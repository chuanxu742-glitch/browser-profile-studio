# Chromium 原生内核

状态：此前约定的语言、时区、硬件以及剩余六类渲染表面已完成源码实现与启动器接入。**按用户要求，本轮只做源码校验、静态检查和轻量单元测试，不执行 Chromium 编译、原生二进制运行或 Docker 构建。** 常规启动仍使用 Playwright 管理的 Chromium；只有显式配置自编译路径才启用新内核。源码检查通过不代表 C++ 已编译或行为已经过原生运行验证。

源码固定为 Chromium `151.0.7922.34` / `782af9cb30a53f54487e5d2e44738645a8ec457c`，与本项目 Playwright `1.62.1` 的浏览器版本一致。源码、depot_tools 和补丁哈希见 [core.lock.json](core.lock.json)。

## 本次原生修改

参考 [Chromix e540796](https://github.com/xiaozhou26/Chromix/tree/e540796decd489e8e9dff8dea940eb03e77db693) 的语言、时区和 Worker 原生配置路径，采用适合本项目“一实例一 Profile”的启动时配置：

| 参数 | 修改位置与预期行为 |
| --- | --- |
| `--abs-languages=fr-FR,fr` | Blink `NavigatorLanguage` 共用实现，覆盖 Window 与 Worker 的语言列表；保留显式 CDP 语言覆盖的优先级 |
| `--abs-locale=fr-FR` | Renderer 初始化 Blink 前设置 ICU 默认 locale，避免在 Worker 的 navigator getter 中修改进程全局 ICU 状态 |
| `--abs-timezone=Europe/Paris` | `TimeZoneController` 初始化基准时区，宿主时区通知不覆盖它；CDP 时区覆盖清除后恢复该基准 |
| `--abs-hardware-concurrency=3` | `NavigatorConcurrentHardware` 共用原生 getter，整数范围 1–256，不修改真实线程调度或物理核心数 |
| `--abs-device-memory=4` | Window/Worker 共用的 `NavigatorDeviceMemory`；精确接受配置桶，不将错误输入四舍五入成另一种配置 |
| `--abs-canvas-seed=0` | 共用像素变换用于 getImageData、toDataURL、toBlob 和 OffscreenCanvas.convertToBlob；绝对坐标、RGBA/BGRA 顺序、行跨度一致，导出时只改私有副本 |
| `--abs-audio-seed=0` | 离线渲染完成、事件和 Promise 暴露之前变换一次；Analyser 的 byte/float 输出共用变换，保留静音、特殊浮点值和应用自己创建的可写 Buffer |
| `--abs-webgl-vendor` / `--abs-webgl-renderer` | WebGL1/2 共用原生查询路径，保留 debug extension 权限与错误处理；真实 limits、extensions、shader precision 不被虚构数值覆盖 |
| `--abs-webgpu-{vendor,architecture,device,description}` | 修改原生 GPUAdapterInfo 的身份字段，保留实际 adapter/device 可用性、fallback 属性和 limits |
| `--abs-webgpu-disabled=1` | requestAdapter 原生返回 null；不把 API 是否存在与设备是否可用混为一谈 |
| `--abs-font-allowlist` | 字体缓存查找前限制原生 family 和 local() 请求；保留通用字体、下载字体与缺字 fallback，不捆绑未授权商业字体 |

浏览器进程向所有 Renderer 传递这些参数，包括跨站 iframe 与 Worker 使用的进程。无参数时保留上游行为。语言列表明确配置时不缩减到首项。HTTP 请求头沿用 Chromium 的 `--accept-lang` 和现有 CDP 设置，不伪称为新增网络内核补丁。

配置是**进程级且启动后固定**，不是每个 BrowserContext 一份；不同原生身份要启动不同浏览器实例。启动器会为受管指纹脚本选择原生模式，页面、iframe 和 Worker 不再叠加上述表面的 JS 覆盖，Studio 后续注册脚本也保持同一模式。调用方自己的 initScript 保留原样；屏幕、UA、WebRTC 等已有兼容逻辑仍沿用现有路径。

Canvas 变换针对 8 位 RGB 不透明像素，保留 alpha、半透明像素、HDR/float16、精确黑白通道；重复处理同一内容不会累积扰动。这里提供的是读取/导出层的像素策略，不改变实际 GPU 渲染器，也不宣称覆盖 WebGL PBO、WebGPU buffer 等所有读回途径。Audio 只改低两位有效尾数，保留其余浮点位；离线输出和实时分析采用不同的接入点，避免读 getter 时修改仍在渲染的缓冲区。

Linux 启动器默认字体列表是 `Liberation Sans,Liberation Serif,Liberation Mono,Noto Color Emoji`。可通过环境变量 `ABS_CHROMIUM_FONT_ALLOWLIST` 设置逗号分隔的 ASCII 字体 family/face 名；这些字体仍必须实际安装。这个策略限制显式字体查找，不模拟另一套字体字形，也不关闭本地字体访问 API 的权限流程。

## 本地轻量验证

```sh
python browser-core/chromium/core.py check
python -m unittest discover -s browser-core/chromium -p 'test_*.py'
node --check browser-core/chromium/smoke.mjs
node --check browser-core/chromium/rendering-probe.mjs
```

`check` 只下载 16 个修改点的上游文件，验证 SHA-256 后按顺序应用两个补丁；新 helper 和 C++ 测试文件由补丁提供，不下载完整 Chromium。它不能证明 C++ 编译通过。

日后编译后，`smoke.mjs` 通过原始浏览器进程和 Playwright CDP 连接读取主页面、跨站 iframe、Dedicated/Shared/Service Worker 的原生值，不设置 context locale/timezone，也不注入兼容脚本。扩展的 `rendering-probe.mjs` 检查 Canvas 多条读取/PNG 导出路径、子矩形、透明像素、Audio 重复读取/事件/Promise/copyFromChannel、字体查找以及可用 GPU 的身份和错误语义。两份 seed 的输出必须不同，真实 GPU limits 不随身份改变；没有 GPU backend 时会在报告中明确标记跳过，不能将其计为 GPU 通过。本轮未执行这些需要新内核的测试。

补丁内还加入了 `AbsProfileTest.*` 原生单元测试，覆盖 seed=0、非法 seed、音频幂等/有限扰动/特殊浮点值，以及像素坐标、字节顺序、alpha、padding 和副本所有权。这些 C++ 测试源码已加入 GN，留待日后编译执行。

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

## 来源与许可

补丁参考 Chromix 的 `0007`、`0015`、`0017`、`0019`、`0020`、`0026`–`0031`、`0047` 等修改位置，重新适配本项目锁定的上游 Chromium 版本。音频改为渲染完成时接入，Canvas 补齐异步导出与软件图像副本；没有引入其整套 UxrConfig、ungoogled 补丁链、V8/CDP 行为修改或 Windows GPU 配置池。保留 [Chromix BSD 3-Clause 许可](CHROMIX-LICENSE)，上游代码继续适用 Chromium 及各组件原有许可。构建包同时携带上游 LICENSE 和生成的第三方 credits。
