/**
 * dsh-ssh — locating the `dsh-desktop-control` installation (the remote desktop
 * component's prerequisite).
 *
 * ## Why this component reuses another package instead of copying it
 *
 * Operating a Windows desktop is not a few Win32 calls: `dsh-desktop-control`
 * ships a 146 KB agent script that owns DPI-aware coordinates, the SendInput
 * input model, a click ladder (UIA → background message → SendInput), window
 * forensics, screen capture with a six-tier fallback, and UI Automation. Copying
 * that into `dsh-ssh` would duplicate a body of work and let the two copies drift
 * apart. So the remote desktop component **runs that very script on the remote
 * host**, and the local plugin only supplies the transport (SSH + a scheduled
 * task). This module answers two questions:
 *
 * 1. **Where is the package?** The script must be read from the installed copy
 *    the user is actually running, not from a hard-coded path.
 * 2. **Is it enabled?** A disabled `dsh-desktop-control` row registers no tools,
 *    and the requirement for this component is "only works when that one does".
 *
 * ## Where the package is
 *
 * The desktop app starts the DSH host with the profile directory as a positional
 * argument (`… dsh-desktop-host/lib/index.js <app> "C:\Users\x\.dsh\profiles\desktop" …`),
 * and Host plugins run inside that same process, so `process.argv` is the most
 * direct answer. The other sources are fallbacks, in this order:
 *
 * - an explicit `remoteDesktopControlDir` config;
 * - a profile directory found in `process.argv` (verified by its
 *   `dsh.profile.bundles` manifest, so arbitrary path arguments cannot match);
 * - the profile suggested by this module's own URL (a copy installed under
 *   `profiles/<name>/node_modules/…` lives there);
 * - `--profile <name>` / `DSH_PROFILE`;
 * - a scan of `<DSH_HOME>/profiles/*`.
 *
 * ## Why "enabled" is a runtime question
 *
 * Installed and enabled are different states, and the latter can change while
 * the process is alive. The tools registry holds the answer: a disabled row
 * never registered `desktop_screen_info`. The check is therefore deferred to the
 * tool gate and to each call, not frozen in `apply()`.
 *
 * @module dsh-ssh/lib/desktop-control
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The package this component depends on. */
export const DESKTOP_CONTROL_PACKAGE = 'dsh-desktop-control';

/** The agent script, relative to that package's root. */
export const AGENT_SCRIPT_RELATIVE = path.join('scripts', 'desktop-agent.ps1');

/**
 * The agent commands this component can call.
 *
 * Checked against the script text at resolution time: an older
 * `dsh-desktop-control` that predates an operation must produce an actionable
 * error rather than a remote `UNKNOWN_COMMAND` from the agent.
 */
export const REQUIRED_OPS = [
  'info',
  'move',
  'click',
  'drag',
  'scroll',
  'down',
  'up',
  'key',
  'text',
  'windows',
  'focus',
  'sequence',
  'screenshot',
  'ui_dump',
  'ui_invoke',
  'ui_set_value',
];

/**
 * A tool `dsh-desktop-control` registers on every healthy activation.
 *
 * Used as the "that plugin is enabled right now" probe. It must be a tool the
 * prerequisite registers unconditionally (its own on-demand gate only hides the
 * schema from the model; the definition still exists in the registry).
 */
export const DESKTOP_CONTROL_PROBE_TOOL = 'desktop_screen_info';

/** Whether a path is an existing directory (any error means no). */
function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/** Read and parse one JSON file, returning null instead of throwing. */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Is `dsh-desktop-control` enabled in this process right now?
 *
 * Deliberately a registry question, not a filesystem one: the Loader row can be
 * disabled from the plugins page, and only a live registration proves it is
 * active in this profile.
 *
 * @param {any} ctx - a Cordis plugin context.
 * @returns {boolean} true when the prerequisite's tools are registered.
 */
export function desktopControlRegistered(ctx) {
  try {
    return ctx?.tools?.get?.(DESKTOP_CONTROL_PROBE_TOOL) !== undefined;
  } catch {
    return false;
  }
}

/**
 * Inspect one candidate directory as a `dsh-desktop-control` installation.
 *
 * @param {string} packageDir - candidate package root.
 * @param {string} [source] - where the candidate came from (for diagnostics).
 * @returns {{
 *   packageDir: string,
 *   version: string,
 *   agentScript: string,
 *   agentBytes: number,
 *   ops: string[],
 *   missingOps: string[],
 *   source: string,
 * } | null} the installation, or null when the directory is not one.
 */
export function inspectDesktopControlPackage(packageDir, source = '') {
  if (typeof packageDir !== 'string' || packageDir.trim() === '') return null;
  const dir = path.resolve(packageDir);
  if (!isDirectory(dir)) return null;

  const manifest = readJson(path.join(dir, 'package.json'));
  if (manifest === null || typeof manifest !== 'object' || manifest.name !== DESKTOP_CONTROL_PACKAGE) return null;

  const agentScript = path.join(dir, AGENT_SCRIPT_RELATIVE);
  let stat;
  try {
    stat = fs.statSync(agentScript);
  } catch {
    return null;
  }
  // The real script is ~146 KB; a tiny file is a stub or a broken install, and
  // shipping it to a remote host would only fail there.
  if (!stat.isFile() || stat.size < 10000) return null;

  let text = '';
  try {
    text = fs.readFileSync(agentScript, 'utf8');
  } catch {
    return null;
  }
  const missingOps = REQUIRED_OPS.filter((operation) => !text.includes(`'${operation}' {`));
  return {
    packageDir: dir,
    version: typeof manifest.version === 'string' ? manifest.version : '',
    agentScript,
    agentBytes: stat.size,
    ops: REQUIRED_OPS.filter((operation) => !missingOps.includes(operation)),
    missingOps,
    source,
  };
}

/** Whether a directory is a DSH profile (its manifest declares a bundle list). */
function looksLikeProfileDir(dir) {
  if (!isDirectory(dir)) return false;
  const manifest = readJson(path.join(dir, 'package.json'));
  if (manifest === null || typeof manifest !== 'object') return false;
  const bundles = manifest?.dsh?.profile?.bundles;
  if (Array.isArray(bundles)) return true;
  return typeof manifest.name === 'string'
    && manifest.name.startsWith('dsh-profile-')
    && fs.existsSync(path.join(dir, 'cordis.patch.yml'));
}

/**
 * Profile directories named by `process.argv`, plus a `--profile <name>` hint.
 *
 * A path argument is accepted only when it really is a profile directory, so an
 * unrelated absolute argument (a task prompt, a script path) cannot be mistaken
 * for one.
 *
 * @param {readonly string[]} argv - the process argument vector.
 * @returns {{ dir?: string, name?: string }[]} candidates.
 */
export function profileHintsFromArgv(argv) {
  const hints = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (typeof value !== 'string') continue;
    if (value === '--profile' && index + 1 < argv.length && typeof argv[index + 1] === 'string') {
      hints.push({ name: argv[index + 1] });
      index += 1;
      continue;
    }
    if (!path.isAbsolute(value)) continue;
    if (looksLikeProfileDir(value)) hints.push({ dir: path.resolve(value) });
  }
  return hints;
}

/**
 * The profile directory a module lives under, when it is installed in one.
 *
 * @param {string} moduleUrl - an `import.meta.url` value.
 * @returns {string | null} the profile directory, or null.
 */
export function profileDirFromModuleUrl(moduleUrl) {
  let file;
  try {
    file = fileURLToPath(moduleUrl);
  } catch {
    return null;
  }
  const parts = path.resolve(file).split(path.sep);
  const index = parts.lastIndexOf('profiles');
  if (index < 1 || index + 1 >= parts.length) return null;
  const dir = parts.slice(0, index + 2).join(path.sep);
  return looksLikeProfileDir(dir) ? dir : null;
}

/**
 * Every profile directory under one dsh home.
 *
 * @param {string} dshHome - the dsh home.
 * @returns {string[]} absolute profile directories.
 */
function scanProfiles(dshHome) {
  const root = path.join(dshHome, 'profiles');
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name))
    .sort();
}

/**
 * Locate the installed `dsh-desktop-control`.
 *
 * @param {{
 *   dshHome: string,
 *   override?: string,
 *   argv?: readonly string[],
 *   env?: Record<string, string | undefined>,
 *   moduleUrl?: string,
 * }} spec - where to look.
 * @returns {{
 *   found: boolean,
 *   packageDir?: string,
 *   version?: string,
 *   agentScript?: string,
 *   agentBytes?: number,
 *   ops?: string[],
 *   missingOps?: string[],
 *   source?: string,
 *   installed?: Array<Record<string, any>>,
 *   notes: string[],
 * }} the resolution result; `found: false` carries the reason in `notes`.
 */
export function locateDesktopControl(spec) {
  const dshHome = typeof spec.dshHome === 'string' && spec.dshHome !== '' ? spec.dshHome : '';
  const override = typeof spec.override === 'string' ? spec.override.trim() : '';
  const argv = Array.isArray(spec.argv) ? spec.argv : process.argv;
  const env = spec.env ?? process.env;
  const moduleUrl = typeof spec.moduleUrl === 'string' ? spec.moduleUrl : import.meta.url;

  /** @type {{ dir: string, source: string }[]} */
  const candidates = [];
  const add = (dir, source) => {
    if (typeof dir === 'string' && dir.trim() !== '') candidates.push({ dir: path.resolve(dir), source });
  };

  if (override !== '') add(override, 'remoteDesktopControlDir config');
  for (const hint of profileHintsFromArgv(argv)) {
    if (hint.dir !== undefined) add(path.join(hint.dir, 'node_modules', DESKTOP_CONTROL_PACKAGE), `profile dir from process.argv (${path.basename(hint.dir)})`);
    else if (hint.name !== undefined && dshHome !== '') add(path.join(dshHome, 'profiles', hint.name, 'node_modules', DESKTOP_CONTROL_PACKAGE), `--profile ${hint.name}`);
  }
  const ownProfile = profileDirFromModuleUrl(moduleUrl);
  if (ownProfile !== null) add(path.join(ownProfile, 'node_modules', DESKTOP_CONTROL_PACKAGE), 'own module path');
  const envProfile = typeof env?.DSH_PROFILE === 'string' ? env.DSH_PROFILE.trim() : '';
  if (envProfile !== '' && dshHome !== '') add(path.join(dshHome, 'profiles', envProfile, 'node_modules', DESKTOP_CONTROL_PACKAGE), `DSH_PROFILE=${envProfile}`);
  if (dshHome !== '') {
    for (const profileDir of scanProfiles(dshHome)) {
      add(path.join(profileDir, 'node_modules', DESKTOP_CONTROL_PACKAGE), `profile ${path.basename(profileDir)}`);
    }
  }

  /** @type {Record<string, any>[]} */
  const installed = [];
  const seen = new Set();
  for (const candidate of candidates) {
    let key = candidate.dir;
    try {
      key = fs.realpathSync(candidate.dir);
    } catch {
      // It does not resolve; the same path is still a fine dedupe key.
    }
    if (seen.has(key)) continue;
    seen.add(key);
    const packageInfo = inspectDesktopControlPackage(candidate.dir, candidate.source);
    if (packageInfo !== null) installed.push(packageInfo);
  }

  const notes = [];
  if (installed.length === 0) {
    notes.push(
      'dsh-desktop-control is not installed in any discovered dsh profile'
        + (dshHome === '' ? ' (and no DSH_HOME was resolved)' : ` under ${path.join(dshHome, 'profiles')}`),
    );
    return { found: false, notes };
  }
  const primary = /** @type {Record<string, any>} */ (installed[0]);
  if (installed.length > 1) notes.push(`multiple dsh-desktop-control installations were found; using ${primary.packageDir} (${primary.source})`);
  if (primary.missingOps.length > 0) notes.push(`this dsh-desktop-control is missing agent operations: ${primary.missingOps.join(', ')}`);
  return { found: true, ...primary, installed, notes };
}
