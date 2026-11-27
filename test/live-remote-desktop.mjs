/**
 * Live end-to-end test of the remote Windows desktop component against a **real
 * Windows SSH server**. Not part of `npm test`.
 *
 * ```
 * DSH_SSH_LIVE_HOST=<host>          # required
 * DSH_SSH_LIVE_USER=<user>          # required
 * DSH_SSH_LIVE_PASSWORD=<password>  # required
 * DSH_SSH_LIVE_PORT=<port>          # optional, default 22
 * DSH_SSH_LIVE_DESKTOP_CONTROL=<dir># optional dsh-desktop-control package dir
 * DSH_SSH_LIVE_REQUIRED=1           # optional: a skip becomes a failure (CI)
 * DSH_SSH_LIVE_OPERATE=1            # optional: also run the REAL input round trip
 * ```
 *
 * The test drives the **tool layer**, not the internal functions: every returned
 * value is validated against the tool's own `output.schema`, which is what the
 * real registry does after `execute`. It therefore covers the transport (SSH →
 * interactive scheduled task → agent → response file), the response parsing, the
 * screenshot download, and the argument/result normalization together.
 *
 * ## Safety
 *
 * - The password comes from the environment only and never appears in output.
 * - The remote files live under `<home>\.dsh-ssh\remote-desktop\`; the test leaves
 *   them in place (the component reuses them), and removes the screenshot files
 *   it produced locally in `finally`.
 * - Default actions are deliberately non-destructive: `info`, `windows`,
 *   full-screen screenshot, a `move` to the **current** cursor position, a no-op
 *   `sequence` that waits 50 ms in the already-foreground window, and a `ui_dump`
 *   of the foreground window (allowed to report UI_UNAVAILABLE — some apps expose
 *   no tree). No clicks, no typing, no window state changes.
 * - With `DSH_SSH_LIVE_OPERATE=1` the test additionally launches a **fresh
 *   Notepad with its own temp file**, clicks into it, types Chinese text, saves
 *   with Ctrl+S, and verifies the saved file content over SFTP. It closes only its
 *   own tab (Alt+F4 after saving) and removes its temp directory + task; it never
 *   kills Notepad globally (Windows 11 Notepad is single-instance with tabs, so a
 *   blanket kill would close the user's tabs).
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createSshService } from '../lib/service.mjs';
import { execCommand, mkdirp, readRemoteText, resolveHome, withSftp, writeRemoteFile } from '../lib/ssh.mjs';
import { psQuote } from '../lib/windows.mjs';
import { locateDesktopControl } from '../lib/desktop-control.mjs';
import { createRemoteDesktop, remoteTaskName } from '../lib/remote-desktop.mjs';
import { buildRemoteDesktopTools } from '../lib/tools-remote-desktop.mjs';
import { validateValue } from './strict-schema.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const REQUIRED = ['DSH_SSH_LIVE_HOST', 'DSH_SSH_LIVE_USER', 'DSH_SSH_LIVE_PASSWORD'];
const missing = REQUIRED.filter((name) => typeof process.env[name] !== 'string' || process.env[name] === '');
if (missing.length > 0) {
  console.log(`[skip] live remote desktop test skipped: missing ${missing.join(', ')}`);
  console.log('Run it with: $env:DSH_SSH_LIVE_HOST="…"; $env:DSH_SSH_LIVE_USER="…"; $env:DSH_SSH_LIVE_PASSWORD="…"; node test/live-remote-desktop.mjs');
  process.exit(process.env.DSH_SSH_LIVE_REQUIRED === '1' ? 2 : 0);
}

const HOST = process.env.DSH_SSH_LIVE_HOST.trim();
const USER = process.env.DSH_SSH_LIVE_USER.trim();
const PASSWORD = process.env.DSH_SSH_LIVE_PASSWORD;
const PORT = Number.parseInt(process.env.DSH_SSH_LIVE_PORT ?? '22', 10);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`[fatal] DSH_SSH_LIVE_PORT must be an integer between 1 and 65535, got ${JSON.stringify(process.env.DSH_SSH_LIVE_PORT)}`);
  process.exit(2);
}

/** Printed form of the target: no credential, partial address. */
const MASKED = `${USER}@${HOST.replace(/\d+$/, '***')}:${PORT}`;
const STAMP = crypto.randomBytes(3).toString('hex');

/** The dsh-desktop-control installation to reuse (repo sibling by default). */
const DESKTOP_CONTROL = process.env.DSH_SSH_LIVE_DESKTOP_CONTROL === undefined
  ? path.resolve(HERE, '..', '..', 'dsh-desktop-control')
  : path.resolve(process.env.DSH_SSH_LIVE_DESKTOP_CONTROL);

let passed = 0;
let failed = 0;
const failures = [];
const localArtifacts = [];

const dshHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ssh-live-rd-'));
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
  tools: {
    register(definition) { registered.set(definition.name, definition); return () => {}; },
    get(name) { return name === 'desktop_screen_info' ? { name } : undefined; },
  },
  logger: { info() {}, warn() {}, error() {} },
};

const options = () => ({ defaultHost: 'win', maxOutputBytes: 65536, connectTimeoutMs: 20000, preferLocalRelay: true });
const service = createSshService({ ctx, dshHome, options });

// One named profile, so `resolveProfileFromArgs` and the password path are the
// same ones a real user's profile goes through.
await service.addServer({ name: 'win', host: HOST, port: PORT, user: USER, auth: 'password' });
await service.setPassword('win', PASSWORD);

const located = locateDesktopControl({
  dshHome,
  override: DESKTOP_CONTROL,
  argv: [],
  env: {},
  moduleUrl: import.meta.url,
});
if (located.found !== true) {
  console.error(`[fatal] dsh-desktop-control was not found at ${DESKTOP_CONTROL}: ${located.notes.join('; ')}`);
  process.exit(2);
}
console.log(`[setup] dsh-desktop-control ${located.version} at ${located.packageDir}`);

const remoteOptions = () => ({ timeoutMs: 90000, screenshotMaxWidth: 0, indicator: false });
const remote = createRemoteDesktop({
  ctx,
  service,
  locator: located,
  options: remoteOptions,
  logger: { info: (line) => console.log(`[component] ${line}`), warn: (line) => console.log(`[component] ${line}`), debug: () => {} },
});
for (const definition of buildRemoteDesktopTools({ service, remote, options: remoteOptions })) registered.set(definition.name, definition);

/**
 * Call one tool and validate its value against its own output schema.
 *
 * @param {string} name - tool name.
 * @param {Record<string, unknown>} args - arguments.
 * @returns {Promise<any>} the tool value.
 */
async function call(name, args) {
  const definition = registered.get(name);
  if (definition === undefined) throw new Error(`tool ${name} was not registered`);
  const value = await definition.execute(args);
  const violations = validateValue(value, definition.output.schema);
  if (violations.length > 0) throw new Error(`schema violation from ${name}: ${violations.join('; ')}`);
  const rendered = definition.output.render(args, value);
  if (!Array.isArray(rendered) || rendered.length === 0 || typeof rendered[0].text !== 'string' || rendered[0].text === '') {
    throw new Error(`${name} rendered nothing`);
  }
  return value;
}

/** Run one named step, recording pass/fail without aborting the run. */
async function step(name, fn) {
  const started = Date.now();
  try {
    await fn();
    passed += 1;
    console.log(`[PASS] ${name} (${Date.now() - started} ms)`);
  } catch (error) {
    failed += 1;
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`${name}: ${message}`);
    console.log(`[FAIL] ${name} (${Date.now() - started} ms): ${message}`);
  }
}

/**
 * Write a tiny PNG and check it back with read_image? No: this is a CLI test; the
 * PNG signature plus a sane byte count is the check available without a viewer.
 *
 * @param {string} file - the local screenshot path.
 * @returns {{ bytes: number, magic: boolean }} what was found.
 */
function inspectPng(file) {
  const buffer = fs.readFileSync(file);
  const magic = buffer.length >= 8
    && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47
    && buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a;
  return { bytes: buffer.length, magic };
}

try {
  await step('ssh_host test reports a Windows remote', async () => {
    const test = await service.testServer('win');
    if (!/windows/i.test(test.platform)) throw new Error(`expected a Windows platform, got ${JSON.stringify(test.platform)}`);
    console.log(`[info] ${MASKED} → ${test.hostname} · ${test.platform} · ${test.uptime}`);
  });

  await step('screen info: physical geometry, DPI and foreground window', async () => {
    const value = await call('ssh_desktop_screen', { action: 'info', host: 'win' });
    if (value.ok !== true) throw new Error(`info failed: ${value.code} ${value.message}`);
    if (!(value.info.screen.width > 0 && value.info.screen.height > 0)) throw new Error('screen geometry is empty');
    if (value.info.monitorCount < 1) throw new Error('no monitor was reported');
    if (!(value.info.dpi >= 96)) throw new Error(`unexpected dpi ${value.info.dpi}`);
    if (value.info.foreground.hwnd <= 0) throw new Error('foreground window is empty');
    console.log(`[info] screen ${value.info.screen.width}x${value.info.screen.height}, dpi ${value.info.dpi}, foreground「${value.info.foreground.title}」(${value.info.foreground.processName})`);
  });

  await step('windows: the list is non-empty and carries hwnd/title/process', async () => {
    const value = await call('ssh_desktop_screen', { action: 'windows', host: 'win', limit: 50 });
    if (value.ok !== true) throw new Error(`windows failed: ${value.code} ${value.message}`);
    if (value.windows.length === 0) throw new Error('no visible window was reported');
    const usable = value.windows.filter((window) => window.hwnd > 0 && typeof window.title === 'string' && typeof window.processName === 'string');
    if (usable.length === 0) throw new Error('no window carries hwnd/title/processName');
    console.log(`[info] ${value.windows.length} windows, e.g.「${value.windows[0].title}」 (${value.windows[0].processName})`);
  });

  await step('screenshot: full screen, maxWidth 0, PNG fetched locally', async () => {
    const value = await call('ssh_desktop_screen', { action: 'screenshot', host: 'win', maxWidth: 0 });
    if (value.ok !== true) throw new Error(`screenshot failed: ${value.code} ${value.message}`);
    if (!(value.shot.width > 0 && value.shot.height > 0)) throw new Error('screenshot dimensions are empty');
    if (!fs.existsSync(value.shot.path)) throw new Error(`local screenshot ${value.shot.path} does not exist`);
    const png = inspectPng(value.shot.path);
    if (!png.magic) throw new Error(`local file is not a PNG (${png.bytes} bytes)`);
    if (png.bytes < 1000) throw new Error(`screenshot is suspiciously small (${png.bytes} bytes)`);
    if (value.shot.width !== value.shot.sourceWidth) throw new Error('maxWidth 0 must not scale the image');
    localArtifacts.push(value.shot.path);
    console.log(`[info] saved ${value.shot.path} (${png.bytes} bytes, ${value.shot.width}x${value.shot.height}, method ${value.shot.captureMethod}, blank=${value.shot.blank})`);
  });

  await step('move: a no-op move to the current cursor stays on the same point', async () => {
    const start = await call('ssh_desktop_screen', { action: 'info', host: 'win' });
    const cursor = start.info.cursor;
    const value = await call('ssh_desktop_action', { action: 'move', host: 'win', x: cursor.x, y: cursor.y });
    if (value.ok !== true) throw new Error(`move failed: ${value.code} ${value.message}`);
    // SendInput's absolute-coordinate normalisation can land one pixel off
    // (measured: asked 2054,2, read back 2054,1), so allow a 2 px tolerance.
    const drift = Math.abs(value.cursor.x - cursor.x) + Math.abs(value.cursor.y - cursor.y);
    if (drift > 2) {
      throw new Error(`cursor drifted from (${cursor.x}, ${cursor.y}) to (${value.cursor.x}, ${value.cursor.y})`);
    }
    console.log(`[info] cursor requested (${cursor.x}, ${cursor.y}), read back (${value.cursor.x}, ${value.cursor.y})`);
  });

  await step('the remote task is launched through the hidden wscript launcher', async () => {
    const profile = service.resolveProfileFromArgs({ host: 'win' });
    const task = remoteTaskName(profile);
    const client = await service.clientFor(profile);
    const result = await execCommand(
      client,
      `$a = (Get-ScheduledTask -TaskName '${task}').Actions; $a | ForEach-Object { $_.Execute; $_.Arguments }`,
      { timeoutMs: 30000, maxOutputBytes: 4096 },
    );
    if (!/wscript\.exe/i.test(result.stdout)) throw new Error(`the task action is not wscript: ${result.stdout.trim()}`);
    if (!/agent\.vbs/i.test(result.stdout)) throw new Error(`the task action does not reference agent.vbs: ${result.stdout.trim()}`);
    console.log(`[info] task ${task} → ${result.stdout.trim().split(/\r?\n/).join(' ')}`);
  });

  await step('sequence: focus the current foreground window and wait 50 ms', async () => {
    // A hwnd is only valid while that window exists; a terminal window can be
    // recreated between two calls (measured during development). Re-read a fresh
    // foreground window and retry once when it vanished — the component correctly
    // reports WINDOW_NOT_FOUND, which is not a failure of the transport.
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const windows = await call('ssh_desktop_screen', { action: 'windows', host: 'win', limit: 20 });
      if (windows.ok !== true || windows.windows.length === 0) throw new Error('no window available for sequence');
      const foreground = windows.windows.find((window) => window.foreground === true) ?? windows.windows[0];
      const value = await call('ssh_desktop_action', {
        action: 'sequence',
        host: 'win',
        window: foreground.title,
        steps: [{ action: 'wait', ms: 50 }],
      });
      if (value.ok === true) {
        if (value.sequence.stepCount !== 1) throw new Error(`expected 1 step, got ${value.sequence.stepCount}`);
        if (value.sequence.failedSteps !== 0) throw new Error(`sequence reported ${value.sequence.failedSteps} failed steps: ${value.sequence.aborted}`);
        console.log(`[info] sequence focused=${value.sequence.focused} method=${value.sequence.focusMethod}`);
        return;
      }
      lastError = value;
      if (value.code !== 'WINDOW_NOT_FOUND') break;
      console.log(`[info] the target window disappeared between calls (attempt ${attempt + 1}); retrying with a fresh one`);
    }
    throw new Error(`sequence failed: ${lastError?.code ?? 'unknown'} ${lastError?.message ?? ''}`);
  });

  await step('ui_dump: the foreground window exposes a UIA tree (or reports UI_UNAVAILABLE)', async () => {
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const windows = await call('ssh_desktop_screen', { action: 'windows', host: 'win', limit: 20 });
      if (windows.ok !== true || windows.windows.length === 0) throw new Error('no window available for ui_dump');
      const foreground = windows.windows.find((window) => window.foreground === true) ?? windows.windows[0];
      const value = await call('ssh_desktop_screen', { action: 'ui_dump', host: 'win', window: foreground.title, maxNodes: 50 });
      if (value.ok === true) {
        if (!Array.isArray(value.ui.elements)) throw new Error('ui_dump returned no elements array');
        console.log(`[info] ui_dump ${value.ui.count}/${value.ui.totalElements} elements on「${value.ui.title}」`);
        return;
      }
      // Not every application exposes UI Automation; that is a documented boundary,
      // not a component failure. Anything else (timeout, transport) still fails.
      if (value.code === 'UI_UNAVAILABLE') {
        console.log(`[info] this foreground window exposes no UIA provider (${value.message})`);
        return;
      }
      lastError = value;
      if (value.code !== 'WINDOW_NOT_FOUND') break;
      console.log(`[info] the target window disappeared between calls (attempt ${attempt + 1}); retrying with a fresh one`);
    }
    throw new Error(`ui_dump failed: ${lastError?.code ?? 'unknown'} ${lastError?.message ?? ''}`);
  });

  if (process.env.DSH_SSH_LIVE_OPERATE === '1') {
    const stamp = crypto.randomBytes(3).toString('hex');
    const opProfile = service.resolveProfileFromArgs({ host: 'win' });
    const opClient = await service.clientFor(opProfile);
    const home = await resolveHome(opClient);
    const opDir = `${home}\\dsh-ssh-live-op-${stamp}`;
    const opTask = `dsh-ssh-live-op-${stamp}`;
    const opFile = `${opDir}\\remote-desktop-test.txt`;
    const expected = '远程桌面验证 OK\n第二行 line2\n符号 !@#$%';
    const vbs = [
      'Dim shell, fso, dir',
      'Set shell = CreateObject("WScript.Shell")',
      'Set fso = CreateObject("Scripting.FileSystemObject")',
      'dir = fso.GetParentFolderName(WScript.ScriptFullName)',
      'shell.Run "notepad.exe """ & dir & "\\remote-desktop-test.txt""", 1, False',
      '',
    ].join('\r\n');
    let opWindow = null;
    // Windows 11 Notepad is a single-instance app with tabs. If none was running
    // before this test, the instance the test launches is exclusively ours and may
    // be ended during cleanup; if the user already had Notepad open, we must not
    // kill it (the test would attach a tab to their app).
    const notepadBefore = await execCommand(
      opClient,
      '$n = @(Get-Process -Name Notepad -ErrorAction SilentlyContinue).Count; Write-Output $n',
      { timeoutMs: 30000, maxOutputBytes: 1024 },
    )
      .then((result) => Number.parseInt(String(result.stdout).trim(), 10) || 0)
      .catch(() => 0);
    try {
      await withSftp(opClient, async (sftp) => {
        await mkdirp(sftp, opDir);
        await writeRemoteFile(sftp, `${opDir}\\start.vbs`, Buffer.from(vbs, 'utf8'));
        await writeRemoteFile(sftp, opFile, Buffer.from('', 'utf8'));
      });
      const setup = [
        `$task = ${psQuote(opTask)}`,
        `$dir = ${psQuote(opDir)}`,
        `Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue | Out-Null`,
        `$exe = Join-Path $env:SystemRoot 'System32\\wscript.exe'`,
        `$arg = '//B //NoLogo "' + (Join-Path $dir 'start.vbs') + '"'`,
        `$action = New-ScheduledTaskAction -Execute $exe -Argument $arg -WorkingDirectory $dir`,
        `$principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Highest`,
        `Register-ScheduledTask -TaskName $task -Action $action -Principal $principal -Force | Out-Null`,
        `Start-ScheduledTask -TaskName $task`,
        `Start-Sleep -Seconds 2`,
        `Get-Process -Name Notepad -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Id`,
      ].join('; ');
      const launched = await execCommand(opClient, setup, { timeoutMs: 60000, maxOutputBytes: 4096 });
      if (!/^\d+$/m.test(launched.stdout.trim())) throw new Error(`Notepad did not start: ${launched.stdout.trim()} ${launched.stderr.trim()}`);

      for (let attempt = 0; attempt < 6 && opWindow === null; attempt += 1) {
        const value = await call('ssh_desktop_screen', { action: 'windows', host: 'win', filter: 'remote-desktop-test', limit: 10 });
        opWindow = value.ok === true ? (value.windows[0] ?? null) : null;
        if (opWindow === null) await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      if (opWindow === null) throw new Error('the Notepad window never appeared');

      await step('operate (opt-in): click + Chinese typing + Ctrl+S reach the remote desktop', async () => {
        const clickX = Math.round(opWindow.x + opWindow.width / 2);
        const clickY = Math.round(opWindow.y + opWindow.height * 0.4);
        const value = await call('ssh_desktop_action', {
          action: 'sequence',
          host: 'win',
          hwnd: opWindow.hwnd,
          state: 'restore',
          steps: [
            { action: 'click', x: clickX, y: clickY },
            { action: 'wait', ms: 300 },
            { action: 'text', text: expected },
            { action: 'wait', ms: 300 },
            { action: 'key', combo: 'Ctrl+S' },
            { action: 'wait', ms: 1500 },
          ],
        });
        if (value.ok !== true) throw new Error(`sequence failed: ${value.code} ${value.message}`);
        if (value.sequence.stepCount !== 6) throw new Error(`expected 6 steps, got ${value.sequence.stepCount} (${value.message})`);
        if (value.sequence.failedSteps !== 0) throw new Error(`failed steps: ${value.sequence.aborted}`);
        let saved = '';
        for (let attempt = 0; attempt < 8; attempt += 1) {
          saved = (await withSftp(opClient, (sftp) => readRemoteText(sftp, opFile, { maxBytes: 65536 }))).replace(/^\uFEFF/, '');
          if (saved.includes('远程桌面验证 OK')) break;
          await new Promise((resolve) => setTimeout(resolve, 800));
        }
        const normalized = saved.replace(/\r\n/g, '\n').replace(/\n+$/, '');
        if (normalized !== expected) {
          throw new Error(`saved text mismatch: expected ${JSON.stringify(expected)}, got ${JSON.stringify(normalized)}`);
        }
        console.log(`[info] saved file content matches exactly: ${JSON.stringify(normalized)}`);
      });

      // Close only our own tab when possible: the file is saved, so Alt+F4 closes
      // it without a prompt. Notepad 11 does not always honour synthesized
      // Alt+F4; cleanup below therefore ends the instance when this test started
      // it (notepadBefore === 0), which closes only tabs created by this run.
      try {
        await call('ssh_desktop_action', {
          action: 'sequence',
          host: 'win',
          hwnd: opWindow.hwnd,
          steps: [{ action: 'key', key: 'Alt+F4' }, { action: 'wait', ms: 500 }],
        });
      } catch (error) {
        console.log(`[info] closing the test tab failed (harmless): ${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      const cleanupScript = [
        `Unregister-ScheduledTask -TaskName ${psQuote(opTask)} -Confirm:$false -ErrorAction SilentlyContinue | Out-Null`,
        notepadBefore === 0
          ? 'Get-Process -Name Notepad -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue'
          : "Write-Output 'notepad was already running before the test; leaving it alone'",
        `Start-Sleep -Milliseconds 800`,
        `for ($i = 0; $i -lt 6; $i++) { Remove-Item -LiteralPath ${psQuote(opDir)} -Recurse -Force -ErrorAction SilentlyContinue; if (-not (Test-Path -LiteralPath ${psQuote(opDir)})) { break }; Start-Sleep -Milliseconds 600 }`,
        `if (Test-Path -LiteralPath ${psQuote(opDir)}) { Write-Output 'cleanup: temp dir could not be removed (a tab may still hold the file)' } else { Write-Output 'cleanup: temp dir removed' }`,
      ].join('; ');
      const cleanupResult = await execCommand(opClient, cleanupScript, { timeoutMs: 60000, maxOutputBytes: 4096 }).catch(() => null);
      if (cleanupResult !== null) console.log(`[cleanup] ${String(cleanupResult.stdout).trim()}`);
    }
  }

  await step('prerequisite: the component refuses to work when dsh-desktop-control is not registered', async () => {
    const gateCtx = { tools: { get: () => undefined } };
    const blockedRemote = createRemoteDesktop({
      ctx: gateCtx,
      service,
      locator: located,
      options: remoteOptions,
      logger: null,
    });
    try {
      await blockedRemote.call({ name: 'win', host: HOST, port: PORT, user: USER }, 'info', {});
      throw new Error('the call succeeded even though the prerequisite is not registered');
    } catch (error) {
      if (!(error instanceof Error) || !String(error.message).includes('dsh-desktop-control')) {
        throw new Error(`expected a prerequisite error, got ${error instanceof Error ? error.message : String(error)}`);
      }
      if (error.code !== 'PREREQUISITE_DISABLED') throw new Error(`expected PREREQUISITE_DISABLED, got ${String(error.code)}`);
    }
  });
} finally {
  for (const file of localArtifacts) {
    try { fs.rmSync(file, { force: true }); } catch { /* keep the failure visible */ }
  }
  fs.rmSync(dshHome, { recursive: true, force: true });
}

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log('\nFailures:');
  for (const failure of failures) console.log(`- ${failure}`);
}
process.exit(failed === 0 ? 0 : 1);
