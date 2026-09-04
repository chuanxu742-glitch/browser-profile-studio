# 当前实现与验收报告

> 当前交付版本：本地 Profile 隔离 Studio + 合规、策略约束、可审计的 Firefox 自动化 MCP。
> 日期：2026-09-01

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

| 项目 | 结果 | 说明 |
| --- | --- | --- |
| `npm run typecheck` | 通过 | TypeScript 类型检查 |
| `npm run build` | 通过 | 生成 ESM `dist/`，包含 Worker 入口；Worker 入口导入检查通过 |
| `npm run test:unit` | 通过（203） | 覆盖 REST 预检、任务筛选分页、脱敏详情、任务取消/重试及既有单元回归 |
| `npm run test:mcp` | 通过（35） | 覆盖工具 schema、Snapshot diff/workflow/handoff 分发、错误脱敏、租户认证和 MCP 边界拒绝 |
| `npm run test:integration` | 未完全通过（25 通过 / 1 失败 / 5 跳过） | Firefox frame/worker 一致性用例等待 Service Worker 消息超时；超时后清理 Profile 时另见 SQLite `EBUSY` |
| `npm run test:firefox` | 通过（1） | 真实 Firefox 浏览器回归 |

真实 Firefox smoke 已在当前宿主通过。发布前仍需在目标环境复跑，并完成真实业务域名与出口策略验收。

## 5. 集群运行说明

1. 配置精确的 `BROWSER_ALLOWED_HOSTS`，保持 `BROWSER_ALLOW_HTTP=false` 和 `BROWSER_ALLOW_PRIVATE_NETWORK=false`。
2. 使用 `docker compose -f docker-compose.cluster.yml up --build` 启动 Redis 与 Worker。
3. 本地 MCP master 设置相同的 `REDIS_URL` 后，通过 stdio 暴露 `cluster_*` 工具。
4. Worker 使用 `node dist/distributed/worker-entrypoint.js` 启动，任务取出后拥有有限租约；Worker 崩溃时，租约过期后由下一次取任务触发回收并按 `maxRetries` 重试。
5. 调高 `WORKER_CONCURRENCY` 时同步调高 `BROWSER_MAX_SESSIONS`，否则浏览器任务会因会话配额主动重试。
6. 原生 Redis Cluster 需要设置 `REDIS_MODE=cluster`、`REDIS_CLUSTER_NODES` 和所有进程一致的 `REDIS_SHARD_COUNT`；生产环境应使用 TLS/ACL 和密钥管理。
7. 设置 `TENANT_CREDENTIALS_JSON` 后，MCP 的 `cluster_*` 调用启用租户认证；设置 `WORKER_TENANTS` 后，Worker 只消费白名单租户。

当前已实现的是“本地 stdio MCP 控制面 + Redis 跨进程任务面”的多租户形态；远程 MCP 接入、远程人工接管 URL、持久化工件仓库和完整控制面监控仍属于后续目标，不应提前宣称。

本次自动化验证覆盖内存适配器、MCP 认证和 Redis Cluster 配置/哈希分片代码路径；未连接真实 Redis Cluster 做节点故障转移压测。部署前仍需在目标环境补做 Redis Cluster 连通性、MOVED/ASK、节点故障和容量测试。

## 6. 发布门槛

- 目标宿主 `npm run test:firefox` 通过；
- allowlist、HTTP/私网策略和 Redis 访问范围经过环境验收；
- Worker 的 Firefox 运行环境已安装 Playwright 对应浏览器版本；
- 对真实业务域名完成 staging 验收，并确认挑战页只会暂停而不会自动求解；
- 继续保留 typecheck、三组自动化测试和依赖审计作为发布前门禁。
