# 更新日志

本插件的版本号同时出现在两处：`package.json` 的 `version`（发布版本）与 `index.js` 的 `BUILD`（构建戳，设置页「状态」里显示）。两者在同一次提交里一起更新——设置页显示的版本来自后者。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [1.1.0] - 2026-10-21

### Added

- **第六个工具 `ssh_fetch`**：把 URL 上的文件直接放到服务器——不用先下载到本机再手动上传。两种模式：
  - `local-relay`（默认）：在运行 dsh 的机器上下载（流式落临时文件），再经 SFTP 上传到 `remotePath`，结束后清理临时文件；适合服务器外网慢 / 限速 / 被墙，或本机有代理。
  - `remote-direct`：在服务器上执行 `curl -fL --retry 2 --connect-timeout 30 -o <path> <url>`（没有 `curl` 时用 `wget`；两者都没有则报错并提示改用 `local-relay`）；适合大文件 + 服务器带宽好。
  - 参数：`host?`、`url`（必填，http/https）、`remotePath`（必填，支持 `~`，相对 `defaultRemoteDir`）、`mode?`（`auto` / `local-relay` / `remote-direct`，默认 `auto`）、`timeoutSec?`（默认 600 秒）。
- **新配置 `preferLocalRelay`**（boolean，默认 `true`，`.volatile()`）：`ssh_fetch` 不传 `mode` 时的默认模式（`true` = 本机中转，`false` = 服务器直连）；设置页「默认行为」区有对应开关。
- 版本号 1.1.0 对应 `index.js` 的 `BUILD = '2026-10-21.2'`。

### Known limitations

- `ssh_fetch` 的 `remote-direct` 依赖服务器有 `curl` 或 `wget`；两者都没有时只能用 `local-relay`。
- `ssh_fetch` 的 `local-relay` 要求运行 dsh 的机器能访问该 URL，且下载期间占用本机临时磁盘（约文件大小）。

## [1.0.0] - 2026-10-21

首个公开版本：把「连 SSH 服务器」从每次临时写一个 Python(paramiko) 脚本，变成 dsh 内置的五个工具 + 一个服务器档案库 + 一张设置页。

### Added

- **五个工具**
  - `ssh_host`：服务器档案管理（`list` / `show` / `add` / `update` / `remove` / `password` / `test`），密码只写不读。
  - `ssh_exec`：在已保存的服务器上跑一条命令，返回 stdout / stderr / exitCode，输出按流截断并明确报告截断。
  - `ssh_upload` / `ssh_download`：SFTP 传输文件或整个目录树，缺失的目录自动创建；远端路径支持 `~` 与相对路径（相对 `defaultRemoteDir`，未配置时相对登录 home，`~` 按真实 home 展开）。
  - `ssh_job`：后台长任务（`start` / `status` / `log` / `stop` / `list`），`setsid nohup` 脱离会话，日志按字节偏移增量读取。
- **连接池**：每台服务器复用一条 SSH 连接（keepalive 10 秒）；服务器档案变化或连接断开时自动重连；每条连接最长保持 5 分钟，到期自动回收（`unref`，不挂住进程），下次调用透明重连；插件停用时统一关闭，不泄漏 sshd 会话。
- **后台任务**：远端 `<登录 home>/.dsh-ssh/jobs/<jobId>/`（绝对路径）下写 `run.sh` / `job.pid` / `job.exit` / `job.log`；状态完全靠文件判定，不需要 `pgrep` 或解析进程表。
- **服务器档案**：`<DSH_HOME>/dsh-ssh/servers.json`，原子写入、POSIX 权限 0600；只存描述与凭据引用，不存密码、私钥或口令。
- **两种密码后端**：有 dsh `credentials` 服务时写入凭据库；没有时降级到 `<DSH_HOME>/dsh-ssh/secrets.json`（AES-256-GCM，密钥由机器身份与 DSH_HOME 派生）。
- **设置页**：设置 → 插件 → SSH 服务器；服务器增删改、密码 / 私钥口令（只写不读）、测试连接、状态（版本 / DSH_HOME / servers.json / 密码后端 / 服务器数量）。Host 半通过自定义 RPC 通道 `/dsh-ssh` 提供数据。
- **全局挂载**：`cordis.patch.yml` 把本插件插在顶层，标准模式与创造模式都可以用。
- **配置项**：`defaultHost`、`maxOutputBytes`（默认 65536）、`connectTimeoutMs`（默认 15000），均声明为 `.volatile()`。

### Known limitations

- 远端只支持 POSIX shell（Linux / macOS）；Windows 远端（cmd / PowerShell）未验证，后台任务依赖 `bash`（以及尽可能用 `setsid`）。
- `ssh_exec` 超时只关闭 SSH 通道，**不会杀掉远端进程**；要真正停掉长任务请用 `ssh_job` 的 `stop`。
- 大目录逐文件传输较慢；建议先打包成一个归档再传，用 `ssh_exec` 解包。
- 符号链接：上传目录时跳过；下载目录时按普通文件处理，不保证链接语义。
- 远端 home 由登录 shell 探测（`printf %s "$HOME"`，按连接缓存）；若登录 shell 被限制导致探测失败，涉及 `~` / 相对路径的调用会报错，请改用绝对路径。
- 不支持交互式 TTY：需要现场输入的命令（编辑器、交互式确认）会挂到超时；请改用非交互参数（如 `-y`）。
- 服务器 host key 未做 pinning（`ssh2` 默认接受任意 host key），不防御中间人。
- 删除服务器不会清理凭据库里对应的密码引用。
- 后台任务的 `status` 依赖远端任务目录（`<登录 home>/.dsh-ssh/jobs/`）下的文件；机器重启后可能报 `unknown`（日志仍可读）。`stop` 只发 SIGTERM，不跟进 SIGKILL。
- 降级文件后端不是强安全边界：能读 `secrets.json` 的人也能重新派生密钥。它只防误读与备份泄露。
