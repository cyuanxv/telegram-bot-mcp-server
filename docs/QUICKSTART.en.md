# Install Telegram Bot MCP Server from npm

[中文](QUICKSTART.md) · [Project home](../README.en.md)

Version: 1.0.1. These instructions use Bash on macOS or Linux, Node.js 24, npm, a writable user cache directory, and enough disk space for the first build. Windows is outside this tutorial's verified scope. No source checkout is required.

## 1. Prepare your own configuration

- `MCP_API_KEY`: generate a strong random access key. This is different from your Bot token.
- `TELEGRAM_BOT_TOKEN`: create your own Bot with Telegram's [@BotFather](https://t.me/BotFather).
- `TELEGRAM_CHAT_ID`: the numeric ID of a private chat or group you control. Start the Bot in private chats; add it to groups with the required sending permissions.

Do not use the author's private service or credentials. You can check the server connection without a Bot, but cannot send real messages. See the [setup guide in Chinese](https://github.com/cyuanxv/telegram-bot-mcp-server/blob/main/docs/GETTING-STARTED.md) for destination IDs. Do not switch an existing Bot's webhook/receiving setup just to find an ID.

Run the following in the same **Bash** terminal. If you use zsh, enter `bash` first. Interactive input avoids placing secrets directly in shell history:

```bash
read -r -s -p 'MCP access key: ' MCP_API_KEY; printf '\n'
export MCP_API_KEY
read -r -s -p 'Your Bot token (Enter to skip): ' TELEGRAM_BOT_TOKEN; printf '\n'
export TELEGRAM_BOT_TOKEN
read -r -p 'Your destination chat ID (Enter to skip): ' TELEGRAM_CHAT_ID
export TELEGRAM_CHAT_ID
```

These settings live in this shell and its child processes. For persistent operation, inject them securely through your own service manager. Keep credentials out of Git, screenshots, and issue reports.

## 2. Start the server

Confirm that `node --version` reports `v24.x`, then run:

```bash
npx --yes @cyuanxv/telegram-bot-mcp-server@1.0.1 --port 3000
```

Keep this terminal running. The first launch installs dependencies and compiles source under `~/.cache/telegram-bot-mcp-server/`; timing depends on your machine and connection. Later launches reuse the build. There are no install-time build hooks, automatic webhook registration, or database migrations.

The CLI reads process environment variables. It **does not automatically load `.env.local` from your current directory**. Keep this separate from source-development instructions.

## 3. Connect an AI client

Use a client that supports Streamable HTTP with a custom Authorization header:

| Setting | Value |
|---|---|
| Name | Telegram Bot |
| Transport | Streamable HTTP |
| URL | `http://127.0.0.1:3000/api/mcp` |
| Header | `Authorization: Bearer <the same MCP_API_KEY>` |

Client settings vary. This is not a universal stdio configuration. A stdio-only client cannot run this command as a stdio MCP server; HTTP support or a separate adapter is required. Cloud clients usually cannot reach localhost. Deploy your own HTTPS backend for them, not the author's private service.

First list tools, then call `inspect_configuration` and `list_bots`. An empty Bot list without Bot configuration is expected; this checks connectivity, not Telegram delivery.

## 4. Confirm your first message

Only do this after configuring your own Bot and destination:

> Use Telegram Bot to check my default Bot and destination, then send “Hello from my AI assistant” to my default chat. Ask me to confirm the destination before sending.

This prompt is illustrative; follow the tool schema shown by your client. Confirm delivery in Telegram. The single-Bot / single-chat setup uses the `default` alias. Aliases are not a complete recipient allowlist.

Start with plain text, then try HTML, image URLs, files, and buttons. Rich Messages, uploads, callbacks, and persistence need additional settings, storage, or permissions. They are not all enabled on installation. See [configuration](https://github.com/cyuanxv/telegram-bot-mcp-server/blob/main/docs/CONFIGURATION.md) and [features](https://github.com/cyuanxv/telegram-bot-mcp-server/blob/main/docs/FEATURES.md), currently in Chinese.

## 5. Troubleshooting and stopping

- Wrong Node version: switch to Node.js 24.
- 401: match the client's Bearer key to the server's MCP_API_KEY.
- Connection refused: wait for the first build, keep the terminal running, and check the port.
- Tools work but delivery fails: check the token, numeric chat ID, private-chat Start / group permissions, and feature configuration.
- Disk full: inspect your own disk and cache; do not delete other services' data.

Press Ctrl+C in the terminal to stop. Removing the package or cache is unnecessary. Source and details: [GitHub](https://github.com/cyuanxv/telegram-bot-mcp-server). This is not an official Telegram product.
