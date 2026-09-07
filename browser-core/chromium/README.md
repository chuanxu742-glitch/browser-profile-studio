# Chromium 原生内核（首批补丁）

状态：源码补丁已实现，精确源码校验和应用检查通过；**尚未完成 Chromium C++ 编译、原生二进制验收或 Docker 镜像构建**。常规启动仍使用 Playwright 管理的 Chromium；只有显式配置自编译路径才启用新内核。

源码固定为 Chromium `151.0.7922.34` / `782af9cb30a53f54487e5d2e44738645a8ec457c`，与本项目 Playwright `1.62.1` 的浏览器版本一致。源码、depot_tools 和补丁哈希见 [core.lock.json](core.lock.json)。

## 本次原生修改

参考 [Chromix e540796](https://github.com/xiaozhou26/Chromix/tree/e540796decd489e8e9dff8dea940eb03e77db693) 的语言、时区和 Worker 原生配置路径，采用适合本项目“一实例一 Profile”的启动时配置：

| 参数 | 修改位置与预期行为 |
| --- | --- |
| `--abs-languages=fr-FR,fr` | Blink `NavigatorLanguage` 共用实现，覆盖 Window 与 Worker 的语言列表；保留显式 CDP 语言覆盖的优先级 |
| `--abs-locale=fr-FR` | Renderer 初始化 Blink 前设置 ICU 默认 locale，避免在 Worker 的 navigator getter 中修改进程全局 ICU 状态 |
| `--abs-timezone=Europe/Paris` | `TimeZoneController` 初始化基准时区，宿主时区通知不覆盖它；CDP 时区覆盖清除后恢复该基准 |
| `--abs-hardware-concurrency=3` | `NavigatorConcurrentHardware` 共用原生 getter，整数范围 1–256，不修改真实线程调度或物理核心数 |

浏览器进程向所有 Renderer 传递这四个参数，包括跨站 iframe 与 Worker 使用的进程。无参数时保留上游行为。语言列表明确配置时不缩减到首项。HTTP 请求头沿用 Chromium 的 `--accept-lang` 和现有 CDP 设置，不伪称为新增网络内核补丁。

配置是**进程级且启动后固定**，不是每个 BrowserContext 一份；不同原生身份要启动不同浏览器实例。现有 JS/CDP 的其他兼容配置仍保留。Canvas、Audio、字体、WebGL/WebGPU、设备内存尚未迁移到本内核补丁，不能宣称与 Chromix 的原生覆盖持平。

## 本地轻量验证

```sh
python browser-core/chromium/core.py check
python -m unittest discover -s browser-core/chromium -p 'test_*.py'
node --check browser-core/chromium/smoke.mjs
```

`check` 只下载 5 个修改点的上游文件，验证 SHA-256 后执行 `git apply --check` 和应用，不下载完整 Chromium。它不能证明 C++ 编译通过。

`smoke.mjs` 通过原始浏览器进程和 Playwright CDP 连接读取主页面、跨站 iframe、Dedicated/Shared/Service Worker 的原生值，不设置 context locale/timezone，也不注入兼容脚本。它测试两份地域配置、冬夏时差、原生 getter、请求头和 CDP 时区恢复。本机用未修改 Chromium 运行时已确认会因核心数、语言、时区不符合配置而失败；这仅验证验收脚本能发现缺失的内核能力。

## GitHub 编译

[工作流](../../.github/workflows/chromium-core.yml) 在 push/PR 上只运行轻量检查。手动打开 GitHub Actions → `chromium-core` → Run workflow，将 `build` 设为 true 才开始完整编译。

- 默认 Runner 标签为 `["self-hosted", "linux", "x64", "chromium-build"]`，需要先注册 Linux 构建机；它可以是云服务器，不需要使用本地电脑。也可填组织已开通的 GitHub larger runner 标签 JSON。
- 建议 16 核、64 GiB 内存、至少 300 GiB 磁盘；首次同步前脚本要求至少 150 GiB 空闲。默认 16 个编译任务，可在工作流调整。
- 需要 Git、Python 3.11+、无交互 sudo；若勾选 Docker 打包还需要 Docker Engine 和 Compose。Runner 应专供可信构建使用。
- Repository variable `CHROMIUM_WORKSPACE` 可指向持久目录，例如 `/opt/abs-chromium-151`；重复构建复用源码、工具和增量编译结果。锁版本变化时选新目录，不覆盖未知修改。
- 普通 GitHub hosted runner 磁盘不适合此任务。GitHub hosted（包括 larger）单 job 最长 6 小时；self-hosted 最长 5 天，本工作流设置 24 小时。参见 [GitHub 限制](https://docs.github.com/en/actions/reference/limits) 和 [Chromium Linux 构建文档](https://chromium.googlesource.com/chromium/src/+/main/docs/linux/build_instructions.md)。

工作流依次同步固定源码、应用补丁、安装系统依赖、编译、打包运行依赖，再对解压出来的包执行原生测试。**只有原生测试通过才上传内核包**，包含来源信息、可执行文件和全部打包文件的哈希及许可证。哈希用于一致性校验，不等同于发行者数字签名。

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

启动器在设置 `ABS_CHROMIUM_EXECUTABLE_PATH` 后检查同目录 `build-provenance.json` 的版本、源码提交、补丁哈希及实际可执行文件哈希；不匹配就拒绝启动。不要只复制一个 chrome 文件，保留完整运行目录。

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

补丁参考 Chromix 的 `0007`、`0017`、`0019` 等修改位置，重新适配本项目锁定的上游 Chromium 版本；没有引入其整套 UxrConfig、ungoogled 补丁链或 Windows GPU 配置池。保留 [Chromix BSD 3-Clause 许可](CHROMIX-LICENSE)，上游代码继续适用 Chromium 及各组件原有许可。构建包同时携带上游 LICENSE 和生成的第三方 credits。
