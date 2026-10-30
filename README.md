# TET for Magpie

Magpie 的 TET 中转供应商插件，支持 GPT-5/6 模型发现、OpenAI Responses 转发、余额与用量查询。无运行时依赖，无需构建。

## 安装

在 Magpie 插件页面添加：

```text
github:xgxg-mdl/magpie-tet#main
```

或使用 CLI：

```bash
magpie plugin add github:xgxg-mdl/magpie-tet
magpie plugin login tet
```

## 使用

在 **TET** 供应商中填写 **API base URL** 和 **API Key**，随后选择 `tet/<模型 ID>`。

地址需包含服务实际的 API 前缀，例如 `https://relay.example/v1`，插件不自动补 `/v1`。建议使用 HTTPS；HTTP 会明文传输 Key 和请求内容。

插件通过 TET 中转站的 `/models` 获取模型、`/responses` 转发请求、`/usage` 查询余额与用量。目前支持 GPT-5/6 文本模型，不支持 Claude/Gemini 专用协议、图片生成、音频或实时模型。

供应商设置中的 **Show traffic statistics** 可控制流量统计展示。

## 配置

一般无需额外配置。高级选项在 Magpie 插件包的 `options` 中设置，修改后重载插件：

| 选项 | 默认值 | 用途 |
| --- | --- | --- |
| `queryTimeoutMs` | `15000` | 模型及用量查询超时，单位毫秒 |
| `showTraffic` | `true` | 流量统计开关初始值 |
| `excludeModels` | `[]` | 按模型 ID 隐藏模型 |
| `modelOverrides` | `{}` | 配置模型名称、容量、能力和推理档位 |

## 开发

```bash
bun test
bun run check
```

配置示例和测试命令见[实现与验证](docs/功能/中转服务插件/架构设计文档/实现与验证.md)。
