# 登录与配置

## 登录方式

插件提供 **TET CodePlane 账号登录** 和 **API Key** 两种方式。TET CodePlane 提供账户认证、网关配置与共享资源查询。登录后选择 `tet/<模型 ID>`。

### TET CodePlane 账号登录

填写 **TET CodePlane 地址**、**TET CodePlane 账号** 和 **TET CodePlane 密码**。网关 API 地址可留空，使用登录响应中的 `codexGatewayUrl` 或 `gatewayPublicBaseUrl`；也可显式填写以覆盖服务端地址。TET CodePlane 和网关可以使用完全不同的地址，插件不会从 TET CodePlane 地址猜测网关地址。

插件自动取得该用户的网关 Key；登录响应缺失 Key 时读取 `/api/auth/profile/gateway-config`。服务端必须提供用户标识、有效会话到期时间和可用 Key。此方式需要支持动态登录问题和密码问题的 Magpie。

账号、密码及会话保存于该登录项的宿主认证数据中，用于自动恢复会话；不会写入日志或用量结果。模型调用始终使用网关 Key。恢复后的 Key 随账户返回值更新，网关地址保持用户确认的值；身份发生变化时需要重新登录。

账号列表和登录摘要显示登录时填写的账号名；内部身份标识仍按 TET CodePlane 地址和用户 ID 区分。旧版本保存的哈希账号名会在用量刷新或会话续期时改为已保存的登录账号名，其他已保存的名称保持不变。

### API Key

填写网关 API 地址和 Key 即可，支持模型调用、钱包、Key 消费和流量，不访问 TET CodePlane。

原先将 API Key 与 TET CodePlane 共享额度绑定的入口已移除，已有绑定继续读取和自动恢复，不自动迁移或失效。需要切换时重新选择 TET CodePlane 账号登录；切换后使用该账户返回的 Key，不再沿用旧方式手填的 Key。旧绑定未保存密码时，需要 TET CodePlane 账号登录一次才能启用自动恢复。

同一登录项改用 **API Key** 时，TET CodePlane token、账号和密码随本地认证替换而移除。插件不调用服务端退出接口，也不影响其他登录项或 TET CodePlane 网页。

## 地址

纯站点地址（如 `https://relay.example`）会自动补 `/v1`；已有 `/v1` 或自定义路径会保留。非标准网关前缀需填写完整 API 地址。地址不能包含 URL 用户名、密码、查询参数或片段。

兼容已有配置时，插件包 `options.baseURL` 可作为网关地址回退；已保存账号的 `metadata.baseURL` 优先。包级地址不会覆盖账号地址，也不能通过模型元数据改变请求去向。

建议使用 HTTPS。HTTP 会明文传输 Key、TET CodePlane 凭据和请求内容；正式真实服务诊断需要显式使用 `--allow-http` 才能访问 HTTP 站点。

## 用量数据的归属

钱包余额属于用户账户；Key 消费、真实密钥额度与订阅额度分别保留各自范围，不与钱包相加。具体术语见[领域术语](../GLOSSARY.md)。

TET CodePlane 账号登录会随现有用量刷新读取当前账号可见的全部分组和关联上游。分组增删、改名和上游迁移无需重新登录；零分组也可以查看钱包。TET CodePlane 共享周期额度与重置次数按上游展示，并发是整个分组的快照，都不代表当前 Key 的独占资源，也不参与路由。

多个上游分别展示，不能累加百分比或重置次数，也不能将多个登录项的同一来源理解为多份额度。单分组、单上游账号的周期统一显示为 `5h`、`7d`，按账号额度相同的约定，由宿主对同方案账号的百分比取平均；这不是去重后的共享额度合计。TET CodePlane 查询失败或超时仅显示辅助状态，不隐藏正常的钱包和消费。

TET CodePlane 查询最多使用 5 秒；配置的查询超时更短时使用更短值。不会额外轮询或导入 TET CodePlane 历史曲线。来源变化后的宿主历史曲线隔离不作保证。展示和降级规则见[架构说明](architecture.md)。

## 插件选项

在 Magpie 插件包的 `options` 中设置，修改后重载插件：

```json
{
  "queryTimeoutMs": 15000,
  "showTraffic": true,
  "excludeModels": [],
  "defaultProtocol": "openai-responses",
  "modelOverrides": {
    "your-model-id": {
      "name": "Custom model name",
      "protocol": "openai-chat",
      "limit": { "context": 200000, "output": 32000 },
      "temperature": false,
      "reasoning": true,
      "toolCall": true,
      "modalities": { "input": ["text", "image"], "output": ["text"] },
      "reasoningLevels": ["low", "medium", "high"]
    }
  }
}
```

| 选项              | 默认值             | 约束                                        |
| ----------------- | ------------------ | ------------------------------------------- |
| `queryTimeoutMs`  | `15000`            | 1000–60000 毫秒，仅限制查询，不限制生成时长 |
| `showTraffic`     | `true`             | 流量展示初始值；宿主保存的供应商开关优先    |
| `excludeModels`   | `[]`               | 按真实模型 ID 隐藏模型                      |
| `defaultProtocol` | `openai-responses` | 模型缺少已知协议时的默认协议                |
| `modelOverrides`  | `{}`               | 覆盖已有模型的名称、容量、能力和推理档位    |

覆盖不会创建目录中不存在的模型。插件不按模型品牌、版本和名称中的模态关键词过滤。容量、协议和档位示例只演示格式，应按服务提供的信息填写。

### 调用协议

当前 TET 目录只有模型标识等基础信息，没有可靠的协议或能力字段，插件不根据名称猜测。协议按模型的 `protocol` 显式覆盖、宿主已有模型的已知适配器、`defaultProtocol` 的顺序确定。兼容默认值 Responses 不代表所有模型都支持它；若要覆盖宿主已有适配器，使用模型级 `protocol`。

| `protocol`             | Magpie 适配器               | 网关路径                                                             |
| ---------------------- | --------------------------- | -------------------------------------------------------------------- |
| `openai-responses`     | `@ai-sdk/openai`            | `/responses`、`/responses/compact`                                   |
| `openai-chat`          | `@ai-sdk/openai-compatible` | `/chat/completions`                                                  |
| `anthropic-messages`   | `@ai-sdk/anthropic`         | `/messages`                                                          |
| `google-generative-ai` | `@ai-sdk/google`            | `/models/<id>:generateContent`、`/models/<id>:streamGenerateContent` |

路径相对于账号的网关 API 地址；Gemini 若使用 `/v1beta` 等前缀，登录时填写完整 API 地址。协议改变不会自动猜测或替换网关前缀。各账号使用自己的地址与 Key，包级协议及模型覆盖配置由这些账号共用。不同账号需要为同名模型选择不同协议时，当前配置尚不支持账号级覆盖。

Magpie 根据模型适配器构造请求并转换响应，插件保留正文、流和取消信号，只按协议注入当前账号的认证头。插件不在失败后自动重试、切换协议或模型，也不从目录元数据加载任意 SDK 或修改请求地址。当前站点的实测结果见[服务能力](capabilities.md)。

### 输入输出模态

`modalities.input` 和 `modalities.output` 各自接受 `text`、`image`、`audio`、`video`、`pdf` 数组。显式配置某个方向时，该数组完整替换此方向的宿主声明，空数组表示不支持这些模态；未配置的方向保留宿主信息，未知时不声明。图片、音频等输出声明还需要调用协议和宿主工作流支持，并不会自动启用专用生成端点。

兼容 `imageInput` 布尔选项，但配置 `modalities.input` 时以后者为准。不提供单独的模态配置时，`imageInput` 只覆盖图片输入，不改写其他模态。

兼容旧式容量配置 `modelLimits`，结构为 `{ "your-model-id": { "context": 200000, "output": 32000 } }`，可选 `input`。同一模型同时配置时，`modelOverrides[id].limit` 优先于 `modelLimits[id]`，其中 `id` 为真实模型 ID。容量必须为正安全整数，`output` 和可选 `input` 不得超过 `context`；新配置建议统一写在 `modelOverrides` 中。

能力取值依次使用显式覆盖、宿主已有模型信息和保守默认。没有依据时不声明采样控制、推理、工具调用或图片输入。明确配置推理档位可开启推理，但不能覆盖已有的 `reasoning: false`，此时需明确设为 `reasoning: true`；推理关闭时不提供推理档位。

## 已验证账号的模型示例

对[服务能力](capabilities.md)中已验证的特定服务账号，可按需启用：

```json
{
  "modelOverrides": {
    "gpt-6-luna": {
      "temperature": false,
      "toolCall": true,
      "imageInput": true
    }
  }
}
```

这不是所有同名模型的通用保证，也不随插件自动启用。示例不编造上下文容量或推理档位；模型出现在目录中也不保证实际可调用。
