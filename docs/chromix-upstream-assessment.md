# Chromix 上游预编译包评估（Windows x64）

原始上游核查日期：**2026-09-25 UTC**；本项目接入状态更新于 **2026-09-26**（见文末）。原始核查范围仅为 [官方仓库](https://github.com/xiaozhou26/Chromix) 的公开源码、Releases 资产及 Actions 元数据；当时没有下载或运行浏览器二进制，也没有在本项目编译 Chromix。这里的“可下载”指 GitHub Release API 中资产状态为 `uploaded`，且当日对四个 ZIP 下载 URL 的 **HEAD 请求均得到 HTTP 200 与对应的 Content-Length**；不代表本机可执行或适合投产。项目当前锁定 [Chromium `151.0.7922.34`、Playwright `1.62.1`](../browser-core/chromium/core.lock.json)，**下列四个 ZIP 均不是该精确版本的本项目原生补丁构建**。

## 决定性结论：实际 Windows x64 资产

[完整 Releases API（本次返回五个 release、无下一页）](https://api.github.com/repos/xiaozhou26/Chromix/releases?per_page=100) 中只有以下四个 `chromix-win-x64.zip`；`v153.0.8010.36` 的资产只有 Linux x64/ARM64 与相应记录，**没有 Windows ZIP**。[README 下载表](https://github.com/xiaozhou26/Chromix#downloads) 所列目标平台及 Actions 构建成功与否都不能替代 Release 的资产检查。表内大小、SHA-256 和上传时间来自 [Release API](https://api.github.com/repos/xiaozhou26/Chromix/releases?per_page=100) 的实际 ZIP 记录；每项的版本、来源需分别看所在发行说明，不能从标签的目标提交推断后来追加/替换的包。

| 下载（各链接指向原 ZIP） | Chromium 版本 / 发行状态 | ZIP 字节数 / SHA-256 | 此 ZIP 的源码提交与验收来源 |
| --- | --- | --- | --- |
| [`v153.0.8010.47/chromix-win-x64.zip`](https://github.com/xiaozhou26/Chromix/releases/download/v153.0.8010.47/chromix-win-x64.zip) | `153.0.8010.47`；**Pre-release**，2026-09-21 02:53 UTC 上传 | `216711252`；`67dd32e3aec53b98fcfed560f9cdf620304473818a09b011a4f1c29329ac1b03` | [`9922d99ddde77949d97d4afbb0e2a207a4de53c6`](https://github.com/xiaozhou26/Chromix/commit/9922d99ddde77949d97d4afbb0e2a207a4de53c6)；[失败的 run `35538924769` / stage 8 job `106152895687`](https://github.com/xiaozhou26/Chromix/actions/runs/35538924769/job/106152895687) 的检查点运行文件**重新封装**；不是原 CI 分发 ZIP。[发行说明](https://github.com/xiaozhou26/Chromix/releases/tag/v153.0.8010.47)及[本包 provenance](https://github.com/xiaozhou26/Chromix/releases/download/v153.0.8010.47/provenance.json)均明确 `ci_gate_passed=false`、`full_acceptance=false`。 |
| [`v152.0.7977.82/chromix-win-x64.zip`](https://github.com/xiaozhou26/Chromix/releases/download/v152.0.7977.82/chromix-win-x64.zip) | `152.0.7977.82`；正式 release，2026-09-18 17:38 UTC 上传（替换此前 Windows 包） | `214411666`；`1cfbe638212ba4d463a8c3330fcfbd8c88f9844ff6dfc0722f2c40745e0bc7f8` | [`93c8511ab187b97395a0a5b4160a47e7b7e412c3`](https://github.com/xiaozhou26/Chromix/commit/93c8511ab187b97395a0a5b4160a47e7b7e412c3)，[成功的 run `35353874079` / stage 11 job `105628329483`](https://github.com/xiaozhou26/Chromix/actions/runs/35353874079/job/105628329483)，artifact `10553989310` 的**原始 ZIP**；发布者称原生 CI 门槛通过但 `full_acceptance=false`，具体边界见[发行说明](https://github.com/xiaozhou26/Chromix/releases/tag/v152.0.7977.82)。**标签**仍指最初的 `23fd0a7a0c63cd452cfaec6b2aba8469ef5d4123`，不是当前 Windows 包的源码。 |
| [`v152.0.7977.75/chromix-win-x64.zip`](https://github.com/xiaozhou26/Chromix/releases/download/v152.0.7977.75/chromix-win-x64.zip) | `152.0.7977.75`；正式 release，2026-09-07 10:06 UTC 上传 | `214372771`；`d1b6130762d18b8b0628e3004add0147f2997bd5caf5518cbbcbc0a4e35ffdb4` | [`0e6c7d180f45a2e925bed63167c5339fd454d067`](https://github.com/xiaozhou26/Chromix/commit/0e6c7d180f45a2e925bed63167c5339fd454d067)；[发行说明](https://github.com/xiaozhou26/Chromix/releases/tag/v152.0.7977.75)指向 run `34008538251`、artifact `9992670663`。 |
| [`v151.0.7922.173/chromix-win-x64.zip`](https://github.com/xiaozhou26/Chromix/releases/download/v151.0.7922.173/chromix-win-x64.zip) | `151.0.7922.173`；正式 release，2026-09-07 10:06 UTC 上传；**不同于本项目 `.34`** | `214207699`；`e4b6a6eb4f0be9b55bacd9944b0f8a11b5b067c7ba9272b79b920a547047f498` | [`65cf50e9738b75907393929a926b06698823ff09`](https://github.com/xiaozhou26/Chromix/commit/65cf50e9738b75907393929a926b06698823ff09)；[发行说明](https://github.com/xiaozhou26/Chromix/releases/tag/v151.0.7922.173)指向 run `33475286778`、artifact `9790066740`。 |

`v153.0.8010.47` 同时发布 **ARM64** ZIP，但它不是 x64：ARM64 与 x64 使用不同构建提交，ARM64 原生启动测试因 ZIP 的反斜杠路径被校验器拒绝而**未执行**；不能用该资产、其构建任务或 x64 的 CI 结果互证，见[该发行说明](https://github.com/xiaozhou26/Chromix/releases/tag/v153.0.8010.47)。当日 GitHub Release 列表的 Latest 是[仅 Linux 的 `v153.0.8010.36`](https://github.com/xiaozhou26/Chromix/releases/tag/v153.0.8010.36)；Latest 不等于最新 Windows 可用版本。

## 完整性、签名与许可边界

- 四个 ZIP 的 `digest` 均由 GitHub [Release API](https://api.github.com/repos/xiaozhou26/Chromix/releases?per_page=100) 提供。发布者的 [153 SHA256SUMS](https://github.com/xiaozhou26/Chromix/releases/download/v153.0.8010.47/SHA256SUMS) 与 [152.82 SHA256SUMS](https://github.com/xiaozhou26/Chromix/releases/download/v152.0.7977.82/SHA256SUMS) 对相应 x64 ZIP 给出相同摘要；较旧版本各自也附有 SHA256SUMS（[152.75](https://github.com/xiaozhou26/Chromix/releases/tag/v152.0.7977.75)、[151.173](https://github.com/xiaozhou26/Chromix/releases/tag/v151.0.7922.173)）。**截至 2026-09-25 的原始上游核查**尚未下载 ZIP，也没有独立重算 ZIP/包内 DLL 的哈希；随后对 152.82 ZIP 的下载及摘要核验见文末，不应外推到其他三个包或浏览器运行。实际使用须将同一 release 的 ZIP 与校验清单固定到特定 digest，不能只依赖可变的标签或未经验证的文件名。
- 153 x64 另附 [逐文件 package-manifest.json](https://github.com/xiaozhou26/Chromix/releases/download/v153.0.8010.47/package-manifest.json) 和 [provenance.json](https://github.com/xiaozhou26/Chromix/releases/download/v153.0.8010.47/provenance.json)：后者列出 ZIP、`chrome.exe` (`6788d5c3835e1c7c66f114a2ad039617783d6cb15765b922000a254ea95a6288`) 和 `chrome.dll` (`6420e4394dbd8cc408160832c830cea8a4243f816f5cb9838a1cbc629d8a0a29`) 的发布者哈希，并明确 DLL 只与封存检查点匹配、验收原始数据没有 DLL 哈希字段，**没有加载 DLL 或签名的源码→二进制证明**。原 ZIP 在 CI 未上传、发行包重新压缩且未再次原生运行，故原 CI 启动测试也不是发行 ZIP 的直接运行证明。[发行说明](https://github.com/xiaozhou26/Chromix/releases/tag/v153.0.8010.47)
- [Windows 打包脚本](https://github.com/xiaozhou26/Chromix/blob/main/build/windows/package-win.ps1) 创建携带 `LICENSE.chromix` 和 `LICENSE.chromium` 的 ZIP 与 SHA256SUMS；已审阅的 release 资产没有独立的 `.sig` / 签名证明，打包脚本也没有代码签名步骤。**未检验 ZIP 内 PE 的 Authenticode 状态**；哈希只验证内容一致性，不等于可信发布者签名或可复现构建证明。152.82 发行说明称 Windows ZIP 已含两种许可证并警告归档内 Windows 反斜杠路径可能被严格解压器拒绝；因此下载后还需核验路径安全与运行文件。
- [Chromix 仓库 LICENSE](https://github.com/xiaozhou26/Chromix/blob/main/LICENSE) 为 BSD 3-Clause，允许有条件的源码/二进制再分发：保留版权、条件及免责声明，不得未经许可借作者/贡献者名称背书；[Chromium LICENSE](https://github.com/chromium/chromium/blob/main/LICENSE) 也要求相应声明。[BUILDING.md](https://github.com/xiaozhou26/Chromix/blob/main/BUILDING.md) 规定按 Chromium archive → ungoogled 核心 → Windows 平台层 → Chromix 补丁构建；这些多层来源及随包第三方许可不能由 Chromix 顶层 BSD 声明一概替代。上游 [Windows 字体资源 NOTICE](https://github.com/xiaozhou26/Chromix/blob/main/assets/fonts/NOTICE) 和 [SOURCE.md](https://github.com/xiaozhou26/Chromix/blob/main/assets/fonts/SOURCE.md) **明确不授予这些字体的再分发权**；如果自己的再打包过程包含这些资源，应逐项核实权利。当前 Windows [打包脚本](https://github.com/xiaozhou26/Chromix/blob/main/build/windows/package-win.ps1)并未列出复制该 `assets/fonts` 目录的步骤；未解包资产，不能独立断言具体发行 ZIP 内字体/其他第三方许可清单完全合规。

## Actions 与源码补丁，不能互换为运行证明

[Windows x64 工作流运行列表](https://api.github.com/repos/xiaozhou26/Chromix/actions/workflows/build-win-x64-github.yml/runs?per_page=20)截至核查日，最新 #138 [run `35538924769`](https://github.com/xiaozhou26/Chromix/actions/runs/35538924769) 在 2026-09-20 结束为 **failure**；[stage 8 job](https://github.com/xiaozhou26/Chromix/actions/runs/35538924769/job/106152895687) 的 `Run stage 8` 步骤失败，`Upload final bundle` 跳过。**另行核查**的最近一次成功是 #133 [run `35353874079`](https://github.com/xiaozhou26/Chromix/actions/runs/35353874079)，2026-09-18 完成，[stage 11 job](https://github.com/xiaozhou26/Chromix/actions/runs/35353874079/job/105628329483) 成功且上传最终包，对应上表 **152.82** 而不是 153。当前公开 job 页面注明日志不可取得（需要读取权限或日志已过期）；细节以发行说明及 153 provenance 的声明为准，**未独立审计原始完整构建日志**。

153 的失败不是仅仅“CI 红”：其[发行说明](https://github.com/xiaozhou26/Chromix/releases/tag/v153.0.8010.47)与[provenance](https://github.com/xiaozhou26/Chromix/releases/download/v153.0.8010.47/provenance.json)记录 Ninja 返回 0、原生产任务版本/无界面启动检查通过，**但**指纹门槛 `transport_lifecycle` 的 HTTP/2 首次连接复用失败，原始关闭原因未确定；15 套中 10 passed、4 incomplete、1 failed，`ci_gate_passed=false`、`full_acceptance=false`。它是**确实可下载、但未通过原生门槛的预发布包**；不能因为编译/启动曾成功而描述为通过验收。152.82 发行说明称 15 套重新评价无阻断、身份 10/10；同时写明物理设备、外部网络、字体栅格化绑定未证明，`full_acceptance=false`，其成功只覆盖指定 CI 配置和构建提交。

[当前 Windows 源码版本 pin](https://github.com/xiaozhou26/Chromix/blob/main/build/ungoogled-revisions.psd1)为 Chromium `153.0.8010.47`、ungoogled core `31e6f2dd3bb2f113800d25ae359f024684addb51`、Windows 平台层 `657b9731b68aae35d4ee02428684ab8bdceb9181`。[BUILDING.md](https://github.com/xiaozhou26/Chromix/blob/main/BUILDING.md) 定义分层来源及精确缓存/构建流程。逐项查阅公开 [`patches/series` @ 9922d99](https://github.com/xiaozhou26/Chromix/blob/9922d99ddde77949d97d4afbb0e2a207a4de53c6/patches/series)是 216 个补丁，而当前 152.82 Windows 实际[构建提交的 series @ 93c8511](https://github.com/xiaozhou26/Chromix/blob/93c8511ab187b97395a0a5b4160a47e7b7e412c3/patches/series)为 208 个，两个旧包各自构建提交的 series 均为 110 个（[152.75](https://github.com/xiaozhou26/Chromix/blob/0e6c7d180f45a2e925bed63167c5339fd454d067/patches/series)、[151.173](https://github.com/xiaozhou26/Chromix/blob/65cf50e9738b75907393929a926b06698823ff09/patches/series)）。这些是**源码 manifest 项数**，不是本机在 ZIP 内证实的实际代码路径数量；main 的后续内容也不能倒灌进旧 ZIP。[上游状态文件](https://github.com/xiaozhou26/Chromix/blob/main/FINGERPRINT_STATUS.md)本身将补丁/工具测试与匹配原生二进制、物理设备验收分开。

**未能由这些发行记录独立确认的来源字段：**表中的 40 位 SHA 是 **Chromix 构建仓库提交**，不是 Chromium 自身的 Git revision。上游 [构建说明](https://github.com/xiaozhou26/Chromix/blob/main/BUILDING.md)说 Chromium 源码归档由匹配 ungoogled 层选择，并在 [Windows pins](https://github.com/xiaozhou26/Chromix/blob/main/build/ungoogled-revisions.psd1)记载该层提交；本轮未取得、重算四个发行 ZIP 各自使用的 Chromium 归档摘要或 Chromium Git revision，也未独立从发布 ZIP 验证源码标记。不得把本项目的 [`782af9cb...` 锁](../browser-core/chromium/core.lock.json)或 Chromix 标签/主干提交误充作四个发行包的 Chromium revision。

源码补丁不止 JS 属性覆盖：[`0002`](https://github.com/xiaozhou26/Chromix/blob/main/patches/0002-base-uxr_config-cc.patch) 定义进程级 persona/display 快照，[`0163`](https://github.com/xiaozhou26/Chromix/blob/main/patches/0163-webgl-shared-backend-policy.patch) 为 WebGL 原生 GPU 后端设置 guard，series 还包括 Canvas/WebGL/WebGPU、音频、语言/时区、字体、存储 quota、媒体 codec、时钟与屏幕/跨 frame 传播；[`0187`](https://github.com/xiaozhou26/Chromix/blob/main/patches/0187-restricted-font-resolution-and-fallback.patch)修改已解析字体及回退，[`0139`](https://github.com/xiaozhou26/Chromix/blob/main/patches/0139-webrtc-ip-presentation.patch)明确仅重写 ICE/SDP 的呈现副本，**不改变真实 socket/STUN/TURN 路由**。[公开 flag 说明](https://github.com/xiaozhou26/Chromix/blob/main/docs/fingerprint-flags.md)进一步限定 GPU 名称不能制造实际 GPU 能力、CPU/RAM getter 不会改变调度/容量、一个 browser launch 共用不可变 persona（并非每个 Playwright BrowserContext 单独身份）；这些是**源码设计/自述的边界**，不是本次对任何 ZIP 的性能或抗检测实测。[GPU 设备矩阵](https://github.com/xiaozhou26/Chromix/blob/main/docs/gpu-backend.md)也明确不是已验收的跨 API 实体 GPU 数据集。

## 对“免本地编译替换”的判断

**仅能作为版本固定、校验和固定的独立候选供后续验收，不能直接取代本项目原生内核。** 153 x64 有 216 项源码系列的发布来源和明确 SHA，但原生验收失败、重新封装没有再次执行；152.82 是有成功 CI 来源的较稳候选，却是不同 Chromium 版本/源码提交和较旧系列，且无物理 GPU 完整验收；151.173 即使大版本为 151 也不是项目锁定的 `151.0.7922.34`。不能用“无本地编译”跳过**本项目**的精确源码/补丁来源绑定、Playwright 协议与启动适配、Windows x64 真实图形窗口及物理 GPU 下的 Canvas/WebGL/WebGPU、一致性/代理/网络路径回归。截至 **2026-09-25 的原始核查**没有触碰依赖、应用代码或任何可执行二进制；后续已接入独立实验性发行版（见下），但上述运行验收仍未知，而非声称失败或通过。[本项目源码锁](../browser-core/chromium/core.lock.json)、[上游 153 验收记录](https://github.com/xiaozhou26/Chromix/releases/download/v153.0.8010.47/provenance.json)、[上游 152.82 发行边界](https://github.com/xiaozhou26/Chromix/releases/tag/v152.0.7977.82)。

## 本项目可执行路线

现有 [`resolveVerifiedChromiumCore`](../src/browser/custom-chromium-runtime.ts)（第 8–87 行）要求 **本项目**的 `151.0.7922.34` 身份、Chromium revision `782af9cb...`、Playwright `1.62.1`、两份特定补丁的路径/哈希及 `build-provenance.json` 全文件清单，并对实际文件逐一计算 SHA-256；[`verify-windows-release.ps1`](../scripts/verify-windows-release.ps1) 也要求 `chromium/build-provenance.json`、与 lock 一致的身份及完整原生文件清单。Chromix ZIP 不是本项目要求的归档/来源格式；不能改名、伪造 provenance、放松校验或直接设置 `ABS_CHROMIUM_EXECUTABLE_PATH` 将其“接入”现有生产引擎。上述严格性由[本项目 resolver](../src/browser/custom-chromium-runtime.ts)、[Windows 验证器](../scripts/verify-windows-release.ps1)及[源码锁](../browser-core/chromium/core.lock.json)定义。

- **A：保留精确 151 路线，免本机编译但不免实际构建。** 在受信任、具备容量的远程 Windows x64 构建机上按现有 [`chromium-core-windows.yml`](../.github/workflows/chromium-core-windows.yml) 显式 `workflow_dispatch build=true`，构建锁定源码并执行本项目原生测试/打包/提取/CDP smoke；将同一提交的成功 artifact 和独立确认的 SHA-256 交给 [`windows-native-release.yml`](../.github/workflows/windows-native-release.yml)。后者要求真实 GPU 的受信任 runner，并执行安装、原生 Profile、替换后持久化 smoke；发布前还须实际收集 **Windows 物理 GPU** 窗口下 Canvas/WebGL/WebGPU 及跨 realm/网络验收证据，不能把 runner 标签本身当作测量。此路线保留现有 resolver/来源合同，不需**本机**编译，但需要真实远程构建、硬件、权限、磁盘和运行验收；本轮没有启动这些工作流。
- **B：隔离接入 `152.0.7977.82` 实验性独立发行版，不替换 151。** 新增的安装、校验和 Studio Profile 选择见下节；这不是现有严格 151 resolver 或 Windows 151 发行 verifier 的输入，不能将 Chromix ZIP 改名后作为生产原生 151 核心。`153.0.8010.47` [预发布包](https://github.com/xiaozhou26/Chromix/releases/tag/v153.0.8010.47)的 HTTP/2 门槛明确失败，**不列为产品替换候选**。

## 2026-09-26 本项目接入更新：仍待真实浏览器验收

产品目标是**指纹浏览器**，Studio 只是其控制面。[独立安装器](../scripts/install-chromix.ps1)固定下载
[官方 152.82 Windows x64 原始 ZIP](https://github.com/xiaozhou26/Chromix/releases/download/v152.0.7977.82/chromix-win-x64.zip)，
在 Windows 上要求预先存在、互不嵌套的 `-ScratchDirectory` 与 `-InstallRoot`；
固定校验 ZIP SHA-256
`1cfbe638212ba4d463a8c3330fcfbd8c88f9844ff6dfc0722f2c40745e0bc7f8`，
解压为 `<InstallRoot>\chromix\chrome.exe`，记录文件清单。
已独立下载 `214411666` 字节的 ZIP，核验摘要与 **681 个文件**的清单，未执行 `chrome.exe`；
此结果不能证明发布者身份、浏览器运行或上游 `full_acceptance=false` 的缺项已补齐。
发行包由上游单独提供，**不捆绑**于本项目仓库或 source+build 测试包；
上游字体及第三方许可须按上文各自核实，不能因添加下载器就推定有再分发许可。

[独立运行时校验器](../src/browser/chromix-runtime.ts)要求绝对
`CHROMIX_EXECUTABLE_PATH=<InstallRoot>\chromix\chrome.exe`、已安装清单及逐文件哈希；
Studio 新建 Chromium Profile 时显式选择 **Chromix 152 (experimental)**。
现有 Profile 的引擎、发行版、ID 均不可更改，Chromix 保存自己的隔离浏览器数据，
不转换 stock 或项目原生 151 的既有 Profile；配置缺失/校验失败不回退。
首次成功启动后，Chromix 保存的种子、GPU、屏幕/硬件和地理身份不接受
改变实际身份的更新；首次 GPU 探测仍由内部保存，失败的启动不提交身份。
已有浏览器目录、Cookie 或存储状态的旧 Profile 在升级后保守视为已使用，
而名称/标签/代理/扩展等非身份管理不受此约束。此序列化只覆盖同一 Studio
进程中的 ProfileStore 实例；**不支持多个独立 Studio 进程同时写同一 Profile 根目录**。
无法保证单写者时须停止第二个进程；代码没有跨进程锁，不得将此表述理解为自动拦截。
Chromix 原生 Canvas/音频扰动当前禁用以优先保证物理一致性，不意味着跨 Profile
独特性或不可检测。[README Windows 开发安装步骤](../README.md#windows-x64-chromix-152-实验性预编译浏览器)
提供可直接执行的 PowerShell 命令，不要求在本机编译 Chromium。

[验收工作流](../.github/workflows/chromix-windows-acceptance.yml)支持手动触发，
并在 `chromix-acceptance/**` 分支 push 时触发；托管 Windows runner 执行兼容性检查，
不把虚拟 GPU 输出当作指纹浏览器应用验收。原始 hosted run
[36160965923](https://github.com/chuanxu742-glitch/browser-profile-studio/actions/runs/36160965923)
的安装器 fixture 22 项通过，固定的 152.0.7977.82 ZIP 已安装并由直接 Playwright
启动；该次兼容性 job 因 first 阶段 Worker 脚本 HTTP 请求缺少
`sec-ch-ua`、`sec-ch-ua-platform`、`sec-ch-ua-mobile` 而失败。
最终 source-aligned hosted run
[36218295845](https://github.com/chuanxu742-glitch/browser-profile-studio/actions/runs/36218295845)
（提交 `0cf016b236a6fb322a586cd682e10b1104bf2b43`）通过 5 个文件、45 项 Windows
scoped unit tests、`npm run build`、已验证 ZIP 及直接 Chromix 兼容性检查。Studio 保存的
Profile 启动被 hosted 虚拟 GPU 以 HTTP 500 `GPU_ACTIVE_DEVICE_AMBIGUOUS` 拒绝；
没有活动会话或已保存 GPU 身份，结果为 `productAcceptance NOT RUN`。物理 GPU job
因硬件 runner 不可用而跳过；硬件验收仍受阻，不能据此宣称产品或物理 GPU 验收通过。

扩展覆盖的 hosted run [36219731789](https://github.com/chuanxu742-glitch/browser-profile-studio/actions/runs/36219731789)
（提交 `07ff604`）对直接 Chromix 页面、同源 iframe、Worker 及同一数据目录重启后的
UA-CH、平台、语言/时区、核心数、可用的 deviceMemory 与页面屏幕/DPR 执行跨 realm
一致性断言；Canvas 像素和页面/iframe 离线音频仅断言同一安装/档案的稳定性。
原生扰动关闭，**未验证不同 Profile 的 Canvas/音频唯一性**。托管虚拟 GPU 上
WebGL/WebGPU 只记录 API 可用性，不能证明物理后端、shader/readback 或设备身份；
外部网络/代理与 WebRTC ICE/STUN 均未运行。Studio 保存档案仍在虚拟 GPU
准入处 fail-closed，物理 GPU job 跳过，不得据此宣称产品验收通过。

### 隔离物理 GPU runner：人工验收操作卡（尚未执行）

**先决安全门槛：**GitHub [明确警告](https://docs.github.com/en/actions/reference/security/secure-use#hardening-for-self-hosted-runners)自托管 runner 不保证每次作业后是干净环境，公开仓库几乎不应使用；`isolated` 只是本工作流的**路由标签**，并非安全沙箱。仅在管理员确认仓库/受控私有副本及其可运行工作流的人员可信、专用 Windows x64 物理 GPU 主机无用户资料/密钥/内网敏感服务、主机具备可恢复的隔离与清理机制后注册。不能把个人日常工作站或承载其他仓库作业的共享 runner 直接贴上标签；不要以关闭 Defender、防火墙、浏览器沙箱或扩大 `GITHUB_TOKEN` 权限换取通过。主机需要可用的显卡驱动、脚本用于同机 Worker 请求基线的 Microsoft Edge、可以访问物理 GPU 的 runner 运行环境，以及下载 GitHub Actions/npm/固定上游 Chromix ZIP 所必需的网络；工作流 `setup-node` 安装 Node.js 22。外部下载有供应链和网络风险，ZIP 哈希并非发布者签名。

1. 管理员在目标仓库 **Settings → Actions → Runners → New self-hosted runner** 选择 **Windows / x64**，只在受控主机上依照 GitHub 页面当时生成的[下载、解包、`config.cmd` 注册和启动命令](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/add-runners#adding-a-self-hosted-runner-to-a-repository)操作；注册令牌有时效，**不复制进仓库、日志或本文**。Windows 服务安装需管理员 shell，但须先确认 runner 实际运行环境能访问物理 GPU；不可假定服务所在非交互会话满足这一条件。注册后在 Runners 页面确认在线、空闲。
2. 为这台专用机器添加自定义标签 `studio-gpu` 和 `isolated`，核对默认 `self-hosted`、`Windows`、`X64` 标签均存在；[全部标签必须同时匹配](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/use-in-a-workflow#using-custom-labels-to-route-jobs)。检查当前工作流的 `runs-on: [self-hosted, Windows, X64, studio-gpu, isolated]`，勿把这些标签加给没有物理 GPU 或未隔离的机器。仅授权必要仓库使用该 runner；标签不能代替主机与仓库访问控制。
3. **没有符合条件且已在线的 runner 时，不派发 `run_physical_gpu=true`，也不要为使作业启动而给不合格机器贴标签。** 可以只运行默认 `false` 的托管兼容性检查；GPU 验收记为 `NOT RUN`，不要把排队等待或跳过当成通过。具备前述 runner 后，经审查将包含应用接入、脚本和 [验收工作流](../.github/workflows/chromix-windows-acceptance.yml) 的**同一提交**推送至可信分支。GitHub [手动触发规则](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow#configuring-a-workflow-to-run-manually)要求 workflow 文件也存在于默认分支；若尚不满足，先通过正常审查将工作流加入默认分支，不能只凭本地未提交文件派发。进入 **Actions → Chromix 152 Windows x64 compatibility and gated acceptance → Run workflow**，选中含上述接入提交的分支，把 `run_physical_gpu` 设为 `true` 再运行；或者在满足默认分支前置条件后使用 `gh workflow run chromix-windows-acceptance.yml --ref <受信任分支> -f run_physical_gpu=true`。`chromix-acceptance/**` 的普通 push 只运行托管兼容性 job，**不会**触发 GPU job。
4. 查看同一 run 的 `hosted-compatibility` **和** `isolated-physical-gpu-acceptance` 结论与 Step Summary；后者必须实际运行且 JSON `result` 为 `passed`，不能把 skipped/queued/hosted-only 算通过。该 job 从可信工作树安装依赖、构建应用，在 `RUNNER_TEMP` 校验安装固定 ZIP，以 Studio 保存的 Profile 启动并测试本地网络/realm、重启后的 Cookie/localStorage 与跨 Profile 隔离及 GPU 后端准入；失败时保留 run URL/非敏感证据，排查 runner 会话及实际 GPU，而非放宽安全/断言。作业结束检查并清理临时工作区/浏览器 Profile，确认无敏感测试数据残留后再复用机器。

即使上述严格本地验收通过，也**不**证明真实公共网络/代理出口、WebRTC 外部 STUN、跨设备物理 shader/Canvas/WebGL/WebGPU 一致性、上游 `full_acceptance` 或产品可投入生产；这些需另行在获授权环境实测、记录实际证据。
