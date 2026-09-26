# 当前项目与 Chromix 的区别

> 历史对照：下文的 Chromix 发行资产与测试计数截至 2026-09-07/08，不代表当前状态。2026-09-25 的商业及开源项目对照、Chromix 后续发行与验收边界见 [市场与开源项目对照](./market-comparison-2026.md)。

2026-09-08 补充：独立 Chromium 补丁已实现语言、ICU locale、时区、硬件并发数，以及 Canvas、音频、字体、WebGL/WebGPU 身份和设备内存的源码改造，并接入启动器。用户要求本轮不编译，当前验证仅包括精确源码应用、静态检查和轻量测试；以下运行能力对比仍按默认运行时计算，不将新源码当作已通过原生验收的二进制。详见 [内核实现范围与验证状态](../browser-core/chromium/README.md)。

更新：2026-09-07。对照对象为 Chromix `e540796decd489e8e9dff8dea940eb03e77db693`；当日重新检查公开发行资产，仍是 Windows x64 的 151/152 两个包。这里只比较源码、公开交付物和本项目已完成的测试，没有运行 Chromix 二进制，因此不对两者检测站表现或运行性能作胜负判断。

| 维度 | 我们的项目 | Chromix |
| --- | --- | --- |
| 产品重点 | 环境管理与自动化平台：Studio、Profile、代理池、扩展、权限、审计、RPA、MCP，另有独立 CDP 服务 | 定制 Chromium 内核及 Node/Python SDK |
| 浏览器路线 | 锁定 Playwright Chromium/Firefox；自定义 Firefox 补丁为单独可选路径 | 基于 ungoogled-chromium 的补丁构建 |
| 指纹配置生效层 | Playwright context、CDP、JS 注入、Firefox 原生 prefs 组合 | 修改 Chromium/Blink/相关组件，再由启动参数传递 persona |
| 原生覆盖差距 | 改写 JS 可见字段不等于更改底层实现；Linux GPU 池仍较保守，GPU 设备能力也依赖宿主 | 补丁触及 WebGL/WebGPU、时区、字体、Canvas、音频等内核路径；实际效果仍需二进制验证 |
| Profile 管理 | 产品化的持久环境、权限、克隆与存储生命周期；CDP 模式一实例一份 Profile | SDK 提供普通及持久 Context 启动，种子可显式固定 |
| 远程 Playwright | 已有 Bearer 认证、discovery、WS 转发、连接限额、状态接口、断开重连与持久化回归测试 | SDK 主要负责本地启动；所审阅仓库未提供同等的工作区管理/CDP 服务产品层 |
| Docker | 已有专用构建文件、Compose、示例与源码包；实际 Linux 镜像验收仍待完成 | 当前公开 Release API 中未提供 Linux 浏览器包，不能直接把 Windows ZIP 装进 Linux 镜像 |
| GeoIP | 国家默认值与实际出口验证分开；CDP 模式代理和地域需显式配置 | 审阅的 Node SDK GeoIP fetch 没有走传入代理，不应直接照搬 |

## 本轮继续完成的优化

- CDP 元数据创建改成先写临时文件、fsync 后原子发布；16 个并发创建者获得同一份完整身份，已有文件不会被覆盖。
- 每次启动重新验证持久文件中的 locale 和 timezone，拒绝空白或非十进制整数种子，不静默重置损坏 Profile。
- CDP 外部连接默认上限 8，可配置为 1–64，握手中的连接也占名额，超限返回 429，断开后释放。
- `/status` 需要认证，返回预期配置与连接数；明确不把它当作实际 GPU/网络出口验证结果。
- 增加端口冲突后的 Profile 释放、浏览器退出后服务关闭、超限拒绝与回收的真实浏览器测试。
- 提供 `scripts/package-cdp.ps1`，按明确文件清单打包源码和校验和，不收集本机 Profile、账号、代理凭据或工作区中的临时抓取脚本。

本轮类型检查、234 个单元测试、35 个 MCP 测试、26 个默认集成测试及 CDP 专项回归通过，生产构建通过。按条件未启用的用例不算通过。此前身份与请求头测试已通过，本轮未修改相关逻辑。

## 当前仍未完成的工作

1. 实际 Linux Docker 构建、容器重启/持久化与网络连接验收。此前 Docker Desktop 启动故障仍未解决；现有源码包不是 `docker load` 镜像。
2. 更完整的跨域 iframe、Shared Worker、已存在 Service Worker 恢复与多客户端并发行为矩阵。现有用例只能证明它们覆盖的路径。
3. 有真实可用 GPU 的环境中验证 WebGPU adapter/device/limits、WebGL1/2 与字体渲染一致性。不能因为 JS 返回目标型号就认为真实能力已改变。
4. Chromium 原生补丁及剩余六类表面的源码实现已经加入；按本轮要求暂不编译，实际 Linux 编译、原生运行验证和版本升级回归仍需之后执行。GPU 元数据配置不改变真实硬件能力，字体策略也不模拟另一操作系统的字形。

这些是不同层面的能力，不能简单认定我们的功能更多就意味着内核更强，也不能仅凭 Chromix 有更多补丁就认定实际效果一定更好。

资料：[Chromix 固定源码](https://github.com/xiaozhou26/Chromix/tree/e540796decd489e8e9dff8dea940eb03e77db693)、[发行版本](https://github.com/xiaozhou26/Chromix/releases)、[本项目 Docker/CDP 使用说明](./docker-cdp.md)、[详细源码核查](./chromix-cdp-audit.md)。

## 2026-09-26 当前对照：集成关系与证据边界

上文是 **2026-09-07/08 的历史记录**，尤其“默认运行时”与“仅 Windows 151/152 两包”不能当作今天的发行或产品结论。这里固定比较上游 **Windows x64 `152.0.7977.82` 原始 ZIP**：其发行说明将该资产绑定到构建仓库提交 [`93c8511ab187b97395a0a5b4160a47e7b7e412c3`](https://github.com/xiaozhou26/Chromix/tree/93c8511ab187b97395a0a5b4160a47e7b7e412c3)，而不是最初的 release tag 提交；ZIP 摘要为 `1cfbe638212ba4d463a8c3330fcfbd8c88f9844ff6dfc0722f2c40745e0bc7f8`。[上游发行说明与构建记录](https://github.com/xiaozhou26/Chromix/releases/tag/v152.0.7977.82)、[本项目固定安装器及核查](./chromix-upstream-assessment.md#2026-09-26-本项目接入更新仍待真实浏览器验收)。

| 维度 | Chromix 上游（固定 152.82 Windows x64） | browser-profile-studio 当前状态 |
| --- | --- | --- |
| 定位与关系 | 定制 Chromium 二进制、[Python SDK](https://github.com/xiaozhou26/Chromix/blob/93c8511ab187b97395a0a5b4160a47e7b7e412c3/sdk/python/README.md) 与 [Node SDK](https://github.com/xiaozhou26/Chromix/blob/93c8511ab187b97395a0a5b4160a47e7b7e412c3/sdk/node/README.md)：提供 Playwright 启动、普通/持久 context、代理/GeoIP、种子与自动化接口；不是仅有裸浏览器。 | [README 当前功能](../README.md#当前交付验收2026-09-26)以指纹浏览器为产品目标，Studio/Profile 是管理控制面；Chromium 可选 stock、自有 native 151 **或实验性集成 Chromix 152**。选 Chromix 时是使用其上游内核，不是与它独立竞争的另一套原生能力。 |
| 原生指纹深度 | 固定提交的 [208 项补丁系列](https://github.com/xiaozhou26/Chromix/blob/93c8511ab187b97395a0a5b4160a47e7b7e412c3/patches/series)触及 Blink、V8、浏览器进程与 GPU/显示、字体、WebRTC 等路径；[上游 flag 合同](https://github.com/xiaozhou26/Chromix/blob/93c8511ab187b97395a0a5b4160a47e7b7e412c3/docs/fingerprint-flags.md)明确进程启动时固定一份 persona，不是按 BrowserContext 独立，GPU 字符串不能改变实际驱动、limits、shader 或物理设备，WebRTC IP 呈现不等于 socket/STUN 路由。源码范围不是逐项二进制实测结果。 | [Chromix 启动参数映射](../src/browser/chromix-runtime.ts)将固定 seed、Windows 平台/版本、硬件、屏幕、语言/时区及可选字体池传给上游，禁止合成设备模式和 Canvas/Audio 扰动，固定 `--fingerprint-noise=false`；因而继承上游对应原生深度**及限制**，不声称跨 Profile 噪声唯一。自有 [Chromium 151 两枚补丁](../browser-core/chromium/README.md)覆盖的源码表面与 Chromix 152 不是同一个二进制，自有 Windows 原生构建/运行尚未通过。 |
| 管理、后端与安全 | SDK 提供本地启动、持久目录、加密 Cookie 显式迁移及代理/GeoIP；不能因为没有 Studio 就说它没有 Profile 或自动化。[上游 README](https://github.com/xiaozhou26/Chromix/blob/93c8511ab187b97395a0a5b4160a47e7b7e412c3/README.md)、[Node SDK 合同](https://github.com/xiaozhou26/Chromix/blob/93c8511ab187b97395a0a5b4160a47e7b7e412c3/sdk/node/README.md)。 | [README 功能/API](../README.md#studio-产品-api)描述 Studio 批量启停、克隆、代理池、扩展、RPA、MCP/REST、工作区资源授权、审计、机密加密及独立认证 CDP 服务；这是上游 SDK 之外的应用层，不会自动使原生指纹更强。Chromix Profile 身份首次成功启动后冻结，浏览器数据隔离，缺包或校验失败不会回退 stock；[接入状态](./chromix-upstream-assessment.md#2026-09-26-本项目接入更新仍待真实浏览器验收)。 |
| 构建、来源与发行 | [上游发行说明](https://github.com/xiaozhou26/Chromix/releases/tag/v152.0.7977.82)称 Windows 原始 CI ZIP、成功 stage 11 和身份矩阵 10/10，但同时明确 `full_acceptance=false`：物理设备、外部网络、字体文件与实际栅格化绑定未证实，QUIC 仅自有回环；摘要/许可证不等于签名或可复现来源证明。 | [安装器与运行时](../src/browser/chromix-runtime.ts)固定发行 ZIP 摘要、安装文件清单及 `chrome.exe`/`chrome.dll` 哈希，不能拿该包冒充自有 151 构建；固定文件一致性不证明二进制来自公开源码。自有 151 源码补丁静态检查不等于已编译 native ZIP、Windows 安装/发行验收或物理 GPU 验收。[原生构建状态](../browser-core/chromium/README.md)、[README 发行边界](../README.md#windows-x64-离线原生发行包未签名)。 |
| 实测证据 | 上游报告属于发布者在指定 CI 配置下的门槛结果，不将 [当前源码 flag 文档](https://github.com/xiaozhou26/Chromix/blob/93c8511ab187b97395a0a5b4160a47e7b7e412c3/docs/fingerprint-flags.md)的所有行为反推成发行 ZIP 已独立验证。[发行说明](https://github.com/xiaozhou26/Chromix/releases/tag/v152.0.7977.82)。 | 最新 [hosted run 36219850042](https://github.com/chuanxu742-glitch/browser-profile-studio/actions/runs/36219850042) 的 [job 列表](https://api.github.com/repos/chuanxu742-glitch/browser-profile-studio/actions/runs/36219850042/jobs)：固定 ZIP 安装与**直接浏览器**兼容性检查通过；跨页面/iframe/Worker 与重启断言范围见[README 运行记录](../README.md#windows-x64-chromix-152-实验性预编译浏览器)。Studio 已保存 Profile 在 hosted 虚拟 GPU 上拒绝启动；物理 GPU job 为 `skipped`。总 workflow 绿色不是产品、物理 GPU、公共网络或完整指纹验收通过。 |

**实际含义：**若目标是更深的原生 Chromium 表面，集成模式依赖 Chromix 上游二进制，不能用 Studio 功能数量宣称胜过其内核；若目标是可管理、可授权、可审计的持久 Profile 与受策略约束的自动化，Studio 补的是 SDK 之上的控制面。上游源码主张、发布者 CI 结论、本站 hosted 直接浏览器观察与仍未执行的物理 GPU/外部网络验证须分别标注；尤其不要把自有 native 151 的未编译补丁当作已交付的 152 能力，也不要把 `full_acceptance=false` 说成失败或完全通过。[上游边界](https://github.com/xiaozhou26/Chromix/releases/tag/v152.0.7977.82)、[本项目验收表](../README.md#当前交付验收2026-09-26)。
