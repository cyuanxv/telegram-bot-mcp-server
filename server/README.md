# Telegram Bot MCP Server

Self-hosted Telegram Bot MCP server for rich text, media and interactive buttons. Node.js 24 is required. This source package uses Streamable HTTP and binds to 127.0.0.1; it is not a stdio server and includes no hosted service.

## Installation / 安装

Install a supplied source .tgz into a dedicated directory, without lifecycle scripts:

```sh
npm install --ignore-scripts /absolute/path/to/cyuanxv-telegram-bot-mcp-server-1.0.0.tgz
```

After public publication, the same version can also be launched with `npx --yes @cyuanxv/telegram-bot-mcp-server@1.0.0 --port 3000`. This public-package command applies only once that version has been published, and requires the service environment described below.

Set a strong `MCP_API_KEY` in your service environment and run `./node_modules/.bin/telegram-bot-mcp-server --port 3000`. The first launch builds the source locally; subsequent launches use that build. Use the `build` subcommand to rebuild, or `start` to require an existing build. The source build workspace is under `~/.cache/telegram-bot-mcp-server/`; keep that user cache writable. Dependencies remain in your npm installation. No install hook builds or starts the service.

Connect to `http://127.0.0.1:3000/api/mcp` using `Authorization: Bearer <your MCP_API_KEY>`. Provide your own `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` for real Bot operations. Do not put tokens in command-line arguments. For deployment on another machine, configure your own authenticated HTTPS reverse proxy; cloud clients cannot connect directly to your local loopback address.

默认情况下，队列、收件箱、媒体字节上传、回调、Rich Messages、个人账号等高级功能不会自动启用。启用前配置对应权限、目标范围和存储。`migrations/` 是按功能分组的 SQL，runtime 示例授权需单独审阅；不要把迁移管理员凭据交给运行服务。

`TELEGRAM_PUBLIC_ORIGIN` 必须设为你自己的 HTTPS 服务根地址，供 webhook 归属校验与注册使用。不配置时为 `.invalid` 占位地址，无法接收真实事件。

`demo-group` 是替换私人配置的兼容别名，不代表真实群；基础默认 chat 会映射到此别名。当前直接 Rich 发送仅开放 `default` Bot / `demo-group`，私聊需使用 Rich session 和显式目标授权。不会自动注册 webhook、导入账号或发送消息。

The MCP key grants trusted operator access, including tools that accept raw chat IDs; configured aliases are not a recipient allowlist. Dependencies retain their own licenses; see THIRD_PARTY_NOTICES.md. This project is not affiliated with Telegram.

## Author and copyright / 作者与版权

© 2026 cyuanxv · [X / Twitter @cyuanxv](https://x.com/cyuanxv)

Own source code is licensed under [MIT](LICENSE).
