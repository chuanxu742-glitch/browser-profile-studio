# Chromix 对照核查与 Docker/CDP 交付依据

核查日期：2026-09-07。本轮先核查，后续按此结果优化，再进行 Docker 验收。本文是审计结论与交付约束，不是已经完成 Docker 交付的声明。

本项目基线为 `1d0334e`；实测同时包含工作区原有的两个 launcher 修改。Chromix 源码固定为 `e540796decd489e8e9dff8dea940eb03e77db693`。已检查其 Node SDK、相关内核补丁、发行资产，以及本项目生成器、注入脚本、启动器、CDP 传输与 Docker 配置。没有运行 Chromix 发行版，也没有编译其内核，不能据此声称其所有宣传能力均有效。

后续实现状态：已按此报告增加独立 CDP 服务、Docker 构建文件、认证与持久 Profile，以及 Linux GPU/内存组合、启动证书校验和初始化失败处理修复。下方保留审计当时的观测与计划；最新使用方法和未完成的容器验收见 [docker-cdp.md](./docker-cdp.md)。

## 决定交付路线的事实

1. Playwright `connectOverCDP` 只适用于 Chromium 系列。Firefox 不能作为这个接口的服务端；Playwright `connect()` 是另一种协议，不应混称 CDP。[官方接口文档](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp)
2. GitHub Release API 本次返回两个 Chromix 发行版：`v152.0.7977.75`、`v151.0.7922.173`，均只有 `chromix-win-x64.zip`、LICENSE 和 SHA256SUMS。SDK 中列出 Linux 下载文件名，不等于该文件已经发布。当前没有已核实的官方 Linux 发行包可以直接放进 Linux Docker。[发行页](https://github.com/xiaozhou26/Chromix/releases)
3. 我们的 `Dockerfile` 启动 `dist/index.js`，即 stdio MCP。`docker-compose.browser.yml` 启动的是 Selenium 镜像，不会调用本项目受管启动器与指纹配置。把这个 companion 的 9222 端口公开不等于交付本项目的指纹浏览器。
4. 本地 Docker CLI/Compose 已安装，但 `docker version` 无法连接 Docker Desktop Linux daemon。本轮未启动 Docker，因此没有镜像构建或 Linux 容器运行证据。

建议：第一版容器使用项目已锁定的受管 Chromium，新增独立 CDP 服务入口。Chromix 作为后续可选内核，只有取得 Linux 构建、校验和及通过相同测试后才接入。若要求第一版必须直接使用 Chromix 内核，需要增加独立的 Linux 内核构建工作，不能通过改一个 executablePath 完成。

## 两边具体有什么差异

| 方面 | Chromix 源码证据 | 本项目证据与结论 |
| --- | --- | --- |
| 配置生效位置 | `patches/0011`、`0017`、`0019` 等修改 Blink navigator/语言/时区；`0090–0092` 增加 persona 模型 | 我们使用 Playwright context、CDP、JS 注入以及 Firefox prefs，不能把相同返回字符串理解为相同内核覆盖 |
| 语言和时区 | Node `buildContextOptions` 明确移除 context 层 locale/timezoneId；顶层设置转为内核 flags | 上一份比较文档中“Chromix 用 Playwright locale 构建 context”的描述不准确，现已更正 |
| GPU 一致性 | `0092` 在 WebGL1/2、WebGPU 间共享选择，但该补丁可见的默认池也是 D3D11 型号 | 我们将 Windows 与 Linux 放入同一个非 Apple GPU 池，实测 Linux 身份报告 D3D11。需要按 OS/后端建模；不能直接照搬对方 GPU 池 |
| deviceMemory | `0015` 将值归入预设桶；具体桶是否适合目标版本仍需验证 | 我们的候选包含 24；Web API 是粗化的 2 次幂值，不能直接使用任意物理内存值。桶上下界应按锁定版本确认，不应固化“所有新版本最大值都是 8”的旧假设 |
| WebGPU | 修改 adapter、limits 等内核路径 | 我们的生成器按 Chromium 就设置 supported；当前实测 requestAdapter 无可用 adapter。必须区分 API 存在、adapter 可用和设备可创建。现有 Proxy 包装是否保持原生 receiver 语义还需有可用 GPU 的环境验证 |
| GeoIP | Node `geoipHttp(proxyUrl)` 的 fetch 没有使用 proxyUrl，并将国家代码小写作为 locale | 不适合照搬。出口 IP 探测必须经过实际代理，国家不能简单变成 BCP 47 locale |
| 文件完整性 | Node SDK 缺失校验清单时警告后继续解压 | 我们的自定义 Firefox 有更严格的版本/源码/补丁/二进制校验；未来内核发行沿用严格校验，不降级 |
| 场景覆盖 | 原生补丁有覆盖更多上下文的潜力，但此处未实测其二进制 | 当前已有 Window/iframe/Worker/Service Worker 部分用例；缺少完整重连、跨域 frame、恢复 SW、并发 Context、故障注入和容器矩阵 |

Device Memory 的规范是实现相关边界内的粗化值：[W3C Device Memory](https://www.w3.org/TR/device-memory/)。Chromix 文件路径均相对于[固定源码版本](https://github.com/xiaozhou26/Chromix/tree/e540796decd489e8e9dff8dea940eb03e77db693)。补丁文件存在不代表对应能力已经通过运行验证。

## 本次实际 CDP 接管试验

测试在 Windows 主机进行，使用受管 Chromium `151.0.7922.34`、Playwright `1.62.1`、seed `31337`、Linux 配置、日语/东京时区。测试仅访问临时回环 HTTP fixture，不访问第三方网站，不使用已有账号或用户 Profile。

步骤：受管启动器创建临时持久 Context → 读取 DevToolsActivePort → 第二个 Playwright 进程内客户端连接 browser WebSocket（noDefaults:true）→ 在既有 Context 新建页面 → 另建 Context → 断开客户端 → 原客户端继续操作。

| 检查 | 观测结果 | 能说明什么 |
| --- | --- | --- |
| CDP 连接、goto、fill、click | 成功，页面标题变为 connected | 底层受管 Chromium 可以被外部 CDP 客户端驱动 |
| 既有 Context 的 UA、平台、语言、时区、网络 UA/CH | 与连接前相同 | 这个配置和此条连接路径下没有丢失这些设置 |
| 客户端断开后继续操作 | 成功 | 此次 `browser.close()` 断开 CDP 客户端没有关闭原宿主浏览器 |
| `browser.newContext()` | 可以创建；观察到身份值相同，视口宽度从 2560 变成 1280 | 新 Context 不等同于受管持久 Profile，不能承诺新建后自动继承全部配置 |
| Linux 配置的 WebGL | 报告 AMD RX 6600 Direct3D11 | 已证实环境组合存在矛盾 |
| WebGPU requestAdapter | 无 adapter | 本机 headless 环境尚不能验证 requestDevice 的成功路径 |

一次试验不是多客户端并发保证，也不是 Linux Docker 保证。本轮证据保存在 `artifacts/chromix-audit/`：`probe-cdp.mts`、`cdp-observed.json`、`releases.json`、`source-hashes.json`。该目录由 gitignore 排除；重新运行探针会生成新的观测结果。

## 优化任务与先后顺序

| 优先级 | 任务 | 完成标准 |
| --- | --- | --- |
| P0 | 修正 OS/GPU/内存/语言/视口组合，区分 WebGPU 声明和实测 | 固定种子可复现；非法组合被拒绝或规范化；不得仅以“返回了预期字符串”作为测试结论 |
| P0 | 审查两个 launcher 的现有参数 | 处理全局忽略证书、重复/无效开关；保留必要参数并验证默认 HTTPS 行为，不把开关数量当作优化程度 |
| P0 | CDP 专用服务入口与容器可达端点 | 宿主机及同一 Docker 网络的客户端都能通过 HTTP discovery 或 WebSocket 连接；不返回客户端无法访问的容器回环地址 |
| P0 | 受管环境建立失败的处理 | 当前 Service Worker 配置存在捕获错误后仅警告并继续的分支；通过故障注入验证失败能被状态接口暴露，并按明确策略阻止错误环境继续服务 |
| P1 | 生命周期与持久化 | 客户端断开保留浏览器；容器停止优雅关闭；重启保留 Cookie/存储与种子；并发占用同一 Profile 有明确错误 |
| P1 | 扩大真实浏览器矩阵 | 页面、跨域 iframe、Dedicated/Shared Worker、Service Worker 初次启动及恢复；JS 与 HTTP 一致性；WebGL1/2；GPU 可用和不可用路径 |
| P1 | 验证产物可独立部署 | Linux 构建、Compose 启动、健康检查、连接示例、版本信息、故障诊断、镜像导出及 SHA-256 |
| 后续 | Chromix Linux 内核适配 | 取得可复现 Linux 构建和完整性证据，解决与当前版本身份锁的差异，运行同一套矩阵，再切换引擎 |

## 最终 Docker 产品约定

建议初版为 Linux amd64、一容器一个 Chromium 进程、一份持久 Profile。seed、locale、timezone、代理与 viewport 由服务启动配置确定。客户端通过 `chromium.connectOverCDP` 连接并复用 `browser.contexts()[0]`；额外 Context 不作为“新持久 Profile”的替代。多份独立环境使用多个实例，后续再做调度接口。

CDP 是浏览器级完整控制入口，现有 MCP 的 URL/动作策略不能约束直接 CDP 命令。因此将它实现为用户明确要求的独立服务模式，默认本机或私有网络访问；需要远程接入时使用认证网关。保留原 MCP 产品接口及其语义。

最终交付物：专用 Dockerfile、Compose、环境变量示例、Node/Python Playwright CDP 示例、自动化 smoke 脚本、固定版本信息、使用说明，以及实际构建的镜像或可导入镜像包。对外发布 registry 不属于当前默认动作。

验收必须在实际 Linux 容器完成：构建成功、健康就绪、连接和基本页面操作成功、既有 Profile 持久化、客户端断开重连、进程异常退出、容器重启、端点鉴权（若启用）、服务关闭资源释放。全部取得证据后才能称为 Docker 版本交付完成。
