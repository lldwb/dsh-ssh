/**
 * The Host-side operations behind both the tools and the settings page.
 *
 * ## Why a service layer
 *
 * The same five operations — list, add, update, remove, authenticate — are needed
 * twice: once from a tool call (the model) and once from the settings page (the
 * user). Implementing them twice would drift: the page would accept a field the
 * tool rejects, or one path would forget to persist. Both surfaces therefore go
 * through this module, which owns the store file, the secret store and the
 * connection pool.
 *
 * ## Reads are never cached
 *
 * `servers.json` is read on every operation. It is a few hundred bytes, and a
 * server added from the settings page must be visible to the very next tool call
 * in a running session. The only state kept here is the connection pool, which is
 * keyed by a fingerprint of the profile, so a changed profile reconnects.
 *
 * @module dsh-ssh/lib/service
 */

import {
  assertProfileName,
  findProfile,
  listProfiles,
  readStore,
  removeProfile,
  serversFilePath,
  upsertProfile,
  writeStore,
} from './profiles.mjs';
import { execCommand, targetOf, JobManager, SshPool } from './ssh.mjs';
import { createSecretStore } from './secrets.mjs';

/**
 * Create the shared service.
 *
 * @param {{
 *   ctx: any,
 *   dshHome: string,
 *   options: () => { defaultHost: string, maxOutputBytes: number, connectTimeoutMs: number },
 * }} spec - the environment.
 * @returns {Record<string, any>} the service methods.
 */
export function createSshService(spec) {
  const { ctx, dshHome, options } = spec;
  const pool = new SshPool({ connectTimeoutMs: options().connectTimeoutMs });
  const secrets = createSecretStore(ctx, dshHome);
  const jobs = new JobManager();

  /**
   * Load the store, throwing a readable error when the file is corrupt.
   *
   * @returns {{ version: number, servers: Record<string, any> }} the store.
   * @throws {Error} when the file exists but cannot be parsed.
   */
  function requireStore() {
    const state = readStore(serversFilePath(dshHome));
    if (state.error !== '') throw new Error(state.error);
    return state.store;
  }

  /**
   * Whether a password is stored for one profile.
   *
   * @param {Record<string, any>} profile - the profile.
   * @returns {Promise<boolean>} true when a password is present.
   */
  async function passwordConfigured(profile) {
    if (profile.auth !== 'password') return false;
    const ref = String(profile.passwordRef ?? '');
    if (ref === '') return false;
    try {
      return await secrets.has(ref);
    } catch {
      return false;
    }
  }

  /**
   * The projection both surfaces see. Never contains a secret.
   *
   * @param {Record<string, any>} profile - the stored profile.
   * @returns {Promise<Record<string, any>>} the view.
   */
  async function view(profile) {
    return {
      name: String(profile.name),
      host: String(profile.host),
      port: Number(profile.port),
      user: String(profile.user),
      auth: String(profile.auth),
      privateKeyPath: typeof profile.privateKeyPath === 'string' ? profile.privateKeyPath : '',
      note: typeof profile.note === 'string' ? profile.note : '',
      defaultRemoteDir: typeof profile.defaultRemoteDir === 'string' ? profile.defaultRemoteDir : '',
      passwordConfigured: await passwordConfigured(profile),
      updatedAt: typeof profile.updatedAt === 'string' ? profile.updatedAt : '',
    };
  }

  /**
   * Find one stored profile or throw.
   *
   * @param {string} name - the profile name.
   * @returns {Record<string, any>} the profile.
   * @throws {Error} when no such profile exists.
   */
  function requireProfile(name) {
    const store = requireStore();
    const profile = findProfile(store, name);
    if (profile === undefined) {
      const known = listProfiles(store)
        .map((entry) => String(entry.name))
        .join(', ');
      throw new Error(`there is no server named ${JSON.stringify(name)}. Known servers: ${known === '' ? '(none)' : known}`);
    }
    return profile;
  }

  /**
   * Resolve which profile a call means.
   *
   * @param {{ host?: string }} args - explicit host name, if any.
   * @returns {Record<string, any>} the profile.
   * @throws {Error} when the choice is ambiguous or missing.
   */
  function resolveProfile(args) {
    const explicit = typeof args?.host === 'string' ? args.host.trim() : '';
    const store = requireStore();
    if (explicit !== '') {
      const profile = findProfile(store, explicit);
      if (profile === undefined) {
        const known = listProfiles(store)
          .map((entry) => String(entry.name))
          .join(', ');
        throw new Error(`there is no server named ${JSON.stringify(explicit)}. Known servers: ${known === '' ? '(none)' : known}`);
      }
      return profile;
    }
    const servers = listProfiles(store);
    const configured = options().defaultHost;
    if (configured !== '') {
      const profile = findProfile(store, configured);
      if (profile !== undefined) return profile;
    }
    if (servers.length === 1) return servers[0];
    if (servers.length === 0) throw new Error('no servers yet — add one with ssh_host action="add" or from the plugin settings page');
    const known = servers.map((entry) => String(entry.name)).join(', ');
    throw new Error(`\`host\` is required because several servers exist: ${known}`);
  }

  /**
   * Get a ready client for a profile.
   *
   * The handshake timeout is refreshed from the live config on every call: it is a
   * volatile settings field, and a user who raises it because a link is slow
   * expects the next connection attempt to use it, not the next restart.
   *
   * @param {Record<string, any>} profile - the profile.
   * @returns {Promise<any>} the client.
   */
  async function clientFor(profile) {
    pool.connectTimeoutMs = options().connectTimeoutMs;
    return await pool.acquire(profile, secrets);
  }

  return {
    /** @returns {Promise<Array<Record<string, any>>>} every server, sorted by name. */
    async listServers() {
      const store = requireStore();
      const result = [];
      for (const profile of listProfiles(store)) result.push(await view(profile));
      return result;
    },

    /**
     * @param {string} name - profile name.
     * @returns {Promise<Record<string, any>>} the view.
     */
    async getServer(name) {
      return await view(requireProfile(assertProfileName(name)));
    },

    /**
     * Create one server.
     *
     * @param {Record<string, any>} input - profile fields.
     * @returns {Promise<Record<string, any>>} the created view.
     * @throws {Error} when the name already exists or a field is invalid.
     */
    async addServer(input) {
      const store = requireStore();
      const result = upsertProfile(store, input, () => new Date().toISOString());
      if (!result.created) throw new Error(`server ${JSON.stringify(String(input?.name))} already exists — use update instead of add`);
      writeStore(serversFilePath(dshHome), result.store);
      if (typeof input?.password === 'string' && input.password !== '') {
        if (result.profile.auth !== 'password') throw new Error('a password can only be stored for auth="password" servers');
        await secrets.set(String(result.profile.passwordRef), input.password);
      }
      if (typeof input?.passphrase === 'string' && input.passphrase !== '' && result.profile.auth === 'key') {
        await secrets.set(String(result.profile.passphraseRef), input.passphrase);
      }
      return await view(result.profile);
    },

    /**
     * Update one server's fields.
     *
     * @param {Record<string, any>} input - fields; `name` selects the profile.
     * @returns {Promise<Record<string, any>>} the updated view.
     * @throws {Error} when the profile does not exist.
     */
    async updateServer(input) {
      const name = assertProfileName(input?.name);
      const store = requireStore();
      if (findProfile(store, name) === undefined) throw new Error(`there is no server named ${JSON.stringify(name)}`);
      const result = upsertProfile(store, input, () => new Date().toISOString());
      writeStore(serversFilePath(dshHome), result.store);
      if (typeof input?.password === 'string' && input.password !== '') {
        if (result.profile.auth !== 'password') throw new Error('a password can only be stored for auth="password" servers');
        await secrets.set(String(result.profile.passwordRef), input.password);
      }
      if (typeof input?.passphrase === 'string' && input.passphrase !== '' && result.profile.auth === 'key') {
        await secrets.set(String(result.profile.passphraseRef), input.passphrase);
      }
      return await view(result.profile);
    },

    /**
     * Delete one server.
     *
     * @param {string} name - profile name.
     * @returns {Promise<{ removed: boolean, closed: boolean }>} the outcome.
     */
    async removeServer(name) {
      const profile = requireProfile(name);
      const store = requireStore();
      const result = removeProfile(store, profile.name);
      writeStore(serversFilePath(dshHome), result.store);
      await pool.disconnect(String(profile.name));
      return { removed: result.removed !== undefined, closed: true };
    },

    /**
     * Store (or replace) one server's password.
     *
     * @param {string} name - profile name.
     * @param {string} password - the secret.
     * @returns {Promise<Record<string, any>>} the view.
     */
    async setPassword(name, password) {
      if (typeof password !== 'string' || password === '') throw new Error('the password must not be empty');
      const profile = requireProfile(name);
      if (profile.auth !== 'password') throw new Error(`server ${JSON.stringify(profile.name)} uses key authentication and has no password`);
      await secrets.set(String(profile.passwordRef), password);
      await pool.disconnect(String(profile.name));
      return await view(profile);
    },

    /**
     * Store (or replace) a key passphrase.
     *
     * @param {string} name - profile name.
     * @param {string} passphrase - the secret.
     * @returns {Promise<Record<string, any>>} the view.
     */
    async setPassphrase(name, passphrase) {
      if (typeof passphrase !== 'string' || passphrase === '') throw new Error('the passphrase must not be empty');
      const profile = requireProfile(name);
      if (profile.auth !== 'key') throw new Error(`server ${JSON.stringify(profile.name)} does not use key authentication`);
      await secrets.set(String(profile.passphraseRef), passphrase);
      await pool.disconnect(String(profile.name));
      return await view(profile);
    },

    /**
     * Connect and report basic facts about a server.
     *
     * @param {string} name - profile name.
     * @returns {Promise<Record<string, any>>} `{ hostname, platform, uptime, latencyMs }`.
     * @throws {Error} when the connection or the probe command fails.
     */
    async testServer(name) {
      const profile = requireProfile(name);
      const started = Date.now();
      const client = await clientFor(profile);
      const result = await execCommand(client, 'hostname; uname -sr; uptime -p 2>/dev/null || uptime', {
        timeoutMs: 30000,
        maxOutputBytes: 8192,
      });
      if (result.exitCode !== 0) {
        throw new Error(`connected to ${targetOf(profile)} but the probe command failed (exit ${String(result.exitCode)}): ${result.stderr.trim()}`);
      }
      const [hostname = '', platform = '', ...uptimeParts] = result.stdout.trim().split(/\r?\n/);
      return { hostname, platform, uptime: uptimeParts.join(' '), latencyMs: Date.now() - started };
    },

    /** Resolve one profile by name, for the tools. */
    resolveProfile,
    /** Resolve a profile from tool arguments (explicit host, default, or the only server). */
    resolveProfileFromArgs: resolveProfile,
    /** Get a ready client. */
    clientFor,
    /** Shared connection pool (closed on plugin disposal). */
    pool,
    /** Secret store (credentials service or encrypted file). */
    secrets,
    /** Job manager. */
    jobs,
    /** Re-read a profile view. */
    view,
    /** The store file path, for diagnostics. */
    storeFile: serversFilePath(dshHome),
  };
}
