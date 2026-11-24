/**
 * dsh-ssh — 随插件注册的 skill（`ssh-remote`）。
 *
 * ## 为什么要有它
 *
 * 六个 `ssh_*` 工具摆在那里，模型并不知道**什么时候该用哪一个**：一条命令直接用
 * `ssh_exec` 就行，训练这种长任务必须走 `ssh_job`，传文件该 `ssh_upload` 还是
 * `ssh_fetch`；还有一条更重要的判断——**目标根本不是远程机器时，这六个工具一个都不该用**。
 * 这些内容放进每个工具的 description 里会重复且太长，所以按 DSH 的技能机制单独注册一份，
 * 模型需要时用 `skill` 工具加载（不加载只占一行 description）。
 *
 * ## 它同时是「按需门控」的开关
 *
 * 1.2.0 起六个工具默认**不进**模型工具表，加载本技能后才从下一步出现
 * （`index.js` 的 `createToolGate`）。所以这份说明书不只是文档，它也是**触发条件**：
 * 正文第一段必须告诉模型"工具是按需的、加载后从下一步出现"。
 *
 * ## 正文为什么放在单独的 .md 文件里
 *
 * 正文大量使用 markdown 行内代码（反引号）。写成 JS 模板字符串时每个反引号都要转义，
 * 漏一个就把模板字符串提前终止、整个插件加载失败。读文件则零转义，也能被编辑器正常预览。
 *
 * @module dsh-ssh/lib/skill
 */

import { readFileSync } from 'node:fs';

/** skill 名（kebab-case，DSH 的 skill 名规则；`skill({ name })` 按名精确匹配）。 */
export const SKILL_NAME = 'ssh-remote';

/** 一行摘要：进技能目录，模型靠它决定要不要加载。 */
export const SKILL_DESCRIPTION =
  '需要连 SSH 服务器执行命令、上传下载文件、跑后台长任务看日志时用：'
  + 'ssh_host 管服务器档案、ssh_exec 跑单条命令、ssh_upload/ssh_download 传文件、'
  + 'ssh_fetch 从 URL 取文件到服务器、ssh_job 起长任务并增量读日志。';

/** 何时该加载（比 description 更具体的使用触发条件）。 */
export const SKILL_WHEN_TO_USE =
  '当任务的目标是**另一台机器**、且要走 SSH 时：在租来的 GPU 服务器上探环境/装包/跑命令、'
  + '把数据集或权重传上去、起训练或编译这类长任务并轮询日志、把产物取回本地。'
  + '只读本地文件、跑本机命令、改本机代码时**不要**用本技能——那些用普通文件与 shell 工具更直接。';

/**
 * skill 正文（markdown，模型加载后才看到）。
 *
 * 读不到文件时回落到一段最小说明——宁可少说，也不能让插件加载失败。
 */
function loadContent() {
  try {
    return readFileSync(new URL('./skill-content.md', import.meta.url), 'utf8');
  } catch (error) {
    return [
      '# SSH 远程操作',
      '',
      '**工具是按需的，加载本技能后从下一步出现**；这一步调不到 `ssh_*` 不代表没有这个能力。',
      '',
      '- 先 `ssh_host { action: "list" }` 看已保存的服务器，`action: "add"` 建档，`action: "test"` 验证；',
      '- 单条命令用 `ssh_exec`，传文件用 `ssh_upload` / `ssh_download`，',
      '  从 URL 取文件用 `ssh_fetch`，长任务用 `ssh_job`（start → status/log → stop）。',
      '',
      `（完整说明书读取失败：${error instanceof Error ? error.message : String(error)}）`,
    ].join('\n');
  }
}

export const SKILL_CONTENT = loadContent();

/** 交给 `ctx.skills.register()` 的定义（`source` 必须显式给，DSH 会校验它是字符串）。 */
export const SKILL_DEFINITION = {
  name: SKILL_NAME,
  description: SKILL_DESCRIPTION,
  whenToUse: SKILL_WHEN_TO_USE,
  content: SKILL_CONTENT,
  source: 'runtime',
  invocation: { modelInvocable: true, userInvocable: true },
};
