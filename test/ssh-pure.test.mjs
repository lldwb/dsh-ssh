/**
 * Offline unit tests for the pure helpers and the parseable halves of
 * `lib/ssh.mjs`.
 *
 * Nothing here opens a socket: `execCommand` / `withSftp` are replaced by small
 * fakes where a `JobManager` test needs them, and `ssh2` is never imported (it is
 * loaded lazily by the module under test).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  JobManager,
  JOBS_ROOT,
  JOB_ID,
  SshPool,
  assertJobId,
  collectBounded,
  describeSshError,
  jobScript,
  loadSsh2,
  makeJobId,
  resolveHome,
  resolveRemotePath,
  shellQuote,
  targetOf,
} from '../lib/ssh.mjs';

/** A tiny stdout/stderr emitter handed to `execCommand` by `resolveHome`. */
function commandStream(text, { code = 0, stderr = '' } = {}) {
  const makeEmitter = () => {
    const listeners = new Map();
    return {
      on(event, handler) {
        if (!listeners.has(event)) listeners.set(event, []);
        listeners.get(event).push(handler);
      },
      emit(event, ...args) {
        for (const handler of listeners.get(event) ?? []) handler(...args);
      },
    };
  };
  const out = makeEmitter();
  const err = makeEmitter();
  const stream = { on: out.on, stderr: { on: err.on }, close() {} };
  queueMicrotask(() => {
    if (text !== '') out.emit('data', Buffer.from(text));
    if (stderr !== '') err.emit('data', Buffer.from(stderr));
    out.emit('close', code, null);
  });
  return stream;
}

/** A client whose `exec` reports a fixed home directory. */
function homeClient(home = '/root') {
  const calls = [];
  return {
    calls,
    exec(command, optionsOrCallback, maybeCallback) {
      const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
      calls.push(command);
      callback(null, commandStream(`${home}\n`));
    },
  };
}

/** A client whose remote home is already cached, so no exec probe runs. */
function cachedHomeClient(home = '/root') {
  return { __dshSshHome: home };
}

// ───────────────────────────────── shellQuote ─────────────────────────────────

test('shellQuote wraps a value in single quotes', () => {
  assert.equal(shellQuote('abc'), "'abc'");
  assert.equal(shellQuote(''), "''");
  assert.equal(shellQuote(42), "'42'");
  assert.equal(shellQuote(undefined), "'undefined'");
  assert.equal(shellQuote('a b'), "'a b'");
});

test('shellQuote escapes embedded single quotes', () => {
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
  assert.equal(shellQuote("'"), `''\\'''`);
  assert.equal(shellQuote("a'b'c"), `'a'\\''b'\\''c'`);
});

test('shellQuote preserves newlines, tabs and non-ASCII inside the quotes', () => {
  assert.equal(shellQuote('line1\nline2'), "'line1\nline2'");
  assert.equal(shellQuote('中文命令'), "'中文命令'");
  assert.equal(shellQuote('a\tb'), "'a\tb'");
});

// ─────────────────────────────────── job ids ───────────────────────────────────

test('assertJobId accepts path-safe ids and rejects anything else', () => {
  for (const id of ['a', 'A1', 'job-20261021080000-abc123', 'a.b_c-d', 'x'.repeat(80)]) {
    assert.equal(assertJobId(id), id);
  }
  for (const id of ['', '-a', '.a', '../etc/passwd', 'a/b', 'a\\b', 'a b', 'a\nb', 'x'.repeat(81), null, undefined, 42]) {
    assert.throws(() => assertJobId(id), /invalid job id/, `expected rejection for ${JSON.stringify(id)}`);
  }
  assert.match(String(JOB_ID), /^\/\^/);
});

test('makeJobId builds a readable, validate id from a label and a clock', () => {
  const now = () => Date.UTC(2026, 9, 21, 8, 0, 0); // 2026-10-21T08:00:00Z
  const id = makeJobId('Train Run!', now);
  assert.match(id, /^train-run-20261021080000-[a-z0-9]+$/);
  assert.equal(assertJobId(id), id);
});

test('makeJobId normalises labels and falls back to "job"', () => {
  const now = () => Date.UTC(2026, 9, 21, 8, 0, 0);
  assert.match(makeJobId(undefined, now), /^job-20261021080000-/);
  assert.match(makeJobId('', now), /^job-20261021080000-/);
  assert.match(makeJobId('  ___  ', now), /^job-20261021080000-/);
  assert.match(makeJobId('中文标签', now), /^job-20261021080000-/);
  assert.match(makeJobId('My_Label.v2', now), /^my-label-v2-20261021080000-/);
  assert.match(makeJobId('a'.repeat(60), now), /^a{24}-20261021080000-/);
});

test('makeJobId output is always accepted by assertJobId', () => {
  for (let i = 0; i < 50; i += 1) assert.doesNotThrow(() => assertJobId(makeJobId(`label ${i}`)));
});

// ────────────────────────────────── jobScript ──────────────────────────────────

test('jobScript embeds the command verbatim and records the exit code', () => {
  const script = jobScript({
    command: 'echo hi\nsleep 1',
    cwd: '/root/work',
    logFile: '/root/job.log',
    pidFile: '/root/job.pid',
    exitFile: '/root/job.exit',
  });
  assert.match(script, /^#!\/bin\/bash/);
  assert.ok(script.includes('echo hi\nsleep 1\n'), 'the command must be embedded verbatim inside the subshell');
  assert.ok(script.includes('echo $$ > \'/root/job.pid\''));
  assert.equal(script.includes("cd '/root/work' 2>/dev/null || cd \"$HOME\""), true);
  assert.ok(script.includes(') > \'/root/job.log\' 2>&1'));
  assert.ok(script.includes('code=$?'));
  assert.ok(script.includes('echo "$code" > \'/root/job.exit\''));
});

test('jobScript escapes shell metacharacters in paths but not in the command', () => {
  const script = jobScript({
    command: "echo 'quoted' && rm -rf /tmp/nope",
    cwd: '',
    logFile: "/tmp/it's/a log.txt",
    pidFile: '/tmp/p.pid',
    exitFile: '/tmp/e.exit',
  });
  assert.ok(script.includes(`echo 'quoted' && rm -rf /tmp/nope`));
  assert.ok(script.includes('cd $HOME 2>/dev/null || cd "$HOME"'));
  assert.ok(script.includes("'/tmp/it'\\''s/a log.txt'"));
});

test('jobScript writes the pid before changing directory, so the pid path must be absolute', () => {
  // JobManager.start resolves $HOME once and builds absolute paths for exactly
  // this reason: single quotes stop `~` from expanding, and the pid write runs
  // before the wrapper's `cd`, so a relative pid path would land in the wrong
  // directory (the historical `~/.dsh-ssh/...` defect).
  const script = jobScript({ command: 'true', cwd: '/root', logFile: '/root/l', pidFile: '/root/p', exitFile: '/root/e' });
  const pidAt = script.indexOf('echo $$ >');
  const cdAt = script.indexOf('cd ');
  assert.ok(pidAt !== -1 && cdAt !== -1);
  assert.ok(pidAt < cdAt);
});

// ─────────────────────────────── collectBounded ────────────────────────────────

test('collectBounded keeps everything under the cap', () => {
  const chunks = [Buffer.from('hello '), Buffer.from('world')];
  const result = collectBounded(chunks, 1024);
  assert.equal(result.text, 'hello world');
  assert.equal(result.bytes, 11);
  assert.equal(result.truncated, false);
});

test('collectBounded keeps the head and reports the full byte count', () => {
  const chunks = [Buffer.from('abc'), Buffer.from('defgh')];
  const result = collectBounded(chunks, 4);
  assert.equal(result.text, 'abcd');
  assert.equal(result.bytes, 8);
  assert.equal(result.truncated, true);
});

test('collectBounded handles empty input, a zero cap and an exact fit', () => {
  assert.deepEqual(collectBounded([], 10), { text: '', bytes: 0, truncated: false });
  assert.deepEqual(collectBounded([Buffer.from('abc')], 0), { text: '', bytes: 3, truncated: true });
  assert.deepEqual(collectBounded([Buffer.from('abc')], 3), { text: 'abc', bytes: 3, truncated: false });
});

test('collectBounded does not concatenate a chunk past the cap', () => {
  const result = collectBounded([Buffer.from('12345'), Buffer.from('67890')], 2);
  assert.equal(result.text, '12');
  assert.equal(result.bytes, 10);
  assert.equal(result.truncated, true);
});

// ─────────────────────────────── resolveHome ───────────────────────────────────

test('resolveHome asks the remote shell once and caches the answer', async () => {
  const client = homeClient('/home/alice');
  assert.equal(await resolveHome(client), '/home/alice');
  assert.equal(client.__dshSshHome, '/home/alice');
  assert.equal(client.calls.length, 1);
  assert.match(client.calls[0], /\$HOME/);
  assert.equal(await resolveHome(client), '/home/alice');
  assert.equal(client.calls.length, 1, 'the second call must use the cache');
});

test('resolveHome rejects an empty, relative or failed answer', async () => {
  const empty = homeClient('');
  await assert.rejects(() => resolveHome(empty), /could not resolve the remote home/);
  const relative = homeClient('not-absolute');
  await assert.rejects(() => resolveHome(relative), /could not resolve the remote home/);
  const failing = {
    exec(command, optionsOrCallback, maybeCallback) {
      const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
      callback(null, commandStream('', { code: 1, stderr: 'permission denied' }));
    },
  };
  await assert.rejects(() => resolveHome(failing), /could not resolve the remote home.*permission denied/);
});

// ─────────────────────────────── resolveRemotePath ─────────────────────────────

test('resolveRemotePath rejects an empty path and embedded newlines/NUL', () => {
  for (const value of ['', '   ', null, undefined, 42, '/a\nb', '/a\rb', '/a\u0000b']) {
    assert.throws(() => resolveRemotePath(value), /remote path/, `expected rejection for ${JSON.stringify(value)}`);
  }
});

test('resolveRemotePath leaves absolute paths untouched and trims whitespace', () => {
  assert.equal(resolveRemotePath('/root/autodl-tmp/data', undefined), '/root/autodl-tmp/data');
  assert.equal(resolveRemotePath('  /root/x  '), '/root/x');
  assert.equal(resolveRemotePath('/'), '/');
});

test('resolveRemotePath joins a relative path onto the profile default directory', () => {
  assert.equal(resolveRemotePath('logs/a.txt', '/root/autodl-tmp'), '/root/autodl-tmp/logs/a.txt');
  assert.equal(resolveRemotePath('logs/a.txt', '/root/autodl-tmp/'), '/root/autodl-tmp/logs/a.txt');
  assert.equal(resolveRemotePath('logs/a.txt', '/'), '/logs/a.txt');
  // No default directory: the resolved home becomes the base so the result stays
  // absolute. SFTP and a remote shell disagree about "the current directory", so
  // a relative destination would resolve to two different files.
  assert.equal(resolveRemotePath('logs/a.txt', '', '/home/alice'), '/home/alice/logs/a.txt');
  assert.equal(resolveRemotePath('logs/a.txt', undefined, '/home/alice'), '/home/alice/logs/a.txt');
  // With neither a default directory nor a home there is nothing safe to join.
  assert.throws(() => resolveRemotePath('logs/a.txt', ''), /needs a default remote directory or a resolved home/);
  assert.throws(() => resolveRemotePath('logs/a.txt'), /needs a default remote directory or a resolved home/);
});

test('resolveRemotePath expands ~ only when a resolved home is supplied', () => {
  assert.throws(() => resolveRemotePath('~'), /cannot expand "~"/);
  assert.throws(() => resolveRemotePath('~/autodl-tmp/x'), /cannot expand "~\/"/);
  assert.equal(resolveRemotePath('~', '', '/home/alice'), '/home/alice');
  // A bare `~` is returned as the home string verbatim (a trailing slash is
  // harmless for SFTP); only `~/…` is normalised to one separator.
  assert.equal(resolveRemotePath('~', '', '/home/alice/'), '/home/alice/');
  assert.equal(resolveRemotePath('~/autodl-tmp/x', '', '/home/alice'), '/home/alice/autodl-tmp/x');
  assert.equal(resolveRemotePath('~/autodl-tmp/x', '', '/home/alice/'), '/home/alice/autodl-tmp/x');
  assert.equal(resolveRemotePath('~/x', '/data', '/home/alice'), '/home/alice/x');
});

test('resolveRemotePath expands ~ inside the default directory too', () => {
  assert.equal(resolveRemotePath('logs/a.txt', '~/data', '/home/alice'), '/home/alice/data/logs/a.txt');
  assert.throws(() => resolveRemotePath('logs/a.txt', '~/data'), /cannot expand "~\/"/);
});

// ──────────────────────────────── fingerprintOf ────────────────────────────────

test('SshPool.fingerprintOf changes when any connection-relevant field changes', () => {
  const base = {
    host: '10.0.0.1',
    port: 22,
    user: 'root',
    auth: 'password',
    updatedAt: '2026-10-21T00:00:00.000Z',
    privateKeyPath: '',
  };
  const fingerprint = SshPool.fingerprintOf(base);
  assert.equal(typeof fingerprint, 'string');
  assert.equal(SshPool.fingerprintOf({ ...base }), fingerprint);
  for (const [key, value] of [
    ['host', '10.0.0.2'],
    ['port', 2222],
    ['user', 'other'],
    ['auth', 'key'],
    ['updatedAt', '2026-10-22T00:00:00.000Z'],
    ['privateKeyPath', '/k'],
  ]) {
    assert.notEqual(SshPool.fingerprintOf({ ...base, [key]: value }), fingerprint, `expected a different fingerprint after ${key} changed`);
  }
});

test('SshPool defaults to a 15 s connect timeout and a 5 min idle timeout', () => {
  assert.equal(new SshPool().connectTimeoutMs, 15000);
  assert.equal(new SshPool({ connectTimeoutMs: 3000 }).connectTimeoutMs, 3000);
  assert.equal(new SshPool({ connectTimeoutMs: 'abc' }).connectTimeoutMs, 15000);
  assert.equal(new SshPool().idleTimeoutMs, 5 * 60 * 1000);
  assert.equal(new SshPool({ idleTimeoutMs: 1234 }).idleTimeoutMs, 1234);
  assert.equal(new SshPool({ idleTimeoutMs: 'abc' }).idleTimeoutMs, 5 * 60 * 1000);
});

test('SshPool.closeAll resolves on an empty pool', async () => {
  await assert.doesNotReject(() => new SshPool().closeAll());
  await assert.doesNotReject(() => new SshPool().disconnect('missing'));
});

// ─────────────────────────────── describeSshError ─────────────────────────────

test('describeSshError maps the common ssh2 failures to actionable sentences', () => {
  const cases = [
    [new Error('All configured authentication methods failed'), /authentication failed/],
    [new Error('getaddrinfo ENOTFOUND wrong.example'), /host could not be resolved/],
    [new Error('getaddrinfo EAI_AGAIN wrong.example'), /host could not be resolved/],
    [new Error('connect ECONNREFUSED 10.0.0.1:22'), /connection refused/],
    [new Error('connect ETIMEDOUT 10.0.0.1:22'), /connection timed out/],
    [new Error('Cannot parse privateKey: Unsupported key format'), /private key could not be decrypted/],
    [new Error('bad passphrase'), /private key could not be decrypted/],
    [new Error('Encrypted private OpenSSH key detected'), /private key could not be decrypted/],
    [new Error('Timed out while waiting for handshake'), /handshake timed out/],
  ];
  for (const [error, expected] of cases) {
    assert.match(describeSshError(error), expected, `expected a mapping for ${error.message}`);
  }
});

test('describeSshError passes through unknown messages and non-Error values', () => {
  assert.equal(describeSshError(new Error('something odd')), 'something odd');
  assert.equal(describeSshError('plain string'), 'plain string');
  assert.equal(describeSshError(42), '42');
});

test('targetOf renders user@host:port', () => {
  assert.equal(targetOf({ user: 'root', host: '10.0.0.1', port: 22 }), 'root@10.0.0.1:22');
});

test('loadSsh2 either loads the dependency or explains what to install', async () => {
  try {
    const ssh2 = await loadSsh2();
    assert.equal(typeof ssh2.Client, 'function');
  } catch (error) {
    assert.match(error.message, /ssh2.*not installed|pnpm install/s);
  }
});

// ───────────────────────── JobManager parsing (fake transport) ─────────────────

/** A fake `execCommand` that returns the given stdout. */
function fakeExec(stdout, { exitCode = 0, stderr = '' } = {}) {
  return async () => ({ stdout, stderr, exitCode });
}

/** The job id used by the parsing tests (must satisfy JOB_ID). */
const JOB = 'job-20261021080000-abcdef';

test('JobManager.jobDir nests a validated id under an absolute home', () => {
  const jobs = new JobManager();
  assert.equal(jobs.jobDir('/root', JOB), `/root/${JOBS_ROOT}/${JOB}`);
  assert.equal(jobs.jobDir('/home/alice/', JOB), `/home/alice/${JOBS_ROOT}/${JOB}`);
  assert.throws(() => jobs.jobDir('/root', '../escape'), /invalid job id/);
  assert.throws(() => jobs.jobDir('/root'), /invalid job id/);
});

test('JobManager.status reports -1 (never null) for the field that does not apply', async () => {
  const cases = [
    ['RUNNING:4242:17\n', { state: 'running', exitCode: -1, pid: 4242, logBytes: 17 }],
    ['EXITED:0:12\n', { state: 'exited', exitCode: 0, pid: -1, logBytes: 12 }],
    ['EXITED:137:12\n', { state: 'exited', exitCode: 137, pid: -1, logBytes: 12 }],
    ['UNKNOWN::5\n', { state: 'unknown', exitCode: -1, pid: -1, logBytes: 5 }],
    ['MISSING:\n', { state: 'unknown', exitCode: -1, pid: -1, logBytes: 0 }],
    ['garbage\n', { state: 'unknown', exitCode: -1, pid: -1, logBytes: 0 }],
  ];
  for (const [stdout, expected] of cases) {
    const jobs = new JobManager({ exec: fakeExec(stdout) });
    assert.deepEqual(await jobs.status(cachedHomeClient(), JOB), { jobId: JOB, ...expected });
  }
});

test('JobManager.status propagates a transport failure', async () => {
  const jobs = new JobManager({ exec: fakeExec('', { exitCode: 1, stderr: 'boom' }) });
  await assert.rejects(() => jobs.status(cachedHomeClient(), JOB), /could not read the state of job/);
});

test('JobManager.stop parses SIGNALED, DEAD, NOPID and MISSING with -1 for no pid', async () => {
  const cases = [
    ['SIGNALED:4242\n', { stopped: true, pid: 4242 }],
    ['DEAD:4242\n', { stopped: false, pid: 4242 }],
    ['DEAD:\n', { stopped: false, pid: -1 }],
    ['NOPID:\n', { stopped: false, pid: -1 }],
    ['MISSING:\n', { stopped: false, pid: -1 }],
  ];
  for (const [stdout, expected] of cases) {
    const jobs = new JobManager({ exec: fakeExec(stdout) });
    assert.deepEqual(await jobs.stop(cachedHomeClient(), JOB), { jobId: JOB, ...expected });
  }
});

test('JobManager.log parses the @@SIZE header and computes nextOffset/truncated', async () => {
  const jobs = new JobManager({ exec: fakeExec('@@SIZE:42\nhello\n') });
  const slice = await jobs.log(cachedHomeClient(), JOB);
  assert.equal(slice.chunk, 'hello\n');
  assert.equal(slice.totalBytes, 42);
  assert.equal(slice.offset, 0);
  assert.equal(slice.nextOffset, 6);
  assert.equal(slice.truncated, true);
});

test('JobManager.log reads from a byte offset and reports when nothing is left', async () => {
  const jobs = new JobManager({ exec: fakeExec('@@SIZE:10\n0123456789\n') });
  const slice = await jobs.log(cachedHomeClient(), JOB, { offset: 10, maxBytes: 1024 });
  assert.equal(slice.chunk, '0123456789\n');
  assert.equal(slice.offset, 10);
  assert.equal(slice.nextOffset, 21);
  assert.equal(slice.truncated, 10 - 10 > 11);
});

test('JobManager.log handles a missing job directory', async () => {
  const jobs = new JobManager({ exec: fakeExec('@@MISSING\n') });
  const slice = await jobs.log(cachedHomeClient(), JOB);
  assert.deepEqual(slice, { jobId: JOB, chunk: '', offset: 0, totalBytes: 0, nextOffset: 0, truncated: false });
});

test('JobManager.list parses the per-line state protocol and sorts newest first', async () => {
  const stdout = [
    'old-job',
    'new-job',
    'EXITED:old-job:0:10',
    'RUNNING:new-job:4242:99',
    'UNKNOWN:gone-job::0',
    'noise that must be ignored',
  ].join('\n');
  const jobs = new JobManager({ exec: fakeExec(stdout) });
  const list = await jobs.list(cachedHomeClient());
  assert.deepEqual(
    list.map((entry) => entry.jobId),
    ['old-job', 'new-job', 'gone-job'].sort((a, b) => b.localeCompare(a)),
  );
  assert.deepEqual(list.find((entry) => entry.jobId === 'new-job'), {
    jobId: 'new-job',
    state: 'running',
    exitCode: -1,
    pid: 4242,
    logBytes: 99,
  });
  assert.deepEqual(list.find((entry) => entry.jobId === 'old-job'), {
    jobId: 'old-job',
    state: 'exited',
    exitCode: 0,
    pid: -1,
    logBytes: 10,
  });
});

test('JobManager.start uploads run.sh under the resolved home and reports the launcher pid', async (t) => {
  // Keep the system temp dir clean: JobManager.start mkdtemps one directory.
  const before = new Set(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('dsh-ssh-job-')));
  t.after(() => {
    for (const name of fs.readdirSync(os.tmpdir())) {
      if (name.startsWith('dsh-ssh-job-') && !before.has(name)) {
        fs.rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true });
      }
    }
  });

  const commands = [];
  const uploaded = [];
  const exec = async (client, command) => {
    commands.push(command);
    if (command.includes('mkdir -p')) return { stdout: '', stderr: '', exitCode: 0 };
    return { stdout: '4242\n', stderr: '', exitCode: 0 };
  };
  const sftp = async (client, operation) =>
    operation({
      mkdir: (target, callback) => callback(null),
      fastPut: (localPath, remotePath, callback) => {
        uploaded.push({ localPath, remotePath, size: fs.statSync(localPath).size });
        callback(null);
      },
    });
  const jobs = new JobManager({ exec, sftp });
  const handle = await jobs.start(cachedHomeClient('/home/alice'), { command: 'echo hi', label: 'demo', cwd: '/root/work' });

  assert.match(handle.jobId, /^demo-\d{14}-[a-z0-9]+$/);
  assert.equal(handle.pid, 4242);
  assert.equal(handle.dir, `/home/alice/${JOBS_ROOT}/${handle.jobId}`);
  assert.equal(handle.logFile, `${handle.dir}/job.log`);
  assert.equal(commands.length, 2);
  assert.ok(commands[0].includes('mkdir -p'));
  assert.ok(commands[1].includes('chmod +x run.sh'));
  assert.equal(uploaded.length, 1);
  assert.equal(uploaded[0].remotePath, `${handle.dir}/run.sh`);
  assert.ok(uploaded[0].size > 0);
});

test('JobManager.start resolves the home through the client when not cached', async () => {
  const client = homeClient('/home/bob');
  const commands = [];
  const jobs = new JobManager({
    exec: async (c, command) => {
      commands.push(command);
      return { stdout: command.includes('mkdir -p') ? '' : '', stderr: '', exitCode: 0 };
    },
    sftp: async (c, operation) => operation({ mkdir: (t, cb) => cb(null), fastPut: (l, r, cb) => cb(null) }),
  });
  const handle = await jobs.start(client, { command: 'true', jobId: JOB });
  assert.equal(handle.dir, `/home/bob/${JOBS_ROOT}/${JOB}`);
  assert.equal(client.calls.length, 1, 'the home probe must be sent exactly once');
  assert.match(client.calls[0], /\$HOME/);
});

test('JobManager.start fails when the job directory cannot be created', async () => {
  const jobs = new JobManager({ exec: async () => ({ stdout: '', stderr: 'permission denied', exitCode: 1 }) });
  await assert.rejects(() => jobs.start(cachedHomeClient(), { command: 'x', jobId: JOB }), /could not create the job directory/);
});
