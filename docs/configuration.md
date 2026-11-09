# 登录与配置

## 登录方式

登录后选择 `tet/<模型 ID>`。需要共享额度时使用 **TET CodePlane 账号登录**，只需模型调用与钱包用量时可使用 **API Key**。

### TET CodePlane 账号登录

填写 **TET CodePlane 地址**、**TET CodePlane 账号** 和 **TET CodePlane 密码**。网关 API 地址可留空，由账号配置自动取得；也可手动填写以覆盖自动配置。CodePlane 地址与网关地址分别填写，可以属于不同站点。

登录成功后，插件自动取得该账号的网关 Key。自动获取地址失败时，可手动填写网关 API 地址后重新登录。

账号、密码及会话保存于该登录项的宿主认证数据中，用于自动恢复会话；不会写入日志或用量结果。模型调用始终使用网关 Key。恢复后的 Key 随账户返回值更新，网关地址保持用户确认的值；身份发生变化时需要重新登录。

账号列表默认显示登录时填写的账号名；会话恢复保留自定义账号标签。

### API Key

填写网关 API 地址和 Key 即可，支持模型调用、钱包、Key 消费和流量，不访问 TET CodePlane。

需查看共享额度时选择 TET CodePlane 账号登录。认证数据校验失败时，重新选择登录方式完成认证。

同一登录项改用 **API Key** 时，已保存的 CodePlane 账号、密码和会话随认证替换而移除；其他登录项和网页会话不受影响。

## 地址

纯站点地址（如 `https://relay.example`）会自动补 `/v1`；已有 `/v1` 或自定义路径会保留。非标准网关前缀需填写完整 API 地址。地址不能包含 URL 用户名、密码、查询参数或片段。

网关地址优先使用登录时保存的账号配置，缺失时使用高级选项 `baseURL`。高级选项不会覆盖账号地址。

建议使用 HTTPS。HTTP 会明文传输 Key、CodePlane 凭据和请求内容。

## 用量数据的归属

钱包余额属于用户账户；Key 消费、真实密钥额度与订阅额度分别保留各自范围，不与钱包相加。具体术语见[领域术语](../GLOSSARY.md)。

TET CodePlane 账号登录会随现有用量刷新读取当前账号可见的全部分组和关联上游。分组增删、改名和上游迁移无需重新登录；零分组也可以查看钱包。TET CodePlane 共享周期额度与重置次数按上游展示，并发是整个分组的快照，都不代表当前 Key 的独占资源，也不参与路由。

每个上游分别展示周期用量和重置次数，分组并发展示整个分组的占用与上限。不同来源的百分比和次数不能相加，多个登录项显示同一来源也不代表多份额度。多分组或多来源时，指标名称包含分组或来源名称以便区分。

CodePlane 查询失败或超时时显示辅助状态，不隐藏正常的钱包和消费。过期或缺失的共享读数显示状态，不能按零用量理解。周期命名、宿主汇总及历史曲线的边界见[架构说明](architecture.md#宿主展示约束)。

## 插件选项

供应商设置中的 **Show traffic statistics** 控制流量统计显示，无需修改配置文件。

其他高级选项可通过 Magpie CLI 设置，例如将查询超时改为 10 秒：

```bash
magpie plugin options 'github:xgxg-mdl/magpie-tet' '{"queryTimeoutMs":10000}'
```

高级选项按完整 JSON 对象保存，再次设置会替换原有高级选项；需要保留的设置应一并提供。保存后宿主会重载插件。查看当前设置可运行：

```bash
magpie plugin options 'github:xgxg-mdl/magpie-tet'
```

配置示例：

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
| `baseURL`         | 未设置             | 账号未保存网关地址时使用的回退地址          |

`showTraffic` 是流量显示的初始值；供应商设置中保存的 **Show traffic statistics** 开关优先。

覆盖不会创建目录中不存在的模型。插件不按模型品牌、版本和名称中的模态关键词过滤。容量、协议和档位示例只演示格式，应按服务提供的信息填写。

### 调用协议

模型协议依次使用 `modelOverrides[id].protocol`、宿主已有的已知协议、`defaultProtocol`。默认值是 Responses。目录没有可靠的协议字段时，需要按服务提供的信息配置，不能根据模型名称推断。

| `protocol`             | 调用接口                                                             |
| ---------------------- | -------------------------------------------------------------------- |
| `openai-responses`     | `/responses`、`/responses/compact`                                   |
| `openai-chat`          | `/chat/completions`                                                  |
| `anthropic-messages`   | `/messages`                                                          |
| `google-generative-ai` | `/models/<id>:generateContent`、`/models/<id>:streamGenerateContent` |

路径相对于账号的网关 API 地址；Gemini 若使用 `/v1beta` 等前缀，登录时填写完整 API 地址。协议改变不会自动猜测或替换网关前缀。各账号使用自己的地址与 Key，包级协议及模型覆盖配置由这些账号共用。不同账号需要为同名模型选择不同协议时，当前配置尚不支持账号级覆盖。

生成失败时不会自动更换模型或协议重试。配置某个协议并不表示服务支持它，实际验证范围见[实测记录](capabilities.md)。

### 输入输出模态

`modalities.input` 和 `modalities.output` 各自接受 `text`、`image`、`audio`、`video`、`pdf` 数组。显式配置某个方向时，该数组完整替换此方向的宿主声明，空数组表示不支持这些模态；未配置的方向保留宿主信息，未知时不声明。图片、音频等输出声明还需要调用协议和宿主工作流支持，并不会自动启用专用生成端点。

`imageInput` 布尔选项只覆盖图片输入，不改写其他模态；同时配置 `modalities.input` 时以后者为准。

容量可通过 `modelOverrides[id].limit` 或 `modelLimits[id]` 设置，前者优先，其中 `id` 为真实模型 ID。`modelLimits` 示例为 `{ "your-model-id": { "context": 200000, "output": 32000 } }`，可选 `input`。容量必须为正安全整数，`output` 和可选 `input` 不得超过 `context`。

能力取值依次使用显式覆盖、宿主已有模型信息和保守默认。没有依据时不声明采样控制、推理、工具调用或图片输入。明确配置推理档位可开启推理，但不能覆盖已有的 `reasoning: false`，此时需明确设为 `reasoning: true`；推理关闭时不提供推理档位。

## 模型配置示例

启用模型的工具调用与图片输入：

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
