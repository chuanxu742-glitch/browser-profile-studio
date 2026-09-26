# Chromium 原生内核

状态：固定 Chromium 151 源码与两枚 `--abs-*` 补丁的 Linux、Windows x64 准备/构建/打包入口已实现；**尚无本仓 Windows 原生二进制编译或实机运行通过的证据**。源码校验和模拟目录的打包测试不等于 C++ 编译通过。常规启动仍使用 Playwright 管理的 Chromium；仅显式配置并通过来源校验的自编译可执行文件才启用此内核。

源码固定为 Chromium `151.0.7922.34` / `782af9cb30a53f54487e5d2e44738645a8ec457c`，与本项目 Playwright `1.62.1` 的浏览器版本一致。源码、depot_tools 和补丁哈希见 [core.lock.json](core.lock.json)。

## 本次原生修改

参考 [Chromix e540796](https://github.com/xiaozhou26/Chromix/tree/e540796decd489e8e9dff8dea940eb03e77db693) 的语言、时区和 Worker 原生配置路径，采用适合本项目“一实例一 Profile”的启动时配置：

| 参数 | 修改位置与预期行为 |
| --- | --- |
| `--abs-languages=fr-FR,fr` | Blink `NavigatorLanguage` 共用实现，覆盖 Window 与 Worker 的语言列表；保留显式 CDP 语言覆盖的优先级 |
| `--abs-locale=fr-FR` | Renderer 初始化 Blink 前设置 ICU 默认 locale，避免在 Worker 的 navigator getter 中修改进程全局 ICU 状态 |
| `--abs-timezone=Europe/Paris` | `TimeZoneController` 初始化基准时区，宿主时区通知不覆盖它；CDP 时区覆盖清除后恢复该基准 |
| `--abs-hardware-concurrency=3` | `NavigatorConcurrentHardware` 共用原生 getter，整数范围 1–256，不修改真实线程调度或物理核心数 |
| `--abs-device-memory=4` | Blink common 的单一进程级桶供 Window/Worker getter 与浏览器生成的 `Sec-CH-Device-Memory`、旧版 `Device-Memory` 请求头共用；只接受 0.25、0.5、1、2、4、8，不将错误输入四舍五入 |
| `--abs-canvas-seed=0` | 共用像素变换用于 getImageData、toDataURL、toBlob 和 OffscreenCanvas.convertToBlob；绝对坐标、RGBA/BGRA 顺序、行跨度一致，导出时只改私有副本 |
| `--abs-audio-seed=0` | 离线渲染完成、事件和 Promise 暴露之前变换一次；Analyser 的 byte/float 输出共用变换，保留静音、特殊浮点值和应用自己创建的可写 Buffer |
| `--abs-webgl-vendor` / `--abs-webgl-renderer` | WebGL1/2 共用原生查询路径，保留 debug extension 权限与错误处理；真实 limits、extensions、shader precision 不被虚构数值覆盖 |
| `--abs-webgpu-{vendor,architecture,device,description}` | 修改原生 GPUAdapterInfo 的身份字段，保留实际 adapter/device 可用性、fallback 属性和 limits |
| `--abs-webgpu-disabled=1` | requestAdapter 原生返回 null；不把 API 是否存在与设备是否可用混为一谈 |
| `--abs-font-allowlist` | 字体缓存查找前限制原生 family 和 local() 请求；保留通用字体、下载字体与缺字 fallback，不捆绑未授权商业字体 |

浏览器进程向所有 Renderer 传递这些参数，包括跨站 iframe 与 Worker 使用的进程。无参数时保留上游行为。语言列表明确配置时不缩减到首项。HTTP 语言头沿用 Chromium 的 `--accept-lang` 和现有 CDP 设置；设备内存 Client Hint 仅在 Chromium 原有的安全上下文、服务端 `Accept-CH` 和权限策略允许发送时采用上述共同值，不增加头的发送范围，也不修改 TLS、代理或其它请求指纹。

配置是**进程级且启动后固定**，不是每个 BrowserContext 一份；不同原生身份要启动不同浏览器实例。启动器会为受管指纹脚本选择原生模式，页面、iframe 和 Worker 不再叠加上述表面的 JS 覆盖，Studio 后续注册脚本也保持同一模式。调用方自己的 initScript 保留原样；屏幕、UA、WebRTC 等已有兼容逻辑仍沿用现有路径。

Canvas 变换针对 8 位 RGB 不透明像素，保留 alpha、半透明像素、HDR/float16、精确黑白通道；重复处理同一内容不会累积扰动。这里提供的是读取/导出层的像素策略，不改变实际 GPU 渲染器，也不宣称覆盖 WebGL PBO、WebGPU buffer 等所有读回途径。Audio 只改低两位有效尾数，保留其余浮点位；离线输出和实时分析采用不同的接入点，避免读 getter 时修改仍在渲染的缓冲区。

字体默认不限制（Linux 和 Windows 均如此）。只有 Profile 显式指定 `fontPolicy.allowlist` 或设置 `ABS_CHROMIUM_FONT_ALLOWLIST` 才传 `--abs-font-allowlist`，环境变量优先；所选字体仍必须实际安装。此策略限制显式字体查找，不模拟另一套字体字形，也不关闭本地字体访问 API 的权限流程。

## 本地轻量验证

```sh
python browser-core/chromium/core.py check
python -m unittest discover -s browser-core/chromium -p 'test_*.py'
node --check browser-core/chromium/smoke.mjs
node --check browser-core/chromium/rendering-probe.mjs
```

`check` 只下载锁文件列出的修改点上游文件，验证 SHA-256 后按顺序应用两枚补丁；新 helper 和 C++ 测试文件由补丁提供，不下载完整 Chromium。它不能证明 C++ 编译通过。

编译后，`smoke.mjs` 通过原始浏览器进程和 Playwright CDP 连接读取主页面、跨站 iframe、Dedicated/Shared/Service Worker 的原生值，不设置 context locale/timezone，也不注入兼容脚本。它还用本机 HTTP 服务的 `Accept-CH` 协商检验两种设备内存请求头与各 realm 一致。扩展的 `rendering-probe.mjs` 检查 Canvas 多条读取/PNG 导出路径、子矩形、透明像素、Audio 重复读取/事件/Promise/copyFromChannel、字体查找以及可用 GPU 的原始身份、limits 与错误语义。两份 seed 的输出必须不同；测试不注入虚构 GPU 厂商/型号，比较两份身份下真实 GPU 信息是否稳定。没有 GPU backend 时会在报告中明确标记跳过，不能将其计为 GPU 通过；实际适配器匹配仍须另行核验。Windows 原生构建/运行仍待有资质的构建机执行。

补丁内还加入了 `AbsProfileTest.*` 原生单元测试，覆盖 seed=0、非法 seed、音频幂等/有限扰动/特殊浮点值，以及像素坐标、字节顺序、alpha、padding 和副本所有权。这些 C++ 测试源码已加入 GN，留待日后编译执行。

### 原生覆盖边界

本补丁没有原生语音列表或屏幕几何模拟：`speechSynthesis.getVoices()` 受系统安装语音、异步枚举和语音服务影响；`screen`、`window` 尺寸及 CSS 媒体查询同时受显示设备与窗口/视口状态影响，单独改 JS getter 不能构成一致的显示器模拟。已有启动器/Playwright 层行为不等于原生覆盖，需在实际 Windows 构建上分别核验；无新增语音或屏幕 flag。WebGL/WebGPU 字符串修改不更换物理 GPU、驱动、功能集或 Widevine/CDM；只有主机实测适配器与所选身份相符时才可宣称 GPU 身份一致。未覆盖所有 Canvas/WebGPU 读取路径、WebRTC/媒体设备、TLS/HTTP2、扩展或安全限制，更不改变 Chromium 151 为 Chrome 153。静态补丁应用与源码单测不能替代 Windows C++ 编译及原生浏览器/CDP+HTTP 实测。

## GitHub 编译

以下为保留的未来构建入口，本轮未触发。

[工作流](../../.github/workflows/chromium-core.yml) 在 push/PR 上只运行轻量检查。手动打开 GitHub Actions → `chromium-core` → Run workflow，将 `build` 设为 true 才开始完整编译。

- 默认 Runner 标签为 `["self-hosted", "linux", "x64", "chromium-build"]`，需要先注册 Linux 构建机；它可以是云服务器，不需要使用本地电脑。也可填组织已开通的 GitHub larger runner 标签 JSON。
- 建议 16 核、64 GiB 内存、至少 300 GiB 磁盘；首次同步前脚本要求至少 150 GiB 空闲。默认 16 个编译任务，可在工作流调整。
- 需要 Git、Python 3.11+、无交互 sudo；若勾选 Docker 打包还需要 Docker Engine 和 Compose。Runner 应专供可信构建使用。
- Repository variable `CHROMIUM_WORKSPACE` 可指向持久目录，例如 `/opt/abs-chromium-151`；重复构建复用源码、工具和增量编译结果。锁版本变化时选新目录，不覆盖未知修改。
- 普通 GitHub hosted runner 磁盘不适合此任务。GitHub hosted（包括 larger）单 job 最长 6 小时；self-hosted 最长 5 天，本工作流设置 24 小时。参见 [GitHub 限制](https://docs.github.com/en/actions/reference/limits) 和 [Chromium Linux 构建文档](https://chromium.googlesource.com/chromium/src/+/main/docs/linux/build_instructions.md)。

工作流依次同步固定源码、应用补丁、安装系统依赖、编译并执行 `AbsProfileTest.*`、打包运行依赖，再对解压出来的包执行原生测试。**只有原生测试通过才上传内核包**，包含来源信息、可执行文件和全部打包文件的哈希及许可证。哈希用于一致性校验，不等同于发行者数字签名。

启用 Docker 打包时，还会构建现有 CDP 基础镜像，再装入自编译内核，测试认证、页面交互、截图、重连和重启后的 Cookie 持久化，成功后导出单独的 `abs-chromium-cdp-docker.tar.gz`。不自动发布 Release 或推送镜像仓库。

## Linux 手动构建和接入

```sh
python3 browser-core/chromium/core.py prepare --workspace /opt/abs-chromium-151
sudo /opt/abs-chromium-151/src/build/install-build-deps.sh --no-prompt
python3 browser-core/chromium/core.py build --workspace /opt/abs-chromium-151 --jobs 16
python3 browser-core/chromium/core.py package --workspace /opt/abs-chromium-151 --output artifacts/native-core
mkdir -p native-core
tar -xzf artifacts/native-core/abs-chromium-151.0.7922.34-linux-x64.tar.gz -C native-core
ABS_CHROMIUM_EXECUTABLE_PATH="$PWD/native-core/chromium/chrome" node browser-core/chromium/smoke.mjs
```

启动器在设置 `ABS_CHROMIUM_EXECUTABLE_PATH` 后检查同目录 `build-provenance.json` 的版本、源码提交、两个补丁的顺序与哈希及实际可执行文件哈希；旧的单补丁内核或其他不匹配内核会被拒绝。不要只复制一个 chrome 文件，保留完整运行目录。

```sh
docker build -f Dockerfile.cdp -t antigravity-cdp:local .
export CDP_TOKEN='replace-with-your-random-token-at-least-24-characters'
docker compose -f docker-compose.cdp.yml -f docker-compose.chromium-cdp.yml up -d --build
```

或者下载已通过工作流测试的 Docker artifact，在 Linux/Docker Desktop 上执行：

```sh
sha256sum -c abs-chromium-cdp-docker.tar.gz.sha256
docker load -i abs-chromium-cdp-docker.tar.gz
docker run -d --init --name native-cdp --shm-size=2g \
  -p 127.0.0.1:9222:9222 -e CDP_TOKEN \
  -v native-cdp-profile:/data/profile antigravity-browser-native-cdp:0.1.0
```

客户端示例：

```js
import { chromium } from 'playwright';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222', {
  headers: { Authorization: `Bearer ${process.env.CDP_TOKEN}` },
  noDefaults: true,
});
const page = await browser.contexts()[0].newPage();
await page.goto('https://example.com');
```

## Windows x64 手动构建及 CI 验收

采用与 Linux 相同的 `core.lock.json`、两枚本仓补丁和 `args.gn`；不使用 Chromix 152 或下载的预编译 Chromium 代替本仓编译。遵循[锁定版本 Chromium 官方 Windows 指南](https://chromium.googlesource.com/chromium/src/+/782af9cb30a53f54487e5d2e44738645a8ec457c/docs/windows_build_instructions.md)：Windows 10+ x64、NTFS 无空格的短工作目录、Git、Python 3.11+、Visual Studio 2026 Desktop development with C++ 和 MFC/ATL、Windows SDK 10.0.26100.7705 及 SDK Debugging Tools >=10.0.26100.3323。源码同步前脚本要求至少 150 GiB 空闲；建议专用 16 核/64 GiB RAM、300 GiB 以上磁盘。`depot_tools` 由脚本获取并固定到锁定提交，在 PATH 首位运行；脚本设置 `DEPOT_TOOLS_WIN_TOOLCHAIN=0` 使用本机安装的 Visual Studio。必要时在构建机配置 `vs2026_install` 指向实际安装位置。不要把 Linux/WSL 和 Windows 工作区或 depot_tools 目录混用。
首次 Windows `prepare` 会在锁定 `depot_tools` 提交上单独运行 `bootstrap/win_tools.bat`，安装该提交的 CIPD Python 并生成 `python3_bin_reldir.txt`；`DEPOT_TOOLS_UPDATE=0` 不会更新工具仓库。`build`/`package` 会再次检查 bootstrap 完整性。

从已具备上述依赖的 **cmd.exe** 运行（下面为示例目录，需实际有足够空闲空间；首次同步可能耗时数小时）：

```bat
python browser-core\\chromium\\core.py prepare --workspace D:\\abs-chromium-151
python browser-core\\chromium\\core.py build --workspace D:\\abs-chromium-151 --jobs 16
python browser-core\\chromium\\core.py package --workspace D:\\abs-chromium-151 --output artifacts\\native-core
```

`build` 在 `gclient runhooks` 后使用 GN/autoninja 构建 `chrome` 和 `blink_platform_unittests` 并运行 `AbsProfileTest.*`。`package` 从 GN `runtime_deps` 复制 Windows 运行文件（如 DLL、pak、locales），另附上游和参考补丁许可、第三方 credits；缺失依赖会报错而非打包不完整目录。输出为 `artifacts/native-core/abs-chromium-151.0.7922.34-win-x64.zip` 与同名 `.zip.sha256`。解压根目录是 `chromium/chrome.exe`，同目录有 `build-provenance.json`；清单记录 `target=win-x64`、版本、源码/补丁哈希、可执行文件和包内文件的 SHA-256。自陈的哈希是完整性校验，不是签名或独立的构建者证明；不能从人工编写相同字段断言实际源码来源。

在独立且仅运行可信代码的 self-hosted Windows x64 runner 注册 `self-hosted`、`Windows`、`X64`、`chromium-build` 标签；将 repository variable `CHROMIUM_WINDOWS_WORKSPACE` 配为真实充足磁盘上的短 NTFS 路径（不配置时默认 `C:\src\abs-chromium-151`）。在 Actions → `chromium-core-windows` → Run workflow 中设置 `build=true`、对应 runner 标签 JSON、并行 jobs；PR/push 仅运行轻量校验，不会自动耗费编译机。远程任务在同步源码前检查 x64、NTFS、150 GiB 空闲、Visual Studio 2026 C++/MFC/ATL、Windows SDK 26100 目录和 Debugging Tools 版本；**SDK 10.0.26100.7705 的 servicing revision 仍须构建机管理员核实，不能只凭目录名判断**。runner 授权、注册凭据和 Visual Studio/SDK 安装须由管理员完成，不写入仓库；避免将不可信 PR 代码授权给长期有特权的构建机。完整编译、包解压后 SHA 校验及 `node browser-core/chromium/smoke.mjs` 原生 CDP 测试成功后，工作流才上传 `chromium-win-x64-<commit>` Actions artifact（ZIP、侧车摘要与 `native-smoke.json`，保留 7 天）。2026-09-26 查询本仓 GitHub Actions 显示 **零个注册的 self-hosted runner**，远端工作流列表也尚无 `chromium-core-windows`（当前工作流文件尚未发布到远端）；必须先由授权者提交/发布当前源码和工作流、配置独立构建机，才可能手动触发实际构建。本轮没有执行 Windows Chromium 编译或实机原生验收，不能称作 Windows native 通过。

本地提取后验证并以 `ABS_CHROMIUM_EXECUTABLE_PATH=<绝对路径>\\chromium\\chrome.exe` 运行；启动器只接受当前 win32 x64 对应 `win-x64` 的完整清单（Linux x64 对应 `linux-x64`），校验固定版本/补丁、清单中全部文件的 SHA-256 和目录中没有未列出的代码/资源（Windows 必须包含 `chrome.dll`），禁止拿 stock 浏览器或其它平台包冒充原生内核。Windows 下可在 PowerShell 中执行：

```powershell
$env:ABS_CHROMIUM_EXECUTABLE_PATH = (Resolve-Path '.\\artifacts\\native-core\\extracted\\chromium\\chrome.exe').Path
node browser-core/chromium/smoke.mjs
```

## 来源与许可

补丁参考 Chromix 的 `0007`、`0015`、`0017`、`0019`、`0020`、`0026`–`0031`、`0047` 等修改位置，重新适配本项目锁定的上游 Chromium 版本。音频改为渲染完成时接入，Canvas 补齐异步导出与软件图像副本；没有引入其整套 UxrConfig、ungoogled 补丁链、V8/CDP 行为修改或 Windows GPU 配置池。保留 [Chromix BSD 3-Clause 许可](CHROMIX-LICENSE)，上游代码继续适用 Chromium 及各组件原有许可。构建包同时携带上游 LICENSE 和生成的第三方 credits。
