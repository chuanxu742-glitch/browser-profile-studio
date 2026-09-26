# 2026 年指纹浏览器市场与开源项目：可验证的差距

> 证据截点：2026-09-25。用途：比较产品形态、源码与发行证据，**不是**规避检测指南或通过率榜单。商业栏仅记录厂商官方公开宣称；开源栏记录项目仓库及其发行页可核查的事实。本文没有安装、运行或独立测试任何竞品。链接所指页面可能日后更新，日期只表示本次查阅时的截点；GitHub 的提交、Release、二进制原生验收分别是不同证据。版本、权限与价格可能随套餐变化。

## 一眼结论

- **商业成品** AdsPower、GoLogin、Dolphin Anty 的公开页面同时覆盖档案、代理、团队协作和自动化；这说明竞争目标是完整运营工作流，而不只是替换某个 `navigator` 值。[AdsPower 产品页](https://www.adspower.com/) · [GoLogin 功能页](https://gologin.com/features/) · [Dolphin Anty 产品页](https://dolphin-anty.com/)
- **开源并非同质品**：Camoufox 是可下载的 Firefox 改造浏览器及 Playwright 接口，但项目自己警告仍在开发、不适于稳定生产；Chromix 是有部分平台已发布包的 Chromium 改造浏览器及 SDK，但其新 216 补丁栈尚无匹配的原生编译验收；rebrowser-patches 是自动化库补丁，BrowserForge 是指纹/HTTP 请求头生成器，而不是完整浏览器。[Camoufox README 与 Release](https://github.com/daijro/camoufox) · [Chromix README](https://github.com/xiaozhou26/Chromix) · [rebrowser-patches README](https://github.com/rebrowser/rebrowser-patches) · [BrowserForge README](https://github.com/daijro/browserforge)
- **本仓当前差距的关键不在参数清单**：Studio/自动化产品面已有相当覆盖，但本仓 Chromium 151 Linux x64 原生补丁尚未编译运行；Firefox 深层 Worker Canvas 未过；必须先证明跨 JS/Worker/网络/真实 GPU 的一致性及可重现发行，才能讨论与原生浏览器并列。该句依据主任务截至本次调研提供的本仓验收快照，并非本文对竞品的实测；旧版 [本仓实现报告](./implementation-report.md) 与 [旧 Chromix 对照](./project-vs-chromix.md) 的历史数字及发行清单**不得**替代当前快照。

## 比较口径

| 证据层级 | 本文允许下的结论 | 不能据此下的结论 |
| --- | --- | --- |
| 厂商功能页/帮助中心 | “厂商公开称有此设置/流程/平台” | 实际底层修改层级、全版本全套餐可用、检测通过率或网络出口无泄漏 |
| 开源 README/源码及 LICENSE | 仓库定义、实现路线、声明的边界及仓库许可 | 所有第三方组件同许可证、实机通过或生产成熟 |
| GitHub Release/资产/构建报告 | 特定版本、平台的资产存在；报告记载了哪些验证 | 未发布目标平台也已交付、新源码栈已进入旧二进制、未覆盖场景已通过 |
| 本仓运行证据 | 仅主任务提供的具体验收快照；本篇未复跑 | 广泛检测效果、跨 OS 部署或未编译补丁的原生效果 |

指纹至少有**JS 可见属性/渲染**、浏览器**原生后端及能力**、**请求头与 UA-CH**、代理出口/DNS/**WebRTC ICE**四层；“设置显示为某值”不等于后端算出相应图像、声音或网络流量。以下对未有厂商可核查内部源码的项目，不推定其 native/JS 比例；UA-CH 未明确列出时不推断已实现逐层一致性。

## 商业成品：仅官方宣称，不代表独立验证

| 产品与平台 | 档案/代理/团队/扩展/自动化产品面 | 指纹及跨层一致性：官方可查的**声明** | 公开证据边界 |
| --- | --- | --- | --- |
| **AdsPower**；[官方下载页](https://www.adspower.com/download)列 Windows、macOS、Linux | [建档说明](https://help.adspower.com/docs/creating_browser_profiles)写明独立档案、批量 Quick Create、代理检查与已存代理、组/标签、Cookie 导入、按档案选择扩展；[产品页](https://www.adspower.com/)列团队角色/权限、RPA、窗口同步器、REST API、MCP。SunBrowser 基于 Chrome、FlowerBrowser 基于 Firefox，系其[建档说明](https://help.adspower.com/docs/creating_browser_profiles)原文。 | [指纹设置说明](https://help.adspower.com/docs/browser_fingerprint)列 UA、WebRTC Forward/Replace/Real/Disabled、按 IP 设置时区/语言、Canvas/WebGL/Audio 噪声与 WebGPU 设置；[建档说明](https://help.adspower.com/docs/creating_browser_profiles)建议 UA 匹配所选内核，并称随机指纹的 UA/WebGL/CPU/RAM 会在启动时重生且此项为付费功能。 | 官方说明的是设置选项与营销主张，未在本文验证 UA-CH 请求、原生 GPU 能力、WebRTC 实际 ICE/出口或“无封号”。产品页宣称的效率与安全效果不能当实测。[来源](https://www.adspower.com/) |
| **GoLogin**；[下载页](https://gologin.com/download/)列 Windows、Linux、macOS Intel/ARM | [功能页](https://gologin.com/features/)列克隆/批量档案、内建代理、会话和文件夹分享及权限、扩展导入/导出、API/SDK/MCP、Puppeteer/Selenium、云档案与云启动、headless/headful；另列 Action Synchronizer/Cookie Bot/Mass Actions，不应误叫为已核实的可视化 RPA 编辑器。 | [功能页](https://gologin.com/features/#fingerprint-protection)宣称覆盖 UA、CPU、字体、Canvas/WebGL、WebRTC 本地/公网地址、STUN/TURN 等“50+”参数及 IP/DNS/WebRTC 保护。 | 50+ 是厂商项目列表，不等于 50 项真实后端经过跨接口验证；[功能页](https://gologin.com/features/)称安全、加密及防关联，本文未审计其客户端源码、云端密钥或代理网络。UA-CH 行为未获得独立实测证据。 |
| **Dolphin Anty**；[下载页](https://dolphin-anty.com/download/)列 Windows 64 位、macOS Intel/M、Linux AppImage/deb/rpm | [产品页](https://dolphin-anty.com/)列档案批量操作、同步器 beta、团队档案/代理/Cookie 共享、档案/文件夹权限、脚本场景自动化、付费档案/Cookie/扩展云同步；[本地 API 操作指南](https://docs.dolphin-anty.com/en/api/basic-automation-dolphin-anty)要求桌面 App 正在运行/已授权，启动档案时启用 DevTools 后用 Puppeteer/Playwright/Selenium 接入，并注明免费套餐的 Cookie API 导入导出限制。 | [指纹官方讲解](https://dolphin-anty.com/blog/en/what-do-the-digital-fingerprint-parameters-mean-in-dolphin-anty/)列 UA、Canvas/WebGL/WebGPU、WebRTC Real/Altered/Manual、代理区域自动时区/语言/定位等可配置项；[产品页](https://dolphin-anty.com/)还宣称 ClientHints/Voices 改造。 | 官网说的“真实指纹”、WebRTC 与代理 IP 相符及“增强 ClientHints”都是厂商声明；没有独立比对真实 HTTP UA-CH、ICE/STUN 流量和各 Worker/底层 GPU。其[下载页](https://dolphin-anty.com/download/)只能证明官方列出的分发形态，不能证明本站实机安装结果。 |

商业维护也只按发布页判断：[AdsPower 下载页](https://www.adspower.com/download)在本次查阅时显示桌面版 8.9.23、2026-09-24 发布，并列不同系统安装包；[GoLogin 下载页](https://gologin.com/download/)和 [Dolphin 下载页](https://dolphin-anty.com/download/)列安装平台，但上述页面未给出可与 AdsPower 同口径比较的客户端版本/发布时间。不能把官网页面更新时间、营销“不断更新”或下载按钮当作可审计的浏览器内核升级记录。

**安全/合规读法**：三家网站均宣传账户安全、隔离或协作，不能由此推断代码可审计、密钥端到端保护得到独立验证，也不能承诺“不会封禁”。可参考其官方描述的权限与工作流，但工程验收应单独做授权范围、凭据存储、出口网络、审计与依赖/二进制供应链核查。[AdsPower](https://www.adspower.com/) · [GoLogin](https://gologin.com/features/) · [Dolphin Anty](https://dolphin-anty.com/)

## 开源：按交付物分类，许可证与维护证据分开

| 项目/类型 | 第一方实际范围及平台 | 许可证证据 | 截至 2026-09-25 的维护/交付证据与限制 |
| --- | --- | --- | --- |
| **[Camoufox](https://github.com/daijro/camoufox)**：Firefox 改造浏览器 + Python/Playwright 接口 | [README 指纹实现说明](https://github.com/daijro/camoufox#fingerprint-injection)称 C++/浏览器层拦截而非依赖 JS 注入，并描述 WebRTC 协议级 IP、网络头与 `navigator`、地域/时区及字体；实际[最新 beta.30 Release](https://github.com/daijro/camoufox/releases/tag/v152.0.4-beta.30)有 Windows x86/x64、Linux x64/ARM64、macOS x64/ARM64 ZIP。README 也坦承指纹旋转可能不一致、复杂检测仍可能识别。 | 仓库 [LICENSE](https://github.com/daijro/camoufox/blob/main/LICENSE) 为 MPL-2.0；[vendored Cursory NOTICE](https://github.com/daijro/camoufox/blob/main/additions/juggler/input/cursory/NOTICE)指出该部分另有 LGPL-3.0-or-later，不能把整体依赖一概视作 MPL。 | [v152.0.4-beta.30](https://github.com/daijro/camoufox/releases/tag/v152.0.4-beta.30)发布于 **2026-09-01**，Release notes 包含渲染及 WebGL↔screen 一致性修复；[仓库元数据](https://api.github.com/repos/daijro/camoufox)显示 2026-09-25 推送。README 首屏明确 **under development / may not be suitable for stable production use**；活跃与可下载不等于生产成熟。 |
| **[Chromix](https://github.com/xiaozhou26/Chromix)**：ungoogled-Chromium 补丁浏览器 + Python/Node SDK | [README](https://github.com/xiaozhou26/Chromix)称固定源码/补丁、每次启动 persona、持久 seed、代理/GeoIP 与限制非代理 UDP，源码目标有 Windows/Linux/macOS 各 x64/ARM64；SDK 不是团队管理台。**目标列表不是发布包清单。** [最新 v153 Release](https://github.com/xiaozhou26/Chromix/releases/tag/v153.0.8010.36)仅 Linux x64/ARM64 ZIP；[v152.0.7977.82](https://github.com/xiaozhou26/Chromix/releases/tag/v152.0.7977.82)另有 Linux、macOS x64/ARM64 和 Windows x64 等资产（按每个 Release 页面具体资产及时间认定）。 | 仓库 [LICENSE](https://github.com/xiaozhou26/Chromix/blob/main/LICENSE) 为 BSD-3-Clause；[README 发行说明](https://github.com/xiaozhou26/Chromix#downloads)称包内另有 Chromium/Chromix license 文件；复用时须逐项核对上游组件。 | [v153 Release 及 provenance](https://github.com/xiaozhou26/Chromix/releases/tag/v153.0.8010.36)记载 Linux 两架构构建提交、包哈希、原生启动及身份场景 10/10；同时明确 `ci_gate_passed=true`、`full_acceptance=false`，GPU/WebGPU/外网覆盖有缺口。当前 [README](https://github.com/xiaozhou26/Chromix)与 [FINGERPRINT_STATUS](https://github.com/xiaozhou26/Chromix/blob/main/FINGERPRINT_STATUS.md)又明确**新合并的 216 补丁栈尚未对匹配二进制完成原生编译验收**，旧发行包不构成新栈证明。[仓库元数据](https://api.github.com/repos/xiaozhou26/Chromix)显示 2026-09-21 推送；不能沿用本仓 2026-09-08 旧文“仅 Windows 包”的过时清单。 |
| **[rebrowser-patches](https://github.com/rebrowser/rebrowser-patches)**：Puppeteer/Playwright 的**库源码补丁**，不提供指纹浏览器成品 | [README](https://github.com/rebrowser/rebrowser-patches)说明针对 CDP `Runtime.enable` 泄漏与脚本 sourceURL/utility world 等自动化痕迹，需对已装库 patch 或换预补丁包；Playwright **目前只支持 Chrome**，页面明确“单靠这些补丁并不能解决代理、UA、Canvas/WebGL 等”。并注明 `page.pause()` 在启用补丁时受限，升级依赖可能覆盖补丁。 | 根仓库 [package.json](https://github.com/rebrowser/rebrowser-patches/blob/main/package.json)的 `license` 字段为 MIT，但 [GitHub 许可证 API](https://api.github.com/repos/rebrowser/rebrowser-patches)返回 `license: null`，根目录列表未见 LICENSE；**不能仅凭元数据为重分发作法律结论**，集成前应核对实际发布包及权利声明。 | [v1.0.19](https://github.com/rebrowser/rebrowser-patches/releases/tag/1.0.19)发布 **2025-05-09**；[README](https://github.com/rebrowser/rebrowser-patches#playwright-support)称 Playwright 最近“完整测试”版本 1.52.0（2025-04-17），Puppeteer 24.8.1；[仓库元数据](https://api.github.com/repos/rebrowser/rebrowser-patches)显示最后推送 2025-05-09。2026 年接新 Playwright 版本必须重新检验，不能由 README 宣称的规避效果推断本站通过率。 |
| **[BrowserForge](https://github.com/daijro/browserforge)**：Python **请求头/指纹生成器**，不是浏览器或原生补丁 | [README](https://github.com/daijro/browserforge#what-is-it)称基于统计分布生成浏览器/OS/设备组合，示例生成匹配 UA、`Sec-CH-UA`、`Accept-Language` 等 headers，及 fingerprint；原有 Playwright/Pyppeteer **JS 注入功能已标 deprecated**，推荐转向 Camoufox。[原文](https://github.com/daijro/browserforge#injecting-fingerprints) | [LICENSE](https://github.com/daijro/browserforge/blob/main/LICENSE) 为 Apache-2.0。 | [仓库最后一笔提交](https://github.com/daijro/browserforge/commit/a8b798f37460d1dd02aea33f80c83647913a1bbd)为 **2026-08-29** README 链接修订，[GitHub Releases 列表](https://api.github.com/repos/daijro/browserforge/releases?per_page=1)为空；最近推送不是功能更新，也没有此仓库 Release 资产可当浏览器二进制。生成匹配请求头的能力本身不保证服务端看到同一 TLS/网络协议栈或原生浏览器行为。 |

**可审计性限制**：开源许可证只覆盖对应仓库条款，不能代替第三方依赖、下载二进制与源码构建提交的逐项溯源；发行资产的存在不等于本文复核了散列或运行了包。Chromix Release 公布构建来源与 SHA-256 并如实标记不完整验收，是可核查的证据形式；Camoufox Release 提供跨平台资产但 README 警告生产稳定性；rebrowser-patches 的包内许可证与依赖版本更应在引入时单独审查。[Chromix v153](https://github.com/xiaozhou26/Chromix/releases/tag/v153.0.8010.36) · [Camoufox beta.30](https://github.com/daijro/camoufox/releases/tag/v152.0.4-beta.30) · [rebrowser package](https://github.com/rebrowser/rebrowser-patches/blob/main/package.json)

## 对本仓的差距判断与先后顺序

以下本仓数字与状态由本次主任务给定（**非本篇重测**）：Studio 空态 UI 本机可开；343 项单元、35 项 MCP、5 项真实 stock 指纹运行已通过；完整 `npm test` 中 integration **34 通过 / 1 失败 / 12 跳过**；Chromium 151 Linux x64 原生源码补丁**未编译/未运行**，Windows 未配置；Firefox 深层 Worker Canvas **NOT PASSED**。这些验证只覆盖对应路径，不能转化成原生内核发行或第三方站点检测结论。本仓旧 [implementation-report.md](./implementation-report.md) 和 [project-vs-chromix.md](./project-vs-chromix.md)有较早的不同测试计数与发行记录，应按日期区分，不当作本次新状态。

| 维度 | 当前可说的对比 | 还缺的证据/工程关口 |
| --- | --- | --- |
| 原生 vs JS 指纹 | 本仓有已运行的 stock 指纹路径与未编译的 Chromium 源码补丁；Camoufox/Chromix 的仓库有浏览器改造与发行资产，但 Chromix 新栈未过匹配原生验收。[Camoufox](https://github.com/daijro/camoufox) · [Chromix 状态](https://github.com/xiaozhou26/Chromix/blob/main/FINGERPRINT_STATUS.md) | 在目标 OS 编译本仓确切补丁，记录可复现源码/二进制散列，实测 Canvas、WebGL/WebGPU、音频、字体与实际后端/Worker；不能把 JS getter 值当物理 GPU 能力。 |
| 网络、UA-CH、WebRTC 一致性 | 商业产品公开列设置项，[AdsPower](https://help.adspower.com/docs/browser_fingerprint)和 [Dolphin](https://dolphin-anty.com/blog/en/what-do-the-digital-fingerprint-parameters-mean-in-dolphin-anty/)宣称代理区域匹配，[GoLogin](https://gologin.com/features/)列网络/ICE 项；BrowserForge 能生成头但不是出口层。[BrowserForge](https://github.com/daijro/browserforge) | 逐档案比对浏览器报告、HTTP 原始请求及服务端观察、UA/UA-CH/高熵提示、DNS/代理/ICE/STUN 与失败路径；跨 Page/iframe/Worker/重启维持同一身份。未测处记未知。 |
| Profile/代理/团队/扩展/RPA | 商业三家的[官方产品页](https://www.adspower.com/) [GoLogin](https://gologin.com/features/) [Dolphin](https://dolphin-anty.com/)给出了成套工作流。本仓主任务快照确认已有 Studio 等产品面；Camoufox/Chromix 主要是浏览器及 SDK，另两开源项目只是组件。 | 比较应按合同/权限/运维使用场景，而不是把组件缺少团队 UI 算浏览器内核缺陷；商业套餐可用性与安全承诺仍须逐项核对。 |
| 发行、维护、安全 | 本仓原生路径无可运行产物；[Chromix v153](https://github.com/xiaozhou26/Chromix/releases/tag/v153.0.8010.36)已有可核查 Linux 构建证据但未全面验收；[Camoufox](https://github.com/daijro/camoufox)声明开发中；[rebrowser](https://github.com/rebrowser/rebrowser-patches)兼容矩阵停在 2025。 | 优先补浏览器版本升级/目标平台构建、供应链散列、准确的测试矩阵与发布门禁，再谈通用“更强/更安全”；审计授权、密钥/代理出口和第三方组件许可。 |

**最终判断**：若目标是授权场景中的档案管理与可审计自动化，本仓应按已运行的产品面与独立的安全边界定位；若目标是和商业反检测宣称或开源原生浏览器较量“指纹效果”，现有证据不足，不能宣称胜负，更不能将失败/跳过/未编译路径算作通过。下一份可信结论必须来自**同一版本、同一代理出口、同一目标平台**的原生构建与跨层观测，而不是参数数量或营销话术。
