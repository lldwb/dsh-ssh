/**
 * The SSH layer: one pooled connection per server, plus the three operations the
 * tools actually need — run a command, move bytes, keep a long job alive.
 *
 * ## Why a pool
 *
 * A training session issues dozens of calls against one machine (`nvidia-smi`,
 * upload the dataset, start training, poll the log). Opening a TCP connection,
 * a key exchange and an authentication handshake for each one costs a second or
 * more over a WAN; the pool pays that once. A connection is reused while its
 * fingerprint (host/port/user/auth/mtime) still matches the profile, and is
 * dropped the moment the profile changes or the transport closes.
 *
 * ## Why jobs are shell scripts instead of `command &`
 *
 * `ssh host 'long-command &'` is a classic trap: the channel closes, the process
 * gets SIGHUP, and "it worked locally" does not reproduce over SSH. A job here is
 * a small script uploaded to `~/.dsh-ssh/jobs/<id>/`, started with
 * `setsid nohup`, with its own PID file and an exit-code file written by the
 * script itself. That makes `status` answerable from the filesystem alone — no
 * process table parsing, no `pgrep` matching on a command line.
 *
 * ## The one escaping rule
 *
 * User-supplied commands are written *into* a script file verbatim: a shell parses
 * it once, exactly like a terminal. Everything else that reaches a shell (paths,
 * ids) goes through {@link shellQuote}. Nothing is ever concatenated into a
 * command unquoted.
 *
 * @module dsh-ssh/lib/ssh
 */

import fsp from 'node:fs/promises';
import path from 'node:path';

import {
  WINDOWS_JOBS_ROOT,
  assertWindowsWireFits,
  buildWindowsJobScript,
  isWindowsPath,
  normalizeWindowsPath,
  parsePowerShellResult,
  resolveWindowsRemotePath,
  windowsAlivePidsScript,
  windowsScriptBytes,
  windowsStopProcessScript,
  windowsTaskName,
  windowsTaskRegisterScript,
  windowsTaskRemoveScript,
  windowsTaskStateScript,
  windowsToSftpPath,
  wrapPowerShell,
} from './windows.mjs';

/** Cached `ssh2` module; `undefined` until the first attempt, `null` when it failed. */
let ssh2Module;

/**
 * Load `ssh2` lazily.
 *
 * A missing dependency must not stop the plugin from activating: the loader would
 * report `did not activate` and the user would have to read the desktop log to
 * find out that one `pnpm install` was missing. Lazy loading turns that into a
 * clear error from the first tool call instead.
 *
 * @returns {Promise<{ Client: any }>} the module.
 * @throws {Error} when the dependency is not installed.
 */
export async function loadSsh2() {
  if (ssh2Module !== undefined && ssh2Module !== null) return ssh2Module;
  try {
    ssh2Module = await import('ssh2');
    return ssh2Module;
  } catch (error) {
    ssh2Module = null;
    throw new Error(
      'dsh-ssh: the `ssh2` dependency is not installed. Run `pnpm install` (or `npm install`) inside the dsh-ssh package directory, then retry. ' +
        `Underlying error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Quote one value for a POSIX shell.
 *
 * POSIX single quotes preserve everything except a single quote, which is closed,
 * escaped and reopened (`'\''`). That is the only interpolation needed.
 *
 * @param {unknown} value - the value to quote.
 * @returns {string} a single-quoted shell word.
 */
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** Remote root of every job's directory, relative to `$HOME`. */
export const JOBS_ROOT = '.dsh-ssh/jobs';

/** A job id: generated here, so the pattern can be strict. */
export const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

/**
 * Validate a job id before it becomes a path segment.
 *
 * @param {unknown} value - candidate.
 * @returns {string} the id.
 * @throws {Error} when the id could escape the jobs directory.
 */
export function assertJobId(value) {
  if (typeof value !== 'string' || !JOB_ID.test(value)) {
    throw new Error(`dsh-ssh: invalid job id ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Generate a job id from an optional label.
 *
 * @param {string} [label] - human-readable prefix.
 * @param {() => number} [now] - clock source.
 * @returns {string} the id.
 */
export function makeJobId(label, now = Date.now) {
  const stamp = new Date(now()).toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const random = Math.random().toString(36).slice(2, 8);
  const prefix = String(label ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  return `${prefix === '' ? 'job' : prefix}-${stamp}-${random}`;
}

/**
 * Build the content of a job's `run.sh`.
 *
 * The command is embedded verbatim inside a subshell so that:
 * - a `cd` or `exit` in the command cannot end the wrapper;
 * - the exit status is captured even when the command fails;
 * - stdout and stderr both land in the log.
 *
 * `$$` is the wrapper's own PID, written before the command starts so `status`
 * never has to guess.
 *
 * @param {{ command: string, cwd: string, logFile: string, pidFile: string, exitFile: string }} spec - the job layout (all remote paths may be relative to the job dir).
 * @returns {string} the script text.
 */
export function jobScript(spec) {
  const cwd = spec.cwd === '' ? '$HOME' : shellQuote(spec.cwd);
  return `#!/bin/bash
# Generated by dsh-ssh. Do not edit: rewritten on every start.
echo $$ > ${shellQuote(spec.pidFile)}
cd ${cwd} 2>/dev/null || cd "$HOME"
(
${spec.command}
) > ${shellQuote(spec.logFile)} 2>&1
code=$?
echo "$code" > ${shellQuote(spec.exitFile)}
`;
}

/**
 * Collapse a byte stream into a bounded string.
 *
 * Keeps the head of the output — the part that says what a command is doing and
 * where it failed — and reports how much was dropped, because a silently
 * truncated log is worse than an explicit refusal to show more.
 *
 * @param {Buffer[]} chunks - received chunks.
 * @param {number} maxBytes - the cap.
 * @returns {{ text: string, bytes: number, truncated: boolean }} the collected output.
 */
export function collectBounded(chunks, maxBytes) {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const kept = [];
  let used = 0;
  for (const chunk of chunks) {
    if (used >= maxBytes) break;
    const room = maxBytes - used;
    if (chunk.length <= room) {
      kept.push(chunk);
      used += chunk.length;
    } else {
      kept.push(chunk.subarray(0, room));
      used = maxBytes;
      break;
    }
  }
  const text = Buffer.concat(kept).toString('utf8');
  return { text, bytes: total, truncated: total > used };
}

/**
 * Render a connection target for messages without leaking a secret.
 *
 * @param {{ user: string, host: string, port: number }} profile - the profile.
 * @returns {string} e.g. `root@10.0.0.1:22`.
 */
export function targetOf(profile) {
  return `${profile.user}@${profile.host}:${profile.port}`;
}

/**
 * A pooled set of SSH connections, keyed by profile name.
 */
export class SshPool {
  /**
   * @param {{ connectTimeoutMs?: number, idleTimeoutMs?: number }} [options] - pool options.
   */
  constructor(options = {}) {
    this.connectTimeoutMs = Number.isFinite(options.connectTimeoutMs) ? Number(options.connectTimeoutMs) : 15000;
    // An idle socket holds a remote sshd session open. Five minutes covers a
    // caller that pauses to think between related calls and still releases the
    // session when a session ends.
    this.idleTimeoutMs = Number.isFinite(options.idleTimeoutMs) ? Number(options.idleTimeoutMs) : 5 * 60 * 1000;
    /** @type {Map<string, { client: any, fingerprint: string, lastUsed: number, timer: NodeJS.Timeout | undefined }>} */
    this.entries = new Map();
  }

  /**
   * The fingerprint a connection must match to be reused.
   *
   * @param {Record<string, unknown>} profile - the profile.
   * @returns {string} the fingerprint.
   */
  static fingerprintOf(profile) {
    return [profile.host, profile.port, profile.user, profile.auth, profile.updatedAt ?? '', profile.privateKeyPath ?? ''].join('|');
  }

  /**
   * Get a live connection for one profile, opening one when needed.
   *
   * @param {Record<string, any>} profile - the profile.
   * @param {{ resolve: (ref: string) => Promise<string | undefined> }} secrets - the secret store.
   * @returns {Promise<any>} a ready `ssh2` Client.
   * @throws {Error} with an actionable message when the connection cannot be established.
   */
  async acquire(profile, secrets) {
    const name = String(profile.name);
    const fingerprint = SshPool.fingerprintOf(profile);
    const cached = this.entries.get(name);
    if (cached !== undefined && cached.fingerprint === fingerprint) {
      cached.lastUsed = Date.now();
      // Re-arm the idle timer on every reuse: the deadline is "no call for N
      // minutes", not "N minutes after connect". Without this a long working
      // session would drop its connection mid-conversation every five minutes.
      cached.timer = this.scheduleIdleClose(name, cached);
      return cached.client;
    }
    if (cached !== undefined) await this.disconnect(name);

    const client = await this.open(profile, secrets);
    const entry = { client, fingerprint, lastUsed: Date.now(), timer: undefined };
    entry.timer = this.scheduleIdleClose(name, entry);
    this.entries.set(name, entry);
    return client;
  }

  /**
   * Schedule closing one idle connection.
   *
   * @param {string} name - profile name.
   * @param {{ timer: NodeJS.Timeout | undefined }} entry - the pool entry.
   * @returns {NodeJS.Timeout | undefined} the timer.
   */
  scheduleIdleClose(name, entry) {
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    const idle = this.idleTimeoutMs;
    if (!Number.isFinite(idle) || idle <= 0) return undefined;
    const timer = setTimeout(() => {
      const current = this.entries.get(name);
      if (current === undefined || current.client !== entry.client) return;
      void this.disconnect(name);
    }, idle);
    timer.unref?.();
    return timer;
  }

  /**
   * Open and authenticate one connection.
   *
   * @param {Record<string, any>} profile - the profile.
   * @param {{ resolve: (ref: string) => Promise<string | undefined> }} secrets - the secret store.
   * @returns {Promise<any>} a ready client.
   */
  async open(profile, secrets) {
    const { Client } = await loadSsh2();
    /** @type {Record<string, unknown>} */
    const options = {
      host: profile.host,
      port: profile.port,
      username: profile.user,
      readyTimeout: this.connectTimeoutMs,
      keepaliveInterval: 10000,
      keepaliveCountMax: 3,
    };

    if (profile.auth === 'key') {
      const keyPath = String(profile.privateKeyPath ?? '');
      let privateKey;
      try {
        privateKey = await fsp.readFile(keyPath, 'utf8');
      } catch (error) {
        throw new Error(
          `dsh-ssh: cannot read the private key ${JSON.stringify(keyPath)} for ${targetOf(profile)}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      options.privateKey = privateKey;
      const passphrase = await secrets.resolve(String(profile.passphraseRef ?? ''));
      if (passphrase !== undefined && passphrase !== '') options.passphrase = passphrase;
    } else {
      const password = await secrets.resolve(String(profile.passwordRef ?? ''));
      if (password === undefined || password === '') {
        throw new Error(
          `dsh-ssh: no password stored for ${targetOf(profile)} (profile "${profile.name}", reference ${JSON.stringify(profile.passwordRef)}). ` +
            'Set it with ssh_host action="password" or from the plugin settings page.',
        );
      }
      options.password = password;
    }

    const client = new Client();
    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        if (error === undefined) resolve(undefined);
        else reject(error);
      };
      client.once('ready', () => finish(undefined));
      client.once('error', (error) => {
        finish(new Error(`dsh-ssh: connection to ${targetOf(profile)} failed: ${describeSshError(error)}`));
      });
      client.once('close', () => {
        // A close before 'ready' means the handshake died; after 'ready' the
        // pool learns about it from the 'close' handler attached below.
        finish(new Error(`dsh-ssh: connection to ${targetOf(profile)} closed before it became ready`));
      });
      try {
        client.connect(/** @type {any} */ (options));
      } catch (error) {
        finish(new Error(`dsh-ssh: could not start a connection to ${targetOf(profile)}: ${error instanceof Error ? error.message : String(error)}`));
      }
    });

    client.on('close', () => {
      for (const [name, entry] of this.entries) {
        if (entry.client === client) {
          if (entry.timer !== undefined) clearTimeout(entry.timer);
          this.entries.delete(name);
        }
      }
    });
    client.on('error', () => {
      // Post-ready errors are transport-level; the pool drops the entry on close.
    });

    return client;
  }

  /**
   * Close one connection.
   *
   * @param {string} name - profile name.
   * @returns {Promise<void>} resolves once the entry is gone.
   */
  async disconnect(name) {
    const entry = this.entries.get(name);
    if (entry === undefined) return;
    this.entries.delete(name);
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    try {
      entry.client.end();
    } catch {
      // End on a dead socket throws on some platforms; the entry is gone already.
    }
  }

  /**
   * Close every connection (plugin disposal).
   *
   * @returns {Promise<void>} resolves when all entries are closed.
   */
  async closeAll() {
    const names = [...this.entries.keys()];
    await Promise.all(names.map((name) => this.disconnect(name)));
  }
}

/**
 * Turn an ssh2 error into an actionable sentence.
 *
 * @param {unknown} error - the error.
 * @returns {string} the message.
 */
export function describeSshError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/All configured authentication methods failed/i.test(message)) {
    return 'authentication failed — check the user and the stored password/private key';
  }
  if (/ENOTFOUND|EAI_AGAIN/i.test(message)) return `host could not be resolved (${message})`;
  if (/ECONNREFUSED/i.test(message)) return 'connection refused — check the port and that sshd is listening';
  if (/ETIMEDOUT/i.test(message)) return 'connection timed out — check the address, port and firewall';
  if (/Cannot parse privateKey|bad passphrase|Encrypted private OpenSSH key/i.test(message)) {
    return `the private key could not be decrypted (${message})`;
  }
  if (/Timed out while waiting for handshake/i.test(message)) return 'the SSH handshake timed out';
  return message;
}

/**
 * Run one command verbatim over a connection, collecting bounded output.
 *
 * Kept separate from {@link execCommand} so platform detection can ask a raw
 * question before any shell wrapping exists. No quoting and no `cwd` prefix is
 * applied here: the caller owns the exact command line.
 *
 * @param {any} client - a ready `ssh2` client.
 * @param {string} command - the exact command line to send.
 * @param {{ timeoutMs?: number, maxOutputBytes?: number, env?: Record<string, string> }} [options] - execution options.
 * @returns {Promise<{ stdout: string, stderr: string, exitCode: number | null, signal: string | null, timedOut: boolean, stdoutBytes: number, stderrBytes: number, stdoutTruncated: boolean, stderrTruncated: boolean, durationMs: number }>} the result.
 */
async function execRawCommand(client, command, options = {}) {
  const maxOutputBytes = Number.isFinite(options.maxOutputBytes) ? Number(options.maxOutputBytes) : 65536;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Number(options.timeoutMs) : 120000;
  const started = Date.now();
  const outChunks = [];
  const errChunks = [];
  let outBytes = 0;
  let errBytes = 0;
  let outKept = 0;
  let errKept = 0;
  let timedOut = false;

  return await new Promise((resolve, reject) => {
    /** @param {Record<string, string> | undefined} env - the environment. */
    const onExec = (error, stream) => {
      if (error !== undefined && error !== null) {
        reject(new Error(`dsh-ssh: could not open a command channel: ${describeSshError(error)}`));
        return;
      }
      let timer;
      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer);
      };
      stream.on('data', (chunk) => {
        outBytes += chunk.length;
        if (outKept < maxOutputBytes) {
          const room = maxOutputBytes - outKept;
          const piece = chunk.length <= room ? chunk : chunk.subarray(0, room);
          outChunks.push(piece);
          outKept += piece.length;
        }
      });
      stream.stderr.on('data', (chunk) => {
        errBytes += chunk.length;
        if (errKept < maxOutputBytes) {
          const room = maxOutputBytes - errKept;
          const piece = chunk.length <= room ? chunk : chunk.subarray(0, room);
          errChunks.push(piece);
          errKept += piece.length;
        }
      });
      stream.on('close', (code, signal) => {
        cleanup();
        resolve({
          stdout: Buffer.concat(outChunks).toString('utf8'),
          stderr: Buffer.concat(errChunks).toString('utf8'),
          exitCode: typeof code === 'number' ? code : null,
          signal: typeof signal === 'string' ? signal : null,
          timedOut,
          stdoutBytes: outBytes,
          stderrBytes: errBytes,
          stdoutTruncated: outBytes > outKept,
          stderrTruncated: errBytes > errKept,
          durationMs: Date.now() - started,
        });
      });
      stream.on('error', (error) => {
        cleanup();
        reject(new Error(`dsh-ssh: command channel failed: ${describeSshError(error)}`));
      });
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          try {
            stream.close();
          } catch {
            // A stream that already closed is fine.
          }
        }, timeoutMs);
        timer.unref?.();
      }
    };

    try {
      if (options.env !== undefined && Object.keys(options.env).length > 0) client.exec(command, { env: options.env }, onExec);
      else client.exec(command, onExec);
    } catch (error) {
      reject(new Error(`dsh-ssh: could not execute over the connection: ${error instanceof Error ? error.message : String(error)}`));
    }
  });
}

/** Trim a diagnostic string for an error message. */
function preview(value, size = 160) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length <= size ? text : `${text.slice(0, size)}…`;
}

/**
 * Detect the remote platform once per pooled connection.
 *
 * `uname -s` is the cheap POSIX test and the first question. A Windows host that
 * defaults to cmd.exe answers with "not recognized" and a non-zero exit; that is
 * the signal to ask PowerShell for the OS version. MINGW/MSYS/CYGWIN `uname`
 * output means "Windows with a bash default shell", which still needs the
 * Windows wrapper and Windows path model, so it maps to `windows` too.
 *
 * The result is cached on the client, so the one extra round trip happens once
 * per connection (the pool reuses the client). A failure is not cached: a
 * transient channel problem should be retried on the next call.
 *
 * @param {any} client - a ready `ssh2` client.
 * @returns {Promise<{ kind: 'posix' | 'windows', family: string }>} the platform.
 * @throws {Error} when neither probe answers.
 */
export async function detectPlatform(client) {
  const cached = client.__dshSshPlatform;
  if (cached !== undefined && cached !== null) return cached;

  const uname = await execRawCommand(client, 'uname -s', { timeoutMs: 15000, maxOutputBytes: 4096 });
  const name = uname.stdout.trim().split(/\r?\n/)[0]?.trim() ?? '';
  if (uname.exitCode === 0 && name !== '') {
    const platform = { kind: /^(MINGW|MSYS|CYGWIN)/i.test(name) ? 'windows' : 'posix', family: name };
    client.__dshSshPlatform = platform;
    return platform;
  }

  const probe = wrapPowerShell('[Console]::Out.Write([Environment]::OSVersion.VersionString)');
  const raw = await execRawCommand(client, probe.wire, { timeoutMs: 20000, maxOutputBytes: 4096 });
  const parsed = parsePowerShellResult(raw.stdout, { nonce: probe.nonce, transportExitCode: raw.exitCode });
  if (parsed.exitCode === 0 && /Windows/i.test(parsed.stdout)) {
    const platform = { kind: 'windows', family: parsed.stdout.trim() };
    client.__dshSshPlatform = platform;
    return platform;
  }

  throw new Error(
    'dsh-ssh: could not determine the remote platform: `uname -s` failed and PowerShell did not answer either. ' +
      'Windows remotes need Windows PowerShell 5.1+; POSIX remotes need a working `uname`. ' +
      `uname: ${uname.exitCode === null ? 'no exit code' : `exit ${uname.exitCode}`}${uname.stderr.trim() === '' ? '' : ` (${preview(uname.stderr)})`}; ` +
      `powershell: ${parsed.exitCode === null ? 'no exit code' : `exit ${parsed.exitCode}`}${parsed.stdout.trim() === '' ? '' : ` (${preview(parsed.stdout)})`}`,
  );
}

/**
 * Run one command through the Windows PowerShell wrapper.
 *
 * @param {any} client - a ready `ssh2` client.
 * @param {string} command - the command, written in PowerShell.
 * @param {{ timeoutMs?: number, maxOutputBytes?: number, env?: Record<string, string>, cwd?: string }} options - execution options.
 * @returns {Promise<{ stdout: string, stderr: string, exitCode: number | null, signal: string | null, timedOut: boolean, stdoutBytes: number, stderrBytes: number, stdoutTruncated: boolean, stderrTruncated: boolean, durationMs: number }>} the result.
 */
async function execWindowsCommand(client, command, options) {
  const cwd = typeof options.cwd === 'string' && options.cwd.trim() !== '' ? options.cwd.trim() : '';
  const wrapped = wrapPowerShell(command, { cwd, env: options.env });
  assertWindowsWireFits(wrapped, command);
  // The environment is already baked into the script; passing it to ssh2 again
  // would expose the same values twice (and in the SSH request itself).
  const { env: _env, ...rawOptions } = options;
  const raw = await execRawCommand(client, wrapped.wire, rawOptions);
  const parsed = parsePowerShellResult(raw.stdout, { nonce: wrapped.nonce, transportExitCode: raw.exitCode });
  return {
    ...raw,
    stdout: parsed.stdout,
    exitCode: parsed.exitCode,
    stdoutBytes: Math.max(0, raw.stdoutBytes - parsed.markerBytes),
  };
}

/**
 * Run one command over an acquired connection.
 *
 * On a POSIX remote the command is written for `sh`/`bash` and `cwd` is applied
 * with `cd '<dir>' &&` before it. On a Windows remote the command is written for
 * PowerShell: it goes through {@link wrapPowerShell} (UTF-8 output, base64 wire,
 * nonce exit-code marker) and `cwd` is applied with `Set-Location`.
 *
 * @param {any} client - a ready `ssh2` client.
 * @param {string} command - the command: POSIX shell syntax, or PowerShell on Windows.
 * @param {{ cwd?: string, timeoutMs?: number, maxOutputBytes?: number, env?: Record<string, string> }} [options] - execution options.
 * @returns {Promise<{ stdout: string, stderr: string, exitCode: number | null, signal: string | null, timedOut: boolean, stdoutBytes: number, stderrBytes: number, stdoutTruncated: boolean, stderrTruncated: boolean, durationMs: number }>} the result.
 */
export async function execCommand(client, command, options = {}) {
  const platform = await detectPlatform(client);
  if (platform.kind === 'windows') return await execWindowsCommand(client, command, options);
  const cwd = typeof options.cwd === 'string' && options.cwd.trim() !== '' ? options.cwd.trim() : '';
  const finalCommand = cwd === '' ? command : `cd ${shellQuote(cwd)} && ${command}`;
  return await execRawCommand(client, finalCommand, options);
}

/**
 * Open an SFTP session, run one operation and close it.
 *
 * SFTP channels are cheap; the TCP connection is what the pool keeps. Opening one
 * per transfer keeps a hung transfer from poisoning the shared connection.
 *
 * @param {any} client - a ready `ssh2` client.
 * @param {(sftp: any) => Promise<any>} operation - the transfer.
 * @returns {Promise<any>} the operation's value.
 */
export async function withSftp(client, operation) {
  const sftp = await new Promise((resolve, reject) => {
    client.sftp((error, session) => {
      if (error !== undefined && error !== null) reject(new Error(`dsh-ssh: could not open an SFTP session: ${describeSshError(error)}`));
      else resolve(session);
    });
  });
  try {
    return await operation(sftp);
  } finally {
    try {
      sftp.end();
    } catch {
      // Already closed.
    }
  }
}

/**
 * Convert one logical remote path to the SFTP server's spelling.
 *
 * Logical paths on a Windows remote are Windows-spelled (`C:\…`) because that is
 * what the shell receives and what a tool result shows; OpenSSH's SFTP server
 * addresses the same file as `/C:/…` (that is the shape `realpath('.')` returns).
 * POSIX paths pass through unchanged, and a path already in SFTP spelling is
 * idempotent.
 *
 * @param {unknown} value - a logical remote path.
 * @returns {unknown} the SFTP-spelled path.
 */
export function toSftpPath(value) {
  if (typeof value !== 'string') return value;
  if (/^[A-Za-z]:/.test(value)) return windowsToSftpPath(value);
  if (/^\/[A-Za-z]:/.test(value)) return value.replace(/\\/g, '/');
  return value;
}

/**
 * The parent of an SFTP-spelled path, or `''` for a root.
 *
 * @param {string} value - an SFTP path.
 * @returns {string} the parent.
 */
function sftpParentOf(value) {
  const trimmed = String(value).replace(/\/+$/, '');
  const index = trimmed.lastIndexOf('/');
  if (index <= 0) return '';
  const parent = trimmed.slice(0, index);
  return /^\/[A-Za-z]:$/.test(parent) ? '' : parent;
}

/**
 * List a remote directory with lstat detail.
 *
 * @param {any} sftp - the SFTP session.
 * @param {string} target - absolute or home-relative path.
 * @returns {Promise<Array<{ name: string, isDirectory: boolean, size: number, longname: string }>>} entries.
 */
export async function readdir(sftp, target) {
  const remote = toSftpPath(target);
  const entries = await new Promise((resolve, reject) => {
    sftp.readdir(remote, (error, list) => {
      if (error !== undefined && error !== null) reject(new Error(`dsh-ssh: cannot list ${JSON.stringify(target)}: ${describeSshError(error)}`));
      else resolve(list);
    });
  });
  return entries.map((entry) => ({
    name: String(entry.filename),
    isDirectory: entry.attrs !== undefined && typeof entry.attrs.isDirectory === 'function' && entry.attrs.isDirectory(),
    size: entry.attrs !== undefined && typeof entry.attrs.size === 'number' ? entry.attrs.size : 0,
    longname: String(entry.longname ?? ''),
  }));
}

/**
 * Stat one remote path.
 *
 * @param {any} sftp - the SFTP session.
 * @param {string} target - the logical remote path.
 * @returns {Promise<any>} ssh2 attributes (`isDirectory()`, `size`, …).
 * @throws {Error} when the path cannot be read.
 */
export async function statRemote(sftp, target) {
  const remote = toSftpPath(target);
  return await new Promise((resolve, reject) => {
    sftp.stat(remote, (error, stats) => {
      if (error !== undefined && error !== null) reject(new Error(`dsh-ssh: cannot stat ${JSON.stringify(target)}: ${describeSshError(error)}`));
      else resolve(stats);
    });
  });
}

/**
 * Write one remote file (creating its parent directory if needed).
 *
 * @param {any} sftp - the SFTP session.
 * @param {string} target - the logical remote path.
 * @param {string | Buffer} content - bytes or UTF-8 text.
 * @returns {Promise<void>} resolves once the stream closed.
 * @throws {Error} on a failed write.
 */
export async function writeRemoteFile(sftp, target, content) {
  const remote = toSftpPath(target);
  const parent = sftpParentOf(remote);
  if (parent !== '') await mkdirp(sftp, parent);
  await new Promise((resolve, reject) => {
    const stream = sftp.createWriteStream(remote);
    stream.on('close', resolve);
    stream.on('error', (error) => reject(new Error(`dsh-ssh: cannot write ${JSON.stringify(target)}: ${describeSshError(error)}`)));
    stream.end(content);
  });
}

/**
 * Drop an incomplete UTF-8 sequence from the end of a byte slice.
 *
 * A byte-range read may stop in the middle of a multi-byte character. Decoding
 * that slice and reporting its byte length as "consumed" makes the caller's next
 * offset drift off the character boundary and inserts U+FFFD into every chunk.
 * Trimming to the last complete character instead leaves the partial bytes to be
 * read by the next call: no loss, no drift, no replacement characters.
 *
 * This is only meaningful for UTF-8 text logs (the job manager's contract). A
 * truly invalid trailing byte is dropped rather than kept: the next call misses
 * that byte, which is preferable to an endless no-progress read.
 *
 * @param {Buffer} buffer - the bytes read.
 * @returns {Buffer} the bytes up to the last complete UTF-8 sequence.
 */
function trimIncompleteUtf8(buffer) {
  let cut = buffer.length;
  while (cut > 0 && (buffer[cut - 1] & 0xc0) === 0x80) cut -= 1;
  if (cut === 0) return buffer;
  const lead = buffer[cut - 1];
  let needed = 1;
  if (lead >= 0xf0) needed = 4;
  else if (lead >= 0xe0) needed = 3;
  else if (lead >= 0xc0) needed = 2;
  if (cut - 1 + needed <= buffer.length) return buffer;
  return buffer.subarray(0, cut - 1);
}

/**
 * Read a byte range of one remote file.
 *
 * Used by the Windows job manager, where byte offsets are the contract: reading
 * over SFTP keeps the bytes exact (no shell encoding, no `tail`/`wc` dependency).
 * The slice stops at a UTF-8 character boundary (see {@link trimIncompleteUtf8}),
 * and `bytes` is the number of bytes actually consumed — the caller must advance
 * `offset` by that, not by the decoded string's length.
 *
 * @param {any} sftp - the SFTP session.
 * @param {string} target - the logical remote path.
 * @param {{ offset?: number, maxBytes?: number }} [options] - range.
 * @returns {Promise<{ chunk: string, offset: number, totalBytes: number, bytes: number }>} the slice.
 * @throws {Error} when the file cannot be statted or read.
 */
export async function readRemoteRange(sftp, target, options = {}) {
  const offset = Number.isFinite(options.offset) && Number(options.offset) > 0 ? Math.floor(Number(options.offset)) : 0;
  const maxBytes = Number.isFinite(options.maxBytes) && Number(options.maxBytes) > 0 ? Math.floor(Number(options.maxBytes)) : 65536;
  const remote = toSftpPath(target);
  const attrs = await statRemote(sftp, target);
  const totalBytes = attrs !== null && attrs !== undefined && typeof attrs.size === 'number' ? attrs.size : 0;
  if (offset >= totalBytes) return { chunk: '', offset, totalBytes, bytes: 0 };
  const chunks = [];
  await new Promise((resolve, reject) => {
    const stream = sftp.createReadStream(remote, { start: offset, end: offset + maxBytes - 1 });
    stream.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    stream.on('end', resolve);
    stream.on('error', (error) => reject(new Error(`dsh-ssh: cannot read ${JSON.stringify(target)}: ${describeSshError(error)}`)));
  });
  const buffer = trimIncompleteUtf8(Buffer.concat(chunks));
  return { chunk: buffer.toString('utf8'), offset, totalBytes, bytes: buffer.length };
}

/**
 * Read a small remote file as UTF-8 text.
 *
 * @param {any} sftp - the SFTP session.
 * @param {string} target - the logical remote path.
 * @param {{ maxBytes?: number }} [options] - byte cap.
 * @returns {Promise<string>} the file content.
 * @throws {Error} when the file cannot be read.
 */
export async function readRemoteText(sftp, target, options = {}) {
  const slice = await readRemoteRange(sftp, target, { maxBytes: Number.isFinite(options.maxBytes) ? Number(options.maxBytes) : 65536 });
  return slice.chunk;
}

/**
 * Create a remote directory and its parents.
 *
 * @param {any} sftp - the SFTP session.
 * @param {string} target - the directory path (absolute, or relative to home).
 * @returns {Promise<void>} resolves when the directory exists.
 */
export async function mkdirp(sftp, target) {
  const remote = toSftpPath(target);
  const isAbsolute = String(remote).startsWith('/');
  const parts = String(remote).split('/').filter((part) => part !== '');
  // Relative paths must stay relative: a leading `/` here would silently create
  // the same name at the filesystem root instead of under the SFTP session's
  // working directory.
  let current = isAbsolute ? '' : '.';
  for (const part of parts) {
    current = current === '.' ? part : `${current}/${part}`;
    const created = await new Promise((resolve) => {
      sftp.mkdir(current, (error) => resolve(error === undefined || error === null));
    });
    if (!created) {
      // Either it already exists, or it exists as a file — the next operation
      // reports the real problem.
      continue;
    }
  }
}

/**
 * Resolve one connection's home directory, cached on the client.
 *
 * SFTP does not expand `~`: the protocol hands the raw path to the server's
 * `sftp-server`, which treats it as the literal name of a directory under the
 * *current* working directory. A naive `mkdir -p '~/.dsh-ssh/jobs/x'` therefore
 * creates a directory literally named `~`. The only correct expansion is the
 * value the shell reports, so it is asked for once per connection.
 *
 * POSIX asks `$HOME`; Windows asks `[Environment]::GetFolderPath('UserProfile')`
 * and returns the Windows spelling (`C:\Users\…`) — every logical path the
 * plugin handles on a Windows remote is Windows-spelled and converted to
 * `/C:/…` only at the SFTP boundary.
 *
 * @param {any} client - a ready `ssh2` client.
 * @returns {Promise<string>} the absolute home directory, e.g. `/root` or `C:\Users\me`.
 * @throws {Error} when the probe fails.
 */
export async function resolveHome(client) {
  const cached = client.__dshSshHome;
  if (typeof cached === 'string' && cached !== '') return cached;
  const platform = await detectPlatform(client);
  if (platform.kind === 'windows') {
    const probe = wrapPowerShell('[Console]::Out.Write([Environment]::GetFolderPath("UserProfile"))');
    const raw = await execRawCommand(client, probe.wire, { timeoutMs: 15000, maxOutputBytes: 4096 });
    const parsed = parsePowerShellResult(raw.stdout, { nonce: probe.nonce, transportExitCode: raw.exitCode });
    const home = parsed.stdout.trim();
    if (parsed.exitCode !== 0 || !/^[A-Za-z]:[\\/]/.test(home)) {
      const detail = parsed.exitCode === 0 ? home || preview(raw.stderr) : `exit ${parsed.exitCode}`;
      throw new Error(`dsh-ssh: could not resolve the remote home directory on Windows${detail === '' ? '' : `: ${detail}`}`);
    }
    const normalized = normalizeWindowsPath(home);
    client.__dshSshHome = normalized;
    return normalized;
  }
  const result = await execCommand(client, 'printf %s "$HOME"', { timeoutMs: 15000, maxOutputBytes: 4096 });
  const home = result.stdout.trim();
  if (result.exitCode !== 0 || home === '' || !home.startsWith('/')) {
    throw new Error(`dsh-ssh: could not resolve the remote home directory${result.stderr.trim() === '' ? '' : `: ${result.stderr.trim()}`}`);
  }
  client.__dshSshHome = home;
  return home;
}

/**
 * Normalise a remote path, expanding `~` and resolving relative paths.
 *
 * A relative path is resolved against the profile's default remote directory; an
 * absolute one is returned unchanged. `~` is expanded only when a resolved home
 * is supplied — a caller that needs it must call {@link resolveHome} first,
 * because guessing (the old `/root` shortcut) is wrong for any non-root user.
 *
 * On a Windows remote the path is normalised to the Windows spelling
 * (`C:\…`), and the returned value is what callers display and what the shell
 * receives; SFTP functions convert it to `/C:/…` at their own boundary.
 *
 * @param {string} target - caller-supplied path.
 * @param {string} [defaultDir] - profile's default directory, used for relative paths.
 * @param {string} [home] - resolved remote home, for `~` expansion.
 * @param {{ kind: string } | string} [platform] - detected platform; inferred from `home` when omitted.
 * @returns {string} an absolute remote path.
 * @throws {Error} when the path is unusable or `~` cannot be expanded.
 */
export function resolveRemotePath(target, defaultDir, home, platform) {
  const kind = typeof platform === 'string' ? platform : (platform?.kind ?? (isWindowsPath(home) ? 'windows' : 'posix'));
  if (kind === 'windows') return resolveWindowsRemotePath(target, defaultDir, home);

  if (typeof target !== 'string' || target.trim() === '') throw new Error('dsh-ssh: a remote path is required');
  const raw = target.trim();
  if (raw.includes('\u0000') || /[\r\n]/.test(raw)) throw new Error('dsh-ssh: a remote path must not contain newlines or NUL');

  /** @param {string} value - a path that may start with `~`. */
  const expand = (value) => {
    if (value === '~') {
      if (typeof home !== 'string' || home === '') throw new Error('dsh-ssh: cannot expand "~" without a resolved home directory');
      return home;
    }
    if (value.startsWith('~/')) {
      if (typeof home !== 'string' || home === '') throw new Error('dsh-ssh: cannot expand "~/" without a resolved home directory');
      return `${home.replace(/\/+$/, '')}/${value.slice(2)}`;
    }
    return value;
  };

  const expanded = expand(raw);
  if (expanded.startsWith('/')) return expanded;
  const baseRaw = typeof defaultDir === 'string' && defaultDir.trim() !== '' ? defaultDir.trim() : '';
  // With no configured default directory, a relative path must still become
  // absolute: SFTP's and curl's notion of "current directory" is the server's
  // login home for one and a per-session default for the other, so leaving it
  // relative makes the destination depend on the transport. Falling back to the
  // resolved home keeps both transports on the same file.
  const base = baseRaw === '' ? (typeof home === 'string' && home !== '' ? home : '') : expand(baseRaw);
  if (base === '') throw new Error(`dsh-ssh: relative remote path ${JSON.stringify(raw)} needs a default remote directory or a resolved home directory`);
  const joined = `${base.replace(/\/+$/, '')}/${expanded}`;
  return joined;
}

/**
 * Upload one local file.
 *
 * @param {any} sftp - the SFTP session.
 * @param {string} localPath - absolute local path.
 * @param {string} remotePath - remote path.
 * @returns {Promise<number>} bytes transferred.
 */
export async function uploadFile(sftp, localPath, remotePath) {
  const stats = await fsp.stat(localPath);
  if (!stats.isFile()) throw new Error(`dsh-ssh: ${localPath} is not a regular file`);
  const remote = toSftpPath(remotePath);
  const parent = sftpParentOf(remote);
  if (parent !== '') await mkdirp(sftp, parent);
  await new Promise((resolve, reject) => {
    sftp.fastPut(localPath, remote, (error) => {
      if (error !== undefined && error !== null) reject(new Error(`dsh-ssh: cannot upload ${localPath} to ${remotePath}: ${describeSshError(error)}`));
      else resolve(undefined);
    });
  });
  return stats.size;
}

/**
 * Upload a directory tree.
 *
 * @param {any} sftp - the SFTP session.
 * @param {string} localDir - absolute local directory.
 * @param {string} remoteDir - remote directory.
 * @returns {Promise<{ files: number, bytes: number }>} transfer statistics.
 */
export async function uploadDirectory(sftp, localDir, remoteDir) {
  const root = toSftpPath(remoteDir);
  await mkdirp(sftp, root);
  /** @type {{ files: number, bytes: number }} */
  const totals = { files: 0, bytes: 0 };
  const walk = async (from, to) => {
    const entries = await fsp.readdir(from, { withFileTypes: true });
    for (const entry of entries) {
      const localChild = path.join(from, entry.name);
      const remoteChild = `${String(to).replace(/\/+$/, '')}/${entry.name}`;
      if (entry.isDirectory()) {
        await mkdirp(sftp, remoteChild);
        await walk(localChild, remoteChild);
      } else if (entry.isFile()) {
        totals.bytes += await uploadFile(sftp, localChild, remoteChild);
        totals.files += 1;
      }
      // Symlinks are skipped on purpose: following one can leave the tree the
      // caller asked for and, on a Windows source, can point at a junction cycle.
    }
  };
  await walk(localDir, root);
  return totals;
}

/**
 * Download one remote file.
 *
 * @param {any} sftp - the SFTP session.
 * @param {string} remotePath - remote path.
 * @param {string} localPath - absolute local path.
 * @returns {Promise<number>} bytes transferred.
 */
export async function downloadFile(sftp, remotePath, localPath) {
  await fsp.mkdir(path.dirname(localPath), { recursive: true });
  const remote = toSftpPath(remotePath);
  await new Promise((resolve, reject) => {
    sftp.fastGet(remote, localPath, (error) => {
      if (error !== undefined && error !== null) reject(new Error(`dsh-ssh: cannot download ${remotePath}: ${describeSshError(error)}`));
      else resolve(undefined);
    });
  });
  const stats = await fsp.stat(localPath);
  return stats.size;
}

/**
 * Download a remote directory tree.
 *
 * @param {any} sftp - the SFTP session.
 * @param {string} remoteDir - remote directory.
 * @param {string} localDir - absolute local directory.
 * @returns {Promise<{ files: number, bytes: number }>} transfer statistics.
 */
export async function downloadDirectory(sftp, remoteDir, localDir) {
  await fsp.mkdir(localDir, { recursive: true });
  const root = toSftpPath(remoteDir);
  /** @type {{ files: number, bytes: number }} */
  const totals = { files: 0, bytes: 0 };
  const walk = async (from, to) => {
    const entries = await readdir(sftp, from);
    for (const entry of entries) {
      if (entry.name === '.' || entry.name === '..') continue;
      const remoteChild = `${String(from).replace(/\/+$/, '')}/${entry.name}`;
      const localChild = path.join(to, entry.name);
      if (entry.isDirectory) {
        await fsp.mkdir(localChild, { recursive: true });
        await walk(remoteChild, localChild);
      } else {
        totals.bytes += await downloadFile(sftp, remoteChild, localChild);
        totals.files += 1;
      }
    }
  };
  await walk(root, localDir);
  return totals;
}

/**
 * Parse one small remote file that should contain a number (`job.pid`,
 * `job.exit`). Returns `undefined` for anything unparsable so callers can decide
 * whether that means "not written yet" or "unexpected content".
 *
 * @param {unknown} text - file content.
 * @param {number} minimum - smallest accepted value.
 * @returns {number | undefined} the number.
 */
function parseRemoteNumber(text, minimum) {
  const value = Number.parseInt(String(text ?? '').trim(), 10);
  return Number.isInteger(value) && value >= minimum ? value : undefined;
}

/**
 * The job manager: scripts, status, logs and termination for long-running remote
 * commands.
 *
 * Two implementations share one caller-facing contract. POSIX uses an uploaded
 * `run.sh` started with `setsid nohup` and answers status from `kill -0`. Windows
 * uploads a `job.ps1`, starts it through a scheduled task (the only detach
 * mechanism that survives the SSH session — see the `windows` module note) and
 * answers status from the job files over SFTP plus one `Get-Process` check.
 */
export class JobManager {
  /**
   * @param {{ exec: typeof execCommand, sftp: typeof withSftp }} [deps] - injectable for tests.
   */
  constructor(deps = {}) {
    this.exec = deps.exec ?? execCommand;
    this.sftp = deps.sftp ?? withSftp;
  }

  /**
   * The absolute remote directory of one job.
   *
   * Absolute on purpose: every remote command here quotes paths with
   * {@link shellQuote}, and single quotes stop `~` from expanding. The home
   * directory is resolved once per connection instead.
   *
   * @param {string} home - the resolved remote home.
   * @param {string} jobId - validated job id.
   * @returns {string} e.g. `/root/.dsh-ssh/jobs/train-20261021…` or `C:\Users\me\.dsh-ssh\jobs\…`.
   */
  jobDir(home, jobId) {
    const base = String(home).replace(/[\\/]+$/, '');
    const id = assertJobId(jobId);
    return isWindowsPath(home) ? `${base}\\${WINDOWS_JOBS_ROOT}\\${id}` : `${base}/${JOBS_ROOT}/${id}`;
  }

  /**
   * Start one job on a Windows remote through a scheduled task.
   *
   * The script is uploaded with a UTF-8 BOM (PowerShell 5.1 would otherwise read
   * non-ASCII paths in it as ANSI), registered as a task that runs a `.ps1`
   * directly, and started. The task itself is removed when the job is seen
   * finished or stopped.
   *
   * @param {any} client - a ready client.
   * @param {{ command: string, label?: string, cwd?: string, jobId?: string }} request - what to run.
   * @returns {Promise<{ jobId: string, dir: string, pid: number | null, logFile: string, startedAt: string }>} the job handle.
   */
  async startWindows(client, request) {
    const jobId = request.jobId === undefined ? makeJobId(request.label) : assertJobId(request.jobId);
    const home = await resolveHome(client);
    const dir = this.jobDir(home, jobId);
    const pidFile = `${dir}\\job.pid`;
    const exitFile = `${dir}\\job.exit`;
    const logFile = `${dir}\\job.log`;
    const cwd = typeof request.cwd === 'string' ? request.cwd.trim() : '';
    const resolvedCwd = cwd === '' ? '' : resolveRemotePath(cwd, home, home, 'windows');
    const taskName = windowsTaskName(jobId);
    const script = buildWindowsJobScript({ command: request.command, cwd: resolvedCwd, logFile, pidFile, exitFile, taskName });
    const scriptPath = `${dir}\\job.ps1`;

    await this.sftp(client, async (sftp) => {
      await mkdirp(sftp, dir);
      await writeRemoteFile(sftp, scriptPath, windowsScriptBytes(script));
    });

    const registered = await this.exec(client, windowsTaskRegisterScript({ taskName, scriptPath, pidFile }), { timeoutMs: 120000 });
    if (registered.exitCode !== 0) {
      throw new Error(
        `dsh-ssh: could not start job ${jobId} on the Windows remote: ${registered.stderr.trim() || `exit ${String(registered.exitCode)}`}. ` +
          `The job directory ${dir} is kept for inspection; remove it with ssh_exec if it is not needed.`,
      );
    }
    const pidMatch = /dsh-pid=(\d+)/.exec(registered.stdout);
    let pid = pidMatch === null ? null : Number.parseInt(pidMatch[1], 10);

    if (pid === null) {
      // The registration script waits for job.ps1's PID before returning. An empty
      // answer means the task never got far enough to write it. A task that is
      // merely slow (state=Running) gets one short grace read on the SFTP path
      // before the failure is reported.
      const diagnostic = await this.exec(client, windowsTaskStateScript(taskName), { timeoutMs: 30000 }).catch(() => undefined);
      const detail =
        diagnostic === undefined || diagnostic.stdout.trim() === ''
          ? 'no task state available'
          : diagnostic.stdout.trim().split(/\r?\n/).join(', ');
      if (/task-state=Running/i.test(detail)) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        try {
          const text = await this.sftp(client, async (sftp) => await readRemoteText(sftp, pidFile, { maxBytes: 64 }));
          const parsed = Number.parseInt(text.trim(), 10);
          if (Number.isInteger(parsed) && parsed > 0) pid = parsed;
        } catch {
          // Still nothing; fall through to the error.
        }
      }
      if (pid === null) {
        await this.removeWindowsTask(client, jobId);
        throw new Error(
          `dsh-ssh: the Windows scheduled task for job ${jobId} was registered but never reported a PID (${detail}). ` +
            'This usually means Task Scheduler could not start the task — the login user may lack permission to register/run tasks, ' +
            `or PowerShell could not start. The job directory ${dir} is kept for inspection (job.log/job.exit); check the Task Scheduler history too.`,
        );
      }
    }
    return { jobId, dir, pid, logFile, startedAt: new Date().toISOString() };
  }

  /**
   * Read one Windows job's files in one SFTP session.
   *
   * @param {any} client - a ready client.
   * @param {string} dir - the job directory (Windows spelling).
   * @returns {Promise<{ missing: boolean, logBytes: number, exitCode?: number, pid?: number, pidText?: string }>} the snapshot.
   */
  async readWindowsJobState(client, dir) {
    return await this.sftp(client, async (sftp) => {
      const exists = await statRemote(sftp, dir).then(() => true).catch(() => false);
      if (!exists) return { missing: true, logBytes: 0 };
      const logBytes = await statRemote(sftp, `${dir}\\job.log`)
        .then((attrs) => (typeof attrs.size === 'number' ? attrs.size : 0))
        .catch(() => 0);
      const exitText = await readRemoteText(sftp, `${dir}\\job.exit`, { maxBytes: 64 }).catch(() => undefined);
      if (exitText !== undefined) return { missing: false, logBytes, exitCode: parseRemoteNumber(exitText, 0) ?? -1 };
      const pidText = await readRemoteText(sftp, `${dir}\\job.pid`, { maxBytes: 64 }).catch(() => '');
      return { missing: false, logBytes, pid: parseRemoteNumber(pidText, 1), pidText: pidText.trim() };
    });
  }

  /**
   * Read one Windows job's state.
   *
   * @param {any} client - a ready client.
   * @param {string} jobId - validated id.
   * @returns {Promise<{ jobId: string, state: 'running' | 'exited' | 'unknown', exitCode: number, pid: number, logBytes: number }>} the state.
   */
  async statusWindows(client, jobId) {
    const home = await resolveHome(client);
    const dir = this.jobDir(home, jobId);
    const snapshot = await this.readWindowsJobState(client, dir);
    if (snapshot.missing) return { jobId, state: 'unknown', exitCode: -1, pid: -1, logBytes: 0 };
    if (snapshot.exitCode !== undefined) {
      // The task has done its work and stays registered until someone removes
      // it; polling status is that someone.
      await this.removeWindowsTask(client, jobId);
      return { jobId, state: 'exited', exitCode: snapshot.exitCode, pid: -1, logBytes: snapshot.logBytes };
    }
    if (snapshot.pid !== undefined && (await this.alivePids(client, [snapshot.pid])).has(snapshot.pid)) {
      return { jobId, state: 'running', exitCode: -1, pid: snapshot.pid, logBytes: snapshot.logBytes };
    }
    return { jobId, state: 'unknown', exitCode: -1, pid: snapshot.pid ?? -1, logBytes: snapshot.logBytes };
  }

  /**
   * Read a slice of one Windows job's log over SFTP.
   *
   * Byte ranges over SFTP are exact and need no shell (`tail`/`wc` do not exist
   * on Windows), which is why this branch does not use {@link execCommand}.
   *
   * @param {any} client - a ready client.
   * @param {string} jobId - validated id.
   * @param {{ offset?: number, maxBytes?: number }} [options] - byte offset and cap.
   * @returns {Promise<{ jobId: string, chunk: string, offset: number, totalBytes: number, nextOffset: number, truncated: boolean }>} the slice.
   */
  async logWindows(client, jobId, options = {}) {
    const home = await resolveHome(client);
    const dir = this.jobDir(home, jobId);
    const offset = Number.isFinite(options.offset) && Number(options.offset) > 0 ? Math.floor(Number(options.offset)) : 0;
    const maxBytes = Number.isFinite(options.maxBytes) && Number(options.maxBytes) > 0 ? Math.floor(Number(options.maxBytes)) : 65536;
    const slice = await this.sftp(client, async (sftp) => {
      try {
        return await readRemoteRange(sftp, `${dir}\\job.log`, { offset, maxBytes });
      } catch {
        return { chunk: '', offset, totalBytes: 0, bytes: 0 };
      }
    });
    // A window smaller than one encoded character (maxBytes 1–3) trims to zero
    // bytes, so a caller that loops on `truncated` would spin forever. Re-read
    // with a window large enough for any UTF-8 character.
    let effective = slice;
    if (slice.chunk === '' && slice.bytes === 0 && offset < slice.totalBytes) {
      effective = await this.sftp(client, async (sftp) => {
        try {
          return await readRemoteRange(sftp, `${dir}\\job.log`, { offset, maxBytes: Math.max(16, maxBytes * 4) });
        } catch {
          return { chunk: '', offset, totalBytes: slice.totalBytes, bytes: 0 };
        }
      });
    }
    const chunk = effective.chunk;
    // Advance by the bytes actually consumed (a UTF-8 character boundary), not by
    // the decoded string's byte length: those differ when a multi-byte character
    // is split, and the difference would make every subsequent read lose bytes.
    const nextOffset = offset + effective.bytes;
    return { jobId, chunk, offset, totalBytes: effective.totalBytes, nextOffset, truncated: nextOffset < effective.totalBytes };
  }

  /**
   * Stop one Windows job: kill the process tree, record the stop, remove the task.
   *
   * The killed process cannot write its own exit-code file (the write happens
   * after the command returns), so a successful stop records `143` — the
   * conventional "terminated by SIGTERM" code — and `status` can then answer
   * `exited` instead of `unknown`.
   *
   * @param {any} client - a ready client.
   * @param {string} jobId - validated id.
   * @returns {Promise<{ jobId: string, stopped: boolean, pid: number }>} the outcome.
   */
  async stopWindows(client, jobId) {
    const home = await resolveHome(client);
    const dir = this.jobDir(home, jobId);
    const snapshot = await this.readWindowsJobState(client, dir);
    if (snapshot.missing || snapshot.exitCode !== undefined || snapshot.pid === undefined) {
      await this.removeWindowsTask(client, jobId);
      return { jobId, stopped: false, pid: -1 };
    }
    const kill = await this.exec(client, windowsStopProcessScript(snapshot.pid), { timeoutMs: 30000 });
    const stopped = /\bKILLED\b/.test(kill.stdout);
    if (stopped) {
      // Only record 143 when the process was actually killed; a job whose process
      // had already vanished is not a successful stop, and claiming otherwise
      // would tell the user it was terminated when it simply ended.
      try {
        await this.sftp(client, async (sftp) => {
          await writeRemoteFile(sftp, `${dir}\\job.exit`, '143');
        });
      } catch {
        // The record is a convenience; the process is already gone.
      }
    }
    await this.removeWindowsTask(client, jobId);
    return { jobId, stopped, pid: snapshot.pid };
  }

  /**
   * List this Windows remote's jobs, newest first.
   *
   * @param {any} client - a ready client.
   * @returns {Promise<Array<{ jobId: string, state: string, exitCode: number, pid: number, logBytes: number }>>} jobs.
   */
  async listWindows(client) {
    const home = await resolveHome(client);
    const root = `${home.replace(/[\\/]+$/, '')}\\${WINDOWS_JOBS_ROOT}`;
    const entries = await this.sftp(client, async (sftp) => {
      /** @type {any[]} */
      const remoteEntries = await new Promise((resolve) => {
        sftp.readdir(toSftpPath(root), (error, list) => resolve(error === undefined || error === null ? list : []));
      });
      /** @type {Array<{ jobId: string, logBytes: number, exitCode?: number, pid?: number }>} */
      const found = [];
      for (const entry of remoteEntries) {
        const jobId = String(entry.filename);
        if (!JOB_ID.test(jobId)) continue;
        // Jobs are directories. Without this, a stray file whose name happens to
        // match the id pattern (`notes.txt`) would be listed as an unknown job.
        const isDirectory = entry.attrs !== undefined && typeof entry.attrs.isDirectory === 'function' && entry.attrs.isDirectory();
        if (!isDirectory) continue;
        const dir = `${root}\\${jobId}`;
        const logBytes = await statRemote(sftp, `${dir}\\job.log`)
          .then((attrs) => (typeof attrs.size === 'number' ? attrs.size : 0))
          .catch(() => 0);
        const exitText = await readRemoteText(sftp, `${dir}\\job.exit`, { maxBytes: 64 }).catch(() => undefined);
        const pidText = exitText === undefined ? await readRemoteText(sftp, `${dir}\\job.pid`, { maxBytes: 64 }).catch(() => '') : '';
        found.push({
          jobId,
          logBytes,
          exitCode: exitText === undefined ? undefined : (parseRemoteNumber(exitText, 0) ?? -1),
          pid: parseRemoteNumber(pidText, 1),
        });
      }
      return found;
    });
    const alive = await this.alivePids(client, entries.filter((entry) => entry.exitCode === undefined && entry.pid !== undefined).map((entry) => entry.pid));
    const jobs = entries.map((entry) => {
      if (entry.exitCode !== undefined) return { jobId: entry.jobId, state: 'exited', exitCode: entry.exitCode, pid: -1, logBytes: entry.logBytes };
      if (entry.pid !== undefined && alive.has(entry.pid)) return { jobId: entry.jobId, state: 'running', exitCode: -1, pid: entry.pid, logBytes: entry.logBytes };
      return { jobId: entry.jobId, state: 'unknown', exitCode: -1, pid: entry.pid ?? -1, logBytes: entry.logBytes };
    });
    jobs.sort((a, b) => b.jobId.localeCompare(a.jobId));
    return jobs;
  }

  /**
   * Which of the given PIDs are alive right now.
   *
   * @param {any} client - a ready client.
   * @param {number[]} pids - candidate process ids.
   * @returns {Promise<Set<number>>} the live ids.
   */
  async alivePids(client, pids) {
    const wanted = [...new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0))];
    if (wanted.length === 0) return new Set();
    const result = await this.exec(client, windowsAlivePidsScript(wanted), { timeoutMs: 30000 });
    /** @type {Set<number>} */
    const alive = new Set();
    if (result.exitCode !== 0) return alive;
    for (const line of result.stdout.split(/\r?\n/)) {
      const parsed = Number.parseInt(line.trim(), 10);
      if (Number.isInteger(parsed)) alive.add(parsed);
    }
    return alive;
  }

  /**
   * Remove one job's scheduled task, tolerating its absence.
   *
   * @param {any} client - a ready client.
   * @param {string} jobId - validated id.
   * @returns {Promise<void>} resolves when the attempt finished.
   */
  async removeWindowsTask(client, jobId) {
    try {
      await this.exec(client, windowsTaskRemoveScript(windowsTaskName(jobId)), { timeoutMs: 20000 });
    } catch {
      // Best effort: a leftover task is inert, and failing a status read over it
      // would be worse than leaving it.
    }
  }

  /**
   * Start one job.
   *
   * @param {any} client - a ready client.
   * @param {{ command: string, label?: string, cwd?: string, jobId?: string }} request - what to run.
   * @returns {Promise<{ jobId: string, dir: string, pid: number | null, logFile: string, startedAt: string }>} the job handle.
   */
  async start(client, request) {
    const platform = await detectPlatform(client);
    if (platform.kind === 'windows') return await this.startWindows(client, request);
    const jobId = request.jobId === undefined ? makeJobId(request.label) : assertJobId(request.jobId);
    const home = await resolveHome(client);
    const dir = this.jobDir(home, jobId);
    const pidFile = `${dir}/job.pid`;
    const exitFile = `${dir}/job.exit`;
    const logFile = `${dir}/job.log`;
    const cwd = typeof request.cwd === 'string' ? request.cwd.trim() : '';

    const ready = await this.exec(client, `mkdir -p ${shellQuote(dir)}`, { timeoutMs: 30000 });
    if (ready.exitCode !== 0) {
      throw new Error(`dsh-ssh: could not create the job directory ${dir}: ${ready.stderr.trim() || `exit ${String(ready.exitCode)}`}`);
    }

    const script = jobScript({ command: request.command, cwd: cwd === '' ? '' : resolveRemotePath(cwd, home, home), logFile, pidFile, exitFile });
    const localTemp = path.join(await fsp.mkdtemp(path.join(process.env.TEMP ?? process.env.TMPDIR ?? '/tmp', 'dsh-ssh-job-')), 'run.sh');
    await fsp.writeFile(localTemp, script, 'utf8');
    try {
      await this.sftp(client, async (sftp) => {
        await uploadFile(sftp, localTemp, `${dir}/run.sh`);
      });
    } finally {
      await fsp.rm(localTemp, { force: true }).catch(() => {});
    }

    const launch =
      `cd ${shellQuote(dir)} && chmod +x run.sh && ` +
      `if command -v setsid >/dev/null 2>&1; then setsid nohup bash run.sh >/dev/null 2>&1 < /dev/null & else nohup bash run.sh >/dev/null 2>&1 < /dev/null & fi; ` +
      `sleep 0.3; cat job.pid 2>/dev/null || echo ''`;
    const launched = await this.exec(client, launch, { timeoutMs: 30000 });
    if (launched.exitCode !== 0) {
      throw new Error(`dsh-ssh: could not start job ${jobId}: ${launched.stderr.trim() || `exit ${String(launched.exitCode)}`}`);
    }
    const pidText = launched.stdout.trim();
    const pid = /^\d+$/.test(pidText) ? Number.parseInt(pidText, 10) : null;

    return { jobId, dir, pid, logFile: `${dir}/job.log`, startedAt: new Date().toISOString() };
  }

  /**
   * Read one job's state from the remote filesystem.
   *
   * @param {any} client - a ready client.
   * @param {string} jobId - validated id.
   * @returns {Promise<{ jobId: string, state: 'running' | 'exited' | 'unknown', exitCode: number | null, pid: number | null, logBytes: number }>} the state.
   */
  async status(client, jobId) {
    assertJobId(jobId);
    const platform = await detectPlatform(client);
    if (platform.kind === 'windows') return await this.statusWindows(client, jobId);
    const home = await resolveHome(client);
    const dir = this.jobDir(home, jobId);
    const probe =
      `cd ${shellQuote(dir)} 2>/dev/null || { echo 'MISSING:'; exit 0; }; ` +
      `size=$(wc -c < job.log 2>/dev/null || echo 0); ` +
      `if [ -f job.exit ]; then echo "EXITED:$(cat job.exit):$size"; ` +
      `else pid=$(cat job.pid 2>/dev/null); ` +
      `if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then echo "RUNNING:$pid:$size"; else echo "UNKNOWN:$pid:$size"; fi; fi`;
    const result = await this.exec(client, probe, { timeoutMs: 30000 });
    if (result.exitCode !== 0) {
      throw new Error(`dsh-ssh: could not read the state of job ${jobId}: ${result.stderr.trim() || `exit ${String(result.exitCode)}`}`);
    }
    const line = result.stdout.trim().split(/\r?\n/).pop() ?? '';
    // `-1` rather than `null`: the tool output schema declares numbers, and the
    // registry rejects a `null` at runtime *after* the work succeeded. `-1` means
    // "not applicable / unknown" and is documented as such in the tool schema.
    if (line.startsWith('MISSING')) return { jobId, state: 'unknown', exitCode: -1, pid: -1, logBytes: 0 };
    const match = /^(RUNNING|EXITED|UNKNOWN):([^:]*):(\d+)$/.exec(line);
    if (match === null) return { jobId, state: 'unknown', exitCode: -1, pid: -1, logBytes: 0 };
    const state = match[1] === 'EXITED' ? 'exited' : match[1] === 'RUNNING' ? 'running' : 'unknown';
    const parsed = match[2] === '' ? -1 : Number.parseInt(match[2], 10);
    const number = Number.isInteger(parsed) && parsed >= 0 ? parsed : -1;
    return {
      jobId,
      state,
      exitCode: state === 'exited' ? number : -1,
      pid: state === 'running' ? number : -1,
      logBytes: Number.parseInt(match[3], 10),
    };
  }

  /**
   * Read a slice of one job's log.
   *
   * @param {any} client - a ready client.
   * @param {string} jobId - validated id.
   * @param {{ offset?: number, maxBytes?: number }} [options] - byte offset and cap.
   * @returns {Promise<{ jobId: string, chunk: string, offset: number, totalBytes: number, nextOffset: number, truncated: boolean }>} the slice.
   */
  async log(client, jobId, options = {}) {
    assertJobId(jobId);
    const platform = await detectPlatform(client);
    if (platform.kind === 'windows') return await this.logWindows(client, jobId, options);
    const home = await resolveHome(client);
    const dir = this.jobDir(home, jobId);
    const offset = Number.isFinite(options.offset) && Number(options.offset) > 0 ? Math.floor(Number(options.offset)) : 0;
    const maxBytes = Number.isFinite(options.maxBytes) && Number(options.maxBytes) > 0 ? Math.floor(Number(options.maxBytes)) : 65536;
    const probe =
      `cd ${shellQuote(dir)} 2>/dev/null || { echo '@@MISSING'; exit 0; }; ` +
      `size=$(wc -c < job.log 2>/dev/null || echo 0); ` +
      `echo "@@SIZE:$size"; ` +
      `tail -c +${offset + 1} job.log 2>/dev/null | head -c ${maxBytes}`;
    const result = await this.exec(client, probe, { timeoutMs: 60000, maxOutputBytes: maxBytes + 128 });
    if (result.exitCode !== 0) {
      throw new Error(`dsh-ssh: could not read the log of job ${jobId}: ${result.stderr.trim() || `exit ${String(result.exitCode)}`}`);
    }
    const text = result.stdout;
    const headerMatch = /@@(?:SIZE:(\d+)|MISSING)/.exec(text);
    if (headerMatch === null) return { jobId, chunk: text, offset, totalBytes: 0, nextOffset: offset, truncated: false };
    if (headerMatch[0] === '@@MISSING') return { jobId, chunk: '', offset, totalBytes: 0, nextOffset: offset, truncated: false };
    const totalBytes = Number.parseInt(headerMatch[1], 10);
    const body = text.slice(headerMatch.index + headerMatch[0].length);
    const chunk = body.replace(/^\r?\n/, '');
    return {
      jobId,
      chunk,
      offset,
      totalBytes,
      nextOffset: offset + Buffer.byteLength(chunk, 'utf8'),
      truncated: totalBytes - offset > Buffer.byteLength(chunk, 'utf8'),
    };
  }

  /**
   * Terminate one job's process group.
   *
   * A job started through `setsid` leads its own process group, so killing the
   * group takes the whole pipeline down instead of just the wrapper.
   *
   * @param {any} client - a ready client.
   * @param {string} jobId - validated id.
   * @returns {Promise<{ jobId: string, stopped: boolean, pid: number | null }>} the outcome.
   */
  async stop(client, jobId) {
    assertJobId(jobId);
    const platform = await detectPlatform(client);
    if (platform.kind === 'windows') return await this.stopWindows(client, jobId);
    const home = await resolveHome(client);
    const dir = this.jobDir(home, jobId);
    const probe =
      `cd ${shellQuote(dir)} 2>/dev/null || { echo 'MISSING:'; exit 0; }; ` +
      `pid=$(cat job.pid 2>/dev/null); ` +
      `if [ -z "$pid" ]; then echo 'NOPID:'; exit 0; fi; ` +
      `if kill -TERM -- -"$pid" 2>/dev/null; then echo "SIGNALED:$pid"; ` +
      `elif kill -TERM "$pid" 2>/dev/null; then echo "SIGNALED:$pid"; else echo "DEAD:$pid"; fi`;
    const result = await this.exec(client, probe, { timeoutMs: 30000 });
    if (result.exitCode !== 0) {
      throw new Error(`dsh-ssh: could not stop job ${jobId}: ${result.stderr.trim() || `exit ${String(result.exitCode)}`}`);
    }
    const line = result.stdout.trim().split(/\r?\n/).pop() ?? '';
    if (line.startsWith('MISSING')) return { jobId, stopped: false, pid: -1 };
    const match = /^(SIGNALED|DEAD|NOPID):(.*)$/.exec(line);
    if (match === null) return { jobId, stopped: false, pid: -1 };
    const pid = /^\d+$/.test(match[2]) ? Number.parseInt(match[2], 10) : -1;
    return { jobId, stopped: match[1] === 'SIGNALED', pid };
  }

  /**
   * List this server's jobs, newest first.
   *
   * @param {any} client - a ready client.
   * @returns {Promise<Array<{ jobId: string, state: string, exitCode: number | null, pid: number | null, logBytes: number }>>} jobs.
   */
  async list(client) {
    const platform = await detectPlatform(client);
    if (platform.kind === 'windows') return await this.listWindows(client);
    const home = await resolveHome(client);
    const dir = `${home.replace(/\/+$/, '')}/${JOBS_ROOT}`;
    const listing = await this.exec(
      client,
      `ls -1 ${shellQuote(dir)} 2>/dev/null || true; echo '---'; ` +
        `for d in ${shellQuote(dir)}/*/; do [ -d "$d" ] || continue; id=$(basename "$d"); ` +
        `size=$(wc -c < "$d/job.log" 2>/dev/null || echo 0); ` +
        `if [ -f "$d/job.exit" ]; then echo "EXITED:$id:$(cat "$d/job.exit"):$size"; ` +
        `else pid=$(cat "$d/job.pid" 2>/dev/null); ` +
        `if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then echo "RUNNING:$id:$pid:$size"; else echo "UNKNOWN:$id:$pid:$size"; fi; fi; done`,
      { timeoutMs: 60000 },
    );
    if (listing.exitCode !== 0) return [];
    /** @type {Array<{ jobId: string, state: string, exitCode: number | null, pid: number | null, logBytes: number }>} */
    const jobs = [];
    for (const line of listing.stdout.split(/\r?\n/)) {
      const match = /^(RUNNING|EXITED|UNKNOWN):([^:]+):([^:]*):(\d+)$/.exec(line.trim());
      if (match === null) continue;
      const state = match[1] === 'EXITED' ? 'exited' : match[1] === 'RUNNING' ? 'running' : 'unknown';
      const parsed = match[3] === '' ? -1 : Number.parseInt(match[3], 10);
      const number = Number.isInteger(parsed) && parsed >= 0 ? parsed : -1;
      jobs.push({
        jobId: match[2],
        state,
        exitCode: state === 'exited' ? number : -1,
        pid: state === 'running' ? number : -1,
        logBytes: Number.parseInt(match[4], 10),
      });
    }
    // job ids embed a sortable timestamp; newest first is what a caller wants.
    jobs.sort((a, b) => b.jobId.localeCompare(a.jobId));
    return jobs;
  }
}
