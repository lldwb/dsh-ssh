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
 * ## On-demand: the tools appear after the skill is loaded (1.2.0)
 *
 * The six `ssh_*` schemas are ~20 000 characters, and connecting to a machine is a
 * situational capability: most turns never touch it. Since 1.2.0 the tools are
 * **not** in the model's tool table by default; loading the bundled `ssh-remote`
 * skill (via the `skill` tool, or `/ssh-remote`) makes them appear from the next
 * model step. `onDemand: false` in the row config restores the old always-on
 * behaviour, and modes without a `skill` tool (minimal) fail open and keep the
 * tools registered — see `createToolGate`.
 *
 * ## Layering
 *
 * ```
 * index.js        Config, registration, on-demand gate, settings policy, RPC wiring
 * lib/service.mjs store + secrets + pool, shared by tools and the settings page
 * lib/tools.mjs   the six tool definitions (strict JSON Schema)
 * lib/skill.mjs   the `ssh-remote` runtime skill (manual + gate trigger)
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
import { SKILL_DEFINITION, SKILL_NAME } from './lib/skill.mjs';
import { buildTools } from './lib/tools.mjs';
import { mountRpc } from './lib/rpc.mjs';
import { desktopControlRegistered, locateDesktopControl } from './lib/desktop-control.mjs';
import { createRemoteDesktop } from './lib/remote-desktop.mjs';
import { REMOTE_DESKTOP_SKILL_DEFINITION, REMOTE_DESKTOP_SKILL_NAME } from './lib/skill-remote-desktop.mjs';
import { buildRemoteDesktopTools } from './lib/tools-remote-desktop.mjs';

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
export const BUILD = '2026-11-27.2';

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
  // On-demand tool registration (1.2.0). The six `ssh_*` tools stay out of the
  // model's tool table until `ssh-remote` is loaded, which keeps ~20 000 characters
  // of schema off every request. Deliberately NOT `.volatile()`: gating is decided
  // once in `apply()`, so this switch takes effect on the next plugin load
  // (disable/enable or restart), not on the next tool call.
  onDemand: z.boolean().default(true),
  // ── Remote Windows desktop component (1.4.0) ──────────────────────────────
  // The component reuses dsh-desktop-control's agent script over SSH, so it is
  // only available while that plugin is installed AND enabled. `remoteDesktop`
  // is read at load time: turning the component off changes registration.
  remoteDesktop: z.boolean().default(true),
  // Optional explicit path to the dsh-desktop-control package, for an install
  // layout the profile scan cannot see. Empty = auto-detect from the live profile.
  remoteDesktopControlDir: z.string().default(''),
  // Per-operation timeout of one remote desktop call (agent startup + task).
  remoteDesktopTimeoutMs: z.number().step(1000).min(5000).max(300000).default(60000).volatile(),
  // Default screenshot width for `ssh_desktop_screen action="screenshot"`; 0 keeps
  // the capture at physical-pixel size (then image pixels = click coordinates).
  remoteDesktopScreenshotMaxWidth: z.number().step(1).min(0).max(8192).default(1600).volatile(),
  // Ask the remote agent to flash its "dsh is operating this desktop" indicator.
  // Off by default: a one-shot run would flash it for every action, and it also
  // registers a global panic hotkey in the remote user's session.
  remoteDesktopIndicator: z.boolean().default(false),
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
 * Build an on-demand gate: one tool group stays out of the model's tool table
 * until **its own** skill has been loaded.
 *
 * Three sources all count as "activated":
 *  1. the model loaded `skillName` with the `skill` tool (observed via `tools/result`);
 *  2. the user invoked `/<skill-name>` (a `skill-invocation` user message);
 *  3. the session's request header already declares one of these tools — resume/fork
 *     drops the in-memory mark, and the header is what the model was actually shown.
 *
 * **fail-open**: when the agent cannot see a `skill` tool at all (minimal mode),
 * the tools stay registered — that mode has no way to load the skill, so gating
 * would hide them forever. The test is `ctx.tools.get('skill', agent)` (the agent's
 * own visible set), *not* `ctx.get('skills')`: in the web composition the skills
 * service lives in the preset scope and a host-plane plugin cannot see it, which
 * would make the gate fail open permanently (i.e. no gating at all).
 *
 * `available` is an extra condition for a group with a runtime prerequisite (the
 * remote desktop component needs `dsh-desktop-control` enabled). It is evaluated
 * on every step, so disabling the prerequisite from the plugins page hides the
 * group immediately instead of at the next dsh restart.
 *
 * @param {any} ctx - the plugin context.
 * @param {{
 *   skillName: string,
 *   toolNames: string[],
 *   enabled: boolean,
 *   available?: () => boolean,
 * }} spec - the group's identity and switches.
 * @returns {((context: { agent?: any }) => boolean) | undefined} the `when` predicate.
 */
function createSkillGate(ctx, spec) {
  const { skillName, toolNames, enabled, available } = spec;
  if (!enabled) return undefined;

  /** Agents that already loaded this group's skill. */
  const marked = new WeakSet();

  ctx.on?.('tools/result', (exec, result) => {
    if (exec?.agent === undefined || exec.name !== 'skill' || result?.isError === true) return;
    const args = exec.arguments;
    if (args !== null && typeof args === 'object' && args.name === skillName) marked.add(exec.agent);
  });

  ctx.on?.('session/event', (session, event) => {
    if (event?.type !== 'user/message') return;
    const source = event.data?.source;
    if (source?.kind !== 'skill-invocation' || source.name !== skillName) return;
    const agent = ctx.get?.('agents')?.get?.(session?.id);
    if (agent?.session === session) marked.add(agent);
  });

  ctx.on?.('agent/disposed', ({ agent }) => marked.delete(agent));

  return ({ agent }) => {
    if (available !== undefined && available() !== true) return false;
    if (agent === undefined) return true;
    // No skill loader in this mode → do not gate (keep the tools registered).
    if (ctx.tools?.get?.('skill', agent) === undefined) return true;
    if (marked.has(agent)) return true;
    try {
      return agent.session?.requestHeader?.()?.tools?.some((tool) => toolNames.includes(tool.name)) === true;
    } catch {
      // A disposed session cannot answer; treat it as "not activated" rather than
      // throwing inside the registry's per-step predicate.
      return false;
    }
  };
}

/**
 * Backwards-compatible wrapper for the `ssh-remote` group.
 *
 * @param {any} ctx - the plugin context.
 * @param {string[]} toolNames - the six `ssh_*` tool names.
 * @param {boolean} enabled - config switch; `false` returns undefined = always on.
 * @returns {((context: { agent?: any }) => boolean) | undefined} the `when` predicate.
 */
function createToolGate(ctx, toolNames, enabled) {
  return createSkillGate(ctx, { skillName: SKILL_NAME, toolNames, enabled });
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

  // On-demand gate: the six tools do not enter the model's tool table until the
  // `ssh-remote` skill is loaded (saves ~20 000 characters of schema per request).
  // `onDemand: false`, or a mode whose agents cannot see a `skill` tool, makes the
  // predicate constant-true — the old always-on behaviour.
  const gate = createToolGate(ctx, definitions.map((definition) => definition.name), readOption(config, 'onDemand', true) !== false);

  for (const definition of definitions) {
    ctx.effect(
      () => ctx.tools.register(definition, gate === undefined ? {} : { when: gate }),
      `dsh-ssh: tool ${definition.name}`,
    );
  }

  // The manual for those tools — and the trigger that makes them appear. The
  // `skills` service is optional: without it the agents have no `skill` tool, the
  // gate above fails open, and the tools simply stay registered without a manual.
  ctx.inject(['skills'], (scoped) => {
    scoped.effect(() => scoped.skills.register(SKILL_DEFINITION), 'dsh-ssh: skill ssh-remote');
  });

  // ── Remote Windows desktop component (1.4.0) ───────────────────────────────
  // Reuses dsh-desktop-control's agent script over SSH instead of shipping a
  // second desktop implementation. The package is located once at load time; the
  // "is it enabled" half is re-asked on every gate evaluation, so disabling the
  // prerequisite in the plugins page hides this group immediately.
  let remoteDesktopSummary = 'disabled';
  if (readOption(config, 'remoteDesktop', true) !== false) {
    const located = locateDesktopControl({
      dshHome,
      override: String(readOption(config, 'remoteDesktopControlDir', '')),
    });
    if (located.found !== true) {
      remoteDesktopSummary = `inactive (${located.notes.join('; ')})`;
      ctx.logger?.info?.(`dsh-ssh: remote desktop component inactive — ${located.notes.join('; ')}`);
    } else {
      for (const note of located.notes) ctx.logger?.warn?.(`dsh-ssh: remote desktop: ${note}`);
      const remoteOptions = () => ({
        timeoutMs: Number(readOption(config, 'remoteDesktopTimeoutMs', 60000)),
        screenshotMaxWidth: Number(readOption(config, 'remoteDesktopScreenshotMaxWidth', 1600)),
        indicator: readOption(config, 'remoteDesktopIndicator', false) === true,
      });
      const remote = createRemoteDesktop({
        ctx,
        service,
        locator: located,
        options: remoteOptions,
        logger: ctx.logger ?? null,
      });
      const remoteTools = buildRemoteDesktopTools({ service, remote, options: remoteOptions });
      const remoteGate = createSkillGate(ctx, {
        skillName: REMOTE_DESKTOP_SKILL_NAME,
        toolNames: remoteTools.map((definition) => definition.name),
        enabled: true,
        available: () => desktopControlRegistered(ctx),
      });
      for (const definition of remoteTools) {
        ctx.effect(
          () => ctx.tools.register(definition, remoteGate === undefined ? {} : { when: remoteGate }),
          `dsh-ssh: tool ${definition.name}`,
        );
      }
      ctx.inject(['skills'], (scoped) => {
        scoped.effect(() => scoped.skills.register(REMOTE_DESKTOP_SKILL_DEFINITION), 'dsh-ssh: skill ssh-remote-desktop');
      });
      remoteDesktopSummary = `${remoteTools.length} tools via skill "${REMOTE_DESKTOP_SKILL_NAME}" (dsh-desktop-control ${located.version}${located.missingOps.length === 0 ? '' : `, missing ops: ${located.missingOps.join(',')}`})`;
      ctx.logger?.info?.(`dsh-ssh: remote desktop component ready — ${remoteDesktopSummary} at ${located.packageDir}`);
    }
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
    `dsh-ssh: ready (${definitions.length} tools ${gate === undefined ? 'always-on' : `on-demand via skill "${SKILL_NAME}"`}, `
    + `remote desktop: ${remoteDesktopSummary}, dshHome=${dshHome}, secretStore=${service.secrets.kind}, build=${BUILD})`,
  );
}
