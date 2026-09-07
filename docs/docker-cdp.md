# Docker Chromium CDP 服务

此模式直接提供浏览器级 CDP，供可信 Playwright 客户端连接；与原 MCP 服务是独立入口。一个容器对应一份持久 Profile，客户端复用 `browser.contexts()[0]`。不要用 `browser.newContext()` 代替创建新的持久环境。

## 构建与启动

需要运行中的 Docker Linux engine，首版目标 Linux amd64。包中包含项目源码及锁定依赖清单，首次构建需要访问 npm、Debian 和 Playwright 下载源。

```powershell
# PowerShell；保留此 token 供客户端使用，不要提交到 Git。
$env:CDP_TOKEN = node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
docker compose -f docker-compose.cdp.yml up -d --build
docker compose -f docker-compose.cdp.yml ps
node scripts/smoke-cdp.mjs
```

```sh
# Linux shell
export CDP_TOKEN="$(openssl rand -hex 32)"
docker compose -f docker-compose.cdp.yml up -d --build
node scripts/smoke-cdp.mjs
```

运行示例和 smoke 脚本前在项目根目录执行 `npm ci`。服务端已包含浏览器；连接客户端无需安装浏览器。

`GET /health` 是不含配置或凭据的健康状态。`GET /json/version` 和 WebSocket `/cdp` 需要 `Authorization: Bearer <CDP_TOKEN>`。Compose 默认只发布到宿主机 `127.0.0.1:9222`。同一 Docker 网络中的客户端使用 `http://browser:9222`。发现接口按连接时的 Host 生成可达 WebSocket 地址，不返回浏览器内部端口。

## Playwright 接入

建议 Node 客户端使用项目锁定的 Playwright 1.62.1；Python 安装兼容版本的 playwright 包。

```javascript
import { chromium } from 'playwright';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222', {
  headers: { Authorization: `Bearer ${process.env.CDP_TOKEN}` },
  noDefaults: true,
});
const context = browser.contexts()[0];
const page = await context.newPage();
await page.goto('https://example.com');
console.log(await page.title());
await browser.close(); // 断开客户端，服务端继续持有浏览器。
```

完整示例：`examples/cdp-connect.mjs` 与 `examples/cdp-connect.py`。`CDP_URL` 设置连接地址，`TARGET_URL` 设置示例打开的地址。CDP 并非 Playwright 自有连接协议，下载、trace 等高级能力应按实际客户端版本另行验证。

## 配置与持久化

| 变量 | 默认/说明 |
| --- | --- |
| CDP_TOKEN | 网络监听必填，至少 24 字符；不要写入镜像 |
| CDP_HOST / CDP_PORT | 本地入口默认 127.0.0.1:9222；镜像监听 0.0.0.0:9222 |
| CDP_PROFILE_DIR | 镜像为 /data/profile，挂载命名卷 |
| CDP_SEED | 首次启动随机生成并保存在 cdp-profile.json；可在服务环境显式指定 uint32 |
| CDP_OS | 镜像固定 linux；本地默认当前操作系统 |
| CDP_COUNTRY / CDP_LOCALE / CDP_TIMEZONE | Compose 默认 US / en-US / America/New_York；手动设置为一组一致值 |
| CDP_WIDTH / CDP_HEIGHT | 1280 / 800 |
| CDP_PROXY | 可选代理 URL；不写入 profile 元数据，不自动做 GeoIP 推断 |
| CDP_PUBLIC_URL | 可选 HTTP(S) origin；经过 TLS 反向代理时可设为外部 origin，使 discovery 返回 wss 地址 |

服务重启会加载相同 seed 和配置。改变已有 Profile 的 seed、OS、语言、时区或视口会拒绝启动（`CDP_PROFILE_CONFIG_CONFLICT`），避免悄然改变现有身份。创建另一组环境应使用另一卷/实例。内核版本变更返回 `CDP_PROFILE_VERSION_MISMATCH`，需要显式规划迁移或创建新 Profile。

浏览器使用自己的 Profile 锁保护重复打开；不要对同一卷运行多个容器。`docker compose restart` 保留 Cookie 和站点存储；普通 `down` 保留命名卷，`down -v` 会删除环境数据。服务处理 SIGTERM/SIGINT，关闭浏览器后退出。浏览器崩溃或环境初始化失败时服务停止，Compose 的重启策略负责恢复。

CDP 允许完整浏览器控制，不能认为原 MCP 的动作限制仍适用于这个连接。跨主机部署请使用私有网络或 HTTPS 认证反向代理。镜像以非 root 用户运行，浏览器沿用 Playwright 的默认 sandbox 设置，不能将 non-root 等同于启用了 Chromium sandbox。WebSocket 每帧/消息和排队数据上限为 16 MiB，超大截图或协议结果可能断开连接。

## 验证与打包

```sh
npm test
npm run test:cdp
npm run test:fingerprint-runtime
npm run test:geo-headers
npm run build
docker compose -f docker-compose.cdp.yml config --quiet
docker compose -f docker-compose.cdp.yml up -d --build
node scripts/smoke-cdp.mjs
docker compose -f docker-compose.cdp.yml restart
node scripts/smoke-cdp.mjs
docker save -o antigravity-browser-cdp-0.1.0.tar antigravity-browser-cdp:0.1.0
```

本机真实 CDP 测试覆盖未授权 HTTP/WS 拒绝、页面交互、截图、断开后服务存活、重启 Cookie 保留、配置冲突拒绝及服务关闭客户端断开。Linux 容器 smoke 由专用 CI 作业执行；CI 配置存在不代表其已运行通过。

当前宿主 Docker Desktop 因遗留 Windows socket 无法访问而启动失败，实际镜像构建/导出和 Linux 容器验证尚未完成。交付的 ZIP 是可构建源码包，不是 `docker load` 镜像包。修复 Docker engine 后执行上述命令完成镜像验收；不要把本机 Chromium 测试当成 Linux 容器测试。

本轮结果：`npm test` 通过 224 个单元测试、35 个 MCP 测试、26 个默认集成测试；另外 CDP 服务 1 项、身份一致性 2 项、请求头 2 项通过。类型检查、生产构建和 Compose 静态校验通过。默认集成按条件跳过的用例不算通过；受管扩展以及真实可用 WebGPU 设备的创建路径未在本轮验证。

Docker 故障处理记录：为绕开旧的 `sailor-ingest.sock`，原 Docker 临时运行目录被保留为 `C:\Users\32536\AppData\Local\Docker\run.audit-backup-ebcc472aa3984220ac6e7026b882b659`。后续 Docker 又因 `docker-secrets-engine/engine.sock` 无法访问退出，该 socket 清理被自动审批拒绝，未继续修改。没有重置 Docker 或删除镜像/数据卷。
