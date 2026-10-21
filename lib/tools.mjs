/**
 * The five tools.
 *
 * ## Why five and not fifteen
 *
 * A model picks a tool from its name and description, so a long catalogue costs
 * accuracy on every turn. The split follows what a remote machine is actually
 * used for:
 *
 * | tool | question it answers |
 * |---|---|
 * | `ssh_host` | which machine, and is it reachable |
 * | `ssh_exec` | run this and show me the output |
 * | `ssh_upload` / `ssh_download` | move these bytes |
 * | `ssh_fetch` | get a file from a URL onto the server, locally relayed by default |
 * | `ssh_job` | start something long, then check on it |
 *
 * `ssh_job` covers start/status/log/stop/list in one tool rather than five: they
 * share one noun (a job id), and a caller that starts a training run will poll it
 * repeatedly, so an `action` argument keeps the catalogue small.
 *
 * ## The strict-schema tax
 *
 * A third-party plugin cannot import `defineTool`, so every parameter node and
 * every *return value* node is written here in the registry's compiled subset
 * (`dsh-plugin-development.md` §12). The registry validates what `execute`
 * returns against `output.schema`: an undeclared field, or a `null` where a
 * `number` was declared, fails the call with `tool returned invalid output` — at
 * runtime, after the work already succeeded. Hence the discipline below: every
 * returned field is declared, `null` is never returned (an unknown exit code is
 * `-1` plus an explanatory `summary`), and failures are returned as
 * `{ ok: false }` rather than thrown so the caller always gets a readable verdict.
 *
 * @module dsh-ssh/lib/tools
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { describeSshError, downloadDirectory, downloadFile, execCommand, mkdirp, readdir, resolveHome, resolveRemotePath, shellQuote, uploadDirectory, uploadFile, withSftp } from './ssh.mjs';

/** One text content block, the shape every `render` returns. */
function text(content) {
  return [{ type: 'text', text: content }];
}

/** One property node of the supported strict JSON-Schema subset. */
function prop(type, description, extra = {}) {
  return { type, ...(description === undefined ? {} : { description }), ...extra };
}

/** One strict object node. */
function obj(properties, required = []) {
  return { type: 'object', additionalProperties: false, properties, ...(required.length === 0 ? {} : { required }) };
}

/** One array node. */
function arr(items, description) {
  return { type: 'array', ...(description === undefined ? {} : { description }), items };
}

/** A string enum node. */
function enumProp(values, description) {
  return { type: 'string', enum: values, description };
}

/** Escape a value for a markdown table cell. */
function cell(value) {
  return String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ');
}

/** Human-readable byte count. */
function humanBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 100 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}

/** Turn a thrown value into a message. */
function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Download a URL to a temporary local file, streaming.
 *
 * Streaming matters: model checkpoints are hundreds of megabytes, and buffering
 * one in memory inside the Harness process would be a silly way to fail. The
 * caller owns the returned directory and must `cleanup()` it.
 *
 * @param {string} url - absolute http(s) URL.
 * @param {{ timeoutMs: number }} options - abort budget.
 * @returns {Promise<{ file: string, bytes: number, cleanup: () => Promise<void> }>} the temp file.
 * @throws {Error} on a non-2xx response, an empty body, or a timeout.
 */
async function downloadUrlToTemp(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  timer.unref?.();
  let cleanupDir;
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!response.ok) throw new Error(`download failed: HTTP ${response.status} ${response.statusText} for ${url}`);
    if (response.body === null) throw new Error(`download failed: the response for ${url} has no body`);
    cleanupDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-ssh-fetch-'));
    const file = path.join(cleanupDir, 'download.bin');
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(file));
    const stats = await fsp.stat(file);
    const dir = cleanupDir;
    return {
      file,
      bytes: stats.size,
      cleanup: async () => {
        await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
      },
    };
  } catch (error) {
    if (cleanupDir !== undefined) await fsp.rm(cleanupDir, { recursive: true, force: true }).catch(() => {});
    if (error instanceof Error && error.name === 'AbortError') throw new Error(`download timed out after ${Math.round(options.timeoutMs / 1000)} s: ${url}`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Fence a block for markdown, escaping any embedded fence. */
function fenced(value) {
  return ['```', String(value).replace(/```/g, '``\\`'), '```'];
}

/**
 * Build every tool definition.
 *
 * @param {any} ctx - the Cordis plugin context.
 * @param {{ service: Record<string, any>, options: () => { defaultHost: string, maxOutputBytes: number } }} env - the shared environment.
 * @returns {any[]} tool definitions.
 */
export function buildTools(ctx, env) {
  const { service, options } = env;

  /** The `profile` output node, shared by several tools. */
  const profileNode = obj(
    {
      name: prop('string'),
      host: prop('string'),
      port: prop('number'),
      user: prop('string'),
      auth: prop('string', '"password" or "key"'),
      privateKeyPath: prop('string', 'Local path of the private key, or an empty string.'),
      note: prop('string'),
      defaultRemoteDir: prop('string'),
      passwordConfigured: prop('boolean', 'Whether a password is stored in the credential store.'),
      updatedAt: prop('string', 'ISO timestamp of the last change.'),
    },
    ['name', 'host', 'port', 'user', 'auth', 'privateKeyPath', 'note', 'defaultRemoteDir', 'passwordConfigured', 'updatedAt'],
  );

  /** Render a markdown table of servers. */
  function renderServerTable(servers) {
    const lines = ['| 名称 | 地址 | 用户 | 认证 | 密码 | 备注 |', '| --- | --- | --- | --- | --- | --- |'];
    for (const server of servers) {
      const auth = server.auth === 'key' ? '密钥' : '密码';
      const password = server.auth === 'key' ? '—' : server.passwordConfigured ? '已配置' : '⚠️ 未配置';
      lines.push(`| ${cell(server.name)} | ${cell(server.host)}:${cell(server.port)} | ${cell(server.user)} | ${auth} | ${password} | ${cell(server.note)} |`);
    }
    return lines.join('\n');
  }

  // ───────────────────────────────────────────────────────────────────────────
  // ssh_host
  // ───────────────────────────────────────────────────────────────────────────
  const sshHost = {
    name: 'ssh_host',
    description:
      'Manage named SSH servers. Actions: "list" (default) shows every saved server and whether its password is stored; "show" describes one; ' +
      '"add" saves one; "update" changes fields; "remove" deletes it; "password" stores or replaces a password; "test" connects and reports hostname/uptime. ' +
      'A saved server is only a description: the password is kept in the dsh credential store, never in the profile file, and never appears in a tool result. ' +
      'Passing a `password` here also writes it into this session transcript, so prefer the plugin settings page for a sensitive password. ' +
      'Call this first on a new machine; every other ssh_* tool refers to a saved server by name.',
    parameters: obj({
      action: enumProp(['list', 'show', 'add', 'update', 'remove', 'password', 'test'], 'What to do. Defaults to "list".'),
      name: prop('string', 'Server name (letters, digits, dot, underscore, dash; at most 64 chars). Required except for "list".'),
      host: prop('string', 'Hostname or IP address. Required for "add".'),
      port: prop('number', 'SSH port. Defaults to 22.'),
      user: prop('string', 'Login user. Required for "add".'),
      auth: enumProp(['password', 'key'], 'Authentication kind. Defaults to "password".'),
      password: prop('string', 'Password to store (add/update/password). Visible in the session transcript.'),
      privateKeyPath: prop('string', 'Local path of a private key (auth="key").'),
      passphrase: prop('string', 'Private key passphrase, stored in the credential store (auth="key").'),
      note: prop('string', 'Free-form description, e.g. "AutoDL GPU 训练机".'),
      defaultRemoteDir: prop('string', 'Default directory for relative upload/download paths, e.g. "/root/autodl-tmp".'),
    }),
    output: {
      schema: obj(
        {
          ok: prop('boolean', 'False when the action failed; `summary` then explains why.'),
          action: prop('string'),
          summary: prop('string', 'Human-readable verdict; render this verbatim.'),
          servers: arr(profileNode),
          profile: profileNode,
          test: obj({ hostname: prop('string'), platform: prop('string'), uptime: prop('string'), latencyMs: prop('number') }, [
            'hostname',
            'platform',
            'uptime',
            'latencyMs',
          ]),
        },
        ['ok', 'action', 'summary', 'servers'],
      ),
      render: (_args, value) => text(value.summary),
    },
    async execute(args) {
      const action = typeof args.action === 'string' && args.action !== '' ? args.action : 'list';
      try {
        if (action === 'list') {
          const servers = await service.listServers();
          if (servers.length === 0) {
            return {
              ok: true,
              action,
              servers,
              summary: '还没有保存任何服务器。\n\n用 `ssh_host action="add" name="…" host="…" user="…" password="…"` 添加，或从「设置 → 插件 → SSH 服务器」页面添加。',
            };
          }
          const lines = [`已保存 ${servers.length} 台服务器：`, '', renderServerTable(servers)];
          if (options().defaultHost !== '') lines.push('', `默认服务器：\`${options().defaultHost}\``);
          lines.push('', '提示：`ssh_host action="test" name="…"` 可验证连通性。');
          return { ok: true, action, servers, summary: lines.join('\n') };
        }

        const name = typeof args.name === 'string' ? args.name.trim() : '';
        if (name === '') return { ok: false, action, servers: [], summary: '❌ 这个 action 需要 `name`。' };

        if (action === 'show') {
          const view = await service.getServer(name);
          const lines = [
            `## \`${view.name}\``,
            '',
            `- 地址：${view.host}:${view.port}`,
            `- 用户：${view.user}`,
            `- 认证：${view.auth === 'key' ? `密钥 \`${view.privateKeyPath}\`` : `密码（${view.passwordConfigured ? '已配置' : '⚠️ 未配置'}）`}`,
            `- 默认远端目录：${view.defaultRemoteDir === '' ? '（未设置）' : `\`${view.defaultRemoteDir}\``}`,
            `- 备注：${view.note === '' ? '（无）' : view.note}`,
          ];
          const all = await service.listServers();
          return { ok: true, action, servers: all, profile: view, summary: lines.join('\n') };
        }

        if (action === 'add' || action === 'update') {
          const input = { name };
          for (const key of ['host', 'port', 'user', 'auth', 'privateKeyPath', 'note', 'defaultRemoteDir', 'password', 'passphrase']) {
            if (args[key] !== undefined) input[key] = args[key];
          }
          const view = action === 'add' ? await service.addServer(input) : await service.updateServer(input);
          const stored = typeof args.password === 'string' && args.password !== '';
          return {
            ok: true,
            action,
            servers: await service.listServers(),
            profile: view,
            summary:
              `${action === 'add' ? '✅ 已添加' : '✅ 已更新'}服务器 \`${view.name}\` → ${view.host}:${view.port}（${view.user}）` +
              (stored ? '\n\n密码已存入凭据库：不会写入 servers.json，也不会出现在工具返回里。' : '') +
              (view.auth === 'password' && !view.passwordConfigured ? '\n\n⚠️ 这台服务器还没有密码。用 `ssh_host action="password"` 或设置页补上。' : ''),
          };
        }

        if (action === 'remove') {
          const result = await service.removeServer(name);
          return { ok: true, action, servers: await service.listServers(), summary: result.removed ? `✅ 已删除服务器 \`${name}\`。` : `⚠️ 没有名为 \`${name}\` 的服务器。` };
        }

        if (action === 'password') {
          const password = typeof args.password === 'string' ? args.password : '';
          if (password === '') return { ok: false, action, servers: [], summary: '❌ `password` 不能为空。' };
          const view = await service.setPassword(name, password);
          return { ok: true, action, servers: await service.listServers(), profile: view, summary: `✅ 已更新 \`${name}\` 的密码（存于凭据库，不写入 servers.json）。` };
        }

        if (action === 'test') {
          const test = await service.testServer(name);
          return {
            ok: true,
            action,
            servers: await service.listServers(),
            test,
            summary: `✅ 连通 ${name}（${test.latencyMs} ms）\n\n- 主机名：${test.hostname}\n- 系统：${test.platform}\n- 运行时长：${test.uptime}`,
          };
        }

        return { ok: false, action, servers: [], summary: `❌ 未知 action：${String(action)}` };
      } catch (error) {
        return { ok: false, action, servers: [], summary: `❌ ${errorText(error)}` };
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `SSH 服务器：${String(args.action ?? 'list')}${args.name === undefined ? '' : ` ${String(args.name)}`}`,
      kind: args.action === 'remove' ? 'delete' : args.action === 'list' || args.action === 'show' ? 'read' : 'execute',
    }),
  };

  // ───────────────────────────────────────────────────────────────────────────
  // ssh_exec
  // ───────────────────────────────────────────────────────────────────────────
  /** The zero-value shape `ssh_exec` returns on a failure path. */
  function execFailure(host, target, command, summary) {
    return {
      ok: false,
      host,
      target,
      command,
      stdout: '',
      stderr: '',
      exitCode: -1,
      signal: '',
      timedOut: false,
      stdoutBytes: 0,
      stderrBytes: 0,
      stdoutTruncated: false,
      stderrTruncated: false,
      durationMs: 0,
      summary,
    };
  }

  const sshExec = {
    name: 'ssh_exec',
    description:
      'Run one shell command on a saved SSH server and return its stdout, stderr and exit code. ' +
      'The command runs through a POSIX shell as the login user; `cwd` is applied first. ' +
      'Use it for anything short: inspecting the machine (`nvidia-smi`, `df -h`, `ps aux`), installing packages, compiling, or one-off python invocations. ' +
      'For anything that may outlive one call — training, long downloads — use ssh_job instead, so the connection does not have to stay open. ' +
      'Output is capped (default 64 KiB per stream): the head is kept and truncation is reported, so a huge log cannot flood the transcript.',
    parameters: obj(
      {
        host: prop('string', 'Saved server name. Optional when a default host is configured or only one server exists.'),
        command: prop('string', 'Shell command to run, written for bash/sh.'),
        cwd: prop('string', 'Directory to cd into before running. `~` and relative paths resolve against the login home. Optional.'),
        timeoutSec: prop('number', 'Abort after this many seconds (default 120). The remote process may keep running.'),
        maxOutputBytes: prop('number', 'Per-stream output cap in bytes (default 65536).'),
      },
      ['command'],
    ),
    output: {
      schema: obj(
        {
          ok: prop('boolean', 'True when the command exited 0 and was not aborted.'),
          host: prop('string'),
          target: prop('string', '"user@host:port".'),
          command: prop('string'),
          stdout: prop('string'),
          stderr: prop('string'),
          exitCode: prop('number', '-1 when unknown (killed by a signal or aborted).'),
          signal: prop('string', 'Signal name, or an empty string.'),
          timedOut: prop('boolean'),
          stdoutBytes: prop('number', 'Total bytes received before truncation.'),
          stderrBytes: prop('number'),
          stdoutTruncated: prop('boolean'),
          stderrTruncated: prop('boolean'),
          durationMs: prop('number'),
          summary: prop('string'),
        },
        [
          'ok',
          'host',
          'target',
          'command',
          'stdout',
          'stderr',
          'exitCode',
          'signal',
          'timedOut',
          'stdoutBytes',
          'stderrBytes',
          'stdoutTruncated',
          'stderrTruncated',
          'durationMs',
          'summary',
        ],
      ),
      render: (_args, value) => {
        const parts = [value.summary];
        if (value.stdout !== '') parts.push('', ...fenced(value.stdout));
        if (value.stderr !== '') parts.push('', '**stderr**', ...fenced(value.stderr));
        return text(parts.join('\n'));
      },
    },
    async execute(args) {
      const opts = options();
      let hostName = '';
      try {
        const profile = service.resolveProfileFromArgs(args);
        hostName = String(profile.name);
        const client = await service.clientFor(profile);
        // `cwd` follows shell semantics: `~` and relative paths resolve against
        // the login home, not against `defaultRemoteDir` (that one is for
        // upload/download destinations). Resolving here also keeps `~` out of the
        // quoted `cd` below, where single quotes would stop it from expanding.
        const rawCwd = typeof args.cwd === 'string' ? args.cwd.trim() : '';
        const cwd = rawCwd === '' ? '' : resolveRemotePath(rawCwd, '~', await resolveHome(client));
        const result = await execCommand(client, String(args.command ?? ''), {
          cwd,
          timeoutMs: typeof args.timeoutSec === 'number' && args.timeoutSec > 0 ? Math.round(args.timeoutSec * 1000) : 120000,
          maxOutputBytes: typeof args.maxOutputBytes === 'number' && args.maxOutputBytes > 0 ? Math.round(args.maxOutputBytes) : opts.maxOutputBytes,
        });
        const ok = result.exitCode === 0 && !result.timedOut;
        const target = `${profile.user}@${profile.host}:${profile.port}`;
        const head = ok
          ? `✅ ${target} · 退出码 0 · ${result.durationMs} ms`
          : result.timedOut
            ? `⏱️ ${target} · 超时中止（远端进程可能仍在运行）· ${result.durationMs} ms`
            : `❌ ${target} · 退出码 ${result.exitCode === null ? '未知' : result.exitCode}${result.signal === null ? '' : ` · 信号 ${result.signal}`} · ${result.durationMs} ms`;
        const notes = [];
        if (result.stdoutTruncated) notes.push(`stdout 原有 ${humanBytes(result.stdoutBytes)}，已截断到 ${humanBytes(result.stdoutBytes - 0)} 以内`);
        if (result.stderrTruncated) notes.push(`stderr 原有 ${humanBytes(result.stderrBytes)}，已截断`);
        if (notes.length > 0) notes.push('需要完整输出时，把输出重定向到远端文件再用 ssh_download 取回，或改用 ssh_job。');
        return {
          ok,
          host: hostName,
          target,
          command: String(args.command ?? ''),
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode === null ? -1 : result.exitCode,
          signal: result.signal === null ? '' : result.signal,
          timedOut: result.timedOut,
          stdoutBytes: result.stdoutBytes,
          stderrBytes: result.stderrBytes,
          stdoutTruncated: result.stdoutTruncated,
          stderrTruncated: result.stderrTruncated,
          durationMs: result.durationMs,
          summary: [head, ...notes].join('\n'),
        };
      } catch (error) {
        return execFailure(hostName, '', String(args.command ?? ''), `❌ ${errorText(error)}`);
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `SSH 执行${args.host === undefined ? '' : ` @${String(args.host)}`}：${String(args.command ?? '').slice(0, 40)}`,
      kind: 'execute',
    }),
  };

  // ───────────────────────────────────────────────────────────────────────────
  // ssh_upload / ssh_download
  // ───────────────────────────────────────────────────────────────────────────
  const transferNode = obj(
    {
      ok: prop('boolean'),
      host: prop('string'),
      target: prop('string'),
      direction: prop('string', '"upload" or "download".'),
      localPath: prop('string'),
      remotePath: prop('string'),
      kind: prop('string', '"file" or "directory".'),
      files: prop('number', 'Files transferred.'),
      bytes: prop('number', 'Bytes transferred.'),
      durationMs: prop('number'),
      summary: prop('string'),
    },
    ['ok', 'host', 'target', 'direction', 'localPath', 'remotePath', 'kind', 'files', 'bytes', 'durationMs', 'summary'],
  );

  const sshUpload = {
    name: 'ssh_upload',
    description:
      'Upload a local file or directory tree to a saved SSH server over SFTP. ' +
      'Point `localPath` at a file or a directory; a directory is walked recursively and its structure recreated under `remotePath`. ' +
      'Relative `remotePath` values resolve against the server\'s default remote directory. Missing remote directories are created. ' +
      'Typical use: push a dataset, a config, or a checkpoint to the remote machine. ' +
      'For a large dataset, prefer uploading one archive and unpacking it with ssh_exec — SFTP moves many small files slowly.',
    parameters: obj(
      {
        host: prop('string', 'Saved server name. Optional when a default host is configured or only one server exists.'),
        localPath: prop('string', 'Absolute local path of a file or directory.'),
        remotePath: prop('string', 'Remote destination path. Relative paths use the server default directory.'),
      },
      ['localPath', 'remotePath'],
    ),
    output: { schema: transferNode, render: (_args, value) => text(value.summary) },
    async execute(args) {
      const started = Date.now();
      try {
        const profile = service.resolveProfileFromArgs(args);
        const localPath = path.resolve(String(args.localPath ?? ''));
        let stats;
        try {
          stats = fs.statSync(localPath);
        } catch {
          throw new Error(`本地路径不存在：${localPath}`);
        }
        const client = await service.clientFor(profile);
        const remotePath = resolveRemotePath(String(args.remotePath ?? ''), profile.defaultRemoteDir, await resolveHome(client));
        const result = await withSftp(client, async (sftp) => {
          if (stats.isDirectory()) {
            const totals = await uploadDirectory(sftp, localPath, remotePath);
            return { kind: 'directory', files: totals.files, bytes: totals.bytes };
          }
          return { kind: 'file', files: 1, bytes: await uploadFile(sftp, localPath, remotePath) };
        });
        const durationMs = Date.now() - started;
        return {
          ok: true,
          host: String(profile.name),
          target: `${profile.user}@${profile.host}:${profile.port}`,
          direction: 'upload',
          localPath,
          remotePath,
          kind: result.kind,
          files: result.files,
          bytes: result.bytes,
          durationMs,
          summary: `✅ 已上传 ${result.kind === 'directory' ? `目录（${result.files} 个文件）` : '文件'} → ${profile.user}@${profile.host}:${remotePath}\n- 传输：${humanBytes(result.bytes)} · 耗时 ${durationMs} ms`,
        };
      } catch (error) {
        return {
          ok: false,
          host: '',
          target: '',
          direction: 'upload',
          localPath: String(args.localPath ?? ''),
          remotePath: String(args.remotePath ?? ''),
          kind: 'file',
          files: 0,
          bytes: 0,
          durationMs: Date.now() - started,
          summary: `❌ ${errorText(error)}`,
        };
      }
    },
    presentCall: (args) => ({ card: 'generic', title: `SSH 上传：${String(args.localPath ?? '').slice(-40)}`, kind: 'execute' }),
  };

  const sshDownload = {
    name: 'ssh_download',
    description:
      'Download a remote file or directory tree from a saved SSH server over SFTP. ' +
      'Point `remotePath` at a file or a directory; a directory is walked recursively and its structure recreated under `localPath`. ' +
      'Relative `remotePath` values resolve against the server\'s default remote directory. Missing local directories are created. ' +
      'Typical use: pull a training log, a checkpoint, or a generated report back into the workspace.',
    parameters: obj(
      {
        host: prop('string', 'Saved server name. Optional when a default host is configured or only one server exists.'),
        remotePath: prop('string', 'Remote file or directory path. Relative paths use the server default directory.'),
        localPath: prop('string', 'Absolute local destination path.'),
      },
      ['remotePath', 'localPath'],
    ),
    output: { schema: transferNode, render: (_args, value) => text(value.summary) },
    async execute(args) {
      const started = Date.now();
      try {
        const profile = service.resolveProfileFromArgs(args);
        const localPath = path.resolve(String(args.localPath ?? ''));
        const client = await service.clientFor(profile);
        const remotePath = resolveRemotePath(String(args.remotePath ?? ''), profile.defaultRemoteDir, await resolveHome(client));
        const result = await withSftp(client, async (sftp) => {
          const attrs = await new Promise((resolve, reject) => {
            sftp.stat(remotePath, (error, stats) => {
              if (error !== undefined && error !== null) reject(new Error(`远端路径不存在或不可读：${remotePath}（${describeSshError(error)}）`));
              else resolve(stats);
            });
          });
          const isDirectory = attrs !== null && attrs !== undefined && typeof attrs.isDirectory === 'function' ? attrs.isDirectory() : false;
          if (isDirectory) {
            const totals = await downloadDirectory(sftp, remotePath, localPath);
            return { kind: 'directory', files: totals.files, bytes: totals.bytes };
          }
          return { kind: 'file', files: 1, bytes: await downloadFile(sftp, remotePath, localPath) };
        });
        const durationMs = Date.now() - started;
        return {
          ok: true,
          host: String(profile.name),
          target: `${profile.user}@${profile.host}:${profile.port}`,
          direction: 'download',
          localPath,
          remotePath,
          kind: result.kind,
          files: result.files,
          bytes: result.bytes,
          durationMs,
          summary: `✅ 已下载 ${result.kind === 'directory' ? `目录（${result.files} 个文件）` : '文件'} → ${localPath}\n- 来源：${profile.user}@${profile.host}:${remotePath}\n- 传输：${humanBytes(result.bytes)} · 耗时 ${durationMs} ms`,
        };
      } catch (error) {
        return {
          ok: false,
          host: '',
          target: '',
          direction: 'download',
          localPath: String(args.localPath ?? ''),
          remotePath: String(args.remotePath ?? ''),
          kind: 'file',
          files: 0,
          bytes: 0,
          durationMs: Date.now() - started,
          summary: `❌ ${errorText(error)}`,
        };
      }
    },
    presentCall: (args) => ({ card: 'generic', title: `SSH 下载：${String(args.remotePath ?? '').slice(-40)}`, kind: 'execute' }),
  };

  // ───────────────────────────────────────────────────────────────────────────
  // ssh_fetch
  // ───────────────────────────────────────────────────────────────────────────
  const fetchNode = obj(
    {
      ok: prop('boolean'),
      host: prop('string'),
      target: prop('string', '"user@host:port".'),
      url: prop('string'),
      remotePath: prop('string', 'Absolute remote path that received the file.'),
      mode: prop('string', '"local-relay" (downloaded here, then uploaded) or "remote-direct" (downloaded on the server).'),
      bytes: prop('number', 'File size in bytes.'),
      durationMs: prop('number'),
      summary: prop('string'),
    },
    ['ok', 'host', 'target', 'url', 'remotePath', 'mode', 'bytes', 'durationMs', 'summary'],
  );

  const sshFetch = {
    name: 'ssh_fetch',
    description:
      'Place a file from a URL onto a saved SSH server — the usual way to get a dataset or model checkpoint onto a rented GPU box. ' +
      'Two modes. "local-relay" (the default) downloads the file on the machine running dsh, then uploads it over SFTP; use it when the server\'s outbound network is slow, rate-limited or blocked, or when this machine has a proxy that does. ' +
      '"remote-direct" runs curl/wget on the server itself; it is faster for a large file on a well-connected host and needs no local disk. ' +
      'The default is controlled by the "preferLocalRelay" plugin setting; pass `mode` to override it for one call. ' +
      'Relative `remotePath` values resolve against the server default directory.',
    parameters: obj(
      {
        host: prop('string', 'Saved server name. Optional when a default host is configured or only one server exists.'),
        url: prop('string', 'Absolute http(s) URL of the file to fetch.'),
        remotePath: prop('string', 'Remote destination path (file). Relative paths use the server default directory.'),
        mode: enumProp(['auto', 'local-relay', 'remote-direct'], 'How to transfer. "auto" (default) follows the plugin setting.'),
        timeoutSec: prop('number', 'Budget for the whole operation, in seconds (default 600).'),
      },
      ['url', 'remotePath'],
    ),
    output: { schema: fetchNode, render: (_args, value) => text(value.summary) },
    async execute(args) {
      const started = Date.now();
      const opts = options();
      const timeoutMs = typeof args.timeoutSec === 'number' && args.timeoutSec > 0 ? Math.round(args.timeoutSec * 1000) : 600000;
      const url = String(args.url ?? '').trim();
      let host = '';
      let target = '';
      let mode = opts.preferLocalRelay ? 'local-relay' : 'remote-direct';
      try {
        if (!/^https?:\/\//i.test(url)) throw new Error('`url` must be an absolute http(s) URL');
        const profile = service.resolveProfileFromArgs(args);
        host = String(profile.name);
        target = `${profile.user}@${profile.host}:${profile.port}`;
        const requested = typeof args.mode === 'string' ? args.mode.trim() : '';
        // The registry validates parameters against this schema in principle, but
        // the shipped runtime does not enforce `enum` (measured: an out-of-enum
        // `mode` reaches `execute`). Falling back silently would let a caller
        // believe a mode took effect when it did not, so an unknown value is an
        // explicit error here.
        if (requested !== '' && requested !== 'auto') {
          if (requested !== 'local-relay' && requested !== 'remote-direct') {
            throw new Error(`\`mode\` 必须是 auto、local-relay 或 remote-direct 之一，收到 ${JSON.stringify(requested)}`);
          }
          mode = requested;
        }

        const client = await service.clientFor(profile);
        const remoteTarget = resolveRemotePath(String(args.remotePath ?? ''), profile.defaultRemoteDir, await resolveHome(client));

        if (mode === 'local-relay') {
          const downloaded = await downloadUrlToTemp(url, { timeoutMs });
          try {
            const bytes = await withSftp(client, async (sftp) => await uploadFile(sftp, downloaded.file, remoteTarget));
            const durationMs = Date.now() - started;
            return {
              ok: true,
              host,
              target,
              url,
              remotePath: remoteTarget,
              mode,
              bytes,
              durationMs,
              summary: `✅ 已经从本机中转上传 → ${target}:${remoteTarget}\n- 大小：${humanBytes(bytes)} · 耗时 ${durationMs} ms · 模式：本地下载后上传`,
            };
          } finally {
            await downloaded.cleanup();
          }
        }

        // remote-direct: curl if present, else wget. The URL and path are quoted
        // separately so a URL containing `&` or `?` cannot split the command.
        const probe = await execCommand(client, 'if command -v curl >/dev/null 2>&1; then echo curl; elif command -v wget >/dev/null 2>&1; then echo wget; else echo none; fi', {
          timeoutMs: 20000,
        });
        const tool = probe.stdout.trim();
        if (tool !== 'curl' && tool !== 'wget') {
          throw new Error(`服务器 ${target} 上既没有 curl 也没有 wget，无法在服务器直接下载；改用 mode="local-relay"（默认）`);
        }
        await withSftp(client, async (sftp) => {
          const parent = path.posix.dirname(remoteTarget);
          if (parent !== '.' && parent !== '/') await mkdirp(sftp, parent);
        });
        const command =
          tool === 'curl'
            ? `curl -fsSL --retry 2 --connect-timeout 30 -o ${shellQuote(remoteTarget)} ${shellQuote(url)}`
            : `wget -q -O ${shellQuote(remoteTarget)} ${shellQuote(url)}`;
        const fetched = await execCommand(client, command, { timeoutMs, maxOutputBytes: 8192 });
        if (fetched.exitCode !== 0) {
          throw new Error(`服务器上 ${tool} 下载失败（exit ${fetched.exitCode === null ? '未知' : fetched.exitCode}）：${fetched.stderr.trim() || fetched.stdout.trim() || '无输出'}`);
        }
        const size = await withSftp(client, async (sftp) => {
          const attrs = await new Promise((resolve, reject) => {
            sftp.stat(remoteTarget, (error, stats) => {
              if (error !== undefined && error !== null) reject(new Error(`下载后无法读取 ${remoteTarget}：${describeSshError(error)}`));
              else resolve(stats);
            });
          });
          return attrs !== null && attrs !== undefined && typeof attrs.size === 'number' ? attrs.size : 0;
        });
        const durationMs = Date.now() - started;
        return {
          ok: true,
          host,
          target,
          url,
          remotePath: remoteTarget,
          mode,
          bytes: size,
          durationMs,
          summary: `✅ 已经在服务器直接下载 → ${target}:${remoteTarget}\n- 大小：${humanBytes(size)} · 耗时 ${durationMs} ms · 模式：服务器直接下载（${tool}）`,
        };
      } catch (error) {
        return {
          ok: false,
          host,
          target,
          url,
          remotePath: String(args.remotePath ?? ''),
          mode,
          bytes: 0,
          durationMs: Date.now() - started,
          summary: `❌ ${errorText(error)}`,
        };
      }
    },
    presentCall: (args) => ({ card: 'generic', title: `SSH 取文件：${String(args.url ?? '').slice(-50)}`, kind: 'execute' }),
  };

  // ───────────────────────────────────────────────────────────────────────────
  // ssh_job
  // ───────────────────────────────────────────────────────────────────────────
  const jobStartNode = obj(
    {
      jobId: prop('string'),
      dir: prop('string'),
      pid: prop('number', '-1 when the launcher could not report a PID yet.'),
      logFile: prop('string'),
      startedAt: prop('string', 'ISO timestamp.'),
    },
    ['jobId', 'dir', 'pid', 'logFile', 'startedAt'],
  );

  const jobStatusNode = obj(
    {
      jobId: prop('string'),
      state: prop('string', '"running" | "exited" | "unknown"'),
      exitCode: prop('number', '-1 when not exited or unknown.'),
      pid: prop('number', '-1 when not running.'),
      logBytes: prop('number'),
    },
    ['jobId', 'state', 'exitCode', 'pid', 'logBytes'],
  );

  const sshJob = {
    name: 'ssh_job',
    description:
      'Start and manage a long-running remote command as a detached job — the tool for training runs, long builds and big downloads. ' +
      'Unlike ssh_exec, a job survives the tool call: it runs under `setsid nohup`, writes stdout+stderr to its own log file and records its own exit code, ' +
      'so later calls can poll it without keeping a connection open. ' +
      'Actions: "start" (command, label?, cwd?) returns a jobId; "status" reports running/exited with the exit code; "log" returns new output from a byte offset; ' +
      '"stop" terminates the process group; "list" lists this server\'s jobs. ' +
      'Typical loop: start the training command, then poll status/log every so often — no need to hold a session open, no need to re-run anything after a disconnect.',
    parameters: obj({
      action: enumProp(['start', 'status', 'log', 'stop', 'list'], 'What to do. Defaults to "list".'),
      host: prop('string', 'Saved server name. Optional when a default host is configured or only one server exists.'),
      jobId: prop('string', 'Job id from action="start". Required for status/log/stop.'),
      command: prop('string', 'Shell command to run (action="start").'),
      label: prop('string', 'Short label used to build a readable job id, e.g. "train".'),
      cwd: prop('string', 'Directory to cd into before running (action="start").'),
      offset: prop('number', 'Byte offset to read the log from (action="log"). Use nextOffset from the previous reply.'),
      maxBytes: prop('number', 'Maximum bytes of log to return (action="log"), default 65536.'),
    }),
    output: {
      schema: obj(
        {
          ok: prop('boolean'),
          action: prop('string'),
          host: prop('string'),
          target: prop('string'),
          summary: prop('string'),
          job: jobStartNode,
          status: jobStatusNode,
          log: obj(
            {
              jobId: prop('string'),
              chunk: prop('string'),
              offset: prop('number'),
              totalBytes: prop('number'),
              nextOffset: prop('number'),
              truncated: prop('boolean'),
            },
            ['jobId', 'chunk', 'offset', 'totalBytes', 'nextOffset', 'truncated'],
          ),
          jobs: arr(jobStatusNode),
        },
        ['ok', 'action', 'host', 'target', 'summary'],
      ),
      render: (_args, value) => {
        const parts = [value.summary];
        if (value.log !== undefined && value.log.chunk !== '') parts.push('', ...fenced(value.log.chunk));
        return text(parts.join('\n'));
      },
    },
    async execute(args) {
      const action = typeof args.action === 'string' && args.action !== '' ? args.action : 'list';
      try {
        const opts = options();
        const profile = service.resolveProfileFromArgs(args);
        const host = String(profile.name);
        const target = `${profile.user}@${profile.host}:${profile.port}`;
        const client = await service.clientFor(profile);
        const jobs = service.jobs;

        if (action === 'start') {
          const command = typeof args.command === 'string' ? args.command : '';
          if (command.trim() === '') return { ok: false, action, host, target, summary: '❌ action="start" 需要 `command`。' };
          const handle = await jobs.start(client, {
            command,
            label: typeof args.label === 'string' ? args.label : '',
            cwd: typeof args.cwd === 'string' ? args.cwd : '',
          });
          return {
            ok: true,
            action,
            host,
            target,
            job: { jobId: handle.jobId, dir: handle.dir, pid: handle.pid === null ? -1 : handle.pid, logFile: handle.logFile, startedAt: handle.startedAt },
            summary:
              `✅ 已在 ${target} 启动后台任务 \`${handle.jobId}\`（PID ${handle.pid === null ? '未知' : handle.pid}）\n` +
              `- 日志：\`${handle.logFile}\`\n` +
              `- 用 \`ssh_job action="status" jobId="${handle.jobId}"\` 看状态，用 \`action="log"\` 读输出。`,
          };
        }

        if (action === 'list') {
          const list = await jobs.list(client);
          if (list.length === 0) return { ok: true, action, host, target, summary: `ℹ️ ${target} 上没有由 dsh-ssh 启动的任务。`, jobs: [] };
          const lines = [`${target} 上的任务（${list.length} 个）：`, '', '| jobId | 状态 | 退出码 | 日志大小 |', '| --- | --- | --- | --- |'];
          for (const entry of list) {
            lines.push(
              `| ${cell(entry.jobId)} | ${entry.state === 'running' ? '运行中' : entry.state === 'exited' ? '已结束' : '未知'} | ${entry.exitCode < 0 ? '—' : entry.exitCode} | ${humanBytes(entry.logBytes)} |`,
            );
          }
          return { ok: true, action, host, target, summary: lines.join('\n'), jobs: list };
        }

        const jobId = typeof args.jobId === 'string' ? args.jobId.trim() : '';
        if (jobId === '') return { ok: false, action, host, target, summary: '❌ 这个 action 需要 `jobId`。' };

        if (action === 'status') {
          const status = await jobs.status(client, jobId);
          if (status.state === 'running') {
            return {
              ok: true,
              action,
              host,
              target,
              status,
              summary: `ℹ️ 任务 \`${jobId}\` 正在运行（PID ${status.pid}）· 日志 ${humanBytes(status.logBytes)}\n- 用 \`ssh_job action="log" jobId="${jobId}"\` 读取新输出。`,
            };
          }
          if (status.state === 'exited') {
            const exitedOk = status.exitCode === 0;
            return {
              ok: exitedOk,
              action,
              host,
              target,
              status,
              summary: `${exitedOk ? '✅' : '❌'} 任务 \`${jobId}\` 已结束，退出码 ${status.exitCode} · 日志 ${humanBytes(status.logBytes)}\n- 用 \`ssh_job action="log" jobId="${jobId}"\` 读取输出。`,
            };
          }
          return {
            ok: false,
            action,
            host,
            target,
            status,
            summary: `⚠️ 任务 \`${jobId}\` 状态未知（没有 PID 文件，或进程已消失，通常是机器重启过）。action="log" 仍可读到已有日志。`,
          };
        }

        if (action === 'log') {
          const slice = await jobs.log(client, jobId, {
            offset: typeof args.offset === 'number' ? args.offset : 0,
            maxBytes: typeof args.maxBytes === 'number' && args.maxBytes > 0 ? args.maxBytes : opts.maxOutputBytes,
          });
          const status = await jobs.status(client, jobId);
          const lines = [
            `日志 \`${jobId}\` · 第 ${slice.offset} 字节起 ${humanBytes(Buffer.byteLength(slice.chunk, 'utf8'))} / 共 ${humanBytes(slice.totalBytes)}${slice.truncated ? '（还有更多，继续用 nextOffset）' : ''}`,
            `- 状态：${status.state === 'running' ? `运行中（PID ${status.pid}）` : status.state === 'exited' ? `已结束，退出码 ${status.exitCode}` : '未知'}`,
            `- nextOffset：${slice.nextOffset}`,
          ];
          return { ok: true, action, host, target, log: slice, status, summary: lines.join('\n') };
        }

        if (action === 'stop') {
          const outcome = await jobs.stop(client, jobId);
          if (outcome.stopped) {
            return { ok: true, action, host, target, summary: `✅ 已向任务 \`${jobId}\` 的进程组发送 SIGTERM（PID ${outcome.pid}）。` };
          }
          return { ok: false, action, host, target, summary: `⚠️ 任务 \`${jobId}\` 没有可终止的进程（可能已结束）。用 action="status" 确认。` };
        }

        return { ok: false, action, host, target, summary: `❌ 未知 action：${String(action)}` };
      } catch (error) {
        return { ok: false, action, host: '', target: '', summary: `❌ ${errorText(error)}` };
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `SSH 任务：${String(args.action ?? 'list')}${args.jobId === undefined ? '' : ` ${String(args.jobId)}`}`,
      kind: 'execute',
    }),
  };

  return [sshHost, sshExec, sshUpload, sshDownload, sshFetch, sshJob];
}
