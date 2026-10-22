# 从零安装后端

## 1. 准备

使用 Node.js 24。运行 `node --version`，应以 `v24.` 开头。需要 npm、可访问 npm 包仓库的网络，以及本机空闲端口3000。当前全新安装实际检查的平台和版本见 [验收范围](ACCEPTANCE.md)；其他系统未作本轮实机保证。

解压本候选包，打开终端进入其中的 `telegram-mcp/server/`。第一次启动不需要数据库，不需要启用收件箱或 Rich Messages 发送。

## 2. 安装并填写本地配置

```sh
npm ci --ignore-scripts
cp .env.example .env.local
```

用编辑器打开 `.env.local`：
- `MCP_API_KEY`：你自己生成的随机密钥，用来限制谁能调用这个后端；推荐32字节随机值。可在本机运行 `node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))"` 生成，只存入自己的配置或密码管理器。
- `TELEGRAM_BOT_TOKEN`：自己的测试 Bot 凭据。没有时先留空，只做启动和离线检查。
- `TELEGRAM_CHAT_ID`：你的测试会话数字 ID。必须选你有权限使用的会话；它不是群标题或邀请链接。

`TELEGRAM_BOTS_JSON={}` 等空注册表可保持原样，不会覆盖单 Bot 配置。所有 `...ENABLED=false` 先保持关闭。`.env.local` 已被忽略，不应提交或装进分享包。

## 3. 启动与连接

```sh
npm run dev -- --hostname 127.0.0.1
```

看到 `Ready` 后，服务默认在3000端口。它是 MCP 接口，不是聊天网页；在浏览器地址栏打开 `/api/mcp` 不能完成 MCP 连接。

在支持 HTTP MCP 和自定义认证头的客户端中填写：
- URL：`http://127.0.0.1:3000/api/mcp`
- 请求头名称：`Authorization`
- 请求头值：`Bearer ` 加你的 `MCP_API_KEY`，注意中间的空格。

先调用 `list_bots`、`list_chats` 看配置，再调用 `inspect_configuration` 看开关。它只检查配置形状，不证明 Telegram 凭据有效、数据库已就绪或 Bot 有权限。

不带密钥或用错密钥应收到401。若端口被占用，可改用 `npm run dev -- --hostname 127.0.0.1 --port 3001`，客户端URL也同步改成3001。

## 4. 有真实测试 Bot 后

在 Telegram 中先打开你自己的测试 Bot 并发起会话，或把它加入你控制的测试群；普通群内发消息只需相应发送权限，不要为了测试默认授予全部管理员权限。重新启动后端以加载配置。

在 MCP 客户端先检查别名，再请求向你选定的测试会话发送一条文字，例如 `send_message` 参数：
```json
{"bot_alias":"default","chat":"default","text":"自托管安装测试"}
```

确认返回 `message_id`，再打开 Telegram 对照实际消息。收到消息并核对内容后，才算这一条真实发送验收通过。图片、文件和富消息需分别验收。出现超时或结果不确定时，先到 Telegram 核实，不要自动重复发送。

本次没有专用测试 Bot，以上真实步骤仅是待执行指南，不是通过记录。

## 5. 用生产模式在本机启动

先停止开发服务，然后：
```sh
npm run build
npm run start -- --hostname 127.0.0.1
```

生产模式也会读取 `.env.local`。对外服务还需要 HTTPS、妥善保存密钥和受控网络入口；本指南不会自动部署服务。

## 6. 停止与重装

在启动终端按 Ctrl+C 关闭服务。修改 `.env.local` 后重启。重装依赖用 `npm ci --ignore-scripts`；不要把本地配置、node_modules 或构建缓存复制给别人。高级存储未启用时不需要执行数据库迁移。
