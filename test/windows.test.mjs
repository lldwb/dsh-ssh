/**
 * Offline tests for the Windows layer: the PowerShell wire format, Windows path
 * handling, platform detection, and the Windows branch of the job manager.
 *
 * Nothing here opens a socket: `execCommand` / `withSftp` are replaced by small
 * fakes, and nothing imports `ssh2`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  JobManager,
  detectPlatform,
  execCommand,
  readRemoteRange,
  resolveHome,
  resolveRemotePath,
  toSftpPath,
} from '../lib/ssh.mjs';
import {
  MAX_WINDOWS_WIRE_LENGTH,
  assertWindowsWireFits,
  buildPowerShellScript,
  buildWindowsJobScript,
  isWindowsPath,
  normalizeWindowsPath,
  parsePowerShellResult,
  psQuote,
  remoteParentPath,
  resolveWindowsRemotePath,
  windowsAlivePidsScript,
  windowsScriptBytes,
  windowsStopProcessScript,
  windowsTaskName,
  windowsTaskRegisterScript,
  windowsTaskRemoveScript,
  windowsTaskStateScript,
  windowsTestProbeScript,
  windowsToSftpPath,
  wrapPowerShell,
} from '../lib/windows.mjs';

// ───────────────────────────── helpers ─────────────────────────────

/**
 * A tiny EventEmitter-like stream.
 *
 * @param {{ stdout?: string, stderr?: string, code?: number | null }} spec - what the stream reports.
 * @returns {any} the stream.
 */
function fakeStream({ stdout = '', stderr = '', code = 0 } = {}) {
  const listeners = new Map();
  const stream = {
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
      return stream;
    },
    stderr: {
      on(event, handler) {
        if (!listeners.has(`err:${event}`)) listeners.set(`err:${event}`, []);
        listeners.get(`err:${event}`).push(handler);
      },
    },
    close() {},
  };
  const emit = (event, ...args) => {
    for (const handler of listeners.get(event) ?? []) handler(...args);
  };
  const emitErr = (event, ...args) => {
    for (const handler of listeners.get(`err:${event}`) ?? []) handler(...args);
  };
  queueMicrotask(() => {
    if (stdout !== '') emit('data', Buffer.from(stdout));
    if (stderr !== '') emitErr('data', Buffer.from(stderr));
    emit('close', code, null);
  });
  return stream;
}

/** Decode a wrapper command line back to its script text. */
function decodeWrapper(command) {
  const match = /-EncodedCommand ([A-Za-z0-9+/=]+)$/.exec(command);
  assert.notEqual(match, null, 'the command must be a PowerShell wrapper');
  return Buffer.from(match[1], 'base64').toString('utf16le');
}

/** The per-call nonce of a wrapper command. */
function nonceOf(command) {
  const script = decodeWrapper(command);
  const match = /@@DSH_([0-9a-f]+):/.exec(script);
  assert.notEqual(match, null, 'the wrapper must carry a marker');
  return match[1];
}

/** A client that answers `uname` and wrapper probes from a script table. */
function probingClient({ uname = { stdout: '', stderr: '', code: 1 }, windowsVersion = 'Microsoft Windows NT 10.0.26200.0' } = {}) {
  const calls = [];
  return {
    calls,
    exec(command, optionsOrCallback, maybeCallback) {
      const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
      calls.push(command);
      if (command === 'uname -s') {
        callback(null, fakeStream(uname));
        return;
      }
      if (command.includes('-EncodedCommand')) {
        const nonce = nonceOf(command);
        callback(null, fakeStream({ stdout: `${windowsVersion}\r\n@@DSH_${nonce}:0\r\n`, code: 0 }));
        return;
      }
      callback(null, fakeStream({ stdout: '', stderr: `unexpected command: ${command}`, code: 1 }));
    },
  };
}

/** A memory SFTP session: enough of the protocol for the Windows job manager. */
function memorySftp() {
  /** @type {Map<string, { dir: boolean, content?: Buffer }>} */
  const files = new Map();
  const mkStream = () => {
    const listeners = new Map();
    const obj = {
      on(event, handler) {
        if (!listeners.has(event)) listeners.set(event, []);
        listeners.get(event).push(handler);
        return obj;
      },
      emit(event, ...args) {
        for (const handler of listeners.get(event) ?? []) handler(...args);
      },
    };
    return obj;
  };
  return {
    files,
    mkdir(target, callback) {
      if (files.has(target)) callback(Object.assign(new Error('exists'), { code: 4 }));
      else {
        files.set(target, { dir: true });
        callback(null);
      }
    },
    stat(target, callback) {
      const entry = files.get(target);
      if (entry === undefined) callback(Object.assign(new Error('no such file'), { code: 2 }));
      else callback(null, { isDirectory: () => entry.dir, size: entry.content === undefined ? 0 : entry.content.length });
    },
    readdir(target, callback) {
      const entry = files.get(target);
      if (entry === undefined || !entry.dir) {
        callback(new Error('not a directory'));
        return;
      }
      const prefix = String(target).replace(/\/+$/, '');
      const children = [...files.keys()]
        .filter((path) => path !== target && path.startsWith(`${prefix}/`) && !path.slice(prefix.length + 1).includes('/'))
        .map((path) => {
          const child = files.get(path) ?? { dir: false };
          return {
            filename: path.slice(prefix.length + 1),
            attrs: { isDirectory: () => child.dir, size: child.content === undefined ? 0 : child.content.length },
            longname: '',
          };
        });
      callback(null, children);
    },
    createWriteStream(target) {
      const stream = mkStream();
      stream.end = (content) => {
        const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
        files.set(String(target), { dir: false, content: buffer });
        queueMicrotask(() => stream.emit('close'));
      };
      return stream;
    },
    createReadStream(target, options = {}) {
      const stream = mkStream();
      const entry = files.get(String(target));
      queueMicrotask(() => {
        if (entry === undefined || entry.content === undefined) {
          stream.emit('error', Object.assign(new Error('no such file'), { code: 2 }));
          return;
        }
        const start = Number.isFinite(options.start) ? Math.max(0, options.start) : 0;
        const end = Number.isFinite(options.end) ? Math.min(entry.content.length, options.end + 1) : entry.content.length;
        if (start < end) stream.emit('data', entry.content.subarray(start, end));
        stream.emit('end');
      });
      return stream;
    },
    end() {},
  };
}

/** A Windows client with the platform and home already cached. */
function windowsClient(home = 'C:\\Users\\me') {
  return { __dshSshPlatform: { kind: 'windows', family: 'Windows 10.0' }, __dshSshHome: home };
}

// ───────────────────────────── quoting / paths ─────────────────────────────

test('psQuote doubles single quotes and leaves everything else alone', () => {
  assert.equal(psQuote('abc'), "'abc'");
  assert.equal(psQuote("it's"), "'it''s'");
  assert.equal(psQuote(''), "''");
  assert.equal(psQuote('中文 ✓'), "'中文 ✓'");
});

test('normalizeWindowsPath normalises drive letter, slashes and dot segments', () => {
  assert.equal(normalizeWindowsPath('c:\\Users\\me'), 'C:\\Users\\me');
  assert.equal(normalizeWindowsPath('C:/Users/me/'), 'C:\\Users\\me');
  assert.equal(normalizeWindowsPath('/C:/Users/me'), 'C:\\Users\\me');
  assert.equal(normalizeWindowsPath('C:'), 'C:\\');
  assert.equal(normalizeWindowsPath('C:\\a\\.\\b\\..\\c'), 'C:\\a\\c');
  assert.throws(() => normalizeWindowsPath('C:\\..\\x'), /escapes the drive root/);
  assert.throws(() => normalizeWindowsPath('\\\\server\\share'), /UNC/);
  assert.throws(() => normalizeWindowsPath('relative'), /not a Windows drive path/);
  assert.throws(() => normalizeWindowsPath('\\rooted'), /needs a drive letter/);
});

test('resolveWindowsRemotePath handles absolute, ~, rooted and relative forms', () => {
  const home = 'C:\\Users\\me';
  assert.equal(resolveWindowsRemotePath('C:\\data\\x', '', home), 'C:\\data\\x');
  assert.equal(resolveWindowsRemotePath('D:/data/x', '', home), 'D:\\data\\x');
  assert.equal(resolveWindowsRemotePath('/C:/data/x', '', home), 'C:\\data\\x');
  assert.equal(resolveWindowsRemotePath('~', '', home), home);
  assert.equal(resolveWindowsRemotePath('~/work', '', home), 'C:\\Users\\me\\work');
  assert.equal(resolveWindowsRemotePath('~\\work', '', home), 'C:\\Users\\me\\work');
  assert.equal(resolveWindowsRemotePath('\\data', '', home), 'C:\\data');
  assert.equal(resolveWindowsRemotePath('rel.txt', 'C:\\base', home), 'C:\\base\\rel.txt');
  assert.equal(resolveWindowsRemotePath('rel.txt', '', home), 'C:\\Users\\me\\rel.txt');
  assert.throws(() => resolveWindowsRemotePath('rel.txt', '', ''), /needs a default remote directory/);
  assert.throws(() => resolveWindowsRemotePath('~\\x', '', ''), /cannot expand/);
  assert.throws(() => resolveWindowsRemotePath('a\nb', '', home), /newlines or NUL/);
  assert.throws(() => resolveWindowsRemotePath('\\\\srv\\share\\x', '', home), /UNC/);
});

test('windows path predicates and SFTP conversion agree', () => {
  assert.equal(isWindowsPath('C:\\x'), true);
  assert.equal(isWindowsPath('C:/x'), true);
  assert.equal(isWindowsPath('/C:/x'), true);
  assert.equal(isWindowsPath('/root/x'), false);
  assert.equal(windowsToSftpPath('C:\\Users\\me'), '/C:/Users/me');
  assert.equal(windowsToSftpPath('/C:/Users/me'), '/C:/Users/me');
  assert.equal(toSftpPath('C:\\Users\\me'), '/C:/Users/me');
  assert.equal(toSftpPath('/C:/Users/me'), '/C:/Users/me');
  assert.equal(toSftpPath('/root/x'), '/root/x');
  assert.equal(toSftpPath('relative/x'), 'relative/x');
  assert.equal(remoteParentPath('C:\\Users\\me\\x.txt'), 'C:\\Users\\me');
  assert.equal(remoteParentPath('C:\\x.txt'), '');
  assert.equal(remoteParentPath('/root/x.txt'), '/root');
  assert.equal(remoteParentPath('/x.txt'), '');
  assert.equal(remoteParentPath('/C:/x.txt'), '');
});

test('resolveRemotePath infers Windows from a Windows home and honours an explicit platform', () => {
  const home = 'C:\\Users\\me';
  assert.equal(resolveRemotePath('~/work', '', home), 'C:\\Users\\me\\work');
  assert.equal(resolveRemotePath('sub', 'C:\\base', home), 'C:\\base\\sub');
  assert.equal(resolveRemotePath('sub', 'C:\\base', home, { kind: 'windows' }), 'C:\\base\\sub');
  // A POSIX home still goes down the POSIX branch.
  assert.equal(resolveRemotePath('~/work', '', '/home/me'), '/home/me/work');
});

// ───────────────────────────── wrapper format ─────────────────────────────

test('buildPowerShellScript sets UTF-8, streams both streams, and marks the exit code', () => {
  const script = buildPowerShellScript('Write-Output "hi"', { nonce: 'abc123' });
  assert.ok(script.includes('[Console]::OutputEncoding = [Text.Encoding]::UTF8'));
  assert.ok(script.includes('$ProgressPreference = "SilentlyContinue"'));
  assert.ok(script.includes("[Console]::Error.WriteLine($_.ToString())"));
  assert.ok(script.includes("[Console]::Out.WriteLine([string]$_)"));
  // Error + warning/verbose/debug + information streams must all be merged;
  // leaving 6 out makes Write-Host arrive as CLIXML on stderr.
  assert.ok(script.includes('2>&1 3>&1 4>&1 6>&1'));
  assert.ok(script.includes('WarningRecord'));
  assert.ok(script.includes('VerboseRecord'));
  assert.ok(script.includes('DebugRecord'));
  assert.ok(script.includes('$dshCode = if ($LASTEXITCODE -ne $null)'));
  assert.ok(script.includes('@@DSH_abc123:'));
  assert.ok(script.includes('exit $dshCode'));
});

test('buildPowerShellScript applies cwd and env with quoting', () => {
  const script = buildPowerShellScript('Write-Output "x"', {
    nonce: 'n1',
    cwd: "C:\\Program Files\\it's",
    env: { FOO: "a'b", 'BAD-NAME': 'ignored' },
  });
  assert.ok(script.includes("Set-Location -LiteralPath 'C:\\Program Files\\it''s' -ErrorAction Stop"));
  assert.ok(script.includes("$env:FOO = 'a''b'"));
  assert.ok(!script.includes('$env:BAD-NAME'));
});

test('buildPowerShellScript embeds the command through ScriptBlock::Create, quoted once', () => {
  const command = 'Write-Output "it\'s a test"\nGet-Location';
  const script = buildPowerShellScript(command, { nonce: 'n2' });
  assert.ok(script.includes("& ([ScriptBlock]::Create($dshCommand))"));
  // The literal must carry the doubled quote, not a broken string.
  assert.ok(script.includes("$dshCommand = 'Write-Output \"it''s a test\"\nGet-Location'"));
});

test('wrapPowerShell produces a decodable, nonce-marked wire command', () => {
  const wrapped = wrapPowerShell('Write-Output "hi"');
  assert.match(wrapped.nonce, /^[0-9a-f]{12}$/);
  assert.ok(wrapped.wire.startsWith('powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand '));
  const decoded = Buffer.from(wrapped.wire.split(' ').pop() ?? '', 'base64').toString('utf16le');
  assert.equal(decoded, wrapped.script);
  assert.ok(decoded.includes(`@@DSH_${wrapped.nonce}:`));
});

test('assertWindowsWireFits accepts ordinary commands and rejects oversized ones', () => {
  assert.doesNotThrow(() => assertWindowsWireFits(wrapPowerShell('Write-Output "hi"'), 'Write-Output "hi"'));
  const longCommand = `Write-Output '${'x'.repeat(3000)}'`;
  const wrapped = wrapPowerShell(longCommand);
  assert.ok(wrapped.wire.length > MAX_WINDOWS_WIRE_LENGTH);
  assert.throws(() => assertWindowsWireFits(wrapped, longCommand), /too long for a Windows remote/);
});

test('parsePowerShellResult strips the marker and uses its exit code', () => {
  const parsed = parsePowerShellResult('out-1\r\n@@DSH_ff11:7\r\n', { nonce: 'ff11', transportExitCode: 0 });
  assert.equal(parsed.stdout, 'out-1\r\n');
  assert.equal(parsed.exitCode, 7);
  assert.equal(parsed.markerSeen, true);
  assert.equal(parsed.markerBytes, Buffer.byteLength('@@DSH_ff11:7\r\n', 'utf8'));
});

test('parsePowerShellResult falls back to the channel code when the wrapper exited early', () => {
  const parsed = parsePowerShellResult('before-exit\r\n', { nonce: 'aa', transportExitCode: 5 });
  assert.equal(parsed.stdout, 'before-exit\r\n');
  assert.equal(parsed.exitCode, 5);
  assert.equal(parsed.markerSeen, false);
  assert.equal(parsed.markerBytes, 0);
});

test('parsePowerShellResult does not eat look-alike markers from another call', () => {
  const parsed = parsePowerShellResult('@@DSH_bb:9\r\nreal\r\n@@DSH_aa:0\r\n', { nonce: 'aa', transportExitCode: 0 });
  assert.equal(parsed.stdout, '@@DSH_bb:9\r\nreal\r\n');
  assert.equal(parsed.exitCode, 0);
});

test('windowsTestProbeScript avoids TickCount64 (missing in PowerShell 5.1)', () => {
  const script = windowsTestProbeScript();
  assert.ok(script.includes('MachineName'));
  assert.ok(script.includes('OSVersion.Version'));
  assert.ok(script.includes('Win32_OperatingSystem'));
  assert.ok(!script.includes('TickCount64'));
  assert.ok(script.includes('TickCount)'));
});

test('windowsScriptBytes prefix a UTF-8 BOM', () => {
  const bytes = windowsScriptBytes('Write-Output "中文"');
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(bytes.subarray(3).toString('utf8'), 'Write-Output "中文"');
});

test('buildWindowsJobScript writes pid first, logs through a UTF-8 writer, and records the exit code', () => {
  const script = buildWindowsJobScript({
    command: 'Write-Output "it\'s"',
    cwd: 'C:\\work',
    logFile: 'C:\\dir\\job.log',
    pidFile: 'C:\\dir\\job.pid',
    exitFile: 'C:\\dir\\job.exit',
    taskName: 'dsh-ssh-job-1',
  });
  assert.ok(script.indexOf('[IO.File]::WriteAllText') < script.indexOf('StreamWriter'));
  assert.ok(script.includes("New-Object System.Text.UTF8Encoding($false)"));
  assert.ok(script.includes("Set-Location -LiteralPath 'C:\\work' -ErrorAction Stop"));
  assert.ok(script.includes('$dshLog.Dispose()'));
  assert.ok(script.includes('job.exit'));
  assert.ok(script.includes("Unregister-ScheduledTask -TaskName 'dsh-ssh-job-1'"), 'the job must delete its own task registration');
  assert.ok(script.indexOf("WriteAllText('C:\\dir\\job.exit'") < script.indexOf('Unregister-ScheduledTask'), 'cleanup must run after the exit code is recorded');
  assert.ok(script.includes('exit 0'));
  // The user command is embedded in the CHILD script, parsed at runtime.
  const match = /-EncodedCommand '([A-Za-z0-9+/=]+)'/.exec(script);
  assert.notEqual(match, null);
  const child = Buffer.from(match[1], 'base64').toString('utf16le');
  assert.ok(child.includes("$dshCommand = 'Write-Output \"it''s\"'"));
  // The child must forward the native command's exit code explicitly, otherwise
  // `cmd /c exit 3` would be recorded as 0 by the parent.
  assert.ok(child.includes('$dshChildCode = if ($LASTEXITCODE -ne $null) { [int]$LASTEXITCODE } else { 0 }'));
  assert.ok(child.includes('exit $dshChildCode'));
  // The child merges all non-output streams so Write-Warning/Host reach the log.
  assert.ok(child.includes('2>&1 3>&1 4>&1 6>&1'));
});

test('buildWindowsJobScript tolerates a missing task name and skips self-unregistration', () => {
  const script = buildWindowsJobScript({
    command: 'Write-Output "x"',
    cwd: '',
    logFile: 'C:\\dir\\job.log',
    pidFile: 'C:\\dir\\job.pid',
    exitFile: 'C:\\dir\\job.exit',
  });
  assert.ok(!script.includes('Unregister-ScheduledTask'));
  assert.ok(script.includes('exit 0'));
});

test('the scheduled-task scripts carry the task name and full script path', () => {
  const register = windowsTaskRegisterScript({
    taskName: 'dsh-ssh-job-1',
    scriptPath: 'C:\\Users\\me\\.dsh-ssh\\jobs\\job-1\\job.ps1',
    pidFile: 'C:\\Users\\me\\.dsh-ssh\\jobs\\job-1\\job.pid',
  });
  assert.ok(register.includes('New-ScheduledTaskAction'));
  assert.ok(register.includes("-File \"C:\\Users\\me\\.dsh-ssh\\jobs\\job-1\\job.ps1\""));
  assert.ok(register.includes("Register-ScheduledTask -TaskName 'dsh-ssh-job-1'"));
  assert.ok(register.includes("Start-ScheduledTask -TaskName 'dsh-ssh-job-1'"));
  // The PID wait is part of this script (one round trip instead of 15 SFTP polls).
  assert.ok(register.includes('dsh-pid='));
  assert.ok(register.includes("job.pid"));
  // S4U: an Interactive-only task cannot start on a host with no interactive
  // session, which is the normal shape of an SSH server.
  assert.ok(register.includes('New-ScheduledTaskPrincipal'));
  assert.ok(register.includes('-LogonType S4U'));
  assert.ok(register.includes('[System.Security.Principal.WindowsIdentity]::GetCurrent().Name'));
  assert.ok(windowsTaskRemoveScript('dsh-ssh-job-1').includes("Unregister-ScheduledTask -TaskName 'dsh-ssh-job-1'"));
  assert.ok(windowsTaskStateScript('dsh-ssh-job-1').includes('Get-ScheduledTaskInfo'));
  assert.equal(windowsTaskName('job-1'), 'dsh-ssh-job-1');
  assert.ok(windowsAlivePidsScript([10, 20]).includes('Get-Process -Id 10,20'));
  assert.ok(windowsStopProcessScript(42).includes('taskkill /PID $dshTarget /T /F'));
  assert.ok(windowsStopProcessScript(42).includes('$dshTarget = 42'));
});

// ───────────────────────────── platform detection ─────────────────────────────

test('detectPlatform classifies a POSIX uname answer and caches it', async () => {
  const client = probingClient({ uname: { stdout: 'Linux\n', stderr: '', code: 0 } });
  const platform = await detectPlatform(client);
  assert.deepEqual(platform, { kind: 'posix', family: 'Linux' });
  assert.equal(client.calls.length, 1);
  await detectPlatform(client);
  assert.equal(client.calls.length, 1, 'the second call must use the cache');
});

test('detectPlatform treats MINGW/MSYS/CYGWIN as Windows', async () => {
  for (const family of ['MINGW64_NT-10.0-19045', 'MSYS_NT-10.0', 'CYGWIN_NT-10.0']) {
    const client = probingClient({ uname: { stdout: `${family}\n`, stderr: '', code: 0 } });
    const platform = await detectPlatform(client);
    assert.equal(platform.kind, 'windows');
    assert.equal(platform.family, family);
  }
});

test('detectPlatform asks PowerShell when uname fails', async () => {
  const client = probingClient({ uname: { stdout: '', stderr: 'not recognized', code: 1 } });
  const platform = await detectPlatform(client);
  assert.equal(platform.kind, 'windows');
  assert.match(platform.family, /Windows/);
  assert.equal(client.calls.length, 2, 'uname then the PowerShell probe');
});

test('detectPlatform throws a diagnostic when neither probe answers', async () => {
  const client = {
    exec(command, optionsOrCallback, maybeCallback) {
      const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
      callback(null, fakeStream({ stdout: '', stderr: 'nope', code: 1 }));
    },
  };
  await assert.rejects(() => detectPlatform(client), /could not determine the remote platform/);
});

// ───────────────────────────── exec / home ─────────────────────────────

test('execCommand on Windows wraps the command, cleans the marker and keeps stdout/stderr apart', async () => {
  const client = windowsClient();
  let seen = '';
  client.exec = (command, optionsOrCallback, maybeCallback) => {
    const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
    seen = command;
    const nonce = nonceOf(command);
    callback(
      null,
      (() => {
        // A stream whose stdout and stderr differ, with a marker after the output.
        const listeners = new Map();
        const stream = {
          on(event, handler) {
            if (!listeners.has(event)) listeners.set(event, []);
            listeners.get(event).push(handler);
            return stream;
          },
          stderr: { on: () => stream },
          close() {},
        };
        queueMicrotask(() => {
          for (const handler of listeners.get('data') ?? []) handler(Buffer.from(`中文 ✓\r\n@@DSH_${nonce}:7\r\n`));
          for (const handler of listeners.get('close') ?? []) handler(7, null);
        });
        return stream;
      })(),
    );
  };
  const result = await execCommand(client, 'Write-Output "中文 ✓"; cmd /c exit 7', { cwd: 'C:\\work' });
  assert.match(seen, /-EncodedCommand/);
  assert.ok(decodeWrapper(seen).includes("Set-Location -LiteralPath 'C:\\work'"));
  assert.equal(result.stdout, '中文 ✓\r\n');
  assert.equal(result.exitCode, 7);
  assert.equal(result.stdoutBytes, Buffer.byteLength('中文 ✓\r\n', 'utf8'));
});

test('execCommand on Windows uses the channel code when the marker is missing', async () => {
  const client = windowsClient();
  client.exec = (command, optionsOrCallback, maybeCallback) => {
    const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
    callback(null, fakeStream({ stdout: 'before-exit\r\n', code: 5 }));
  };
  const result = await execCommand(client, 'Write-Output "before-exit"; exit 5');
  assert.equal(result.stdout, 'before-exit\r\n');
  assert.equal(result.exitCode, 5);
});

test('execCommand on Windows rejects an over-long command with guidance', async () => {
  const client = windowsClient();
  client.exec = () => {
    throw new Error('must not be called for an over-long command');
  };
  await assert.rejects(() => execCommand(client, `Write-Output '${'x'.repeat(3000)}'`), /too long for a Windows remote/);
});

test('execCommand keeps the POSIX path untouched', async () => {
  const client = { __dshSshPlatform: { kind: 'posix', family: 'Linux' } };
  let seen = '';
  client.exec = (command, optionsOrCallback, maybeCallback) => {
    const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
    seen = command;
    callback(null, fakeStream({ stdout: 'ok\n', code: 0 }));
  };
  const result = await execCommand(client, 'echo hi', { cwd: '/tmp/x' });
  assert.equal(seen, "cd '/tmp/x' && echo hi");
  assert.equal(result.stdout, 'ok\n');
});

test('resolveHome asks PowerShell on Windows and caches the normalised path', async () => {
  const client = { __dshSshPlatform: { kind: 'windows', family: 'Windows' } };
  const calls = [];
  client.exec = (command, optionsOrCallback, maybeCallback) => {
    const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
    calls.push(command);
    const nonce = nonceOf(command);
    callback(null, fakeStream({ stdout: `C:\\Users\\me\r\n@@DSH_${nonce}:0\r\n`, code: 0 }));
  };
  assert.equal(await resolveHome(client), 'C:\\Users\\me');
  assert.equal(await resolveHome(client), 'C:\\Users\\me');
  assert.equal(calls.length, 1);
  assert.match(decodeWrapper(calls[0]), /GetFolderPath/);
});

test('resolveHome on Windows rejects a non-drive answer', async () => {
  const client = { __dshSshPlatform: { kind: 'windows', family: 'Windows' } };
  client.exec = (command, optionsOrCallback, maybeCallback) => {
    const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
    const nonce = nonceOf(command);
    callback(null, fakeStream({ stdout: `not-a-path\r\n@@DSH_${nonce}:0\r\n`, code: 0 }));
  };
  await assert.rejects(() => resolveHome(client), /could not resolve the remote home directory on Windows/);
});

// ───────────────────────────── Windows job manager ─────────────────────────────

/** Build a Windows job manager over the memory SFTP and scripted exec. */
function windowsJobManager({ home = 'C:\\Users\\me', sftp, exec } = {}) {
  const session = sftp ?? memorySftp();
  const calls = [];
  const jobs = new JobManager({
    exec: async (client, command, options) => {
      calls.push(command);
      return exec === undefined ? { stdout: '', stderr: '', exitCode: 0 } : await exec(command, options);
    },
    sftp: async (client, operation) => operation(session),
  });
  return { jobs, session, calls, client: windowsClient(home) };
}

/** Seed one job's files in the memory SFTP (paths in SFTP spelling). */
function seedJob(session, rootSftp, name, { pid, exitCode, log } = {}) {
  // The job manager lists the jobs root with readdir, so the root itself must be
  // a directory entry, not just the jobs below it.
  session.files.set(rootSftp, { dir: true });
  const dir = `${rootSftp}/${name}`;
  session.files.set(dir, { dir: true });
  if (pid !== undefined) session.files.set(`${dir}/job.pid`, { dir: false, content: Buffer.from(String(pid)) });
  if (exitCode !== undefined) session.files.set(`${dir}/job.exit`, { dir: false, content: Buffer.from(String(exitCode)) });
  if (log !== undefined) session.files.set(`${dir}/job.log`, { dir: false, content: Buffer.from(log) });
}

test('Windows JobManager.start uploads a BOM .ps1, registers a task and returns the pid', async () => {
  const { jobs, session, calls, client } = windowsJobManager({
    exec: async (command) =>
      command.includes('Register-ScheduledTask')
        ? { stdout: 'started\r\ndsh-pid=4242\r\n', stderr: '', exitCode: 0 }
        : { stdout: '', stderr: '', exitCode: 0 },
  });
  seedJob(session, '/C:/Users/me/.dsh-ssh/jobs', 'test-job', { pid: 4242 });
  const handle = await jobs.start(client, { command: 'Write-Output "hi"', jobId: 'test-job', cwd: '~' });
  assert.equal(handle.jobId, 'test-job');
  assert.equal(handle.pid, 4242);
  assert.equal(handle.dir, 'C:\\Users\\me\\.dsh-ssh\\jobs\\test-job');
  assert.equal(handle.logFile, 'C:\\Users\\me\\.dsh-ssh\\jobs\\test-job\\job.log');
  const script = session.files.get('/C:/Users/me/.dsh-ssh/jobs/test-job/job.ps1');
  assert.notEqual(script, undefined, 'job.ps1 must be uploaded');
  assert.deepEqual([...script.content.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'the script must start with a UTF-8 BOM');
  assert.ok(script.content.toString('utf8').includes('[IO.File]::WriteAllText'));
  assert.ok(script.content.toString('utf8').includes("Unregister-ScheduledTask -TaskName 'dsh-ssh-test-job'"), 'the script must clean up its own task');
  const register = calls.find((command) => command.includes('Register-ScheduledTask'));
  assert.notEqual(register, undefined, 'a scheduled task must be registered');
  assert.ok(register.includes('dsh-ssh-test-job'));
  assert.ok(register.includes('job.ps1'));
  assert.ok(register.includes('dsh-pid='));
});

test('Windows JobManager.status reads exit/pid files over SFTP and cleans the task', async () => {
  const { jobs, session, calls, client } = windowsJobManager();
  seedJob(session, '/C:/Users/me/.dsh-ssh/jobs', 'done-job', { exitCode: 7, log: 'done\n' });
  const state = await jobs.status(client, 'done-job');
  assert.deepEqual(state, { jobId: 'done-job', state: 'exited', exitCode: 7, pid: -1, logBytes: 5 });
  assert.ok(calls.some((command) => command.includes('Unregister-ScheduledTask') && command.includes('dsh-ssh-done-job')));
});

test('Windows JobManager.status reports running when the pid is alive', async () => {
  const manager = windowsJobManager({
    exec: async (command) => (command.includes('Get-Process') ? { stdout: '4242\r\n', stderr: '', exitCode: 0 } : { stdout: '', stderr: '', exitCode: 0 }),
  });
  seedJob(manager.session, '/C:/Users/me/.dsh-ssh/jobs', 'run-job', { pid: 4242, log: 'x' });
  const state = await manager.jobs.status(manager.client, 'run-job');
  assert.equal(state.state, 'running');
  assert.equal(state.pid, 4242);
  assert.equal(state.logBytes, 1);
});

test('Windows JobManager.status reports unknown for a missing job', async () => {
  const { jobs, client } = windowsJobManager();
  const state = await jobs.status(client, 'absent-job');
  assert.deepEqual(state, { jobId: 'absent-job', state: 'unknown', exitCode: -1, pid: -1, logBytes: 0 });
});

test('Windows JobManager.log reads a byte range over SFTP', async () => {
  const { jobs, session, client } = windowsJobManager();
  seedJob(session, '/C:/Users/me/.dsh-ssh/jobs', 'log-job', { log: '0123456789abcdef' });
  const slice = await jobs.log(client, 'log-job', { offset: 4, maxBytes: 6 });
  assert.equal(slice.chunk, '456789');
  assert.equal(slice.offset, 4);
  assert.equal(slice.totalBytes, 16);
  assert.equal(slice.nextOffset, 10);
  assert.equal(slice.truncated, true);
});

test('Windows JobManager.stop kills the tree, records 143 and removes the task', async () => {
  const commands = [];
  const { jobs, session, calls, client } = windowsJobManager({
    exec: async (command) => {
      commands.push(command);
      if (command.includes('taskkill')) return { stdout: 'KILLED\r\n', stderr: '', exitCode: 0 };
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  });
  seedJob(session, '/C:/Users/me/.dsh-ssh/jobs', 'live-job', { pid: 777 });
  const outcome = await jobs.stop(client, 'live-job');
  assert.deepEqual(outcome, { jobId: 'live-job', stopped: true, pid: 777 });
  const exit = session.files.get('/C:/Users/me/.dsh-ssh/jobs/live-job/job.exit');
  assert.notEqual(exit, undefined);
  assert.equal(exit.content.toString('utf8'), '143');
  assert.ok(commands.some((command) => command.includes('taskkill') && command.includes('$dshTarget = 777')));
  assert.ok(calls.some((command) => command.includes('Unregister-ScheduledTask')));
});

test('Windows JobManager.list reports exited/running/unknown from files plus one process check', async () => {
  const { jobs, session, client } = windowsJobManager({
    exec: async (command) => (command.includes('Get-Process') ? { stdout: '4242\r\n', stderr: '', exitCode: 0 } : { stdout: '', stderr: '', exitCode: 0 }),
  });
  const root = '/C:/Users/me/.dsh-ssh/jobs';
  seedJob(session, root, 'job-a', { exitCode: 0, log: 'aaa' });
  seedJob(session, root, 'job-b', { pid: 4242, log: 'bb' });
  seedJob(session, root, 'job-c', { pid: 9999, log: 'c' });
  session.files.set('/C:/Users/me/.dsh-ssh/jobs/not-a-job.txt', { dir: false, content: Buffer.from('x') });
  const list = await jobs.list(client);
  assert.deepEqual(
    list.map((entry) => [entry.jobId, entry.state, entry.exitCode, entry.pid, entry.logBytes]),
    [
      ['job-c', 'unknown', -1, 9999, 1],
      ['job-b', 'running', -1, 4242, 2],
      ['job-a', 'exited', 0, -1, 3],
    ],
  );
  void jobs;
  void session;
  void client;
});

// ───────────────── review fixes: byte ranges, stop semantics, start diagnostics ─────────────────

test('readRemoteRange stops at a UTF-8 character boundary and reports consumed bytes', async () => {
  const session = memorySftp();
  const original = Buffer.from('中'.repeat(100), 'utf8');
  session.files.set('/C:/Users/me/log.txt', { dir: false, content: original });
  const first = await readRemoteRange(session, 'C:\\Users\\me\\log.txt', { offset: 0, maxBytes: 4 });
  assert.equal(first.chunk, '中');
  assert.equal(first.bytes, 3, 'the split character must not be counted as consumed');
  assert.ok(!first.chunk.includes('\uFFFD'));
  const second = await readRemoteRange(session, 'C:\\Users\\me\\log.txt', { offset: first.bytes, maxBytes: original.length });
  assert.equal(second.chunk, '中'.repeat(99));
  assert.equal(first.bytes + second.bytes, original.length);
});

test('Windows JobManager.log advances nextOffset by consumed bytes on CJK logs', async () => {
  const { jobs, session, client } = windowsJobManager();
  const content = '中'.repeat(50);
  seedJob(session, '/C:/Users/me/.dsh-ssh/jobs', 'cjk-job', { log: content });
  const first = await jobs.log(client, 'cjk-job', { offset: 0, maxBytes: 4 });
  assert.equal(first.chunk, '中');
  assert.equal(first.nextOffset, 3);
  assert.ok(!first.chunk.includes('\uFFFD'));
  const second = await jobs.log(client, 'cjk-job', { offset: first.nextOffset, maxBytes: 4096 });
  assert.equal(first.chunk + second.chunk, content);
  assert.equal(second.nextOffset, Buffer.byteLength(content, 'utf8'));
  assert.equal(second.truncated, false);
});

test('Windows JobManager.log makes progress even with a 1-byte window on CJK logs', async () => {
  const { jobs, session, client } = windowsJobManager();
  const content = '中'.repeat(50);
  seedJob(session, '/C:/Users/me/.dsh-ssh/jobs', 'tiny-job', { log: content });
  const slice = await jobs.log(client, 'tiny-job', { offset: 0, maxBytes: 1 });
  assert.ok(slice.chunk.length > 0, 'a window below one character must widen instead of returning nothing');
  assert.ok(!slice.chunk.includes('\uFFFD'));
  assert.ok(slice.nextOffset > 0);
  assert.equal(slice.nextOffset, Buffer.byteLength(slice.chunk, 'utf8'));
  assert.equal(slice.truncated, true);
});

test('Windows JobManager.stop does not claim a stop when the process was already gone', async () => {
  const { jobs, session, client } = windowsJobManager({
    exec: async (command) => (command.includes('taskkill') || command.includes('$dshTarget') ? { stdout: 'GONE\r\n', stderr: '', exitCode: 0 } : { stdout: '', stderr: '', exitCode: 0 }),
  });
  seedJob(session, '/C:/Users/me/.dsh-ssh/jobs', 'dead-job', { pid: 777 });
  const outcome = await jobs.stop(client, 'dead-job');
  assert.deepEqual(outcome, { jobId: 'dead-job', stopped: false, pid: 777 });
  assert.equal(session.files.get('/C:/Users/me/.dsh-ssh/jobs/dead-job/job.exit'), undefined, 'a job that ended on its own must not be marked as stopped');
});

test('Windows JobManager.start fails loudly when the task never reports a PID', async () => {
  const { jobs, client, calls } = windowsJobManager({
    exec: async (command) => {
      if (command.includes('Get-ScheduledTaskInfo')) return { stdout: 'task-state=Ready\r\ntask-last-result=1\r\n', stderr: '', exitCode: 0 };
      if (command.includes('Register-ScheduledTask')) return { stdout: 'started\r\ndsh-pid=\r\n', stderr: '', exitCode: 0 };
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  });
  await assert.rejects(
    () => jobs.start(client, { command: 'Write-Output "x"', jobId: 'nopid-job' }),
    /never reported a PID.*task-state=Ready/,
  );
  assert.ok(calls.some((command) => command.includes('Unregister-ScheduledTask')), 'the phantom task must be removed');
});
