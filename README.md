# 浏览器 Profile 隔离工作台与策略约束自动化 MCP

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

> **产品定位**：面向自有、测试或已获授权网站的本地浏览器环境隔离、持久 Profile 管理与可审计自动化。项目不承诺绕过站点挑战、规避风控、账号不受限制或达到第三方检测站分数。
>
> **当前已交付核心能力**：
> 1. **持久 Profile**：Firefox/Chromium 环境配置、稳定种子、Cookie 与存储目录生命周期管理；
> 2. **本地 Studio**：Profile 创建、更新、克隆、批量启停、可恢复删除，持久代理池、受管扩展中心、真实出口验证、标签轮换以及带条件/循环/变量/重试/产物的声明式 RPA；
> 3. **本地安全**：REST Bearer/HttpOnly Cookie 鉴权、工作区成员、资源级授权、可撤销哈希 API Key、结构化审计，以及 Cookie、代理密码和 2FA Secret 的 AES-256-GCM 加密；Windows 默认使用 DPAPI 保护 Studio 主密钥；
> 4. **策略网关**：标准 MCP 与 Local REST API 只组合高层动作，限制会话资源、URL 范围和自动化状态。

检测到挑战时，自动化立即暂停。生产挑战的标准结果是 `CHALLENGE_DETECTED`/`SESSION_PAUSED_CHALLENGE`，等待受信任人员处理；服务不会刷新、重试、切换环境或与挑战控件交互。

Service Worker 身份链路：Chromium 会通过仅绑定回环地址的浏览器级 CDP 通道，在网站代码执行前暂停目标，统一 UA、平台、Client Hints 与后续网络请求；Firefox 不依赖页面脚本注入，而是使用 Gecko 原生 Profile 首选项统一 Window、Worker、Service Worker 和 HTTP 通道中的 UA、平台、appVersion、语言、硬件并发数及相关请求头。stock Firefox 的 Playwright 时区覆盖不会进入 Service Worker，因此完整时区覆盖仍只在 `browser-core/firefox` 的版本锁定内核补丁中提供，产品能力接口对此保持 `false`，不会把部分覆盖冒充为全覆盖。

## 安装

要求 Node.js 20 或更高版本。

```sh
npm ci
npm run install:firefox
npm run build
```

启动本地桌面 Studio：

```powershell
npm run studio
```

首次启动会在 `data/` 创建本机主密钥和 owner token，并通过一次性启动链接写入 HttpOnly Cookie。Windows 上两个启动机密以当前用户 DPAPI 密文保存，旧明文启动文件会自动迁移；业务密文仍使用 AES-256-GCM。可用 `STUDIO_MASTER_KEY`、`STUDIO_ACCESS_TOKEN` 和 `STUDIO_USERS_JSON` 接入外部 KMS 或配置静态多角色凭据。`data/` 必须作为敏感目录备份与保护；主密钥丢失后已有密文无法恢复。

### Studio 产品 API

Studio API 默认只监听 `127.0.0.1`，除 `/api/v1/health` 外均需认证。主要端点包括：

- `/api/v1/openapi.json`：OpenAPI 3.1 入口；Profile 列表支持 `q`、`offset`、`limit`，总数返回在 `X-Total-Count`。
- `/api/v1/profiles/trash`、`/profiles/{id}/restore`、`/profiles/{id}/purge`：回收站、恢复与仅 owner 可用的永久清除。
- `/api/v1/team/*`：工作区、成员、资源 grants 以及只在创建时返回明文的可撤销 API Key。
- `/api/v1/extensions`、`/extensions/import`、`/profiles/{id}/extensions`：仅 owner 可导入的受管 ZIP/XPI 仓库，以及按 Profile 分配扩展。
- `/api/v1/sessions/{sessionId}/ws`：`abs-rpc/1` 有界 WebSocket 自动化协议，支持 status/open/click/type/select/scroll/snapshot/screenshot；它不是原始 CDP。
- `/api/v1/synchronizer/captures`：显式启停主窗口动作捕获。只同步可解析的语义目标，密码字段被排除。
- `/api/v1/product/capabilities`、`/product/runtime-health`、`/metrics`：真实能力边界、外部云运行时适配器状态和本机运行指标。

小状态文件使用同目录临时文件、`fsync`、原子替换和 `.bak` 上一版本恢复。该方案为单 Studio 进程设计，不等于支持多个进程同时写入，也不等于已经提供云数据库。云浏览器与 Android 云手机提供标准 provider 适配边界，以及经过鉴权的创建、停止和健康检查 API；未注册并配置真实供应商与凭据时，能力接口会返回未配置，不会创建模拟设备或伪造连接地址。

代理状态分为 `unhealthy`、`reachable` 和 `verified`。`reachable` 只代表代理端口可达；只有请求确实通过代理并从出口服务取得 IP 时才是 `verified`。国家字段只在所配置的出口服务真实返回国家信息时出现，不使用默认国家填充。

开发环境没有 `package-lock.json` 时可用 `npm install` 代替 `npm ci`。`npm run install:browsers` 下载项目锁定的 Firefox 与 Chromium；只使用单一引擎时可分别运行 `npm run install:firefox` 或 `npm run install:chromium`。启动前复制 `.env.example`，至少设置 `BROWSER_ALLOWED_HOSTS`：

```sh
# POSIX
cp .env.example .env
export BROWSER_ALLOWED_HOSTS='test.example.com,*.staging.example.com'
npm start
```

```powershell
# Windows PowerShell
Copy-Item .env.example .env
$env:BROWSER_ALLOWED_HOSTS = 'test.example.com,*.staging.example.com'
npm start
```

当前版本的服务仍只从环境和 Studio 管理面读取管理员配置；MCP 调用不能传入 allowlist、浏览器可执行文件、扩展包、扩展路径或 profile 路径，但 `browser_start` 支持按会话传入代理、指纹、GeoIP、语言、时区、地理位置、UA、视口和种子。自定义 UA 的浏览器品牌与主版本必须匹配项目锁定的受管内核，并且只能与受管指纹同时使用；留空时服务会自动生成兼容值。Chromium 的 JS Client Hints 与网络 `Sec-CH-UA-*` 由同一版本/OS 模型配置，外部 CDP 浏览器禁止注入受管指纹。扩展只能由 Studio owner 导入受管仓库，并通过服务器生成的扩展 ID 分配给持久 Profile。

### 受管扩展中心

Studio 的“扩展中心”接受最大 12 MiB 的 ZIP/XPI，导入时检查压缩路径、解压大小、文件数量、Manifest V2/V3、危险权限和可执行载荷，并固定原包及解压内容的 SHA-256。`nativeMessaging`、`debugger`、`management` 权限被拒绝；Cookie、代理、历史、下载、剪贴板和 `<all_urls>` 等高风险权限必须由 owner 显式确认。启动前会再次校验完整性，调用方不能提交任意本机路径。

Chromium 使用服务器受管的解压目录加载扩展；带扩展的 Chromium Profile 必须以 headed 模式启动。Firefox 只接受同时声明固定 Gecko ID 且包内具有 Mozilla 签名结构的 XPI，安装后仍由 Firefox 原生签名校验作最终裁决；服务不会关闭签名要求。扩展的启停或分配在停止并重新启动 Profile 后生效。


默认情况下每个会话使用临时 Profile，停止或到期后清理。若确实需要保留登录态，管理员可将
`BROWSER_PERSIST_PROFILES=true`，并在 `browser_start` 中使用安全的 `profile` 名称；Profile
会保存到 `BROWSER_DATA_DIR/profiles/<profile>`，因此该目录必须挂载到受保护的持久化卷。服务
不会把同一个持久化 Profile 同时分配给多个活动会话。该开关会持久化 Cookie 和本地存储，
不应在共享主机或未加密卷上启用。

### Chromium、Bridge 与控制面

stdio MCP 仍是默认的策略网关；需要浏览器池或远程 Agent 时，先构建并启动独立控制面：

```sh
npm run build
CONTROL_PLANE_TOKEN='use-a-long-random-secret' npm run start:control-plane
```

控制面默认监听 `127.0.0.1:8081`，提供 `/api/browsers`、`/api/bindings`、
`/api/platforms`、`/api/skills` 和 `/ws/agents`。设置 `CONTROL_PLANE_TOKEN` 后，HTTP 使用
`Authorization: Bearer ...`，WebSocket 可使用同一 Bearer 或查询参数 `?token=...`。
Agent 通过 WS 反向连接后可以调用受策略约束的 MCP 工具；这适合 NAT/内网环境。

浏览器池中的 `managed` 实例由服务启动 Firefox 或 Chromium，`cdp` 实例通过
`cdpEndpoint` 接管已有 Chromium，`bridge` 实例等待 OpenCLI 扩展连接到
`/ws/bridge/<browserId>`。Bridge 使用带 requestId 的有界 RPC，不开放任意 JavaScript；扩展
侧应实现 `opencli-bridge.v1` 协议并继续执行页面挑战暂停与人工确认流程。实例可以通过
`PATCH /api/browsers/<id>` 在停止状态切换模式，并通过 `/api/bindings` 将站点绑定到指定实例。
例如把 noVNC 中已登录的 Chromium 接管到池中：

```sh
curl -X POST http://127.0.0.1:8081/api/browsers \
  -H "Authorization: Bearer $CONTROL_PLANE_TOKEN" -H 'content-type: application/json' \
  -d '{"name":"account-a","engine":"chromium","mode":"cdp","cdpEndpoint":"http://127.0.0.1:9222","profileName":"account-a"}'
```

需要可视化登录/扫码时，可选启动 Chromium + noVNC companion：

```sh
docker compose -f docker-compose.browser.yml up -d
```

此时 noVNC 在 `http://127.0.0.1:6080`，CDP 默认在 `127.0.0.1:9222`。该 compose 使用独立
`chromium-profile` 卷保存登录态；生产环境应固定经过审计的镜像版本，并将端口置于鉴权反向
代理后。`/api/skills` 中的动作包目前是可发现目录，带第三方 API Key 的条目会明确标注，
不会伪装成已实现的站点专用选择器。

本地控制面默认允许持续每秒 20 次工具调用、短时突发 40 次，可由管理员通过 `MCP_RATE_PER_SECOND` 和 `MCP_BURST` 收紧。限流是单进程安全阀；多实例租户配额仍应由共享网关或 Redis 层统一实施。控制面只审计工具名、阶段、结果和 traceId，不记录调用参数、token、URL、目标名称或输入文本。

每个浏览器会话都有服务端强制的绝对生命周期。`BROWSER_SESSION_TTL_MS` 未设置时跟随
管理员选择的自动化策略：`strict` 为 30 分钟、`standard` 为 2 小时、`trusted-local`
为 24 小时；显式 TTL 只能收紧策略上限，接受范围仍为 1 分钟至 24 小时。TTL 到期后
服务会停止并清理会话、释放并发槽，后续状态或动作访问返回稳定的 `SESSION_EXPIRED`。
TTL 不会因导航、动作或人工接管而续期。

`BROWSER_AUTOMATION_POLICY` 只由管理员通过环境变量选择，默认 `standard`，模型不能在
工具调用中提升限制。策略同时控制每会话 Tab 数、workflow 步数/时长/结果、滚动档位、
Snapshot 历史容量/保留时间/对象大小和 retained workspace TTL：

| 策略 | Tab | workflow | 紧凑 Snapshot | workspace |
| --- | ---: | --- | --- | --- |
| `strict` | 5 | 10 步 / 30 秒 / 64 KB | 32 份 / 10 分钟 / 256 KB | 24 小时 |
| `standard` | 12 | 50 步 / 2 分钟 / 256 KB | 64 份 / 30 分钟 / 512 KB | 7 天 |
| `trusted-local` | 20 | 100 步 / 5 分钟 / 1 MB | 256 份 / 24 小时 / 1 MB | 7 天 |

服务仍保留不可被策略提升的硬上限：32 Tab、100 步、5 分钟、1 MB workflow 结果、
20 个滚动档位、256 份 Snapshot、24 小时 Snapshot TTL、16 MiB 历史和 4 MiB 单对象。

## allowlist 与网络策略

`BROWSER_ALLOWED_HOSTS` 必填，逗号分隔，支持精确域名和显式 `*.example.com` 单标签通配符；裸 `*`、URL、端口和空项都会导致启动失败。默认只允许 HTTPS，默认阻止环回、RFC1918 私网、链路本地、保留地址和云元数据地址；DNS 解析后的地址和重定向仍会再次检查。

`page_fetch` 和 `cluster_*` 任务也使用同一套服务端 URL 策略。轻量抓取仅允许 GET/HEAD，不能提交 body 或任意请求头；重定向逐跳检查且有数量上限，响应体也有大小上限。响应头使用服务端白名单，只返回缓存与内容元数据；`Set-Cookie`、认证挑战头和其他未批准响应头不会返回给 MCP 调用方或写入集群任务结果。

`page_fetch` 的 HTTP(S) 连接会复用策略在本次请求中解析并批准的地址，并把该地址固定到 TCP socket；原始主机名仍用于 `Host` 和 HTTPS SNI。浏览器 Playwright 的导航/资源路由可以在连接前 fail-closed 地检查 allowlist、DNS 和私网地址，但无法在应用层把 Firefox 的每条底层 TCP 连接可靠地 pin 到该解析结果。因此生产部署必须在进程或容器出口使用只允许批准目标的 egress firewall 或显式代理，并在网络层阻断环回、RFC1918、链路本地、云元数据及未批准目标；应用层检查不能替代该出口控制。

仅在自有本地 fixture 且经过评审时，才在服务端显式设置 `BROWSER_ALLOW_HTTP=true` 或 `BROWSER_ALLOW_PRIVATE_NETWORK=true`。私网开关打开时会写 stderr 警告；示例配置不会打开它，也不给任何私网地址。

## MCP 配置

`mcp-config.example.json` 是可复制的最小示例。将 `args` 改成生成后的绝对路径，并替换为自己管理的测试域名。Windows 配置：

```json
{
  "mcpServers": {
    "compliant-firefox": {
      "command": "node",
      "args": ["C:\\path\\to\\antigravity-browser\\dist\\index.js"],
      "env": {
        "BROWSER_ALLOWED_HOSTS": "test.example.com",
        "BROWSER_ALLOW_PRIVATE_NETWORK": "false"
      }
    }
  }
}
```

POSIX 配置：

```json
{
  "mcpServers": {
    "compliant-firefox": {
      "command": "node",
      "args": ["/opt/compliant-firefox/dist/index.js"],
      "env": {
        "BROWSER_ALLOWED_HOSTS": "test.example.com",
        "BROWSER_ALLOW_PRIVATE_NETWORK": "false"
      }
    }
  }
}
```

stdio 的 stdout 只承载 MCP 协议帧；启动错误、清理错误和私网警告写 stderr。不要把调试输出重定向到 stdout。

## 工具

服务注册以下 31 个标准 MCP 工具：

| 工具 | 作用 |
| --- | --- |
| `browser_start` | 启动受策略约束的 headless/headed Firefox 会话 |
| `browser_status` | 查询状态、页面摘要、挑战状态和最近的安全阻断事件 |
| `browser_stop` | 停止并清理会话（可重复调用） |
| `browser_reopen_headed` | 仅在暂停状态请求人工接管窗口 |
| `browser_resume` | `humanConfirmed: true` 后重新检查并恢复 |
| `browser_handoff` | 将会话切换到 headed 人工控制并签发短期一次性 lease token |
| `browser_takeover` | 用 lease token 和显式人工确认把控制权交还自动化 |
| `page_fetch` | 使用受 URL 策略约束的轻量 HTTP 客户端读取页面（仅 GET/HEAD） |
| `page_open` | 打开 allowlist 内的绝对 HTTP(S) URL |
| `page_snapshot` | 返回带 `snapshotId`/`pageRevision` 的有界语义摘要，支持 compact 输出 |
| `page_extract` | 结构化批量抽取页面列表/表格数据（根据 Schema 批量提取） |
| `page_screenshot` | 返回内嵌图像与不透明 `artifactRef`，不暴露主机路径 |
| `page_click` | 按自适应语义目标点击唯一目标 |
| `page_type` | 按自适应语义目标输入有界文本，可选择清空/提交 |
| `page_select` | 按 `value` 或 `label` 选择原生选项 |
| `page_scroll` | 以有界档位滚动 |
| `page_wait` | 等待短时长或安全语义条件 |
| `page_workflow` | 按管理员策略串行执行声明式高层步骤，遇中断立即停止 |
| `workspace_list` | 列出当前活动浏览器工作区 |
| `workspace_get` | 查询工作区控制权与保留策略 |
| `workspace_handoff` | 将工作区交给人工并签发短期 lease |
| `workspace_resume` | 经人工确认后恢复 Agent 控制 |
| `page_workflow_execute` | 执行有界声明式步骤并返回停止原因/快照 |
| `page_list_tabs` | 列出会话中的受控标签页 |
| `page_switch_tab` | 切换当前活动标签页 |
| `page_close_tab` | 关闭指定标签页 |
| `browser_capabilities` | 返回工具、限制与明确禁止的底层能力 |
| `cluster_submit_task` | 提交异步爬取/渲染任务至分布式优先级队列（支持轻重双模） |
| `cluster_batch_submit` | 批量提交爬取任务到集群调度队列（支持并发与重试控制） |
| `cluster_status` | 查询集群 Worker 节点状态与队列统计 |
| `cluster_get_task` | 按 `taskId` 查询分布式任务执行状态与抽取结果 |

语义目标示例：

```json
{
  "sessionId": "ses_example_1234",
  "target": { "role": "button", "name": "保存", "exact": true }
}
```

`page_snapshot` 返回的短期 opaque ref 也可直接使用，例如
`{"target":{"ref":"ref_..."}}`；页面导航或 DOM 身份变化后 ref 会失效，需重新快照。语义目标会在服务端通过有界快照解析，并且匹配不唯一时拒绝执行。

一个最小流程（具体 `sessionId` 由 `browser_start` 返回）：

```text
browser_start({"headless":true,"viewport":{"width":1280,"height":800})
page_open({"sessionId":"ses_...","url":"https://test.example.com/login"})
page_snapshot({"sessionId":"ses_..."})
page_type({"sessionId":"ses_...","target":{"label":"邮箱"},"text":"qa@example.com"})
page_click({"sessionId":"ses_...","target":{"role":"button","name":"继续"}})
page_screenshot({"sessionId":"ses_..."})
browser_stop({"sessionId":"ses_..."})
```

动作会经过服务端可见性、唯一性、可操作性、URL 和挑战门禁检查。页面改变后应重新 `page_snapshot`；不要猜测或复用失效目标。

### Snapshot v2 与写动作防重

`page_snapshot` 在保留原有结构化字段的基础上返回 `snapshotId`、`pageRevision`、`content`、`contentBytes` 和明确的截断状态。设置 `format: "compact"` 时，响应只保留模型可直接阅读的紧凑 `content`，不会重复携带正文和 target 数组；`maxBytes`（100–4 MiB）限制紧凑内容的 UTF-8 字节数，实际值仍受当前管理员策略限制。
```text
page_snapshot({"sessionId":"ses_...","format":"compact","maxBytes":8000})
page_snapshot({"sessionId":"ses_...","sinceSnapshotId":"snp_..."})
```

传入 `sinceSnapshotId` 时，服务从当前会话、当前 Tab 的有界内存历史中返回 `changes`（`added`、`removed`、`updated` 和 revision 变化）。历史容量、保留时间和对象大小跟随管理员策略；只保存脱敏语义节点和文本摘要，不保存页面正文、URL、标题或 compact content。未知、过期或来自其他 Tab 的基线分别返回 `SNAPSHOT_NOT_FOUND`/`SNAPSHOT_EXPIRED`。Snapshot 与写动作应同时记录返回的 `tabId`。

`page_open`、`page_click`、`page_type`、`page_select`、`page_scroll` 和 `page_workflow` 可选携带：

- `actionId`：UUID。同一会话内，同 ID、同参数的重试直接复用首次 Promise/结果，不会重复写；同 ID、不同参数返回 `ACTION_ID_CONFLICT`。
- `expectedPageRevision`：写动作开始前必须与当前 revision 一致，否则返回可重试的 `PAGE_REVISION_MISMATCH`，调用方应重新快照并使用新的 actionId。
- `expectedTabId`：写动作开始前必须仍在同一受控 Tab；切换 Tab 后即使 revision 数值相同也返回 `PAGE_REVISION_MISMATCH`。

幂等缓存按会话隔离，最多保留 256 项、TTL 10 分钟，停止会话时清空。缓存只保留 SHA-256 参数摘要和安全结果，不持久化输入正文。

### 声明式 workflow
`page_workflow` 只接受 `open`、`click`、`type`、`select`、`scroll`、`wait` 和 `snapshot`。它不接受循环、变量、表达式、JavaScript、CSS/XPath、raw selector 或协议命令。workflow 步数、总时长、结果大小和单个 Snapshot 大小跟随管理员策略，且不会超过硬上限 100 步、5 分钟、1 MiB 和 4 MiB；会话在执行期间被独占，外部交错动作返回 `SESSION_BUSY`。challenge、popup/page-crash interrupt、revision mismatch、歧义、超时或任一步错误都会停止后续步骤；dialog/download 是否作为状态中断停止由 `stopOn` 控制，未显式设置时保持安全默认；敏感输入结果只返回长度。

```text
page_workflow({"sessionId":"ses_...","expectedTabId":"tab_1","steps":[
  {"op":"open","url":"https://test.example.com/profile"},
  {"op":"click","target":{"role":"button","name":"编辑"}},
  {"op":"snapshot","format":"compact","maxBytes":8000}
]})
```
`page_workflow_execute` 使用同一套管理员策略和硬上限，但只接受 `WorkflowStepSchema`：不接受 `type` 字段，每一步使用 `op` 和语义目标，`scroll.amount` 按策略限制（硬上限 1–20），`select.values` 会串行执行。`stopOn` 只控制可选的 navigation/dialog/download/ambiguity 停止条件；challenge、popup/page-crash、revision mismatch、超时和错误仍始终停止。遇到中断时返回 `stoppedReason` 与有界当前 Snapshot。超过当前策略步数返回 `WORKFLOW_STEP_LIMIT_EXCEEDED`。

`browser_start` 可传 `workspaceName` 与 `workspaceRetention`。工作区生命周期通过 `workspace_list`/`workspace_get` 查询；`workspace_handoff` 后所有 Agent 写操作返回 `USER_CONTROL_HARD_STOP`，只有一次性 lease 与 `humanConfirmed: true` 的 `workspace_resume` 才能恢复。启用租户认证时，会话/工作区工具必须携带有效 `tenantId` 与 `tenantToken`；服务按租户过滤并拒绝跨租户 session/workspace 访问。`retain`/`keep_until` 工作区记录只在当前进程内保留，并受服务端 1 分钟至 7 天 TTL 上限约束，进程重启不会恢复浏览器或记录。

一个会话的受控 Tab 数按管理员策略限制（硬上限 32）。新窗口通过 URL 策略后才进入 `page_list_tabs`；`page_switch_tab` 切换后续页面操作的目标，Tab 之间的 `tabId`、page revision、semantic ref 和 Snapshot history 完全隔离；headed handoff/reopen 会恢复已打开 Tab 的数量与 URL；超限弹窗自动关闭并记录 `TAB_LIMIT_EXCEEDED`。

`browser_capabilities` 返回服务版本、当前策略、工具清单、有效资源限制、并发/Tab/TTL 限制和私网开关，并明确列出禁止的 `raw_evaluate`、`raw_selector`、`raw_cdp`、`unmanaged_extension_loading`、`arbitrary_extension_path` 等底层能力。代理、确定性环境和受管扩展配置通过受校验的高层管理面提供，不开放原始协议或任意路径注入。

### 安全阻断事件

popup、原生 dialog 和 download 仍默认关闭、dismiss 或 cancel，不会扩大能力边界；但它们不再静默消失。`browser_status.interrupts` 返回累计数量、最新 sequence 和最多 16 条脱敏事件摘要，类型包括 `POPUP_BLOCKED`、`DIALOG_BLOCKED`、`DOWNLOAD_BLOCKED` 和 `PAGE_CRASHED`。摘要不包含 dialog 正文、下载 URL 或页面敏感内容。

`page_extract` 同时限制条数、单字段字符数和完整 JSON 的 UTF-8 字节数。字段会在页面侧先截断，累计结果超过服务端硬上限时返回 `RESOURCE_EXHAUSTED`，避免把无界页面文本带入 MCP 或 Redis。

## Headless、headed 与人工接管

`headless: true` 适合 CI 和无图形桌面测试，但不能人工操作。如果检测到 Cloudflare/Turnstile/CAPTCHA 或其他机器人挑战，会话进入暂停状态。此时只允许状态、语义快照、截图、有界等待、停止和人工接管；导航、点击、输入、选择和滚动全部拒绝。

`headless: false` 使用 headed Firefox。`browser_reopen_headed` 不是挑战求解器：它只把已暂停会话交给受信任操作员。操作员完成站点要求后，调用方仍必须显式发送 `browser_resume({"sessionId":"ses_...","humanConfirmed":true})`；服务端会再次检测，挑战仍在时保持暂停。没有图形桌面的服务器不能提供本地人工接管，应停止或转到经过审批的人工流程。

普通人工复核可调用 `browser_handoff`，服务会在需要时以 headed 模式重启同一服务端 profile，并进入 `USER_CONTROLLED`。此期间页面读取和写入都 hard-stop；返回的 lease token 只出现一次，服务仅保留 SHA-256 摘要。操作员结束后调用 `browser_takeover` 并提供 token 与 `humanConfirmed: true`，服务重新扫描 challenge 后才恢复。lease 过期不会自动把控制权交回 Agent。本地 stdio 无法从密码学上证明“确认”一定来自人类，因此宿主/操作台必须把这两个工具置于受信任的人机审批边界，不能让普通 Agent 自行完成整套交接。

测试自己的 Turnstile fixture 时，应使用 Cloudflare 官方测试 sitekey/secret，不要把生产凭据或生产挑战放进自动化测试。参见 [Cloudflare 官方 Turnstile 测试密钥文档](https://developers.cloudflare.com/turnstile/troubleshooting/testing/)。测试密钥只用于测试环境；遇到真实生产挑战，本服务的合格行为仍然是暂停，不是“通过”。

## 集群运行

Master 仍是本地 stdio MCP 进程；集群模式只把任务队列放到 Redis。先启动 Redis 和 Worker：

```sh
docker compose -f docker-compose.cluster.yml up --build
```

这个 compose 文件提供的是单实例 Redis 开发环境；原生 Redis Cluster 通常连接已有的托管/运维集群，不要把该 compose 的单实例地址直接当作 Cluster 启动节点。

启动前必须设置 `BROWSER_ALLOWED_HOSTS`。本地 MCP 配置还需要设置 `REDIS_URL`，Worker 使用 `npm run start:worker` 对 Redis 队列进行消费。当前集群 Worker 的 HTTP 模式只支持受策略约束的 GET/HEAD；浏览器模式使用服务端受控 Firefox 会话。调高 `WORKER_CONCURRENCY` 时应同步调高 `BROWSER_MAX_SESSIONS`。

Worker 与 MCP 进程都读取相同的 `BROWSER_SESSION_TTL_MS`，浏览器-only Worker 不会
创建控制面 Redis 连接；请在所有 Worker 上保持会话 TTL、并发和 URL 策略配置一致。

适配器支持两种 Redis 形态：

- 单实例本地开发形态：设置 `REDIS_MODE=standalone` 和 `REDIS_URL`。
- 原生 Redis Cluster：设置 `REDIS_MODE=cluster`、`REDIS_CLUSTER_NODES`（逗号分隔的启动节点）和相同的 `REDIS_SHARD_COUNT`。每个“租户 + 分片”使用 Redis hash tag，单次 Lua 出队/租约操作保持在一个 Cluster slot 内；不同租户和分片可以分散到不同节点。`REDIS_URL` 可用 `rediss://user:password@node:port` 为 Cluster 节点提供统一 ACL/TLS 配置。

任务、URL 排重、Worker 心跳和状态查询都按租户隔离。同一个 URL 可以被不同租户分别提交；同一租户内仍然是原子排重。URL 声明成功但任务入队失败时会执行租户内补偿释放，避免失败提交占用长期排重 TTL。生产环境设置 `TENANT_CREDENTIALS_JSON` 后，四个 `cluster_*` 工具必须携带对应的 `tenantId` 和 32 字符以上 `tenantToken`；角色为 `read` 的租户只能查询，`submit` 才能提交任务。token 只在 MCP 进程内校验，不写入 Redis 任务记录、审计事件或错误响应。Worker 用 `WORKER_TENANTS=tenant-a,tenant-b` 声明可信消费范围，未配置时仅消费 `default` 租户。

`cluster_*` 是跨进程的控制面能力；`browser_*` 会话仍归属当前 MCP/Worker 进程，不会因为租户字段而共享浏览器 profile。无 `TENANT_CREDENTIALS_JSON` 时仅适合本机开发，默认租户为 `default`；生产部署应同时使用 TLS/ACL、密钥管理和独立的 Worker 租户白名单。
启用 `TENANT_CREDENTIALS_JSON` 后，`browser_*`、`page_*` 和 `workspace_*` 工具也必须携带对应的 `tenantId` 与 `tenantToken`；凭据只在 MCP 进程内校验，绝不转发给 manager、浏览器页面、Redis、审计或错误响应。浏览器工作区不会跨进程共享，租户认证不等于浏览器状态持久化。

## 错误、审计与测试

工具失败仍返回 MCP `isError: true`，并在 `structuredContent` 和短文本中提供稳定 JSON：

```json
{
  "ok": false,
  "sessionId": "ses_...",
  "traceId": "tr_...",
  "error": {
    "code": "TARGET_NOT_FOUND",
    "message": "The target was not found.",
    "retryable": false,
    "details": {}
  }
}
```

常见 code 包括 `SESSION_NOT_FOUND`、`SESSION_EXPIRED`、`INVALID_STATE`、`SESSION_PAUSED_CHALLENGE`、`NAVIGATION_DENIED`、`PRIVATE_NETWORK_DENIED`、`TARGET_NOT_FOUND`、`TARGET_AMBIGUOUS`、`ACTION_TIMEOUT`、`BROWSER_LAUNCH_FAILED` 和 `INTERNAL_ERROR`。输入、密码、Cookie、Authorization、页面全文和 URL query 不写入普通审计；审计为服务端追加 JSONL。

```sh
npm run typecheck
npm test
npm run build
```

MCP 契约测试覆盖 `tools/list` 的精确工具集合、严格 schema、注解、输入错误、截图路径隔离和 manager stub 调用。默认集成测试使用注入 launcher，不启动真实浏览器。安装项目锁定的 Firefox 后，可运行 `npm run test:firefox`，以本机真实 Firefox 访问本地 fixture；该测试不会访问、求解或统计真实 Cloudflare/CAPTCHA 页面。

只有 `npm run test:firefox` 在部署宿主通过后，才可把该宿主标记为 Firefox 运行时就绪。单元测试、类型检查或 fake-launcher 集成测试通过，不等价于本机 Firefox 可启动。

## 故障排查

- **启动立即失败**：检查 `BROWSER_ALLOWED_HOSTS` 是否设置、是否包含裸 `*`、URL/端口/空项；检查数据目录和审计路径是否为可写的绝对路径。
- **浏览器启动失败**：运行对应的 `npm run install:firefox` 或 `npm run install:chromium`，确认 Node、lockfile 与 Playwright 版本一致，再运行真实浏览器测试。服务只启动 Playwright 锁定的内核，并核对实际版本；不会回退到系统 Firefox、Chrome/Edge，也不会跨引擎替代。Windows 上 Firefox 若只看到 `spawn UNKNOWN`，请同时检查“事件查看器 → Windows 日志 → 应用程序”的 `SideBySide` 事件；若指向 `mozglue` 激活上下文/程序集错误，应在受支持的干净 Windows 或 Linux 宿主复验，不要修改或替换浏览器二进制。
- **导航被拒绝**：确认 URL 为 HTTP(S)、主机精确命中 allowlist，且 DNS 结果不是私网/元数据地址。不要用重试绕过策略。
- **动作暂停**：先调用 `browser_status`/`page_screenshot`。挑战状态下不要点击、输入、滚动、导航或刷新；请求人工接管或停止。
- **目标找不到/歧义**：先重新 `page_snapshot`，改用唯一的 role/name、label 或 testId；不要改成 CSS、XPath 或坐标。
- **stdout 出现非 JSON-RPC 文本**：将调试日志改写到 stderr，并检查启动脚本、shell profile 和第三方包装器。
