# Chromix 对照与本次优化

本文记录首轮修复。最新的能力差异、后续优化与未完成事项见 [当前项目与 Chromix 的区别](./project-vs-chromix.md)。

对照日期：2026-09-07。参考源码固定在 [Chromix e540796](https://github.com/xiaozhou26/Chromix/tree/e540796decd489e8e9dff8dea940eb03e77db693)。以下是源码审阅结论，没有运行或验证 Chromix 的发行二进制。

| 方面 | Chromix | 本项目与处理决定 |
| --- | --- | --- |
| 环境一致性 | Chromium 补丁与 `--fingerprint-*` 参数，SDK 协调启动参数 | 本项目为受管 Firefox/Chromium、原生首选项和 CDP/脚本组合。保留现有架构，修复 locale、语言列表、时区与坐标的配置差异 |
| 请求头与地域设置 | Node SDK 将顶层 locale/timezone 转为内核 flags，明确移除 context 层对应覆盖 | 移除地理配置中的全局导航头，由浏览器按资源类型生成 Fetch Metadata 和 Accept |
| 内核完整性 | `_binary.js` 使用流式 SHA-256 校验下载文件 | 自定义 Firefox 可执行文件改用流式校验，保留严格版本、源码、补丁锁与失败拒绝策略 |
| GeoIP | Node `geoipHttp(proxyUrl)` 内的 fetch 未使用 proxyUrl，并将国家代码小写作为 locale | 该实现不适合借用。国家默认环境也不等于真实出口探测；本次未增加在线 GeoIP 服务 |
| 产品范围 | 浏览器内核与轻量 SDK | 本项目还有 Studio、持久 Profile、代理池、权限、审计与 RPA，不能把内核替换等同于产品升级 |

## 已落地

- `alignGeoEnvironment` 只设置 Accept-Language，防止把 fetch、样式表和其他子资源错误标为文档导航，或覆盖调用方指定的 Accept。
- 显式时区优先使用已有时区坐标表，显式经纬度始终优先。坐标表是城市级测试默认值，不是 IP 定位结果；未知时区仍沿用国家默认坐标。
- 指纹生成器在仅指定 locale 时同步语言列表；默认与显式语言列表均复制，防止配置数组跨会话共享。
- 时区查询只接受表内自身属性，避免把 `constructor` 等继承属性当作坐标。
- 自定义 Firefox 使用流式 SHA-256，内存占用不再随整个可执行文件大小增长；格式错误的 provenance 与补丁元数据返回稳定错误。
- 保留 iframe 的原生 Window.navigator 访问器，避免 Firefox 子窗口丢失整个 navigator API。跨上下文测试的加载回调现在传播读取异常，Worker 使用标准 Blob URL 创建，错误或超时会失败并释放资源，不再静默跳过 Worker 断言。

## 验证方式

`npm test` 执行类型、单元、MCP 与默认集成检查；`npm run build` 构建生产输出。

新增真实浏览器请求头测试不访问外站，使用临时回环 HTTP 服务，验证 Chromium/Firefox 的导航、CSS、fetch 元数据与自定义 Accept：

```sh
npm run test:geo-headers
```

CI 的 verify 作业也执行该检查。

最终验证结果：类型检查、生产构建、217 个单元测试、35 个 MCP 测试和 26 个默认集成测试全部通过。默认集成中的 7 个按条件启用的测试未执行；随后单独运行 `test:geo-headers`（2 项）、`test:fingerprint-runtime`（2 项）和 `test:firefox`（1 项）全部通过。受管扩展测试未在本轮单独启用。

首轮发现的跨 iframe/Worker 测试超时已修复，根因为 iframe 保护代码删除 Window.navigator 后，测试加载回调抛错但没有拒绝等待中的 Promise。此前已在撤回首轮优化、保留原工作区改动的临时副本中复现；修复后正常完成。真实身份测试通过不代表 stock Firefox 已获得自定义内核才支持的 Service Worker 时区覆盖，原有能力边界保持不变。

## 后续内核接入边界

完整核查与 Docker/CDP 交付依据见 [chromix-cdp-audit.md](./chromix-cdp-audit.md)，包含真实 CDP 接管观测、当前发行平台限制和分阶段验收任务。

本次未引入 Chromix 依赖或替换浏览器。若未来支持 Chromix，应独立实现管理员配置的引擎适配器，固定发行版及校验清单，从真实内核版本生成身份，并增加 Window/Worker/Service Worker/网络一致性测试。当前仅受管 Playwright 版本的身份检查不能直接用于 Chromix 二进制。Chromix README 所述能力不能视为本项目已实现或已验证的能力。
