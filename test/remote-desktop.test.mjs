/**
 * The remote Windows desktop component: offline tests.
 *
 * Five layers, each with a failure mode that the others cannot see:
 *
 * 1. **Generated remote scripts** — they are PowerShell text shipped to another
 *    machine; a non-ASCII byte, a missing redirection or a changed task principal
 *    would only fail there. Checked structurally here.
 * 2. **Package locator** — "which installed dsh-desktop-control" is a filesystem
 *    question with several discovery paths. Exercised against real temp dirs.
 * 3. **Wire helpers** — marker/response parsing is the boundary between a remote
 *    process and a tool result; malformed input must produce a diagnosable error.
 * 4. **Tool layer** — every action is executed against a fake remote, and its
 *    return value is validated against the tool's own `output.schema`, exactly as
 *    the registry does at runtime. A failure also has to keep that shape.
 * 5. **On-demand gate + prerequisite** — two tool groups, two skills: loading one
 *    skill must not reveal the other group, and disabling `dsh-desktop-control`
 *    must hide the remote group immediately.
 *
 * Nothing here opens an SSH connection: the transport layer is exercised against
 * the real host by `test/live-remote-desktop.mjs`, which is environment-driven.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  AGENT_SCRIPT_RELATIVE,
  DESKTOP_CONTROL_PACKAGE,
  REQUIRED_OPS,
  desktopControlRegistered,
  inspectDesktopControlPackage,
  locateDesktopControl,
  profileDirFromModuleUrl,
  profileHintsFromArgv,
} from '../lib/desktop-control.mjs';
import {
  RemoteDesktopError,
  buildAgentCommandScript,
  buildAgentVbsScript,
  buildRunActionScript,
  installationKey,
  isPng,
  parseAgentResponse,
  parseMarkers,
  remoteDesktopPaths,
  remoteTaskName,
  selectAgentData,
} from '../lib/remote-desktop.mjs';
import { REMOTE_DESKTOP_TOOL_NAMES, buildRemoteDesktopTools } from '../lib/tools-remote-desktop.mjs';
import { REMOTE_DESKTOP_SKILL_DEFINITION, REMOTE_DESKTOP_SKILL_NAME } from '../lib/skill-remote-desktop.mjs';
import { validateSchemaNode, validateValue } from './strict-schema.mjs';

/** A fresh temp directory removed by the caller. */
function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Create a minimal but *valid* dsh-desktop-control installation.
 *
 * The agent script must be larger than 10 KB and contain the command dispatch
 * lines, because the locator refuses a stub: shipping a stub to a remote host
 * would fail there instead of at install time.
 *
 * @param {string} profileDir - the profile directory to install under.
 * @param {string} [version] - package version.
 * @returns {string} the package directory.
 */
function installFakeDesktopControl(profileDir, version = '0.8.4') {
  const packageDir = path.join(profileDir, 'node_modules', DESKTOP_CONTROL_PACKAGE);
  fs.mkdirSync(path.join(packageDir, 'scripts'), { recursive: true });
  fs.writeFileSync(
    path.join(packageDir, 'package.json'),
    JSON.stringify({ name: DESKTOP_CONTROL_PACKAGE, version, main: './index.js' }, null, 2),
  );
  const dispatch = REQUIRED_OPS.map((operation) => `        '${operation}' { return $null }`).join('\n');
  fs.writeFileSync(
    path.join(packageDir, AGENT_SCRIPT_RELATIVE),
    ['# fake agent for tests', 'switch ($command) {', dispatch, '}', 'x'.repeat(12000), ''].join('\n'),
    'utf8',
  );
  return packageDir;
}

/** Create a profile directory with the manifest the locator recognises. */
function writeProfile(profileDir, bundles = ['dsh-ssh', DESKTOP_CONTROL_PACKAGE]) {
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(
    path.join(profileDir, 'package.json'),
    JSON.stringify({ name: 'dsh-profile-test', private: true, dsh: { profile: { bundles } } }, null, 2),
  );
  return profileDir;
}

// ─────────────────────────── generated remote scripts ────────────────────────

test('agent.cmd redirects stdin/stdout byte-for-byte and records the exit code', () => {
  const script = buildAgentCommandScript({ indicator: false });
  assert.match(script, /desktop-agent\.ps1/);
  assert.match(script, /\-Indicator 0/);
  // OS-level redirection is the encoding-safe route (a .NET pipe would decode
  // UTF-8 with the console code page and mangle Chinese titles).
  assert.match(script, /< "%~dp0request\.jsonl" > "%~dp0response\.jsonl" 2> "%~dp0stderr\.txt"/);
  assert.match(script, /> "%~dp0agent\.exit" echo %ERRORLEVEL%/);
  assert.ok(/^[\t\r\n\x20-\x7e]*$/.test(script), 'the launcher must be ASCII so PowerShell 5.1 never decodes it as ANSI');
  assert.equal(buildAgentCommandScript({ indicator: true }).includes('-Indicator 1'), true);
});

test('agent.vbs starts agent.cmd hidden (no console window on the user desktop)', () => {
  const vbs = buildAgentVbsScript();
  assert.ok(/^[\t\r\n\x20-\x7e]*$/.test(vbs), 'the VBS launcher must be ASCII-only');
  assert.match(vbs, /WScript\.Shell/);
  assert.match(vbs, /GetParentFolderName\(WScript\.ScriptFullName\)/);
  // window style 0 = hidden, and it must not wait (the runner observes agent.exit).
  assert.match(vbs, /shell\.Run .*0, False/);
  assert.match(vbs, /agent\.cmd/);
});

test('run-action.ps1 uses an Interactive principal at Highest and reports markers', () => {
  const script = buildRunActionScript();
  assert.ok(/^[\t\r\n\x20-\x7e]*$/.test(script), 'the runner must be ASCII-only');
  assert.match(script, /New-ScheduledTaskPrincipal .* -LogonType Interactive -RunLevel Highest/);
  assert.match(script, /Register-ScheduledTask/);
  assert.match(script, /Start-ScheduledTask/);
  assert.match(script, /Stop-ScheduledTask/, 'a stale running instance must be stopped before the next start');
  // The agent is launched through wscript (GUI subsystem), not cmd directly:
  // a console window would steal the remote user's foreground on every call.
  assert.match(script, /wscript\.exe/);
  assert.match(script, /agent\.vbs/);
  assert.match(script, /dsh-launcher=vbs/);
  assert.match(script, /dsh-launcher=console/, 'a fallback for images without wscript must exist');
  // An existing task registered with the old launcher has to be migrated.
  assert.match(script, /\$currentAction\.Execute -ne \$actionExe/);
  // The Node side distinguishes a real failure from "no interactive session" by
  // these markers, so each must be present.
  for (const marker of ['dsh-task=', 'dsh-exit=timeout', 'dsh-response-bytes=', 'dsh-explorer-sessions=']) {
    assert.ok(script.includes(marker), `missing marker ${marker}`);
  }
  // Regression guard: PowerShell variable names are case-insensitive, so a local
  // `$task` silently overwrites the `-Task` parameter and the task name becomes
  // null (measured on a real host: Register-ScheduledTask rejected a null name).
  assert.ok(!/\$task(?!Info)/.test(script), 'the runner must not use a local $task next to the -Task parameter');
  assert.match(script, /\$taskInfo = Get-ScheduledTask/);
});

// ─────────────────────────── wire helpers ────────────────────────────────────

test('remoteDesktopPaths normalises a trailing separator and lays out every file', () => {
  const paths = remoteDesktopPaths('C:\\Users\\Administrator\\');
  assert.equal(paths.root, 'C:\\Users\\Administrator\\.dsh-ssh\\remote-desktop');
  assert.equal(paths.agentScript, `${paths.root}\\desktop-agent.ps1`);
  assert.equal(paths.agentCommand, `${paths.root}\\agent.cmd`);
  assert.equal(paths.runAction, `${paths.root}\\run-action.ps1`);
  assert.equal(paths.request, `${paths.root}\\request.jsonl`);
  assert.equal(paths.response, `${paths.root}\\response.jsonl`);
  assert.equal(paths.exitFile, `${paths.root}\\agent.exit`);
  assert.equal(paths.shots, `${paths.root}\\shots`);
  assert.equal(paths.stamp, `${paths.root}\\install.json`);
});

test('remoteTaskName is stable per user, prefixed, and Task-Scheduler safe', () => {
  const first = remoteTaskName({ user: 'Administrator' });
  const second = remoteTaskName({ user: 'Administrator' });
  const other = remoteTaskName({ user: 'somebody' });
  assert.equal(first, second);
  assert.notEqual(first, other);
  assert.match(first, /^dsh-ssh-remote-desktop-[0-9a-f]{12}$/);
  assert.equal(remoteTaskName({}).startsWith('dsh-ssh-remote-desktop-'), true);
});

test('installationKey changes when the agent script or a launcher changes', () => {
  const agent = Buffer.from('agent-bytes');
  const cmd = buildAgentCommandScript({});
  const vbs = buildAgentVbsScript();
  const run = buildRunActionScript();
  const key = installationKey(agent, cmd, vbs, run);
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.notEqual(installationKey(Buffer.from('agent-bytez'), cmd, vbs, run), key);
  assert.notEqual(installationKey(agent, `${cmd}\r\nrem changed`, vbs, run), key);
  assert.notEqual(installationKey(agent, cmd, `${vbs}\r\n' changed`, run), key);
  assert.notEqual(installationKey(agent, cmd, vbs, `${run}\r\n# changed`), key);
  assert.equal(installationKey(agent, cmd, vbs, run), key, 'the same inputs must produce the same key');
});

test('parseMarkers keeps key=value pairs with spaces and ignores foreign lines', () => {
  const { markers } = parseMarkers([
    'dsh-task=register-failed access denied to the task folder',
    'dsh-exit=0',
    'noise without an equals sign',
    'foo=bar',
    'dsh-response-bytes=4096',
  ].join('\r\n'));
  assert.deepEqual(markers, {
    'dsh-task': 'register-failed access denied to the task folder',
    'dsh-exit': '0',
    'dsh-response-bytes': '4096',
  });
});

test('parseAgentResponse finds the matching id and separates ready from response', () => {
  const text = [
    '{"ready":true,"screen":{"width":2560,"height":1440}}',
    '{"id":1,"ok":true,"data":{"count":2}}',
    '',
  ].join('\n');
  const parsed = parseAgentResponse(text, 1);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.data, { count: 2 });
  assert.equal(parsed.ready.screen.width, 2560);
  assert.equal(parsed.count, 2);

  const failed = parseAgentResponse('{"ready":true}\n{"id":1,"ok":false,"code":"BAD_ARGUMENT","message":"x"}', 1);
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'BAD_ARGUMENT');
  assert.equal(failed.message, 'x');

  const missing = parseAgentResponse('{"ready":true}', 1);
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'REMOTE_DESKTOP_NO_RESPONSE');
});

test('selectAgentData recovers the sequence summary from the agent array payload', () => {
  // Captured from a real host: `sequence` with text/key steps leaks the step
  // functions' return values into the response, so data is an array and the last
  // element (the actual summary) must be chosen by shape, not by position.
  const leaked = [
    { characters: 28, foreground: { hwnd: 1, title: 'x' } },
    { keys: ['Ctrl', 'S'], times: 1 },
    { hwnd: 1, title: 'x', focused: true, stepCount: 6, failedSteps: 0, steps: [{ index: 1, action: 'click', ok: true }] },
  ];
  const summary = selectAgentData('sequence', leaked);
  assert.equal(summary.stepCount, 6);
  assert.equal(summary.steps.length, 1);

  // The same array in a different order still resolves by shape.
  const reordered = [leaked[2], leaked[0], leaked[1]];
  assert.equal(selectAgentData('sequence', reordered).stepCount, 6);

  // Non-sequence arrays use the last object; scalars and null degrade to {}.
  assert.deepEqual(selectAgentData('windows', [{ a: 1 }, { b: 2 }]), { b: 2 });
  assert.deepEqual(selectAgentData('info', { width: 1 }), { width: 1 });
  assert.deepEqual(selectAgentData('info', []), {});
  assert.deepEqual(selectAgentData('info', null), {});
  assert.deepEqual(selectAgentData('info', 'text'), {});
  // An array with no summary falls back to the last object for sequence too.
  assert.deepEqual(selectAgentData('sequence', [{ characters: 1 }, { keys: [] }]), { keys: [] });
});

test('isPng accepts only the PNG signature', () => {
  assert.equal(isPng(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])), true);
  assert.equal(isPng(Buffer.from('not a png')), false);
  assert.equal(isPng(null), false);
});

// ─────────────────────────── package locator ─────────────────────────────────

test('inspectDesktopControlPackage validates name, script size and required operations', () => {
  const root = tempDir('dsh-ssh-locator-');
  try {
    const packageDir = installFakeDesktopControl(path.join(root, 'profiles', 'desktop'));
    const found = inspectDesktopControlPackage(packageDir, 'test');
    assert.equal(found.packageDir, packageDir);
    assert.equal(found.version, '0.8.4');
    assert.deepEqual(found.missingOps, []);
    assert.equal(found.source, 'test');

    const stub = path.join(root, 'stub');
    fs.mkdirSync(path.join(stub, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(stub, 'package.json'), JSON.stringify({ name: DESKTOP_CONTROL_PACKAGE }));
    fs.writeFileSync(path.join(stub, AGENT_SCRIPT_RELATIVE), 'tiny');
    assert.equal(inspectDesktopControlPackage(stub), null, 'a stub install must be refused');

    const wrongName = path.join(root, 'wrong-name');
    fs.mkdirSync(wrongName, { recursive: true });
    fs.writeFileSync(path.join(wrongName, 'package.json'), JSON.stringify({ name: 'something-else' }));
    assert.equal(inspectDesktopControlPackage(wrongName), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('locateDesktopControl finds a profile install and reports the source', () => {
  const dshHome = tempDir('dsh-ssh-home-');
  try {
    const profileDir = writeProfile(path.join(dshHome, 'profiles', 'desktop'));
    installFakeDesktopControl(profileDir);
    const located = locateDesktopControl({ dshHome, argv: [], env: {}, moduleUrl: 'file:///nowhere/index.js' });
    assert.equal(located.found, true);
    assert.equal(located.version, '0.8.4');
    assert.equal(located.source, 'profile desktop');
    assert.deepEqual(located.notes, []);
  } finally {
    fs.rmSync(dshHome, { recursive: true, force: true });
  }
});

test('locateDesktopControl honours an explicit override and prefers it', () => {
  const dshHome = tempDir('dsh-ssh-home-');
  const overrideHome = tempDir('dsh-ssh-override-');
  try {
    const profileDir = writeProfile(path.join(dshHome, 'profiles', 'desktop'));
    installFakeDesktopControl(profileDir, '0.8.0');
    const overridePackage = installFakeDesktopControl(path.join(overrideHome), '0.9.9');
    const located = locateDesktopControl({
      dshHome,
      override: overridePackage,
      argv: [],
      env: {},
      moduleUrl: 'file:///nowhere/index.js',
    });
    assert.equal(located.found, true);
    assert.equal(located.version, '0.9.9');
    assert.equal(located.source, 'remoteDesktopControlDir config');
  } finally {
    fs.rmSync(dshHome, { recursive: true, force: true });
    fs.rmSync(overrideHome, { recursive: true, force: true });
  }
});

test('locateDesktopControl discovers the profile from argv and from the module URL', () => {
  const dshHome = tempDir('dsh-ssh-home-');
  try {
    const profileDir = writeProfile(path.join(dshHome, 'profiles', 'web'));
    installFakeDesktopControl(profileDir);

    const fromArgv = locateDesktopControl({ dshHome, argv: ['node', profileDir], env: {}, moduleUrl: 'file:///nowhere/index.js' });
    assert.equal(fromArgv.found, true);
    assert.match(fromArgv.source, /process\.argv/);

    const packageDir = path.join(profileDir, 'node_modules', DESKTOP_CONTROL_PACKAGE);
    const fromModule = locateDesktopControl({
      dshHome: '',
      argv: [],
      env: {},
      moduleUrl: `file:///${path.join(packageDir, 'lib', 'x.mjs').replace(/\\/g, '/')}`,
    });
    assert.equal(fromModule.found, true);
    assert.equal(fromModule.source, 'own module path');
  } finally {
    fs.rmSync(dshHome, { recursive: true, force: true });
  }
});

test('locateDesktopControl reports missing, and duplicates as a note', () => {
  const dshHome = tempDir('dsh-ssh-home-');
  try {
    const missing = locateDesktopControl({ dshHome, argv: [], env: {}, moduleUrl: 'file:///nowhere/index.js' });
    assert.equal(missing.found, false);
    assert.ok(missing.notes.length > 0);

    installFakeDesktopControl(writeProfile(path.join(dshHome, 'profiles', 'a')), '0.8.1');
    installFakeDesktopControl(writeProfile(path.join(dshHome, 'profiles', 'b')), '0.8.2');
    const duplicated = locateDesktopControl({ dshHome, argv: [], env: {}, moduleUrl: 'file:///nowhere/index.js' });
    assert.equal(duplicated.found, true);
    assert.ok(duplicated.notes.some((note) => note.includes('multiple')), 'the ambiguity must be reported');
    assert.equal(duplicated.installed.length, 2);
  } finally {
    fs.rmSync(dshHome, { recursive: true, force: true });
  }
});

test('profileHintsFromArgv ignores non-profile absolute paths', () => {
  const root = tempDir('dsh-ssh-argv-');
  try {
    const profileDir = writeProfile(path.join(root, 'profiles', 'desktop'));
    const otherDir = path.join(root, 'not-a-profile');
    fs.mkdirSync(otherDir, { recursive: true });
    const hints = profileHintsFromArgv(['node', '--profile', 'desktop', otherDir, profileDir]);
    assert.deepEqual(hints, [{ name: 'desktop' }, { dir: profileDir }]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('profileDirFromModuleUrl refuses a path that is not under a profile', () => {
  assert.equal(profileDirFromModuleUrl('file:///E:/dsh-plugins/dsh-ssh/lib/x.mjs'), null);
});

test('desktopControlRegistered reads the live tool registry and never throws', () => {
  assert.equal(desktopControlRegistered({ tools: { get: (name) => (name === 'desktop_screen_info' ? {} : undefined) } }), true);
  assert.equal(desktopControlRegistered({ tools: { get: () => undefined } }), false);
  assert.equal(desktopControlRegistered({}), false);
  assert.equal(desktopControlRegistered({ tools: { get() { throw new Error('disposed'); } } }), false);
});

// ─────────────────────────── tool layer ──────────────────────────────────────

/** A profile view adequate for `resolveProfileFromArgs`. */
const PROFILE = { name: 'win-pc', host: '10.0.0.9', port: 22, user: 'Administrator' };

/** A fake remote that records calls and returns canned agent data. */
function fakeRemote(handlers = {}) {
  const calls = [];
  return {
    calls,
    prerequisiteEnabled: () => true,
    describe: () => ({}),
    async call(profile, cmd, args, options) {
      calls.push({ cmd, args, options });
      const handler = handlers[cmd];
      if (handler === undefined) throw new Error(`unexpected remote command ${cmd}`);
      if (handler instanceof Error) throw handler;
      return { ready: {}, data: typeof handler === 'function' ? handler(args) : handler };
    },
    async screenshot(profile, args, options) {
      calls.push({ cmd: 'screenshot', args, options });
      const handler = handlers.screenshot;
      if (handler === undefined) throw new Error('unexpected screenshot');
      if (handler instanceof Error) throw handler;
      const data = typeof handler === 'function' ? handler(args) : handler;
      return {
        localPath: 'C:\\Temp\\dsh-ssh-remote-desktop\\win-pc\\shot.png',
        remotePath: 'C:\\Users\\Administrator\\.dsh-ssh\\remote-desktop\\shots\\shot.png',
        bytes: 2048,
        maxWidth: args.maxWidth ?? 0,
        ...data,
      };
    },
  };
}

/** Build the two tools against a fake remote. */
function toolsWith(remote) {
  const service = { resolveProfileFromArgs: () => PROFILE };
  const options = () => ({ timeoutMs: 60000, screenshotMaxWidth: 1600, indicator: false });
  const tools = buildRemoteDesktopTools({ service, remote, options });
  return { tools, byName: new Map(tools.map((tool) => [tool.name, tool])), remote };
}

/** Validate one tool result and return the violations. */
function violationsOf(tool, value) {
  return validateValue(value, tool.output.schema);
}

const INFO_DATA = {
  ready: true,
  screen: { width: 2560, height: 1440 },
  virtualScreen: { x: 0, y: 0, width: 2560, height: 1440 },
  monitors: [{ index: 0, name: '\\\\.\\DISPLAY1', primary: true, x: 0, y: 0, width: 2560, height: 1440, workX: 0, workY: 0, workWidth: 2560, workHeight: 1392, dpi: 96, scale: 1 }],
  cursor: { x: 100, y: 200 },
  dpi: 96,
  scale: 1,
  dpiAware: 'per-monitor-v2',
  foreground: { hwnd: 42, title: '记事本', className: 'Notepad', pid: 1234, processName: 'notepad' },
};

const WINDOWS_DATA = {
  count: 2,
  windows: [
    { hwnd: 42, title: '记事本', className: 'Notepad', pid: 1234, processName: 'notepad', x: 10, y: 20, width: 800, height: 600, visible: true, minimized: false, maximized: false, foreground: true },
    { hwnd: 43, title: '设置', className: 'ApplicationFrameWindow', pid: 999, processName: 'SystemSettings', x: 0, y: 0, width: 2560, height: 1392, visible: true, minimized: false, maximized: true, foreground: false },
  ],
  foreground: { hwnd: 42, title: '记事本', className: 'Notepad', pid: 1234, processName: 'notepad' },
};

test('both tools are well formed and their schemas are inside the strict subset', () => {
  const { tools } = toolsWith(fakeRemote());
  assert.deepEqual(tools.map((tool) => tool.name), REMOTE_DESKTOP_TOOL_NAMES);
  for (const tool of tools) {
    assert.ok(tool.description.length > 200, `${tool.name}: the description has to teach the model when to use it`);
    assert.equal(typeof tool.execute, 'function');
    assert.equal(typeof tool.output.render, 'function');
    assert.equal(typeof tool.presentCall, 'function');
    assert.deepEqual(validateSchemaNode(tool.parameters, `${tool.name}.parameters`), []);
    assert.deepEqual(validateSchemaNode(tool.output.schema, `${tool.name}.output.schema`), []);
    assert.equal(tool.parameters.type, 'object');
    assert.equal(tool.output.schema.type, 'object');
  }
});

test('ssh_desktop_screen: each action returns a schema-valid value', async () => {
  const remote = fakeRemote({
    info: INFO_DATA,
    windows: WINDOWS_DATA,
    screenshot: { width: 1600, height: 900, sourceWidth: 2560, sourceHeight: 1440, scale: 1.6, frame: { x: 0, y: 0, width: 2560, height: 1440 }, captureMethod: 'screen', captureLevel: 2, blank: false, cursor: { x: 1, y: 2 }, foreground: INFO_DATA.foreground, bytes: 2048 },
    ui_dump: {
      hwnd: 42,
      title: '记事本',
      count: 2,
      totalElements: 5,
      shellOnly: false,
      nodes: [
        { name: '编辑', controlType: 'Edit', automationId: 'Editor', className: 'Edit', x: 0, y: 0, width: 100, height: 20, enabled: true, offscreen: false, patterns: ['value'] },
        { name: '确定', controlType: 'Button', automationId: 'Ok', className: 'Button', x: 10, y: 10, width: 60, height: 24, enabled: true, offscreen: false, patterns: ['invoke'] },
      ],
      foreground: INFO_DATA.foreground,
    },
  });
  const { byName } = toolsWith(remote);
  const tool = byName.get('ssh_desktop_screen');

  const info = await tool.execute({ action: 'info', host: 'win-pc' });
  assert.equal(info.ok, true);
  assert.deepEqual(violationsOf(tool, info), []);
  assert.equal(info.info.screen.width, 2560);
  assert.match(tool.output.render({}, info)[0].text, /2560x1440/);

  const windows = await tool.execute({ action: 'windows', host: 'win-pc', filter: '记事本' });
  assert.equal(windows.ok, true);
  assert.deepEqual(violationsOf(tool, windows), []);
  assert.equal(windows.windows.length, 2);
  assert.equal(remote.calls.at(-1).args.filter, '记事本');
  assert.match(tool.output.render({}, windows)[0].text, /记事本/);

  const shot = await tool.execute({ action: 'screenshot', host: 'win-pc', maxWidth: 0 });
  assert.equal(shot.ok, true);
  assert.deepEqual(violationsOf(tool, shot), []);
  assert.equal(shot.shot.path, 'C:\\Temp\\dsh-ssh-remote-desktop\\win-pc\\shot.png');
  assert.match(tool.output.render({}, shot)[0].text, /maxWidth|未缩放|图内像素/);
  assert.equal(remote.calls.at(-1).args.maxWidth, 0);

  const ui = await tool.execute({ action: 'ui_dump', host: 'win-pc', hwnd: 42, maxNodes: 10 });
  assert.equal(ui.ok, true);
  assert.deepEqual(violationsOf(tool, ui), []);
  assert.equal(ui.ui.elements.length, 2);
  assert.equal(ui.ui.elements[1].name, '确定');

  assert.equal(tool.presentCall({ action: 'windows' }).kind, 'read');
});

test('a single-monitor payload (object, not array) is normalized to one monitor', async () => {
  const remote = fakeRemote({ info: { ...INFO_DATA, monitors: INFO_DATA.monitors[0] } });
  const { byName } = toolsWith(remote);
  const tool = byName.get('ssh_desktop_screen');
  const value = await tool.execute({ action: 'info', host: 'win-pc' });
  assert.equal(value.ok, true);
  assert.deepEqual(violationsOf(tool, value), []);
  assert.equal(value.info.monitorCount, 1);
  assert.equal(value.info.monitors[0].name, '\\\\.\\DISPLAY1');
  assert.match(tool.output.render({}, value)[0].text, /显示器：1 块/);
});

test('ssh_desktop_screen screenshot by title resolves the hwnd with one windows call', async () => {
  const remote = fakeRemote({
    windows: WINDOWS_DATA,
    screenshot: { width: 800, height: 600, sourceWidth: 800, sourceHeight: 600, scale: 1, frame: { x: 10, y: 20, width: 800, height: 600 }, captureMethod: 'screen', captureLevel: 2, blank: false, cursor: { x: 1, y: 2 }, foreground: INFO_DATA.foreground, bytes: 10 },
  });
  const { byName } = toolsWith(remote);
  const tool = byName.get('ssh_desktop_screen');
  const value = await tool.execute({ action: 'screenshot', host: 'win-pc', window: '记事本' });
  assert.equal(value.ok, true);
  assert.deepEqual(violationsOf(tool, value), []);
  const calls = remote.calls.map((call) => call.cmd);
  assert.deepEqual(calls, ['windows', 'screenshot']);
  assert.equal(remote.calls[1].args.hwnd, 42, 'the foreground match should win');
});

test('ssh_desktop_screen refuses a missing window and an unknown action', async () => {
  const remote = fakeRemote({ windows: { count: 0, windows: [], foreground: INFO_DATA.foreground }, screenshot: {} });
  const { tools, byName } = toolsWith(remote);
  const tool = byName.get('ssh_desktop_screen');

  const missing = await tool.execute({ action: 'screenshot', host: 'win-pc', window: '不存在' });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'WINDOW_NOT_FOUND');
  assert.deepEqual(violationsOf(tool, missing), []);

  const unknown = await tool.execute({ action: 'dance', host: 'win-pc' });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, 'BAD_ARGUMENT');
  assert.deepEqual(violationsOf(tool, unknown), []);
  assert.match(tool.output.render({}, unknown)[0].text, /dance/);
  assert.equal(tools.length, 2);
});

test('ssh_desktop_action: each action returns a schema-valid value', async () => {
  const remote = fakeRemote({
    focus: { hwnd: 42, title: '记事本', focused: true, method: 'setforeground', state: 'restore', attempts: [{ method: 'setforeground', ok: true, reason: '' }] },
    move: { cursor: { x: 400, y: 300 }, foreground: INFO_DATA.foreground },
    click: { planned: 'uia', attempts: [{ method: 'uia', ok: true, reason: '' }], point: { x: 400, y: 300 }, window: { hwnd: 42, rootHwnd: 42, title: '记事本', className: 'Notepad' }, coveredBy: { hwnd: 0, title: '', className: '' }, foreground: INFO_DATA.foreground },
    drag: { from: { x: 1, y: 2 }, to: { x: 3, y: 4 }, button: 'left', restoredCursor: true, cursor: { x: 5, y: 6 }, foreground: INFO_DATA.foreground },
    scroll: { clicks: 3, horizontal: false, restoredCursor: false, cursor: { x: 1, y: 1 }, foreground: INFO_DATA.foreground },
    down: { cursor: { x: 1, y: 1 } },
    up: { cursor: { x: 1, y: 1 } },
    key: { keySequence: ['Ctrl', 'C'], times: 1, foreground: INFO_DATA.foreground },
    text: { characters: 4, foreground: INFO_DATA.foreground },
    sequence: { hwnd: 42, title: '记事本', focused: true, focusMethod: 'setforeground', state: 'restore', steps: [{ index: 1, action: 'click', ok: true, skipped: false, reason: 'left@10,20 x1' }], stepCount: 1, failedSteps: 0, aborted: '', cursor: { x: 10, y: 20 }, foreground: INFO_DATA.foreground },
    ui_invoke: { hwnd: 42, title: '记事本', action: 'invoke', applied: true, matched: 1, index: 0, element: { name: '确定', controlType: 'Button', automationId: 'Ok', className: 'Button', x: 0, y: 0, width: 10, height: 10, enabled: true, offscreen: false, patterns: [] }, cursor: { x: 1, y: 2 }, foreground: INFO_DATA.foreground },
    ui_set_value: { hwnd: 42, title: '记事本', applied: true, value: 'hello', matched: 1, index: 0, element: { name: '编辑', controlType: 'Edit', automationId: 'Editor', className: 'Edit', x: 0, y: 0, width: 10, height: 10, enabled: true, offscreen: false, patterns: ['value'] }, cursor: { x: 1, y: 2 }, foreground: INFO_DATA.foreground },
  });
  const { byName } = toolsWith(remote);
  const tool = byName.get('ssh_desktop_action');

  const cases = [
    [{ action: 'focus', host: 'win-pc', hwnd: 42, state: 'restore' }, 'focus'],
    [{ action: 'move', host: 'win-pc', x: 400, y: 300 }, 'move'],
    [{ action: 'click', host: 'win-pc', x: 400, y: 300 }, 'click'],
    [{ action: 'drag', host: 'win-pc', fromX: 1, fromY: 2, toX: 3, toY: 4 }, 'drag'],
    [{ action: 'scroll', host: 'win-pc', clicks: 3 }, 'scroll'],
    [{ action: 'down', host: 'win-pc' }, 'down'],
    [{ action: 'up', host: 'win-pc' }, 'up'],
    [{ action: 'key', host: 'win-pc', combo: 'Ctrl+C' }, 'key'],
    [{ action: 'text', host: 'win-pc', text: 'hello' }, 'text'],
    [{ action: 'sequence', host: 'win-pc', window: '记事本', steps: [{ action: 'click', x: 10, y: 20 }] }, 'sequence'],
    [{ action: 'ui_invoke', host: 'win-pc', hwnd: 42, name: '确定' }, 'ui_invoke'],
    [{ action: 'ui_set_value', host: 'win-pc', hwnd: 42, name: '编辑', value: 'hello' }, 'ui_set_value'],
  ];
  for (const [args, expected] of cases) {
    const value = await tool.execute(args);
    assert.equal(value.ok, true, `${expected}: ${value.message}`);
    assert.equal(value.action, expected);
    assert.deepEqual(violationsOf(tool, value), [], `${expected}: ${JSON.stringify(violationsOf(tool, value))}`);
    const rendered = tool.output.render(args, value)[0].text;
    assert.ok(rendered.length > 0);
  }
  assert.equal(tool.presentCall({ action: 'click' }).kind, 'execute');

  // A partially failed sequence is reported as not-ok but keeps the full shape.
  remote.call = async () => ({ ready: {}, data: { hwnd: 42, title: 'x', focused: true, focusMethod: 'already', state: '', steps: [{ index: 1, action: 'click', ok: false, skipped: false, reason: 'boom' }], stepCount: 1, failedSteps: 1, aborted: '第 1 步失败：boom', cursor: { x: 0, y: 0 }, foreground: INFO_DATA.foreground } });
  const partial = await tool.execute({ action: 'sequence', host: 'win-pc', steps: [{ action: 'click', x: 1, y: 1 }] });
  assert.equal(partial.ok, false);
  assert.equal(partial.code, 'SEQUENCE_PARTIAL');
  assert.deepEqual(violationsOf(tool, partial), []);
});

test('ssh_desktop_action: remote errors surface with code and diagnostic detail', async () => {
  const remote = fakeRemote({
    click: new RemoteDesktopError('NOT_WINDOWS', '目标是 POSIX 系统', 'command=click\nexit=1'),
    focus: new RemoteDesktopError('WINDOW_NOT_FOUND', '找不到窗口'),
  });
  const { byName } = toolsWith(remote);
  const tool = byName.get('ssh_desktop_action');

  const value = await tool.execute({ action: 'click', host: 'win-pc', x: 1, y: 1 });
  assert.equal(value.ok, false);
  assert.equal(value.code, 'NOT_WINDOWS');
  assert.match(value.message, /命令|诊断/);
  assert.match(value.message, /command=click/);
  assert.deepEqual(violationsOf(tool, value), []);

  const missing = await tool.execute({ action: 'focus', host: 'win-pc', window: 'x' });
  assert.equal(missing.code, 'WINDOW_NOT_FOUND');

  const bad = await tool.execute({ action: 'text', host: 'win-pc', text: '' });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'BAD_ARGUMENT');

  const blocked = await tool.execute({ action: 'click', host: 'win-pc' });
  assert.equal(blocked.ok, false);
});

test('ssh_desktop_action validates its own arguments before touching the remote', async () => {
  const remote = fakeRemote({});
  const { byName } = toolsWith(remote);
  const tool = byName.get('ssh_desktop_action');

  const noSteps = await tool.execute({ action: 'sequence', host: 'win-pc', steps: [] });
  assert.equal(noSteps.ok, false);
  assert.equal(noSteps.code, 'BAD_ARGUMENT');
  assert.equal(remote.calls.length, 0);

  const noValue = await tool.execute({ action: 'ui_set_value', host: 'win-pc', hwnd: 42 });
  assert.equal(noValue.code, 'BAD_ARGUMENT');
  assert.equal(remote.calls.length, 0);

  const noWindow = await tool.execute({ action: 'ui_invoke', host: 'win-pc' });
  assert.equal(noWindow.code, 'BAD_ARGUMENT');
  assert.equal(remote.calls.length, 0);
});

// ─────────────────────────── gate + prerequisite ─────────────────────────────

/**
 * Mount `apply()` with a mock context.
 *
 * @param {{
 *   config?: object,
 *   dshHome: string,
 *   desktopRegisteredRef: { value: boolean },
 *   skillVisibleRef: { value: boolean },
 * }} options - harness state.
 * @returns {{ registrations: any[], skills: any[], emit: Function, agents: Map<string, any> }} the harness.
 */
function mountApply(options) {
  const registrations = [];
  const handlers = new Map();
  const skills = [];
  const agents = new Map();
  const tools = {
    register(tool, registrationOptions = {}) {
      const entry = { tool, options: registrationOptions };
      registrations.push(entry);
      return () => {
        const index = registrations.indexOf(entry);
        if (index >= 0) registrations.splice(index, 1);
      };
    },
    get(name) {
      if (name === 'skill') return options.skillVisibleRef.value ? { name: 'skill' } : undefined;
      if (options.desktopRegisteredRef.value === true) return { name };
      return undefined;
    },
  };
  const base = {
    logger: { info: () => undefined, warn: () => undefined, debug: () => undefined },
    tools,
    effect(callback) {
      const cleanup = callback();
      return () => {
        if (typeof cleanup === 'function') cleanup();
      };
    },
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
      return () => undefined;
    },
    get(name) {
      if (name === 'agents') return { get: (id) => agents.get(id) };
      return undefined;
    },
    inject(names, callback) {
      const available = new Set(['skills', 'settings']);
      if (!names.every((name) => available.has(name))) return;
      const scoped = {
        ...base,
        skills: {
          register(definition) {
            skills.push(definition);
            return () => undefined;
          },
        },
        settings: { configure: () => () => undefined },
      };
      callback(scoped);
    },
  };
  const { apply } = pluginModule;
  apply(base, options.config);
  return {
    registrations,
    skills,
    agents,
    emit(event, ...args) {
      for (const handler of handlers.get(event) ?? []) handler(...args);
    },
  };
}

/** The plugin entry, imported after this file's own imports are evaluated. */
const pluginModule = await import('../index.js');

test('two on-demand groups: loading one skill must not reveal the other', async () => {
  const dshHome = tempDir('dsh-ssh-gate-');
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = dshHome;
  try {
    installFakeDesktopControl(writeProfile(path.join(dshHome, 'profiles', 'desktop')));
    const desktopRegisteredRef = { value: true };
    const skillVisibleRef = { value: true };
    const harness = mountApply({ dshHome, desktopRegisteredRef, skillVisibleRef, config: {} });

    const names = harness.registrations.map((entry) => entry.tool.name).sort();
    assert.deepEqual(names, [...[
      'ssh_host', 'ssh_exec', 'ssh_upload', 'ssh_download', 'ssh_fetch', 'ssh_job',
      'ssh_desktop_screen', 'ssh_desktop_action',
    ]].sort());

    const remoteNames = ['ssh_desktop_screen', 'ssh_desktop_action'];
    const remoteEntries = harness.registrations.filter((entry) => remoteNames.includes(entry.tool.name));
    assert.equal(remoteEntries.length, 2);
    for (const entry of remoteEntries) assert.equal(typeof entry.options.when, 'function');

    /** A gate is identified by its own evaluation, not by which entry holds it. */
    const sshEntry = harness.registrations.find((entry) => entry.tool.name === 'ssh_host');
    const sshGate = sshEntry.options.when;
    const remoteGate = remoteEntries[0].options.when;

    const agent = { session: { id: 's1', requestHeader: () => ({ tools: [] }) } };
    assert.equal(sshGate({ agent }), false, 'ssh tools hide before their skill is loaded');
    assert.equal(remoteGate({ agent }), false, 'remote tools hide before their skill is loaded');

    harness.emit('tools/result', { name: 'skill', agent, arguments: { name: 'ssh-remote' } }, { isError: false });
    assert.equal(sshGate({ agent }), true, 'loading ssh-remote enables the ssh group');
    assert.equal(remoteGate({ agent }), false, 'loading ssh-remote must NOT enable the remote group');

    harness.emit('tools/result', { name: 'skill', agent, arguments: { name: REMOTE_DESKTOP_SKILL_NAME } }, { isError: false });
    assert.equal(remoteGate({ agent }), true);
    assert.equal(sshGate({ agent }), true);

    // Disabling the prerequisite hides the remote group on the next step.
    desktopRegisteredRef.value = false;
    assert.equal(remoteGate({ agent }), false, 'a disabled dsh-desktop-control must hide the remote tools');
    assert.equal(sshGate({ agent }), true, 'the ssh group is unaffected');
    desktopRegisteredRef.value = true;

    const skills = harness.skills.map((definition) => definition.name).sort();
    assert.deepEqual(skills, ['ssh-remote', 'ssh-remote-desktop']);
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    fs.rmSync(dshHome, { recursive: true, force: true });
  }
});

test('remoteDesktop:false registers neither the remote tools nor the skill', async () => {
  const dshHome = tempDir('dsh-ssh-gate-');
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = dshHome;
  try {
    installFakeDesktopControl(writeProfile(path.join(dshHome, 'profiles', 'desktop')));
    const harness = mountApply({
      dshHome,
      desktopRegisteredRef: { value: true },
      skillVisibleRef: { value: true },
      config: { remoteDesktop: false },
    });
    const names = harness.registrations.map((entry) => entry.tool.name);
    assert.equal(names.length, 6, `expected the six ssh tools, got ${names.join(',')}`);
    assert.equal(harness.skills.length, 1);
    assert.equal(harness.skills[0].name, 'ssh-remote');
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    fs.rmSync(dshHome, { recursive: true, force: true });
  }
});

test('without an installed dsh-desktop-control the component stays inactive without failing the plugin', async () => {
  const dshHome = tempDir('dsh-ssh-gate-');
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = dshHome;
  try {
    writeProfile(path.join(dshHome, 'profiles', 'desktop'), ['dsh-ssh']);
    const harness = mountApply({
      dshHome,
      desktopRegisteredRef: { value: false },
      skillVisibleRef: { value: true },
      config: {},
    });
    assert.equal(harness.registrations.length, 6);
    assert.equal(harness.skills.length, 1);
    // The ssh group still works.
    const sshEntry = harness.registrations.find((entry) => entry.tool.name === 'ssh_host');
    assert.equal(typeof sshEntry.options.when, 'function');
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    fs.rmSync(dshHome, { recursive: true, force: true });
  }
});

test('Config declares the remote desktop knobs with the documented defaults', () => {
  const { Config, readOption } = pluginModule;
  const config = Config({});
  assert.equal(readOption(config, 'remoteDesktop', false), true);
  assert.equal(readOption(config, 'remoteDesktopControlDir', 'x'), '');
  assert.equal(readOption(config, 'remoteDesktopTimeoutMs', 0), 60000);
  assert.equal(readOption(config, 'remoteDesktopScreenshotMaxWidth', 0), 1600);
  assert.equal(readOption(config, 'remoteDesktopIndicator', true), false);
  assert.equal(readOption(config, 'remoteDesktop', false), true);
});

test('the remote desktop skill body is small enough and states the on-demand contract', () => {
  const definition = REMOTE_DESKTOP_SKILL_DEFINITION;
  assert.equal(definition.name, 'ssh-remote-desktop');
  assert.equal(definition.source, 'runtime');
  assert.equal(definition.invocation.modelInvocable, true);
  assert.equal(definition.invocation.userInvocable, true);
  assert.match(definition.content, /加载本技能后从下一步出现/);
  assert.match(definition.content, /dsh-desktop-control/);
  assert.match(definition.content, /物理像素/);
  assert.match(definition.content, /sequence/);
  assert.ok(definition.content.length < 8192, `skill body is ${definition.content.length} chars; over 8192 gets pruned`);
});
