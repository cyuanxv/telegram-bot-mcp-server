# 常见问题

[English](FAQ.en.md) · [安装教程](QUICKSTART.md) · [项目首页](../README.md)

## 这是 Telegram 客户端吗？需要自己的 Bot 吗？

这是连接 AI 助手和 Telegram Bot 的后端服务。使用者自行运行服务，并使用自己的 Bot token。它不是 Telegram 官方产品，也不提供共享的托管入口。没有 Bot 时可以检查 MCP 连接，但不能发送 Telegram 消息。

## 怎么创建 Bot？

在 Telegram 打开官方 [@BotFather](https://t.me/BotFather)，发送 `/newbot`，按提示设置名称和用户名。将收到的 token 放入自己的安全配置。私聊发送前，先打开新 Bot 并点击 Start；群聊发送前，先将 Bot 加入自己控制的群并确认权限。不要把 token 发到 GitHub Issue、聊天或截图里。

## Bot token、MCP 密钥和 chat ID 有什么区别？

- Bot token：Telegram 提供的 Bot 凭据。
- `MCP_API_KEY`：你自己生成的服务访问密钥，客户端用它连接此服务。
- chat ID：目标会话的数字 ID，不是群名或 Bot 用户名。取得方式见[从零安装](GETTING-STARTED.md)。已有 webhook 的 Bot 不要为查询 ID 随意改用轮询。

## 最简单的安装方式是什么？

按[安装教程](QUICKSTART.md)使用 Node.js 24 和 npm 安装包。npm CLI 从进程环境读取配置，不会自动加载当前目录的 `.env.local`。源码开发方式才是在 `server/` 内配置 `.env.local`，两种方式不要混用。

## 可以直接把 npx 命令填进任何 MCP 客户端吗？

不能。此服务使用 **Streamable HTTP**，不是 stdio。客户端需要支持 HTTP MCP 和自定义 Authorization 请求头。连接地址为 `http://127.0.0.1:3000/api/mcp`，请求头为 `Authorization: Bearer <你的 MCP_API_KEY>`。云端客户端通常不能访问你的本机地址，需要你自己的 HTTPS 部署；浏览器地址栏打开接口也不等于完成 MCP 连接。

## 为什么首次启动较慢？

首次运行会下载依赖并在用户缓存目录编译源码。等待终端显示启动结果，再连接客户端。确认磁盘空间和网络可用；不要删除其他服务的数据来清理空间。

## 401、连接拒绝、Bot 列表为空怎么处理？

| 现象 | 下一步 |
|---|---|
| 401 | 确认客户端 Bearer 密钥与服务 `MCP_API_KEY` 相同；修改环境配置后重启服务 |
| 连接拒绝 | 确认首次编译完成、服务仍在运行、地址和端口正确 |
| `list_bots` 为空 | npm 方式检查进程环境中的 `TELEGRAM_BOT_TOKEN`；源码方式检查 `server/.env.local`，然后重启 |
| `Unknown bot alias` | 先调用 `list_bots` 确认真实别名；基础单 Bot 配置使用 `default` |

## 已连接，但 Telegram 没有收到消息？

依次确认 Bot token、目标数字 chat ID、私聊已 Start / 群权限，以及所用功能是否已配置。先试普通文字，再试媒体或按钮。若请求超时且发送结果不确定，先去 Telegram 核对，不要自动重发以免重复。

## 图片、按钮、Rich Messages 都能直接用吗？需要数据库吗？

基础发送不要求先搭建数据库。高级上传、持久化、Rich Messages、收件箱和回调等能力有各自的开关、存储和权限要求，见[配置说明](CONFIGURATION.md)和[功能说明](FEATURES.md)。链接和复制按钮与需要 webhook 的回调按钮不同；不要为了一个功能一次打开所有权限。

## 支持什么系统？能把 MCP 密钥给所有人吗？

安装教程覆盖已验收的 macOS 和 Linux，Windows 不在该教程验收范围。MCP 密钥只应交给可信操作者；基础接口可以接受原始 chat ID，别名不是完整的收件人白名单。自行部署时保留认证，远程连接使用 HTTPS。

## 如何停止？遇到问题去哪里反馈？

前台运行时按 Ctrl+C。普通问题可在 [GitHub Issues](https://github.com/cyuanxv/telegram-bot-mcp-server/issues) 反馈，附系统、Node 版本、包版本、安装方式、脱敏后的报错，以及是否收到消息。不要提交 token、访问密钥、私人聊天内容或数据库凭据；安全问题请先阅读 [SECURITY.md](../SECURITY.md)。依赖告警见[已知问题](KNOWN-ISSUES.md)，不要直接执行 `npm audit fix --force`。
