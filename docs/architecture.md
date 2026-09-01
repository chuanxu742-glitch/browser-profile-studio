# 浏览器身份隔离与自动化 MCP：当前基线架构

> 当前实现：本地 Profile 隔离 Studio + 合规、策略约束、可审计的 Firefox 自动化 MCP。Studio 的持久代理池与声明式 RPA 均复用 SessionManager 策略门；本文不对挑战绕过、账号安全或第三方检测分数作任何承诺。

> 文档定位：这是架构师视角的目标态评审稿，包含 TTL、多租户、虚拟显示和工件存储等后续阶段设计，不表示当前 MVP 已全部实现。当前交付的公开契约以 `README.md`、`docs/prd.md` 和 `docs/implementation-report.md` 为准。

> 当前实现没有向 MCP 公开 evaluate、用于写操作的 raw selector、CDP/BiDi、代理、指纹覆盖或扩展启动配置；只读批量抽取保留受限 selector schema。本文中的后续目标态内容不代表当前已交付能力。实现状态以 `README.md`、`docs/prd.md` 和 `docs/implementation-report.md` 为准。

> 文档状态：Draft v0.1  
> 面向读者：产品、平台架构、安全、后端、测试、运维  
> 适用范围：当前基线在自有或已获明确授权的网站上，通过版本锁定的 Playwright Firefox（Gecko）兼容构建完成可审计的 Agent 交互  
> 仓库基线：本稿由架构设计阶段产出；实现结果另见交付报告

## 1. 架构结论

本系统采用“薄 MCP 接口层 + 强制策略网关 + 隔离 Firefox Worker + 人工挑战接管”的分层架构。

关键决策如下：

1. 当前使用 Playwright 官方分发、版本固定的 Firefox 兼容构建（该构建依赖 Playwright 补丁，不等同于任意安装的品牌 Firefox）；如后续确有企业 Firefox 兼容需求，可新增 WebDriver BiDi/Marionette 适配器，但不能引入定制隐身内核。
2. Agent 只能调用有限、语义化的高层工具，例如导航、快照、点击、输入、滚动和等待；不开放任意 JavaScript、浏览器内部协议透传、扩展安装、配置指纹覆盖、网络请求伪造或原始文件系统访问。
3. “缓动鼠标”和“有界随机节奏”只用于减少误点、等待布局稳定及更接近真实 UI 操作时序，不承诺也不用于规避机器人检测。轨迹与延迟均有上下限、可复现、可审计和可关闭。
4. 一旦识别到 CAPTCHA、Cloudflare Challenge 或其他站点挑战，自动化立即停止，进入 HUMAN_REQUIRED 状态。系统不尝试求解、点击挑战控件、转发挑战给第三方打码服务或修改浏览器特征；只能由受信任操作员显式接管或终止。
5. 所有顶层导航、重定向和浏览器网络请求均受域名 allowlist、协议限制、DNS/IP 检查、速率限制和会话配额约束。
6. 每个会话运行在独立进程与临时配置目录中；默认无持久化，关闭时回收临时数据。日志采用结构化事件并对输入值、Cookie、授权头、页面内容和截图做分级脱敏。
7. 默认通过本地 stdio 暴露 MCP。远程模式必须使用加密传输、服务身份认证、细粒度能力授权和租户隔离，不能直接将浏览器 Worker 暴露给 Agent 或公网。

## 2. 范围与边界

### 2.1 目标

- 为 Agent 提供小而稳定的 Firefox UI 自动化工具集。
- 仅对自有、测试或已获明确授权的域名执行交互。
- 使用可解释、可重放的交互节奏提高 UI 稳定性。
- 在挑战页、登录高风险步骤和敏感操作前支持人工接管。
- 对“谁在何时通过哪个 Agent 对哪个站点执行了什么动作”形成审计链。
- 在多租户或多任务场景下隔离会话、凭据、缓存、下载和日志。
- 使策略、安全和自动化实现彼此解耦，便于独立测试与升级。

### 2.2 明确不做

以下能力不在产品和技术范围内，且应在代码、配置和评审门禁中明确禁止：

- 自动绕过 Cloudflare、CAPTCHA、Turnstile 或任何机器人/访问控制挑战。
- 接入打码平台、挑战 token 交易服务或自动挑战求解模型。
- 将确定性页面环境配置宣传为通过第三方检测或规避平台风控的保证。
- 定制浏览器内核、挑战求解或根据检测信号动态改变自动化特征。
- 提供住宅代理来源、身份农场、批量注册、批量养号或规避站点频率限制。
- 绕过 robots、服务条款、登录授权、付费墙、地域限制或访问控制。
- 暴露任意 JavaScript/evaluate、原始 CDP/Marionette 命令、任意 HTTP 请求、shell 或文件系统工具。
- 在不可见、被遮挡、禁用或不在视口内的元素上直接派发 DOM 事件。
- 在 Agent 未获授权时执行购买、转账、发布、删除账号等不可逆动作。

### 2.3 合法使用前提

业务接入方必须为每个域名维护授权依据、数据分类、允许动作和责任人。allowlist 是技术保护，不替代站点授权、隐私评估或法律审查。生产部署前应由组织内部的安全和法务流程确认用途。

## 3. 质量属性与设计原则

优先级从高到低为：

1. 安全与合规：策略不可由 Agent 绕过，挑战状态下 fail closed。
2. 可审计：动作、决策、策略版本和人工接管均可关联到同一 trace。
3. 隔离：会话之间、租户之间、控制面与浏览器数据面之间相互隔离。
4. 确定性：相同输入、固定随机种子和相同页面状态应产生可重放的动作计划。
5. 稳定性：交互前检查可见性、遮挡、布局稳定和导航状态。
6. 可替换性：自动化引擎通过 Adapter 接口隔离，不污染 MCP 契约。
7. 最小能力：只提供完成已批准用例所需的最少工具和字段。

## 4. 逻辑架构

~~~mermaid
flowchart LR
    A[Agent / MCP Client\n不受信任输入] -->|MCP stdio 或 HTTPS| G

    subgraph CP[控制面：受信任服务边界]
      G[MCP Gateway\n鉴权、Schema、幂等]
      P[Policy Engine\nallowlist、动作权限、限流]
      S[Session Manager\n状态机、租约、配额]
      O[Action Orchestrator\n解析 ref、稳定性检查]
      R[Interaction Rhythm Engine\n缓动轨迹、有界延迟]
      C[Challenge Guard\n识别并冻结自动化]
      AU[Audit / Metrics\n脱敏事件、告警]
      H[Operator Handoff Broker\n一次性接管租约]
      G --> P --> S --> O
      O --> R
      O --> C
      G --> AU
      P --> AU
      S --> AU
      O --> AU
      C --> H
      C --> AU
    end

    subgraph DP[浏览器数据面：每会话隔离]
      W[Firefox Worker Supervisor]
      AD[Playwright Firefox Adapter\n仅高层 API]
      F[Stock Firefox\n临时 Profile / Headless 默认]
      W --> AD --> F
    end

    O -->|受限 RPC / Action Plan| W
    W -->|事件、快照、挑战信号| O
    H -->|本地受控画面与输入租约| OP[受信任操作员]
    F -->|HTTPS，经出口策略| WEB[获授权站点与显式资源域名]
    AU --> STORE[(审计与指标存储\n与页面数据分级隔离)]
~~~

### 4.1 组件职责

| 组件 | 核心职责 | 不应承担的职责 |
| --- | --- | --- |
| MCP Gateway | MCP 工具注册、输入 Schema 校验、调用身份、trace、幂等键、统一响应 | 页面操作细节、策略例外 |
| Policy Engine | 域名/动作/会话策略、速率限制、敏感动作审批、网络目的地判定 | 自动“猜测”授权 |
| Session Manager | 会话创建、状态转换、租约、超时、回收、Worker 绑定 | 直接驱动页面 |
| Action Orchestrator | 将语义化工具转换为原子 Action Plan，校验页面版本和元素 ref | 任意脚本拼装 |
| Interaction Rhythm Engine | 生成有界缓动轨迹、按键节奏、动作前后等待；输出可审计参数 | 规避检测、改变浏览器指纹 |
| Challenge Guard | 汇总 HTTP 状态、标题、可访问性树和已配置规则，冻结疑似挑战会话 | 点击或求解挑战 |
| Worker Supervisor | 启停隔离 Worker、健康检查、崩溃回收、资源限额 | 接收 Agent 的未校验输入 |
| Browser Adapter | 封装 Playwright 的导航、locator、mouse、keyboard、screenshot 等高层能力 | evaluate、协议透传、隐身补丁 |
| Handoff Broker | 创建短时、单人、一次性的人工接管租约并记录操作员身份 | 将挑战页发送给外部求解服务 |
| Audit / Metrics | 脱敏审计、指标、告警、策略决策证据 | 默认保存页面正文、凭据或完整截图 |

### 4.2 推荐技术边界

- MCP 服务：TypeScript，使用官方 MCP SDK；通过类型生成保证 JSON Schema 与运行时校验一致。
- 浏览器驱动：Playwright 的 Firefox 通道，绑定项目锁文件固定版本；Firefox 二进制来源固定并校验哈希/签名。
- Worker 隔离：每会话独立子进程；生产环境进一步放入最小权限容器或系统沙箱。
- 内部通信：本机 Unix domain socket/Windows named pipe，或双向认证的短连接 RPC；不监听公网。
- 状态：活跃会话以内存为主，租约/幂等记录可放轻量事务存储；敏感浏览数据不进入通用状态库。
- 可观测：结构化日志、指标和 trace 分离；审计日志使用追加写和完整性保护。

该技术选择不承诺具体版本号。实现时应通过依赖锁文件、SBOM、漏洞扫描和受控升级流程确定版本。

## 5. 信任边界与威胁模型

### 5.1 信任边界

| 边界 | 两侧 | 主要风险 | 控制 |
| --- | --- | --- | --- |
| TB-1 | Agent ↔ MCP Gateway | 提示注入导致越权调用、恶意 URL、参数膨胀、重放 | 强 Schema、调用身份、能力范围、幂等、大小限制、限流 |
| TB-2 | 控制面 ↔ Firefox Worker | 命令注入、Worker 逃逸、跨会话访问 | 固定 RPC 协议、无任意脚本、独立进程、OS 最小权限、会话令牌 |
| TB-3 | Firefox ↔ Internet | SSRF、恶意下载、DNS rebinding、重定向逃逸、恶意页面 | 出口代理/防火墙、每次请求目的地检查、下载禁用、私网阻断 |
| TB-4 | Handoff Broker ↔ 操作员 | 接管链接泄露、双重控制、操作不可追责 | SSO/MFA、一次性短租约、单写者锁、全程审计、显式归还 |
| TB-5 | 系统 ↔ 日志/制品存储 | Cookie、PII、页面正文或截图泄露 | 默认最少记录、字段脱敏、独立密钥、RBAC、TTL、访问审计 |
| TB-6 | 租户/会话 ↔ 租户/会话 | Profile、缓存、Cookie、下载或 ref 混用 | 独立 Worker/Profile、租户命名空间、不可猜 ID、销毁校验 |

### 5.2 重点威胁及处置

1. 页面提示注入诱导 Agent 请求未授权域名：Policy Engine 独立于模型判断，所有导航、重定向、弹窗和请求都重新做 allowlist 判定。
2. URL 指向 localhost、云元数据或内网：禁止 file、data、javascript 等非批准 scheme，禁止 IP literal，解析后阻断 loopback、link-local、private、reserved 网段；连接时再次校验解析结果以降低 DNS rebinding 风险。
3. 页面通过新窗口逃离策略：新 page、popup 和下载默认阻断；如业务批准 popup，则继承同一策略与会话。
4. Agent 利用选择器访问隐藏或敏感控件：Agent 只能使用服务生成的短期 opaque ref；点击前重新检查同一页面版本、可见性、可操作性、遮挡和目标语义。
5. 挑战页被误判为普通页面：挑战规则宁可误停；状态进入 HUMAN_REQUIRED 后，所有页面变更工具统一拒绝，只允许查询状态或关闭。
6. 人工与 Agent 同时输入：会话采用单写者租约；HUMAN_CONTROLLED 时自动化输入通道物理冻结。
7. 凭据进入日志：输入接口支持 secretRef；明文 text 字段设置大小限制和敏感字段检测。键值、Cookie、授权头、密码输入框内容不记录。
8. Worker 崩溃后 Profile 残留：Supervisor 在启动时登记目录，正常关闭和异常恢复都执行限定路径的安全回收；回收结果进入审计。

## 6. 会话状态机

~~~mermaid
stateDiagram-v2
    [*] --> CREATING
    CREATING --> READY: Worker 启动且策略装载成功
    CREATING --> FAILED: 启动/策略失败

    READY --> NAVIGATING: navigate
    NAVIGATING --> READY: 页面稳定且未发现挑战
    NAVIGATING --> HUMAN_REQUIRED: 疑似挑战
    NAVIGATING --> FAILED: 不可恢复错误

    READY --> ACTION_RUNNING: click/type/scroll/wait
    ACTION_RUNNING --> READY: 动作完成
    ACTION_RUNNING --> HUMAN_REQUIRED: 动作中发现挑战
    ACTION_RUNNING --> READY: 可恢复动作错误
    ACTION_RUNNING --> FAILED: Worker/策略不可恢复错误

    HUMAN_REQUIRED --> HUMAN_CONTROLLED: 操作员取得租约
    HUMAN_REQUIRED --> READY: 安全人员判定为误报并显式恢复
    HUMAN_REQUIRED --> CLOSING: 放弃/超时
    HUMAN_CONTROLLED --> HUMAN_REQUIRED: 操作员归还但挑战未解除
    HUMAN_CONTROLLED --> READY: 操作员归还且重新校验通过
    HUMAN_CONTROLLED --> CLOSING: 放弃/超时

    READY --> CLOSING: close/TTL
    FAILED --> CLOSING: 回收
    CLOSING --> CLOSED: Worker 与 Profile 已回收
    CLOSED --> [*]
~~~

### 6.1 状态不变量

- 只有 READY 状态可接受新的页面变更动作。
- 任一时刻最多有一个写入者：Agent 自动化或操作员。
- HUMAN_REQUIRED 和 HUMAN_CONTROLLED 状态下，MCP 的 click、type、scroll、navigate 工具均返回 SESSION_STATE_CONFLICT 或 CHALLENGE_REQUIRES_HUMAN。
- CLOSED 会话不可恢复；需要创建新会话。
- 所有状态转换都携带 actor、reason、policyVersion、pageRevision、traceId 和时间戳。
- 发生策略引擎不可用、审计写入不可用或域名判定不明确时 fail closed。

## 7. 动作执行流水线

每个页面变更调用按以下固定顺序执行：

1. Gateway 校验调用身份、JSON Schema、请求大小、deadline 和 idempotencyKey。
2. Policy Engine 校验租户、域名、工具能力、会话状态、动作配额和敏感动作审批。
3. Session Manager 获取该会话的短时排他写锁。
4. Orchestrator 校验 pageRevision；解析 opaque targetRef，并确认目标属于当前页面。
5. Adapter 检查目标 attached、visible、enabled、未被遮挡且在安全视口内；必要时用标准滚动 API 将其滚入视口。
6. Challenge Guard 在动作前检查页面；命中则冻结会话，不执行动作。
7. Rhythm Engine 生成受配置约束的 Action Plan：
   - 鼠标轨迹使用 2–4 个控制点的缓动曲线，持续时间有固定上下限。
   - 不产生越出视口、经过敏感控件或无意义大范围游走的轨迹。
   - 点击使用真实 mouse move/down/up 高层 API，不使用 DOM dispatchEvent。
   - 输入先聚焦可见控件，再使用 keyboard 高层 API逐键输入；粘贴默认关闭。
   - 动作前后等待和逐键延迟均为有界值，可通过 actionSeed 重放。
8. Adapter 执行动作，并采集最少的结果信号。
9. Challenge Guard 在动作后再次检查。若命中，则状态转为 HUMAN_REQUIRED。
10. 记录脱敏审计事件，释放写锁并返回结果。

随机节奏不是安全边界，也不应根据站点检测结果动态调参。所有分布均由服务端配置，Agent 不能请求任意延迟、轨迹密度或“更像真人”等模式。

## 8. MCP 接口契约

### 8.1 传输与通用约定

- 默认传输：本地 stdio。
- 远程传输：HTTPS + 服务身份认证；组织策略可要求 mTLS。必须限制来源网络和租户。
- MCP Server 名称建议：compliant-firefox。
- 所有 ID 均为不可猜的 opaque identifier，不包含租户、路径或 URL。
- 所有写操作支持 idempotencyKey；同一主体在幂等窗口内以相同键和不同参数调用时拒绝。
- deadlineMs 由 Agent 提供建议值，但服务端会裁剪到配置范围。
- URL 仅允许绝对 HTTPS URL；是否允许 HTTP 仅能由服务端针对本地测试域名显式配置。
- 成功结果统一包含 traceId、sessionId、state、pageRevision 和 data。

成功响应示例：

~~~json
{
  "ok": true,
  "traceId": "tr_opaque",
  "sessionId": "ses_opaque",
  "state": "READY",
  "pageRevision": 7,
  "data": {}
}
~~~

### 8.2 browser_session_create

用途：创建隔离的临时 Firefox 会话。

输入：

~~~json
{
  "purpose": "测试已授权的结账页面",
  "authorizationRef": "authz_opaque",
  "requestedDomainSet": "owned-test-sites",
  "viewportProfile": "desktop-standard",
  "idempotencyKey": "idem_opaque"
}
~~~

约束：

- Agent 不可传 userAgent、Canvas/WebGL、字体、语言伪装、扩展、Firefox prefs、代理或持久化 Profile。
- viewportProfile 必须引用管理员预置配置。
- authorizationRef 必须能关联到有效的业务授权记录。

输出 data：createdAt、expiresAt、effectivePolicyId、capabilities。

### 8.3 browser_navigate

用途：导航到已批准 URL。

输入字段：

- sessionId：必填。
- url：绝对 URL。
- waitUntil：仅允许 domcontentloaded 或 load，默认 domcontentloaded。
- expectedPageRevision：可选，用于乐观并发控制。
- idempotencyKey：必填。

服务端在初始 URL、每次重定向、popup 和最终 URL 上都重新执行策略校验。输出只返回脱敏后的 finalUrl、title、navigationTimingSummary 和新 pageRevision。

### 8.4 browser_snapshot

用途：获取 Agent 可理解的、最少必要的页面视图。

输入字段：

- sessionId：必填。
- mode：accessibility、screenshot 或 combined。
- includeRoles：可选的角色 allowlist。
- maxNodes：由服务端裁剪。
- redactProfile：管理员预置的脱敏策略。

accessibility 模式返回经过裁剪的语义树和短期 targetRef。targetRef 与 sessionId、pageRevision、frameId 和节点身份绑定，页面修订后失效。截图返回短时制品引用，不直接内嵌无限大小的图像。

默认排除密码值、Cookie、localStorage、隐藏节点、不可见文本、跨域 frame 正文和被标记为敏感的数据区域。

### 8.5 browser_click

用途：点击当前快照中的可操作元素。

输入：

~~~json
{
  "sessionId": "ses_opaque",
  "targetRef": "ref_opaque",
  "expectedPageRevision": 7,
  "button": "left",
  "idempotencyKey": "idem_opaque"
}
~~~

约束：

- 仅允许 left，除非管理员为特定用例批准其他按钮。
- 不接受 CSS/XPath、屏幕绝对坐标或脚本表达式。
- 目标必须可见、启用、未遮挡，并通过敏感动作策略。
- 对购买、发布、删除、转账、授权等动作可返回 APPROVAL_REQUIRED。

输出 data：actionSummary、targetRole、targetNameRedacted、timingSummary、navigationOccurred。

### 8.6 browser_type

用途：向当前快照中的可编辑控件输入文本。

输入字段：

- sessionId、targetRef、expectedPageRevision、idempotencyKey：必填。
- text 或 secretRef：二选一。
- replaceExisting：布尔值，默认 false。
- submit：默认 false；若为 true，需要独立策略授权。

约束：

- secretRef 由服务端受控凭据提供方解析，Agent 不获得明文。
- 密码和敏感字段的内容、长度细节及逐键事件不进入普通审计日志。
- 禁止通过输入框粘贴脚本并诱导系统执行站点控制台操作。

### 8.7 browser_scroll

用途：在当前页面或已批准的可滚动容器内滚动。

输入字段：sessionId、targetRef（可选）、direction（up/down）、amount（small/medium/page）、expectedPageRevision、idempotencyKey。

不接受任意大像素值。系统将语义档位映射为受限距离，并在每段滚动后等待布局稳定。

### 8.8 browser_wait

用途：等待页面达到受限条件，避免 Agent 通过高频轮询消耗资源。

允许条件：

- duration：由服务端裁剪到短时范围。
- pageStable：网络和布局在配置窗口内稳定。
- targetVisible：指定 targetRef 可见。
- navigationComplete：当前导航完成。

不接受 JavaScript predicate、正则扫描整页敏感内容或无限等待。

### 8.9 browser_handoff_status

用途：只读查询挑战/人工接管状态。

输出 data：challengeCategory、detectedAt、operatorLeaseState、handoffExpiresAt、allowedNextActions。不得返回挑战 token、可转售材料或自动求解建议。

### 8.10 browser_handoff_resume

用途：操作员完成接管后，由受信任控制面恢复自动化。该工具默认不授予普通 Agent。

前置条件：

- 已验证的操作员身份和一次性租约。
- 操作员显式归还控制权。
- Challenge Guard 重新检查未再命中。
- 当前 URL 仍在 allowlist 内。
- 新 pageRevision 已生成，旧 targetRef 全部作废。

### 8.11 browser_session_close

用途：关闭 Worker 并安全回收临时 Profile。

输入字段：sessionId、reason、idempotencyKey。输出 data：closedAt、cleanupStatus、auditCompleteness。若清理异步完成，状态先为 CLOSING，客户端可只读查询。

### 8.12 可选只读接口

- browser_session_get：返回状态、TTL、当前域名和策略 ID，不返回 Cookie/存储。
- browser_session_list：仅管理员或同一调用主体可用，强制分页。
- browser_artifact_get：获取有权限且未过期的脱敏截图/trace 制品。

## 9. 错误模型

错误统一为结构化结果；不得将浏览器堆栈、文件路径、内部 host、Cookie 或页面正文直接返回 Agent。

~~~json
{
  "ok": false,
  "traceId": "tr_opaque",
  "error": {
    "code": "DOMAIN_NOT_ALLOWED",
    "message": "Navigation target is outside the approved domain set.",
    "retryable": false,
    "category": "POLICY",
    "details": {
      "policyId": "pol_opaque"
    }
  }
}
~~~

| code | category | retryable | 语义与客户端处理 |
| --- | --- | --- | --- |
| INVALID_ARGUMENT | INPUT | false | Schema 或字段组合错误；修正请求 |
| UNAUTHENTICATED | AUTH | false | 缺少或无效身份 |
| PERMISSION_DENIED | AUTH | false | 调用主体无工具/会话权限 |
| POLICY_DENIED | POLICY | false | 动作不在批准用途或能力范围 |
| DOMAIN_NOT_ALLOWED | POLICY | false | URL、重定向或资源域名不在 allowlist |
| NETWORK_BLOCKED | POLICY | false | scheme、IP、DNS 或出口策略阻断 |
| DOWNLOAD_BLOCKED | POLICY | false | 页面触发未批准下载 |
| RATE_LIMITED | QUOTA | true | 达到主体/域名/会话配额；遵守 retryAfterMs |
| APPROVAL_REQUIRED | POLICY | false | 敏感动作需人工审批，不应自动重试 |
| SESSION_NOT_FOUND | SESSION | false | 会话不存在或调用主体不可见 |
| SESSION_EXPIRED | SESSION | false | TTL 到期；创建新会话 |
| SESSION_STATE_CONFLICT | SESSION | true | 状态不允许该动作；查询状态后决定 |
| PAGE_REVISION_MISMATCH | SESSION | true | 页面已变化；重新获取快照 |
| TARGET_NOT_FOUND | ACTION | true | ref 失效或节点已移除；重新快照 |
| TARGET_NOT_ACTIONABLE | ACTION | true | 不可见、禁用、不稳定或被遮挡 |
| NAVIGATION_TIMEOUT | BROWSER | true | 导航超时；在策略允许时有限重试 |
| ACTION_TIMEOUT | BROWSER | true | 动作超时；先重新快照，禁止盲目连点 |
| CHALLENGE_REQUIRES_HUMAN | SAFETY | false | 会话已冻结；人工接管或关闭 |
| HUMAN_HANDOFF_EXPIRED | SAFETY | false | 接管租约过期；重新走授权流程 |
| BROWSER_CRASHED | BROWSER | conditional | Worker 崩溃；仅幂等只读动作可自动重试 |
| AUDIT_UNAVAILABLE | SAFETY | false | 审计不可用时 fail closed |
| INTERNAL | INTERNAL | conditional | 未分类故障；携 traceId 排查 |

自动重试由 Orchestrator 统一控制，且只对明确幂等操作执行。click、type 和可能提交表单的导航不能在结果不确定时自动重放。

## 10. 配置模型

配置由管理员管理、签名或受版本控制保护。Agent 只能引用预定义 policy/profile，不能覆盖安全字段。

~~~yaml
server:
  transport: stdio
  max_request_bytes: 262144
  default_deadline_ms: 15000
  max_deadline_ms: 45000

browser:
  engine: firefox
  adapter: playwright
  headless: true
  binary_source: managed
  persistent_profile: false
  extensions_allowed: false
  downloads_allowed: false
  clipboard_allowed: false
  arbitrary_javascript_allowed: false
  raw_protocol_allowed: false
  session_ttl_seconds: 1800
  max_pages_per_session: 1

network:
  allowed_schemes: [https]
  block_ip_literals: true
  block_private_ranges: true
  revalidate_dns_on_connect: true
  validate_every_redirect: true
  top_level_domain_sets:
    owned-test-sites:
      exact_hosts: [test.example.internal]
      include_subdomains: false
  resource_host_sets:
    owned-test-sites:
      exact_hosts: [test.example.internal, static.example.internal]
  max_redirects: 8

interaction:
  mode: stability_pacing
  mouse_duration_ms: { min: 180, max: 850 }
  mouse_control_points: { min: 2, max: 4 }
  key_delay_ms: { min: 35, max: 140 }
  action_pre_delay_ms: { min: 80, max: 350 }
  action_post_delay_ms: { min: 120, max: 600 }
  layout_stable_ms: 250
  deterministic_seed_scope: action
  agent_can_override_bounds: false

challenge_guard:
  enabled: true
  action_on_suspected_challenge: freeze
  automated_solver_allowed: false
  external_solver_allowed: false
  handoff_ttl_seconds: 300
  require_operator_sso: true
  require_operator_mfa: true

limits:
  max_sessions_per_subject: 2
  max_actions_per_minute_per_session: 30
  max_navigations_per_minute_per_domain: 6
  max_snapshot_nodes: 1500
  max_screenshot_bytes: 5000000

audit:
  required: true
  fail_closed: true
  store_page_text: false
  store_input_values: false
  store_cookies: false
  screenshot_policy: explicit_or_incident
  artifact_ttl_hours: 24
  event_ttl_days: 90
  integrity_protection: true
~~~

### 10.1 配置校验规则

- exact_hosts 使用规范化 ASCII hostname；禁止通配符前缀和模糊字符串匹配。
- include_subdomains 必须显式声明；启用时按 DNS label 边界匹配，不能用 endsWith。
- resource_host_sets 与顶层导航域名分开，避免 CDN 放行反向扩大导航范围。
- min 不得大于 max，所有延迟与配额都有编译期和启动期硬上限。
- automated_solver_allowed 和 external_solver_allowed 必须由 Schema 固定为 false，不能靠运行时约定。
- 生产环境 browser.binary_source 只能为 managed。
- 审计 fail_closed、网络私网阻断和逐重定向校验在生产策略中不可关闭。

## 11. 安全与合规控制

### 11.1 身份与授权

- 每次 MCP 调用绑定主体、租户、Agent 实例和授权目的。
- 工具采用 capability allowlist；普通 Agent 不具有 handoff_resume、策略管理或制品导出能力。
- 会话所有权在服务端校验，不能仅依赖不可猜 sessionId。
- 敏感动作使用 step-up approval，并绑定页面修订、目标语义和动作摘要；页面变化后审批失效。

### 11.2 浏览器与主机

- 使用版本锁定的 Playwright Firefox 兼容构建，不加载未知扩展，不接受用户自带二进制。
- Worker 使用非管理员账户、只读程序目录、独立临时 Profile 和资源配额。
- 禁止 file URL、本地文件上传、打印、剪贴板和下载，除非具体用例经单独威胁建模批准。
- 限制单会话 page 数、CPU、内存、运行时间、响应体和截图大小。
- 依赖通过锁文件、SBOM、签名/哈希校验、漏洞扫描和滚动升级治理。

### 11.3 网络

- 浏览器出口必须通过策略执行点，不能仅在 navigate 工具中检查 URL。
- 顶层文档、frame、XHR/fetch、WebSocket、EventSource、字体和媒体请求均应用资源域名策略。
- 禁止访问本机、内网、云元数据、保留地址和非批准端口。
- 每跳重定向、DNS 解析结果和最终连接目标都需校验。
- TLS 校验不可由 Agent 关闭；本地测试证书只能通过管理员管理的信任库处理。

### 11.4 数据与审计

最小审计事件字段：

- eventId、traceId、timestamp、tenantId、subjectId、agentId。
- sessionId、toolName、actionType、stateBefore、stateAfter。
- policyId、policyVersion、decision、reasonCode。
- 规范化且按策略脱敏的 origin，不默认记录完整 query。
- pageRevision、targetRole、脱敏 targetName、动作耗时区间。
- challengeCategory、operatorId、handoffLeaseId 和人工接管结果（如适用）。
- errorCode、retryable、Worker health。

秘密、Cookie、Authorization、页面表单值、密码长度、完整页面正文不进入普通日志。需要事件取证截图时，应单独授权、加密、设置短 TTL 并记录每次读取。

### 11.5 挑战处置

- Challenge Guard 采用可解释规则并记录命中原因，但不将规则反馈给 Agent 用于对抗调整。
- 发现挑战后先冻结输入，再生成审计与通知；任何异常都保持冻结。
- 人工接管只在组织内受控界面完成，接管画面不向外部打码服务传播。
- 操作员只能控制已冻结的单个会话，租约到期自动撤销。
- 操作员归还后重新校验 URL、挑战状态、页面修订和策略；旧 ref 作废。

## 12. 可观测性与运行指标

建议指标：

- 会话创建成功率、Worker 启动/崩溃率、清理成功率。
- 每工具延迟分位、导航超时率、目标失效率、pageRevision 冲突率。
- 按主体与域名的动作量、限流次数、策略拒绝次数。
- 挑战命中率、误报复核率、人工接管耗时与超时率。
- 被阻断的私网、重定向、下载、popup 和非批准资源请求。
- 审计写入延迟、失败率、完整性校验结果。

日志、指标和 trace 使用同一 traceId 关联。告警应覆盖审计不可用、私网访问尝试、短时大量挑战、Worker 清理失败、策略签名异常和同一主体异常并发。

## 13. 测试策略

测试只能针对本地夹具、自有测试站点或有书面授权的环境；不得把公共 Cloudflare/CAPTCHA 页面当作“能否绕过”的验收测试。

| 层级 | 重点 | 代表性用例 |
| --- | --- | --- |
| 单元测试 | Schema、URL 规范化、host 匹配、状态机、延迟边界、错误映射 | Unicode hostname、尾点、相似后缀、min/max、非法状态转换 |
| 属性测试 | URL/重定向解析、opaque ref、动作计划不变量 | 随机 URL 不能逃逸 allowlist；轨迹不越视口；延迟不越硬上限 |
| 契约测试 | MCP 输入输出、幂等、deadline、错误结构 | 重复键同参数返回同结果；同键异参数拒绝 |
| Adapter 测试 | 锁定 Playwright Firefox 高层 API 行为 | 可见按钮、遮挡按钮、动态 DOM、iframe、键盘输入、滚动 |
| 集成测试 | Gateway→Policy→Worker→Audit 全链路 | 创建、导航、快照、点击、关闭与 Profile 清理 |
| 安全测试 | SSRF、DNS rebinding、重定向、下载、popup、跨租户、日志泄露 | 127.0.0.1、私网 DNS、开放重定向、Cookie/密码不落日志 |
| 挑战安全测试 | 只验证“停止并接管”，不验证绕过 | 模拟 challenge fixture 后所有自动化写工具被拒绝 |
| 人工接管测试 | 单写者租约、MFA、超时、归还 | 接管时 Agent 输入被冻结；归还后旧 ref 失效 |
| 故障注入 | Worker 崩溃、审计失败、网络策略超时、磁盘压力 | fail closed、无重复提交、临时目录可回收 |
| 兼容测试 | 受控升级后的 Firefox/Playwright 组合 | 固定回归站点通过后才推广新版本 |
| 性能测试 | 并发会话、快照大小、限流、资源上限 | 配额内稳定；超限被拒且不影响其他租户 |

### 13.1 必须自动化验证的不变量

- 任意挑战命中后，页面变更工具均不能到达 Adapter。
- 任意未批准 origin 的顶层/子资源请求均不能到达网络。
- Agent 无法传入或间接构造 arbitrary evaluate/raw protocol 请求。
- Agent 无法覆盖交互节奏硬边界或请求“隐身”模式。
- 跨会话 targetRef、secretRef、artifactRef 和 idempotencyKey 不可复用。
- 审计不可用时，生产策略下页面变更动作不执行。
- 结果不确定的非幂等动作不会自动重试。
- Worker 关闭后临时 Profile 不可再访问。

## 14. 部署拓扑

### 14.1 本地单用户模式

MCP Gateway、控制面和 Worker Supervisor 位于同一受信任主机，通过 stdio 与 Agent 通信。Firefox Worker 仍需独立进程和临时 Profile。该模式适合开发及个人授权任务，不应暴露远程监听端口。

### 14.2 受管服务模式

- MCP Gateway 位于身份感知入口之后。
- 控制面按租户分区，Worker 池运行在无入站公网访问的隔离子网。
- 浏览器仅能经策略出口访问批准域名。
- Handoff UI 位于内部网络并使用企业 SSO/MFA。
- 审计、制品和业务状态使用不同存储与密钥；制品生命周期更短。
- 调度器不得复用活跃 Profile；Worker 节点退役前执行残留扫描。

## 15. 分阶段实施计划

### Phase 0：治理与安全基线

交付：

- 用例清单、域名授权登记、数据分类和滥用风险评估。
- MCP 工具白名单、错误码、状态机、日志数据字典。
- ADR：选定版本锁定的 Playwright Firefox 兼容构建，明确禁止本项目自定义隐身补丁/挑战求解。
- 威胁模型和安全验收门禁。

退出条件：产品、安全、法务和架构共同确认范围；未授权“过 CF”不作为需求或验收项。

### Phase 1：最小只读闭环

交付：

- Gateway、Policy Engine、Session Manager、Worker Supervisor 骨架。
- session_create、navigate、snapshot、session_get、session_close。
- 域名/重定向/私网阻断、会话隔离、基础限流和审计。
- 本地测试站点与契约测试。

退出条件：安全测试证明未批准流量无法发出，关闭后 Profile 可回收，日志无敏感值。

### Phase 2：受控交互

交付：

- click、type、scroll、wait。
- opaque targetRef、pageRevision、元素可操作性检查。
- Rhythm Engine 的有界、可重放轨迹和节奏。
- 敏感动作审批钩子及非幂等重试保护。

退出条件：动作不变量、动态页面回归、并发锁和属性测试全部通过。

### Phase 3：挑战冻结与人工接管

交付：

- Challenge Guard、HUMAN_REQUIRED/HUMAN_CONTROLLED 状态。
- 内部 Handoff UI、SSO/MFA、一次性租约、单写者锁。
- 接管告警、超时回收和旧 ref 作废。

退出条件：模拟挑战只会停止或人工接管；不存在自动求解路径；双重输入测试通过。

### Phase 4：生产加固

交付：

- Worker OS/容器隔离、出口策略、SBOM、签名校验、密钥和制品治理。
- 故障注入、容量测试、SLO、告警、运行手册和应急开关。
- 依赖升级与兼容测试流水线。

退出条件：安全评审、隐私评审、灾难恢复演练和灰度门禁通过。

### Phase 5：受限试点与推广

交付：

- 从单一自有测试域名、少量主体、低并发开始。
- 审核策略拒绝、挑战误报、人工接管及审计完整度。
- 只按域名逐项批准扩展，不提供全局通配符。

退出条件：试点期间无越权网络、敏感日志、跨会话泄露或自动挑战处理；每次扩域均有新授权记录。

## 16. 架构验收清单

- [ ] 当前版本的产品名称、文档和接口不宣称已支持“过 CF”“反检测”或“隐身”；规划目标与已交付能力分开标注。

- [ ] 使用官方 Firefox，二进制和依赖可追溯。
- [ ] MCP 写操作不暴露 arbitrary JavaScript、raw protocol、任意 selector/coordinate 或 shell；只读抽取 selector 受 schema 与大小上限约束。
- [ ] allowlist 在浏览器网络出口生效，并覆盖重定向和子资源。
- [ ] 私网、元数据地址、下载、popup 和未知 scheme 默认阻断。
- [ ] challenge 命中后先冻结，且只能人工接管或关闭。
- [ ] 人工接管有 SSO/MFA、单写者租约、超时和审计。
- [ ] 缓动轨迹和随机延迟有硬边界、可重放、可关闭，且不用于对抗检测。
- [ ] 会话、Profile、ref、secret 和制品均实现租户隔离与 TTL。
- [ ] 密码、Cookie、授权头、输入值和完整页面正文不进入普通日志。
- [ ] 非幂等动作在结果不确定时不会自动重放。
- [ ] 审计或策略不可用时生产系统 fail closed。
- [ ] 测试环境和目标站点均有明确授权，不以公共挑战绕过为测试目标。

## 17. 待产品与安全共同确认的问题

以下问题不会改变安全底线，但会影响实现优先级：

1. 首批获授权域名、允许资源域名和业务责任人分别是什么？
2. 首批允许动作是否包含登录、表单提交或其他敏感操作？审批人是谁？
3. 是否确需远程 MCP；若需要，租户身份源、网络边界和密钥体系是什么？
4. 人工接管只需本机，还是需要企业内部 Handoff UI？
5. 截图、无障碍树和审计事件分别涉及何种数据分类与保留期？
6. 可接受的最大并发会话、单会话 TTL、动作速率和浏览器资源预算是多少？
7. Firefox/Playwright 升级的兼容窗口、回滚策略和安全补丁 SLA 是什么？

这些问题应在 Phase 0 形成可追溯决策记录；在答案缺失时使用最严格默认值，而不是由 Agent 自行推断或放宽。
