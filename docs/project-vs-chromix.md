# 当前项目与 Chromix 的区别

2026-09-08 补充：已开始维护独立 Chromium 原生补丁，覆盖语言、ICU locale、时区及硬件并发数，并提供 GitHub 构建/原生测试/Docker 导出流程。当前验证到精确源码应用和启动器测试，尚无通过完整编译的自定义 Chromium 二进制；以下已交付能力对比仍按默认运行时计算。详见 [内核实现与构建状态](../browser-core/chromium/README.md)。

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
4. 首批 Chromium 原生补丁及构建流程已经加入；仍须完成实际 Linux 编译和原生运行验证。Canvas、音频、字体、WebGL/WebGPU 的更深层修改和升级回归尚未完成。

这些是不同层面的能力，不能简单认定我们的功能更多就意味着内核更强，也不能仅凭 Chromix 有更多补丁就认定实际效果一定更好。

资料：[Chromix 固定源码](https://github.com/xiaozhou26/Chromix/tree/e540796decd489e8e9dff8dea940eb03e77db693)、[发行版本](https://github.com/xiaozhou26/Chromix/releases)、[本项目 Docker/CDP 使用说明](./docker-cdp.md)、[详细源码核查](./chromix-cdp-audit.md)。
