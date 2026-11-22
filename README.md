# 答桥 AnswerBridge

答桥是一款 Windows 桌面助手。你可以在电脑上截图或输入问题，通过答案小窗查看流式回答，也可以扫码同步到手机。实时语音功能接收电脑播放的声音，将模型回答以文字显示在小窗。

## Windows 下载和使用

从 [GitHub Releases](https://github.com/Tangtang232/AnswerBridge/releases) 下载 Windows x64 ZIP，完整解压后双击 `AnswerBridge.exe`。

1. 打开「软件设置 → 回答模型」，填写服务商、API Key 和模型 ID，保存后即可提问。截图模型需要支持图片输入。连接测试发送一条短文本，可用于验证接口配置。
2. 点「打开答案小窗」可查看本次会话的回答，调节字号和透明度。主窗最小化到 Windows 通知区，点击答桥图标恢复。
3. 手机同步是可选功能。手机和电脑连接能互通的局域网，点「连接手机」生成二维码。

全屏截图默认是单独按下并松开 `Ctrl`，`Alt+D` 用于框选截图，`Home` 显示或收起主窗。答桥截图时会暂时隐藏自己的窗口。

## 实时语音与回答风格

安装 VB-Audio Virtual Cable 并连接耳机。在「软件设置 → 实时语音」填写豆包实时语音 API Key，点「一键配置」检测 CABLE 和播放设备。

在答案小窗点「开始实时语音」后，答桥将电脑原声转送至所选设备，模型回答显示为文字。点「立即发送」可提交当前语音。暂停回答时仍可听电脑原声，关闭小窗后恢复播放设备。

在「语音回答风格」可填写提示词，也可选择或导入一份 Markdown Skill。保存后下次开始实时语音时生效。所选内容会随语音会话发送给豆包，截图和文字提问的 Skill 可独立配置。

## 从源码构建

需要 Windows、Node.js 22 和 npm。

~~~powershell
npm ci
npm run build
npm start
~~~

开发使用 `npm run dev`，测试使用 `npm test`，打包使用 `npm run package:win`。

## 数据与共享

- API Key 和 Skill 快照通过 Windows 本机加密保存。发布包不包含账户配置、个人 Skill 或会话历史。
- 局域网同步使用 HTTP/WebSocket，请在可信网络中使用。
- Windows 共享屏幕保护默认开启。保护效果因共享或录制软件而异，请在使用前用另一台设备确认实际画面。
