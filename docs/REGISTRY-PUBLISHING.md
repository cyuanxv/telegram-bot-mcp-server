# MCP Registry 发布准备与门禁

本页说明维护者的发布步骤；公开动作须取得明确授权。保持后端源码分发范围，不包含Sites、Docker镜像、node_modules或编译二进制。源码安装包只提供本地Streamable HTTP，不注册公共远程入口。

## 固定身份

| 项目 | 值 |
|---|---|
| GitHub仓库（计划） | cyuanxv/telegram-bot-mcp-server |
| npm安装包（计划） | @cyuanxv/telegram-bot-mcp-server |
| 正式版本 | 1.0.1 |
| Registry名称 | io.github.cyuanxv/telegram-bot-mcp-server |
| 包内MCP协议身份 | telegram-bot-mcp-server / 1.0.1 |

无作用域npm同名包已存在；使用作者作用域避免重名。用户已确认npm账号正常且账号名为`cyuanxv`；正式发布时使用该账号完成必要认证，并核对目标版本尚未发布。公开查询不存在不代表已经预留名称。GitHub身份认证只证明Registry命名空间，不能替代npm权限确认。

## 本地检查

在源码`server/`目录运行：

```sh
npm ci --ignore-scripts
npm run check:registry
npm run test:package
npm test
npm run test:review
npm run typecheck
npm run build
npm run test:protocol
mcp-publisher validate
```

`server.json`同时放在源码根目录和server目录，两份必须一致。元数据使用公开npm包定位，transport为`streamable-http`，URL为`http://127.0.0.1:{port}/api/mcp`；端口来自`--port`参数，MCP_API_KEY和Authorization头由安装者填写。Authorization值必须包含Bearer前缀。真实Bot操作需要用户自己的Bot凭据。

官方validate与JSON Schema检查只证明当前元数据可接受，不代表npm包已存在、发布者认证已完成或客户端自动安装一定成功。正式发布前应使用当时最新版官方工具复核。

## 防止误发布

审阅源码的`package.json`保留`private: true`；本地打包暂存副本设置为false，生成将来可发布的tgz。tgz不含预装依赖和编译产物，依赖由用户安装；首次运行在用户机器编译。源码开源不自动等于npm/Registry发布。没有自动发布workflow、安装生命周期钩子或私人生产URL。

## 等用户明确授权公开后，才执行

1. 从干净源码建立无旧历史的公开仓库，并确认README、许可证、报告范围。
2. 在安全终端核对npm发布账号和`@cyuanxv`作用域；不要把认证token写入项目。复查包内容、依赖、许可证和摘要，确认将来公开的正是已审阅tgz。
3. 公开npm包：`npm publish /absolute/path/to/cyuanxv-telegram-bot-mcp-server-1.0.1.tgz --access public --ignore-scripts`。仅在维护者明确授权发布时执行。
4. 验证公开安装和`mcpName`所有权标记，再使用`mcp-publisher login github`完成用户交互认证；必须是拥有`cyuanxv`身份的账号。
5. 再次validate，用户授权范围包含Registry时才运行`mcp-publisher publish`。
6. 回读Registry条目、公开包和干净安装结果，记录版本/摘要；不添加私人服务作为remotes。

用户确认不再重复Bot测试；不将其列为本次发布前置任务。仍保留[验收范围](ACCEPTANCE.md)，不把独立安装检查写成Telegram真实投递。Mac与Linux ARM64安装包检查已完成。

## 官方依据

- [Registry说明](https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/about.mdx)
- [官方发布流程](https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/quickstart.mdx)
- [安装包类型与所有权](https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/package-types.mdx)
- [固定版本Schema](https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json)
