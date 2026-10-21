/**
 * Live end-to-end test against a real SSH server. NOT part of `npm test`.
 *
 * ## Why a separate file
 *
 * A green offline suite proves the schemas and the pure helpers; it cannot prove
 * that a connection is established, that SFTP moves bytes, or that a detached job
 * really runs and can be stopped. Those need a real sshd, so they live here and
 * are driven by environment variables:
 *
 * ```
 * DSH_SSH_LIVE_HOST=<host>
 * DSH_SSH_LIVE_PORT=<port>        # optional, default 22
 * DSH_SSH_LIVE_USER=<user>
 * DSH_SSH_LIVE_PASSWORD=<password>
 * ```
 *
 * With any of host/user/password missing the script prints a skip notice and
 * exits 0, so it is safe to call in CI.
 *
 * ## What it proves
 *
 * 1. profile store + secret store in a throwaway `DSH_HOME` (never the real one);
 * 2. `ssh_host` add / password / list / test over a genuine connection;
 * 3. `ssh_exec` (`hostname`, `uname -sr`, `nproc`, and a shell-quoting probe);
 * 4. SFTP file and directory upload/download, with content compared both ways;
 * 5. `ssh_job` start → poll status → read log (exit code 0, "tick 3") → list,
 *    plus a second job started with `sleep` and terminated by `stop`;
 * 6. tool return values are run through the same strict schema validator the
 *    offline suite uses, so a real result cannot silently violate its declared
 *    `output.schema`.
 *
 * ## Safety
 *
 * - The password is read from the environment only. It is never printed, never
 *   passed as an argument, and never written outside the throwaway DSH_HOME.
 * - The remote work directory is a freshly generated name under the remote
 *   `$HOME`; every remote cleanup command is checked against a strict pattern
 *   before it runs, and the directory is removed in a `finally`.
 * - The local throwaway DSH_HOME is removed in a `finally`.
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
  console.log(`[skip] live SSH test skipped: missing ${missing.join(', ')}`);
  console.log('Run it with: $env:DSH_SSH_LIVE_HOST="…"; $env:DSH_SSH_LIVE_PORT="22"; $env:DSH_SSH_LIVE_USER="…"; $env:DSH_SSH_LIVE_PASSWORD="…"; node test/live-ssh.mjs');
  process.exit(0);
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

/** Printed form of the target: the address is masked, the credential never appears. */
const MASKED_TARGET = `${USER}@${HOST.replace(/\d+$/, '***')}:${PORT}`;
const OPTIONS = () => ({ defaultHost: '', maxOutputBytes: 65536, connectTimeoutMs: 20000 });
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

let passed = 0;
let failed = 0;
const failures = [];
const warnings = [];

/**
 * Run one named step, recording pass/fail without aborting the run.
 *
 * @param {string} name - the step name.
 * @param {() => Promise<any>} fn - the step body; a throw is a failure.
 * @returns {Promise<{ ok: boolean, value?: any, error?: string }>} the outcome.
 */
async function step(name, fn) {
  const started = Date.now();
  try {
    const value = await fn();
    passed += 1;
    console.log(`[PASS] ${name} (${Date.now() - started} ms)`);
    return { ok: true, value };
  } catch (error) {
    failed += 1;
    failures.push(name);
    console.log(`[FAIL] ${name} (${Date.now() - started} ms): ${error instanceof Error ? error.message : String(error)}`);
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Throw unless the condition holds. */
function check(condition, message) {
  if (!condition) throw new Error(message);
}

/** Sleep for a while. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Validate a tool result against its declared output schema, recording a warning
 * (not a failure) when it does not conform: the live run is about connectivity,
 * and the offline suite owns the defect assertions.
 *
 * @param {string} label - what was called.
 * @param {any} tool - the tool definition.
 * @param {any} value - the returned value.
 * @returns {void}
 */
function auditOutput(label, tool, value) {
  const violations = validateValue(value, tool.output.schema);
  if (violations.length > 0) {
    warnings.push(`${label}: output.schema violations: ${violations.join('; ')}`);
    console.log(`[WARN] ${label}: output.schema violations (${violations.length}):`);
    for (const line of violations) console.log(`       ${line}`);
  } else {
    console.log(`[ok]   ${label}: output.schema satisfied`);
  }
}

/** Main run. */
async function main() {
  const dshHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ssh-live-'));
  const localWork = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ssh-live-local-'));
  const token = crypto.randomBytes(6).toString('hex');
  /** @type {string[]} remote paths to remove, checked before each rm. */
  const remoteCleanup = [];

  console.log(`[live] target=${MASKED_TARGET} dshHome=<temp>`);
  console.log(`[live] port=${PORT}`);

  const ctx = { get: () => undefined };
  const service = createSshService({ ctx, dshHome, options: OPTIONS });
  const definitions = buildTools(ctx, { service, options: OPTIONS });
  const byName = new Map(definitions.map((tool) => [tool.name, tool]));

  try {
    // ── profile store + secret store ────────────────────────────────────────
    const listEmpty = await step('ssh_host list (empty)', async () => {
      const value = await byName.get('ssh_host').execute({ action: 'list' });
      auditOutput('ssh_host list', byName.get('ssh_host'), value);
      check(value.ok === true, `expected ok, got ${JSON.stringify(value.summary)}`);
      check(Array.isArray(value.servers) && value.servers.length === 0, 'expected an empty server list');
      return value;
    });
    if (!listEmpty.ok) return;

    await step('ssh_host add stores a password outside servers.json', async () => {
      const tool = byName.get('ssh_host');
      const value = await tool.execute({ action: 'add', name: 'live', host: HOST, port: PORT, user: USER, password: PASSWORD, note: 'live test' });
      auditOutput('ssh_host add', tool, value);
      check(value.ok === true, `add failed: ${JSON.stringify(value.summary)}`);
      check(value.profile.passwordConfigured === true, 'passwordConfigured must be true after add');
      const store = fs.readFileSync(path.join(dshHome, 'dsh-ssh', 'servers.json'), 'utf8');
      check(!store.includes(PASSWORD), 'servers.json must not contain the password');
      const secretFile = path.join(dshHome, 'dsh-ssh', 'secrets.json');
      check(fs.existsSync(secretFile), 'the encrypted secret file must exist');
      check(!fs.readFileSync(secretFile, 'utf8').includes(PASSWORD), 'the secret file must not contain plaintext');
      return value;
    });

    await step('ssh_host list shows the stored server', async () => {
      const tool = byName.get('ssh_host');
      const value = await tool.execute({ action: 'list' });
      auditOutput('ssh_host list (one)', tool, value);
      check(value.ok === true, 'list failed');
      check(value.servers.length === 1 && value.servers[0].name === 'live', 'expected exactly one server named live');
      check(value.servers[0].passwordConfigured === true, 'list must report the password as configured');
      return value;
    });

    // ── connection + probe ──────────────────────────────────────────────────
    const tested = await step('ssh_host test connects and reports hostname/platform/uptime', async () => {
      const tool = byName.get('ssh_host');
      const value = await tool.execute({ action: 'test', name: 'live' });
      auditOutput('ssh_host test', tool, value);
      check(value.ok === true, `test failed: ${JSON.stringify(value.summary)}`);
      check(typeof value.test.hostname === 'string' && value.test.hostname !== '', 'empty hostname');
      check(typeof value.test.platform === 'string' && value.test.platform !== '', 'empty platform');
      check(Number.isInteger(value.test.latencyMs) && value.test.latencyMs >= 0, 'latencyMs must be a non-negative integer');
      console.log(`       hostname=${value.test.hostname}`);
      console.log(`       platform=${value.test.platform}`);
      console.log(`       uptime=${value.test.uptime}`);
      console.log(`       latencyMs=${value.test.latencyMs}`);
      return value;
    });
    if (!tested.ok) return;

    const execTool = byName.get('ssh_exec');
    await step('ssh_exec runs hostname; uname -sr; nproc', async () => {
      const value = await execTool.execute({ command: 'hostname; uname -sr; nproc' });
      auditOutput('ssh_exec probe', execTool, value);
      check(value.ok === true, `probe failed: ${JSON.stringify(value.summary)}`);
      const lines = value.stdout.trim().split(/\r?\n/);
      check(lines.length >= 3, `expected at least 3 lines, got ${lines.length}: ${JSON.stringify(value.stdout)}`);
      check(Number.parseInt(lines[lines.length - 1], 10) > 0, `nproc should be a positive integer, got ${JSON.stringify(lines[lines.length - 1])}`);
      console.log(`       stdout=${JSON.stringify(value.stdout.trim())}`);
      console.log(`       exitCode=${value.exitCode} durationMs=${value.durationMs}`);
      return value;
    });

    await step('ssh_exec proves shell quoting and non-zero exit codes', async () => {
      const quoted = await execTool.execute({ command: 'printf "%s" \'it\'"\'"\'s a test\' && echo' });
      auditOutput('ssh_exec quoting', execTool, quoted);
      check(quoted.ok === true, `quoting probe failed: ${JSON.stringify(quoted.summary)}`);
      check(quoted.stdout.trim() === "it's a test", `unexpected quoted output ${JSON.stringify(quoted.stdout)}`);
      const failedCommand = await execTool.execute({ command: 'exit 7' });
      auditOutput('ssh_exec exit 7', execTool, failedCommand);
      check(failedCommand.ok === false, 'exit 7 must not be reported as ok');
      check(failedCommand.exitCode === 7, `expected exitCode 7, got ${failedCommand.exitCode}`);
      return failedCommand;
    });

    // ── remote work directory ───────────────────────────────────────────────
    const homeResult = await step('resolve the remote home directory', async () => {
      const value = await execTool.execute({ command: 'printf %s "$HOME"' });
      check(value.ok === true, 'could not read $HOME');
      const home = value.stdout.trim();
      check(/^\/[A-Za-z0-9._/-]*$/.test(home) && home !== '/', `unexpected remote home ${JSON.stringify(home)}`);
      return home;
    });
    if (!homeResult.ok) return;
    const remoteHome = homeResult.value;
    const remoteDir = `${remoteHome}/dsh-ssh-live-${token}`;
    const remoteDirPattern = new RegExp(`^${remoteHome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/dsh-ssh-live-[0-9a-f]{12}$`);
    check(remoteDirPattern.test(remoteDir), 'generated remote directory failed its own safety pattern');
    remoteCleanup.push(remoteDir);
    console.log(`       remoteDir=${remoteDir}`);

    await step('create the remote work directory', async () => {
      const value = await execTool.execute({ command: `mkdir -p '${remoteDir}' && test -d '${remoteDir}'` });
      auditOutput('ssh_exec mkdir', execTool, value);
      check(value.ok === true, `mkdir failed: ${JSON.stringify(value.summary)}`);
      return value;
    });

    // ── SFTP: single file ───────────────────────────────────────────────────
    const localFile = path.join(localWork, 'hello.txt');
    const fileBody = `dsh-ssh live test ${token}\nline two\n中文行\n`;
    fs.writeFileSync(localFile, fileBody, 'utf8');
    const remoteFile = `${remoteDir}/hello.txt`;
    const uploadTool = byName.get('ssh_upload');
    const downloadTool = byName.get('ssh_download');

    await step('ssh_upload uploads one file', async () => {
      const value = await uploadTool.execute({ host: 'live', localPath: localFile, remotePath: remoteFile });
      auditOutput('ssh_upload file', uploadTool, value);
      check(value.ok === true, `upload failed: ${JSON.stringify(value.summary)}`);
      check(value.kind === 'file' && value.files === 1, 'expected a single-file transfer');
      check(value.bytes === Buffer.byteLength(fileBody, 'utf8'), `expected ${Buffer.byteLength(fileBody, 'utf8')} bytes, got ${value.bytes}`);
      console.log(`       bytes=${value.bytes} durationMs=${value.durationMs}`);
      return value;
    });

    await step('uploaded file is byte-identical on the remote side', async () => {
      const value = await execTool.execute({ command: `wc -c < '${remoteFile}' && cat '${remoteFile}'` });
      check(value.ok === true, 'remote read failed');
      const [sizeLine, ...bodyLines] = value.stdout.split(/\r?\n/);
      check(Number.parseInt(sizeLine.trim(), 10) === Buffer.byteLength(fileBody, 'utf8'), `remote size mismatch: ${sizeLine}`);
      check(bodyLines.join('\n').trim() === fileBody.trim(), 'remote content differs from the local file');
      return value;
    });

    await step('ssh_download downloads the file and matches it locally', async () => {
      const localBack = path.join(localWork, 'hello-back.txt');
      const value = await downloadTool.execute({ host: 'live', remotePath: remoteFile, localPath: localBack });
      auditOutput('ssh_download file', downloadTool, value);
      check(value.ok === true, `download failed: ${JSON.stringify(value.summary)}`);
      check(value.kind === 'file' && value.files === 1, 'expected a single-file transfer');
      check(fs.readFileSync(localBack, 'utf8') === fileBody, 'downloaded content differs');
      return value;
    });

    // ── SFTP: directory ─────────────────────────────────────────────────────
    const localTree = path.join(localWork, 'tree');
    fs.mkdirSync(path.join(localTree, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(localTree, 'a.txt'), 'alpha\n', 'utf8');
    fs.writeFileSync(path.join(localTree, 'sub', 'b.txt'), 'beta\n', 'utf8');
    const remoteTree = `${remoteDir}/tree`;

    await step('ssh_upload uploads a directory tree', async () => {
      const value = await uploadTool.execute({ host: 'live', localPath: localTree, remotePath: remoteTree });
      auditOutput('ssh_upload dir', uploadTool, value);
      check(value.ok === true, `directory upload failed: ${JSON.stringify(value.summary)}`);
      check(value.kind === 'directory' && value.files === 2, `expected 2 files, got ${JSON.stringify({ kind: value.kind, files: value.files })}`);
      return value;
    });

    await step('remote tree has both files with the right content', async () => {
      const value = await execTool.execute({ command: `find '${remoteTree}' -type f | sort && cat '${remoteTree}/a.txt' '${remoteTree}/sub/b.txt'` });
      check(value.ok === true, 'remote tree read failed');
      check(value.stdout.includes(`${remoteTree}/a.txt`), 'a.txt missing remotely');
      check(value.stdout.includes(`${remoteTree}/sub/b.txt`), 'sub/b.txt missing remotely');
      check(value.stdout.includes('alpha') && value.stdout.includes('beta'), 'remote file content mismatch');
      return value;
    });

    await step('ssh_download downloads the directory tree', async () => {
      const localTreeBack = path.join(localWork, 'tree-back');
      const value = await downloadTool.execute({ host: 'live', remotePath: remoteTree, localPath: localTreeBack });
      auditOutput('ssh_download dir', downloadTool, value);
      check(value.ok === true, `directory download failed: ${JSON.stringify(value.summary)}`);
      check(value.kind === 'directory' && value.files === 2, `expected 2 files, got ${JSON.stringify({ kind: value.kind, files: value.files })}`);
      check(fs.readFileSync(path.join(localTreeBack, 'a.txt'), 'utf8') === 'alpha\n', 'a.txt content mismatch');
      check(fs.readFileSync(path.join(localTreeBack, 'sub', 'b.txt'), 'utf8') === 'beta\n', 'sub/b.txt content mismatch');
      return value;
    });

    // ── ssh_fetch (public URL; skipped when this machine has no route to it) ──
    // A public, non-sensitive URL is used on purpose: nothing internal is fetched
    // and nothing about the user's network is assumed. When the machine running
    // dsh cannot reach it, the case is skipped without failing the run.
    const fetchTool = byName.get('ssh_fetch');
    const publicUrl = 'https://example.com/';
    let publicUrlReachable = false;
    try {
      const probe = await fetch(publicUrl, { signal: AbortSignal.timeout(10000) });
      publicUrlReachable = probe.ok;
      if (!probe.ok) console.log(`[skip] ssh_fetch live case: ${publicUrl} answered HTTP ${probe.status}`);
    } catch (error) {
      console.log(`[skip] ssh_fetch live case: this machine cannot reach ${publicUrl} (${error instanceof Error ? error.message : String(error)})`);
    }
    if (publicUrlReachable) {
      const remoteFetched = `${remoteDir}/example.html`;
      await step('ssh_fetch local-relay puts a public URL file on the server', async () => {
        const value = await fetchTool.execute({ host: 'live', url: publicUrl, remotePath: remoteFetched, mode: 'local-relay', timeoutSec: 120 });
        auditOutput('ssh_fetch local-relay', fetchTool, value);
        check(value.ok === true, `ssh_fetch failed: ${JSON.stringify(value.summary)}`);
        check(value.mode === 'local-relay', `expected mode local-relay, got ${value.mode}`);
        check(Number.isInteger(value.bytes) && value.bytes > 0, `expected a positive byte count, got ${value.bytes}`);
        const verify = await execTool.execute({ command: `wc -c < '${remoteFetched}'` });
        check(verify.ok === true, 'remote size probe failed');
        check(Number.parseInt(verify.stdout.trim(), 10) === value.bytes, `remote size ${verify.stdout.trim()} != reported bytes ${value.bytes}`);
        console.log(`       url=${publicUrl} bytes=${value.bytes} durationMs=${value.durationMs}`);
        return value;
      });
    }

    // ── jobs ────────────────────────────────────────────────────────────────
    const jobTool = byName.get('ssh_job');
    const startedJob = await step('ssh_job start runs a detached ticking command', async () => {
      const value = await jobTool.execute({ action: 'start', host: 'live', label: 'live-tick', command: 'for i in 1 2 3; do echo tick $i; sleep 1; done' });
      auditOutput('ssh_job start', jobTool, value);
      check(value.ok === true, `job start failed: ${JSON.stringify(value.summary)}`);
      check(JOB_ID.test(value.job.jobId), `invalid job id ${JSON.stringify(value.job.jobId)}`);
      check(value.job.pid > 0, `expected a launcher pid, got ${value.job.pid}`);
      console.log(`       jobId=${value.job.jobId} pid=${value.job.pid}`);
      remoteCleanup.push(`${remoteHome}/.dsh-ssh/jobs/${value.job.jobId}`);
      return value;
    });
    if (startedJob.ok) {
      const jobId = startedJob.value.job.jobId;
      await step('ssh_job status reaches state=exited with exitCode 0', async () => {
        let last = null;
        for (let attempt = 0; attempt < 40; attempt += 1) {
          const value = await jobTool.execute({ action: 'status', host: 'live', jobId });
          last = value;
          if (value.status?.state === 'exited') {
            check(value.status.exitCode === 0, `expected exitCode 0, got ${value.status.exitCode}`);
            check(value.ok === true, 'an exited-0 job should be ok:true');
            check(Number.isInteger(value.status.logBytes) && value.status.logBytes > 0, 'logBytes must be positive');
            return value;
          }
          await sleep(250);
        }
        throw new Error(`job never exited; last status ${JSON.stringify(last?.status)} summary ${JSON.stringify(last?.summary)}`);
      });

      await step('ssh_job log returns the job output including "tick 3"', async () => {
        const value = await jobTool.execute({ action: 'log', host: 'live', jobId });
        auditOutput('ssh_job log', jobTool, value);
        check(value.ok === true, `log failed: ${JSON.stringify(value.summary)}`);
        check(typeof value.log.chunk === 'string' && value.log.chunk.includes('tick 3'), `expected "tick 3" in the log, got ${JSON.stringify(value.log.chunk)}`);
        check(Number.isInteger(value.log.offset) && Number.isInteger(value.log.nextOffset) && Number.isInteger(value.log.totalBytes), 'log byte counters must be integers');
        console.log(`       log=${JSON.stringify(value.log.chunk.trim())}`);
        return value;
      });

      await step('ssh_job list contains the job', async () => {
        const value = await jobTool.execute({ action: 'list', host: 'live' });
        auditOutput('ssh_job list', jobTool, value);
        check(value.ok === true, `list failed: ${JSON.stringify(value.summary)}`);
        check(Array.isArray(value.jobs) && value.jobs.some((entry) => entry.jobId === jobId), `job ${jobId} missing from the list`);
        return value;
      });
    }

    const longJob = await step('ssh_job start launches a long sleep', async () => {
      const value = await jobTool.execute({ action: 'start', host: 'live', label: 'live-sleep', command: `sleep 300 # dsh-ssh-live-${token}` });
      auditOutput('ssh_job start (sleep)', jobTool, value);
      check(value.ok === true, `sleep job start failed: ${JSON.stringify(value.summary)}`);
      remoteCleanup.push(`${remoteHome}/.dsh-ssh/jobs/${value.job.jobId}`);
      return value;
    });
    if (longJob.ok) {
      const jobId = longJob.value.job.jobId;
      const running = await step('ssh_job status reports the long job as running', async () => {
        let last = null;
        for (let attempt = 0; attempt < 20; attempt += 1) {
          const value = await jobTool.execute({ action: 'status', host: 'live', jobId });
          last = value;
          if (value.status?.state === 'running') {
            check(Number.isInteger(value.status.pid) && value.status.pid > 0, `expected a positive running pid, got ${value.status.pid}`);
            return value;
          }
          await sleep(250);
        }
        throw new Error(`job never reached running; last ${JSON.stringify(last?.status)} summary ${JSON.stringify(last?.summary)}`);
      });

      if (running.ok) {
        const pid = running.value.status.pid;
        await step('ssh_job stop terminates the job process group', async () => {
          const value = await jobTool.execute({ action: 'stop', host: 'live', jobId });
          auditOutput('ssh_job stop', jobTool, value);
          check(value.ok === true, `stop failed: ${JSON.stringify(value.summary)}`);
          check(/已向任务/.test(value.summary), `unexpected stop summary: ${JSON.stringify(value.summary)}`);
          // Assert the wrapper is gone AND that no process is left in its process
          // group. (Do NOT use `pgrep -f <token>` here: the probe shell's own
          // command line contains the pattern, so pgrep matches itself and the
          // check reports a false leftover.)
          const probe = await execTool.execute({
            command:
              `if kill -0 ${pid} 2>/dev/null; then echo alive; else echo dead; fi; ` +
              `count=$(ps -eo pgid=,args= 2>/dev/null | awk -v g=${pid} '$1==g {print}' | wc -l); echo "group:$count"`,
          });
          check(probe.ok === true, 'pid probe failed');
          check(probe.stdout.includes('dead'), `pid ${pid} still alive after stop: ${JSON.stringify(probe.stdout)}`);
          check(/group:0/.test(probe.stdout), `process group ${pid} still has members: ${JSON.stringify(probe.stdout)}`);
          return value;
        });

        await step('ssh_job status no longer reports running after stop', async () => {
          const value = await jobTool.execute({ action: 'status', host: 'live', jobId });
          check(value.status?.state !== 'running', `job still running after stop: ${JSON.stringify(value.status)}`);
          check(['exited', 'unknown'].includes(value.status?.state), `unexpected state ${JSON.stringify(value.status?.state)}`);
          return value;
        });
      }
    }

    // ── cleanup of the remote work area ─────────────────────────────────────
    await step('remove the remote work directory', async () => {
      for (const target of remoteCleanup) {
        check(target.startsWith(`${remoteHome}/`), `refusing to delete a path outside the remote home: ${target}`);
        const value = await execTool.execute({ command: `rm -rf '${target}' && test ! -e '${target}'` });
        check(value.ok === true, `remote cleanup of ${target} failed: ${JSON.stringify(value.summary)}`);
      }
      const verify = await execTool.execute({ command: `test ! -e '${remoteDir}' && echo removed` });
      check(verify.ok === true && verify.stdout.includes('removed'), 'remote work directory is still present');
      return verify;
    });
  } finally {
    await service.pool.closeAll().catch(() => {});
    fs.rmSync(localWork, { recursive: true, force: true });
    fs.rmSync(dshHome, { recursive: true, force: true });
    console.log(`[live] temp DSH_HOME removed: ${!fs.existsSync(dshHome)}`);
  }

  console.log('\n=== SUMMARY ===');
  console.log(`passed: ${passed}`);
  console.log(`failed: ${failed}`);
  if (warnings.length > 0) {
    console.log(`warnings: ${warnings.length} output.schema violation(s)`);
    for (const warning of warnings) console.log(`  - ${warning}`);
  }
  if (failures.length > 0) {
    console.log('failed steps:');
    for (const name of failures) console.log(`  - ${name}`);
    process.exitCode = 1;
  } else {
    console.log('live SSH end-to-end test passed');
  }
}

main().catch((error) => {
  console.error(`[fatal] ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
});
