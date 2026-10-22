# 开发与安装排错

使用者先看[中文 FAQ](FAQ.md) / [English FAQ](FAQ.en.md)。下表同时包含源码开发检查；npm CLI 配置来自进程环境，源码方式使用 `server/.env.local`。

| 现象 | 先检查 |
|---|---|
| 根目录执行npm命令报没有package.json | 进入 `server/` |
| 接口401 | MCP_API_KEY是否填写；客户端是否使用 `Authorization: Bearer ...`；修改配置后是否重启 |
| 浏览器打开MCP地址不能聊天 | 使用支持HTTP MCP的客户端，地址栏访问不是初始化协议 |
| 本机能启动，云端客户端连接不了 | 云端通常无法访问你的127.0.0.1；需要自己的HTTPS部署 |
| list_bots为空 / Unknown bot alias | npm进程环境 / 源码 `server/.env.local` 的Bot配置；别名大小写；是否重启 |
| 有别名但发不出去 | 配置检查不验证真实token和权限；确认Bot会话已开始、目标ID正确及发送权限 |
| disabled / scope denied | 高级功能默认关闭；只按所需功能补配置，不要批量开放 |
| 生产启动提示没有构建 | 先运行 `npm run build`，再 `npm run start` |
| 本地协议检查报端口占用或别名不为空 | 3130端口须空闲；使用不含真实 `.env.local` 的独立测试副本 |
| npm audit非零 | 阅读 [已知问题](KNOWN-ISSUES.md)；不要盲目执行 `npm audit fix --force` |
| 安装出现弃用、构建出现sourcemap提示 | 与安全审计/执行失败分别判断；查看最终退出码和测试结果 |
| 发出请求但超时、没有确定回执 | 先核对Telegram消息，结果不确定时不要自动重发 |

普通问题可通过 [GitHub Issues](https://github.com/cyuanxv/telegram-bot-mcp-server/issues) 反馈；安全问题先看 [SECURITY.md](../SECURITY.md)。问题说明应包含Node版本、操作系统、包校验值、具体命令、脱敏后的错误和是否出现Telegram回执。不要附token、MCP密钥、密码、会话串、数据库地址或私人消息；安全问题不要公开贴利用数据。
