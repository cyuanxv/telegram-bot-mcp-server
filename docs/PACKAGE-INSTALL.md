# 安装包自行部署

项目：Telegram Bot MCP Server；版本为1.0.1。npm名称为`@cyuanxv/telegram-bot-mcp-server`，Registry名称为`io.github.cyuanxv/telegram-bot-mcp-server`。本页说明源码安装包的自行部署方式；公开npm安装命令仅适用于已经发布的版本。

## 本地审阅安装

需要Node.js 24。新建专用目录，把随本地审阅材料提供的tgz安装进去：

```sh
mkdir telegram-bot-mcp-server-local
cd telegram-bot-mcp-server-local
npm install --ignore-scripts /absolute/path/to/cyuanxv-telegram-bot-mcp-server-1.0.1.tgz
```

通过服务管理器/终端安全环境设置`MCP_API_KEY`，再运行：

```sh
./node_modules/.bin/telegram-bot-mcp-server --port 3000
```

不要把真实密钥写在命令参数、仓库或聊天里。这个入口读取进程环境，不自动读取执行命令目录里的`.env.local`；原源码开发流程仍由Next从`server/`读取`.env.local`。

首次运行会将源码复制到用户自己的`~/.cache/telegram-bot-mcp-server/`目录后编译，需要用户缓存目录可写；依赖仅链接到自己的npm安装目录；编译不需要Bot凭据，不会自动注册webhook或迁移数据库。后续启动使用已有编译结果。可以显式运行`telegram-bot-mcp-server build`重建，或`telegram-bot-mcp-server start --port 3000`要求已有构建。安装时没有自动构建/启动脚本。

客户端连接`http://127.0.0.1:3000/api/mcp`，请求头为`Authorization: Bearer <同一个MCP_API_KEY>`。这是Streamable HTTP，不是stdio；只支持stdio或不会启动HTTP安装包的客户端需手动启动本服务，再配置HTTP连接。

真实Bot操作还需配置自己的`TELEGRAM_BOT_TOKEN`和`TELEGRAM_CHAT_ID`。其余开关、数据库及权限要求见[配置说明](CONFIGURATION.md)与[功能说明](FEATURES.md)。

## 远程自行部署

安装包仅绑定127.0.0.1。部署在自己的Linux服务器时，使用自己的进程管理器和HTTPS反向代理，把请求转发到本机端口，并保留访问认证。需要webhook时另配置自己可访问的HTTPS服务地址和相关功能。没有提供共享公共服务，也不需要连接作者的私人服务。

## 将来正式发布后

仅当维护者完成公开发布并确认包存在，用户才可改用：

```sh
npx --yes @cyuanxv/telegram-bot-mcp-server@1.0.1 --port 3000
```

同样需要先安全设置进程环境。用户缓存目录必须可写，以便首次编译。不要现在把以上命令写成已能从公网安装成功；当前只验收本地tgz。
