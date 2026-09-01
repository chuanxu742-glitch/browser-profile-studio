# ego-lite 深度对照研究与演进建议

> 调研日期：2026-08-31  
> 上游仓库：[`citrolabs/ego-lite`](https://github.com/citrolabs/ego-lite)  
> 研读提交：`5ca3c36cba2240b8df2e22ba32127747029039d5`（2026-08-24）  
> 对照项目：本仓库 `compliant-firefox-automation-mcp` 0.1.0

> 目标产品：传统反检测指纹浏览器。
> 当前实现：合规、策略约束、可审计的 Firefox 自动化 MCP 基线；本文只分析当前基线可吸收的控制层设计，不表示目标产品能力已实现。

> 落地进度（2026-08-31）：已完成 Snapshot v2 与 `sinceSnapshotId` 有界差分、写动作幂等/revision 前置校验、有界 interrupt、通用 lease handoff/takeover hard-stop，以及按管理员策略限制的安全 declarative workflow。仍未引入任意脚本、raw CDP、raw selector 或共享真实用户浏览器状态。



## 1. 结论先行

ego-lite 最值得学习的不是“换成 Chromium”或“开放更多底层能力”，而是以下产品与协议设计：

1. **把任务工作区设为一等对象**：任务有名称、稳定 ID、所有权、人工接管和完成语义，不只是一个临时浏览器进程。
2. **把人工控制定义为硬停止状态**：Agent 不能把用户接管误判为可重试错误，也不能自行抢回控制权。
3. **以紧凑语义快照作为主观察面**：快照面向模型的 token 成本设计，临时 ref 与可复用定位信息分工明确。
4. **组合执行以减少往返**：复杂任务不应被迫拆成大量“观察一次、调用一次”的 MCP 循环。
5. **让浏览器事件可见**：原生对话框、弹窗、下载、导航和网络事件不能被静默处理，否则 Agent 只会看到超时。
6. **积累域名绑定的经验包**：成功流程可沉淀为有 schema、可校验、无临时 ref、无秘密的站点知识。
7. **围绕真实任务写回归测试**：除单函数测试外，还应覆盖控制权切换、跨轮次 ref、复杂表单和事件竞态。

当前基线不应照搬 ego-lite 的任意 JavaScript、raw CDP、CSS/XPath、任意文件和共享真实用户浏览器状态。上述限制描述当前交付边界；对规划目标中的反检测能力，本研究不提供实现设计。当前基线继续吸收 ego-lite 的工作区、观察协议、组合执行、经验复用和人工协作模型。


## 2. 证据边界

ego-lite 的公开仓库包含：

- `ego-browser` Node.js 控制层；
- Agent Skill 与安装脚本；
- Task Space 协议适配；
- 页面操作、事件、等待、截图和录屏辅助层；
- 站点 learnings 的 manifest、notes、tools 与校验器；
- 单元测试和真实浏览器 E2E 脚本。

公开仓库**不包含 ego-lite 浏览器内核和桌面应用本体**。因此：

- Task Space 控制层、错误处理、ref map、事件队列、learnings 格式等可以从源码验证；
- “内核级快照”“跨源 iframe/Shadow DOM 覆盖”“资源占用与速度领先”等只能视为厂商公开说明或基准结果，不能视为本次源码审计结论；
- 当前公开版本以 macOS 应用为主，Windows/Linux 仍不能当作已交付的等价运行时。

本次在 Node.js 22.15.0 下执行了上游 `npm test`，上游控制层的 299 项测试全部通过。`npm ci` 的 POSIX `prepare` 脚本在 Windows `cmd.exe` 下不兼容，但已有依赖环境下构建、类型检查和测试可通过；这也说明其开源控制层本身较跨平台，宿主应用才是主要平台约束。

## 3. 架构对照

| 维度 | 本项目当前实现 | ego-lite 开源控制层 | 建议 |
|---|---|---|---|
| 核心对象 | `BrowserSession`，每会话一个独立 Firefox persistent context 和临时目录 | Task Space，名称/ID/owner/control/complete 是显式协议 | 在 Session 之上增加 Workspace 语义，不直接改掉安全隔离 |
| 进程模型 | 每会话独立 Firefox，上限 1–32 | 同一浏览器进程内的多个 BrowserContext（内核实现未开源） | 先保持独立进程；用容量数据决定是否新增共享进程适配器 |
| 页面模型 | 明确只允许单页；新 popup 自动关闭 | 多 tab，可列举、复用、切换、关闭 | 增加受控 tab 模型；仍逐 URL 走 allowlist |
| 快照 | body 文本 + 扁平 target 数组，默认最多 12k 字符 | 紧凑可访问性树文本 + `@N` + stable locator | 新增 Snapshot v2：层次、预算、差分、frame provenance |
| ref | opaque ref + generation/TTL，页面变化失效 | `@N` 映射 backendNodeId，每轮重建，空 map 可自动重快照 | 保留 opaque ref；补充 snapshotId/revision 和明确失效原因 |
| 定位 | role/name、label、testId、ref | ref、role/text/label/testId、CSS/XPath 等 | 不开放 raw selector；增加经审核的稳定语义 locator 描述 |
| 动作调用 | 一个 MCP 工具一个动作 | 一次 Node 脚本可组合多个动作 | 新增有界 declarative workflow，不开放 JS/CDP |
| 人工接管 | 仅挑战后 `reopenHeaded`，随后 `resume` | 任意 Task Space 可 handoff/takeover，user control 是 hard stop | 把人工接管从“挑战特例”提升为通用控制权协议 |
| 事件 | popup 关闭、dialog dismiss、download cancel，调用方不可见 | 缓冲 CDP 事件，跟踪 pending dialog，支持 wait/drain | 增加安全事件摘要和 wait API，不返回敏感 payload |
| 经验复用 | 无 | 域名绑定的 notes、Node tools、browser tools | 实现只含 notes + declarative recipes 的合规子集 |
| 证据 | 截图立即返回，session 停止时删除 | 截图、screencast、任务空间保留供复核 | 增加有保留期的 evidence manifest，录屏保持显式 opt-in |
| 自描述 | README + 31 个 MCP schema | Skill、`help()`、同一 helper context | 从 schema 生成 Agent 指南与能力清单，减少文档漂移 |

| 分布式 | Redis 队列、租户、worker、fetch/browser 双模 | 重点是本地并行 Space | 保留现有优势，补上 workspace 与 worker 归属/租约 |

## 4. 当前项目已经做对的部分

这些能力不应因为参考 ego-lite 而倒退：

- 服务端精确域名 allowlist、DNS/IP 私网检查、逐跳重定向检查；
- 生产挑战检测后暂停，不尝试求解、刷新、切环境或规避；
- 不公开 arbitrary evaluate、raw CDP/BiDi、启动参数、代理和指纹覆盖；
- 语义定位歧义时拒绝执行，不自动选择第一个；
- ref 绑定页面 generation，页面变化后失效；
- 输入、Cookie、Authorization、URL query 和主机路径不进入普通错误/审计；
- 每会话串行队列、硬超时、队列上限、独立 profile/artifact 清理；
- 集群任务具备租户隔离、排重、租约回收和 Worker 消费范围。

尤其是安全边界：ego-lite 的通用自动化控制面适合用户本机高信任环境，本项目面向受约束 MCP 服务，威胁模型不同，不能用功能丰富度直接比较。

## 5. 最值得补齐的十二个点

### 5.1 Workspace，而不只是 Session

当前调用方拿到 `sessionId` 后必须自行保存；MCP 没有列出、按名称复用、完成后保留现场等工作区语义。建议新增：

- `workspaceId`：稳定、不复用、可审计；
- `name`：人可理解的任务名称，不作为唯一安全标识；
- `owner`：`agent | user | none`；
- `controlState`：`AGENT_CONTROLLED | USER_CONTROLLED | INACTIVE`；
- `retention`：`destroy | keep_until`，由服务端策略限制；
- `browserSessionId`：当前运行实例，可在崩溃恢复后更换。

Workspace 是控制面对象，Firefox Session 是运行时对象。两者分离后，才能自然支持发现、恢复、人工检查、Worker 迁移和证据保留。

### 5.2 通用人工接管与不可绕过的 hard stop

当前人工接管仅在检测到挑战后可用。实际业务还需要在以下场景主动交给人：

- 支付、下单、退款、发布、删除、授权第三方应用；
- 短信/邮件验证码、二维码、硬件密钥；
- Agent 无法可靠判断的页面状态；
- 用户随时从 UI 主动接管。

一旦进入 `USER_CONTROLLED`：

- 所有写动作和导航立即返回稳定的非重试错误；
- Agent 不得自行调用 takeover；
- 只有新的用户授权事件或带租约的操作员确认才能恢复；
- 即使 Agent 脚本捕获并吞掉错误，任务编排层也必须把它识别为 hard stop。

### 5.3 Snapshot v2：先为模型预算设计

当前快照默认返回最多 12,000 字符 body 文本，加扁平 targets，容易重复、缺少结构，也没有明确 token 预算。建议 Snapshot v2 返回：

```json
{
  "snapshotId": "snp_...",
  "pageRevision": 42,
  "url": "https://example.test/path",
  "title": "Orders",
  "content": "@a heading \"Orders\"\n@b textbox \"Search\"\n@c button \"Apply\"",
  "targets": [],
  "changes": { "since": "snp_...", "added": [], "removed": [], "updated": [] },
  "truncated": { "content": false, "targets": false, "reason": null }
}
```

设计要求：

- `content` 是模型主读面，结构化数组用于程序客户端；
- 预算按 UTF-8 byte/token 近似值控制，而不只按 JS 字符数；
- 可选 `viewport | full_page` scope；
- target 带 `framePath`、可见性、可操作性和敏感值已脱敏标记；
- 支持 `sinceSnapshotId` 差分快照，减少动态页面重复传输；
- 明确说明普通 Playwright Firefox 对跨源 iframe/closed shadow root 的可见性限制，不伪装成内核级覆盖。

### 5.4 临时 ref 与稳定定位线索分工

当前 opaque ref 的安全性很好，但每次 DOM 更新后 Agent 只能重新猜语义目标。建议在快照中补充服务端生成、不可执行的 `locatorHint`：

```json
{
  "ref": "ref_...",
  "locatorHint": {
    "role": "button",
    "name": "Save",
    "exact": true,
    "testId": "save-order"
  }
}
```

它只由已允许的语义字段构成，不包含 CSS/XPath。站点 recipe 可以保存 locatorHint，但禁止保存短期 ref。

### 5.5 用 pageRevision 和 actionId 防止重复写

技术设计已描述 `actionId` 去重和页面 revision 检查，错误码也已预留，但当前 MCP schema/执行路径没有完整实现。建议所有写动作支持：

- `actionId`：同 ID + 同参数返回首次结果；同 ID + 不同参数返回 `ACTION_ID_CONFLICT`；
- `expectedPageRevision`：页面已变化则在动作前返回 `PAGE_REVISION_MISMATCH`；
- 只缓存脱敏参数摘要与安全结果，不保存输入正文；
- 缓存有每会话数量上限和 TTL。

这是比增加更多点击方式优先级更高的可靠性能力。

### 5.6 安全的组合执行，而不是 arbitrary JavaScript

ego-lite 的速度优势很大一部分来自一次脚本组合多个动作。本项目不能开放代码执行，但可以提供受限 workflow：

```json
{
  "sessionId": "ses_...",
  "actionId": "...",
  "expectedPageRevision": 12,
  "steps": [
    { "op": "type", "target": { "label": "Search" }, "text": "invoice" },
    { "op": "click", "target": { "role": "button", "name": "Apply" } },
    { "op": "wait", "condition": { "role": "table", "name": "Results" } },
    { "op": "snapshot", "maxBytes": 8000 }
  ],
  "stopOn": ["navigation", "challenge", "dialog", "download", "ambiguity"]
}
```

硬限制建议（当前策略落实为：standard 默认最多 50 步、最多 2 分钟，硬上限最多 100 步、5 分钟）：逐步重新过挑战/URL/状态门禁、遇页面 revision 变化时只允许显式声明可跨 revision 的下一步、结果总字节数有上限。第一版不支持循环、条件表达式、变量插值、脚本和任意 selector。


### 5.7 浏览器事件不能静默消失

当前实现会自动关闭 popup、dismiss dialog、cancel download。这是安全的默认行为，但调用方不知道发生过什么，容易反复点击或等待超时。建议状态与快照中暴露有界、脱敏的 interrupt 摘要：

- `POPUP_BLOCKED`：目标 host/path（去 query）、时间、来源 actionId；
- `DIALOG_BLOCKED`：类型，不返回 message 正文；
- `DOWNLOAD_BLOCKED`：建议文件名经过净化，不返回 URL；
- `NAVIGATION_BLOCKED` / `RESOURCE_BLOCKED`：稳定原因码；
- `PAGE_CRASHED` / `CONTEXT_CLOSED`。

事件队列需要 sequence、最大长度和 drain cursor，不能无限积累。

### 5.8 受控多 Tab，而不是永远关闭 popup

单页是合理 MVP，但很多授权工作流依赖 OAuth、新窗口预览和详情页。建议新增受控 tab 能力：

- `page_list_tabs`、`page_switch_tab`、`page_close_tab`；
- 新 tab 默认进入 `PENDING_APPROVAL` 或自动关闭由策略决定；
- 每个 tab 有 opaque `tabId`、独立 pageRevision/ref registry；
- 跨 tab 不复用 ref；
- tab 数量有硬上限；
- 每个顶层 URL 和子资源仍走相同 URL policy。

### 5.9 域名绑定的经验库（合规子集）

可以借鉴 ego-lite learnings 的目录思想，但只实现数据化 recipe：

```text
recipes/<site-id>/
  manifest.json
  notes/*.md
  workflows/*.json
```

manifest 至少包含：`id`、`version`、`domains`、`description`、`reviewedAt`、`policyVersion`、`workflows`。校验规则：

- domain 必须是精确域名或显式单标签 wildcard；
- workflow 只能使用公开高层操作；
- 禁止临时 ref、Cookie、token、密码、URL query、主机绝对路径；
- 不允许跨域 recipe 自动继承；
- recipe 的启用由管理员配置，Agent 只能查询和调用；
- 每次执行记录 recipe 版本和结果，失败不会自动覆写经验。

### 5.10 证据包，而不只是一次截图

建议为每个 workspace 生成受控 evidence manifest：

- 访问过的去 query URL；
- actionId、动作类型、结果码、pageRevision；
- 挑战/人工接管/策略阻断时间线；
- 经批准的截图或录屏 artifactRef；
- recipe 与 policy 版本。

截图/录屏必须服务端启用、短保留期、租户隔离、大小上限，并提供敏感页面禁录策略。不要默认把二进制内容写进审计 JSONL。

### 5.11 自描述能力与文档一致性

ego-browser 从同一 helper surface 生成 `help()`；本项目目前同时维护 Zod schema、手写 JSON Schema、README 表格和设计文档，容易漂移。建议：

- 以 Zod/单一元数据表生成 JSON Schema、README 工具表和 Agent 提示；
- CI 比较生成物，发现漂移即失败；
- 每个工具公开风险注解、状态前置条件、可能 hard stop、是否会改变页面 revision；
- 运行时提供 `browser_capabilities`，返回版本、限制和服务器启用的可选能力，不暴露路径或秘密配置。

### 5.12 资源预算和生命周期

并行 workspace 会把内存、进程、页面和工件问题放大。每个 workspace 应有：

- 最大运行时长、空闲 TTL、队列长度、动作数；
- 最大 tab、截图、响应字节、网络请求和重定向数；
- Worker/tenant 并发配额；
- 心跳与 owner lease；
- 崩溃后状态收敛和 evidence 清理策略。

ego-lite 自身的公开 issue 也在讨论并发 Task Space 的资源预算，这说明“支持并行”不等于“生命周期治理已解决”。

## 6. 明确不采用的能力

| ego-lite 能力或做法 | 本项目决定 | 原因 |
|---|---|---|
| 任意 Node/页面 JavaScript | 不采用 | 绕过高层工具审计、URL/状态门禁和数据边界 |
| raw CDP | 不采用 | 权限过大，可读取 Cookie、修改网络与浏览器状态 |
| raw CSS/XPath | 不用于写操作 | 易误点、逃逸语义约束，难做稳定风险判断 |
| 任意 `serverFetch`/`browserFetch` | 不采用 | 破坏只读方法、header/body 和 URL policy 边界 |
| 任意上传/下载主机路径 | 不采用 | 可能造成数据外传、路径读取与恶意文件落地 |
| 自动继承真实 Chrome 登录、Cookie、扩展 | 不采用为默认能力 | 与最小授权、租户隔离和凭据不出域冲突 |
| “减少 CAPTCHA/风控触发”作为成功指标 | 不采用 | 本项目遇生产挑战的标准行为是暂停 |
| 直接复刻定制 Chromium 内核 | 暂不采用 | 与 Firefox 优先定位、维护成本和供应链风险不匹配 |

## 7. 分阶段路线图

### P0：可靠观察与控制（已交付）

1. 持续维护文档与实现状态同步，明确标注持久档案、actionId、revision、接管租约等能力的实际状态。
2. Snapshot v2：`snapshotId`、紧凑 content、预算、差分、frame provenance。
3. 写动作增加 `actionId` 与 `expectedPageRevision`。
4. 通用 handoff/takeover hard-stop 状态，不再只服务于挑战。
5. 暴露 popup/dialog/download/crash 的安全 interrupt 摘要。

验收重点：不会重复写、不会在用户控制时重试、事件不再表现为无信息超时、快照平均输出显著下降。

### P1：效率与可复用性

1. 按管理员策略限制的 declarative workflow。
2. 受控多 tab 与 tab 级 revision/ref。
3. 域名绑定 recipes（notes + JSON workflows）。
4. evidence manifest 与短期 artifact 保留。
5. schema/文档/Agent 指南自动生成。

### P2：规模与运行形态

1. Workspace 控制面持久化、owner lease、Worker 迁移。
2. 评估 Firefox 多 context/共享进程适配器；必须先做租户泄漏测试。
3. 远程人工接管网关、操作员 RBAC 和短期授权 token。
4. 真实 Redis Cluster 故障转移与浏览器容量压测。
5. 可选录屏与可观测性仪表盘。

## 8. 推荐的第一批实现切片

第一批不要同时做所有功能。建议按以下切片交付：

### Slice A：Observation Contract v2

- additive 新增 `format: "compact" | "structured"`；
- 返回 `snapshotId`、`pageRevision`、`content`、`truncated`；
- 保留现有 targets 兼容客户端；
- 增加 snapshot byte 上限；`sinceSnapshotId` 差分已实现，并只在会话内存中保留有界脱敏语义节点。

### Slice B：Write Safety

- click/type/select/open 增加 `actionId`、`expectedPageRevision`；
- 实现同参幂等、异参冲突、revision 前置拒绝；
- 输入正文只参与内存中的 HMAC/摘要，不落日志和错误。

### Slice C：Interrupt Visibility

- 记录 popup/dialog/download/crash 的计数和最近事件；
- `browser_status` 返回脱敏摘要；
- 新增 cursor/drain 前先不开放对事件的执行权限。

三个切片都不改变现有反挑战、网络和选择器边界，却能直接提升 Agent 成功率、可诊断性和 token 效率。

## 9. 需要先修正的文档/实现不一致

1. PRD 写有“保留持久档案”，但当前 profile 目录带 sessionId，stop/launch failure 都会删除；当前实际是临时 profile。
2. 技术设计已经描述 `actionId` 去重，但公开 MCP schema 没有 `actionId`，执行层也没有结果缓存。
3. 错误码包含 `PAGE_REVISION_MISMATCH`、`ACTION_ID_CONFLICT`、`HUMAN_HANDOFF_EXPIRED` 等，但多数尚无对应可达路径。
4. human control/租约模型已进入公开工具；远程虚拟显示和独立操作员身份认证仍属于部署侧后续能力。
5. `profile` 参数目前只是服务端目录名前缀，不代表可复用登录态或持久档案，名称应改成 `profileLabel` 或从公开 schema 移除，避免误导。

## 10. 验证建议

新增能力至少需要以下测试：

- 快照：大 DOM、动态 rerender、iframe、shadow root、重复名称、敏感输入、UTF-8 字节上限；
- revision：快照后导航/重渲染，旧 expected revision 必须在写前失败；
- actionId：并发同参只执行一次、异参冲突、TTL/容量淘汰、敏感参数不落盘；
- handoff：用户接管期间所有写动作 hard stop，Agent 无法自行 takeover；
- events：popup/dialog/download 被阻断但状态可见，队列有界且游标稳定；
- workflow：逐步策略门禁、挑战中止、结果上限、无循环/脚本/selector 逃生口；
- recipes：跨域拒绝、路径穿越拒绝、临时 ref/秘密扫描、版本固定；
- 资源：并发达到上限时确定性拒绝，崩溃后 profile/process/artifact 可回收。

## 11. 最终判断

ego-lite 证明了 Agent 浏览器的竞争力不只来自“能点网页”，而来自四个系统性能力：

> **独立工作区 + 高密度观察 + 少往返执行 + 可积累经验。**

本项目已经拥有更强的网络策略、挑战处理、租户隔离和审计基础。下一阶段应把这些安全基础与上述四点结合起来，形成差异化定位：

> **安全边界内、可人工协作、低 token、可积累经验的 Firefox Agent Workspace。**

这比在当前基线中扩展 raw selector、指纹、代理或挑战通过率更符合当前交付边界，也更容易形成长期可维护的产品基础。
