/**
 * Offline unit tests for `lib/profiles.mjs` — the durable server store.
 *
 * No network, no ssh2, no DSH runtime: a bare `node --test` run must be enough.
 * Every test that touches the filesystem uses a `mkdtemp` directory and removes
 * it afterwards, so the developer's real `~/.dsh` is never read or written.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  AUTH_KINDS,
  CREDENTIAL_PREFIX,
  SERVER_NAME,
  STORE_VERSION,
  assertProfileName,
  credentialRefFor,
  emptyStore,
  findProfile,
  listProfiles,
  normalizeProfile,
  passphraseRefFor,
  readStore,
  removeProfile,
  resolveDshHome,
  serversFilePath,
  upsertProfile,
  writeStore,
} from '../lib/profiles.mjs';

/** A throwaway directory removed with the test. */
function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ssh-profiles-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A fixed clock, so timestamps are comparable. */
const NOW = () => '2026-10-21T00:00:00.000Z';

/** A later fixed clock, for update tests. */
const LATER = () => '2027-01-02T03:04:05.000Z';

// ─────────────────────────────── name validation ───────────────────────────────

test('assertProfileName accepts path-safe names up to 64 characters', () => {
  for (const name of ['a', 'A1', 'a-b_c.d', '0', 'x'.repeat(64)]) {
    assert.equal(assertProfileName(name), name);
  }
  assert.match(String(SERVER_NAME), /^\/\^/);
});

test('assertProfileName rejects invalid names', () => {
  const invalid = [
    '', // empty
    ' ', // whitespace only
    '-leading-dash', // must start alphanumeric
    '_leading', // must start alphanumeric
    '.leading',
    'a b', // space
    'a/b', // path slash
    'a\\b', // backslash
    'a:b',
    'a\u0000b', // NUL
    'a\nb', // newline
    'x'.repeat(65), // too long
    '名字', // non-ASCII
    undefined,
    null,
    42,
    {},
  ];
  for (const value of invalid) {
    assert.throws(() => assertProfileName(value), /dsh-ssh:/, `expected rejection for ${JSON.stringify(value)}`);
  }
});

// ────────────────────────────── credential refs ────────────────────────────────

test('credentialRefFor derives an upper-case, punctuation-free reference', () => {
  assert.equal(credentialRefFor('live'), 'DSH_SSH_LIVE_PASSWORD');
  assert.equal(credentialRefFor('my-server'), 'DSH_SSH_MY_SERVER_PASSWORD');
  assert.equal(credentialRefFor('a.b_c-d'), 'DSH_SSH_A_B_C_D_PASSWORD');
  assert.ok(credentialRefFor('x').startsWith(CREDENTIAL_PREFIX));
});

test('passphraseRefFor derives the key-passphrase reference', () => {
  assert.equal(passphraseRefFor('gpu-1'), 'DSH_SSH_GPU_1_PASSPHRASE');
});

// ───────────────────────────── normalizeProfile ────────────────────────────────

test('normalizeProfile requires name, host and user', () => {
  assert.throws(() => normalizeProfile({}, undefined, NOW), /`name`/);
  assert.throws(() => normalizeProfile({ name: 'a' }, undefined, NOW), /`host`/);
  assert.throws(() => normalizeProfile({ name: 'a', host: 'h' }, undefined, NOW), /`user`/);
  assert.throws(() => normalizeProfile(null, undefined, NOW), /must be an object/);
  assert.throws(() => normalizeProfile([], undefined, NOW), /must be an object/);
  assert.throws(() => normalizeProfile('x', undefined, NOW), /must be an object/);
});

test('normalizeProfile trims host and user and defaults auth/port', () => {
  const profile = normalizeProfile({ name: 'a', host: '  10.0.0.1  ', user: ' root ' }, undefined, NOW);
  assert.equal(profile.host, '10.0.0.1');
  assert.equal(profile.user, 'root');
  assert.equal(profile.port, 22);
  assert.equal(profile.auth, 'password');
  assert.equal(profile.note, '');
  assert.equal(profile.defaultRemoteDir, '');
  assert.equal(profile.createdAt, NOW());
  assert.equal(profile.updatedAt, NOW());
  assert.equal(profile.passwordRef, 'DSH_SSH_A_PASSWORD');
  assert.equal(profile.privateKeyPath, undefined);
});

test('normalizeProfile accepts a numeric string port and rejects bad ports', () => {
  assert.equal(normalizeProfile({ name: 'a', host: 'h', user: 'u', port: '2222' }, undefined, NOW).port, 2222);
  for (const port of [0, -1, 65536, 1.5, 'abc', NaN, '', Infinity]) {
    assert.throws(
      () => normalizeProfile({ name: 'a', host: 'h', user: 'u', port }, undefined, NOW),
      /`port`/,
      `expected rejection for port ${String(port)}`,
    );
  }
});

test('normalizeProfile rejects invalid auth kinds', () => {
  for (const auth of ['none', 'agent', '', 42]) {
    assert.throws(() => normalizeProfile({ name: 'a', host: 'h', user: 'u', auth }, undefined, NOW), /`auth`/);
  }
  for (const auth of AUTH_KINDS) {
    assert.doesNotThrow(() =>
      normalizeProfile({ name: 'a', host: 'h', user: 'u', auth, privateKeyPath: '/k' }, undefined, NOW),
    );
  }
});

test('normalizeProfile treats an explicit null auth/port as "not provided"', () => {
  // `??` is what the implementation uses, so null falls back to the default and
  // is not an invalid value; documented here so the behaviour is intentional.
  const profile = normalizeProfile({ name: 'a', host: 'h', user: 'u', auth: null, port: null }, undefined, NOW);
  assert.equal(profile.auth, 'password');
  assert.equal(profile.port, 22);
});

test('normalizeProfile rejects control characters in host/user', () => {
  for (const field of ['host', 'user']) {
    for (const value of ['a\nb', 'a\rb', 'a\u0000b', 'a\tb']) {
      assert.throws(
        () => normalizeProfile({ name: 'a', host: 'h', user: 'u', [field]: value }, undefined, NOW),
        new RegExp(`\`${field}\``),
        `expected rejection for ${field}=${JSON.stringify(value)}`,
      );
    }
  }
});

test('normalizeProfile enforces note and defaultRemoteDir limits', () => {
  assert.equal(normalizeProfile({ name: 'a', host: 'h', user: 'u', note: 'x'.repeat(2000) }, undefined, NOW).note.length, 2000);
  assert.throws(
    () => normalizeProfile({ name: 'a', host: 'h', user: 'u', note: 'x'.repeat(2001) }, undefined, NOW),
    /`note`/,
  );
  assert.throws(
    () => normalizeProfile({ name: 'a', host: 'h', user: 'u', defaultRemoteDir: '/x'.repeat(2049) }, undefined, NOW),
    /defaultRemoteDir/,
  );
  for (const value of ['/a\nb', '/a\rb', '/a\u0000b']) {
    assert.throws(() => normalizeProfile({ name: 'a', host: 'h', user: 'u', defaultRemoteDir: value }, undefined, NOW), /defaultRemoteDir/);
  }
});

test('normalizeProfile requires a private key path for auth="key"', () => {
  assert.throws(() => normalizeProfile({ name: 'k', host: 'h', user: 'u', auth: 'key' }, undefined, NOW), /privateKeyPath/);
  const profile = normalizeProfile({ name: 'k', host: 'h', user: 'u', auth: 'key', privateKeyPath: '/home/me/id_ed25519' }, undefined, NOW);
  assert.equal(profile.privateKeyPath, '/home/me/id_ed25519');
  assert.equal(profile.passphraseRef, 'DSH_SSH_K_PASSPHRASE');
  assert.equal(profile.passwordRef, undefined);
});

test('normalizeProfile update inherits omitted fields and keeps createdAt/passwordRef', () => {
  const existing = normalizeProfile(
    { name: 'live', host: '10.0.0.1', user: 'root', port: 2222, note: 'old note', defaultRemoteDir: '/data' },
    undefined,
    NOW,
  );
  const updated = normalizeProfile({ name: 'live', note: 'new note' }, existing, LATER);
  assert.equal(updated.host, '10.0.0.1');
  assert.equal(updated.user, 'root');
  assert.equal(updated.port, 2222);
  assert.equal(updated.note, 'new note');
  assert.equal(updated.defaultRemoteDir, '/data');
  assert.equal(updated.createdAt, NOW());
  assert.equal(updated.updatedAt, LATER());
  assert.equal(updated.passwordRef, existing.passwordRef);
});

test('normalizeProfile honours an explicit passwordRef and only generates one when absent', () => {
  const explicit = normalizeProfile({ name: 'a', host: 'h', user: 'u', passwordRef: 'CUSTOM_REF' }, undefined, NOW);
  assert.equal(explicit.passwordRef, 'CUSTOM_REF');
  const generated = normalizeProfile({ name: 'a', host: 'h', user: 'u' }, undefined, NOW);
  assert.equal(generated.passwordRef, 'DSH_SSH_A_PASSWORD');
});

test('normalizeProfile keeps a stored passphraseRef on update', () => {
  const existing = normalizeProfile(
    { name: 'k', host: 'h', user: 'u', auth: 'key', privateKeyPath: '/k', passphraseRef: 'OLD_PASS' },
    undefined,
    NOW,
  );
  const updated = normalizeProfile({ name: 'k', note: 'n' }, existing, LATER);
  assert.equal(updated.passphraseRef, 'OLD_PASS');
  assert.equal(updated.privateKeyPath, '/k');
});

// ───────────────────────────────── readStore ───────────────────────────────────

test('readStore treats a missing file as an empty store', (t) => {
  const state = readStore(path.join(tempDir(t), 'nope', 'servers.json'));
  assert.equal(state.exists, false);
  assert.equal(state.error, '');
  assert.deepEqual(state.store, { version: STORE_VERSION, servers: {} });
});

test('readStore reports corrupt JSON as data instead of throwing', (t) => {
  const file = path.join(tempDir(t), 'servers.json');
  fs.writeFileSync(file, '{ not json', 'utf8');
  const state = readStore(file);
  assert.equal(state.exists, true);
  assert.match(state.error, /not valid JSON/);
  assert.deepEqual(state.store, emptyStore());
});

test('readStore rejects a document whose servers field is not an object', (t) => {
  const dir = tempDir(t);
  for (const body of ['[]', 'null', '"x"', '{"version":1,"servers":null}', '{"version":1}']) {
    const file = path.join(dir, `s-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(file, body, 'utf8');
    const state = readStore(file);
    assert.notEqual(state.error, '', `expected an error for ${body}`);
    assert.deepEqual(state.store, emptyStore());
  }
});

test('readStore rejects an array in servers instead of accepting it as an empty store', (t) => {
  // Regression for a reported defect: the shape check used to test only
  // `typeof servers === 'object'`, so `{"version":1,"servers":[]}` was accepted
  // as an empty store and a corrupt file was never reported. The `Array.isArray`
  // guard is now part of the check.
  const file = path.join(tempDir(t), 'servers.json');
  fs.writeFileSync(file, '{"version":1,"servers":[]}', 'utf8');
  const state = readStore(file);
  assert.notEqual(state.error, '');
  assert.match(state.error, /not a dsh-ssh store/);
  assert.deepEqual(state.store, { version: STORE_VERSION, servers: {} });
});

test('readStore keeps valid profiles, drops malformed entries and preserves version', (t) => {
  const file = path.join(tempDir(t), 'servers.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 7,
      servers: {
        good: { name: 'good', host: '10.0.0.1' },
        noHost: { name: 'noHost' },
        asArray: [1, 2, 3],
        asNull: null,
        asString: 'nope',
        hostNotString: { name: 'x', host: 5 },
      },
    }),
    'utf8',
  );
  const state = readStore(file);
  assert.equal(state.error, '');
  assert.equal(state.exists, true);
  assert.equal(state.store.version, 7);
  assert.deepEqual(Object.keys(state.store.servers), ['good']);
  assert.deepEqual(state.store.servers.good, { name: 'good', host: '10.0.0.1' });
});

test('readStore tolerates a store with no profile entries', (t) => {
  const file = path.join(tempDir(t), 'servers.json');
  fs.writeFileSync(file, '{"version":1,"servers":{}}', 'utf8');
  const state = readStore(file);
  assert.equal(state.error, '');
  assert.deepEqual(state.store, { version: STORE_VERSION, servers: {} });
});

// ───────────────────────────────── writeStore ──────────────────────────────────

test('writeStore creates the directory and round-trips through readStore', (t) => {
  const home = tempDir(t);
  const file = serversFilePath(home);
  const store = {
    version: STORE_VERSION,
    servers: { live: { name: 'live', host: '10.0.0.1', user: 'root', port: 22, auth: 'password' } },
  };
  writeStore(file, store);
  assert.ok(fs.existsSync(file));
  const state = readStore(file);
  assert.equal(state.error, '');
  assert.equal(state.store.version, STORE_VERSION);
  assert.deepEqual(state.store.servers.live, store.servers.live);
});

test('writeStore is atomic and leaves no temporary files behind', (t) => {
  const home = tempDir(t);
  const file = serversFilePath(home);
  writeStore(file, { version: STORE_VERSION, servers: {} });
  writeStore(file, {
    version: STORE_VERSION,
    servers: { b: { name: 'b', host: 'h', user: 'u', port: 22, auth: 'password' } },
  });
  const dir = path.dirname(file);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['servers.json']);
  assert.match(fs.readFileSync(file, 'utf8'), /"b"/);
  assert.equal(fs.readFileSync(file, 'utf8').endsWith('\n'), true);
});

test('writeStore always stamps the current store version', (t) => {
  const home = tempDir(t);
  const file = serversFilePath(home);
  writeStore(file, { version: 999, servers: {} });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, STORE_VERSION);
});

// ──────────────────────────────── upsertProfile ────────────────────────────────

test('upsertProfile reports created on insert and false on replace', () => {
  const empty = emptyStore();
  const first = upsertProfile(empty, { name: 'srv', host: 'h1', user: 'root' }, NOW);
  assert.equal(first.created, true);
  assert.equal(first.profile.name, 'srv');
  assert.equal(first.store.servers.srv.host, 'h1');
  assert.equal(empty.servers.srv, undefined, 'the input store must not be mutated');

  const second = upsertProfile(first.store, { name: 'srv', host: 'h2' }, LATER);
  assert.equal(second.created, false);
  assert.equal(second.store.servers.srv.host, 'h2');
  assert.equal(second.store.servers.srv.user, 'root');
  assert.equal(second.store.servers.srv.createdAt, NOW());
  assert.equal(second.store.servers.srv.updatedAt, LATER());
});

test('upsertProfile propagates validation errors without touching the store', () => {
  const store = emptyStore();
  assert.throws(() => upsertProfile(store, { name: 'bad name', host: 'h', user: 'u' }, NOW), /invalid server name/);
  assert.deepEqual(store, emptyStore());
});

// ─────────────────────────────── removeProfile ────────────────────────────────

test('removeProfile removes an existing profile and reports it', () => {
  const created = upsertProfile(emptyStore(), { name: 'gone', host: 'h', user: 'u' }, NOW);
  const result = removeProfile(created.store, 'gone');
  assert.equal(result.removed.name, 'gone');
  assert.equal(result.store.servers.gone, undefined);
});

test('removeProfile is a no-op for an unknown name but still validates it', () => {
  const store = upsertProfile(emptyStore(), { name: 'keep', host: 'h', user: 'u' }, NOW).store;
  const result = removeProfile(store, 'other');
  assert.equal(result.removed, undefined);
  assert.deepEqual(result.store.servers.keep.name, 'keep');
  assert.throws(() => removeProfile(store, 'bad/name'), /invalid server name/);
});

// ──────────────────────────────── listProfiles ─────────────────────────────────

test('listProfiles sorts by name and preserves every entry', () => {
  let store = emptyStore();
  for (const name of ['b', 'a', 'c']) store = upsertProfile(store, { name, host: `${name}.example`, user: 'u' }, NOW).store;
  assert.deepEqual(
    listProfiles(store).map((profile) => profile.name),
    ['a', 'b', 'c'],
  );
  assert.equal(listProfiles(emptyStore()).length, 0);
});

test('findProfile returns undefined for a missing entry', () => {
  const store = upsertProfile(emptyStore(), { name: 'a', host: 'h', user: 'u' }, NOW).store;
  assert.equal(findProfile(store, 'a').host, 'h');
  assert.equal(findProfile(store, 'missing'), undefined);
});

// ─────────────────────────────── home resolution ───────────────────────────────

test('resolveDshHome prefers an explicit DSH_HOME and falls back to ~/.dsh', () => {
  assert.equal(resolveDshHome({ DSH_HOME: 'C:\\custom\\home' }), path.resolve('C:\\custom\\home'));
  assert.equal(resolveDshHome({ DSH_HOME: 'relative-dir' }), path.resolve('relative-dir'));
  assert.equal(resolveDshHome({ DSH_HOME: '' }), path.join(os.homedir(), '.dsh'));
  assert.equal(resolveDshHome({}), path.join(os.homedir(), '.dsh'));
  assert.equal(resolveDshHome(undefined), path.join(os.homedir(), '.dsh'));
  assert.equal(serversFilePath('/home/me/.dsh'), path.join('/home/me/.dsh', 'dsh-ssh', 'servers.json'));
});
