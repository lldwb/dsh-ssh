/**
 * Server profiles — the durable, secret-free description of "which server".
 *
 * ## Where this lives, and why it is not the Loader config
 *
 * A profile is created and edited *at runtime* (by a tool call, or by the
 * settings page), often many times in one session. Loader config is the wrong
 * home for that: it is a patch-layer document, `configEditor.edit()` writes it
 * through the Loader, and a per-host map inside it would have to be re-declared
 * in full on every write. So profiles live in one small JSON file under
 * `<DSH_HOME>/dsh-ssh/servers.json`, and the Loader config keeps only the few
 * genuinely static knobs (default host, timeouts, output cap).
 *
 * ## What is *not* in this file
 *
 * No password, no private key, no passphrase. A password lives in the dsh
 * credential store under a reference name (`passwordRef`); a private key lives in
 * a file the user controls, referenced by path. That split is what makes this
 * file safe to copy, back up, or show in a settings page.
 *
 * ## The reference name is stored, not derived
 *
 * Deriving `DSH_SSH_<NAME>_PASSWORD` on every read looks tidy and is a trap:
 * renaming a profile would silently orphan its stored password, and two names
 * that differ only in case or punctuation (`a-b` / `a_b`) would collide. The
 * reference is therefore generated once, at first creation, and persisted. Reads
 * fall back to the derived name only when a profile predates the field.
 *
 * @module dsh-ssh/lib/profiles
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** On-disk format version. Bumped only on an incompatible shape change. */
export const STORE_VERSION = 1;

/** A profile name: one path-safe, shell-safe, case-preserving token. */
export const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Prefix of every generated credential reference. */
export const CREDENTIAL_PREFIX = 'DSH_SSH_';

/** The two supported authentication kinds. */
export const AUTH_KINDS = ['password', 'key'];

/** Longest accepted host name / address. */
const MAX_HOST_LENGTH = 255;

/** Longest accepted user name. */
const MAX_USER_LENGTH = 128;

/** Longest accepted note. */
const MAX_NOTE_LENGTH = 2000;

/** Longest accepted remote directory. */
const MAX_DIR_LENGTH = 4096;

/**
 * Resolve the dsh home directory.
 *
 * The same order the shipped tooling uses: an explicit `DSH_HOME` wins, then
 * `~/.dsh`. The parameter exists so tests never touch the real home.
 *
 * @param {Record<string, string | undefined>} [env] - environment to read.
 * @returns {string} the resolved home directory.
 */
export function resolveDshHome(env = process.env) {
  const explicit = typeof env?.DSH_HOME === 'string' && env.DSH_HOME !== '' ? env.DSH_HOME : undefined;
  return explicit === undefined ? path.join(os.homedir(), '.dsh') : path.resolve(explicit);
}

/**
 * Where the profile store lives inside a dsh home.
 *
 * @param {string} dshHome - the resolved dsh home.
 * @returns {string} absolute path of `servers.json`.
 */
export function serversFilePath(dshHome) {
  return path.join(dshHome, 'dsh-ssh', 'servers.json');
}

/**
 * The reference name a fresh password should use for a profile name.
 *
 * Only used when a profile is created; the result is persisted, see the module
 * note. Collisions are possible in principle (`a-b` and `a_b`) and handled by the
 * stored field, not by this function.
 *
 * @param {string} name - a validated profile name.
 * @returns {string} an upper-case credential reference name.
 */
export function credentialRefFor(name) {
  return `${CREDENTIAL_PREFIX}${String(name).toUpperCase().replace(/[^A-Z0-9]/g, '_')}_PASSWORD`;
}

/**
 * The reference name a fresh key passphrase should use.
 *
 * @param {string} name - a validated profile name.
 * @returns {string} an upper-case credential reference name.
 */
export function passphraseRefFor(name) {
  return `${CREDENTIAL_PREFIX}${String(name).toUpperCase().replace(/[^A-Z0-9]/g, '_')}_PASSPHRASE`;
}

/**
 * Reject a string that must not contain control characters.
 *
 * Newlines and NULs are the two that turn into argument injection once a value
 * reaches a shell or an SFTP path, so they are refused rather than escaped.
 *
 * @param {unknown} value - candidate.
 * @param {string} label - field name for the error message.
 * @param {number} max - maximum accepted length.
 * @returns {string} the trimmed value.
 * @throws {Error} when the value is not a usable string.
 */
function requireClean(value, label, max) {
  if (typeof value !== 'string') throw new Error(`dsh-ssh: \`${label}\` must be a string`);
  const trimmed = value.trim();
  if (trimmed === '') throw new Error(`dsh-ssh: \`${label}\` must not be empty`);
  if (trimmed.length > max) throw new Error(`dsh-ssh: \`${label}\` is longer than ${max} characters`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) throw new Error(`dsh-ssh: \`${label}\` must not contain control characters or newlines`);
  return trimmed;
}

/**
 * Validate and normalise a profile name.
 *
 * @param {unknown} value - candidate name.
 * @returns {string} the name.
 * @throws {Error} when the name is unusable.
 */
export function assertProfileName(value) {
  if (typeof value !== 'string' || value === '') throw new Error('dsh-ssh: `name` is required and must be a non-empty string');
  if (!SERVER_NAME.test(value)) {
    throw new Error(
      `dsh-ssh: invalid server name ${JSON.stringify(value)} — it must match ${String(SERVER_NAME)} ` +
        '(letters, digits, dot, underscore, dash; must start with a letter or digit; at most 64 characters)',
    );
  }
  return value;
}

/**
 * Normalise one profile declaration into the stored shape.
 *
 * `existing` supplies the fields an update is allowed to omit (name, timestamps,
 * reference names, auth kind). Anything the caller did pass is validated, so an
 * update can never smuggle a half-written profile into the store.
 *
 * @param {Record<string, unknown>} input - the caller's fields.
 * @param {Record<string, unknown> | undefined} existing - the profile being replaced, if any.
 * @param {() => string} now - timestamp source (injectable for tests).
 * @returns {Record<string, unknown>} the complete stored profile.
 * @throws {Error} on invalid input.
 */
export function normalizeProfile(input, existing, now) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('dsh-ssh: a profile must be an object');
  }

  const name = assertProfileName(input.name ?? existing?.name);
  const host = requireClean(input.host ?? existing?.host, 'host', MAX_HOST_LENGTH);
  const user = requireClean(input.user ?? existing?.user, 'user', MAX_USER_LENGTH);

  const rawPort = input.port ?? existing?.port ?? 22;
  const port = typeof rawPort === 'number' ? rawPort : Number.parseInt(String(rawPort), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('dsh-ssh: `port` must be an integer between 1 and 65535');

  const auth = input.auth ?? existing?.auth ?? 'password';
  if (!AUTH_KINDS.includes(auth)) throw new Error(`dsh-ssh: \`auth\` must be one of ${AUTH_KINDS.join(', ')}`);

  const note = input.note === undefined ? (existing?.note ?? '') : String(input.note);
  if (note.length > MAX_NOTE_LENGTH) throw new Error(`dsh-ssh: \`note\` is longer than ${MAX_NOTE_LENGTH} characters`);

  const defaultRemoteDir =
    input.defaultRemoteDir === undefined ? (existing?.defaultRemoteDir ?? '') : String(input.defaultRemoteDir).trim();
  if (defaultRemoteDir.length > MAX_DIR_LENGTH) throw new Error('dsh-ssh: `defaultRemoteDir` is too long');
  if (/[\u0000\r\n]/.test(defaultRemoteDir)) throw new Error('dsh-ssh: `defaultRemoteDir` must not contain newlines or NUL');

  /** @type {Record<string, unknown>} */
  const profile = {
    name,
    host,
    port,
    user,
    auth,
    note,
    defaultRemoteDir,
    createdAt: typeof existing?.createdAt === 'string' ? existing.createdAt : now(),
    updatedAt: now(),
  };

  if (auth === 'password') {
    // The reference is generated once and carried over on update: see the module
    // note about renames and collisions.
    profile.passwordRef =
      typeof existing?.passwordRef === 'string' && existing.passwordRef !== ''
        ? existing.passwordRef
        : typeof input.passwordRef === 'string' && input.passwordRef !== ''
          ? input.passwordRef
          : credentialRefFor(name);
  } else {
    profile.privateKeyPath = requireClean(input.privateKeyPath ?? existing?.privateKeyPath, 'privateKeyPath', MAX_DIR_LENGTH);
    const passphraseExplicit = input.passphraseRef;
    profile.passphraseRef =
      typeof passphraseExplicit === 'string' && passphraseExplicit !== ''
        ? passphraseExplicit
        : typeof existing?.passphraseRef === 'string' && existing.passphraseRef !== ''
          ? existing.passphraseRef
          : passphraseRefFor(name);
  }

  return profile;
}

/**
 * An empty store.
 *
 * @returns {{ version: number, servers: Record<string, unknown> }} the store.
 */
export function emptyStore() {
  return { version: STORE_VERSION, servers: {} };
}

/**
 * Read the store, tolerating every "not there yet" case.
 *
 * A missing file is an empty store. A corrupt file is reported as data (with the
 * parse error) rather than thrown, because a plugin that refuses to activate
 * cannot show the user what is wrong. A corrupt file is never overwritten
 * silently: {@link writeStore} refuses while the read reported an error.
 *
 * @param {string} file - absolute path of `servers.json`.
 * @returns {{ store: { version: number, servers: Record<string, unknown> }, exists: boolean, error: string }} the state.
 */
export function readStore(file) {
  let source;
  try {
    source = fs.readFileSync(file, 'utf8');
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error).code;
    return { store: emptyStore(), exists: false, error: code === 'ENOENT' ? '' : `could not read ${file}: ${error instanceof Error ? error.message : String(error)}` };
  }
  try {
    const parsed = JSON.parse(source);
    // `servers` must be a plain object: `[]` is an array, and treating it as an
    // empty store would silently accept a corrupt file instead of reporting it.
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      typeof parsed.servers !== 'object' ||
      parsed.servers === null ||
      Array.isArray(parsed.servers)
    ) {
      return { store: emptyStore(), exists: true, error: `${file} is not a dsh-ssh store (expected {"version":…,"servers":{…}})` };
    }
    /** @type {Record<string, unknown>} */
    const servers = {};
    for (const [key, value] of Object.entries(parsed.servers)) {
      if (value !== null && typeof value === 'object' && !Array.isArray(value) && typeof value.host === 'string') {
        servers[key] = value;
      }
    }
    return { store: { version: typeof parsed.version === 'number' ? parsed.version : STORE_VERSION, servers }, exists: true, error: '' };
  } catch (error) {
    return { store: emptyStore(), exists: true, error: `${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * Write the store atomically.
 *
 * A temp file in the same directory plus `rename` means a crash mid-write leaves
 * the previous store intact rather than a truncated file. The directory is
 * created `0700` on POSIX: it is per-user state.
 *
 * @param {string} file - absolute path of `servers.json`.
 * @param {{ version: number, servers: Record<string, unknown> }} store - the content.
 * @returns {void}
 * @throws {Error} when the write fails.
 */
export function writeStore(file, store) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const document = { version: STORE_VERSION, servers: store.servers };
  fs.writeFileSync(temp, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, file);
}

/**
 * List profiles sorted by name.
 *
 * @param {{ servers: Record<string, unknown> }} store - the store.
 * @returns {Record<string, unknown>[]} profiles.
 */
export function listProfiles(store) {
  return Object.values(store.servers).sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

/**
 * Find one profile by name.
 *
 * @param {{ servers: Record<string, unknown> }} store - the store.
 * @param {string} name - the profile name.
 * @returns {Record<string, unknown> | undefined} the profile.
 */
export function findProfile(store, name) {
  const entry = store.servers[name];
  return entry === undefined ? undefined : /** @type {Record<string, unknown>} */ (entry);
}

/**
 * Create or replace one profile in the store, returning a new store.
 *
 * @param {{ version: number, servers: Record<string, unknown> }} store - the current store.
 * @param {Record<string, unknown>} input - the caller's fields.
 * @param {() => string} now - timestamp source.
 * @returns {{ store: { version: number, servers: Record<string, unknown> }, profile: Record<string, unknown>, created: boolean }} the result.
 * @throws {Error} on invalid input.
 */
export function upsertProfile(store, input, now) {
  const existing = typeof input.name === 'string' ? findProfile(store, input.name) : undefined;
  const profile = normalizeProfile(input, existing, now);
  const servers = { ...store.servers, [String(profile.name)]: profile };
  return { store: { version: STORE_VERSION, servers }, profile, created: existing === undefined };
}

/**
 * Remove one profile, returning a new store.
 *
 * @param {{ version: number, servers: Record<string, unknown> }} store - the current store.
 * @param {string} name - the profile name.
 * @returns {{ store: { version: number, servers: Record<string, unknown> }, removed: Record<string, unknown> | undefined }} the result.
 */
export function removeProfile(store, name) {
  const name_ = assertProfileName(name);
  const removed = findProfile(store, name_);
  const servers = { ...store.servers };
  delete servers[name_];
  return { store: { version: STORE_VERSION, servers }, removed };
}
