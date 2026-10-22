# 配置说明

## 最小后端配置

| 配置 | 用途 | 起步要求 |
|---|---|---|
| MCP_API_KEY | 后端调用密钥 | 启动验收必须填写；与Bot token不同 |
| TELEGRAM_BOT_TOKEN | Telegram提供的Bot凭据 | 真实发送才需要 |
| TELEGRAM_CHAT_ID | 自己控制的测试会话数字ID | 真实发送才需要 |
| TELEGRAM_BOTS_JSON | 多Bot别名注册表 | 单Bot先保持 `{}` |
| TELEGRAM_CHATS_JSON | 会话别名注册表 | 单会话先保持 `{}` |
| TELEGRAM_PUBLIC_ORIGIN | 自己的HTTPS后端根地址 | 接收webhook前需要；起步可保留 `.invalid` |

单Bot默认别名是 `default`；单会话同时映射到 `default` 和 `demo-group`。`demo-group` 是示例兼容名称，不能直接找到任何真实群。基础接口也接受原始chat ID，别名注册表不构成完整的目标隔离。

## 高级能力

| 能力 | 还需要什么 |
|---|---|
| 字节上传 | 独立上传开关、精确Bot/chat范围、大小和MIME限制 |
| 持久去重 / 报告队列 | 自己的PostgreSQL、对应迁移和最小运行权限、明确目标范围 |
| 收件箱 / 按钮回调 | HTTPS webhook、批准接收的会话和事件、存储/保留规则 |
| Rich Messages发送 / 编辑 / 流式会话 | 功能开关、媒体范围、持久存储、客户端及Telegram接口支持 |
| 个人账号 / Business / 支付 / Bot管理 | 分别配置和审阅；不是起步必需项，不能一次全开 |

迁移文件位于 `server/migrations/`。先按启用功能选择并审阅，应用不会自动执行。迁移管理员和运行服务应使用不同权限；不要把生产数据库凭据交给测试实例。

任何 `.invalid` 值都是故意不可用的占位符。候选不会替你连接旧私有服务；不得把原服务地址或凭据补回分享包。
