# TET 服务能力

## TET CodePlane 认证补充验证

验证日期：2026-11-06。使用授权测试账号进行只读登录和会话查询，未调用生成接口。

- `POST /api/auth/login` 返回 TET CodePlane token、约 8 小时的有效期、网关 Key 和网关地址，未返回 refresh token。
- 连续两次 `GET /api/auth/me` 均返回同一用户身份，但未返回 token，`tokenExpiresAt` 为零；未观察到 `Set-Cookie` 或 `Authorization` 响应头。该接口本次未提供可供插件保存的新 token 或延长后的有效期。
- `GET /api/auth/profile/gateway-config` 返回的 Key 与登录响应一致，账号登录后自动取得网关 Key 的接口路径已实测。
- 公开 OpenAPI 未声明 TET CodePlane 专用刷新接口。当前采用密码重新登录恢复会话；插件仍能识别 `/api/auth/me` 将来明确返回的新 token 或延长后的有效期。此次短时查询不能证明服务端不存在未公开接口或内部滑动续期。

## 网关验证范围

验证日期：2026-10-30。以下是特定测试账号与模型的实测结果，不代表所有账号、模型或后续服务版本具有相同能力。不包含服务地址、凭据、账号身份或余额数值。

### 2026-11-06 目录与协议补测

使用本地测试凭证重新查询网关：`GET /v1/models` 返回 200，共 28 个模型，包括图片、音频和实时命名模型。每项仅有 `id`、`object`、`created`、`owned_by`、`type`、`display_name`，其中 `type` 均为 `model`；没有协议或输入输出能力声明，不能据此自动选择协议。

通过修改后插件的模型发现与认证 loader，使用 `openai-chat` 发现全部 28 个模型；以 `gpt-6-luna` 调用 `/v1/chat/completions` 的非流式和流式请求均返回 200，分别取得有效消息文本、有效增量文本与 `[DONE]` 终止标记。此项确认插件实际转发链路可用，不是绕过插件直接请求网关。

以 `gpt-6-luna` 向 `/v1/messages` 使用 `x-api-key` 发送最小请求，返回 403；向 `/v1/models/gpt-6-luna:generateContent` 使用 `x-goog-api-key` 发送最小请求，返回 401。两者均未获得有效生成响应，不证明其他账号、认证方式、模型或 API 前缀下不可用。未重试或扫描全部模型。Responses 和 Chat 的既有成功记录见下表。

插件已提供四种协议的配置与固定端点转发，协议转换由宿主完成。Messages、Gemini 的离线覆盖不等于当前站点已通过真实调用验证。当前目录没有可靠协议元数据，因此不实现自动协商，也不按名称猜测。

## 接口与功能

生成能力以 `gpt-6-luna` 验证；目录和用量按当前测试账号查询。

| 接口／功能                   | 实测结果                                           | 插件范围                                                       |
| ---------------------------- | -------------------------------------------------- | -------------------------------------------------------------- |
| `GET /v1/models`             | 模型目录查询正常，但不提供可靠价格、容量和能力声明 | 发现账号可见的有效模型 ID，不按品牌、版本或模态名称过滤        |
| `GET /v1/usage`              | 返回钱包、今日与累计消费、流量统计                 | 展示余额及消费，流量可关闭                                     |
| `POST /v1/responses`         | JSON 和 SSE 均完成，文本及终止事件正常             | 兼容默认协议，可按模型配置其他协议                             |
| Responses 函数调用           | 函数名、参数和调用 ID 正确，回传结果后可继续生成   | 透明转发；未知模型默认不声明，可配置 `modelOverrides.toolCall` |
| Responses 严格 JSON Schema   | 基本结构化输出测试通过                             | 透明转发；不保证任意复杂 schema                                |
| Responses 图片输入           | PNG 颜色识别基本测试通过                           | 默认不声明；可为已验证模型配置 `modelOverrides.imageInput`     |
| `POST /v1/chat/completions`  | JSON 和 SSE 均通过                                 | 可配置 `openai-chat`                                           |
| `POST /v1/responses/compact` | 本次返回 502、`upstream_error`，未验证通过         | 允许转发路径，不代表上游可用                                   |

纯站点地址需要 `/v1` 前缀；直接请求 `/models` 本次返回 500。插件会为纯站点地址自动补齐 `/v1`，自定义路径保持不变。模型目录接口在不携带认证时返回 401。

## 参数与账号限制

- **模型目录不等于可调用保证**：`gpt-5.4-mini` 在目录中，但一次生成返回 `400 model_not_found`；未逐个测试全部模型。
- **采样参数**：发送 `temperature: 0` 后，返回对象字段为 `temperature: 1`，不能宣称该参数有效控制采样。
- **推理档位**：携带 `reasoning.effort: low` 可完成请求；简单任务的推理 Token 为零，不足以证明各档位均有效。
- **服务端会话**：请求 `store: true` 返回 `store: false`；当前账号使用 `previous_response_id` 返回 400，并提示需要 OpenAI API-key account。显式历史和工具结果回传已通过。
- **限流**：观察到 HTTP 429，阈值和成因未确认；限流不等于协议不支持。
- **用量口径**：Responses 用量报告包含未由测试请求显式提供的 `instructions` 输入 Token，不能仅按用户短提示长度估算消费，实际收费规则未核实。

## 用量及验证边界

当前真实账号返回 `mode: unrestricted` 和钱包余额，没有订阅或密钥额度对象。钱包、订阅、密钥限额及其组合的插件映射已有离线和宿主模拟测试，但真实订阅与密钥限额尚未验证。

用量接口还返回 `daily_usage`、`model_stats`、输入／输出和缓存 Token、平均时长等字段；插件尚未完整展示这些额外统计。

以下内容不在已验证承诺内：图片生成、音频、实时接口、全部模型、全部推理档位、容量与价格、长上下文、复杂视觉、并行工具、联网工具和生产稳定性。模型出现在目录中不能代替实际调用验证。

宿主适配依据：核对 Magpie 提交 `b020ae10220810991e52cc466b9f47864b6170bf` 的 `internal/provider/plugins.go` 中 `pluginProtocol` 和 `internal/plugin/host.js`，确认模型 `api.npm` 到 Responses、Chat、Messages 和 Gemini 的映射，以及输入输出模态的传递。宿主沙箱测试覆盖 Responses 与 Chat 的模型适配器声明、账号隔离和请求转发，不代替桌面端完整生成测试。

本文记录能力边界，不包含环境复现材料。测试地址、凭据、原始诊断结果和临时探测脚本保留在 Git 忽略的 `docs/local/`；通用测试入口及命令见[开发与验证](development.md)，插件配置见[登录与配置](configuration.md)。
