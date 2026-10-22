# Telegram Bot MCP Server

[中文](README.md) · [English](README.en.md)

为 AI 助手连接 Telegram Bot，支持富文本、多媒体消息和交互按钮，可自行部署。

`telegram-bot-mcp-server` 通过 MCP（模型上下文协议）让兼容客户端使用你自己的 Telegram Bot。服务运行在你控制的环境中，Bot 凭据由你配置和保管。

## 你可以用它做什么

- 把 AI 整理的日报、摘要发送到自己的 Telegram 会话。
- 将文字、图片和文件交付给团队，随后按需要编辑消息。
- 为消息添加链接、复制按钮；需要用户反馈时再配置回调。

## 使用 npm 开始

需要 Node.js 24，先设置自己的 `MCP_API_KEY` 进程环境，再运行：

```sh
npx --yes @cyuanxv/telegram-bot-mcp-server@1.0.0 --port 3000
```

首次启动会编译源码。连接地址为 `http://127.0.0.1:3000/api/mcp`，使用 Streamable HTTP，并携带 `Authorization: Bearer <你的 MCP_API_KEY>`。真实发送还需你自己的 Bot token 和目标 chat ID。

[按步骤安装](docs/QUICKSTART.md) · [npm 安装包](https://www.npmjs.com/package/@cyuanxv/telegram-bot-mcp-server) · [1.0.0 Release](https://github.com/cyuanxv/telegram-bot-mcp-server/releases/tag/v1.0.0) · [官方 MCP Registry 条目](https://registry.modelcontextprotocol.io/v0.1/servers/io.github.cyuanxv%2Ftelegram-bot-mcp-server/versions/1.0.0)

## 主要功能

- **富文本与编辑**：普通文字、HTML、MarkdownV2，以及已发送消息的编辑。
- **多媒体消息**：图片、视频、文件、音频、GIF、语音和贴纸。
- **Rich Messages**：标题、表格、公式、正文穿插图片，以及音视频混排。
- **交互按钮**：链接、复制文字和需要回调配置的交互操作。
- **自行部署**：提供后端源码、自动测试、数据库迁移和安装说明。

各功能的配置要求见[功能说明](docs/FEATURES.md)。本仓库提供后端源码，不包含 Sites 网页入口、Docker 镜像或预装依赖。本项目并非 Telegram 官方产品。

## 作者

© 2026 cyuanxv · [X / Twitter @cyuanxv](https://x.com/cyuanxv)

## 从这里开始

[npm 安装教程](docs/QUICKSTART.md) · [源码与本地安装包说明](docs/PACKAGE-INSTALL.md) · [Registry 发布维护说明](docs/REGISTRY-PUBLISHING.md)

1. [从零安装](docs/GETTING-STARTED.md)：安装、配置、启动，以及如何确认连接成功。
2. [配置说明](docs/CONFIGURATION.md)：最少需要填什么、哪些高级功能先保持关闭。
3. [功能边界](docs/FEATURES.md)：基础功能、条件功能与实验功能。
4. [常见问题](docs/TROUBLESHOOTING.md)：连接失败、没有消息回执和依赖告警。
5. [当前验收范围](docs/ACCEPTANCE.md)：本次全新安装做了什么，哪些还没验证。

以下为源码开发方式；日常安装请优先看上面的 npm 教程。使用 Node.js 24 和随附的 npm。解压后所有后端命令都在 `server/` 目录执行，不要在本包根目录执行 `npm ci`。

```sh
cd telegram-bot-mcp-server/server
npm ci --ignore-scripts
cp .env.example .env.local
# 用编辑器填 MCP_API_KEY；有自己的测试 Bot 时再填 token 和 chat ID
npm run dev -- --hostname 127.0.0.1
```

MCP 地址：`http://127.0.0.1:3000/api/mcp`。客户端请求需带 `Authorization: Bearer <你的 MCP_API_KEY>`。云端客户端通常不能访问你的本机地址，需要你自行部署 HTTPS 后端。

没有真实 Bot 也能启动并运行合成测试，但不能据此声称已向 Telegram 发出消息。不要把 Bot token、MCP 密钥或验证码贴入聊天、截图或 Git。

## 检查命令

在 `server/`：
```sh
npm test
npm run test:review
npm run typecheck
npm run build:delivery
npm run build
npm run test:protocol
```

低内存设备可用 `node --test-concurrency=2 --experimental-test-module-mocks --import ./tests/register-typescript.mjs --test tests/*.test.mjs` 代替 `npm test`。协议检查只连接本机，端口3130须空闲；运行时不要加载真实 Bot 配置。

已有本地安装验收不等于云端部署、真实 Bot 或客户端效果验收。

## 安全与许可

MCP 密钥只给可信操作者：基础接口包含发送、编辑和管理工具，可选择原始 chat ID，配置别名不是完整的收件人白名单。不要把它作为无需认证的公开消息服务。

已知依赖风险见 [已知问题](docs/KNOWN-ISSUES.md)。源码沿用 [MIT](LICENSE) 及原版权声明，第三方条款见 [第三方声明](THIRD_PARTY_NOTICES.md)。自有代码版权由cyuanxv持有，已确认采用MIT；不覆盖第三方依赖的原许可。反馈前请按 [安全说明](SECURITY.md) 删除凭据。

## 版权

© 2026 cyuanxv · [X / Twitter @cyuanxv](https://x.com/cyuanxv)

自有代码采用 [MIT 许可证](LICENSE)，第三方依赖保留各自的版权和许可。
