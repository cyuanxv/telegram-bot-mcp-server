# Telegram Bot MCP Server

[中文](README.md) · [English](README.en.md)

Self-hosted Telegram Bot MCP server for AI assistants. Send rich messages, photos, videos, files, and interactive buttons.

`telegram-bot-mcp-server` connects MCP-compatible clients to your own Telegram Bot through the Model Context Protocol. Run the backend in an environment you control and configure your own Bot credentials.

[Installation](docs/QUICKSTART.en.md) · [FAQ](docs/FAQ.en.md) · [Features and requirements](docs/FEATURES.md) · [Report an issue](https://github.com/cyuanxv/telegram-bot-mcp-server/issues)

## What you can do

- Send AI-written daily reports and summaries to your own Telegram chat.
- Deliver text, photos, and files to your team, then edit messages when needed.
- Add link and copy buttons; configure callbacks separately for user responses.

## Start with npm

Use Node.js 24. Set your own `MCP_API_KEY` in the process environment, then run:

```sh
npx --yes @cyuanxv/telegram-bot-mcp-server@1.0.0 --port 3000
```

The first launch compiles the source. Connect over Streamable HTTP at `http://127.0.0.1:3000/api/mcp` with `Authorization: Bearer <your MCP_API_KEY>`. Real delivery also requires your own Bot token and destination chat ID.

[Step-by-step installation](docs/QUICKSTART.en.md) · [npm package](https://www.npmjs.com/package/@cyuanxv/telegram-bot-mcp-server) · [1.0.0 release](https://github.com/cyuanxv/telegram-bot-mcp-server/releases/tag/v1.0.0) · [Official MCP Registry entry](https://registry.modelcontextprotocol.io/v0.1/servers/io.github.cyuanxv%2Ftelegram-bot-mcp-server/versions/1.0.0)

## Features

- **Text and editing**: plain text, HTML, MarkdownV2, and editing sent messages.
- **Media messages**: photos, videos, documents, audio, GIFs, voice messages, and stickers.
- **Rich Messages**: headings, tables, formulas, inline images, and mixed audio/video content.
- **Interactive buttons**: links, copy text, and interactive actions that require callback configuration.
- **Self-hosting**: backend source, automated tests, database migrations, and installation documentation.

See the [feature guide](docs/FEATURES.md) for configuration requirements. This repository contains backend source only; it excludes the Sites web entry, Docker images, and installed dependencies. This project is not an official Telegram product.

## Author

© 2026 cyuanxv · [X / Twitter @cyuanxv](https://x.com/cyuanxv)

## Getting started

[npm installation tutorial](docs/QUICKSTART.en.md) · [Source and local package guide](docs/PACKAGE-INSTALL.md) · [Registry publishing maintenance](docs/REGISTRY-PUBLISHING.md)


The detailed guides below are currently in Chinese:

1. [Install from scratch](docs/GETTING-STARTED.md): installation, configuration, startup, and connection checks.
2. [Configuration](docs/CONFIGURATION.md): required settings and advanced features to leave disabled initially.
3. [Feature boundaries](docs/FEATURES.md): basic, conditional, and experimental features.
4. [FAQ in English](docs/FAQ.en.md): Bot creation, installation, connection, and delivery troubleshooting; [developer troubleshooting](docs/TROUBLESHOOTING.md) is in Chinese.
5. [Acceptance scope](docs/ACCEPTANCE.md): what the clean installation verified and what remains unverified.

The following is the source-development path; use the npm tutorial above for installation. Use Node.js 24 and its bundled npm. After extraction, run all backend commands inside `server/`; do not run `npm ci` at the package root.

```sh
cd telegram-bot-mcp-server/server
npm ci --ignore-scripts
cp .env.example .env.local
# Set MCP_API_KEY in an editor; add a Bot token and chat ID only for your own test Bot.
npm run dev -- --hostname 127.0.0.1
```

MCP endpoint: `http://127.0.0.1:3000/api/mcp`. Client requests must include `Authorization: Bearer <your MCP_API_KEY>`. Cloud clients generally cannot access your local endpoint; deploy your own HTTPS backend to connect them.

Without a real Bot, you can start the server and run synthetic tests, but this does not verify Telegram delivery. Never paste Bot tokens, MCP keys, or verification codes into chats, screenshots, or Git.

## Checks

Run inside `server/`:

```sh
npm test
npm run test:review
npm run typecheck
npm run build:delivery
npm run build
npm run test:protocol
```

On low-memory devices, replace `npm test` with `node --test-concurrency=2 --experimental-test-module-mocks --import ./tests/register-typescript.mjs --test tests/*.test.mjs`. The protocol check connects only to localhost and requires port 3130 to be free. Do not load real Bot configuration during that check.

Local installation acceptance does not verify cloud deployment, a real Bot, or client rendering.

## Security and licensing

Share the MCP key only with trusted operators. The base interface includes sending, editing, and management tools and can accept raw chat IDs. Configured aliases are not a complete recipient allowlist. Do not expose this as an unauthenticated public messaging service.

See [known issues](docs/KNOWN-ISSUES.md) for dependency risks and [third-party notices](THIRD_PARTY_NOTICES.md) for dependency terms. Copyright in the project's own code belongs to cyuanxv, who has confirmed the MIT license; this does not replace third-party licenses. Remove credentials before reporting an issue, following the [security guide](SECURITY.md).

## Copyright

© 2026 cyuanxv · [X / Twitter @cyuanxv](https://x.com/cyuanxv)

The project's own code is licensed under the [MIT License](LICENSE). Third-party dependencies retain their respective copyrights and licenses.
