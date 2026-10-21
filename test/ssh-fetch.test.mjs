/**
 * Behaviour tests for `ssh_fetch` (the sixth tool).
 *
 * The local half of `local-relay` is exercised by replacing `globalThis.fetch`
 * with a fake that returns a genuine web `ReadableStream` — the same shape the
 * real `fetch` returns, and the shape `Readable.fromWeb()` in the download helper
 * requires. The replacement is restored after every test, so the rest of the
 * suite keeps the real fetch.
 *
 * The remote half is exercised against the scripted `exec` transport from
 * `fake-ssh.mjs`: probe → `curl`/`wget`/`none`, then the download command.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';

import { errorResponse, fakeGlobalFetch, fakeSftp, okResponse, toolsFor } from './fake-ssh.mjs';

const URL_BASE = 'https://files.example.com/data.bin';
const BODY = 'streamed-bytes-中文-123';

/** Temp directories the helper may have created. */
function fetchTempDirs() {
  return fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('dsh-ssh-fetch-'));
}

/** A fake `exec` script: answers the tool probe and the download command. */
function scriptedClientStream(script) {
  const commands = [];
  const stream = (command) => {
    commands.push(command);
    return script(command);
  };
  return { commands, stream };
}

// ───────────────────────────────── enum ───────────────────────────────────────

test('ssh_fetch: mode is a three-value enum and "api" is not one of them', () => {
  const { byName } = toolsFor();
  const mode = byName.get('ssh_fetch').parameters.properties.mode;
  assert.deepEqual(mode.enum, ['auto', 'local-relay', 'remote-direct']);
  assert.equal(mode.enum.includes('api'), false);
  assert.equal(mode.type, 'string');
});

test('ssh_fetch: execute rejects an out-of-enum mode instead of falling back', async (t) => {
  // Measured on the shipped runtime: `enum` is not enforced before `execute`, so
  // an unknown mode really does arrive here. A silent fallback would let the
  // caller believe the requested mode took effect; it must be an explicit error.
  fakeGlobalFetch(t, async () => okResponse('x'));
  const { byName } = toolsFor();
  const value = await byName.get('ssh_fetch').execute({ url: URL_BASE, remotePath: '/tmp/x', mode: 'api' });
  assert.equal(value.ok, false);
  assert.match(value.summary, /local-relay/);
  assert.match(value.summary, /api/);
});

// ───────────────────────────── mode resolution ────────────────────────────────

/** A remote-direct environment: curl exists, the download succeeds, stat says 42 bytes. */
function remoteDirectEnv(bytes = 42) {
  const { commands, stream } = scriptedClientStream((command) => {
    if (command.includes('command -v curl')) return { stdout: 'curl\n' };
    return { stdout: '', code: 0 };
  });
  const sftp = fakeSftp(new Map([['/root/dl/file.bin', { kind: 'file', content: Buffer.alloc(bytes) }]]));
  return { commands, stream, sftp };
}

test('ssh_fetch: with preferLocalRelay=true (default), no mode means local-relay', async (t) => {
  fakeGlobalFetch(t, async () => okResponse('abc'));
  const { byName } = toolsFor();
  const value = await byName.get('ssh_fetch').execute({ url: URL_BASE, remotePath: '/tmp/d.bin' });
  assert.equal(value.ok, true);
  assert.equal(value.mode, 'local-relay');
  assert.equal(value.bytes, 3);
});

test('ssh_fetch: with preferLocalRelay=false, no mode (or mode="auto") means remote-direct', async () => {
  for (const args of [{ url: URL_BASE, remotePath: '/root/dl/file.bin' }, { url: URL_BASE, remotePath: '/root/dl/file.bin', mode: 'auto' }]) {
    const { commands, stream, sftp } = remoteDirectEnv();
    const { byName } = toolsFor({ clientStream: stream, sftpSession: sftp }, { preferLocalRelay: false });
    const value = await byName.get('ssh_fetch').execute(args);
    assert.equal(value.ok, true, `expected remote-direct success: ${JSON.stringify(value.summary)}`);
    assert.equal(value.mode, 'remote-direct');
    assert.equal(value.bytes, 42);
    assert.ok(commands.some((command) => command.includes('command -v curl')));
  }
});

test('ssh_fetch: an explicit mode overrides the plugin setting in both directions', async (t) => {
  // Setting says remote-direct, call says local-relay.
  fakeGlobalFetch(t, async () => okResponse('local'));
  const { byName: localByName } = toolsFor({}, { preferLocalRelay: false });
  const local = await localByName.get('ssh_fetch').execute({ url: URL_BASE, remotePath: '/tmp/a', mode: 'local-relay' });
  assert.equal(local.ok, true);
  assert.equal(local.mode, 'local-relay');

  // Setting says local-relay, call says remote-direct.
  const { stream, sftp } = remoteDirectEnv();
  const { byName: directByName } = toolsFor({ clientStream: stream, sftpSession: sftp }, { preferLocalRelay: true });
  const direct = await directByName.get('ssh_fetch').execute({ url: URL_BASE, remotePath: '/root/dl/file.bin', mode: 'remote-direct' });
  assert.equal(direct.ok, true);
  assert.equal(direct.mode, 'remote-direct');
});

// ─────────────────────────── local-relay: happy path ──────────────────────────

test('ssh_fetch local-relay: streams the body to a temp file, uploads it and cleans up', async (t) => {
  const before = new Set(fetchTempDirs());
  const fetchCalls = fakeGlobalFetch(t, async () => okResponse(BODY));
  const entries = new Map();
  const sftp = fakeSftp(entries);
  const { byName } = toolsFor({ sftpSession: sftp });

  const value = await byName.get('ssh_fetch').execute({ url: URL_BASE, remotePath: '/root/dl/data.bin' });

  assert.equal(value.ok, true, `expected success: ${JSON.stringify(value.summary)}`);
  assert.equal(value.mode, 'local-relay');
  assert.equal(value.bytes, Buffer.byteLength(BODY, 'utf8'));
  assert.equal(value.remotePath, '/root/dl/data.bin');
  assert.equal(value.url, URL_BASE);
  assert.equal(value.host, 'live');
  assert.equal(value.target, 'root@10.0.0.1:22');
  assert.match(value.summary, /本机中转上传/);
  assert.ok(Number.isInteger(value.durationMs) && value.durationMs >= 0);

  // The bytes the transport received are exactly the streamed body.
  assert.equal(entries.get('/root/dl/data.bin').content.toString('utf8'), BODY);
  // The parent directory was created before the upload.
  assert.ok(sftp.mkdirs.includes('/root/dl'), `expected mkdirs to include /root/dl, got ${JSON.stringify(sftp.mkdirs)}`);
  // fetch was called once with redirect following and an abort signal.
  assert.equal(fetchCalls.calls.length, 1);
  assert.equal(fetchCalls.calls[0].url, URL_BASE);
  assert.equal(fetchCalls.calls[0].init.redirect, 'follow');
  assert.equal(typeof fetchCalls.calls[0].init.signal, 'object');
  // The temp directory was removed (cleanup runs in the tool's finally).
  const leftovers = fetchTempDirs().filter((name) => !before.has(name));
  assert.deepEqual(leftovers, [], `temp download dirs were left behind: ${leftovers.join(', ')}`);
});

test('ssh_fetch local-relay: a multi-megabyte body is streamed, not buffered into the result', async (t) => {
  const big = 'x'.repeat(3 * 1024 * 1024 + 17);
  fakeGlobalFetch(t, async () => okResponse(big));
  const { byName } = toolsFor();
  const value = await byName.get('ssh_fetch').execute({ url: URL_BASE, remotePath: '/tmp/big.bin' });
  assert.equal(value.ok, true);
  assert.equal(value.bytes, Buffer.byteLength(big, 'utf8'));
  // Only sizes and a short summary cross the tool boundary.
  assert.ok(value.summary.length < 500);
});

test('ssh_fetch local-relay: a ~ remote path is expanded against the remote home', async (t) => {
  fakeGlobalFetch(t, async () => okResponse('home'));
  const entries = new Map();
  const sftp = fakeSftp(entries);
  const { byName } = toolsFor({ sftpSession: sftp });
  const value = await byName.get('ssh_fetch').execute({ url: URL_BASE, remotePath: '~/dl/home.bin' });
  assert.equal(value.ok, true);
  assert.equal(value.remotePath, '/root/dl/home.bin');
  assert.equal(entries.get('/root/dl/home.bin').content.toString('utf8'), 'home');
});

// ────────────────────────── local-relay: failure paths ───────────────────────

test('ssh_fetch local-relay: an HTTP error is a readable failure', async (t) => {
  fakeGlobalFetch(t, async () => errorResponse(404, 'Not Found'));
  const { byName } = toolsFor();
  const value = await byName.get('ssh_fetch').execute({ url: URL_BASE, remotePath: '/tmp/x' });
  assert.equal(value.ok, false);
  assert.match(value.summary, /HTTP 404/);
  assert.equal(value.bytes, 0);
  assert.equal(value.mode, 'local-relay');
});

test('ssh_fetch local-relay: a response without a body is reported', async (t) => {
  fakeGlobalFetch(t, async () => okResponse(null));
  const { byName } = toolsFor();
  const value = await byName.get('ssh_fetch').execute({ url: URL_BASE, remotePath: '/tmp/x' });
  assert.equal(value.ok, false);
  assert.match(value.summary, /has no body/);
});

test('ssh_fetch local-relay: a network error is passed through as a readable failure', async (t) => {
  fakeGlobalFetch(t, async () => {
    throw new Error('getaddrinfo ENOTFOUND files.example.com');
  });
  const { byName } = toolsFor();
  const value = await byName.get('ssh_fetch').execute({ url: URL_BASE, remotePath: '/tmp/x' });
  assert.equal(value.ok, false);
  assert.match(value.summary, /ENOTFOUND/);
});

test('ssh_fetch local-relay: a timeout aborts the download and reports it', async (t) => {
  const before = new Set(fetchTempDirs());
  fakeGlobalFetch(t, async (url, init) => {
    assert.equal(typeof init.timeoutMs, 'undefined'); // the helper passes only signal/redirect
    return await new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    });
  });
  const { byName } = toolsFor();
  const value = await byName.get('ssh_fetch').execute({ url: URL_BASE, remotePath: '/tmp/x', timeoutSec: 0.05 });
  assert.equal(value.ok, false);
  assert.match(value.summary, /download timed out/);
  const leftovers = fetchTempDirs().filter((name) => !before.has(name));
  assert.deepEqual(leftovers, []);
});

test('ssh_fetch local-relay: an upload failure is a readable failure and still cleans the temp file', async (t) => {
  const before = new Set(fetchTempDirs());
  fakeGlobalFetch(t, async () => okResponse('x'));
  const sftp = fakeSftp();
  sftp.fastPut = (localPath, remotePath, callback) => callback(new Error('sftp: no space left on device'));
  const { byName } = toolsFor({ sftpSession: sftp });
  const value = await byName.get('ssh_fetch').execute({ url: URL_BASE, remotePath: '/tmp/x' });
  assert.equal(value.ok, false);
  assert.match(value.summary, /no space left/);
  const leftovers = fetchTempDirs().filter((name) => !before.has(name));
  assert.deepEqual(leftovers, [], 'the temp download must be removed even when the upload fails');
});

// ────────────────────────────── remote-direct ────────────────────────────────

test('ssh_fetch remote-direct: builds a curl command, quotes url/path and mkdirs the parent', async () => {
  const { commands, stream } = scriptedClientStream((command) => {
    if (command.includes('command -v curl')) return { stdout: 'curl\n' };
    return { stdout: '', code: 0 };
  });
  const sftp = fakeSftp(new Map([['/root/dl/file.bin', { kind: 'file', content: Buffer.alloc(42) }]]));
  const { byName } = toolsFor({ clientStream: stream, sftpSession: sftp }, { preferLocalRelay: false });

  const urlWithQuery = 'https://files.example.com/f.bin?a=1&b=2';
  const value = await byName.get('ssh_fetch').execute({ url: urlWithQuery, remotePath: '/root/dl/file.bin' });

  assert.equal(value.ok, true);
  assert.equal(value.mode, 'remote-direct');
  assert.equal(value.bytes, 42);
  assert.equal(value.remotePath, '/root/dl/file.bin');
  assert.match(value.summary, /服务器直接下载（curl）/);
  assert.ok(sftp.mkdirs.includes('/root/dl'), 'the parent directory must be created before the download');
  const download = commands.find((command) => command.includes('curl -fsSL'));
  assert.ok(download !== undefined, `no curl download command in ${JSON.stringify(commands)}`);
  assert.equal(download, `curl -fsSL --retry 2 --connect-timeout 30 -o '/root/dl/file.bin' 'https://files.example.com/f.bin?a=1&b=2'`);
});

test('ssh_fetch remote-direct: falls back to wget when curl is absent', async () => {
  const { commands, stream } = scriptedClientStream((command) => {
    if (command.includes('command -v curl')) return { stdout: 'wget\n' };
    return { stdout: '', code: 0 };
  });
  const sftp = fakeSftp(new Map([['/tmp/f.bin', { kind: 'file', content: Buffer.alloc(5) }]]));
  const { byName } = toolsFor({ clientStream: stream, sftpSession: sftp }, { preferLocalRelay: false });
  const value = await byName.get('ssh_fetch').execute({ url: URL_BASE, remotePath: '/tmp/f.bin' });
  assert.equal(value.ok, true);
  assert.match(value.summary, /wget/);
  const download = commands.find((command) => command.includes('wget -q'));
  assert.equal(download, `wget -q -O '/tmp/f.bin' '${URL_BASE}'`);
});

test('ssh_fetch remote-direct: neither curl nor wget gives an actionable error mentioning local-relay', async () => {
  const { stream } = scriptedClientStream((command) => {
    if (command.includes('command -v curl')) return { stdout: 'none\n' };
    return { stdout: '', code: 0 };
  });
  const { byName } = toolsFor({ clientStream: stream }, { preferLocalRelay: false });
  const value = await byName.get('ssh_fetch').execute({ url: URL_BASE, remotePath: '/tmp/f.bin' });
  assert.equal(value.ok, false);
  assert.match(value.summary, /没有 curl 也没有 wget/);
  assert.match(value.summary, /local-relay/);
});

test('ssh_fetch remote-direct: a non-zero curl exit is a readable failure', async () => {
  const { stream } = scriptedClientStream((command) => {
    if (command.includes('command -v curl')) return { stdout: 'curl\n' };
    return { stdout: '', stderr: 'curl: (22) The requested URL returned error: 404', code: 22 };
  });
  const { byName } = toolsFor({ clientStream: stream }, { preferLocalRelay: false });
  const value = await byName.get('ssh_fetch').execute({ url: URL_BASE, remotePath: '/tmp/f.bin' });
  assert.equal(value.ok, false);
  assert.match(value.summary, /下载失败/);
  assert.match(value.summary, /curl: \(22\)/);
});

test('ssh_fetch remote-direct: a failed size lookup is reported', async () => {
  const { stream } = scriptedClientStream((command) => {
    if (command.includes('command -v curl')) return { stdout: 'curl\n' };
    return { stdout: '', code: 0 };
  });
  const sftp = fakeSftp(); // no entry for the target, so stat fails
  const { byName } = toolsFor({ clientStream: stream, sftpSession: sftp }, { preferLocalRelay: false });
  const value = await byName.get('ssh_fetch').execute({ url: URL_BASE, remotePath: '/tmp/f.bin' });
  assert.equal(value.ok, false);
  assert.match(value.summary, /下载后无法读取/);
});

test('ssh_fetch remote-direct: a ~ remote path is expanded before the command is built', async () => {
  const { commands, stream } = scriptedClientStream((command) => {
    if (command.includes('command -v curl')) return { stdout: 'curl\n' };
    return { stdout: '', code: 0 };
  });
  const sftp = fakeSftp(new Map([['/root/dl/f.bin', { kind: 'file', content: Buffer.alloc(9) }]]));
  const { byName } = toolsFor({ clientStream: stream, sftpSession: sftp }, { preferLocalRelay: false });
  const value = await byName.get('ssh_fetch').execute({ url: URL_BASE, remotePath: '~/dl/f.bin' });
  assert.equal(value.ok, true);
  assert.equal(value.remotePath, '/root/dl/f.bin');
  assert.ok(commands.some((command) => command.includes(`-o '/root/dl/f.bin'`)));
});
