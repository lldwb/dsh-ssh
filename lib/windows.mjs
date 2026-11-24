/**
 * Windows remote support: the PowerShell wire format, Windows path handling, and
 * the detached-job script.
 *
 * ## Why PowerShell instead of whatever shell the server defaults to
 *
 * A Windows OpenSSH server may run `cmd.exe` or `powershell.exe` as its default
 * shell, and a cmd session has two properties that make it unusable as a
 * transport: its console code page is the machine's OEM code page (Chinese
 * output arrives as GBK bytes, which the plugin decodes as UTF-8 and shows as
 * mojibake), and its exit code propagation through the outer shell is not
 * reliable. Wrapping every command in
 * `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass
 * -EncodedCommand <base64(utf16le)>` removes both problems:
 *
 * - base64 contains no character either cmd or PowerShell parses, so there is
 *   exactly one quoting layer to reason about;
 * - `[Console]::OutputEncoding = UTF8` makes both PowerShell's own output and
 *   native-child output (cmd/curl) UTF-8 on the wire;
 * - a nonce marker line carries the real exit code, with the SSH channel's
 *   close code as a fallback when the command calls `exit` itself (which ends
 *   the wrapper before the marker line, but after the output has been streamed).
 *
 * ## Why the output is streamed, not buffered
 *
 * An earlier candidate collected stdout/stderr in ArrayLists and printed them
 * after the command finished. That loses every byte a command wrote before an
 * `exit` call, which is a common way for a script to finish. The wrapper
 * therefore forwards each line as it arrives; the trade-off is that the marker
 * cannot be stripped from a truncated stream, so the exit code falls back to the
 * channel close code — which is the wrapper's own `exit` value.
 *
 * ## Why every stream is merged, not just the error stream
 *
 * `2>&1` alone leaves the information stream (6) out. `Write-Host` writes there,
 * and PowerShell then serializes it as CLIXML on stderr — measured: one
 * `Write-Host` produced about 1 KB of `#< CLIXML` on `ssh_exec`'s stderr, and in
 * a job log `Write-Warning` disappeared entirely. The wrapper (and the job's
 * child script) therefore merge `2>&1 3>&1 4>&1 6>&1` and route Error/Warning/
 * Verbose/Debug records to stderr and everything else to stdout.
 *
 * ## The command-line limit
 *
 * The wire travels through the server's default shell. On the cmd.exe path the
 * whole command line is capped at ~8191 characters, and base64 of UTF-16 doubles
 * the script size, so a user command longer than ~1900 characters cannot be
 * wrapped. That is a real limit, not a bug to paper over: it is reported with an
 * actionable message instead of a truncated command. Long scripts belong in a
 * file (`ssh_upload` + a one-line invocation, or `ssh_job`, which uploads its
 * script).
 *
 * ## Scripts on disk need a BOM
 *
 * PowerShell 5.1 reads a BOM-less `.ps1` using the system ANSI code page. On a
 * Chinese Windows install that turns a UTF-8 path such as `C:\Users\x\测试\job.ps1`
 * into `C:\Users\x\娴嬭瘯\job.ps1` and fails with "could not find a part of the
 * path". Every script this plugin writes to a Windows remote is therefore
 * prefixed with a UTF-8 BOM ({@link windowsScriptBytes}).
 *
 * ## Why a scheduled task for jobs, and why a child PowerShell inside it
 *
 * `Start-Process` children do not survive the SSH session: Windows OpenSSH puts
 * them in a job object that is terminated when the session ends. A scheduled
 * task runs under the Task Scheduler service instead and does survive — measured
 * on a real host with a 4-tick job that completed after the SSH connection had
 * been closed and reopened. WMI `Win32_Process.Create` looked promising but its
 * children were killed with the initiating channel; scheduled tasks are the
 * mechanism that actually holds.
 *
 * Inside the job script the user's command runs in a CHILD PowerShell. If it ran
 * in the script's own process, a command ending in `exit 5` would terminate the
 * script before it could write its exit-code file, and `status` would report the
 * job as unknown forever. The child's exit code is what gets written.
 *
 * @module dsh-ssh/lib/windows
 */

import crypto from 'node:crypto';

/** The executable the wrapper invokes. */
export const POWERSHELL_EXE = 'powershell.exe';

/**
 * Conservative cap for the wrapped command line.
 *
 * cmd.exe's limit is 8191 characters for the whole line; the wrapper prefix adds
 * ~120 and base64 expands UTF-16 by 4/3, i.e. ~2.67 characters per script
 * character. 7000 keeps a safety margin for the occasional longer prefix.
 */
export const MAX_WINDOWS_WIRE_LENGTH = 7000;

/** UTF-8 byte-order mark, see the module note about PowerShell 5.1. */
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/**
 * Quote one value as a PowerShell single-quoted string.
 *
 * Inside single quotes PowerShell performs no interpolation; the only escape is
 * doubling a quote.
 *
 * @param {unknown} value - the value to quote.
 * @returns {string} a single-quoted PowerShell string.
 */
export function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Whether a path is a Windows drive path, in either Windows or SFTP spelling.
 *
 * @param {unknown} value - candidate path.
 * @returns {boolean} true for `C:\x`, `C:/x`, `/C:/x` and `C:`.
 */
export function isWindowsPath(value) {
  return typeof value === 'string' && (/^[A-Za-z]:([\\/]|$)/.test(value) || /^\/[A-Za-z]:([\\/]|$)/.test(value));
}

/**
 * Normalise a Windows path: upper-case drive, backslashes, no `.`/`..` segments.
 *
 * `..` is resolved lexically and refused at the drive root rather than clamped:
 * a caller that asks for `C:\..\x` gets an error instead of a silently different
 * path. UNC paths (`\\server\share`) are intentionally unsupported — the SFTP
 * server's spelling of them differs between Windows versions, and guessing wrong
 * would write to a path the user did not ask for.
 *
 * @param {unknown} value - a path using either slash.
 * @returns {string} the normalised path, e.g. `C:\Users\Administrator`.
 * @throws {Error} when the path is not a drive path or escapes its root.
 */
export function normalizeWindowsPath(value) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error('dsh-ssh: a Windows path is required');
  let text = value.trim();
  // Accept the SFTP spelling `/C:/x` as well as the Windows spelling `C:\x`.
  if (/^\/[A-Za-z]:([\\/]|$)/.test(text)) text = text.slice(1);
  let raw = text.replace(/\//g, '\\');
  if (raw.startsWith('\\\\')) throw new Error('dsh-ssh: UNC paths (\\\\server\\share) are not supported on Windows remotes; use a drive-letter path');
  if (/^\\(?![\\])/.test(raw) && !/^[A-Za-z]:/.test(raw)) throw new Error(`dsh-ssh: a rooted Windows path needs a drive letter: ${JSON.stringify(value)}`);
  if (/^[A-Za-z]$/.test(raw)) raw = `${raw}:\\`;
  const match = /^([A-Za-z]):(.*)$/.exec(raw);
  if (match === null) throw new Error(`dsh-ssh: not a Windows drive path: ${JSON.stringify(value)}`);
  const drive = `${match[1].toUpperCase()}:`;
  /** @type {string[]} */
  const segments = [];
  for (const segment of match[2].split('\\')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) throw new Error(`dsh-ssh: the path ${JSON.stringify(value)} escapes the drive root`);
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.length === 0 ? `${drive}\\` : `${drive}\\${segments.join('\\')}`;
}

/**
 * Convert a Windows path to the SFTP server's spelling.
 *
 * OpenSSH for Windows exposes drives as `/C:/…` (that is what `realpath('.')`
 * returns); the SFTP layer of ssh2 passes the string through verbatim, so the
 * plugin keeps every logical path in Windows spelling and converts at the SFTP
 * boundary.
 *
 * @param {unknown} value - a Windows drive path.
 * @returns {string} the SFTP path, e.g. `/C:/Users/Administrator`.
 * @throws {Error} when the path is not a usable drive path.
 */
export function windowsToSftpPath(value) {
  const normalized = normalizeWindowsPath(value);
  return `/${normalized.slice(0, 2)}${normalized.slice(2).replace(/\\/g, '/')}`;
}

/**
 * Resolve a caller-supplied remote path on a Windows host.
 *
 * Accepted spellings: `C:\x`, `C:/x`, `/C:/x`, `~`, `~/x`, `~\x`, paths rooted at
 * the current drive (`\x` — attached to the home drive), and relative paths
 * (resolved against `defaultRemoteDir`, else the login home). Mirrors
 * {@link resolveRemotePath} in ssh.mjs, which keeps the POSIX branch.
 *
 * @param {unknown} target - caller-supplied path.
 * @param {unknown} [defaultDir] - profile's default remote directory.
 * @param {unknown} [home] - resolved Windows home directory.
 * @returns {string} a normalised Windows path.
 * @throws {Error} when the path is empty, malformed, or `~` cannot be expanded.
 */
export function resolveWindowsRemotePath(target, defaultDir, home) {
  if (typeof target !== 'string' || target.trim() === '') throw new Error('dsh-ssh: a remote path is required');
  const raw = target.trim();
  if (raw.includes('\u0000') || /[\r\n]/.test(raw)) throw new Error('dsh-ssh: a remote path must not contain newlines or NUL');

  const homePath = typeof home === 'string' && home.trim() !== '' ? normalizeWindowsPath(home) : '';

  /** @param {string} value - a path that may start with `~`. */
  const expand = (value) => {
    if (value === '~') {
      if (homePath === '') throw new Error('dsh-ssh: cannot expand "~" without a resolved home directory');
      return homePath;
    }
    if (/^~[\\/]/.test(value)) {
      if (homePath === '') throw new Error('dsh-ssh: cannot expand "~" without a resolved home directory');
      return `${homePath.replace(/\\+$/, '')}\\${value.slice(2)}`;
    }
    return value;
  };

  let expanded = expand(raw);
  // Accept the SFTP spelling as input and convert it to Windows spelling.
  if (/^\/[A-Za-z]:([\\/]|$)/.test(expanded)) expanded = expanded.slice(1);
  if (/^\\\\/.test(expanded)) throw new Error('dsh-ssh: UNC paths (\\\\server\\share) are not supported on Windows remotes; use a drive-letter path');

  // A path rooted at the current drive (`\x`) has no drive of its own; attach the
  // home drive so the result is self-contained and SFTP-addressable.
  if (/^\\/.test(expanded) && !/^[A-Za-z]:/.test(expanded)) {
    if (homePath === '') throw new Error(`dsh-ssh: relative remote path ${JSON.stringify(raw)} needs a resolved home directory`);
    expanded = `${homePath.slice(0, 2)}${expanded}`;
  }

  /** @type {string} */
  let absolute;
  if (/^[A-Za-z]:/.test(expanded)) {
    absolute = expanded;
  } else {
    const baseRaw = typeof defaultDir === 'string' && defaultDir.trim() !== '' ? defaultDir.trim() : '';
    const base = baseRaw === '' ? homePath : expand(baseRaw);
    if (base === '') throw new Error(`dsh-ssh: relative remote path ${JSON.stringify(raw)} needs a default remote directory or a resolved home directory`);
    absolute = `${base.replace(/\\+$/, '')}\\${expanded}`;
  }
  return normalizeWindowsPath(absolute);
}

/**
 * The parent directory of a logical remote path, for `mkdir -p` style calls.
 *
 * @param {string} value - a logical (POSIX or Windows) remote path.
 * @returns {string} the parent, or an empty string for a root / single segment.
 */
export function remoteParentPath(value) {
  if (isWindowsPath(value)) {
    const normalized = normalizeWindowsPath(value);
    const index = normalized.lastIndexOf('\\');
    return index <= 2 ? '' : normalized.slice(0, index);
  }
  const trimmed = String(value).replace(/\/+$/, '');
  const index = trimmed.lastIndexOf('/');
  return index <= 0 ? '' : trimmed.slice(0, index);
}

/**
 * Build the PowerShell script text a wrapper executes.
 *
 * Kept separate from {@link wrapPowerShell} so tests can inspect the script
 * without decoding base64, and so the same generator can be reused if the wire
 * encoding changes.
 *
 * @param {string} command - the user command, written in PowerShell.
 * @param {{ cwd?: string, env?: Record<string, string> }} [options] - optional working directory and environment additions.
 * @returns {string} the script text.
 */
export function buildPowerShellScript(command, options = {}) {
  const lines = [
    '$ProgressPreference = "SilentlyContinue"',
    '$ErrorActionPreference = "Continue"',
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    '$OutputEncoding = [Text.Encoding]::UTF8',
    '$global:LASTEXITCODE = 0',
  ];
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    lines.push(`$env:${key} = ${psQuote(value)}`);
  }
  if (typeof options.cwd === 'string' && options.cwd !== '') {
    lines.push('try {');
    lines.push(`  Set-Location -LiteralPath ${psQuote(options.cwd)} -ErrorAction Stop`);
    lines.push('} catch {');
    lines.push('  [Console]::Error.WriteLine("dsh-ssh: cannot change directory: " + $_.ToString())');
    lines.push('  exit 1');
    lines.push('}');
  }
  lines.push('try {');
  // The user command is embedded as a single-quoted string and parsed at
  // runtime. Embedding it directly would make a syntax error in the command break
  // the WHOLE wrapper's parse, which surfaces as CLIXML noise on stderr and no
  // summary; through ScriptBlock::Create it becomes a catchable error.
  lines.push(`$dshCommand = '${String(command).replace(/'/g, "''")}'`);
  // Merge every non-output stream, not just the error stream: `Write-Host` writes
  // to the information stream (6), and leaving it out makes PowerShell serialize
  // it as CLIXML on stderr (measured: 1 KB of `#< CLIXML` for one `Write-Host`).
  // Warnings/verbose/debug keep their conventional destination (stderr), while
  // host output is ordinary stdout.
  lines.push('& ([ScriptBlock]::Create($dshCommand)) 2>&1 3>&1 4>&1 6>&1 | ForEach-Object {');
  lines.push('  if ($_ -is [System.Management.Automation.ErrorRecord]) { [Console]::Error.WriteLine($_.ToString()) }');
  lines.push('  elseif ($_ -is [System.Management.Automation.WarningRecord] -or $_ -is [System.Management.Automation.VerboseRecord] -or $_ -is [System.Management.Automation.DebugRecord]) { [Console]::Error.WriteLine($_.ToString()) }');
  lines.push('  else { [Console]::Out.WriteLine([string]$_) }');
  lines.push('}');
  lines.push('$dshCode = if ($LASTEXITCODE -ne $null) { [int]$LASTEXITCODE } else { 0 }');
  // The nonce makes the marker unambiguous even when the command itself prints
  // text that looks like a marker.
  lines.push(`[Console]::Out.WriteLine("@@DSH_${options.nonce ?? '__NONCE__'}:" + $dshCode)`);
  lines.push('exit $dshCode');
  lines.push('} catch {');
  lines.push('  [Console]::Error.WriteLine("ERROR: " + $_.ToString())');
  lines.push('  exit 1');
  lines.push('}');
  return lines.join('\r\n');
}

/**
 * Wrap one PowerShell command for a Windows remote.
 *
 * @param {string} command - the command, written in PowerShell.
 * @param {{ cwd?: string, env?: Record<string, string>, nonce?: string }} [options] - wrapper options.
 * @returns {{ wire: string, nonce: string, script: string }} the command line to send, its nonce, and the script text.
 */
export function wrapPowerShell(command, options = {}) {
  const nonce = options.nonce ?? crypto.randomBytes(6).toString('hex');
  const script = buildPowerShellScript(command, { ...options, nonce });
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return { wire: `${POWERSHELL_EXE} -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`, nonce, script };
}

/**
 * Throw when a wrapped command line cannot survive the server's default shell.
 *
 * @param {{ wire: string }} wrapped - the result of {@link wrapPowerShell}.
 * @param {string} command - the original command, for the message.
 * @returns {void}
 * @throws {Error} when the wire exceeds {@link MAX_WINDOWS_WIRE_LENGTH}.
 */
export function assertWindowsWireFits(wrapped, command) {
  if (wrapped.wire.length <= MAX_WINDOWS_WIRE_LENGTH) return;
  throw new Error(
    `dsh-ssh: this command is too long for a Windows remote (${wrapped.wire.length} characters on the wire, and cmd.exe caps a command line at ~8191). ` +
      `The practical limit is roughly 1900 characters of command text. Write the script to a file, upload it with ssh_upload, then run it with ssh_exec (for example: ` +
      `\`powershell -File C:\\path\\to\\script.ps1\`), or use ssh_job, which uploads its script instead of passing it on the command line. ` +
      `Command length: ${String(command).length} characters.`,
  );
}

/**
 * Split one wrapper result into user output and the real exit code.
 *
 * The marker is looked up by its per-call nonce at the end of stdout. When it is
 * absent (the command called `exit` before the wrapper could print it, or the
 * stream was truncated) the SSH channel's close code is used: the wrapper ends
 * with `exit $dshCode`, so the channel code carries the same value.
 *
 * @param {string} stdout - the channel's stdout.
 * @param {{ nonce: string, transportExitCode?: number | null }} options - the nonce and the channel code.
 * @returns {{ stdout: string, exitCode: number | null, markerBytes: number, markerSeen: boolean }} the cleaned result.
 */
export function parsePowerShellResult(stdout, options) {
  const tag = `@@DSH_${options.nonce}:`;
  const index = stdout.lastIndexOf(tag);
  if (index === -1) {
    return {
      stdout,
      exitCode: typeof options.transportExitCode === 'number' ? options.transportExitCode : null,
      markerBytes: 0,
      markerSeen: false,
    };
  }
  const tail = stdout.slice(index + tag.length);
  const match = /^(\d+)(\r?\n)?/.exec(tail);
  const exitCode = match === null ? null : Number.parseInt(match[1], 10);
  const removed = tag + (match === null ? '' : match[0]);
  return {
    stdout: `${stdout.slice(0, index)}${stdout.slice(index + removed.length)}`,
    exitCode: exitCode ?? (typeof options.transportExitCode === 'number' ? options.transportExitCode : null),
    markerBytes: Buffer.byteLength(removed, 'utf8'),
    markerSeen: true,
  };
}

/**
 * The script text of one Windows job.
 *
 * Layout mirrors the POSIX `run.sh`: it writes its own PID before starting, logs
 * both streams to one UTF-8 file, and writes the exit code to a separate file so
 * `status` can answer from the filesystem alone. The user command runs in a
 * child PowerShell (see the module note).
 *
 * @param {{ command: string, cwd: string, logFile: string, pidFile: string, exitFile: string, taskName?: string }} spec - job layout.
 * @returns {string} the script text (callers must write it via {@link windowsScriptBytes}).
 */
export function buildWindowsJobScript(spec) {
  const childPrelude = [
    '$ProgressPreference = "SilentlyContinue"',
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    '$OutputEncoding = [Text.Encoding]::UTF8',
  ].join('\r\n');
  // Same reason as the wrapper: parse the user command at runtime, so a syntax
  // error is reported in the job log instead of breaking the script that writes
  // the PID and the exit code. All non-output streams are merged into the child's
  // stdout so the parent's log writer captures them (`Write-Warning` was lost
  // otherwise).
  const childScript = [
    childPrelude,
    `$dshCommand = '${String(spec.command).replace(/'/g, "''")}'`,
    '& ([ScriptBlock]::Create($dshCommand)) 2>&1 3>&1 4>&1 6>&1 | ForEach-Object { [Console]::Out.WriteLine($_.ToString()) }',
    // The child must return the command's exit code explicitly: a PowerShell
    // process exits 0 by default, so `cmd /c exit 3` would otherwise be recorded
    // as success by the parent (and by `job.exit`).
    '$dshChildCode = if ($LASTEXITCODE -ne $null) { [int]$LASTEXITCODE } else { 0 }',
    'exit $dshChildCode',
    '',
  ].join('\r\n');
  const encodedCommand = Buffer.from(childScript, 'utf16le').toString('base64');
  const cwdLine = spec.cwd === '' ? '' : `Set-Location -LiteralPath ${psQuote(spec.cwd)} -ErrorAction Stop`;
  // The task registration is deleted by the job itself once the exit code is
  // recorded: a job that finishes and is never polled again would otherwise leave
  // a scheduled task behind forever. The running task instance survives the
  // deletion (measured), so this does not interrupt the job. `stop` and `status`
  // still sweep as a fallback for jobs that crash before reaching this line.
  const cleanupLine =
    typeof spec.taskName === 'string' && spec.taskName !== ''
      ? `try { Unregister-ScheduledTask -TaskName ${psQuote(spec.taskName)} -Confirm:$false -ErrorAction SilentlyContinue } catch { }`
      : '';
  return [
    '# Generated by dsh-ssh. Do not edit: rewritten on every start.',
    '$ProgressPreference = "SilentlyContinue"',
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    '$OutputEncoding = [Text.Encoding]::UTF8',
    '$dshCode = 1',
    'try {',
    `  [IO.File]::WriteAllText(${psQuote(spec.pidFile)}, [string]$PID)`,
    `  $dshLog = New-Object System.IO.StreamWriter(${psQuote(spec.logFile)}, $false, (New-Object System.Text.UTF8Encoding($false)))`,
    '  $dshLog.AutoFlush = $true',
    '  try {',
    cwdLine === '' ? '' : `    ${cwdLine}`,
    '    $dshExe = (Get-Command powershell.exe).Source',
    `    & $dshExe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${psQuote(encodedCommand)} 2>&1 | ForEach-Object { $dshLog.WriteLine($_.ToString()) }`,
    '    $dshCode = if ($LASTEXITCODE -ne $null) { [int]$LASTEXITCODE } else { 0 }',
    '  } catch {',
    '    $dshLog.WriteLine("ERROR: " + $_.ToString())',
    '    $dshCode = 1',
    '  } finally {',
    '    $dshLog.Dispose()',
    '  }',
    '} catch {',
    `  try { [IO.File]::WriteAllText(${psQuote(spec.exitFile)}, "1") } catch { }`,
    '  exit 1',
    '}',
    `[IO.File]::WriteAllText(${psQuote(spec.exitFile)}, [string]$dshCode)`,
    cleanupLine,
    'exit 0',
    '',
  ]
    .filter((line) => line !== '')
    .join('\r\n');
}

/**
 * Encode script text for writing to a Windows remote.
 *
 * @param {string} text - the script text.
 * @returns {Buffer} UTF-8 with a BOM (see the module note on PowerShell 5.1).
 */
export function windowsScriptBytes(text) {
  return Buffer.concat([UTF8_BOM, Buffer.from(String(text), 'utf8')]);
}

/**
 * The PowerShell script `ssh_host action="test"` runs on a Windows remote.
 *
 * Uptime comes from `Win32_OperatingSystem.LastBootUpTime` because
 * `[Environment]::TickCount64` does not exist in Windows PowerShell 5.1
 * (.NET Framework); the 32-bit `[Environment]::TickCount` is only the fallback
 * when CIM is unavailable (it wraps after ~49.7 days, which is acceptable for a
 * connectivity probe). `MachineName`/`OSVersion` need no service round trip.
 *
 * @returns {string} the probe script, one fact per line.
 */
export function windowsTestProbeScript() {
  return [
    '[Console]::Out.WriteLine([Environment]::MachineName)',
    '[Console]::Out.WriteLine("Windows " + [Environment]::OSVersion.Version.ToString())',
    // `[Environment]::TickCount64` does not exist in Windows PowerShell 5.1
    // (.NET Framework), so the uptime comes from the OS boot time; the 32-bit
    // TickCount is only a fallback for machines where CIM is unavailable.
    '$dshUp = $null',
    'try {',
    '  $dshUp = (Get-Date) - (Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop).LastBootUpTime',
    '} catch {',
    '  $dshUp = [TimeSpan]::FromMilliseconds([Environment]::TickCount)',
    '}',
    '[Console]::Out.WriteLine("up " + [int][Math]::Floor($dshUp.TotalDays) + " days, " + $dshUp.Hours + " hours, " + $dshUp.Minutes + " minutes")',
  ].join('\r\n');
}

/**
 * The script that registers and starts one job's scheduled task.
 *
 * The task action runs an uploaded `.ps1` directly. That deliberately avoids a
 * `.cmd` launcher: -File keeps non-ASCII paths out of a batch file, which cmd.exe
 * would read in the OEM code page.
 *
 * The PID wait happens INSIDE this script: `job.ps1` writes its PID before doing
 * anything else, so polling the file here costs one PowerShell round trip instead
 * of up to 15 separate SFTP sessions (measured on a slow link: a start that
 * should take a second reached 84–202 s because every poll paid a full round
 * trip). The caller parses `dsh-pid=<n>` from stdout.
 *
 * @param {{ taskName: string, scriptPath: string, pidFile: string }} spec - task identity, absolute `.ps1` path and the PID file to wait for.
 * @returns {string} the PowerShell script.
 */
export function windowsTaskRegisterScript(spec) {
  return [
    `$dshExe = (Get-Command powershell.exe).Source`,
    `$dshAction = New-ScheduledTaskAction -Execute $dshExe -Argument ${psQuote(`-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${spec.scriptPath}"`)}`,
    '$dshSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)',
    // S4U (= "do not store a password") rather than the default Interactive logon:
    // an Interactive task only starts while that user has an interactive session,
    // which is exactly what a headless SSH host usually lacks. The canonical
    // WindowsIdentity name is used because `$env:USERDOMAIN` is `WORKGROUP` on a
    // workgroup machine and `WORKGROUP\user` does not resolve (measured: S4U with
    // the canonical name registers and runs, the env-based name fails with
    // "No mapping between account names and security IDs").
    '$dshPrincipal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType S4U -RunLevel Limited',
    `Register-ScheduledTask -TaskName ${psQuote(spec.taskName)} -Action $dshAction -Settings $dshSettings -Principal $dshPrincipal -Force | Out-Null`,
    `Start-ScheduledTask -TaskName ${psQuote(spec.taskName)}`,
    '$dshPid = ""',
    'for ($dshTry = 0; $dshTry -lt 25 -and $dshPid -eq ""; $dshTry++) {',
    '  Start-Sleep -Milliseconds 200',
    `  if (Test-Path ${psQuote(spec.pidFile)}) { $dshPid = (Get-Content -LiteralPath ${psQuote(spec.pidFile)} -Raw).Trim() }`,
    '}',
    'Write-Output ("started")',
    'Write-Output ("dsh-pid=" + $dshPid)',
  ].join('\r\n');
}

/**
 * The script that removes one job's scheduled task, tolerating its absence.
 *
 * @param {string} taskName - the task name.
 * @returns {string} the PowerShell script.
 */
export function windowsTaskRemoveScript(taskName) {
  return `Unregister-ScheduledTask -TaskName ${psQuote(taskName)} -Confirm:$false -ErrorAction SilentlyContinue; Write-Output "cleaned"`;
}

/**
 * The script that reports which of the given PIDs are still alive.
 *
 * @param {number[]} pids - process ids.
 * @returns {string} the PowerShell script; one id per line for live processes.
 */
export function windowsAlivePidsScript(pids) {
  const list = pids.filter((pid) => Number.isInteger(pid) && pid > 0).join(',');
  if (list === '') return 'Write-Output ""';
  return `Get-Process -Id ${list} -ErrorAction SilentlyContinue | ForEach-Object { [Console]::Out.WriteLine([string]$_.Id) }`;
}

/**
 * The script that kills one process tree (job stop).
 *
 * @param {number} pid - the process id.
 * @returns {string} the PowerShell script; writes `KILLED` or `GONE`.
 */
export function windowsStopProcessScript(pid) {
  return [
    `$dshTarget = ${Number.isInteger(pid) ? pid : 0}`,
    'if ($dshTarget -le 0) { Write-Output "GONE"; exit 0 }',
    'if (Get-Process -Id $dshTarget -ErrorAction SilentlyContinue) {',
    '  taskkill /PID $dshTarget /T /F 2>&1 | Out-Null',
    '  Write-Output "KILLED"',
    '} else {',
    '  Write-Output "GONE"',
    '}',
  ].join('\r\n');
}

/** Task name prefix used for job tasks. */
export const WINDOWS_TASK_PREFIX = 'dsh-ssh-';

/** Job directory root, relative to the Windows login home. */
export const WINDOWS_JOBS_ROOT = '.dsh-ssh\\jobs';

/**
 * The script that reports one scheduled task's state and last result.
 *
 * Used when a job's PID never appears: "the task was registered but produced no
 * PID" is otherwise a silent phantom job, and the Task Scheduler state/result is
 * what turns it into an actionable error.
 *
 * @param {string} taskName - the task name.
 * @returns {string} the PowerShell script, one diagnostic per line.
 */
export function windowsTaskStateScript(taskName) {
  return [
    `$dshTask = Get-ScheduledTask -TaskName ${psQuote(taskName)} -ErrorAction SilentlyContinue`,
    'if ($dshTask -eq $null) {',
    '  Write-Output "task=absent"',
    '} else {',
    '  Write-Output ("task-state=" + $dshTask.State)',
    `  $dshInfo = Get-ScheduledTaskInfo -TaskName ${psQuote(taskName)}`,
    '  Write-Output ("task-last-result=" + $dshInfo.LastTaskResult)',
    '}',
  ].join('\r\n');
}

/**
 * Build a scheduled-task name for one job id.
 *
 * @param {string} jobId - a validated job id.
 * @returns {string} the task name.
 */
export function windowsTaskName(jobId) {
  return `${WINDOWS_TASK_PREFIX}${jobId}`;
}
