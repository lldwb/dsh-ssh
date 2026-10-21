/**
 * Shared fakes for the tool-level tests.
 *
 * `schema.test.mjs` and `ssh-fetch.test.mjs` both need a service that never
 * opens a socket, an SFTP session that lives in memory, and an `exec` transport
 * that can be scripted per command. Keeping one copy here means a change to the
 * tool contract cannot make one suite pass while the other drifts.
 *
 * Not a `*.test.mjs` file: the tool glob imports it, never runs it as a suite.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildTools } from '../lib/tools.mjs';
import { JobManager, SshPool } from '../lib/ssh.mjs';

/** A stored-profile view, matching `service.view()`. */
export function profileView(overrides = {}) {
  return {
    name: 'live',
    host: '10.0.0.1',
    port: 22,
    user: 'root',
    auth: 'password',
    privateKeyPath: '',
    note: '',
    defaultRemoteDir: '',
    passwordConfigured: true,
    updatedAt: '2026-10-21T00:00:00.000Z',
    ...overrides,
  };
}

/** An EventEmitter-like stream used to satisfy `execCommand`. */
export function fakeStream({ stdout = '', stderr = '', code = 0, signal = null } = {}) {
  /** One tiny emitter; stdout and stderr must not share listeners. */
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
    if (stdout !== '') out.emit('data', Buffer.from(stdout));
    if (stderr !== '') err.emit('data', Buffer.from(stderr));
    out.emit('close', code, signal);
  });
  return stream;
}

/**
 * A fake ssh2 client.
 *
 * `streamOptions` is either a canned stream spec or a `(command) => spec`
 * function, so a test can answer the `$HOME` / `command -v curl` probes with one
 * thing and the real command with another. `__dshSshHome` is pre-seeded so
 * `resolveHome` never has to fake the probe unless a test wants it to.
 */
export function fakeClient(streamOptions = {}, sftpSession) {
  const resolveOptions = typeof streamOptions === 'function' ? streamOptions : () => streamOptions;
  return {
    __dshSshHome: '/root',
    exec(command, optionsOrCallback, maybeCallback) {
      const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
      callback(null, fakeStream(resolveOptions(command)));
    },
    sftp(callback) {
      callback(null, sftpSession ?? fakeSftp());
    },
    end() {},
    on() {},
    once() {},
  };
}

/**
 * A small in-memory SFTP session.
 *
 * Uploads read the real local file (so the test proves bytes reached the
 * transport), downloads write the real local file, and `mkdirs` records every
 * directory the tool asked to create.
 */
export function fakeSftp(entries = new Map()) {
  const mkdirs = [];
  return {
    mkdirs,
    mkdir(target, callback) {
      mkdirs.push(target);
      callback(null);
    },
    stat(target, callback) {
      const entry = entries.get(target);
      if (entry === undefined) {
        callback(new Error('no such file'));
        return;
      }
      callback(null, { isDirectory: () => entry.kind === 'directory', size: entry.content?.length ?? 0 });
    },
    readdir(target, callback) {
      const entry = entries.get(target);
      if (entry === undefined || entry.kind !== 'directory') {
        callback(new Error('not a directory'));
        return;
      }
      const prefix = target.replace(/\/+$/, '');
      callback(
        null,
        entry.children.map((name) => {
          const child = entries.get(`${prefix}/${name}`);
          return {
            filename: name,
            attrs: { isDirectory: () => child?.kind === 'directory', size: child?.content?.length ?? 0 },
            longname: '',
          };
        }),
      );
    },
    fastPut(localPath, remotePath, callback) {
      entries.set(remotePath, { kind: 'file', content: fs.readFileSync(localPath) });
      callback(null);
    },
    fastGet(remotePath, localPath, callback) {
      const entry = entries.get(remotePath);
      if (entry === undefined) {
        callback(new Error('no such file'));
        return;
      }
      fs.mkdirSync(path.dirname(localPath), { recursive: true });
      fs.writeFileSync(localPath, entry.content);
      callback(null);
    },
    end() {},
  };
}

/**
 * Build a fake service that records calls.
 *
 * @param {{
 *   exec?: Function,                 // JobManager transport
 *   sftp?: Function,                 // JobManager SFTP transport
 *   clientStream?: object | Function,// ssh2 client's exec reply
 *   sftpSession?: object,            // ssh2 client's SFTP session
 * }} [options] - overrides.
 * @returns {{ service: Record<string, any>, calls: string[] }} the fake.
 */
export function fakeService(options = {}) {
  const calls = [];
  const servers = new Map([['live', profileView()]]);
  const jobs = new JobManager({
    exec: options.exec ?? (async () => ({ stdout: '', stderr: '', exitCode: 0 })),
    sftp: options.sftp ?? (async (client, operation) => operation(fakeSftp())),
  });

  const service = {
    async listServers() {
      calls.push('listServers');
      return [...servers.values()];
    },
    async getServer(name) {
      calls.push(`getServer:${name}`);
      const found = servers.get(name);
      if (found === undefined) throw new Error(`there is no server named ${JSON.stringify(name)}`);
      return found;
    },
    async addServer(input) {
      calls.push(`addServer:${input.name}`);
      const view = profileView({ name: input.name, host: input.host ?? 'h', user: input.user ?? 'u', passwordConfigured: Boolean(input.password) });
      servers.set(view.name, view);
      return view;
    },
    async updateServer(input) {
      calls.push(`updateServer:${input.name}`);
      const view = profileView({ name: input.name, passwordConfigured: Boolean(input.password) });
      servers.set(view.name, view);
      return view;
    },
    async removeServer(name) {
      calls.push(`removeServer:${name}`);
      return { removed: servers.delete(name), closed: true };
    },
    async setPassword(name, password) {
      calls.push(`setPassword:${name}`);
      return profileView({ name, passwordConfigured: password !== '' });
    },
    async setPassphrase(name) {
      calls.push(`setPassphrase:${name}`);
      return profileView({ name, auth: 'key', passwordConfigured: false });
    },
    async testServer(name) {
      calls.push(`testServer:${name}`);
      return { hostname: 'srv', platform: 'Linux 6.1', uptime: 'up 3 days', latencyMs: 42 };
    },
    resolveProfileFromArgs() {
      return servers.get('live');
    },
    async clientFor() {
      return fakeClient(options.clientStream ?? {}, options.sftpSession);
    },
    jobs,
    secrets: { kind: 'fake' },
    pool: new SshPool(),
    storeFile: '/fake/servers.json',
    view: async (profile) => profileView(profile),
  };
  return { service, calls };
}

/** A temporary directory for transfer tests. */
export function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ssh-tools-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Build the tools against a fake environment.
 *
 * @param {Record<string, any>} [env] - fake-service overrides.
 * @param {Record<string, any>} [optionOverrides] - plugin options (settings).
 * @returns {{ tools: any[], byName: Map<string, any>, fake: { service: any, calls: string[] } }} the tools.
 */
export function toolsFor(env = {}, optionOverrides = {}) {
  const fake = fakeService(env);
  const options = () => ({
    defaultHost: '',
    maxOutputBytes: 65536,
    connectTimeoutMs: 15000,
    preferLocalRelay: true,
    ...optionOverrides,
  });
  const tools = buildTools({}, { service: fake.service, options });
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return { tools, byName, fake };
}

/**
 * A web ReadableStream carrying the given text.
 *
 * `downloadUrlToTemp` uses `Readable.fromWeb(response.body)`, so a fake fetch
 * must return a genuine web stream, not a Node stream.
 */
export function webStreamOf(text) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

/**
 * Replace `globalThis.fetch` for one test and restore it afterwards.
 *
 * @param {import('node:test').TestContext} t - the test, for cleanup.
 * @param {Function} implementation - the fake fetch.
 * @returns {{ calls: Array<{ url: string, init: any }> }} recorded calls.
 */
export function fakeGlobalFetch(t, implementation) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return await implementation(String(url), init);
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return { calls };
}

/** A fetch response stub with a web-stream body. */
export function okResponse(bodyText, { status = 200, statusText = 'OK' } = {}) {
  return { ok: true, status, statusText, body: bodyText === null ? null : webStreamOf(bodyText) };
}

/** A non-2xx fetch response stub. */
export function errorResponse(status, statusText = 'Error') {
  return { ok: false, status, statusText, body: null };
}
