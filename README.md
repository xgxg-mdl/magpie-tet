# TET for Magpie

Magpie 的 TET 供应商插件，支持账号模型发现、模型调用、钱包与用量查询，以及 TET CodePlane 共享额度展示。

## 安装与更新

在 Magpie 插件页面输入：

```text
github:xgxg-mdl/magpie-tet
```

也可使用 CLI：

```bash
magpie plugin add github:xgxg-mdl/magpie-tet
magpie plugin login tet
```

Magpie 通过 Bun 直接加载仓库中的 TypeScript 入口，安装时无需构建。上面的地址跟随默认分支，Magpie 会检测后续提交，用户可在插件页更新或运行 `magpie plugin update`。如需固定版本，使用 `github:xgxg-mdl/magpie-tet#v1.0.0`。版本说明和独立构建包见 [GitHub Releases](https://github.com/xgxg-mdl/magpie-tet/releases)。

## 登录与使用

在 **TET** 供应商中选择登录方式，登录后使用 `tet/<模型 ID>`：

| 登录方式                   | 所需信息                                 | 可用数据                                          |
| -------------------------- | ---------------------------------------- | ------------------------------------------------- |
| **TET CodePlane 账号登录** | CodePlane 地址、账号、密码；网关地址可选 | 模型调用、钱包与 Key 用量、账号可见分组的共享额度 |
| **API Key**                | 网关地址、Key                            | 模型调用、钱包与 Key 用量                         |

账号登录会自动取得网关 Key；网关地址可自动获取，也可手动填写。CodePlane 地址与网关地址分别填写。账号、密码和会话保存在该登录项的宿主认证数据中，用于恢复登录。

网关纯站点地址会自动补 `/v1`，已有 API 路径保持不变。建议使用 HTTPS；HTTP 会明文传输凭据与请求内容。

供应商设置中的 **Show traffic statistics** 控制流量统计展示。模型协议、容量和能力等高级配置见[登录与配置](https://github.com/xgxg-mdl/magpie-tet/blob/main/docs/configuration.md)。

## 支持范围

- 发现账号可见的模型，支持配置 Responses、Chat Completions、Anthropic Messages 和 Gemini GenerateContent 协议。实际可用能力取决于服务和模型，见[实测记录](https://github.com/xgxg-mdl/magpie-tet/blob/main/docs/capabilities.md)。
- 展示钱包、密钥与订阅限额、消费及流量统计。CodePlane 登录额外展示分组和上游共享额度。
- 共享额度不代表当前 Key 独占资源，也不参与路由；共享额度查询失败时，正常的钱包和消费仍会保留。
- 不提供独立的图片生成、音频或实时接口。

## 开发

使用 proto 管理的 Node.js 24.13.1 和 Bun 1.3.13：

```bash
proto install
bun install --frozen-lockfile
bun run check
bun test
```

开发环境和验证命令见[开发与验证](https://github.com/xgxg-mdl/magpie-tet/blob/main/docs/development.md)，发版步骤与 CHANGELOG 规则见[发布指南](https://github.com/xgxg-mdl/magpie-tet/blob/main/docs/releasing.md)，模块职责见[架构说明](https://github.com/xgxg-mdl/magpie-tet/blob/main/docs/architecture.md)，数据归属见[领域术语](https://github.com/xgxg-mdl/magpie-tet/blob/main/GLOSSARY.md)。
