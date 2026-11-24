/**
 * Live end-to-end test against a real WINDOWS SSH server. NOT part of `npm test`.
 *
 * ## Why a separate file
 *
 * The offline suite proves schemas and pure helpers; the POSIX live test
 * (`live-ssh.mjs`) cannot prove the Windows branch, because that one needs a
 * real OpenSSH-for-Windows server with `cmd.exe` or PowerShell as its default
 * shell. This file drives the real tool layer against such a host and checks the
 * behaviours the Windows support exists for: UTF-8 output, real exit codes,
 * separated streams, Windows path resolution, SFTP round-trips with drive-letter
 * paths, both `ssh_fetch` modes, and scheduled-task jobs.
 *
 * ```
 * DSH_SSH_LIVE_HOST=<host>          # required
 * DSH_SSH_LIVE_USER=<user>          # required
 * DSH_SSH_LIVE_PASSWORD=<password>  # required
 * DSH_SSH_LIVE_PORT=<port>          # optional, default 22
 * DSH_SSH_LIVE_URL=<url>            # optional, default https://example.com/
 * ```
 *
 * With a required variable missing the script prints a skip notice and exits 0.
 *
 * ## Safety
 *
 * - The password is read from the environment only; it never appears in output.
 * - The remote work directory is a freshly generated name under the remote
 *   `C:\Users\<user>`, removed in `finally`; created job directories are removed
 *   there too. Nothing outside it is touched.
 * - The local throwaway DSH_HOME is removed in `finally`.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSshService } from '../lib/service.mjs';
import { buildTools } from '../lib/tools.mjs';
import { validateValue } from './strict-schema.mjs';

const REQUIRED = ['DSH_SSH_LIVE_HOST', 'DSH_SSH_LIVE_USER', 'DSH_SSH_LIVE_PASSWORD'];
const missing = REQUIRED.filter((name) => typeof process.env[name] !== 'string' || process.env[name] === '');
if (missing.length > 0) {
  console.log(`[skip] live Windows SSH test skipped: missing ${missing.join(', ')}`);
  console.log('Run it with: $env:DSH_SSH_LIVE_HOST="…"; $env:DSH_SSH_LIVE_USER="…"; $env:DSH_SSH_LIVE_PASSWORD="…"; node test/live-windows.mjs');
  // A CI caller that wants "skip is not allowed" sets this; a plain `node --test`
  // style run treats a missing environment as a skip and exits successfully.
  process.exit(process.env.DSH_SSH_LIVE_REQUIRED === '1' ? 2 : 0);
}

const HOST = process.env.DSH_SSH_LIVE_HOST.trim();
const USER = process.env.DSH_SSH_LIVE_USER.trim();
const PASSWORD = process.env.DSH_SSH_LIVE_PASSWORD;
const PORT_RAW = process.env.DSH_SSH_LIVE_PORT ?? '22';
const PORT = Number.parseInt(PORT_RAW, 10);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`[fatal] DSH_SSH_LIVE_PORT must be an integer between 1 and 65535, got ${JSON.stringify(PORT_RAW)}`);
  process.exit(2);
}
const URL = process.env.DSH_SSH_LIVE_URL ?? 'https://example.com/';

/** Printed form of the target: no credential, no full address. */
const MASKED = `${USER}@${HOST.replace(/\d+$/, '***')}:${PORT}`;
const STAMP = `dsh-ssh-live-${crypto.randomBytes(3).toString('hex')}`;
const REMOTE_DIR = `C:\\Users\\${USER}\\${STAMP}`;

let passed = 0;
let failed = 0;
const failures = [];

const dshHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ssh-live-win-'));
const refs = new Map();
const credentials = {
  async resolve(ref) { return refs.has(ref) ? { value: refs.get(ref) } : undefined; },
  async set(ref, value) { refs.set(ref, value); },
  async unset(ref) { refs.delete(ref); },
  async describe(ref) { return { configured: refs.has(ref), writable: true }; },
};
const registered = new Map();
const ctx = {
  effect(fn) { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {}; },
  get(name) { return name === 'credentials' ? credentials : undefined; },
  tools: { register(definition) { registered.set(definition.name, definition); return () => {}; } },
  logger: { info() {}, warn() {}, error() {} },
};
const options = () => ({ defaultHost: 'win', maxOutputBytes: 65536, connectTimeoutMs: 20000, preferLocalRelay: true });
const service = createSshService({ ctx, dshHome, options });
for (const definition of buildTools(ctx, { service, options })) registered.set(definition.name, definition);

/**
 * Call one tool and validate its value against its own output schema — the same
 * check the runtime registry performs after `execute`.
 *
 * @param {string} name - tool name.
 * @param {Record<string, unknown>} args - arguments.
 * @returns {Promise<any>} the returned value.
 */
async function call(name, args) {
  const definition = registered.get(name);
  const value = await definition.execute(args);
  const errors = validateValue(value, definition.output.schema);
  if (errors.length > 0) throw new Error(`schema violation: ${errors.join('; ')}`);
  return value;
}

/**
 * Run one named step, recording pass/fail without aborting the run.
 *
 * @param {string} name - the step name.
 * @param {() => Promise<void>} fn - the body.
 * @returns {Promise<void>} resolves when recorded.
 */
async function step(name, fn) {
  const started = Date.now();
  try {
    await fn();
    passed += 1;
    console.log(`[PASS] ${name} (${Date.now() - started} ms)`);
  } catch (error) {
    failed += 1;
    failures.push(name);
    console.log(`[FAIL] ${name} (${Date.now() - started} ms): ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Assert a condition. */
function check(condition, message) {
  if (!condition) throw new Error(message);
}

/** A fresh local scratch path. */
function localPath(name) {
  return path.join(dshHome, name);
}

/**
 * Remove the remote work directory and every job directory this run created.
 *
 * @param {string[]} jobIds - job ids created by the run.
 * @returns {Promise<void>} resolves when cleanup was attempted.
 */
async function cleanupRemote(jobIds) {
  const paths = [REMOTE_DIR, ...jobIds.map((jobId) => `C:\\Users\\${USER}\\.dsh-ssh\\jobs\\${jobId}`)];
  const quoted = paths.map((value) => `'${value.replace(/'/g, "''")}'`).join(',');
  await call('ssh_exec', { command: `Remove-Item -LiteralPath ${quoted} -Recurse -Force -ErrorAction SilentlyContinue; Write-Output cleaned` });
}

/** Remote work directory this run created, and job ids to clean up in `finally`. */
const createdJobIds = [];

const run = async () => {
  console.log(`\n=== ${MASKED} · Windows live test ===`);
  let platform = null;

  await step('ssh_host add stores the password without leaking it', async () => {
    const value = await call('ssh_host', { action: 'add', name: 'win', host: HOST, port: PORT, user: USER, auth: 'password', password: PASSWORD });
    check(value.ok, value.summary);
    check(!value.summary.includes(PASSWORD), 'the password must not appear in the tool result');
  });

  await step('ssh_host test detects Windows and returns host/platform/uptime', async () => {
    const value = await call('ssh_host', { action: 'test', name: 'win' });
    check(value.ok, value.summary);
    check(/windows/i.test(value.test.platform), `platform not Windows: ${value.test.platform}`);
    check(value.test.hostname !== '', 'hostname must not be empty');
    check(value.test.uptime !== '', 'uptime must not be empty');
    check(value.test.latencyMs > 0, 'latency must be positive');
    platform = value.test.platform;
  });

  await step('ssh_exec preserves UTF-8 output (script and native cmd)', async () => {
    const script = await call('ssh_exec', { command: 'Write-Output "中文输出测试 ✓"' });
    check(script.ok, script.summary);
    check(script.stdout.trim() === '中文输出测试 ✓', `stdout=${JSON.stringify(script.stdout)}`);
    check(script.stderr === '', `stderr=${JSON.stringify(script.stderr)}`);
    const native = await call('ssh_exec', { command: 'cmd /c "echo 中文来自cmd"' });
    check(native.ok, native.summary);
    check(native.stdout.includes('中文来自cmd'), `stdout=${JSON.stringify(native.stdout)}`);
  });

  await step('ssh_exec returns the real exit code and keeps the streams separate', async () => {
    const value = await call('ssh_exec', { command: 'Write-Output "out-1"; [Console]::Error.WriteLine("err-1"); cmd /c exit 7' });
    check(value.ok === false, 'a non-zero command must be ok:false');
    check(value.exitCode === 7, `exitCode=${value.exitCode}`);
    check(value.stdout.includes('out-1'), `stdout=${JSON.stringify(value.stdout)}`);
    check(!value.stdout.includes('err-1'), 'stderr text must not appear on stdout');
    check(value.stderr.includes('err-1'), `stderr=${JSON.stringify(value.stderr)}`);
  });

  await step('ssh_exec routes Write-Host to stdout without CLIXML on stderr', async () => {
    const value = await call('ssh_exec', { command: 'Write-Host "host-line"; Write-Output "out-line"' });
    check(value.ok, value.summary);
    check(value.stdout.includes('host-line'), `stdout=${JSON.stringify(value.stdout)}`);
    check(value.stdout.includes('out-line'), `stdout=${JSON.stringify(value.stdout)}`);
    check(!value.stderr.includes('CLIXML'), `stderr=${JSON.stringify(value.stderr.slice(0, 300))}`);
    check(value.stderr.trim() === '', `stderr=${JSON.stringify(value.stderr)}`);
  });

  await step('ssh_exec applies cwd (~ and absolute)', async () => {
    const home = await call('ssh_exec', { command: '(Get-Location).Path', cwd: '~' });
    check(home.ok, home.summary);
    check(/^[A-Za-z]:\\/.test(home.stdout.trim()), `stdout=${JSON.stringify(home.stdout)}`);
    const make = await call('ssh_exec', { command: `New-Item -ItemType Directory -Force -Path '${REMOTE_DIR}' | Out-Null; Write-Output made` });
    check(make.ok, make.summary);
    const absolute = await call('ssh_exec', { command: '(Get-Location).Path', cwd: REMOTE_DIR });
    check(absolute.ok, absolute.summary);
    check(absolute.stdout.includes(STAMP), `stdout=${JSON.stringify(absolute.stdout)}`);
  });

  await step('ssh_exec reports a bad cwd as an actionable error', async () => {
    const value = await call('ssh_exec', { command: 'Write-Output never', cwd: 'C:\\no-such-dir-xyz' });
    check(value.ok === false, 'a bad cwd must fail');
    check(/cannot change directory/.test(value.stderr), `stderr=${JSON.stringify(value.stderr)}`);
  });

  await step('ssh_exec rejects an over-long command with guidance', async () => {
    const value = await call('ssh_exec', { command: `Write-Output ${'x'.repeat(3000)}` });
    check(value.ok === false, 'an over-long command must fail');
    check(/too long for a Windows remote/.test(value.summary), `summary=${value.summary}`);
  });

  await step('ssh_upload / ssh_download round-trip a file at a drive-letter path', async () => {
    const local = localPath('hello.txt');
    fs.writeFileSync(local, 'uploaded to windows\n', 'utf8');
    const up = await call('ssh_upload', { localPath: local, remotePath: `${REMOTE_DIR}\\hello.txt` });
    check(up.ok, up.summary);
    check(up.remotePath === `${REMOTE_DIR}\\hello.txt`, `remotePath=${up.remotePath}`);
    const back = localPath('back.txt');
    const down = await call('ssh_download', { remotePath: `${REMOTE_DIR}\\hello.txt`, localPath: back });
    check(down.ok, down.summary);
    check(fs.readFileSync(back, 'utf8') === 'uploaded to windows\n', 'downloaded content differs');
  });

  await step('ssh_upload / ssh_download round-trip a directory tree with spaces and CJK', async () => {
    const tree = localPath('tree');
    fs.mkdirSync(path.join(tree, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(tree, 'a.txt'), 'a', 'utf8');
    fs.writeFileSync(path.join(tree, 'sub', 'b 空格 文件.txt'), 'b', 'utf8');
    const up = await call('ssh_upload', { localPath: tree, remotePath: `${REMOTE_DIR}\\tree` });
    check(up.ok, up.summary);
    check(up.files === 2, `files=${up.files}`);
    const back = localPath('tree-back');
    const down = await call('ssh_download', { remotePath: `${REMOTE_DIR}\\tree`, localPath: back });
    check(down.ok, down.summary);
    check(fs.readFileSync(path.join(back, 'sub', 'b 空格 文件.txt'), 'utf8') === 'b', 'tree content differs');
  });

  await step('ssh_fetch local-relay puts the URL content on the server', async () => {
    const value = await call('ssh_fetch', { url: URL, remotePath: `${REMOTE_DIR}\\local-relay.html`, mode: 'local-relay' });
    check(value.ok, value.summary);
    check(value.mode === 'local-relay', `mode=${value.mode}`);
    check(value.bytes > 0, `bytes=${value.bytes}`);
  });

  await step('ssh_fetch remote-direct downloads on the server (curl.exe/wget.exe/Invoke-WebRequest)', async () => {
    const value = await call('ssh_fetch', { url: URL, remotePath: `${REMOTE_DIR}\\remote-direct.html`, mode: 'remote-direct' });
    check(value.ok, value.summary);
    check(value.mode === 'remote-direct', `mode=${value.mode}`);
    check(value.bytes > 0, `bytes=${value.bytes}`);
  });

  const jobIds = createdJobIds;
  let longJobId = '';

  await step('ssh_job start/status/log/list cover a completed job', async () => {
    const started = await call('ssh_job', {
      action: 'start',
      label: 'live',
      command: '1..4 | ForEach-Object { Write-Output ("tick " + $_); Start-Sleep -Milliseconds 400 }',
    });
    check(started.ok, started.summary);
    jobIds.push(started.job.jobId);
    check(/^live-\d{14}-[a-z0-9]+$/.test(started.job.jobId), `jobId=${started.job.jobId}`);
    check(started.job.logFile.endsWith('job.log'), `logFile=${started.job.logFile}`);

    /** @type {any} */
    let status = null;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const value = await call('ssh_job', { action: 'status', jobId: started.job.jobId });
      status = value.status;
      if (status.state === 'exited') break;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    check(status !== null && status.state === 'exited', `status=${JSON.stringify(status)}`);
    check(status.exitCode === 0, `exitCode=${status.exitCode}`);

    const log = await call('ssh_job', { action: 'log', jobId: started.job.jobId });
    check(log.ok, log.summary);
    check(log.log.chunk.includes('tick 4'), `chunk=${JSON.stringify(log.log.chunk)}`);

    const list = await call('ssh_job', { action: 'list' });
    check(list.ok, list.summary);
    check(list.jobs.some((job) => job.jobId === started.job.jobId), 'the job must appear in list');
  });

  await step('ssh_job stop kills a long job and records exit 143', async () => {
    const started = await call('ssh_job', { action: 'start', label: 'stopme', command: 'Start-Sleep -Seconds 300' });
    check(started.ok, started.summary);
    longJobId = started.job.jobId;
    jobIds.push(longJobId);
    await new Promise((resolve) => setTimeout(resolve, 800));
    const before = await call('ssh_job', { action: 'status', jobId: longJobId });
    check(before.status.state === 'running', `before=${JSON.stringify(before.status)}`);
    const stopped = await call('ssh_job', { action: 'stop', jobId: longJobId });
    check(stopped.ok, stopped.summary);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const after = await call('ssh_job', { action: 'status', jobId: longJobId });
    check(after.status.state !== 'running', `still running after stop: ${JSON.stringify(after.status)}`);
    check(after.status.exitCode === 143, `exitCode=${after.status.exitCode}`);
  });

  await step('ssh_job records a failing native command exit code', async () => {
    const started = await call('ssh_job', { action: 'start', label: 'fail', command: 'Write-Output "before"; cmd /c exit 3' });
    check(started.ok, started.summary);
    jobIds.push(started.job.jobId);
    /** @type {any} */
    let status = null;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const value = await call('ssh_job', { action: 'status', jobId: started.job.jobId });
      status = value.status;
      if (status.state === 'exited') break;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    check(status !== null && status.state === 'exited', `status=${JSON.stringify(status)}`);
    check(status.exitCode === 3, `exitCode=${status.exitCode}`);
    const log = await call('ssh_job', { action: 'log', jobId: started.job.jobId });
    check(log.log.chunk.includes('before'), `chunk=${JSON.stringify(log.log.chunk)}`);
  });

  await step('ssh_job log chunks a CJK log without dropping or corrupting bytes', async () => {
    const started = await call('ssh_job', { action: 'start', label: 'cjk', command: "Write-Output ('中' * 50)" });
    check(started.ok, started.summary);
    jobIds.push(started.job.jobId);
    /** @type {any} */
    let status = null;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const value = await call('ssh_job', { action: 'status', jobId: started.job.jobId });
      status = value.status;
      if (status.state === 'exited') break;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    check(status !== null && status.state === 'exited', `status=${JSON.stringify(status)}`);
    const full = await call('ssh_job', { action: 'log', jobId: started.job.jobId, offset: 0, maxBytes: 65536 });
    check(full.ok, full.summary);
    check(full.log.chunk.includes('中'), `chunk=${JSON.stringify(full.log.chunk)}`);
    // 100 bytes = 33 full CJK characters (99 bytes) + the first byte of the next
    // one, so the first read is cut in the middle of a multi-byte character and
    // exercises readRemoteRange's boundary trim.
    let offset = 0;
    let assembled = '';
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const slice = await call('ssh_job', { action: 'log', jobId: started.job.jobId, offset, maxBytes: 100 });
      check(slice.ok, slice.summary);
      check(!slice.log.chunk.includes('\uFFFD'), `replacement character at offset ${offset}`);
      assembled += slice.log.chunk;
      offset = slice.log.nextOffset;
      if (!slice.log.truncated) break;
    }
    check(assembled === full.log.chunk, `assembled ${Buffer.byteLength(assembled)} bytes, full ${Buffer.byteLength(full.log.chunk)} bytes`);
  });

  await step('no scheduled task for the finished jobs is left behind', async () => {
    // Scope the check to the jobs this run created: unrelated stale tasks from an
    // earlier crashed run are not this test's business.
    for (const jobId of createdJobIds) {
      const value = await call('ssh_exec', {
        command: `$t = Get-ScheduledTask -TaskName 'dsh-ssh-${jobId}' -ErrorAction SilentlyContinue; if ($t) { 'EXISTS' } else { 'ABSENT' }`,
      });
      check(value.ok, value.summary);
      check(value.stdout.trim() === 'ABSENT', `task for ${jobId} still exists`);
    }
  });

  console.log(`\n${'='.repeat(60)}\nPASS ${passed} / FAIL ${failed} · platform=${platform ?? 'unknown'}`);
  if (failures.length > 0) console.log(`failures: ${failures.join(', ')}`);
};

try {
  await run();
} catch (error) {
  failed += 1;
  console.error(`[fatal] ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
} finally {
  if (createdJobIds.length > 0) {
    try {
      const names = createdJobIds.map((id) => `'dsh-ssh-${id}'`).join(',');
      await call('ssh_exec', {
        command: `$names = @(${names}); foreach ($n in $names) { Unregister-ScheduledTask -TaskName $n -Confirm:$false -ErrorAction SilentlyContinue }; Write-Output swept`,
      });
    } catch {
      // Best effort: the main steps already report whether tasks were cleaned.
    }
  }
  try {
    await cleanupRemote(createdJobIds);
  } catch {
    // The tool layer may be unusable after a fatal error; the remote temp name is
    // printed in the step output above so a human can remove it.
  }
  await service.pool.closeAll().catch(() => {});
  fs.rmSync(dshHome, { recursive: true, force: true });
}
console.log(failed > 0 ? `RESULT: FAIL (${failed})` : 'RESULT: PASS');
process.exit(failed > 0 ? 1 : 0);
