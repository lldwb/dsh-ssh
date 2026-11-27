/**
 * dsh-ssh — the `ssh-remote-desktop` skill.
 *
 * ## What it is for
 *
 * Two tools (`ssh_desktop_screen`, `ssh_desktop_action`) cover 16 agent commands.
 * The tools' descriptions stay short; this manual carries the parts the model
 * cannot guess: the **prerequisite** (`dsh-desktop-control` enabled + a logged-in
 * interactive session), the **coordinate contract** (physical pixels, and how to
 * turn a screenshot pixel into a click), why `sequence` exists, and which
 * situations mean "do not use this at all".
 *
 * ## It is also the on-demand trigger
 *
 * The tools are registered behind `{ when }` and only become visible after this
 * skill is loaded (see `index.js`). The body therefore says so explicitly, in the
 * first paragraph — otherwise a model that could not see `ssh_desktop_*` in the
 * very step it loaded the skill concludes the capability does not exist.
 *
 * ## Why the body is a `.md` file
 *
 * The text is full of inline-code backticks. Inside a JS template literal every
 * one of them would need escaping, and one missed escape breaks the whole plugin
 * load. Reading the file avoids the escaping entirely and keeps the manual
 * editable as markdown.
 *
 * @module dsh-ssh/lib/skill-remote-desktop
 */

import { readFileSync } from 'node:fs';

/** Skill name (kebab-case; `skill({ name })` matches it exactly). */
export const REMOTE_DESKTOP_SKILL_NAME = 'ssh-remote-desktop';

/** One-line catalogue entry: the model uses it to decide whether to load. */
export const REMOTE_DESKTOP_SKILL_DESCRIPTION =
  '需要通过 SSH 操作另一台 Windows 电脑的真实桌面时用：截图看屏幕、列出/聚焦窗口、'
  + '鼠标点击拖拽滚轮、键盘输入、UIA 触发控件，并用 sequence 一次完成多步；'
  + '前提是 dsh-desktop-control 已启用且远端有交互式登录会话。';

/** When to load it (more concrete than the description). */
export const REMOTE_DESKTOP_SKILL_WHEN_TO_USE =
  '当目标是一台**已保存的 Windows SSH 服务器**，且要在它的桌面上看界面、点按钮、'
  + '输入文字、操作窗口时。只跑命令/传文件用 ssh-remote（ssh_exec / ssh_job）；'
  + '操作**本机**桌面用 desktop-control（desktop_* 工具）；Linux/macOS 远端不要用本技能。';

/**
 * Load the manual, falling back to a minimal body.
 *
 * A missing file must not break the plugin load: the skill would simply be
 * less detailed, and the tools still carry the prerequisite in their own
 * descriptions.
 *
 * @returns {string} the skill body.
 */
function loadContent() {
  try {
    return readFileSync(new URL('./skill-remote-desktop-content.md', import.meta.url), 'utf8');
  } catch (error) {
    return [
      '# 远程 Windows 桌面（SSH）',
      '',
      '**工具是按需的，加载本技能后从下一步出现**；这一步调不到 `ssh_desktop_*` 不代表没有这个能力。',
      '',
      '- 前提：`dsh-desktop-control` 已启用，远端 Windows 有同账号的交互式登录会话；',
      '- `ssh_desktop_screen`：info / windows / screenshot / ui_dump；',
      '- `ssh_desktop_action`：focus / move / click / drag / scroll / key / text / sequence / ui_invoke / ui_set_value；',
      '- 多步操作用 `sequence`，坐标是远端屏幕的物理像素，截图后用 read_image 验收。',
      '',
      `（完整说明书读取失败：${error instanceof Error ? error.message : String(error)}）`,
    ].join('\n');
  }
}

/** The skill body. */
export const REMOTE_DESKTOP_SKILL_CONTENT = loadContent();

/** The definition handed to `ctx.skills.register()`. */
export const REMOTE_DESKTOP_SKILL_DEFINITION = {
  name: REMOTE_DESKTOP_SKILL_NAME,
  description: REMOTE_DESKTOP_SKILL_DESCRIPTION,
  whenToUse: REMOTE_DESKTOP_SKILL_WHEN_TO_USE,
  content: REMOTE_DESKTOP_SKILL_CONTENT,
  source: 'runtime',
  invocation: { modelInvocable: true, userInvocable: true },
};
