# 服务能力与验证范围

配置方法见[登录与配置](configuration.md)，验证命令见[开发与验证](development.md)。

## 模型发现与生成

| 能力                       | 实测结果                                                                     |
| -------------------------- | ---------------------------------------------------------------------------- |
| 模型目录                   | 2026-11-06 查询返回 28 个模型，插件使用 Chat 协议配置时发现全部模型          |
| Responses 文本             | JSON 和 SSE 均完成，文本和终止事件正常                                       |
| Responses 工具调用         | 函数名、参数、调用 ID 和工具结果回传通过，可继续生成                         |
| Responses 严格 JSON Schema | 基本结构化输出通过，复杂 Schema 未验证                                       |
| Responses 图片输入         | 固定 PNG 颜色识别通过，复杂视觉未验证                                        |
| Chat Completions 文本      | 2026-11-06 经插件转发，非流式和流式均返回 HTTP 200，取得文本及 `[DONE]` 标记 |
| Anthropic Messages         | 2026-11-06 最小请求使用 `x-api-key` 返回 HTTP 403，未验证通过                |
| Gemini GenerateContent     | 2026-11-06 最小请求使用 `x-goog-api-key` 返回 HTTP 401，未验证通过           |
| Responses Compact          | 返回 HTTP 502、`upstream_error`，未验证通过                                  |

目录包含图片、音频和实时命名模型，但只返回 `id`、`object`、`created`、`owned_by`、`type`、`display_name` 等基础字段，未提供可靠的协议、输入输出模态、容量或价格信息。目录存在某个模型不代表它可以调用：`gpt-5.4-mini` 的一次生成返回 `400 model_not_found`，未逐个测试全部模型。

网关 `/v1/models` 正常，直接请求 `/models` 返回 HTTP 500；不携带认证查询模型返回 HTTP 401。

## CodePlane 登录与网关用量

2026-11-06 的登录与会话查询结果：

- `POST /api/auth/login` 返回用户会话、约八小时有效期、网关 Key 和网关地址，未返回 refresh token。
- `GET /api/auth/profile/gateway-config` 返回的 Key 与登录响应一致。
- 连续两次 `GET /api/auth/me` 返回相同身份，但没有新 token，`tokenExpiresAt` 为零，也未观察到 `Set-Cookie` 或 `Authorization` 响应头。该次查询未提供明确续期结果。

公开 OpenAPI 未声明专用刷新接口。

网关用量实测返回 `mode: unrestricted`、钱包余额、今日与累计消费、流量统计。该账号没有订阅或密钥限额对象，因此**真实订阅与密钥限额尚未验证**。接口还返回 `daily_usage`、`model_stats`、输入／输出及缓存 Token、平均时长等字段，插件未完整展示这些额外统计。

## 参数与账号限制

- **采样温度**：发送 `temperature: 0` 后响应字段为 `temperature: 1`，没有证据确认温度控制有效。
- **推理档位**：`reasoning.effort: low` 请求完成，但简单任务的推理 Token 为零，不足以证明各档位有效。
- **服务端历史**：请求 `store: true` 返回 `store: false`；使用 `previous_response_id` 返回 HTTP 400，并提示需要 OpenAI API-key account。显式历史和工具结果回传已通过。
- **限流**：观察到 HTTP 429，阈值和成因未确认，不能据此判断协议不受支持。
- **消费口径**：Responses 用量包含未由测试请求显式提供的 `instructions` 输入 Token，不能仅按用户短提示长度估算消费，实际收费规则未核实。

## 离线与宿主验证

插件实现四种协议的固定端点转发，由 Magpie 执行协议转换。

离线与宿主模拟覆盖钱包、订阅和密钥限额的组合映射，以及会话恢复逻辑；恢复逻辑能识别明确的新 token 或延长有效期，并在无法续期时使用密码重新登录。宿主沙箱覆盖 Responses 与 Chat 的模型适配器声明、账号隔离和请求转发，不代替桌面端完整生成测试。

宿主协议核对版本为 Magpie 提交 `b020ae10220810991e52cc466b9f47864b6170bf`，依据为 `internal/provider/plugins.go` 的 `pluginProtocol` 和 `internal/plugin/host.js`。固定版本的沙箱验证方式见[开发与验证](development.md#宿主沙箱验证)。

图片生成、音频、实时接口、全部模型与推理档位、容量与价格、长上下文、复杂视觉、并行工具、联网工具和生产稳定性均缺少完整实测证据。
