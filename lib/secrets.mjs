/**
 * Where a password goes.
 *
 * ## Two backends, one interface
 *
 * The dsh credential service is the right home for a password: it is the same
 * store the Models page writes, it survives plugin reinstalls, and the value is
 * never read back into a tool result. So that is the primary backend.
 *
 * It is not a hard dependency, though. `credentials` is an *optional* Host
 * service: a profile without it should still be able to use key authentication,
 * and a profile where it exists but is read-only should still start. When the
 * service is absent the store falls back to one AES-256-GCM file under
 * `<DSH_HOME>/dsh-ssh/secrets.json`.
 *
 * ## What the fallback is worth, honestly
 *
 * The fallback key is derived from the machine identity (host name and user name)
 * plus the dsh home path. That defeats a stolen backup or a casual `cat`, and
 * defeats nothing else: anything that can read the file can also re-derive the
 * key. It exists so the feature keeps working without the credential service,
 * not as a security boundary, and the README says so.
 *
 * @module dsh-ssh/lib/secrets
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** On-disk format version of the fallback file. */
const FILE_VERSION = 1;

/**
 * Derive the fallback encryption key.
 *
 * @param {string} material - machine- and home-specific material.
 * @returns {Buffer} a 32-byte key.
 */
export function deriveKey(material) {
  return crypto.createHash('sha256').update(String(material)).digest();
}

/**
 * Derive the fallback key material for one dsh home.
 *
 * @param {string} dshHome - resolved dsh home.
 * @returns {string} key material.
 */
export function keyMaterialFor(dshHome) {
  let user = 'unknown';
  try {
    user = os.userInfo().username;
  } catch {
    // A service account without a resolvable user name is still a valid host.
  }
  return `dsh-ssh/${os.hostname()}/${user}/${path.resolve(dshHome)}`;
}

/**
 * Encrypt one string with AES-256-GCM.
 *
 * The output packs `iv | tag | ciphertext` in one base64 string, so the file
 * stays a flat `{ref: value}` map.
 *
 * @param {Buffer} key - 32-byte key.
 * @param {string} plaintext - the secret.
 * @returns {string} base64 payload.
 */
export function encryptSecret(key, plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

/**
 * Decrypt one string produced by {@link encryptSecret}.
 *
 * @param {Buffer} key - 32-byte key.
 * @param {string} payload - base64 payload.
 * @returns {string} the plaintext.
 * @throws {Error} when the payload is malformed or the key is wrong.
 */
export function decryptSecret(key, payload) {
  const buffer = Buffer.from(String(payload), 'base64');
  if (buffer.length < 12 + 16) throw new Error('dsh-ssh: encrypted secret is truncated');
  const iv = buffer.subarray(0, 12);
  const tag = buffer.subarray(12, 28);
  const ciphertext = buffer.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/**
 * A store backed by the dsh credential service.
 *
 * @param {{ resolve: Function, set: Function, unset: Function, describe: Function }} service - the credentials service.
 * @returns {{ kind: string, resolve: (ref: string) => Promise<string | undefined>, set: (ref: string, value: string) => Promise<void>, has: (ref: string) => Promise<boolean>, remove: (ref: string) => Promise<void>, error: string }} the store.
 */
function serviceStore(service) {
  return {
    kind: 'credentials-service',
    error: '',
    async resolve(ref) {
      const resolved = await service.resolve(ref);
      return resolved === undefined || resolved === null ? undefined : String(resolved.value);
    },
    async set(ref, value) {
      await service.set(ref, String(value));
    },
    async has(ref) {
      const info = await service.describe(ref);
      return info !== null && typeof info === 'object' && info.configured === true;
    },
    async remove(ref) {
      await service.unset(ref);
    },
  };
}

/**
 * A store backed by one encrypted JSON file.
 *
 * @param {string} file - absolute path of `secrets.json`.
 * @param {string} dshHome - resolved dsh home, used for key derivation.
 * @returns {{ kind: string, resolve: Function, set: Function, has: Function, remove: Function, error: string }} the store.
 */
function fileStore(file, dshHome) {
  const key = deriveKey(keyMaterialFor(dshHome));

  /** @returns {Record<string, string>} the raw map. */
  function readAll() {
    let source;
    try {
      source = fs.readFileSync(file, 'utf8');
    } catch (error) {
      const code = /** @type {NodeJS.ErrnoException} */ (error).code;
      if (code === 'ENOENT') return {};
      throw new Error(`dsh-ssh: could not read the secret file ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      const parsed = JSON.parse(source);
      if (parsed === null || typeof parsed !== 'object' || typeof parsed.values !== 'object' || parsed.values === null) return {};
      /** @type {Record<string, string>} */
      const values = {};
      for (const [ref, value] of Object.entries(parsed.values)) {
        if (typeof value === 'string' && value !== '') values[ref] = value;
      }
      return values;
    } catch {
      throw new Error(`dsh-ssh: the secret file ${file} is not valid JSON — fix or delete it`);
    }
  }

  /** @param {Record<string, string>} values - the raw map. */
  function writeAll(values) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify({ version: FILE_VERSION, values }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, file);
  }

  return {
    kind: 'encrypted-file',
    error: '',
    async resolve(ref) {
      const payload = readAll()[ref];
      if (payload === undefined) return undefined;
      return decryptSecret(key, payload);
    },
    async set(ref, value) {
      const values = readAll();
      values[ref] = encryptSecret(key, String(value));
      writeAll(values);
    },
    async has(ref) {
      return readAll()[ref] !== undefined;
    },
    async remove(ref) {
      const values = readAll();
      if (values[ref] === undefined) return;
      delete values[ref];
      writeAll(values);
    },
  };
}

/**
 * Pick a secret store for this profile.
 *
 * The credential service wins whenever it exposes the four methods this module
 * needs. `ctx.get` is used rather than `ctx.credentials` so a profile without the
 * service never throws.
 *
 * @param {{ get?: (name: string) => unknown }} ctx - the Cordis plugin context.
 * @param {string} dshHome - resolved dsh home.
 * @returns {{ kind: string, resolve: Function, set: Function, has: Function, remove: Function, error: string }} the store.
 */
export function createSecretStore(ctx, dshHome) {
  const service = typeof ctx?.get === 'function' ? ctx.get('credentials') : undefined;
  const usable =
    service !== undefined &&
    service !== null &&
    typeof service.resolve === 'function' &&
    typeof service.set === 'function' &&
    typeof service.describe === 'function' &&
    typeof service.unset === 'function';

  if (usable) return serviceStore(service);
  return fileStore(path.join(dshHome, 'dsh-ssh', 'secrets.json'), dshHome);
}
