/**
 * dsh-ssh — connect to SSH servers from DeepSeek Harness.
 *
 * ## The pain this removes
 *
 * Connecting to a rented GPU box from an agent session used to mean writing a
 * throwaway Python script around paramiko for every step: probe the environment,
 * upload the dataset, start training, poll the log, pull the weights back. Each
 * script is a file to write, run, and delete, and the password ends up pasted
 * into a command line. This plugin replaces all of it with five tools and one
 * persistent server list, plus a settings page for the credentials.
 *
 * ## Mounted globally, on purpose
 *
 * `cordis.patch.yml` inserts this row at the top level rather than inside an
 * agent preset: connecting to a machine is a general capability, wanted in the
 * standard mode as well as the creation mode. (Contrast `dsh-plugin-devkit`,
 * whose tools exist only inside the `cordis` preset.)
 *
 * ## Layering
 *
 * ```
 * index.js        Config, registration, settings policy, RPC wiring
 * lib/service.mjs store + secrets + pool, shared by tools and the settings page
 * lib/tools.mjs   the five tool definitions (strict JSON Schema)
 * lib/rpc.mjs     the settings page's HTTP channel
 * lib/ssh.mjs     connections, exec, SFTP, jobs
 * lib/profiles.mjs durable, secret-free server descriptions
 * lib/secrets.mjs passwords: dsh credential service, or an encrypted file
 * ```
 *
 * ## The two things that must stay true
 *
 * 1. **No secret ever reaches a tool result, a log line, or `servers.json`.**
 *    Passwords live in the credential store; the profile file holds only a
 *    reference name.
 * 2. **The row id is load-bearing.** It is the settings namespace the client half
 *    expects (`SETTINGS_NAMESPACE`); renaming it silently removes the page.
 *
 * @module dsh-ssh
 */

import z from '@deepseek-ai/schemastery';

import { resolveDshHome } from './lib/profiles.mjs';
import { createSshService } from './lib/service.mjs';
import { buildTools } from './lib/tools.mjs';
import { mountRpc } from './lib/rpc.mjs';

/** Cordis plugin name, used by loader diagnostics. */
export const name = 'dsh-ssh';

/**
 * The settings namespace, which is the Loader row id.
 *
 * The settings service addresses a plugin's config section by the row id, not by
 * the package name; the client half repeats this string because it cannot import
 * from the Host package. Changing one without the other makes the settings page
 * vanish without an error.
 */
export const SETTINGS_NAMESPACE = name;

/**
 * `tools` is a hard dependency: registering tools is the point of the plugin.
 *
 * Everything else — `credentials`, `settings`, `connection`, `webServer` — is
 * reached with `ctx.get()` / `ctx.inject()` and degrades gracefully, so a profile
 * without the web half still gets the tools and a profile without the credential
 * service still works with key authentication.
 */
export const inject = ['tools'];

/**
 * Build stamp, surfaced by `ssh_host action="list"` diagnostics and the log line.
 *
 * Bumped whenever the observable behaviour changes, so "did the running process
 * pick up my edit" is answerable from the output alone.
 */
export const BUILD = '2026-10-21.2';

/**
 * Volatile fields are editable from the settings page; the rest is load-time
 * configuration. Every key written in `cordis.patch.yml` must be declared here —
 * an id-targeted patch replaces the whole `config` block, and an undeclared key
 * is rejected or dropped at load time.
 */
export const Config = z.object({
  defaultHost: z.string().default('').volatile(),
  maxOutputBytes: z.number().step(1).min(1024).max(1048576).default(65536).volatile(),
  connectTimeoutMs: z.number().step(1000).min(1000).max(120000).default(15000).volatile(),
  // Which side does the downloading in `ssh_fetch`. On by default: a rented GPU
  // box often has slow, metered or filtered outbound access while the desktop has
  // a proxy, so "download here, then upload" is the safer default; switching it
  // off lets the server pull the file itself.
  preferLocalRelay: z.boolean().default(true).volatile(),
});

/**
 * Read one option from a config value that may be a volatile reference.
 *
 * A `.volatile()` field is resolved by the loader into a live reference with a
 * `.get()`; a field that has a default arrives as plain data. Both shapes are
 * accepted so the plugin keeps working across that boundary.
 *
 * @param {unknown} config - the row config.
 * @param {string} key - the field name.
 * @param {any} fallback - value to use when unset.
 * @returns {any} the resolved value.
 */
export function readOption(config, key, fallback) {
  const value = config === null || config === undefined ? undefined : /** @type {any} */ (config)[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'object' && typeof value.get === 'function') {
    const live = value.get();
    return live === undefined || live === null ? fallback : live;
  }
  return value;
}

/**
 * Register the plugin.
 *
 * @param {any} ctx - the Cordis plugin context.
 * @param {unknown} [config] - the Loader row's `config` block.
 * @returns {void}
 */
export function apply(ctx, config) {
  const dshHome = resolveDshHome();

  /**
   * Resolved options, read fresh on every call: a settings-page edit must reach
   * the very next tool call without a restart.
   *
   * @returns {{ defaultHost: string, maxOutputBytes: number, connectTimeoutMs: number }} options.
   */
  const options = () => ({
    defaultHost: String(readOption(config, 'defaultHost', '')),
    maxOutputBytes: Number(readOption(config, 'maxOutputBytes', 65536)),
    connectTimeoutMs: Number(readOption(config, 'connectTimeoutMs', 15000)),
    preferLocalRelay: readOption(config, 'preferLocalRelay', true) !== false,
  });

  const service = createSshService({ ctx, dshHome, options });
  const definitions = buildTools(ctx, { service, options });

  for (const definition of definitions) {
    ctx.effect(() => ctx.tools.register(definition), `dsh-ssh: tool ${definition.name}`);
  }

  // Pooled sockets must not outlive the plugin: a disable/enable cycle (the
  // documented way to hot-apply a patch change) would otherwise leak one sshd
  // session per reload.
  ctx.effect(() => () => void service.pool.closeAll(), 'dsh-ssh: close pooled connections');

  // The settings page's channel. Optional services inside `mountRpc`.
  mountRpc(ctx, {
    handlers: {
      'plugin.status': async () => ({
        version: BUILD,
        dshHome,
        storeFile: service.storeFile,
        secretStore: service.secrets.kind,
        serverCount: (await service.listServers()).length,
      }),
      'profiles.list': async () => ({ profiles: await service.listServers() }),
      'profiles.get': async (payload) => ({ profile: await service.getServer(String(payload.name ?? '')) }),
      'profiles.add': async (payload) => ({ profile: await service.addServer(payload) }),
      'profiles.update': async (payload) => ({ profile: await service.updateServer(payload) }),
      'profiles.remove': async (payload) => ({ result: await service.removeServer(String(payload.name ?? '')) }),
      'profiles.password': async (payload) => ({ profile: await service.setPassword(String(payload.name ?? ''), String(payload.password ?? '')) }),
      'profiles.passphrase': async (payload) => ({ profile: await service.setPassphrase(String(payload.name ?? ''), String(payload.passphrase ?? '')) }),
      'profiles.test': async (payload) => ({ test: await service.testServer(String(payload.name ?? '')) }),
    },
  });

  // Turn off the auto-generated settings form: the client half draws its own page
  // (a server list the auto form cannot express), and two pages for one namespace
  // would be confusing. `auto: false` only disables presentation — the namespace
  // stays readable/writable.
  ctx.inject(['settings'], (scoped) => {
    scoped.effect(() => scoped.settings.configure({ auto: false }, /** @type {any} */ (ctx).fiber), 'dsh-ssh: settings presentation policy');
  });

  ctx.logger?.info?.(
    `dsh-ssh: ready (${definitions.length} tools, dshHome=${dshHome}, secretStore=${service.secrets.kind}, build=${BUILD})`,
  );
}
