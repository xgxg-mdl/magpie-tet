# 开发与验证

## 工具链

Node.js 和 Bun 由 proto 管理，项目使用 Node.js 22、Bun 1.3.13 和已提交的 `bun.lock`。从仓库根目录安装：

```bash
proto install
bun install --frozen-lockfile
```

运行时代码使用原生 ESM，不需要构建，也没有运行时依赖。公开包入口是 `index.mjs`，目录职责见[架构说明](architecture.md)。

## 离线检查

```bash
bun run format:check
bun test
bun run check
```

`format:check` 使用 Prettier 检查格式。测试使用模拟上游，覆盖账号登录与恢复、动态分组、用量映射、模型能力、请求转发和安全诊断。

`check` 递归校验 `src/`、`scripts/` 和入口语法，检查供应商身份及图标一致性；在临时目录打包，精确检查发布文件白名单，并用 Node.js 加载打包后的入口，完成后清理临时文件。这些检查不代表真实服务或桌面安装已验证。

CI 使用 Node.js 22 和 Bun 1.3.13，依次执行锁文件冻结安装、格式检查、包检查和测试。

安装开发依赖时启用 Husky。提交前格式化暂存文件并执行包检查和测试，提交信息使用 `type(scope): 中文行为描述` 的 Conventional Commits 格式。提交应包含同一问题对应的代码、测试和文档；未执行的检查不要写成已通过。

## 宿主沙箱检查

入口为 `scripts/smoke/host.mjs`，命令保持 `test:host`。检查使用独立临时目录和合成凭据，需要先取得宿主源码：

```bash
gh api repos/yetone/magpie/contents/internal/plugin/host.js \
  -H 'Accept: application/vnd.github.raw+json' > /tmp/magpie-host.js
bun run test:host /tmp/magpie-host.js
```

这会验证插件在该宿主源码下的加载、认证、用量及请求传递。宿主沙箱核对显式多轮历史与工具结果在宿主、插件、上游之间保持不变，但不能证明实际桌面 SDK 构造请求的全部行为。记录验证结论时应同时记录使用的宿主版本或提交。

## 真实服务诊断

入口为 `scripts/smoke/relay.mjs`，命令保持 `test:relay`：

```bash
bun run test:relay --help
```

脚本只读取 `TET_BASE_URL` 和 `TET_API_KEY` 环境变量，不读取凭据文件。Key 应通过终端不回显输入注入，不放入命令历史或仓库。真实服务结果与已验证边界见[服务能力](capabilities.md)。

| 命令                                                  | 行为                                                           |
| ----------------------------------------------------- | -------------------------------------------------------------- |
| `bun run test:relay`                                  | 只查询模型与用量                                               |
| `bun run test:relay --allow-http`                     | 显式允许 HTTP 明文连接                                         |
| `bun run test:relay --generate --model your-model-id` | 额外发送非流式和流式 Responses，最多两次生成请求，可能产生消费 |

HTTP 服务的生成检查也必须加 `--allow-http`。诊断不输出 Key、响应正文或生成文本，不自动重试，也不自动更换模型。默认生成检查只覆盖文本 JSON 和 SSE。

显式生成模式可增加能力检查，全部通过时最多发送五次生成请求：

```bash
bun run test:relay --generate --model your-model-id --tools --structured
```

`--tools` 额外检查函数调用及结果回传，共两次请求；`--structured` 额外检查严格 JSON Schema 的基本行为，共一次请求。两者都必须和 `--generate --model` 一起使用；任一步失败即停止。工具参数和结构必须符合预期，HTTP 200 本身不算能力验证通过。

工具结果回传使用显式历史，不依赖 `store` 或 `previous_response_id`。图片、Compact、采样控制和服务端存储不属于正式诊断检查，不能从文本检查通过推断这些能力可用。

诊断区分认证、限流、上游、模型不可用、超时和网络故障，保留状态码及经过校验的 `Retry-After`，不展示上游原文。模型不可用只识别有界 JSON 错误中的固定 `model_not_found` 代码，其余错误不猜测原因。

## 文档与本地材料

| 文件                    | 维护内容                                     |
| ----------------------- | -------------------------------------------- |
| `README.md`             | 安装与使用入口                               |
| `GLOSSARY.md`           | 账户、密钥、钱包、分组、上游和额度的统一术语 |
| `docs/configuration.md` | 登录方式、地址、配置和数据归属               |
| `docs/architecture.md`  | 模块职责、认证生命周期、请求与用量约束       |
| `docs/capabilities.md`  | 带日期和条件的能力证据及未验证范围           |
| `CHANGELOG.md`          | 发布记录和当前未发布变更                     |

本机环境、凭据、探索脚本和诊断报告保留在整个被 Git 忽略的 `docs/local/`，不随源码或发布包交付。公开文档只记录脱敏结论，不复制私有环境值或原始响应；本地 `runs/` 报告可以按需清理，后续探测会自动重建目录。

整理本地材料时保留 `docs/local/` 根路径，以及 `.gitignore`、`.prettierignore` 的整目录规则。移动公开文档或运行时代码后，同步检查本地索引和探索脚本的相对路径。验收时确认忽略规则继续命中、本地文件没有进入暂存区，且发布包不包含本地材料。

`assets/logo.svg` 是正式图标来源，修改后运行 `bun run sync-icon` 并执行包检查。`design/icons/` 是设计探索历史，不作为运行时图标依赖；其中 `preview.svg.png` 衍生产物继续忽略。
