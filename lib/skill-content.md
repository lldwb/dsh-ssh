# SSH 远程操作

用 `ssh_*` 工具在一台**已保存的** SSH 服务器上执行命令、传文件、跑后台长任务。

> **工具是按需的，加载本技能后从下一步出现。** 六个 `ssh_*` 工具平时不在模型工具表里
> （每请求省下约两万字符的 schema）。你加载本技能后，它们从**下一个模型步**开始可见：
> - 如果这一步还调不到 `ssh_host` / `ssh_exec`，不要当成"没有这个能力"，下一步再调；
> - resume / fork 之后的会话若工具又不见了，重新加载一次本技能即可；
> - `minimal` 这类没有 `skill` 工具的模式不门控，工具始终可见。

## 0. 先建档，再操作

`host` 参数在所有工具里都是**已保存服务器的名字**，不是 IP 地址。还没建档就先 `ssh_host`：

```text
ssh_host { action: "list" }                                   # 默认 action，看已有哪些服务器
ssh_host { action: "add", name: "gpu", host: "1.2.3.4", port: 22, user: "root", defaultRemoteDir: "/root/autodl-tmp" }
ssh_host { action: "test", name: "gpu" }                      # 连一下，返回主机名/内核/运行时长/延迟
```

**密码走凭据库，不要在会话里贴密码。** 优先让用户在「设置 → 插件 → SSH 服务器」里输入；
确实要在会话里存，才用 `action: "password"`，并知道它**会留在会话记录里**。密钥认证给
`privateKeyPath`（口令用 `passphrase`）。`ssh_host` 的返回里永远没有密码，`servers.json` 里
也只有一条凭据引用。

不传 `host` 时的解析顺序：配置的 `defaultHost`（存在该名字才算）→ 只有一台服务器时用它 →
否则报错，要求显式传。**不要靠这个隐式规则猜机器**，多台服务器时一律显式给 `host`。

## 1. 选哪个工具（一条判据）

| 要做的事 | 工具 |
|---|---|
| 一条命令、要 stdout/stderr | `ssh_exec` |
| 本地 → 服务器 传文件/目录 | `ssh_upload` |
| 服务器 → 本地 取文件/目录 | `ssh_download` |
| 把 URL 上的文件弄到服务器 | `ssh_fetch` |
| 会跑很久的任务（训练/编译/大下载） | `ssh_job` |

**判据只有一条：这条命令会不会跑超过几十秒？** 会 → `ssh_job`；不会 → `ssh_exec`。
`ssh_exec` 会**等命令结束**并把输出带回来（`timeoutSec` 默认 120），拿它跑训练只会被超时掐断，
还拿不到中间日志。

## 2. `ssh_exec`：单条命令

```text
ssh_exec { host: "gpu", command: "nvidia-smi" }
ssh_exec { host: "gpu", command: "cd /root/app && python train.py --dry-run", timeoutSec: 60 }
```

- **每次调用都是独立 shell**：上一条的 `cwd`、环境变量、`cd` 都不会保留。多步用 `&&` 串起来，
  或用 `cwd` 参数指定起始目录（`~` 与相对路径按登录 home 解析）。
- 输出按 `maxOutputBytes`（默认 65536）**按流**截断，返回里 `stdoutTruncated` / `stderrTruncated`
  会标出来：看到截断就用 `head` / `grep` / `tail` 缩小范围，**不要重复跑同一条大输出命令**。
- 退出码非 0 或超时 → `ok: false`，`stdout`/`stderr`/`exitCode`/`timedOut` 仍然返回，照常分析。
- 超时只关闭通道，**远端进程可能还在跑**；要真正可控地停，用 `ssh_job`。

## 3. `ssh_fetch`：URL → 服务器，两种模式

```text
ssh_fetch { host: "gpu", url: "https://example.com/w.pt", remotePath: "w.pt" }                        # 默认 auto
ssh_fetch { host: "gpu", url: "https://example.com/w.pt", remotePath: "w.pt", mode: "local-relay" }
ssh_fetch { host: "gpu", url: "https://example.com/w.pt", remotePath: "w.pt", mode: "remote-direct" }
```

- **`local-relay`**：在本机流式下载到临时文件，再 SFTP 上传，结束清理临时文件。
  适合**服务器外网慢/限速/被墙**，或本机有代理而服务器没有。
- **`remote-direct`**：在服务器上 `curl`/`wget`。适合**文件大、服务器带宽好**、不想占本机
  磁盘与出口。服务器没有 `curl`/`wget` 会报错并提示改用 `local-relay`。
- `mode` 不传或 `auto` → 跟随配置 `preferLocalRelay`（默认 `true` = local-relay）。
  拿不准就用默认：多花本机一点带宽，但不会因为服务器连不上外网而失败。
  返回里的 `mode` 是**实际生效**的模式。`timeoutSec` 默认 600。

## 4. `ssh_job`：后台长任务

```text
ssh_job { action: "start", host: "gpu", command: "python train.py", label: "train", cwd: "/root/app" }
  → jobId / dir / pid / logFile / startedAt
ssh_job { action: "status", host: "gpu", jobId: "train-20261124120000-ab12cd" }
ssh_job { action: "log",    host: "gpu", jobId: "...", offset: 0, maxBytes: 65536 }
ssh_job { action: "stop",   host: "gpu", jobId: "..." }
ssh_job { action: "list",   host: "gpu" }
```

- `start` 用 `setsid nohup`，**调用立即返回**；工具调用之间不需要保持连接，断线不影响任务。
- 轮询用 `status` + `log`。`log` 返回 `nextOffset`，下次把它传回 `offset` 就只读**新增部分**，
  不会重复下载整份日志；`truncated: true` 表示这次没读完，继续用 `nextOffset` 读下一段。
- 状态只靠远端任务文件（`job.pid` / `job.exit` / `job.log`）判定：`running` / `exited` /
  `unknown`。`exitCode` / `pid` / `logBytes` 在"不适用或未知"时是 `-1`，不是 `null`。
- `stop` 给进程组发 SIGTERM，用于"还在跑但不想等了"；任务已 `exited` 后再 stop 会返回
  "没有可终止的进程"——那不是错误。
- 别指望 `ssh_job` 的日志是实时的：它读远端文件，程序自己把输出刷到 stdout 才可见
  （Python 记得 `-u` 或 `flush=True`，否则缓冲区没满时日志是空的）。

## 5. 传文件：`ssh_upload` / `ssh_download`

```text
ssh_upload   { host: "gpu", localPath: "E:/data/train", remotePath: "/root/autodl-tmp/train" }
ssh_download { host: "gpu", remotePath: "/root/autodl-tmp/out", localPath: "E:/out" }
```

- 目录递归传输，结构原样重建；`remotePath` 就是目标目录**本身**（本地目录的内容放进去，
  不会再套一层同名目录）；缺失的远端/本地目录自动创建。
- `remotePath` 的相对路径以档案的 `defaultRemoteDir` 为基准（未配置时落到登录 home）；
  `ssh_exec` 的 `cwd` 则按登录 home 解析——两者的基准不同，别混。
- 大量小文件先打包再传（`tar czf` + `ssh_download`），SFTP 逐文件很慢。
- 符号链接会跳过。

## 6. 出错先看什么

| 现象 | 先做什么 |
|---|---|
| `no password stored for ...` | 让用户在设置页存密码，或用 `ssh_host action="password"` |
| 连接超时 / refused / 认证失败 | `ssh_host { action: "test", name }`；核对 `host`/`port`/`user`/`auth` |
| `host is required` | 没有 `defaultHost` 且不止一台：显式传 `host` |
| 输出被截断 | 缩窄命令（`head`/`grep`），或调大 `maxOutputBytes`；**不要反复重跑** |
| `tool returned invalid output` | 插件返回 schema 问题：带上命令与原始输出开 issue |

## 7. 什么时候**不该**加载本技能

只读本地文件、跑本机命令、改本机代码时**不要**加载——那用普通文件与 shell 工具。
本技能只在"目标机器是另一台服务器、要走 SSH"时才需要。已经确认不是远程操作却加载了它，
等于白白多一段说明书，还让六个用不上的工具进工具表。
