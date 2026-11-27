/**
 * dsh-ssh — remote Windows desktop component: transport and operation layer.
 *
 * ## The problem it solves
 *
 * `dsh-desktop-control` drives **this** machine's desktop. Reaching another
 * Windows PC's desktop over SSH has an extra obstacle that a naive port of the
 * local bridge would hit: **Windows OpenSSH starts every session in Session 0**
 * (measured: `(Get-Process -Id $PID).SessionId` = 0, `[Environment]::UserInteractive`
 * = False). Processes there have no interactive desktop — `SendInput`,
 * `CopyFromScreen` and UI Automation see nothing a user could touch.
 *
 * A process started through an **interactive scheduled task** lands in the user's
 * real session instead (measured on a logged-in Windows 11 host: SessionId 1,
 * `UserInteractive=True`, a real 2560×1440 desktop, and a working screenshot).
 * That is the transport this module implements:
 *
 * ```
 * dsh Host (Windows/macOS/Linux)
 *   │  ssh2 exec: run-action.ps1            →  Session 0: verify task, start it, wait
 *   │  SFTP: request.jsonl / response.jsonl
 *   ▼
 * Task Scheduler (Interactive logon, highest)
 *   └─ agent.cmd                            →  user's session: stdin/stdout redirected
 *        └─ desktop-agent.ps1 (from dsh-desktop-control)   → the actual desktop work
 * ```
 *
 * ## Why one task run per tool call
 *
 * A task cannot be handed a console, so the agent's stdin/stdout are redirected to
 * files from a `.cmd` launcher. That is not just convenient, it is the one
 * encoding-safe route: `Process.Start` with `RedirectStandardOutput` decodes the
 * child's UTF-8 bytes with the console code page (GBK on a Chinese Windows), which
 * turned 「管理员」 into 「绠＄悊鍛?」 in a measured prototype. OS-level redirection
 * (`<` / `>`) moves raw bytes, so Chinese window titles and Chinese input survive
 * both directions.
 *
 * The cost is that every call pays the agent's startup (PowerShell + `Add-Type`,
 * measured ~1.3–1.6 s locally, plus task scheduling: one action measured ~2–4 s
 * end to end over SSH). `sequence` exists precisely for this: focus + click +
 * type in **one** agent run instead of three.
 *
 * ## Ordering and shared files
 *
 * All calls for one remote user share `request.jsonl` / `response.jsonl` and one
 * scheduled task, so calls are serialized in-process. A task left `Running` by a
 * crashed previous call is stopped before the next one starts.
 *
 * ## The prerequisite
 *
 * The agent script is **read from the installed `dsh-desktop-control`**, never
 * copied into this package: one implementation of DPI awareness, the click
 * ladder, capture fallbacks and UIA. This module verifies at call time that the
 * prerequisite is enabled in the running profile, and the tools are also hidden
 * by their gate when it is not.
 *
 * ## What is left on the remote host
 *
 * `<home>\.dsh-ssh\remote-desktop\` (agent script, two launchers, one request and
 * one response file, screenshots while running) and a scheduled task named
 * `dsh-ssh-remote-desktop-<user hash>` (Interactive logon). Nothing auto-starts:
 * the task only runs when a tool call asks it to.
 *
 * @module dsh-ssh/lib/remote-desktop
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { desktopControlRegistered } from './desktop-control.mjs';
import {
  detectPlatform,
  downloadFile,
  execCommand,
  mkdirp,
  readRemoteText,
  resolveHome,
  toSftpPath,
  withSftp,
  writeRemoteFile,
} from './ssh.mjs';
import { psQuote } from './windows.mjs';

/** Directory under the remote Windows home that holds this component's files. */
export const REMOTE_ROOT_SUFFIX = '.dsh-ssh\\remote-desktop';

/** Prefix of the scheduled task created on the remote host. */
export const TASK_PREFIX = 'dsh-ssh-remote-desktop-';

/** Default per-operation timeout (the whole remote round trip). */
export const DEFAULT_ACTION_TIMEOUT_MS = 60000;

/** Largest accepted agent response; a huge `ui_dump` should be narrowed instead. */
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/** The request id this component uses; one request per agent run. */
export const REQUEST_ID = 1;

/** Default screenshot output width on the remote capture side (0 = original). */
export const DEFAULT_SCREENSHOT_MAX_WIDTH = 1600;

/** PNG magic bytes. */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * An error with a machine-readable code, rendered by the tools as a readable
 * verdict. Never thrown out of a tool: `execute` catches it.
 */
export class RemoteDesktopError extends Error {
  /**
   * @param {string} code - stable machine-readable code (e.g. `NOT_WINDOWS`).
   * @param {string} message - human-readable explanation, already actionable.
   * @param {string} [detail] - optional diagnostic text (marker/stderr tail).
   */
  constructor(code, message, detail = '') {
    super(message);
    this.name = 'RemoteDesktopError';
    this.code = code;
    this.detail = detail;
  }
}

/** Quote one value for a Windows command line (single-quoted). */
function quoteWindows(value) {
  return psQuote(value);
}

/**
 * The `.cmd` launcher the scheduled task runs.
 *
 * `%~dp0` is the directory of the script, so the task action never carries an
 * absolute path that would go stale if the remote home moves. `-Indicator 0` is
 * the default: an indicator window per one-shot run would flash on the remote
 * user's screen for every action.
 *
 * @param {{ indicator?: boolean }} [options] - whether to ask the agent for its
 *   on-screen activity indicator (it also registers a global panic hotkey).
 * @returns {string} the script text (CRLF, ASCII only).
 */
export function buildAgentCommandScript(options = {}) {
  const indicator = options.indicator === true ? 1 : 0;
  return [
    '@echo off',
    'rem Generated by dsh-ssh remote desktop. Rewritten on every install.',
    'setlocal',
    'cd /d "%~dp0"',
    `"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0desktop-agent.ps1" -Indicator ${indicator} < "%~dp0request.jsonl" > "%~dp0response.jsonl" 2> "%~dp0stderr.txt"`,
    '> "%~dp0agent.exit" echo %ERRORLEVEL%',
    'exit /b 0',
    '',
  ].join('\r\n');
}

/**
 * The hidden launcher the scheduled task actually starts.
 *
 * `wscript.exe` is a GUI-subsystem host, so it creates **no console window**. It
 * then starts `agent.cmd` with window style 0 (hidden). This is not cosmetic:
 * measured on a real host, a task that started `cmd.exe` directly put an elevated
 * console window on the remote user's desktop on **every** tool call — it stole
 * the foreground, made `info`/`windows` report the wrong foreground window, and
 * its HWND changed on every run, so a hwnd read from one call was invalid in the
 * next.
 *
 * @returns {string} the VBScript text (CRLF, ASCII only).
 */
export function buildAgentVbsScript() {
  return [
    "' Generated by dsh-ssh remote desktop. Rewritten on every install.",
    "' Runs agent.cmd in a hidden window so no console appears on the user's desktop.",
    'Option Explicit',
    'Dim shell, fso, dir',
    'Set shell = CreateObject("WScript.Shell")',
    'Set fso = CreateObject("Scripting.FileSystemObject")',
    'dir = fso.GetParentFolderName(WScript.ScriptFullName)',
    'shell.Run """" & dir & "\\agent.cmd""", 0, False',
    '',
  ].join('\r\n');
}

/**
 * The Session-0 runner: ensure the interactive task exists, start it, wait for
 * the agent to finish, and print small ASCII markers for the Node side.
 *
 * It deliberately does **not** print the agent response (that would go through
 * the exec channel's UTF-8 wrapper and its size cap); the caller reads
 * `response.jsonl` over SFTP instead.
 *
 * @returns {string} the PowerShell script text (CRLF, ASCII only).
 */
export function buildRunActionScript() {
  return [
    'param(',
    '    [Parameter(Mandatory = $true)][string]$Dir,',
    '    [Parameter(Mandatory = $true)][string]$Task,',
    '    [int]$TimeoutSec = 60',
    ')',
    '',
    "$ErrorActionPreference = 'Continue'",
    '',
    'function Write-Marker([string]$text) {',
    '    $safe = $text.Replace([string][char]13, \' \').Replace([string][char]10, \' \')',
    '    [Console]::Out.WriteLine($safe)',
    '}',
    '',
    "$exitFile = Join-Path $Dir 'agent.exit'",
    "$responseFile = Join-Path $Dir 'response.jsonl'",
    "$stderrFile = Join-Path $Dir 'stderr.txt'",
    '',
    '# Which interactive sessions exist? Reported to the caller so a missing',
    '# desktop session becomes an actionable error instead of a bare timeout.',
    "$explorer = @(Get-Process explorer -ErrorAction SilentlyContinue | ForEach-Object { [string]$_.SessionId }) -join ','",
    "Write-Marker ('dsh-explorer-sessions=' + $explorer)",
    '',
    '# Launch the agent through wscript.exe so no console window appears on the',
    "# remote user's desktop. A console window would steal the foreground on every",
    '# tool call (measured: the task cmd.exe was the foreground, and its hwnd',
    '# changed on every run). wscript is a GUI-subsystem host; agent.vbs starts',
    '# agent.cmd with window style 0. Fall back to a visible cmd if wscript is absent.',
    "$wscript = Join-Path $env:SystemRoot 'System32\\wscript.exe'",
    "$agentVbs = Join-Path $Dir 'agent.vbs'",
    'if (Test-Path -LiteralPath $wscript) {',
    '    $actionExe = $wscript',
    "    $argument = '//B //NoLogo \"' + $agentVbs + '\"'",
    "    Write-Marker 'dsh-launcher=vbs'",
    '} else {',
    "    $actionExe = Join-Path $env:SystemRoot 'System32\\cmd.exe'",
    "    $argument = '/c \"' + (Join-Path $Dir 'agent.cmd') + '\"'",
    "    Write-Marker 'dsh-launcher=console'",
    '}',
    'try {',
    '# NOTE: the local is $taskInfo, not the parameter itself. PowerShell variable',
    '# names are case-insensitive, so a local with the parameter name would',
    '# overwrite the -Task argument.',
    '    $taskInfo = Get-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue',
    '    $needsRegister = $null -eq $taskInfo',
    '    if (-not $needsRegister) {',
    '        $currentAction = @($taskInfo.Actions)[0]',
    '        if ($null -eq $currentAction -or $currentAction.Execute -ne $actionExe -or $currentAction.Arguments -ne $argument) { $needsRegister = $true }',
    '    }',
    '    if ($needsRegister) {',
    '        $action = New-ScheduledTaskAction -Execute $actionExe -Argument $argument -WorkingDirectory $Dir',
    '        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable',
    '        # Interactive logon, not S4U: S4U runs in a non-interactive session,',
    '        # which has no desktop to operate. Highest: SendInput/UIA must be able',
    '        # to reach elevated windows too.',
    '        $principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Highest',
    '        Register-ScheduledTask -TaskName $Task -Action $action -Settings $settings -Principal $principal -Force -ErrorAction Stop | Out-Null',
    "        Write-Marker 'dsh-task=created'",
    '        $taskInfo = Get-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue',
    '    } else {',
    "        Write-Marker 'dsh-task=present'",
    '    }',
    '} catch {',
    "    Write-Marker ('dsh-task=register-failed ' + $_.Exception.Message)",
    "    Write-Marker 'dsh-exit=aborted'",
    '    exit 3',
    '}',
    '',
    '# A previous run that never came back would share the request/response files.',
    'try {',
    "    if ($null -ne $taskInfo -and [string]$taskInfo.State -eq 'Running') {",
    '        for ($index = 0; $index -lt 10; $index++) {',
    '            Start-Sleep -Milliseconds 200',
    '            $taskInfo = Get-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue',
    "            if ($null -eq $taskInfo -or [string]$taskInfo.State -ne 'Running') { break }",
    '        }',
    "        if ($null -ne $taskInfo -and [string]$taskInfo.State -eq 'Running') {",
    '            Stop-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue',
    '            Start-Sleep -Milliseconds 500',
    "            Write-Marker 'dsh-stale=stopped'",
    '        }',
    '    }',
    "} catch { Write-Marker ('dsh-stale=error ' + $_.Exception.Message) }",
    '',
    'foreach ($file in @($exitFile, $responseFile, $stderrFile)) {',
    '    Remove-Item -LiteralPath $file -ErrorAction SilentlyContinue',
    '}',
    '',
    'try {',
    '    Start-ScheduledTask -TaskName $Task -ErrorAction Stop',
    '} catch {',
    "    Write-Marker ('dsh-task=start-failed ' + $_.Exception.Message)",
    "    Write-Marker 'dsh-exit=aborted'",
    '    exit 3',
    '}',
    '',
    '$deadline = (Get-Date).AddSeconds($TimeoutSec)',
    'while ((Get-Date) -lt $deadline) {',
    '    if (Test-Path -LiteralPath $exitFile) { break }',
    '    Start-Sleep -Milliseconds 120',
    '}',
    '',
    '$info = Get-ScheduledTaskInfo -TaskName $Task -ErrorAction SilentlyContinue',
    '$state = Get-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue',
    'if ($null -ne $info) { Write-Marker ([string](\'dsh-last-result=\' + $info.LastTaskResult)) }',
    'if ($null -ne $state) { Write-Marker ([string](\'dsh-task-state=\' + $state.State)) }',
    '',
    'if (-not (Test-Path -LiteralPath $exitFile)) {',
    "    Write-Marker 'dsh-exit=timeout'",
    '    exit 2',
    '}',
    '',
    "$exitValue = (Get-Content -LiteralPath $exitFile -Raw).Trim()",
    "Write-Marker ('dsh-exit=' + $exitValue)",
    'if (Test-Path -LiteralPath $responseFile) {',
    "    Write-Marker ([string]('dsh-response-bytes=' + (Get-Item -LiteralPath $responseFile).Length))",
    '} else {',
    "    Write-Marker 'dsh-response-bytes=0'",
    '}',
    'exit 0',
    '',
  ].join('\r\n');
}

/**
 * Paths of this component's files under one remote home.
 *
 * @param {string} home - the remote Windows home (`C:\Users\…`).
 * @returns {{
 *   root: string,
 *   agentScript: string,
 *   agentCommand: string,
 *   runAction: string,
 *   request: string,
 *   response: string,
 *   stderr: string,
 *   exitFile: string,
 *   stamp: string,
 *   shots: string,
 * }} all paths.
 */
export function remoteDesktopPaths(home) {
  const root = `${String(home).replace(/\\+$/, '')}\\${REMOTE_ROOT_SUFFIX}`;
  return {
    root,
    agentScript: `${root}\\desktop-agent.ps1`,
    agentCommand: `${root}\\agent.cmd`,
    agentVbs: `${root}\\agent.vbs`,
    runAction: `${root}\\run-action.ps1`,
    request: `${root}\\request.jsonl`,
    response: `${root}\\response.jsonl`,
    stderr: `${root}\\stderr.txt`,
    exitFile: `${root}\\agent.exit`,
    stamp: `${root}\\install.json`,
    shots: `${root}\\shots`,
  };
}

/**
 * The scheduled task name for one SSH login user.
 *
 * Task Scheduler names are machine-wide but ACL-scoped to their user; a stable
 * hash of the user name keeps two dsh setups on one host from fighting over a
 * task that neither can see.
 *
 * @param {{ user?: string }} profile - the SSH profile.
 * @returns {string} the task name.
 */
export function remoteTaskName(profile) {
  const user = typeof profile?.user === 'string' && profile.user !== '' ? profile.user : 'user';
  const digest = crypto.createHash('sha1').update(user).digest('hex').slice(0, 12);
  return `${TASK_PREFIX}${digest}`;
}

/**
 * A stable identity of the files this component installs on the remote host.
 *
 * The agent script is part of it, so upgrading `dsh-desktop-control` re-uploads
 * the new script on the next call; the launchers are part of it, so changing
 * their generated text re-installs too.
 *
 * @param {Buffer} agentScript - the agent script bytes.
 * @param {string} agentCommand - `agent.cmd` text.
 * @param {string} agentVbs - `agent.vbs` text.
 * @param {string} runAction - `run-action.ps1` text.
 * @returns {string} a hex sha256.
 */
export function installationKey(agentScript, agentCommand, agentVbs, runAction) {
  const hash = crypto.createHash('sha256');
  hash.update(agentScript);
  hash.update('\u0000agent.cmd\u0000');
  hash.update(agentCommand, 'utf8');
  hash.update('\u0000agent.vbs\u0000');
  hash.update(agentVbs, 'utf8');
  hash.update('\u0000run-action.ps1\u0000');
  hash.update(runAction, 'utf8');
  return hash.digest('hex');
}

/**
 * Parse the runner's `key=value` markers.
 *
 * Values may contain spaces (error messages); everything after the first `=` is
 * the value. Heartbeat/unknown lines are kept so diagnostics can quote them.
 *
 * @param {string} stdout - the exec stdout.
 * @returns {{ markers: Record<string, string>, lines: string[] }} parsed markers.
 */
export function parseMarkers(stdout) {
  /** @type {Record<string, string>} */
  const markers = {};
  const lines = String(stdout ?? '').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const index = trimmed.indexOf('=');
    if (index <= 0) continue;
    const key = trimmed.slice(0, index);
    if (!/^dsh-[a-z-]+$/.test(key)) continue;
    markers[key] = trimmed.slice(index + 1);
  }
  return { markers, lines: lines.filter((line) => line.trim() !== '') };
}

/**
 * Extract the agent's response for one request id from a response file.
 *
 * The agent prints one `ready` line (the screen-info object) followed by one
 * response line per request. The response line is the one with the matching `id`.
 *
 * @param {string} text - the response file content.
 * @param {number} requestId - the request id.
 * @returns {{ ok: boolean, data: Record<string, any>, code: string, message: string, ready: Record<string, any> | null, count: number }}
 *   the parsed verdict; `ok` is false when no response line was found.
 */
export function parseAgentResponse(text, requestId = REQUEST_ID) {
  let ready = null;
  let response = null;
  let count = 0;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (message === null || typeof message !== 'object') continue;
    count += 1;
    if (message.ready === true && message.id === undefined) {
      ready = message;
      continue;
    }
    if (Number(message.id) === Number(requestId)) response = message;
  }
  if (response === null) {
    return {
      ok: false,
      data: {},
      code: 'REMOTE_DESKTOP_NO_RESPONSE',
      message: '远程桌面代理没有返回本次请求的结果（可能启动失败或输出被破坏）。',
      ready,
      count,
    };
  }
  const ok = response.ok === true;
  return {
    ok,
    data: response.data !== null && typeof response.data === 'object' ? response.data : {},
    code: ok ? 'OK' : typeof response.code === 'string' && response.code !== '' ? response.code : 'REMOTE_DESKTOP_FAILED',
    message: ok ? '' : typeof response.message === 'string' && response.message !== '' ? response.message : '远程桌面代理执行失败，但没有给出原因。',
    ready,
    count,
  };
}

/** Whether a buffer starts with the PNG signature. */
export function isPng(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_MAGIC);
}

/**
 * Pick the real result out of an agent `data` payload.
 *
 * ## Why `data` can be an array
 *
 * The agent's dispatch returns `Invoke-DeskCommand`'s value, and PowerShell
 * functions emit **everything they write to the pipeline**. In the `sequence`
 * command the steps call `Invoke-TypeText` / `Invoke-KeyTap`, which return their
 * own result objects; those bubble out of `Invoke-Sequence` in addition to the
 * sequence summary. The agent therefore answers a `sequence` with
 * `data: [<text result>, <key result>, <sequence summary>]` whenever the steps
 * include typing or key presses (measured on a real host: stepCount was lost and
 * the tool reported "0 steps").
 *
 * The sequence summary is the element carrying `steps` / `stepCount`; for any
 * other array the last object is the closest equivalent of a scalar result.
 * Fixing the agent itself belongs to `dsh-desktop-control` (its local tools are
 * affected too), so this component normalises on its side and does not depend on
 * a particular `dsh-desktop-control` release.
 *
 * @param {string} cmd - the agent command name.
 * @param {unknown} data - `response.data` as parsed from the agent.
 * @returns {Record<string, any>} the object the tool layer expects.
 */
export function selectAgentData(cmd, data) {
  if (data === null || data === undefined) return {};
  if (!Array.isArray(data)) return typeof data === 'object' ? /** @type {Record<string, any>} */ (data) : {};
  const objects = data.filter((entry) => entry !== null && typeof entry === 'object' && !Array.isArray(entry));
  if (objects.length === 0) return {};
  if (cmd === 'sequence') {
    const summary = objects.find((entry) => Array.isArray(entry.steps) || typeof entry.stepCount === 'number');
    if (summary !== undefined) return summary;
  }
  return /** @type {Record<string, any>} */ (objects[objects.length - 1]);
}

/** Replace anything unsuitable for a file name. */
function safeFilePart(value) {
  return String(value ?? '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

/** A sortable local timestamp for screenshot file names. */
function fileStamp() {
  const now = new Date();
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${pad(now.getMilliseconds(), 3)}`;
}

/** Read a remote text file, returning '' instead of throwing. */
async function readRemoteTextQuietly(sftp, target, maxBytes) {
  try {
    return await readRemoteText(sftp, target, { maxBytes });
  } catch {
    return '';
  }
}

/**
 * Build the remote desktop component.
 *
 * @param {{
 *   ctx: any,
 *   service: Record<string, any>,
 *   locator: Record<string, any>,
 *   options: () => { timeoutMs: number, screenshotMaxWidth: number, indicator: boolean },
 *   logger?: { info?: Function, warn?: Function, debug?: Function } | null,
 * }} spec - dependencies.
 * @returns {{
 *   call: (profile: any, cmd: string, args?: Record<string, any>, options?: { timeoutMs?: number }) => Promise<{ ready: any, data: any }>,
 *   screenshot: (profile: any, args?: Record<string, any>, options?: { timeoutMs?: number }) => Promise<Record<string, any>>,
 *   describe: () => Record<string, any>,
 *   prerequisiteEnabled: () => boolean,
 * }} the component.
 */
export function createRemoteDesktop(spec) {
  const { ctx, service, locator } = spec;
  const readOptions = spec.options;
  const logger = spec.logger ?? null;

  /** Serial queues per remote identity (request/response files are shared). */
  const queues = /** @type {Map<string, Promise<any>>} */ (new Map());

  /** Remote installations already verified in this process. */
  const installed = /** @type {Map<string, string>} */ (new Map());

  /**
   * Is the prerequisite enabled right now? Checked per call, so disabling
   * `dsh-desktop-control` from the plugins page takes effect immediately.
   */
  function prerequisiteEnabled() {
    return desktopControlRegistered(ctx);
  }

  /** The serialization key for one remote login. */
  function queueKeyOf(profile) {
    return `${String(profile?.user ?? '')}@${String(profile?.host ?? '')}:${String(profile?.port ?? '')}`;
  }

  /**
   * Run one task after every earlier task for the same remote login.
   *
   * @template T
   * @param {string} key - the serialization key.
   * @param {() => Promise<T>} operation - the task.
   * @returns {Promise<T>} the task's value.
   */
  function enqueue(key, operation) {
    const previous = queues.get(key) ?? Promise.resolve();
    const run = previous.then(operation, operation);
    queues.set(key, run.then(() => undefined, () => undefined));
    return run;
  }

  /**
   * Upload the agent and launchers when they are missing or changed.
   *
   * A remote stamp carries the installation key, so a restarted dsh does not
   * re-upload 146 KB on every first call. The in-memory cache additionally skips
   * even the stamp read while the process keeps the same files.
   *
   * @param {any} client - the connected ssh2 client.
   * @param {string} cacheKey - per-remote cache key.
   * @param {ReturnType<typeof remoteDesktopPaths>} paths - remote paths.
   * @param {{ indicator: boolean }} backendOptions - agent launch options.
   * @returns {Promise<void>} resolves when the remote files are current.
   */
  async function ensureInstalled(client, cacheKey, paths, backendOptions) {
    const agent = fs.readFileSync(locator.agentScript);
    const agentCommand = buildAgentCommandScript({ indicator: backendOptions.indicator });
    const agentVbs = buildAgentVbsScript();
    const runAction = buildRunActionScript();
    const key = installationKey(agent, agentCommand, agentVbs, runAction);
    if (installed.get(cacheKey) === key) return;

    let remoteKey = '';
    try {
      remoteKey = String(JSON.parse(await withSftp(client, (sftp) => readRemoteText(sftp, paths.stamp, { maxBytes: 4096 }))).key ?? '');
    } catch {
      remoteKey = '';
    }
    if (remoteKey !== key) {
      await withSftp(client, async (sftp) => {
        await mkdirp(sftp, paths.root);
        await mkdirp(sftp, paths.shots);
        // The agent script must keep its UTF-8 BOM: PowerShell 5.1 reads a
        // BOM-less .ps1 with the ANSI code page and Chinese paths break.
        await writeRemoteFile(sftp, paths.agentScript, agent);
        await writeRemoteFile(sftp, paths.agentCommand, Buffer.from(agentCommand, 'utf8'));
        await writeRemoteFile(sftp, paths.agentVbs, Buffer.from(agentVbs, 'utf8'));
        await writeRemoteFile(sftp, paths.runAction, Buffer.from(runAction, 'utf8'));
        await writeRemoteFile(sftp, paths.stamp, Buffer.from(JSON.stringify({
          key,
          version: locator.version,
          agentBytes: agent.length,
          installedAt: new Date().toISOString(),
        }), 'utf8'));
      });
      logger?.info?.(`dsh-ssh: remote desktop installed on ${cacheKey} (dsh-desktop-control ${locator.version})`);
    }
    installed.set(cacheKey, key);
  }

  /** Drop the cached installation so the next call re-uploads. */
  function invalidate(cacheKey) {
    installed.delete(cacheKey);
  }

  /**
   * Compose the actionable timeout message from the runner's markers.
   *
   * @param {Record<string, string>} markers - parsed markers.
   * @returns {string} the message.
   */
  function timeoutMessage(markers) {
    const sessions = markers['dsh-explorer-sessions'] ?? '';
    const state = markers['dsh-task-state'] ?? '';
    const lastResult = markers['dsh-last-result'] ?? '';
    const hints = [
      '远端桌面操作超时：计划任务已启动，但交互式会话里的代理没有在时限内完成。',
    ];
    if (sessions === '') {
      hints.push('检测不到任何交互式桌面会话（没有 explorer.exe）：该 Windows 账号当前没有登录桌面。请先在远端用这个账号登录，再重试。');
    } else {
      hints.push(`检测到交互式会话：${sessions}。请确认 SSH 登录的账号与远端登录桌面的账号一致（计划任务按当前账号的交互式会话启动）。`);
    }
    if (state !== '') hints.push(`任务状态：${state}；LastTaskResult：${lastResult === '' ? '未知' : lastResult}。`);
    hints.push('如果远端刚重装或升级了 dsh-desktop-control，下一次调用会自动重新上传代理脚本。');
    return hints.join('\n');
  }

  /**
   * Run one agent command on the remote desktop.
   *
   * @param {any} profile - a resolved SSH server profile.
   * @param {string} cmd - an agent command name.
   * @param {Record<string, any>} [args] - the request payload.
   * @param {{ timeoutMs?: number, retried?: boolean }} [callOptions] - per-call overrides.
   * @returns {Promise<{ ready: Record<string, any> | null, data: Record<string, any> }>} the agent result.
   * @throws {RemoteDesktopError} with an actionable code and message.
   */
  async function call(profile, cmd, args = {}, callOptions = {}) {
    if (!prerequisiteEnabled()) {
      throw new RemoteDesktopError(
        'PREREQUISITE_DISABLED',
        '远程桌面组件需要先启用 dsh-desktop-control（「设置 → 插件」里把 dsh-desktop-control 打开），'
          + '它提供桌面代理脚本；未启用时本组件不生效。',
      );
    }
    const cacheKey = queueKeyOf(profile);
    return await enqueue(cacheKey, async () => {
      try {
        return await runOnce(profile, cmd, args, callOptions);
      } catch (error) {
        // A missing agent script is the one failure that a fresh upload fixes;
        // retry once, inside this same queue slot (re-entering `call` here would
        // deadlock behind ourselves).
        if (error instanceof RemoteDesktopError && error.code === 'REMOTE_DESKTOP_EMPTY_RESPONSE' && callOptions.retried !== true) {
          invalidate(cacheKey);
          logger?.warn?.('dsh-ssh: remote desktop produced no response; re-uploading the agent and retrying once');
          return await runOnce(profile, cmd, args, { ...callOptions, retried: true });
        }
        throw error;
      }
    });
  }

  /**
   * One attempt at a remote command (not serialized; `call` owns the queue).
   *
   * @param {any} profile - a resolved SSH server profile.
   * @param {string} cmd - an agent command name.
   * @param {Record<string, any>} args - the request payload.
   * @param {{ timeoutMs?: number, retried?: boolean }} callOptions - per-call overrides.
   * @returns {Promise<{ ready: Record<string, any> | null, data: Record<string, any> }>} the agent result.
   */
  async function runOnce(profile, cmd, args, callOptions) {
    const timeoutMs = Number(callOptions.timeoutMs) > 0 ? Math.round(Number(callOptions.timeoutMs)) : readOptions().timeoutMs;
    const cacheKey = queueKeyOf(profile);
    const started = Date.now();
    const client = await service.clientFor(profile);
    const platform = await detectPlatform(client);
      if (platform.kind !== 'windows') {
        throw new RemoteDesktopError(
          'NOT_WINDOWS',
          `远程桌面前置：目标是 ${platform.kind === 'posix' ? 'POSIX（Linux/macOS）' : '未知'} 系统，不是 Windows。`
            + '远程桌面组件只操作 Windows 的交互式桌面；Linux 服务器请直接用 ssh_exec / ssh_job。',
        );
      }
      const home = await resolveHome(client);
      const paths = remoteDesktopPaths(home);
      const task = remoteTaskName(profile);

      await ensureInstalled(client, cacheKey, paths, { indicator: readOptions().indicator });

      const request = { id: REQUEST_ID, cmd: String(cmd), args: args ?? {} };
      await withSftp(client, (sftp) => writeRemoteFile(sftp, paths.request, Buffer.from(`${JSON.stringify(request)}\n`, 'utf8')));

      const timeoutSec = Math.max(5, Math.ceil(timeoutMs / 1000));
      const invocation = `& ${quoteWindows(paths.runAction)} -Dir ${quoteWindows(paths.root)} -Task ${quoteWindows(task)} -TimeoutSec ${timeoutSec}`;
      const exec = await execCommand(client, invocation, {
        // The runner waits for the agent, so allow the task round trip on top.
        timeoutMs: timeoutMs + 25000,
        maxOutputBytes: 8192,
      });
      const { markers, lines } = parseMarkers(exec.stdout);
      const detail = [
        `command=${cmd}`,
        `exit=${exec.exitCode === null ? 'unknown' : exec.exitCode}`,
        ...lines.filter((line) => line.startsWith('dsh-')),
        exec.stderr.trim() === '' ? '' : `stderr=${exec.stderr.trim().slice(-1200)}`,
      ].filter((line) => line !== '').join('\n');

      if (exec.timedOut) {
        throw new RemoteDesktopError('REMOTE_DESKTOP_EXEC_TIMEOUT', `远端执行超时（${Math.round((timeoutMs + 25000) / 1000)} s 未返回）。`, detail);
      }
      if (typeof markers['dsh-task'] === 'string' && markers['dsh-task'].startsWith('register-failed')) {
        throw new RemoteDesktopError(
          'TASK_REGISTER_FAILED',
          `无法在远端注册交互式计划任务：${markers['dsh-task'].slice('register-failed'.length).trim()}。`
            + '通常是没有注册计划任务的权限，或账号策略禁止交互式任务。',
          detail,
        );
      }
      if (markers['dsh-task'] === 'start-failed') {
        throw new RemoteDesktopError('TASK_START_FAILED', '远端计划任务启动失败（详见 detail）。', detail);
      }
      if (markers['dsh-exit'] === 'timeout' || markers['dsh-exit'] === undefined || markers['dsh-exit'] === 'aborted') {
        // A stale installation is one plausible cause; make the next call retry.
        invalidate(cacheKey);
        throw new RemoteDesktopError('REMOTE_DESKTOP_NO_INTERACTIVE_SESSION', timeoutMessage(markers), detail);
      }

      const responseBytes = Number.parseInt(markers['dsh-response-bytes'] ?? '0', 10) || 0;
      if (responseBytes <= 0) {
        const stderrTail = await withSftp(client, (sftp) => readRemoteTextQuietly(sftp, paths.stderr, 4096)).catch(() => '');
        throw new RemoteDesktopError(
          'REMOTE_DESKTOP_EMPTY_RESPONSE',
          '远端桌面代理没有产生响应文件（启动失败或提前退出）。',
          `${detail}${stderrTail === '' ? '' : `\nagent-stderr=${stderrTail.trim().slice(-1200)}`}`,
        );
      }
      if (responseBytes > MAX_RESPONSE_BYTES) {
        throw new RemoteDesktopError(
          'RESPONSE_TOO_LARGE',
          `远端返回 ${responseBytes} 字节，超过 ${MAX_RESPONSE_BYTES} 字节上限。ui_dump 请缩小 maxNodes / 加 filter 后重试。`,
          detail,
        );
      }

      const text = await withSftp(client, (sftp) => readRemoteText(sftp, paths.response, { maxBytes: MAX_RESPONSE_BYTES }));
      const parsed = parseAgentResponse(text, REQUEST_ID);
      if (!parsed.ok) {
        const stderrTail = await withSftp(client, (sftp) => readRemoteTextQuietly(sftp, paths.stderr, 4096)).catch(() => '');
        throw new RemoteDesktopError(
          parsed.code,
          parsed.message,
          `${detail}${stderrTail === '' ? '' : `\nagent-stderr=${stderrTail.trim().slice(-1200)}`}`,
        );
      }
      logger?.debug?.(`dsh-ssh: remote desktop ${cmd} on ${cacheKey} took ${Date.now() - started} ms`);
      return { ready: parsed.ready, data: selectAgentData(cmd, parsed.data) };
  }

  /**
   * Capture one screenshot on the remote host and bring the PNG back.
   *
   * The capture itself happens in the interactive session (a remote path is
   * written there); only the finished PNG crosses SFTP, so `read_image` gets a
   * local file and the remote never needs to encode pixels into JSON.
   *
   * @param {any} profile - a resolved SSH server profile.
   * @param {Record<string, any>} [args] - capture arguments (`hwnd`, `maxWidth`,
   *   `capture`, `allowActivate`, optional `x`/`y`/`width`/`height`).
   * @param {{ timeoutMs?: number }} [callOptions] - per-call overrides.
   * @returns {Promise<Record<string, any>>} agent data plus `localPath`, `remotePath` and `bytes`.
   * @throws {RemoteDesktopError} when capture or transfer fails.
   */
  async function screenshot(profile, args = {}, callOptions = {}) {
    const home = await resolveHome(await service.clientFor(profile));
    const paths = remoteDesktopPaths(home);
    const stamp = fileStamp();
    const remotePath = `${paths.shots}\\shot-${stamp}.png`;
    const maxWidth = Number.isFinite(args.maxWidth) ? Math.max(0, Math.round(args.maxWidth)) : readOptions().screenshotMaxWidth;
    const request = {
      ...(args.hwnd !== undefined && args.hwnd !== null ? { hwnd: args.hwnd } : {}),
      ...(args.capture !== undefined ? { capture: args.capture } : {}),
      ...(args.allowActivate === true ? { allowActivate: true } : {}),
      path: remotePath,
      maxWidth,
    };
    const { data } = await call(profile, 'screenshot', request, callOptions);

    const localDir = path.join(os.tmpdir(), 'dsh-ssh-remote-desktop', safeFilePart(profile.name) || 'remote');
    await fsp.mkdir(localDir, { recursive: true });
    const localPath = path.join(localDir, `shot-${stamp}.png`);
    const client = await service.clientFor(profile);
    try {
      await withSftp(client, (sftp) => downloadFile(sftp, remotePath, localPath));
    } catch (error) {
      throw new RemoteDesktopError(
        'SCREENSHOT_TRANSFER_FAILED',
        `远端截图已生成，但通过 SFTP 取回失败：${error instanceof Error ? error.message : String(error)}。远端文件仍在 ${remotePath}。`,
      );
    }
    const buffer = await fsp.readFile(localPath).catch(() => null);
    if (buffer === null || !isPng(buffer)) {
      const bytes = buffer === null ? 0 : buffer.length;
      throw new RemoteDesktopError(
        'SCREENSHOT_INVALID',
        `取回的截图不是有效 PNG（${bytes} 字节）。远端文件：${remotePath}。下一步：检查远端磁盘与截图目录权限。`,
      );
    }
    // Best-effort cleanup: the local copy is the deliverable. A left-over remote
    // file only matters when the download failed, which was reported above.
    await withSftp(client, (sftp) => new Promise((resolve) => {
      try {
        sftp.unlink(toSftpPath(remotePath), () => resolve(undefined));
      } catch {
        resolve(undefined);
      }
    })).catch(() => undefined);

    return { ...data, localPath, remotePath, bytes: buffer.length, maxWidth };
  }

  /** Component description for logs, diagnostics and tests. */
  function describe() {
    const current = readOptions();
    return {
      packageDir: locator.packageDir,
      version: locator.version,
      agentScript: locator.agentScript,
      agentBytes: locator.agentBytes,
      missingOps: locator.missingOps ?? [],
      source: locator.source,
      timeoutMs: current.timeoutMs,
      screenshotMaxWidth: current.screenshotMaxWidth,
      indicator: current.indicator,
    };
  }

  return { call, screenshot, describe, prerequisiteEnabled };
}
