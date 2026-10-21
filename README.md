# dsh-ssh

> 在 [DeepSeek Harness（dsh）](https://github.com/deepseek-ai/deepseek-harness) 里直接连 SSH 服务器：执行命令、上传下载文件、跑后台长任务并读取日志——不再为每一次连接临时写一个 Python(paramiko) 脚本。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

> 当前版本 **1.1.0**（[更新日志](./CHANGELOG.md)）· 仓库 <https://github.com/lldwb/dsh-ssh>（公开，MIT）

## 为什么需要它

租一台 GPU 服务器（AutoDL 之类的按小时计费实例）跑训练，过去在 agent 会话里是这样工作的：

1. 写一个 `connect.py`：`paramiko.SSHClient()`、自动接受 host key、把密码塞进脚本或命令行；
2. 再写一个 `upload.py` 传数据集；
3. 再写一个 `train.py` 起训练，然后每隔几分钟写一个 `poll.py` 去看日志；
4. 训练结束再写一个 `download.py` 把权重拉回来。

每一步都是一个临时文件，每个文件里都要重复一遍连接与认证，密码还经常出现在命令行里。机器换了、密码改了，这些脚本全部作废重写。

`dsh-ssh` 把上面每一步换成**一次工具调用**：服务器信息存一次（`ssh_host`），密码存一次（凭据库，不落进服务器档案），之后在一条会话里就能走完「探环境 → 传数据 → 起训练 → 轮询日志 → 取回权重」。工具挂在 Host 顶层而不是某个 agent preset 里，所以标准模式与创造模式都能用。

## 特性

| 能力 | 说明 |
|---|---|
| **六个工具** | `ssh_host`（服务器档案）、`ssh_exec`（执行命令）、`ssh_upload` / `ssh_download`（SFTP 文件与目录）、`ssh_fetch`（从 URL 取文件到服务器）、`ssh_job`（后台长任务） |
| **连接复用** | 每台服务器复用一条 SSH 连接（keepalive 10 秒），一次会话里几十次调用只付一次握手成本；服务器档案变化或连接断开时自动重连；每条连接最长保持 5 分钟，到期自动回收（`unref`，不挂住进程），下次调用透明重连 |
| **后台长任务** | `setsid nohup` 启动，日志写在远端自己的文件里，按字节偏移增量读取——工具调用之间不需要保持连接，断线也不影响训练 |
| **密码不进配置文件** | 服务器档案只有描述与凭据引用；密码存在 dsh 凭据库（没有该服务时降级为加密文件） |
| **设置页** | 设置 → 插件 → SSH 服务器：服务器增删改、密码输入、测试连接、状态 |
| **全局可用** | 插件行插在 Host 顶层，任何会话（标准 / 创造模式）都能调用 |

## 安装

### 前置

- DeepSeek Harness 桌面版（Host 插件形态，依赖 `tools` 服务；`settings` / `credentials` / `connection` / `webServer` 都是可选的，缺了会降级而不是崩）；
- Node.js >= 20。

### 方式一：从本地目录安装（推荐）

命令形式是 `dsh plugin [--profile <profile>] add <目录路径>`：

```bash
dsh plugin --profile desktop add "<本仓库的绝对路径>"
```

`desktop` 换成你的 profile 名（桌面版主 profile 通常就是 `desktop`）。在 GUI 里等价的做法是让 dsh 调用：

```text
plugin_manager install_bundle <dsh-ssh 目录的绝对路径>
```

### 方式二：手动 link

1. 在 profile 的 `package.json` 的 `dependencies` 里加 `"dsh-ssh": "link:<本仓库绝对路径>"`；
2. 把 `dsh-ssh` 加进同一个 `package.json` 的 `dsh.profile.bundles` 数组；
3. 在 profile 目录运行一次 `npm install`；
4. 重启 dsh。

### ⚠️ 装完必须补一次依赖安装

这个插件**有真实运行时依赖**：`ssh2`（SSH/SFTP 协议实现）与 `@deepseek-ai/schemastery`（声明 `Config` schema）。`dsh plugin add` 用 `link:` 方式把本包挂进 profile，**不会**替被链接的包安装它自己的依赖；而 `@deepseek-ai/*` 在 profile 目录下也解析不到。所以装完必须进插件目录跑一次：

```bash
cd "<本仓库的绝对路径>"
npm install
```

仓库随附 `package-lock.json`，装到的版本是确定的。

漏掉这一步的症状：

| 缺的依赖 | 现象 |
|---|---|
| `@deepseek-ai/schemastery` | 插件整行不激活（启动日志里 `Cannot find module '@deepseek-ai/schemastery'`），设置页也不出现 |
| `ssh2` | 插件能激活，但第一次调用工具时报 `dsh-ssh: the ssh2 dependency is not installed...` |

装好后打开「设置 → 插件」，应能看到「SSH 服务器」卡片；也可以在新会话里让模型调用 `ssh_host action="list"`，返回「还没有保存任何服务器」即表示插件已正常工作。

## 快速开始

1. **添加服务器**：打开「设置 → 插件 → SSH 服务器」，点「添加服务器」填名称、地址、端口（默认 22）、用户、认证方式与密码；或者直接让模型调用：

   ```text
   ssh_host action="add" name="gpu" host="10.0.0.10" user="root" auth="password" password="<你的密码>" note="AutoDL GPU 训练机" defaultRemoteDir="/root/autodl-tmp"
   ```

   > 密码优先在设置页输入：从设置页输入的密码不会出现在会话记录里；而写在工具参数里的 `password` 会留在会话日志中（见「安全说明」）。

2. **验证连通**：

   ```text
   ssh_host action="test" name="gpu"
   ```

   返回主机名、内核、运行时长与握手延迟。

3. **跑第一条命令**：

   ```text
   ssh_exec host="gpu" command="nvidia-smi"
   ```

到这里就完成了从「写脚本」到「用工具」的切换。

## 工具参考

以下工具名、参数名与默认值都与实现（`lib/tools.mjs`）一致。

`host` 参数的语义在所有工具里相同：**已保存服务器的名字**（不是 IP 地址）。不传 `host` 时按这个顺序解析：配置的 `defaultHost`（存在该名字才算）→ 只有一台服务器时用它 → 否则报错，要求显式传 `host`。

### `ssh_host` — 服务器档案管理

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `action` | `list` \| `show` \| `add` \| `update` \| `remove` \| `password` \| `test` | 否 | `list` | 要做什么 |
| `name` | string | 除 `list` 外都必填 | — | 服务器名：字母/数字开头，允许 `.` `_` `-`，最长 64 字符 |
| `host` | string | `add` 必填；`update` 可省 | — | 主机名或 IP |
| `port` | number | 否 | `22` | 1–65535 |
| `user` | string | `add` 必填；`update` 可省 | — | 登录用户 |
| `auth` | `password` \| `key` | 否 | `password` | 认证方式 |
| `password` | string | 否 | — | 登录密码，写入凭据库；**会留在会话记录里** |
| `privateKeyPath` | string | `auth="key"` 时必填 | — | 本地私钥文件路径 |
| `passphrase` | string | 否 | — | 私钥口令，写入凭据库（仅 `add` / `update` 时可传） |
| `note` | string | 否 | `""` | 备注，最长 2000 字符 |
| `defaultRemoteDir` | string | 否 | `""` | 相对远端路径的基准目录，例如 `/root/autodl-tmp` |

各 `action` 的作用：

| action | 作用 |
|---|---|
| `list` | 列出所有服务器，并标出每台密码是否已配置 |
| `show` | 显示一台服务器的详情 |
| `add` | 新建服务器；名字已存在会报错，要求改用 `update` |
| `update` | 修改已有服务器的字段（只改传入的字段；`name` 是主键，不能改名） |
| `remove` | 删除服务器档案（不会清理凭据库里对应的密码引用） |
| `password` | 写入 / 替换登录密码（仅 `auth="password"` 的服务器） |
| `test` | 连接并执行探测命令，返回主机名 / 内核 / 运行时长 / 延迟 |

### `ssh_exec` — 执行一条命令

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `host` | string | 否 | — | 服务器名；有 `defaultHost` 或只有一台服务器时可省 |
| `command` | string | **是** | — | 按 POSIX shell（bash/sh）写的命令 |
| `cwd` | string | 否 | — | 先 `cd` 到这个目录再执行；`~` 与相对路径相对登录 home |
| `timeoutSec` | number | 否 | `120` | 超时后关闭通道；**远端进程可能继续运行** |
| `maxOutputBytes` | number | 否 | 配置值（`65536`） | 输出上限，**stdout / stderr 各自**截断到此值 |

返回：`stdout`、`stderr`、`exitCode`、`signal`、`timedOut`、`durationMs`，以及 `stdoutBytes` / `stderrBytes`（截断前的总量）和 `stdoutTruncated` / `stderrTruncated`。`ok` 只有在退出码为 0 且未超时的时候才是 `true`；退出码未知时 `exitCode` 为 `-1`。

适合：探环境（`nvidia-smi`、`df -h`、`ps aux`）、装包、编译、一次性脚本。**不要**用它跑会超出一次调用的训练或长下载——用 `ssh_job`。

`cwd` 的 `~`、`~/` 与相对路径都按登录 home 解析（每条连接探测一次 `$HOME` 并缓存）。这与 `ssh_upload` / `ssh_download` 的 `remotePath` 不同：后者的相对路径以 `defaultRemoteDir` 为基准，未配置时才落到登录 home。

### `ssh_upload` — 上传文件或目录

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `host` | string | 否 | — | 服务器名（规则同上） |
| `localPath` | string | **是** | — | 本地文件或目录的绝对路径 |
| `remotePath` | string | **是** | — | 远端目标路径；相对路径基于 `defaultRemoteDir`（为空时相对登录 home），支持 `~` |

目录会递归传输，结构按原样重建；**远端 `remotePath` 就是目标目录本身**，本地目录的*内容*放进它里面（不会再套一层同名目录）。缺失的远端目录会自动创建。符号链接跳过。`~` / `~/` 按真实登录 home 展开。

### `ssh_download` — 下载文件或目录

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `host` | string | 否 | — | 服务器名（规则同上） |
| `remotePath` | string | **是** | — | 远端文件或目录路径；相对路径基于 `defaultRemoteDir`（为空时相对登录 home），支持 `~` |
| `localPath` | string | **是** | — | 本地目标绝对路径 |

目录同样递归下载，远端目录的内容放到 `localPath` 下；缺失的本地目录会自动创建。`~` / `~/` 按真实登录 home 展开。

### `ssh_fetch` — 从 URL 取文件到服务器

把 `url` 指向的文件放到服务器上的 `remotePath`。这是把数据集、模型权重、checkpoint 弄上机器的最短路径（不用先下载到本机再手动上传）。两种传输模式：

| 模式 | 行为 | 适合 |
|---|---|---|
| `local-relay`（默认，当 `preferLocalRelay=true`） | 在**运行 dsh 的机器**上流式下载到临时文件，再经 SFTP 上传到 `remotePath`，结束后清理临时文件 | 服务器外网慢 / 限速 / 被墙，或本机有代理而服务器没有；要求本机能访问该 URL，且下载期间占用本机临时磁盘 |
| `remote-direct` | 在**服务器**上执行 `curl -fL --retry 2 --connect-timeout 30 -o <path> <url>`；没有 `curl` 时用 `wget`；两者都没有则报错并提示改用 `local-relay` | 文件大、服务器带宽好、不想占本机磁盘/带宽 |

`mode` 不传或传 `auto` 时，用插件设置 `preferLocalRelay` 决定默认模式；返回的 `mode` 是**实际生效**的模式（不会是 `auto`）。

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `host` | string | 否 | — | 服务器名（规则同上） |
| `url` | string | **是** | — | 要取的文件 URL，必须是 `http(s)://` 绝对地址 |
| `remotePath` | string | **是** | — | 远端目标文件路径；相对路径基于 `defaultRemoteDir`（为空时相对登录 home），支持 `~` |
| `mode` | `auto` \| `local-relay` \| `remote-direct` | 否 | `auto` | 传输方式；`auto` 跟随 `preferLocalRelay` |
| `timeoutSec` | number | 否 | `600` | 整个操作的超时预算（约束本机下载与服务器端下载命令；SFTP 上传阶段不单独计时） |

返回：`ok`、`host`、`target`、`url`、`remotePath`、`mode`、`bytes`、`durationMs`、`summary`。

示例（`defaultRemoteDir="/root/autodl-tmp"` 时，三条示例的 `weights.pt` 都落到 `/root/autodl-tmp/weights.pt`）：

```text
# 默认：本机下载后上传（服务器外网受限时最稳）
ssh_fetch host="gpu" url="https://example.com/models/weights.pt" remotePath="weights.pt"

# 显式本机中转
ssh_fetch host="gpu" url="https://example.com/models/weights.pt" remotePath="weights.pt" mode="local-relay"

# 服务器带宽好、文件大：让服务器自己下载
ssh_fetch host="gpu" url="https://example.com/models/weights.pt" remotePath="weights.pt" mode="remote-direct"
```

> 什么时候用哪种：服务器外网慢 / 被墙 / 没有直连 → `local-relay`（默认）；文件大、服务器带宽好、本机磁盘或出口紧张 → `remote-direct`。大文件下载后要解压/校验的，接着用 `ssh_exec` 处理即可。

### `ssh_job` — 后台长任务

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `action` | `start` \| `status` \| `log` \| `stop` \| `list` | 否 | `list` | 要做什么 |
| `host` | string | 否 | — | 服务器名（规则同上） |
| `jobId` | string | `status` / `log` / `stop` 必填 | — | `start` 返回的任务 id |
| `command` | string | `start` 必填 | — | 要跑的 shell 命令 |
| `label` | string | 否 | — | 短标签，用来生成可读的 jobId（如 `train`） |
| `cwd` | string | 否 | 远端 `$HOME` | 启动前先 `cd` 到这里；支持 `~` 与相对路径（相对登录 home） |
| `offset` | number | 否 | `0` | `log` 的字节偏移；用上一次返回的 `nextOffset` |
| `maxBytes` | number | 否 | 配置值（`65536`） | `log` 单次返回的最大字节数 |

各 `action` 的作用：

| action | 作用 |
|---|---|
| `start` | 上传启动脚本、用 `setsid nohup` 后台启动，返回 `jobId` / `dir` / `pid` / `logFile` / `startedAt` |
| `status` | 从远端文件判定 `running` / `exited` / `unknown`，返回 `exitCode`、`pid`、`logBytes`（不适用 / 未知时为 `-1`） |
| `log` | 从 `offset` 起读至多 `maxBytes` 字节，返回 `chunk`、`totalBytes`、`nextOffset`、`truncated` |
| `stop` | 向任务进程组发送 SIGTERM（`setsid` 不可用时退化为对单个 PID 发送） |
| `list` | 列出该服务器上由 dsh-ssh 启动的任务，新的在前 |

任务目录在远端 `<登录 home>/.dsh-ssh/jobs/<jobId>/`（绝对路径，例如 root 用户是 `/root/.dsh-ssh/jobs/<jobId>/`），里面有 `run.sh`、`job.pid`、`job.exit`、`job.log`。状态完全靠这些文件判定，所以机器上的其他进程与它无关，也不用 `pgrep`。jobId 形如 `train-20261021153000-ab12cd`（`label` 小写后 + 时间戳 + 随机串）。

### 输出、截断与失败

- 工具失败不抛异常，返回 `ok: false` 加一段可读的 `summary`（模型能直接读懂并重试）。
- `ssh_exec` 的输出是「保留头部、尾部截断」，并明确报告被截断；需要完整输出时，把命令重定向到远端文件再用 `ssh_download` 取回，或改用 `ssh_job`。
- `ssh_job` 的日志永远是增量读取：把上一次的 `nextOffset` 传给下一次 `offset` 即可。

## 典型场景：AutoDL 上的训练闭环

下面是一条会话里从零到取回权重的完整流程（地址与密码是占位值，换成你自己的）：

```text
# 1. 存服务器（也可以从设置页添加）
ssh_host action="add" name="gpu" host="10.0.0.10" user="root" auth="password" password="<你的密码>" note="AutoDL GPU 训练机" defaultRemoteDir="/root/autodl-tmp"

# 2. 验证连通
ssh_host action="test" name="gpu"

# 3. 探环境
ssh_exec host="gpu" command="nvidia-smi"
ssh_exec host="gpu" command="python -V && df -h /root/autodl-tmp"

# 4. 传本地数据集：本地目录的内容放进远端目标目录
ssh_upload host="gpu" localPath="D:\\datasets\\coco128" remotePath="/root/autodl-tmp/data/coco128"

# 5. 从 URL 直接取预训练权重到服务器（默认本机中转；服务器外网好时也可 mode="remote-direct"）
ssh_fetch host="gpu" url="https://example.com/models/yolo11n.pt" remotePath="/root/autodl-tmp/weights/yolo11n.pt"

# 6. 起训练：后台任务，调用立即返回
ssh_job action="start" host="gpu" label="train" command="python /root/autodl-tmp/code/train.py --data /root/autodl-tmp/data/coco128 --weights /root/autodl-tmp/weights/yolo11n.pt --epochs 50"

# 7. 轮询状态与日志（jobId 用 start 返回的值）
ssh_job action="status" host="gpu" jobId="train-20261021153000-ab12cd"
ssh_job action="log" host="gpu" jobId="train-20261021153000-ab12cd" offset=0
ssh_job action="log" host="gpu" jobId="train-20261021153000-ab12cd" offset=<上一次返回的 nextOffset>

# 8. 取回权重
ssh_download host="gpu" remotePath="runs/best.pt" localPath="D:\\runs\\best.pt"
```

踩坑提示：

- 第 4 步如果数据集很大（几万个小文件），**先打包再传**会快得多：本机 `tar` 出一个归档 → `ssh_upload` 传归档 → `ssh_exec` 在远端解开。
- 第 5 步的 `ssh_fetch`：服务器外网慢 / 被墙 / 没有直连时用默认的 `local-relay`（本机下载后上传）；文件大、服务器带宽好时用 `mode="remote-direct"` 让服务器自己下。
- 第 6 步的命令要写成非交互式（加 `-y` / `--yes` 之类），否则需要 TTY 的程序会一直等到超时。
- 训练脚本自己也要把 checkpoint 落到 `defaultRemoteDir` 下面，第 8 步的相对路径才找得到。

## 配置项

插件行在 `cordis.patch.yml` 里带四个配置项：

| 字段 | 默认值 | 范围 | 说明 | 生效时机 |
|---|---|---|---|---|
| `defaultHost` | `""` | — | 工具没传 `host` 时默认用哪台服务器；空串表示必须显式指定 | 下一次工具调用 |
| `maxOutputBytes` | `65536` | 1024–1048576 | `ssh_exec` 的单流输出上限，也是 `ssh_job log` 的默认 `maxBytes` | 下一次工具调用 |
| `connectTimeoutMs` | `15000` | 1000–120000 | 建立 SSH 连接的超时 | 下一次连接（每次连接前从配置同步到连接池） |
| `preferLocalRelay` | `true` | — | `ssh_fetch` 不传 `mode` 时的默认模式：`true` = 本机下载后上传（`local-relay`），`false` = 服务器直接下载（`remote-direct`） | 下一次 `ssh_fetch` 调用 |

要改的话，在你自己的 profile `cordis.patch.yml` 里按行 id 定向覆盖。**注意 id 定向 patch 会整体替换 `config`，不做深合并**，所以四个字段要写全：

```yaml
- id: dsh-ssh
  name: 'dsh-ssh'
  config:
    defaultHost: gpu
    maxOutputBytes: 131072
    connectTimeoutMs: 30000
    preferLocalRelay: true
```

改完在「设置 → 插件」里把本插件禁用再启用（或重启 dsh），让 Loader 重新读取 patch。四个字段都是 volatile：配置一旦读入，之后的工具调用 / 连接立即使用新值（`connectTimeoutMs` 在每次连接前同步到连接池），不需要为了改值再重载。`preferLocalRelay` 也可以在设置页的「默认行为」区直接开关。

## 服务器档案与密码存储

两个文件都在 dsh home 下（`DSH_HOME` 环境变量优先，否则 `~/.dsh`；Windows 上是 `%USERPROFILE%\.dsh`）：

```text
<DSH_HOME>/dsh-ssh/servers.json   # 服务器档案：只有描述，没有密码
<DSH_HOME>/dsh-ssh/secrets.json   # 仅在缺少 credentials 服务时才创建：AES-256-GCM 加密的密码
```

`servers.json` 的结构如下（**不含任何密码、私钥或口令**）：

```json
{
  "version": 1,
  "servers": {
    "gpu": {
      "name": "gpu",
      "host": "10.0.0.10",
      "port": 22,
      "user": "root",
      "auth": "password",
      "note": "AutoDL GPU 训练机",
      "defaultRemoteDir": "/root/autodl-tmp",
      "createdAt": "2026-10-21T07:30:00.000Z",
      "updatedAt": "2026-10-21T07:30:00.000Z",
      "passwordRef": "DSH_SSH_GPU_PASSWORD"
    }
  }
}
```

它写入时是原子写（临时文件 + rename），POSIX 上文件权限 0600、目录 0700。

**每种信息存在哪：**

| 信息 | 位置 |
|---|---|
| 地址 / 端口 / 用户 / 认证方式 / 备注 / 默认远端目录 / 凭据引用名 | `servers.json` |
| 登录密码、私钥口令 | dsh 凭据库（`credentials` 服务）；没有该服务时降级到 `secrets.json` |
| 私钥文件本身 | 你自己的磁盘上（`privateKeyPath`），插件只读它，不复制也不上传 |
| 会话记录 | 工具调用参数——**用工具传 `password` / `passphrase` 时会留下** |

**凭据引用名**：创建服务器时生成一次并写进 `servers.json`，形如 `DSH_SSH_<名字>_PASSWORD`（名字转大写、非字母数字变 `_`）；私钥口令是 `DSH_SSH_<名字>_PASSPHRASE`。引用名是持久化的，所以改服务器名不会静默弄丢已存的密码。

**两种密码后端：**

1. **dsh 凭据服务**（首选）：和 Models 页的 API 密钥同一个存储，插件重装后密码仍在；插件只写不读回工具结果。
2. **加密文件**（降级）：`secrets.json`，AES-256-GCM，密钥由 `dsh-ssh/<主机名>/<用户名>/<dsh home 绝对路径>` 派生。**这不是强安全边界**：能读到这个文件的人在同一台机器上也能重新派生出密钥。它的意义是让没有凭据服务的 profile 也能用密码认证，同时避免明文落盘、避免备份被直接 `cat` 出密码。需要更强的隔离时请用密钥认证。

**什么进仓库、什么不进：**

- 本仓库里只有代码、文档与图标，**不含任何服务器地址、用户名或密码**；
- `servers.json` 与 `secrets.json` 都在 `<DSH_HOME>` 下，不属于本仓库，也不应被提交到任何公开仓库；
- 备份时 `servers.json` 可以放心备份（描述性数据，不含秘密），但换机器/重装后要重新填一次密码——凭据引用是机器本地凭据库里的东西；
- `secrets.json` 要当作密钥对待：**不要**提交、不要共享给别的机器（密钥与机器身份绑定，换机器也解不开）。

## 设置页

入口：**设置 → 插件 → SSH 服务器**。页面由本包的浏览器半（`client.js`）绘制，通过自定义 RPC 通道 `/dsh-ssh` 与 Host 半通信；Host 半不可用时页面不会出现。

页面上可以做：

- 查看已保存的服务器列表（地址、用户、认证方式、密码是否已配置）；
- 添加 / 编辑 / 删除服务器；
- 输入或替换登录密码、私钥口令（**只写不读**：页面只显示「已配置 / 未配置」，不会回显密码）；
- 「测试连接」按钮：等价于 `ssh_host action="test"`，返回主机名 / 内核 / 运行时长 / 延迟；
- 「默认行为」区里对应 `preferLocalRelay` 的开关：决定 `ssh_fetch` 不传 `mode` 时的默认模式；
- 查看状态：构建版本、dsh home、`servers.json` 路径、当前密码后端（`credentials-service` / `encrypted-file`）、服务器数量。

密码从设置页输入不会进会话记录，这是推荐方式；从工具参数传密码则会让它留在会话日志里。

## 安全说明

- **密码进会话记录的场景**：`ssh_host action="add"` / `"update"` / `"password"` 的 `password` 参数，以及 `add` / `update` 的 `passphrase` 参数。工具调用参数会被写进会话记录，可能被模型与日志看到——敏感密码请用设置页输入。
- **密码不进服务器档案、不进工具返回、不进日志**：`servers.json` 只有凭据引用，工具返回里只有「密码是否已配置」这个布尔值。
- **推荐用私钥认证**：`auth="key"` + `privateKeyPath` 指向本地私钥；私钥文件只被本地读取，不会上传到服务器。有口令的私钥可以把口令存进凭据库（设置页或 `passphrase` 参数）。
- **host key 未做 pinning（已知限制）**：插件没有实现 known_hosts 校验，`ssh2` 默认接受任意 host key。也就是说，连接过程**不防御中间人**。在不可信网络上请自行用 VPN / 跳板机 / 网络层保护，或改用你能校验目标身份的方式。
- **降级文件后端不是强安全边界**（见上一节）：需要强隔离时用凭据服务 + 密钥认证。
- **权限建议**：给训练机用独立账号或独立密码，按需开机；用完可以 `ssh_host action="remove"` 删掉档案（密码引用如需清理，可在凭据库里手动删除）。

## 已知限制

- **远端只支持 POSIX shell（Linux / macOS）**：命令按 bash/sh 写；Windows 远端（cmd / PowerShell）未验证。`ssh_job` 还依赖远端有 `bash`（`setsid` 可选，没有时退化为 `nohup`）。
- **`ssh_exec` 超时不会杀远端进程**：超时只关闭 SSH 通道并返回 `timedOut: true`，远端命令可能继续运行。要真正停止长任务，用 `ssh_job start` + `ssh_job stop`。
- **大目录逐文件传输慢**：SFTP 逐个文件传，几万个小文件会明显偏慢。建议先打包成归档再传，在远端用 `ssh_exec` 解包。
- **`ssh_fetch` 的 `remote-direct` 依赖服务器上有 `curl` 或 `wget`**：两者都没有时会报错并提示改用 `local-relay`（默认模式）。
- **`ssh_fetch` 的 `local-relay` 需要本机能访问该 URL**：下载走运行 dsh 的这台机器，且下载期间占用本机临时磁盘（约文件大小）；服务器外网受限而本机也没有出口时，只能考虑先在其他地方取到文件再用 `ssh_upload`。
- **符号链接**：上传目录时跳过链接；下载目录时按普通文件处理，不保证链接语义。
- **远端 home 依赖登录 shell 探测**：`~` 与相对路径按登录 shell 报告的 `$HOME` 展开（每条连接探测一次并缓存，不再假定 `/root`）。如果远端限制登录 shell（例如 `ForceCommand`）导致探测不到 home，涉及 `~` / 相对路径的调用会报错，请改用绝对路径。
- **不支持交互式 TTY**：需要现场输入的程序（`vim`、交互式 `apt` 确认）会挂到超时。请用非交互参数。
- **删除服务器不清理密码**：`ssh_host action="remove"` 只删档案，凭据库里的密码引用仍然在（这样误删档案后重新 add 同名服务器还能用回密码）。
- **后台任务的状态依赖远端文件**：机器重启后任务目录（`<登录 home>/.dsh-ssh/jobs/`）里的 PID 可能指向已消失的进程，`status` 会报 `unknown`，但日志仍可读。`stop` 只发 SIGTERM，不跟进 SIGKILL。
- **`update` 不能改名**：`name` 是主键；要改名请 `remove` 后 `add`。

## 故障排查

| 现象 | 原因与处理 |
|---|---|
| 设置页没有「SSH 服务器」卡片 | 插件没激活：确认 profile 的 `dsh.profile.bundles` 里有 `dsh-ssh`，并在插件目录跑过 `npm install`，然后重载 / 重启 dsh |
| `Cannot find module '@deepseek-ai/schemastery'` | 插件目录没跑 `npm install`（缺这个依赖时整行不激活） |
| `the ssh2 dependency is not installed` | 插件目录没跑 `npm install` |
| `authentication failed` | 用户名 / 密码 / 私钥不对；先在设置页点「测试连接」 |
| `connection refused` | 端口写错，或远端 sshd 没在监听 |
| `connection timed out` | 地址 / 端口 / 防火墙 / 安全组 |
| `host could not be resolved` | 主机名或 DNS 问题 |
| `no password stored for ...` | 还没存密码：用设置页，或 `ssh_host action="password"` |
| `status` 显示 `unknown` | 机器重启过，或任务目录被清理；日志通常仍可读 |
| 传输很慢 | 大目录先打包再传，见「已知限制」 |
| `tool returned invalid output` | 插件自身的返回 schema 问题；请带上命令与原始输出开 issue |

## 实现结构

```text
dsh-ssh/
├── index.js            # Host 半：Config、工具注册、设置页策略、RPC 接线
├── client.js           # Client 半：设置页（浏览器端）
├── lib/
│   ├── tools.mjs       # 六个工具定义（严格 JSON Schema，含返回值校验）
│   ├── service.mjs     # 档案 + 凭据 + 连接池的统一服务层
│   ├── profiles.mjs    # servers.json 的读取、校验与原子写入
│   ├── secrets.mjs     # 凭据库 / 加密文件两种密码后端
│   ├── ssh.mjs         # ssh2 封装：连接池（keepalive + 空闲回收）、exec、SFTP、JobManager
│   └── rpc.mjs         # 设置页的 RPC 通道（/dsh-ssh）
├── cordis.patch.yml    # 顶层 insert：全局挂载 + 四个配置项
├── locale/{zh,en}.json # 插件卡片标题与描述
├── icon.svg
├── README.md
└── CHANGELOG.md
```

## 仓库与许可证

- 仓库：<https://github.com/lldwb/dsh-ssh>（公开）
- 许可证：[MIT](./LICENSE)
- `package.json` 里的 `"private": true` 只阻止误发 npm，不影响本地安装，也与仓库可见性无关。
