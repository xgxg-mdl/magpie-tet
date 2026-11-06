# TET for Magpie

Magpie 的 TET 中转供应商插件，支持 GPT-5/6 模型发现、OpenAI Responses 转发、余额与用量查询。无运行时依赖，无需构建。

TET CodePlane 提供账户认证、网关配置与共享资源查询，插件通过它取得账号登录信息和共享额度。

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

## 登录与使用

在 **TET** 供应商中选择登录方式，随后选择 `tet/<模型 ID>`：

| 方式                       | 所需信息                                          | 可用数据                                                   |
| -------------------------- | ------------------------------------------------- | ---------------------------------------------------------- |
| **TET CodePlane 账号登录** | TET CodePlane 地址、账号、密码；网关 API 地址可选 | 模型调用、钱包、Key 消费与流量，以及账号可见分组的共享额度 |
| **API Key**                | 网关 API 地址、Key                                | 模型调用、钱包、Key 消费与流量                             |

TET CodePlane 账号登录会自动取得网关 Key；网关地址可使用服务端返回值或显式填写。TET CodePlane 与网关可使用不同地址，账号登录需要支持动态登录问题和密码问题的 Magpie。账号、密码和会话保存在该登录项的宿主认证数据中，用于会话恢复。

填写站点地址（如 `https://relay.example`）时自动补齐 `/v1`；完整 API 地址和自定义路径会保留。建议使用 HTTPS；HTTP 会明文传输凭据和请求内容。

TET CodePlane 共享额度来自登录账号可见的分组及上游，不代表当前 Key 独占的额度，也不参与路由。TET CodePlane 查询失败时，正常的钱包和消费仍会保留。原先将 API Key 与 TET CodePlane 共享额度绑定的入口已移除，已有绑定继续读取和恢复；切换登录方式的行为见[登录与配置](https://github.com/xgxg-mdl/magpie-tet/blob/main/docs/configuration.md)。

供应商设置中的 **Show traffic statistics** 可控制流量统计展示。高级选项在插件包的 `options` 中设置，修改后重载插件：

| 选项             | 默认值  | 用途                               |
| ---------------- | ------- | ---------------------------------- |
| `queryTimeoutMs` | `15000` | 模型及用量查询超时，单位毫秒       |
| `showTraffic`    | `true`  | 流量统计开关初始值                 |
| `excludeModels`  | `[]`    | 按模型 ID 隐藏模型                 |
| `modelOverrides` | `{}`    | 配置模型名称、容量、能力和推理档位 |

## 支持范围

插件通过 `/models` 发现 GPT-5/6 文本模型，通过 `/responses` 转发请求，通过 `/usage` 查询余额与用量。不提供 Claude/Gemini 专用协议、图片生成、音频或实时模型入口。

模型目录不保证所有能力可用。插件优先采用显式配置和宿主已有信息，未知能力默认不声明；工具调用、图片输入等实测范围见[服务能力与验证边界](https://github.com/xgxg-mdl/magpie-tet/blob/main/docs/capabilities.md)。

## 开发

使用 proto 管理的 Node.js 22 和 Bun 1.3.13：

```bash
proto install
bun install --frozen-lockfile
bun run format:check
bun test
bun run check
```

安装开发依赖后，Husky 会在提交前格式化暂存文件并执行包检查和测试，同时校验提交信息格式。开发、宿主测试与真实服务诊断见[开发与验证](https://github.com/xgxg-mdl/magpie-tet/blob/main/docs/development.md)，模块职责和行为约束见[架构说明](https://github.com/xgxg-mdl/magpie-tet/blob/main/docs/architecture.md)，数据归属见[领域术语](https://github.com/xgxg-mdl/magpie-tet/blob/main/GLOSSARY.md)。
