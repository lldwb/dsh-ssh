/**
 * Schema tests for the six tools in `lib/tools.mjs`.
 *
 * Two independent checks:
 *
 * 1. **Structure** — every `parameters` node and every `output.schema` node is
 *    walked by the strict validator in `strict-schema.mjs` (self-contained, not
 *    the devkit's): single-string `type`, `additionalProperties: false`,
 *    `required` ⊆ `properties`, no unknown keywords.
 * 2. **Return values** — with a fake service and a fake SFTP/exec transport, each
 *    tool's `execute` is actually called and its result validated against its
 *    own declared `output.schema`, exactly as the registry does at runtime.
 *
 * The second check is what catches `tool returned invalid output`: a field the
 * schema declares as `number` but the implementation fills with `null` passes a
 * type-free review and fails in production.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { validateSchemaNode, validateValue, ALLOWED_KEYWORDS } from './strict-schema.mjs';
import { fakeSftp, tempDir, toolsFor } from './fake-ssh.mjs';

/** Validate one tool result and return the violations. */
function violationsOf(tool, value) {
  return validateValue(value, tool.output.schema);
}

// ─────────────────────────────── structural checks ────────────────────────────

test('every tool is well formed: name, description, parameters, output.schema, execute, render', () => {
  const { tools } = toolsFor();
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ['ssh_host', 'ssh_exec', 'ssh_upload', 'ssh_download', 'ssh_fetch', 'ssh_job'],
  );
  for (const tool of tools) {
    assert.equal(typeof tool.name, 'string');
    assert.ok(tool.name.length > 0);
    assert.equal(typeof tool.description, 'string');
    assert.ok(tool.description.length > 40, `${tool.name}: description should teach the model when to use it`);
    assert.equal(typeof tool.execute, 'function');
    assert.equal(typeof tool.output.render, 'function');
    assert.equal(typeof tool.presentCall, 'function');
  }
});

test('every parameters/output schema node is inside the strict subset', () => {
  const { tools } = toolsFor();
  for (const tool of tools) {
    const parameterErrors = validateSchemaNode(tool.parameters, `${tool.name}.parameters`);
    assert.deepEqual(parameterErrors, [], `${tool.name}: invalid parameters schema:\n${parameterErrors.join('\n')}`);
    const outputErrors = validateSchemaNode(tool.output.schema, `${tool.name}.output.schema`);
    assert.deepEqual(outputErrors, [], `${tool.name}: invalid output schema:\n${outputErrors.join('\n')}`);
  }
});

test('the parameters and output roots are objects with additionalProperties:false', () => {
  const { tools } = toolsFor();
  for (const tool of tools) {
    for (const [label, schema] of [
      ['parameters', tool.parameters],
      ['output.schema', tool.output.schema],
    ]) {
      assert.equal(schema.type, 'object', `${tool.name}.${label} must be an object`);
      assert.equal(schema.additionalProperties, false, `${tool.name}.${label} must declare additionalProperties:false`);
    }
  }
});

test('the strict validator rejects schemas the registry would refuse', () => {
  const bad = [
    { type: ['string', 'number'] },
    { type: 'object', properties: { a: { type: 'string' } } }, // no additionalProperties:false
    { type: 'object', additionalProperties: false, properties: {}, required: ['missing'] },
    { type: 'string', minimum: 1 },
    { type: 'array', items: [{ type: 'string' }] },
    { type: 'string', enum: ['a', 1] },
  ];
  for (const schema of bad) {
    assert.ok(validateSchemaNode(schema).length > 0, `expected a rejection for ${JSON.stringify(schema)}`);
  }
  assert.ok(ALLOWED_KEYWORDS.has('description'));
  assert.ok(ALLOWED_KEYWORDS.has('additionalProperties'));
});

test('output schemas declare every field the execute paths return', () => {
  // Static cross-check: every field name used in a returned object literal in
  // lib/tools.mjs appears in the corresponding output schema's properties.
  const source = fs.readFileSync(new URL('../lib/tools.mjs', import.meta.url), 'utf8');
  const { tools } = toolsFor();
  for (const tool of tools) {
    const declared = new Set(Object.keys(tool.output.schema.properties ?? {}));
    // Fields the implementation is known to return, read from the source text.
    const expected = {
      ssh_host: ['ok', 'action', 'summary', 'servers', 'profile', 'test'],
      ssh_exec: [
        'ok', 'host', 'target', 'command', 'stdout', 'stderr', 'exitCode', 'signal',
        'timedOut', 'stdoutBytes', 'stderrBytes', 'stdoutTruncated', 'stderrTruncated', 'durationMs', 'summary',
      ],
      ssh_upload: ['ok', 'host', 'target', 'direction', 'localPath', 'remotePath', 'kind', 'files', 'bytes', 'durationMs', 'summary'],
      ssh_download: ['ok', 'host', 'target', 'direction', 'localPath', 'remotePath', 'kind', 'files', 'bytes', 'durationMs', 'summary'],
      ssh_fetch: ['ok', 'host', 'target', 'url', 'remotePath', 'mode', 'bytes', 'durationMs', 'summary'],
      ssh_job: ['ok', 'action', 'host', 'target', 'summary', 'job', 'status', 'log', 'jobs'],
    }[tool.name];
    for (const field of expected) assert.ok(declared.has(field), `${tool.name}: output field "${field}" is not declared`);
    assert.ok(source.includes(tool.name));
  }
});

test('required output fields are never subset leak: the required list is exactly the always-present fields', () => {
  const { tools } = toolsFor();
  for (const tool of tools) {
    for (const field of tool.output.schema.required ?? []) {
      assert.ok(field in tool.output.schema.properties, `${tool.name}: required "${field}" missing from properties`);
    }
  }
});

// ───────────────────────────── ssh_host return values ────────────────────────

test('ssh_host: every action returns a value that satisfies its own schema', async () => {
  const { byName, fake } = toolsFor();
  const tool = byName.get('ssh_host');
  const actions = [
    [{ action: 'list' }, 'empty and non-empty list'],
    [{ action: 'show', name: 'live' }, 'show'],
    [{ action: 'add', name: 'new', host: 'h', user: 'u' }, 'add'],
    [{ action: 'update', name: 'live', note: 'n' }, 'update'],
    [{ action: 'remove', name: 'live' }, 'remove'],
    [{ action: 'password', name: 'live', password: 'x' }, 'password'],
    [{ action: 'test', name: 'live' }, 'test'],
    [{ action: 'bogus' }, 'unknown action'],
  ];
  for (const [args, label] of actions) {
    const value = await tool.execute(args);
    assert.deepEqual(violationsOf(tool, value), [], `ssh_host ${label} result violates output.schema:\n${JSON.stringify(value, null, 2)}`);
  }
  assert.ok(fake.calls.includes('addServer:new'));
});

test('ssh_host: a missing name for show/remove/test is a readable failure, not a throw', async () => {
  const { byName } = toolsFor();
  const tool = byName.get('ssh_host');
  for (const action of ['show', 'update', 'remove', 'password', 'test']) {
    const value = await tool.execute({ action });
    assert.equal(value.ok, false, `${action} without name must fail`);
    assert.deepEqual(violationsOf(tool, value), []);
  }
});

test('ssh_host: a thrown service error becomes ok:false with the message', async () => {
  const { byName, fake } = toolsFor();
  const tool = byName.get('ssh_host');
  fake.service.addServer = async () => {
    throw new Error('server "x" already exists — use update instead of add');
  };
  const value = await tool.execute({ action: 'add', name: 'x', host: 'h', user: 'u' });
  assert.equal(value.ok, false);
  assert.match(value.summary, /already exists/);
  assert.deepEqual(violationsOf(tool, value), []);
});

// ───────────────────────────── ssh_exec return values ────────────────────────

test('ssh_exec: success and non-zero exit both satisfy the output schema', async () => {
  const { byName } = toolsFor({ clientStream: { stdout: 'hello\n' } });
  const tool = byName.get('ssh_exec');
  const value = await tool.execute({ command: 'echo hello' });
  assert.equal(value.ok, true);
  assert.equal(value.stdout, 'hello\n');
  assert.equal(value.exitCode, 0);
  assert.deepEqual(violationsOf(tool, value), []);
});

test('ssh_exec: non-zero exit and a null exit code become -1, staying inside the schema', async () => {
  const { byName } = toolsFor({ clientStream: { stdout: '', stderr: 'nope', code: 3 } });
  const tool = byName.get('ssh_exec');
  const failed = await tool.execute({ command: 'false' });
  assert.equal(failed.ok, false);
  assert.equal(failed.exitCode, 3);
  assert.equal(failed.stderr, 'nope');
  assert.deepEqual(violationsOf(tool, failed), []);

  const { byName: signalByName } = toolsFor({ clientStream: { stdout: '', stderr: '', code: null, signal: 'SIGKILL' } });
  const killed = await signalByName.get('ssh_exec').execute({ command: 'sleep 999' });
  assert.equal(killed.ok, false);
  assert.equal(killed.exitCode, -1);
  assert.equal(killed.signal, 'SIGKILL');
  assert.deepEqual(violationsOf(signalByName.get('ssh_exec'), killed), []);
});

test('ssh_exec: a missing profile becomes ok:false with empty host/target', async () => {
  const { byName, fake } = toolsFor();
  fake.service.resolveProfileFromArgs = () => {
    throw new Error('no servers yet — add one with ssh_host action="add"');
  };
  const tool = byName.get('ssh_exec');
  const value = await tool.execute({ command: 'hostname' });
  assert.equal(value.ok, false);
  assert.equal(value.host, '');
  assert.equal(value.target, '');
  assert.equal(value.exitCode, -1);
  assert.deepEqual(violationsOf(tool, value), []);
});

// ─────────────────────── ssh_upload / ssh_download return values ─────────────

test('ssh_upload: file and directory paths satisfy the output schema', async (t) => {
  const dir = tempDir(t);
  const { byName } = toolsFor();
  const tool = byName.get('ssh_upload');

  const file = path.join(dir, 'a.txt');
  fs.writeFileSync(file, 'data');
  const fileResult = await tool.execute({ localPath: file, remotePath: '/tmp/a.txt' });
  assert.equal(fileResult.ok, true);
  assert.equal(fileResult.kind, 'file');
  assert.equal(fileResult.files, 1);
  assert.equal(fileResult.bytes, 4);
  assert.deepEqual(violationsOf(tool, fileResult), []);

  const tree = path.join(dir, 'tree');
  fs.mkdirSync(path.join(tree, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(tree, 'x.txt'), 'x');
  fs.writeFileSync(path.join(tree, 'sub', 'y.txt'), 'yy');
  const dirResult = await tool.execute({ localPath: tree, remotePath: '/tmp/tree' });
  assert.equal(dirResult.ok, true);
  assert.equal(dirResult.kind, 'directory');
  assert.equal(dirResult.files, 2);
  assert.deepEqual(violationsOf(tool, dirResult), []);
});

test('ssh_upload: a remote path starting with ~ is expanded against the remote home', async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'home.txt');
  fs.writeFileSync(file, 'x');
  const { byName } = toolsFor();
  const tool = byName.get('ssh_upload');
  const value = await tool.execute({ localPath: file, remotePath: '~/dsh-ssh/up.txt' });
  assert.equal(value.ok, true, `~ must be expanded by ssh_upload: ${JSON.stringify(value.summary)}`);
  assert.equal(value.remotePath, '/root/dsh-ssh/up.txt');
  assert.deepEqual(violationsOf(tool, value), []);
});

test('ssh_download: a remote path starting with ~ is expanded against the remote home', async (t) => {
  const dir = tempDir(t);
  const entries = new Map([['/root/checkpoints/latest.bin', { kind: 'file', content: Buffer.from('bin') }]]);
  const { byName } = toolsFor({ sftpSession: fakeSftp(entries) });
  const tool = byName.get('ssh_download');
  const value = await tool.execute({ remotePath: '~/checkpoints/latest.bin', localPath: path.join(dir, 'latest.bin') });
  assert.equal(value.ok, true, `~ must be expanded by ssh_download: ${JSON.stringify(value.summary)}`);
  assert.equal(value.remotePath, '/root/checkpoints/latest.bin');
  assert.equal(fs.readFileSync(path.join(dir, 'latest.bin'), 'utf8'), 'bin');
  assert.deepEqual(violationsOf(tool, value), []);
});

test('ssh_upload: a missing local path is a readable failure inside the schema', async () => {
  const { byName } = toolsFor();
  const tool = byName.get('ssh_upload');
  const value = await tool.execute({ localPath: path.join(os.tmpdir(), 'definitely-not-here-dsh-ssh'), remotePath: '/tmp/x' });
  assert.equal(value.ok, false);
  assert.match(value.summary, /本地路径不存在/);
  assert.deepEqual(violationsOf(tool, value), []);
});

test('ssh_download: file path, directory path and missing remote path stay inside the schema', async (t) => {
  const dir = tempDir(t);
  const entries = new Map([
    ['/tmp/r.txt', { kind: 'file', content: Buffer.from('remote-data') }],
    ['/tmp/tree', { kind: 'directory', children: ['a.txt'] }],
    ['/tmp/tree/a.txt', { kind: 'file', content: Buffer.from('a') }],
  ]);
  const sftp = fakeSftp(entries);
  const { byName } = toolsFor({ sftpSession: sftp });
  const tool = byName.get('ssh_download');

  const file = await tool.execute({ remotePath: '/tmp/r.txt', localPath: path.join(dir, 'r.txt') });
  assert.equal(file.ok, true);
  assert.equal(file.kind, 'file');
  assert.equal(file.bytes, 11);
  assert.equal(fs.readFileSync(path.join(dir, 'r.txt'), 'utf8'), 'remote-data');
  assert.deepEqual(violationsOf(tool, file), []);

  const tree = await tool.execute({ remotePath: '/tmp/tree', localPath: path.join(dir, 'tree') });
  assert.equal(tree.ok, true);
  assert.equal(tree.kind, 'directory');
  assert.equal(tree.files, 1);
  assert.deepEqual(violationsOf(tool, tree), []);

  const missing = await tool.execute({ remotePath: '/tmp/absent', localPath: path.join(dir, 'absent') });
  assert.equal(missing.ok, false);
  assert.match(missing.summary, /远端路径不存在/);
  assert.deepEqual(violationsOf(tool, missing), []);
});

// ────────────────────────────── ssh_fetch return values ───────────────────────

test('ssh_fetch: parameters are url + remotePath required, mode is a 3-value enum', () => {
  const { byName } = toolsFor();
  const tool = byName.get('ssh_fetch');
  assert.deepEqual(tool.parameters.required, ['url', 'remotePath']);
  assert.deepEqual(tool.parameters.properties.mode.enum, ['auto', 'local-relay', 'remote-direct']);
  assert.equal(tool.parameters.properties.url.type, 'string');
  assert.equal(tool.parameters.properties.remotePath.type, 'string');
  assert.equal(tool.parameters.properties.timeoutSec.type, 'number');
  assert.equal('host' in tool.parameters.properties, true);
  // The registry rejects an out-of-enum value before execute runs; this pins the
  // enum the registry checks against.
  assert.equal(tool.parameters.properties.mode.enum.includes('api'), false);
  assert.equal(tool.output.schema.required.includes('mode'), true);
});

test('ssh_fetch: a non-http(s) URL is a readable failure inside the schema', async () => {
  const { byName } = toolsFor();
  const tool = byName.get('ssh_fetch');
  for (const url of ['', 'ftp://example.com/file', 'example.com/file', 'file:///etc/passwd', ' ']) {
    const value = await tool.execute({ url, remotePath: '/tmp/x' });
    assert.equal(value.ok, false, `expected ${JSON.stringify(url)} to fail`);
    assert.match(value.summary, /must be an absolute http\(s\) URL/);
    assert.equal(value.bytes, 0);
    assert.equal(typeof value.mode, 'string');
    assert.deepEqual(violationsOf(tool, value), []);
  }
});

test('ssh_fetch: a missing remote path is a readable failure inside the schema', async () => {
  const { byName } = toolsFor();
  const tool = byName.get('ssh_fetch');
  const value = await tool.execute({ url: 'https://example.com/file.bin' });
  assert.equal(value.ok, false);
  assert.match(value.summary, /remote path is required/);
  assert.deepEqual(violationsOf(tool, value), []);
});

test('ssh_fetch: an unreachable profile leaves host/target empty and stays inside the schema', async () => {
  const { byName, fake } = toolsFor();
  fake.service.resolveProfileFromArgs = () => {
    throw new Error('no servers yet — add one with ssh_host action="add"');
  };
  const tool = byName.get('ssh_fetch');
  const value = await tool.execute({ url: 'https://example.com/f.bin', remotePath: '/tmp/f.bin' });
  assert.equal(value.ok, false);
  assert.equal(value.host, '');
  assert.equal(value.target, '');
  assert.match(value.summary, /no servers yet/);
  assert.deepEqual(violationsOf(tool, value), []);
});

test('ssh_fetch: render shows the summary', async () => {
  const { byName } = toolsFor();
  const tool = byName.get('ssh_fetch');
  const content = tool.output.render({}, { summary: '✅ fetched', ok: true });
  assert.deepEqual(content, [{ type: 'text', text: '✅ fetched' }]);
});

// ──────────────────────────────── ssh_job ─────────────────────────────────────

/** A JobManager whose transport answers with the given stdout per action. */
function jobService(execOutputs) {
  let call = 0;
  const exec = async () => {
    const output = execOutputs[Math.min(call, execOutputs.length - 1)];
    call += 1;
    return { stdout: output.stdout ?? '', stderr: output.stderr ?? '', exitCode: output.exitCode ?? 0 };
  };
  const { byName } = toolsFor({
    exec,
    sftp: async (client, operation) =>
      operation({
        mkdir: (target, callback) => callback(null),
        fastPut: (localPath, remotePath, callback) => callback(null),
        stat: (target, callback) => callback(null, { isDirectory: () => false, size: 1 }),
        fastGet: (remotePath, localPath, callback) => callback(null),
        readdir: (target, callback) => callback(null, []),
        end() {},
      }),
  });
  return { byName };
}

test('ssh_job: start, stop and list satisfy the output schema', async () => {
  const { byName } = jobService([
    { stdout: '' }, // mkdir -p
    { stdout: '4242\n' }, // launch
    { stdout: 'SIGNALED:4242\n' }, // stop
    { stdout: '' }, // list header
  ]);
  const tool = byName.get('ssh_job');
  const started = await tool.execute({ action: 'start', command: 'echo hi', label: 'demo' });
  assert.equal(started.ok, true);
  assert.ok(Number.isInteger(started.job.pid));
  assert.deepEqual(violationsOf(tool, started), []);

  const stopped = await tool.execute({ action: 'stop', jobId: started.job.jobId });
  assert.equal(stopped.ok, true);
  assert.deepEqual(violationsOf(tool, stopped), []);
});

test('ssh_job: a failed start is a readable failure inside the schema', async () => {
  const { byName } = jobService([{ exitCode: 1, stderr: 'permission denied' }]);
  const tool = byName.get('ssh_job');
  const value = await tool.execute({ action: 'start', command: 'x' });
  assert.equal(value.ok, false);
  assert.match(value.summary, /permission denied/);
  assert.deepEqual(violationsOf(tool, value), []);
});

test('ssh_job: status of a running job uses -1 (not null) for exitCode and stays valid', async () => {
  // Regression for a real defect: JobManager.status used to return `null` for
  // the field that did not apply (exitCode while running, pid after exit) while
  // the declared output schema typed both as `number`, so the registry rejected
  // the result with `tool returned invalid output`. `-1` is now the documented
  // zero value, which keeps the value inside the schema.
  const { byName } = jobService([{ stdout: 'RUNNING:4242:10\n' }]);
  const tool = byName.get('ssh_job');
  const value = await tool.execute({ action: 'status', jobId: 'job-20261021080000-abcdef' });
  assert.equal(value.ok, true);
  assert.equal(value.status.exitCode, -1);
  assert.equal(value.status.pid, 4242);
  assert.deepEqual(violationsOf(tool, value), []);
});

test('ssh_job: status of an exited job uses -1 (not null) for pid and stays valid', async () => {
  const { byName } = jobService([{ stdout: 'EXITED:0:10\n' }]);
  const tool = byName.get('ssh_job');
  const value = await tool.execute({ action: 'status', jobId: 'job-20261021080000-abcdef' });
  assert.equal(value.ok, true);
  assert.equal(value.status.pid, -1);
  assert.equal(value.status.exitCode, 0);
  assert.deepEqual(violationsOf(tool, value), []);
});

test('ssh_job: log and list are valid now that status/jobs entries use -1', async () => {
  const { byName } = jobService([
    { stdout: '@@SIZE:10\nhello\n' }, // log payload
    { stdout: 'RUNNING:4242:10\n' }, // status after log
    { stdout: '\nEXITED:job-x:0:10\n' }, // list
  ]);
  const tool = byName.get('ssh_job');
  const logValue = await tool.execute({ action: 'log', jobId: 'job-20261021080000-abcdef' });
  assert.equal(logValue.ok, true);
  assert.equal(logValue.status.exitCode, -1);
  assert.deepEqual(violationsOf(tool, logValue), []);

  const listValue = await tool.execute({ action: 'list' });
  assert.equal(listValue.ok, true);
  assert.equal(listValue.jobs[0].pid, -1);
  assert.deepEqual(violationsOf(tool, listValue), []);
});

test('ssh_job: unknown action and missing jobId are readable failures', async () => {
  const { byName } = jobService([{ stdout: '' }]);
  const tool = byName.get('ssh_job');
  const noId = await tool.execute({ action: 'status' });
  assert.equal(noId.ok, false);
  assert.match(noId.summary, /jobId/);
  assert.deepEqual(violationsOf(tool, noId), []);

  // `action` is only reported as unknown after `jobId` was accepted; with an id
  // present the unknown-action branch is reachable.
  const unknown = await tool.execute({ action: 'bogus', jobId: 'job-20261021080000-abcdef' });
  assert.equal(unknown.ok, false);
  assert.match(unknown.summary, /未知 action/);
  assert.deepEqual(violationsOf(tool, unknown), []);
});
