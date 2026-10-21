/**
 * Offline unit tests for `lib/secrets.mjs` — password storage.
 *
 * The credential-service backend is exercised against a small in-memory mock;
 * the encrypted-file fallback against a throwaway DSH_HOME. No real credentials
 * are read or written.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSecretStore, decryptSecret, deriveKey, encryptSecret, keyMaterialFor } from '../lib/secrets.mjs';

/** A throwaway DSH_HOME removed with the test. */
function tempHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ssh-secrets-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A plugin context with no credentials service. */
const noCredentialsCtx = { get: () => undefined };

/** A plugin context whose credentials service is the given mock. */
function credentialsCtx(service) {
  return { get: (name) => (name === 'credentials' ? service : undefined) };
}

// ───────────────────────────── AES-256-GCM primitives ──────────────────────────

test('deriveKey produces a stable 32-byte key', () => {
  const key = deriveKey('material');
  assert.equal(key.length, 32);
  assert.deepEqual(deriveKey('material'), key);
  assert.notDeepEqual(deriveKey('other'), key);
});

test('encryptSecret/decryptSecret round-trips every shape of string', () => {
  const key = deriveKey('test-key');
  const samples = [
    'hunter2',
    '',
    'p@ss w0rd with spaces',
    '中文密码：测试',
    'quote\'"`$\\',
    'x'.repeat(10000),
    '\n\r\t\x00',
  ];
  for (const plaintext of samples) {
    const payload = encryptSecret(key, plaintext);
    assert.equal(typeof payload, 'string');
    assert.equal(decryptSecret(key, payload), plaintext); // eslint-disable-line no-await-in-loop
  }
});

test('encryptSecret uses a fresh IV for every call', () => {
  const key = deriveKey('test-key');
  assert.notEqual(encryptSecret(key, 'same'), encryptSecret(key, 'same'));
});

test('decryptSecret throws on a wrong key and on a truncated payload', () => {
  const payload = encryptSecret(deriveKey('key-a'), 'secret');
  assert.throws(() => decryptSecret(deriveKey('key-b'), payload));
  assert.throws(() => decryptSecret(deriveKey('key-a'), ''), /truncated/);
  assert.throws(() => decryptSecret(deriveKey('key-a'), Buffer.alloc(20).toString('base64')), /truncated/);
});

test('keyMaterialFor binds the key to the dsh home path', () => {
  const a = keyMaterialFor(path.join(os.tmpdir(), 'home-a'));
  const b = keyMaterialFor(path.join(os.tmpdir(), 'home-b'));
  assert.notEqual(a, b);
  assert.match(a, /^dsh-ssh\//);
});

// ───────────────────────────── encrypted-file backend ─────────────────────────

test('createSecretStore falls back to the encrypted file without a credentials service', (t) => {
  const home = tempHome(t);
  const store = createSecretStore(noCredentialsCtx, home);
  assert.equal(store.kind, 'encrypted-file');
  assert.equal(store.error, '');
});

test('file backend set/get/has/remove round-trip', async (t) => {
  const home = tempHome(t);
  const store = createSecretStore(noCredentialsCtx, home);
  const file = path.join(home, 'dsh-ssh', 'secrets.json');

  assert.equal(await store.has('REF'), false);
  assert.equal(await store.resolve('REF'), undefined);

  await store.set('REF', 's3cr3t');
  assert.equal(await store.has('REF'), true);
  assert.equal(await store.resolve('REF'), 's3cr3t');
  assert.ok(fs.existsSync(file));

  // The value on disk is an encrypted envelope, never the plaintext.
  const raw = fs.readFileSync(file, 'utf8');
  assert.equal(raw.includes('s3cr3t'), false);
  assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ['values', 'version']);
  assert.equal(JSON.parse(raw).values.REF !== 's3cr3t', true);

  await store.set('REF', 'rotated');
  assert.equal(await store.resolve('REF'), 'rotated');

  await store.remove('REF');
  assert.equal(await store.has('REF'), false);
  assert.equal(await store.resolve('REF'), undefined);
  await assert.doesNotReject(() => store.remove('REF'), 'removing a missing reference is a no-op');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).values, {});
});

test('file backend survives a new store instance on the same home', async (t) => {
  const home = tempHome(t);
  await createSecretStore(noCredentialsCtx, home).set('REF', 'persisted');
  const reopened = createSecretStore(noCredentialsCtx, home);
  assert.equal(await reopened.resolve('REF'), 'persisted');
});

test('file backend cannot decrypt with a key derived from another home', async (t) => {
  const home = tempHome(t);
  await createSecretStore(noCredentialsCtx, home).set('REF', 'bound-to-home');
  const file = path.join(home, 'dsh-ssh', 'secrets.json');
  const otherHome = tempHome(t);
  // Copy the ciphertext into another home, where the derived key differs.
  fs.mkdirSync(path.join(otherHome, 'dsh-ssh'), { recursive: true });
  fs.copyFileSync(file, path.join(otherHome, 'dsh-ssh', 'secrets.json'));
  const other = createSecretStore(noCredentialsCtx, otherHome);
  await assert.rejects(() => other.resolve('REF'));
});

test('file backend reports a corrupt secret file instead of silently resetting it', async (t) => {
  const home = tempHome(t);
  const file = path.join(home, 'dsh-ssh', 'secrets.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ broken', 'utf8');
  const store = createSecretStore(noCredentialsCtx, home);
  await assert.rejects(() => store.resolve('REF'), /not valid JSON/);
  await assert.rejects(() => store.set('REF', 'x'), /not valid JSON/);
});

test('file backend ignores malformed value entries on read', async (t) => {
  const home = tempHome(t);
  const file = path.join(home, 'dsh-ssh', 'secrets.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, values: { A: 'x', B: 42, C: null, D: '' } }), 'utf8');
  const store = createSecretStore(noCredentialsCtx, home);
  assert.equal(await store.has('B'), false);
  assert.equal(await store.has('C'), false);
  assert.equal(await store.has('D'), false);
  // A malformed value is dropped, so resolving A fails at the GCM layer only
  // if it is not a valid envelope; a short value is reported as truncated.
  await assert.rejects(() => store.resolve('A'), /truncated/);
});

// ───────────────────────────── credentials-service backend ─────────────────────

test('createSecretStore prefers a complete credentials service', async () => {
  const calls = [];
  const service = {
    async resolve(ref) {
      calls.push(['resolve', ref]);
      return { value: `value-of-${ref}` };
    },
    async set(ref, value) {
      calls.push(['set', ref, value]);
    },
    async describe(ref) {
      calls.push(['describe', ref]);
      return { configured: true };
    },
    async unset(ref) {
      calls.push(['unset', ref]);
    },
  };
  const store = createSecretStore(credentialsCtx(service), path.join(os.tmpdir(), 'unused-home'));
  assert.equal(store.kind, 'credentials-service');

  assert.equal(await store.resolve('REF'), 'value-of-REF');
  await store.set('REF', 'new-value');
  assert.equal(await store.has('REF'), true);
  await store.remove('REF');
  assert.deepEqual(calls, [
    ['resolve', 'REF'],
    ['set', 'REF', 'new-value'],
    ['describe', 'REF'],
    ['unset', 'REF'],
  ]);
});

test('credentials service: absent value, configured=false and null resolve', async () => {
  let configured = false;
  const service = {
    async resolve() {
      return undefined;
    },
    async set() {},
    async describe() {
      return { configured };
    },
    async unset() {},
  };
  const store = createSecretStore(credentialsCtx(service), path.join(os.tmpdir(), 'unused-home'));
  assert.equal(await store.resolve('REF'), undefined);
  assert.equal(await store.has('REF'), false);
  configured = true;
  assert.equal(await store.has('REF'), true);

  const nullResolving = createSecretStore(
    credentialsCtx({ ...service, async resolve() { return null; } }),
    path.join(os.tmpdir(), 'unused-home'),
  );
  assert.equal(await nullResolving.resolve('REF'), undefined);
});

test('an incomplete credentials service falls back to the encrypted file', (t) => {
  const home = tempHome(t);
  for (const service of [
    { resolve() {}, set() {}, describe() {} }, // no unset
    { resolve() {}, set() {}, unset() {} }, // no describe
    { resolve() {}, describe() {}, unset() {} }, // no set
    { set() {}, describe() {}, unset() {} }, // no resolve
    {}, // nothing
    null,
  ]) {
    assert.equal(createSecretStore({ get: () => service }, home).kind, 'encrypted-file');
  }
});
