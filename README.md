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

Worker 身份链路：受管 Chromium 使用回环 CDP 通道和单一目标暂停所有者，在 URL、module、Blob、嵌套、SharedWorker 与 Service Worker 首段脚本执行前配置实际运行域；不改写应用消息。UA/UAData、语言、时区与 GPU/Canvas 需要用 Worker 内序列化的真实结果验证，而非页面回显。

Firefox 使用 Gecko 原生首选项对齐可支持的身份字段；stock 内核的并发数受宿主上限约束，异地时区会话通过真实引擎设置禁用 Service Worker。当前已验证的定制补丁仅覆盖原生 CPU/时区，不包含首脚本 Worker Canvas bootstrap。因此 **Firefox 深层 Worker Canvas 全一致性验收仍为 NOT PASSED**，`workerBootstrapByEngine.firefox` 及完整 Service Worker 注入能力保持 `false`；自定义可执行文件路径本身不是完整支持证明。页面 Canvas 保护仍启用，诊断必须保留不支持项及实际像素差异。

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

- `/api/v1/openapi.json`：OpenAPI 3.1 入口；Profile 列表支持 `q`、`name`、`tag`、`country`、`engine`、`cursor`、`limit`，响应为 `{ items, nextCursor, total }`，总数同时返回在 `X-Total-Count`。
- `/api/v1/profiles/trash`、`/profiles/{id}/restore`、`/profiles/{id}/purge`：回收站、恢复与仅 owner 可用的永久清除。
- `/api/v1/profiles/{id}/health`：仅 manager 和 owner 可用的读写接口，维护 Profile 的健康快照。
- `/api/v1/profiles/{id}/backups`、`/api/v1/profiles/{id}/backups/{backupId}/restore`：仅 owner 可用；备份只返回不含服务器路径的 opaque `backupId`，恢复会停止该 Profile 的活动会话并校验清单中的 Profile ID。
- `/api/v1/team/*`：工作区、成员、资源 grants 以及只在创建时返回明文的可撤销 API Key。
- `/api/v1/extensions`、`/extensions/import`、`/profiles/{id}/extensions`：仅 owner 可导入的受管 ZIP/XPI 仓库，以及按 Profile 分配扩展。
- `/api/v1/migration/local-browsers`、`/migration/import-local`：仅 owner 可用的本机 Chrome、Edge、Firefox Profile 扫描与网站会话迁移。
- `/api/v1/sessions/{sessionId}/ws`：`abs-rpc/1` 有界 WebSocket 自动化协议，支持 status/open/click/type/select/scroll/snapshot/screenshot；它不是原始 CDP。
- `/api/v1/synchronizer/captures`：显式启停主窗口动作捕获。只同步可解析的语义目标，密码字段被排除。
- `/api/v1/product/capabilities`、`/product/runtime-health`、`/metrics`：真实能力边界、外部云运行时适配器状态和本机运行指标。

受管 Profile 在安全停止时原子保存 cookies、localStorage、IndexedDB 与虚拟 WebAuthn 凭据；最新登录态还会按版本写入有界检查点。配置主密钥后，检查点和备份均使用 AES-256-GCM 认证加密；损坏的最新检查点会回退到更早的有效版本。服务端失效、验证码和站点主动登出仍会使登录态失效。

小状态文件使用同目录临时文件、`fsync`、原子替换和 `.bak` 上一版本恢复。多进程写同一 Profile 时必须启用共享 Redis Profile lease；版本化登录检查点另有 CAS 冲突检测。云浏览器与 Android 云手机只提供标准 provider 适配边界，以及经过鉴权的创建、停止和健康检查 API；未注册并配置真实供应商与凭据时，能力接口会返回未配置，不会创建模拟设备或伪造连接地址。

### 本机浏览器数据导入

Studio 的“数据迁移与互通”页面可以扫描系统默认位置中的 Chrome、Edge 和 Firefox Profile。导入前必须完全退出源浏览器；服务只接受扫描产生的 `sourceId`，不接受调用方提交任意本机路径。迁移内容包括 Cookie 数据库、Local/Session Storage、IndexedDB、Service Worker 存储和必要的站点权限数据。密码库、历史记录、书签、自动填充和源浏览器扩展不会复制，符号链接与锁文件也会跳过。

Chromium 的 Cookie 可能受 Windows DPAPI 或 App-Bound Encryption 保护。导入器会复制最小化的 `os_crypt` 元数据，但不会绕过操作系统保护；如果项目锁定的 Chromium 无法解密，其他站点存储仍会保留，登录 Cookie 需要在导入后的持久 Profile 中手动重新建立。Firefox Cookie 数据库和 origin storage 会复制到 Firefox Profile 根目录。

也可以先从命令行只扫描，再按 `sourceId` 导入：

```powershell
npm run import:local
npm run import:local -- <sourceId> confirm-browser-closed
```

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

如果当前网络通过 Meta Tunnel 将已批准的公网域名解析到 `198.18.0.0/15` 的合成地址，管理员可显式设置 `BROWSER_ALLOW_SYNTHETIC_TUNNEL=true`。该开关只放行 `198.18.0.0/15`，仍然拒绝 RFC1918、回环、链路本地和云元数据地址；默认关闭，不应替代正常公网 DNS。

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
侧实现 `antigravity-bridge.v1` 协议并继续执行页面挑战暂停与人工确认流程。实例可以通过
`PATCH /api/browsers/<id>` 在停止状态切换模式，并通过 `/api/bindings` 将站点绑定到指定实例。

仓库现已自带 [`browser-bridge-extension`](./browser-bridge-extension) Manifest V3 扩展。它参考
OpenCLI/Razormind 的“扩展 + 本机守护进程 + `chrome.debugger`”架构，直接使用常用 Chrome 中
已经登录的页面，不复制 Cookie，也不受 Chrome App-Bound Encryption 的跨内核解密限制。
扩展只允许连接 `localhost`/`127.0.0.1`，控制面只接受 `navigate`、语义快照、点击、输入、
选择、滚动、截图和受限标签页管理；没有原始 Cookie、任意 JavaScript 或任意 CDP 方法入口。

构建并启动控制面后，可生成/复用本机 Chrome Bridge 配置：

```sh
npm run build
CONTROL_PLANE_TOKEN='use-a-long-random-secret' npm run start:control-plane
# 另开一个终端，使用相同 Token：
CONTROL_PLANE_TOKEN='use-a-long-random-secret' npm run bridge:setup
```

随后打开 `chrome://extensions`，启用开发者模式并“加载已解压的扩展程序”，选择命令输出的
绝对目录，在扩展弹窗中填写 endpoint、browserId 和 Token，再在已登录网站点击“绑定当前标签页”。
Chrome 显示“正在调试此浏览器”的提示属于 `chrome.debugger` 的正常安全提醒。控制面还提供
`POST /api/browsers/<id>/call` 供受信任的本机客户端调用上述受限操作。
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

### 通用生产出口验收

使用环境变量驱动，不把业务域名写入代码：

```powershell
$env:BROWSER_ALLOWED_HOSTS = 'shop.example.com,static.shop.example.com'
$env:ACCEPTANCE_TARGET_URLS = 'https://shop.example.com/health,https://static.shop.example.com/'
$env:ACCEPTANCE_EXPECTED_EGRESS_IPS = '203.0.113.10'
$env:ACCEPTANCE_EGRESS_IP_URL = 'https://你的出口探针域名/ip'
npm run acceptance:egress
```

脚本只执行无登录 GET、策略预检和手动检查重定向，不跟随未授权重定向，不读取响应正文。未设置 `ACCEPTANCE_TARGET_URLS` 时仅执行应用层策略矩阵；未设置预期出口 IP 时出口检查标记为 `SKIP`，不会冒充生产网络验收。使用 `npm run acceptance:egress -- --fixture` 可在无生产域名时执行确定性的 allowlist、HTTPS、私网和元数据阻断验收。

## MCP 配置

`mcp-config.example.json` 是可复制的最小示例。将 `args` 改成生成后的绝对路径，并替换为自己管理的测试域名。Windows 配置：

```json
{
  "mcpServers": {
    "compliant-firefox": {
      "command": "node",
      "args": ["C:\\path\\to\\browser-profile-studio\\dist\\index.js"],
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

服务注册以下 40 个标准 MCP 工具：

| 工具 | 作用 |
| --- | --- |
| `browser_start` | 启动受策略约束的 headless/headed Firefox 会话 |
| `browser_status` | 查询状态、页面摘要、挑战状态和最近的安全阻断事件 |
| `browser_environment_diagnostics` | 只读检查 User-Agent、平台、语言、时区、Viewport、硬件、WebGL 与 `navigator.webdriver` 一致性；不返回页面正文、Cookie 或凭据 |
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
| `cluster_list_tasks` | 按 `projectId`、`runId`、状态和租户筛选任务，便于观察一次爬取运行 |

提交任务时可带稳定的 `projectId` / `runId`（仅允许字母、数字、`.`, `_`, `-`，最多 64 字符），随后用 `cluster_list_tasks` 查询某次运行；查询仍按租户隔离并受既有 URL allowlist、重试、租约和审计策略约束。

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

Master 仍是本地 stdio MCP 进程；集群模式依赖 Redis 共享任务队列、Profile lease 与节点位置（placement/CAS scope）。Worker 未配置 `WORKER_STORAGE_NAMESPACE` 时使用节点唯一的本地 namespace，不会把本地磁盘误判成共享盘。只有确实挂载同一 Profile/检查点存储、配置相同 `BROWSER_MASTER_KEY`，并显式设置相同 namespace 的 Worker 才能进行账号任务故障转移。generation fence 会拒绝旧位置任务；当前版本仍不支持正在运行的浏览器工作区热迁移。

```sh
docker compose -f docker-compose.cluster.yml up --build
```

## 生产环境运维 (Production Operations)

- **容量释放闸口**：先执行 `npm run capacity:release -- calibrate capacity-baseline.json` 生成同机基线，再执行 `npm run capacity:release -- gate capacity-baseline.json`。闸口比较五类延迟、RSS、任务失败及隔离不变量；`high_checkpoint_failures`、`high_proxy_quarantine` 是可观测告警，**不会自动修改准入阈值**。
- **外置依赖限制**：仓库不内置托管 Redis Cluster、KMS、共享文件系统、生产凭据或告警通知通道；多机发布必须由运维提供这些依赖，并确保共享存储 namespace 与主密钥一致。
- **24–72 小时浸泡**：默认 `npm run soak` 只运行 5 秒烟测。长期释放验证需显式执行 `$env:LONG_MODE='true'; $env:SOAK_DURATION_MS='86400000'; npm run soak`（最长 `259200000` 毫秒），并保存最终 NDJSON 指标。短时运行不能证明长期稳定性。
- **登录提供方矩阵**：`npm run acceptance:login -- login-acceptance.json` 只验证授权方提供的凭据/授权标记及人工采集证据，不会登录真实站点。缺凭据、缺授权或缺证据返回 `blocked` 和退出码 2；观察失败返回退出码 1。
- **备份与密钥轮换**：
  - 创建与恢复：Studio API `POST /api/v1/profiles/{id}/backups` 和 `POST /api/v1/profiles/{id}/backups/{backupId}/restore`。
  - 轮换：设置 `OLD_STUDIO_MASTER_KEY`、`NEW_STUDIO_MASTER_KEY` 和可选 `BACKUP_DIR` 后运行 `npm run rekey:backups`。脚本先校验每个文件摘要，再以内存明文、磁盘密文方式原子替换；任一文件失败即返回非零退出码。

这个 compose 文件提供的是单实例 Redis 开发环境；原生 Redis Cluster 通常连接已有的托管/运维集群，不要把该 compose 的单实例地址直接当作 Cluster 启动节点。

启动 compose 前必须设置 `BROWSER_ALLOWED_HOSTS`、32 字符以上的 `CONTROL_PLANE_TOKEN` 和 16 字节以上的 `BROWSER_MASTER_KEY`；两个 Worker 共享 compose 命名卷、storage namespace 和主密钥。本地 MCP 配置还需要设置 `REDIS_URL`，Worker 使用 `npm run start:worker` 对 Redis 队列进行消费。当前集群 Worker 的 HTTP 模式只支持受策略约束的 GET/HEAD；浏览器模式使用服务端受控 Firefox 会话。调高 `WORKER_CONCURRENCY` 时应同步调高 `BROWSER_MAX_SESSIONS`。

Worker 与 MCP 进程都读取相同的 `BROWSER_SESSION_TTL_MS`。Worker 的 `SessionManager` 禁用内置队列连接，并复用 entrypoint 创建的 Redis adapter 完成任务队列、Profile lease 和 placement fencing；请在所有 Worker 上保持会话 TTL、并发和 URL 策略配置一致。

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

MCP 契约测试覆盖 `tools/list` 的精确工具集合、严格 schema、注解、输入错误、截图路径隔离和 manager stub 调用。集成目录同时包含注入 launcher 的契约测试与本机真实浏览器测试；安装项目锁定的内核后运行相应真实测试。`npm run test:firefox` 使用本机 Firefox 访问本地 fixture，不会访问、求解或统计真实 Cloudflare/CAPTCHA 页面。

只有 `npm run test:firefox` 在部署宿主通过后，才可把该宿主标记为 Firefox 运行时就绪。单元测试、类型检查或 fake-launcher 集成测试通过，不等价于本机 Firefox 可启动。

### 指纹运行时与线上验收（2026-09-05）

本次修复保留原生非自动化 `navigator.webdriver === false` 属性、跨 realm 的原生函数外观与非法 receiver 异常；不伪造插件、媒体设备或消息载荷。Canvas 采用幂等像素投影，HTML/Offscreen 读取及无损导出保持一致，并仅移除已验证的非渲染 PNG `deBG` 随机元数据以保持同种子原始导出字节稳定。Audio 保留真实采样率、静音和可写 buffer 契约；普通 WebRTC offer/设置本地描述可执行，但这不证明实际 ICE/STUN 代理出口安全。

- **网络契约**：默认 `Accept-Language` 与完整 Profile 语言列表一致；显式 locale 可收窄列表。Chromium 拒绝与 Profile 冲突的显式语言头，比较语言顺序时忽略大小写并允许合法权重。地理对齐不再向所有资源强塞 HTML `Accept`、`Sec-Fetch-*` 或 `Upgrade-Insecure-Requests`；文档、脚本、样式、fetch 与 Worker 的请求语义由浏览器原生生成。Client Hints 必须在文档及实际携带它们的请求上自洽，不要求浏览器原本不发送 hints 的 Worker 请求伪造这些头。
- **诊断边界**：缺少证据、Service Worker 未实际执行、网络出口未验证时保留 `warning`，真实不一致为 `fail`。headed 原生合成器可能有亚像素舍入，CSS viewport 检查采用 ±0.5 CSS px，有限正 DPR 采用相对 `2^-23` 容差；原始测量值仍保留，明显尺寸/比例差异不会因此放行。
- **本地验收**：`npm run test:fingerprint-runtime` 显式启用真实内核回归，覆盖原始 Worker 身份、请求头、公开 SessionManager 子资源执行、Canvas/Audio/WebRTC 与跨 realm 契约。Firefox 执行同样的像素探针，但将不支持的严格 Worker Canvas 验收单独记录为 `NOT PASSED`，不以单元测试或页面检测通过代替。完整修复需要匹配的 Gecko 源码、首脚本 Worker bootstrap 原生补丁及 MozillaBuild/Rust/Cargo/编译工具链；本次宿主缺少这些构建前提，现有 CPU/时区补丁不能代替。
- **线上证据**：`npm run test:benchmarks` 保存实际选项、观测历史、截图和错误。通过 `BENCHMARK_ENGINE`、`BENCHMARK_HEADLESS`、`BENCHMARK_COUNTRY`、`BENCHMARK_RESULT_TIMEOUT_MS` 等环境变量选择条件；比较前须保持 engine、headed/headless、种子、OS、地区与出口条件一致。占位零分、未完成脚本、超时或挑战不能算通过；CreepJS 百分比只是站点启发式，不是封禁概率或全局通过率。
- **退出码与独立结论**：结果 JSON 分开记录站点 `status` 与 `runtimeAssessment`。站点通过但运行时明确不一致，仍保留站点通过并将套件判失败；`warning` 仅表示未验证，不冒充失败或一致。退出码 `0` 表示站点验收完成且无已证明的运行时失败，`1` 表示站点/运行时明确失败或执行错误，`2` 表示无明确失败但验收未完成或无可验证的二元结论。即使退出 `0`，仍须阅读未验证警告。

本次证据保存在 `artifacts/fingerprint-repair-20260905/`，此前审计保留于 `artifacts/fingerprint-audit-20260905/`。本地支持项通过不代表 Firefox 原生阻塞项已修复，也不承诺第三方站点评分、挑战绕过或账号安全。

### CI 跨 realm 回归修正（2026-09-06）

Linux CI 的 Firefox 跨 realm 用例此前由种子生成 16 核配置，而 runner 原生 Worker 只能报告 4 核。该支持范围用例现使用明确的 2 核持久化 Profile，并逐个验证页面、iframe、Blob/URL Worker 的请求值；不修改生产配置、不按宿主静默钳制配置。不可用 WebGL renderer 按值比较，不要求 `undefined` 经 JSON 序列化后仍保留属性。真实超宿主核数探针仍报告 Worker CPU 不一致，Firefox 首脚本 Worker Canvas 仍为 **NOT PASSED**。诊断与验证证据保存在 `artifacts/ci-repair-20260906/`；本地通过不等于 GitHub CI 已通过。

## 故障排查

- **启动立即失败**：检查 `BROWSER_ALLOWED_HOSTS` 是否设置、是否包含裸 `*`、URL/端口/空项；检查数据目录和审计路径是否为可写的绝对路径。
- **浏览器启动失败**：运行对应的 `npm run install:firefox` 或 `npm run install:chromium`，确认 Node、lockfile 与 Playwright 版本一致，再运行真实浏览器测试。服务只启动 Playwright 锁定的内核，并核对实际版本；不会回退到系统 Firefox、Chrome/Edge，也不会跨引擎替代。Windows 上 Firefox 若只看到 `spawn UNKNOWN`，请同时检查“事件查看器 → Windows 日志 → 应用程序”的 `SideBySide` 事件；若指向 `mozglue` 激活上下文/程序集错误，应在受支持的干净 Windows 或 Linux 宿主复验，不要修改或替换浏览器二进制。
- **导航被拒绝**：确认 URL 为 HTTP(S)、主机精确命中 allowlist，且 DNS 结果不是私网/元数据地址。不要用重试绕过策略。
- **动作暂停**：先调用 `browser_status`/`page_screenshot`。挑战状态下不要点击、输入、滚动、导航或刷新；请求人工接管或停止。
- **目标找不到/歧义**：先重新 `page_snapshot`，改用唯一的 role/name、label 或 testId；不要改成 CSS、XPath 或坐标。
- **stdout 出现非 JSON-RPC 文本**：将调试日志改写到 stderr，并检查启动脚本、shell profile 和第三方包装器。
