# Antigravity Browser Bridge

该 Manifest V3 扩展把用户明确选择的、已经登录的 Chrome 标签页连接到本机控制面。它通过
`chrome.debugger` 发送受限 CDP 指令，因此不需要复制或解密 Chrome Cookie，也不会把密码、
原始 Cookie 或任意 JavaScript 暴露给控制面。

1. 启动 `npm run start:control-plane`，在控制面创建一个 `bridge` 实例。
2. 打开 `chrome://extensions`，启用“开发者模式”，选择“加载已解压的扩展程序”。
3. 选择本目录，在扩展弹窗中填写控制面地址、浏览器 ID 和可选 Token。
4. 打开并登录目标网站，点击“绑定当前标签页”。

扩展只允许连接 `localhost` 或 `127.0.0.1`。Chrome 会在调试标签页时显示调试提示，这是
`chrome.debugger` 的正常安全提示。
