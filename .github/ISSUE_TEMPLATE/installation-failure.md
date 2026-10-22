---
name: Installation failure / 安装失败
about: Report installation, startup, or MCP connection problems / 反馈安装、启动或 MCP 连接问题
title: "[Install] "
---

<!-- You may answer in English or Chinese. 可用中文或英文填写，不必重复填写两种语言。 -->
<!-- Public issues are visible to everyone. Never include Bot tokens, MCP keys, passwords, .env files, Authorization headers, database URLs, or private chats. Redact commands and logs before posting. -->
<!-- Issue 是公开的。不要上传 Bot token、MCP 密钥、密码、.env 文件、Authorization 请求头、数据库地址或私人聊天。命令和日志请先脱敏。 -->
<!-- For suspected vulnerabilities, read https://github.com/cyuanxv/telegram-bot-mcp-server/blob/main/SECURITY.md first; do not post exploit details here. 安全漏洞请先阅读 https://github.com/cyuanxv/telegram-bot-mcp-server/blob/main/SECURITY.md，不要在这里公开利用细节。 -->

## What went wrong? / 遇到了什么问题？

Describe where it stopped: installation, first build, startup, or client connection.
说明卡在哪一步：安装、首次编译、启动，还是客户端连接。

## Environment / 使用环境

- OS and version / 系统和版本：
- Node.js version (`node --version`) / Node.js 版本：
- npm version (`npm --version`) / npm 版本：
- Package version or source commit / 包版本或源码提交：
- Installation method: npm/npx or source / 安装方式：npm/npx 或源码：
- MCP client and version, if applicable / MCP 客户端和版本（如适用）：
- Client and server: same machine or remote? / 客户端和服务：同一台机器还是远程连接？

## Steps and result / 操作和结果

1. Command or client action, with secrets removed / 脱敏后的命令或客户端操作：
2. Expected result / 预期结果：
3. Actual result / 实际结果：

## Error output / 报错内容

Paste only relevant, redacted lines; do not attach a full environment file.
只粘贴相关且已脱敏的报错，不要附完整环境文件。

```text
Replace this line with redacted output / 在这里填写脱敏报错
```

## Checks already tried / 已尝试的检查

List what you checked and the result; “not sure” is fine.
写明已检查的内容及结果；不清楚的可以写“不确定”。

- Node.js 24 / Node.js 是否为 24：
- First build finished and server still running / 首次编译是否完成、服务是否仍在运行：
- Streamable HTTP and matching Bearer key (do not paste the key) / 是否使用 Streamable HTTP、两端密钥是否一致（不要填写密钥）：
- Anything else tried / 其他尝试：

## Delivery status, only if a send was attempted / 如尝试过发送，消息是否到达？

Not attempted / received / not received / unknown. No private message contents needed.
未尝试 / 已收到 / 未收到 / 不确定。无需附私人消息内容。

If delivery is uncertain after a timeout, check Telegram before retrying to avoid duplicates.
若超时后发送结果不确定，请先去 Telegram 核对，避免重复发送。

See the [installation guide](https://github.com/cyuanxv/telegram-bot-mcp-server/blob/main/docs/QUICKSTART.en.md) and [FAQ](https://github.com/cyuanxv/telegram-bot-mcp-server/blob/main/docs/FAQ.en.md).
参阅[安装教程](https://github.com/cyuanxv/telegram-bot-mcp-server/blob/main/docs/QUICKSTART.md)和[常见问题](https://github.com/cyuanxv/telegram-bot-mcp-server/blob/main/docs/FAQ.md)。
