# 当前实现与验收报告

> 当前交付版本：本地 Profile 隔离 Studio + 合规、策略约束、可审计的 Firefox 自动化 MCP。
> 日期：2026-09-05。历史证据与本轮新验证分开记录；新验证快照位于 [`artifacts/verification/2026-09-05T09-33-51-192Z/`](../artifacts/verification/2026-09-05T09-33-51-192Z/)。

## 1. 当前结论

项目包含两个边界清晰的入口：本地 Studio REST/桌面控制台负责 Profile、代理池、RPA 与本机运维；stdio MCP 公开高层工具，面向已获授权的网站执行受限导航、读取和 UI 交互。

MCP 公开边界不包含任意 JavaScript、写操作 raw selector、raw protocol、扩展加载、坐标点击、挑战求解或任意 HTTP 写请求。Studio 新增的代理池和声明式 RPA 仍通过 SessionManager 高层动作与同一挑战/资源策略，不向调用方暴露原始 Page 对象。

Studio 已交付 REST 鉴权、四级 RBAC、受限 CORS、HTTP 审计、Profile 更新/克隆/批量操作、持久代理池与轮换、声明式 RPA 调度/取消/日志，以及 Cookie、代理密码、2FA Secret 的 AES-256-GCM 加密和旧明文首次读取迁移。

网络出口由服务端 `UrlPolicy` 统一控制：顶层导航、重定向、子资源、`page_fetch` 和集群任务都必须经过 allowlist、协议、DNS/IP 私网检查和速率/资源限制。`page_fetch` 只接受 GET/HEAD，不接受调用方自定义请求体或任意请求头。

## 2. 已交付能力

- 本地 stdio MCP，工具输入使用 Zod 严格校验，并同步维护稳定的 `tools/list` JSON Schema。
- 独立 Firefox 会话、临时 profile/artifact 目录、管理员可选资源策略配额、挑战检测、人工接管状态机和结构化审计。
- 语义目标（role、label、testId、短期 ref）驱动的点击、输入、选择、滚动和等待。
- 受服务端 URL 策略约束的浏览器导航与轻量 GET/HEAD 抓取。
- Redis standalone/native Cluster 队列、租户 + 分片路由、跨 Worker URL 排重、Worker 心跳和 Redis 任务租约过期回收。
- 集群任务的跨租户隔离与可选 token/RBAC 认证；Worker 可通过租户白名单限制消费范围。
- 批量 URL 声明具备整批原子语义；Worker 启停、取消、重试和共享适配器关闭具备并发保护。
- 可直接构建的 Worker 入口和 Dockerfile；MCP master 保持本地 stdio，Worker 通过 Redis 消费任务。
- Snapshot v2：在兼容原结构化快照的同时提供 `snapshotId`、`pageRevision`、UTF-8 字节预算和不重复正文/target 的 compact 模式；历史容量与对象大小跟随管理员策略。
- Snapshot diff：`sinceSnapshotId` 使用会话级有界内存历史返回 added/removed/updated，历史不保存正文、URL 或标题。
- 通用人工控制租约：`browser_handoff`/`browser_takeover`、一次性 token 摘要、TTL 和 `USER_CONTROLLED` hard-stop。
- 声明式 workflow：步数、时长、结果和 Snapshot 大小跟随管理员策略，并受硬上限约束；只组合公开高层动作，独占会话、遇中断即停。
- 写动作可靠性：导航、点击、输入、选择和滚动支持可选 `actionId` 幂等与 `expectedPageRevision` 前置检查；缓存只保留内存摘要和安全结果。
- 安全 interrupt 可见性：被默认阻断的 popup、dialog、download 以及 page crash 会进入有界、脱敏的会话状态摘要。

## 3. 公开工具集

会话与人工控制：`browser_start`、`browser_status`、`browser_environment_diagnostics`、`browser_stop`、`browser_reopen_headed`、`browser_resume`、`browser_handoff`、`browser_takeover`。

页面读取与交互：`page_fetch`、`page_open`、`page_snapshot`、`page_extract`、`page_screenshot`、`page_click`、`page_type`、`page_select`、`page_scroll`、`page_wait`、`page_workflow`。

集群：`cluster_submit_task`、`cluster_batch_submit`、`cluster_status`、`cluster_get_task`、`cluster_list_tasks`；Studio REST 另外提供任务 URL 预检、分页/多维筛选、取消/重试和批量动作。任务支持 `projectId` / `runId` 运行关联、脱敏详情、状态事件时间线和结构化结果预览。

Studio 爬虫工作台已补齐：提交前授权确认与 URL allowlist 预检、robots 治理提示、任务详情、事件时间线、错误码、Profile/Session/Worker 关联、结构化结果表格与 JSON、分页、批量取消/重试/导出、自动刷新开关、移动端筛选和可区分的空/错状态。挑战求解、绕过、原始 lease token 和敏感凭据仍不进入 UI/API。

## 4. 验证状态

原始证据保留在 [`artifacts/benchmarks/2026-09-05T07-25-11.973Z/`](../artifacts/benchmarks/2026-09-05T07-25-11.973Z/)，不覆盖失败记录，不从页面可达性推断检测分数。下表中的历史数量仅描述当时运行。
[本轮新验证证据目录](../artifacts/verification/2026-09-05T09-33-51-192Z/)（`unit-mcp.json`、`session-proxy.json`、`integration-final.json`、权限、TLS、策略与生产不完整报告）保留原始 JSON。

| 项目 | 已观察结果 | 证据与边界 |
| --- | --- | --- |
| 历史单元 + MCP 回归 | 322 项通过、53 个文件 | `artifacts/benchmarks/.../unit-mcp-results.json`；历史快照，不覆盖后续修复 |
| 历史含集成并发回归 | 359 通过、9 失败、3 跳过 | `artifacts/benchmarks/.../regression-results.json`；并发运行不是最终串行发布门禁 |
| 历史 browserscan / whoer | `loadStatus: ERROR`，`detectionResult: unverified` | `artifacts/benchmarks/2026-09-05T07-25-11.973Z/report.json`；URL policy 拒绝导航，宿主 DNS 解析到保留的 `198.18.*` 地址，没有外站分数或检测通过证据 |
| 旧画像显式升级 | 留存升级前后、启动后界面及状态 | `artifacts/benchmarks/2026-09-05T07-25-11.973Z/profile-migration-before.png`、`profile-migration-after.png`、`profile-migration-launched.png`、`studio-migration.json`；种子与 Cookie 保留、画像版本为 2 且 Chromium 会话 READY，不推断真实站点登录态 |
| 本轮单元 + MCP | 352 项通过、54 个文件 | `unit-mcp.json`；本轮实际验证 |
| 本轮 Session proxy | 33 项通过、2 个文件 | `session-proxy.json`；本轮实际验证 |
| 本轮最终集成 | 56 项通过、1 项跳过、15 个文件 | `integration-final.json`；没有失败，但不能写成“全部通过” |
| 本轮较早集成尝试 | 55 通过、1 失败、1 跳过 | `integration.json`；历史失败保留，原因是错误假设 Firefox 重启会重置权限 |
| Firefox 权限持久化 | 原生 Playwright Firefox 重启后仍为 geolocation=granted、notifications=denied | `native-firefox-permissions.json`；当前测试改为比较未修改 Profile B 的权限基线，不强制引擎特定重置 |
| TLS 代理烟测 | 受信任本地 HTTPS 代理与嵌套 HTTPS origin 均加密且验证成功；不受信任证书在凭据/请求前拒绝 | `tls-proxy-smoke.json`；`203.0.113.9` 是 fixture 数据，不是公网出口证明 |
| 确定性策略 fixture | 7 PASS、2 SKIP，`complete: false` | `policy-fixture.json`；跳过业务域名与浏览器出口探针 |
| 生产出口不完整运行 | `complete: false`，CLI 退出码 1 | `production-incomplete.json`；`BROWSER_ALLOWED_HOSTS` 缺失 |
| 自定义 Firefox 内核 | 未验证，构建先决条件缺失 | 缺少 `mach.ps1`、MozillaBuild 和 `clang-cl`；stock Firefox 的拒绝保护不等价于 custom-core 成功 |

Vitest 全局配置已验证为 `maxWorkers=1`、`fileParallelism=false`、`maxConcurrency=1`；直接调用 Vitest 也适用。它限制单次测试进程内部并发，不阻止操作员同时启动多个测试进程。
环境诊断只比较已采集的运行时字段。缺失、未支持或不可比较的表面返回 `warning`，明确观测到破坏才返回 `fail`；局部源码呈原生样式不证明原型链、跨 frame/worker、ICE/DNS 或真实出口完整。
本轮实际完成了上述新验证；Main 报告 `tsc --noEmit` 成功，随后最终集成验证成功，之后 `npm run build` 成功。未设置 `.env`，且 Main 进程环境缺少 `ACCEPTANCE_TARGET_URLS`、`ACCEPTANCE_EXPECTED_EGRESS_IPS`、`ACCEPTANCE_EGRESS_IP_URL`、`ACCEPTANCE_PROXY_URL`、`BROWSER_ALLOWED_HOSTS`，因此公网浏览器出口、生产 acceptance 和外部检测分数仍未验证。

本轮 native 权限与浏览器验证矩阵仅在这台 Windows 宿主上执行；不代表其他操作系统。

真实 Firefox 扩展 smoke test 仍为明确跳过：源码要求 `RUN_FIREFOX_EXTENSION_XPI` 指向一个由 Mozilla 签名、含固定 Gecko ID 和签名结构的 XPI；当前没有该签名扩展前置条件。自定义 Firefox 源码/工具链同样缺失。

Chromium 代理边界：受管 Chromium 支持 HTTP password-only（空用户名）认证；没有受管指纹 Profile 的原生 Chromium 路径拒绝空用户名认证（Playwright 原生 username truthiness 限制）；Chromium 带认证 SOCKS 均为 `PROXY_AUTH_UNSUPPORTED`。`BrowserSession.open` 返回 `navigationCompleted`，可选观测 `httpStatus`；容忍部分加载为 false 且无状态码，不能作为成功。

外网验收仍依赖获授权业务目标、可用公网 DNS、出口探针、预期 IP 与实际代理配置；未满足时不得标记完整发布接受。

## 5. 集群运行说明


1. 配置精确的 `BROWSER_ALLOWED_HOSTS`，保持 `BROWSER_ALLOW_HTTP=false` 和 `BROWSER_ALLOW_PRIVATE_NETWORK=false`。
2. 使用 `docker compose -f docker-compose.cluster.yml up --build` 启动 Redis 与 Worker。
3. 本地 MCP master 设置相同的 `REDIS_URL` 后，通过 stdio 暴露 `cluster_*` 工具。
4. Worker 使用 `node dist/distributed/worker-entrypoint.js` 启动，任务取出后拥有有限租约；Worker 崩溃时，租约过期后由下一次取任务触发回收并按 `maxRetries` 重试。
5. 调高 `WORKER_CONCURRENCY` 时同步调高 `BROWSER_MAX_SESSIONS`，否则浏览器任务会因会话配额主动重试。
6. 原生 Redis Cluster 需要设置 `REDIS_MODE=cluster`、`REDIS_CLUSTER_NODES` 和所有进程一致的 `REDIS_SHARD_COUNT`；生产环境应使用 TLS/ACL 和密钥管理。
7. 设置 `TENANT_CREDENTIALS_JSON` 后，MCP 的 `cluster_*` 调用启用租户认证；设置 `WORKER_TENANTS` 后，Worker 只消费白名单租户。

当前已实现的是“本地 stdio MCP 控制面 + Redis 跨进程任务面”的多租户形态；远程 MCP 接入、远程人工接管 URL、持久化工件仓库和完整控制面监控仍属于后续目标，不应提前宣称。

现有测试覆盖内存适配器、MCP 认证和 Redis Cluster 配置/哈希分片代码路径；本轮未连接真实 Redis Cluster 做节点故障转移压测。部署前仍需在目标环境补做 Redis Cluster 连通性、MOVED/ASK、节点故障和容量测试。

## 6. 发布门槛

- 目标宿主 `npm run test:firefox` 通过；
- allowlist、HTTP/私网策略和 Redis 访问范围经过环境验收；
- Worker 的 Firefox 运行环境已安装 Playwright 对应浏览器版本；
- 对真实业务域名完成 staging 验收，并确认挑战页只会暂停而不会自动求解；
- 继续保留 typecheck、三组自动化测试和依赖审计作为发布前门禁。
- `acceptance:egress -- --fixture` 仅证明确定性策略矩阵，退出码 0 也不表示生产 `complete`；必须保留真实业务域名、浏览器出口及未观测项的分项证据。
- 外部检测结果保持 `unverified`，直至获得可审阅的检测结果原文；页面截图或加载成功不能替代分数/结论。
- 要宣称自定义 Firefox 非宿主时区/跨上下文能力，必须先获得源码及完整原生工具链，实际构建并在该产物上执行对应运行时验证。
