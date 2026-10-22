# Frequently asked questions

[中文](FAQ.md) · [Installation](QUICKSTART.en.md) · [Home](../README.en.md)

## Is this a Telegram client? Do I need my own Bot?

This backend connects an AI assistant to a Telegram Bot. You run the service and configure your own Bot token. It is not an official Telegram product and does not provide a shared hosted endpoint. Without a Bot, you can check MCP connectivity but cannot send Telegram messages.

## How do I create a Bot?

Open the official [@BotFather](https://t.me/BotFather) in Telegram, send `/newbot`, and follow the name and username prompts. Store the returned token in your own secure configuration. Before sending to a private chat, open your new Bot and press Start. For groups, add the Bot to a group you control and check its permissions. Never include the token in GitHub issues, chats, or screenshots.

## How are the Bot token, MCP key, and chat ID different?

- Bot token: the Bot credential issued by Telegram.
- `MCP_API_KEY`: a service access key you generate; clients use it to connect to this backend.
- Chat ID: the numeric destination identifier, not a group name or Bot username. See the [setup guide](GETTING-STARTED.md), currently in Chinese. Do not switch a Bot with an existing webhook to polling just to discover an ID.

## What is the easiest installation path?

Follow the [npm tutorial](QUICKSTART.en.md) with Node.js 24. The npm CLI reads process environment variables; it does not automatically load `.env.local` from the current directory. The source-development path uses `.env.local` inside `server/`. Keep these two configuration paths distinct.

## Can I paste the npx command into any MCP client?

No. This server uses **Streamable HTTP**, not stdio. Your client must support HTTP MCP and a custom Authorization header. Use `http://127.0.0.1:3000/api/mcp` with `Authorization: Bearer <your MCP_API_KEY>`. Cloud clients generally cannot reach your localhost; deploy your own HTTPS backend for them. Opening the endpoint in a browser address bar is not an MCP connection check.

## Why does the first launch take longer?

The first run downloads dependencies and compiles source in your user cache. Wait for startup to finish before connecting. Check available disk space and network access; do not remove other services' data to make space.

## How do I resolve a 401, connection refusal, or empty Bot list?

| Symptom | Next step |
|---|---|
| 401 | Match the client's Bearer key to the service's `MCP_API_KEY`; restart after environment changes |
| Connection refused | Check that compilation finished, the server is running, and the address and port are correct |
| Empty `list_bots` | For npm, check `TELEGRAM_BOT_TOKEN` in the process environment; for source development, check `server/.env.local`, then restart |
| `Unknown bot alias` | Call `list_bots` to confirm aliases; the basic single-Bot setup uses `default` |

## Connected, but no Telegram message arrived?

Check the Bot token, numeric destination chat ID, Start status / group permissions, and the feature's configuration. Begin with plain text before media or buttons. If a request times out with an uncertain delivery result, inspect Telegram before retrying to avoid duplicates.

## Do photos, buttons, and Rich Messages work immediately? Is a database required?

Basic sending does not require setting up a database first. Advanced uploads, persistence, Rich Messages, inboxes, and callbacks have separate switches, storage, and permission requirements; see [configuration](CONFIGURATION.md) and [features](FEATURES.md), currently in Chinese. Link and copy buttons differ from callback buttons requiring a webhook. Enable only what you need.

## Which systems are covered? Can I share my MCP key with everyone?

The tutorial covers verified macOS and Linux installations; Windows is outside that tutorial's acceptance scope. Share the MCP key only with trusted operators. Base tools can accept raw chat IDs, so aliases are not a complete recipient allowlist. Keep authentication enabled and use HTTPS for remote access.

## How do I stop the service or report a problem?

Press Ctrl+C when running in the foreground. Report ordinary problems through [GitHub Issues](https://github.com/cyuanxv/telegram-bot-mcp-server/issues), including OS, Node version, package version, installation path, redacted errors, and whether a message arrived. Exclude tokens, access keys, private messages, and database credentials. Read [SECURITY.md](../SECURITY.md) first for security issues. See [known issues](KNOWN-ISSUES.md) before addressing dependency warnings; do not blindly run `npm audit fix --force`.
