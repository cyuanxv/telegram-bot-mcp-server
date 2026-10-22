# 从 npm 安装 Telegram Bot MCP Server

[English](QUICKSTART.en.md) · [项目首页](../README.md)

适用版本：1.0.0。适用于 macOS / Linux 的 Bash 终端。需要 Node.js 24 和 npm、可写的用户缓存目录及首次编译所需磁盘空间。本文使用已公开安装包，不需要下载源码。Windows 未在本文验收范围。

## 1. 准备自己的配置

- `MCP_API_KEY`：自己生成的强随机访问密钥，与 Bot token 不同。
- `TELEGRAM_BOT_TOKEN`：通过 Telegram 的 [@BotFather](https://t.me/BotFather) 创建自己的 Bot 后获得。
- `TELEGRAM_CHAT_ID`：自己控制的目标私聊或群的数字 ID；群里应先加入 Bot，并授予所需发送权限。私聊需先打开 Bot 并按 Start。

不要填写作者服务的地址或凭据。没有 Bot 也能验证服务连接，但无法真实发送。如何取得目标 ID 见[从零配置](https://github.com/cyuanxv/telegram-bot-mcp-server/blob/main/docs/GETTING-STARTED.md)；已有 webhook 的 Bot 不要为查 ID 随意切换收件方式。

以下命令在同一个 **Bash** 终端运行；如果当前是 zsh，可先输入 `bash`。使用交互输入，避免把密钥直接写入命令历史：

```bash
read -r -s -p 'MCP access key: ' MCP_API_KEY; printf '\n'
export MCP_API_KEY
read -r -s -p 'Your Bot token (Enter to skip): ' TELEGRAM_BOT_TOKEN; printf '\n'
export TELEGRAM_BOT_TOKEN
read -r -p 'Your destination chat ID (Enter to skip): ' TELEGRAM_CHAT_ID
export TELEGRAM_CHAT_ID
```

密钥仅存在当前 shell 与其子进程环境中；持续运行时改用自己的服务管理器安全注入。不要把凭据存入 Git、截图或反馈。

## 2. 启动

先确认 `node --version` 是 `v24.x`，再运行：

```bash
npx --yes @cyuanxv/telegram-bot-mcp-server@1.0.0 --port 3000
```

保持此终端运行。第一次会安装依赖并在 `~/.cache/telegram-bot-mcp-server/` 下编译，耗时依网络和机器而变；后续启动复用构建。没有安装时自动执行的构建脚本，不会自动设置 webhook 或执行数据库迁移。

CLI 读取进程环境，**不会自动读取当前目录的 `.env.local`**。不要与源码开发方式混用。

## 3. 连接 AI 客户端

在支持 Streamable HTTP 和自定义 Authorization 请求头的客户端里添加：

| 设置 | 填写 |
|---|---|
| 名称 | Telegram Bot |
| 传输 | Streamable HTTP |
| URL | `http://127.0.0.1:3000/api/mcp` |
| 请求头 | `Authorization: Bearer <与服务一致的 MCP_API_KEY>` |

不同客户端设置界面不同，这不是通用 stdio 配置。只支持 stdio 的客户端不能把上面的命令直接当 stdio 服务运行；需要其支持 HTTP 或另行适配。云端客户端通常无法连接本机地址，需自行部署 HTTPS 后端，不要填作者私人服务。

先请求客户端列出工具，再调用 `inspect_configuration` 和 `list_bots`。没有配置 Bot 时应看到空列表，这表示服务连接检查，不表示 Telegram 发送成功。

## 4. 自己确认第一条消息

只有你准备好自己的 Bot 和目标会话后再做：

> 使用 Telegram Bot，先核对 default Bot 和目标会话，然后向我的 default 会话发送“Hello from my AI assistant”。发送前让我确认目标。

自然语言提示供使用者参考，具体调用以客户端展示的工具参数为准。随后在 Telegram 中确认消息到达。基础单 Bot / 单 chat 配置使用 `default` 别名；别名不是完整的收件人白名单。

从普通文本开始，再逐步试 HTML、图片 URL、文件与按钮。Rich Messages、上传、回调和持久化等能力需要额外开关/存储/权限，见[配置说明](https://github.com/cyuanxv/telegram-bot-mcp-server/blob/main/docs/CONFIGURATION.md)和[功能说明](https://github.com/cyuanxv/telegram-bot-mcp-server/blob/main/docs/FEATURES.md)，不是装完即全部启用。

## 5. 常见问题和退出

- Node 版本不符：使用 Node.js 24 后重试。
- 401：客户端的 Bearer 密钥须与服务的 MCP_API_KEY 一致。
- 连接拒绝：确认首次编译完成、终端仍在运行、端口未被占用。
- 有工具却没有消息：确认 Bot token、数字 chat ID、私聊已 Start / 群权限，以及所用功能配置。
- 磁盘不足：检查自己的缓存和磁盘空间；不要删除其他服务数据。

终端按 Ctrl+C 停止服务。仅需停止即可，不需要删除包或缓存。源码和详细说明：[GitHub](https://github.com/cyuanxv/telegram-bot-mcp-server)。项目并非 Telegram 官方产品。
