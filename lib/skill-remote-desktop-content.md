# 远程 Windows 桌面（SSH）

用 `ssh_desktop_screen` / `ssh_desktop_action` 操作**另一台 Windows 电脑的真实桌面**（鼠标、键盘、截图、窗口、UI Automation）。

> **工具是按需的，加载本技能后从下一步出现。** 这一步还调不到 `ssh_desktop_*`，不代表没有这个能力：下一步再调。
> 若下一步仍然没有，检查前提——**`dsh-desktop-control` 必须已启用**（它提供桌面代理脚本），
> 且远端 Windows 上该 SSH 账号**当前有交互式登录桌面**。

## 前提（先确认，再动手）

1. 已用 `ssh_host` 保存了目标服务器，`ssh_host action="test" name="…"` 返回 `platform: Windows …`。
2. **`dsh-desktop-control` 已启用**（「设置 → 插件」）。本组件复用它的 `desktop-agent.ps1`，不复制桌面实现；
   未启用时这两个工具不出现，调用也会明确报 `PREREQUISITE_DISABLED`。
3. 远端 Windows 已用**同一个账号**登录（锁屏可以，注销/无会话不行）。检测不到交互式会话时，
   计划任务起不来，会报 `REMOTE_DESKTOP_NO_INTERACTIVE_SESSION` 并给出诊断。
4. 远端是 Windows（Linux/macOS 服务器请直接用 `ssh_exec` / `ssh_job`）。

**原理**：SSH 会话落在 Session 0，没有桌面。本组件在远端创建一个**交互式计划任务**，由它把代理跑进用户会话；
每次工具调用 = 一次「SSH → 起任务 → 代理执行一个动作 → 取回结果」的往返，**约 2–5 秒**。

## 先看，再动

```text
ssh_desktop_screen { action: "info", host: "win-pc" }
ssh_desktop_screen { action: "windows", host: "win-pc", filter: "记事本" }
ssh_desktop_screen { action: "screenshot", host: "win-pc", maxWidth: 0 }
```

- `info`：屏幕/虚拟桌面/显示器（各自 DPI）/光标/前台窗口。**坐标一律是物理像素**，不是系统设置里的逻辑分辨率。
- `windows`：窗口列表（前台优先）。拿 `hwnd` 给后续动作或截图用。
- `screenshot`：远端截图 → 自动取回本机 → 返回 `path`。**用 `read_image` 打开它**，这是唯一可靠的验收证据。
  - `maxWidth: 0` = 不缩放：**图内像素 = 物理像素**，点击坐标 = `frame.x + 图上 x`、`frame.y + 图上 y`（截整屏时 frame 原点就是虚拟桌面原点）。
  - 默认 `maxWidth` 会缩放；缩放时点击坐标 = `frame 原点 + 图上坐标 × scale`。需要精确点击就用 `maxWidth: 0`。
  - 图是空白（`blank: true`）= 远端锁屏/息屏或窗口最小化，不是截图坏了。
- `ui_dump`：窗口的 UI Automation 树（`hwnd` 或 `window` 标题）。用于找到按钮/输入框，走不抢鼠标的 UIA 路线。

## 再动：优先 `sequence`

每次工具调用都要付一次代理启动（约 2–5 秒）。**多步操作放进一个 `sequence`**，不要连续调 4 次工具：

```text
ssh_desktop_action {
  action: "sequence", host: "win-pc",
  window: "记事本", state: "restore",
  steps: [
    { action: "click", x: 400, y: 300 },
    { action: "text", text: "hello 中文" },
    { action: "key", combo: "Ctrl+S" },
    { action: "wait", ms: 800 },
    { action: "key", key: "Enter" }
  ]
}
```

`sequence` 会先聚焦窗口（`window`/`hwnd` + 可选 `state: restore|maximize|minimize`），再按顺序执行
`click` / `key` / `text` / `wait`；失败会中止并把每一步结论放进 `steps`（可加 `continueOnError: true` 继续）。

单步动作（不推荐串着用，除非确实只需要一下）：

| action | 用途 |
|---|---|
| `click` / `move` / `drag` / `scroll` / `down` / `up` | 鼠标；坐标是物理像素；`click` 不传 x/y = 点当前光标 |
| `key` / `text` | 按键（`key` 或 `combo`，如 `Ctrl+C`）与输入文本（`\n` 换行、`\t` Tab） |
| `focus` | 把窗口切到前台（`state` 可 restore/maximize/minimize） |
| `ui_invoke` / `ui_set_value` | 按 UIA 的 name/automationId/controlType 触发控件或写输入框——**不动鼠标、不抢焦点**，比坐标点击更稳 |

每步之后建议 `ssh_desktop_screen action="screenshot"` 复核；没复核就不要宣称操作成功。

## 选择顺序（从最不打扰到最打扰）

1. **UIA**：`ui_dump` 找到控件 → `ui_invoke` / `ui_set_value`。不动光标、不抢前台。
2. **后台/闪点点击**：`click` 默认走阶梯（UIA → 后台消息 → 闪点 → 真实点击），结果里的 `planned` / `attempts` 会告诉你用了哪一档。
3. **真实点击/输入**：上面的都不可用时才落到真实 SendInput；这会动到远端用户的鼠标/键盘。

截图尽量别用 `allowActivate`（会还原并切前台，打扰远端用户）。

## 安全与边界

- 这是**真实用户正在用的桌面**：不要关闭带未保存内容的窗口，不要向不认识的窗口输入密码/令牌等敏感信息。
- 动作前先 `windows` 看前台是谁；`click` 返回的 `coveredByTitle` 与目标窗口不一致，说明点被别的窗口挡住了。
- 远端锁屏时截图是空白、输入可能被安全桌面拦下：先让用户解锁，或 `state: "restore"` 还原窗口再试。
- 本组件**不套用** dsh-desktop-control 的本地白/黑名单与急停文件（那些检查在本机进程里）；远端操作请自己确认目标。
- 远端留下的东西：`%USERPROFILE%\.dsh-ssh\remote-desktop\`（代理脚本 + 启动器）与计划任务
  `dsh-ssh-remote-desktop-*`。任务不会自动运行，只在工具调用时启动；不需要时可手动删除目录与任务。

## 什么时候**不该**加载本技能

- 要操作的是**本机**桌面：用 `dsh-desktop-control` 的 `desktop_*` 工具（加载 `desktop-control` 技能），本组件只管远端。
- 远端是 Linux/macOS：用 `ssh_exec` / `ssh_job`。
- 只想传文件/跑命令：那些是 `ssh_remote` 技能的事，不需要桌面。

## 语义细节

坐标系（物理像素、DPI-aware）、点击阶梯、截图降级档位、多显示器 `frame` 这些语义与 **dsh-desktop-control 完全相同**；
需要更细的说明时加载 `desktop-control` 技能（前提已启用它）。本技能只讲 SSH 远端这条链路的差异：计划任务、会话前提、取回截图与延迟。
