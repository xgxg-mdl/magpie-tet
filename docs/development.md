# 开发与验证

## 工具链

项目使用 proto 管理的 Node.js 24.13.1、Bun 1.3.13 和已提交的 `bun.lock`。从仓库根目录安装依赖：

```bash
proto install
bun install --frozen-lockfile
```

源码使用 TypeScript，无运行时依赖。模块职责见[架构说明](architecture.md)，用户操作见[登录与配置](configuration.md)。

## 常规验证

```bash
bun run format:check
bun run check
bun test
```

`check` 在 `package.json` 中依次编排本地材料隔离、架构依赖、脚本语法及构建（包含源码与测试类型检查），无需重复运行 `typecheck` 或 `build`。发布包验证另用 `bun run check:release`，复用已有构建，准备一次发布目录及归档，检查白名单、源码文件一致性和隔离 Node.js 加载。格式调整使用 `bun run format`。

Husky 的 `pre-commit` 先执行 `check:local-materials`，阻止已跟踪或强制暂存的本地材料进入后续步骤，再格式化暂存文件、执行 `check` 和测试。`check` 保留本地材料检查，供手动运行和 CI 独立使用。`commit-msg` 只执行 `check:commit-message`，提交信息格式见 [AGENTS.md](../AGENTS.md#提交规范)。

按需单独执行：

| 命令                            | 用途                                           |
| ------------------------------- | ---------------------------------------------- |
| `bun run typecheck`             | 检查源码与测试类型                             |
| `bun run build`                 | 检查类型并重建本地产物                         |
| `bun run check:build`           | 核对已有产物与源码、图标一致                   |
| `bun run check:architecture`    | 检查生产依赖、模块方向及包含类型引用的循环依赖 |
| `bun run check:local-materials` | 检查本地材料忽略规则与 Git 索引隔离            |
| `bun run check:syntax`          | 用 Node.js 检查工程脚本语法                    |
| `bun run check:release`         | 从已有构建准备发布目录、归档并完成包检查       |
| `bun run check:package`         | 检查已准备的发布归档、文件一致性及隔离加载     |

脚本按用途分目录：`scripts/checks/` 保存工程检查，`scripts/release/` 保存发布准备与发布操作，`scripts/host/` 保存使用合成上游的宿主沙箱，`scripts/diagnostics/` 保存需要显式运行的真实服务诊断。构建和图标同步入口保留在 `scripts/` 根目录。`test:host` 和 `test:relay` 按需执行，不属于默认离线检查。

模块测试与实现放在同模块的 `__tests__/`；跨模块钩子与 CLI 验证放在 `test/integration/`，工具约定测试放在 `test/tooling/`。跨模块合成数据放在 `test/fixtures/`，断言和 Fetch mock 放在 `test/support/`。生产类型检查排除测试目录；测试配置将它们单独纳入。

常规测试使用合成上游，不访问真实服务。提交钩子不执行发布包检查；测试 CI 在常规检查和测试后执行 `check:release`。发布包检查将实际交付归档解到临时目录，验证入口后清理，不再使用 npm/Bun 打包流程。它不代表真实服务或桌面安装已经验证。

## 类型与构建

Magpie 从 GitHub 仓库安装源码，使用 Bun 直接加载清单中的 `src/index.ts`，不执行安装脚本，也不需要现场构建。独立构建包的清单指向 `dist/index.mjs`；两种入口都只导出 `TetPlugin`。源码按 Node.js 22 类型和标准 Web API 检查，测试另加载 Bun 类型。两者均启用严格检查、索引缺失和精确可选属性，不跳过依赖声明检查。声明依赖固定版本，升级时重新验证兼容性。

构建将内部模块合并为单个 ESM 入口，生成 sourcemap、保留函数名并内嵌图标。构建禁用环境变量注入；产物不使用 Bun 专属运行时接口。`dist/` 与 `.release/` 是忽略的生成目录，不随源码提交。

独立构建包只含 `dist/`、`package.json`、README 和许可证，移除开发依赖、包管理器与生命周期脚本。它作为 GitHub Release 附件提供，不参与 Magpie 的仓库安装及更新。图标来源为 `assets/logo.svg`，修改后运行 `bun run sync-icon`；`check:package` 会核对包元数据图标一致性。

## 宿主沙箱验证

使用与发布工作流一致的 Magpie 宿主提交：`3cabaab54fa2d6c77bbc491942d2ada9e2535577`。先构建，再下载固定宿主源码，验证工作区与实际发布包：

```bash
bun run build
gh api 'repos/yetone/magpie/contents/internal/plugin/host.js?ref=3cabaab54fa2d6c77bbc491942d2ada9e2535577' \
  -H 'Accept: application/vnd.github.raw+json' > /tmp/tet-magpie-host.js
bun run test:host /tmp/tet-magpie-host.js
bun run release:prepare
bun run check:package /tmp/tet-magpie-host.js
```

`test:host` 加载工作区源码；包检查对实际交付归档的解包目录运行宿主沙箱。验证使用隔离目录、合成凭据和模拟上游，覆盖加载、认证保存、账号隔离、用量及显式历史和工具结果的转发。它不能证明实际桌面 SDK 的完整请求构造行为。

升级固定宿主版本时，同步更新发布工作流和本节命令，并记录实际验证的提交。

## 真实服务诊断

```bash
bun run test:relay --help
```

诊断只从环境变量读取 `TET_BASE_URL` 和 `TET_API_KEY`，不读取凭据文件。Key 通过终端不回显输入注入，避免进入命令历史。诊断不输出 Key、响应正文或生成文本，不自动重试或更换模型。

| 命令                                                  | 行为                                                  |
| ----------------------------------------------------- | ----------------------------------------------------- |
| `bun run test:relay`                                  | 只查询模型与用量                                      |
| `bun run test:relay --allow-http`                     | 明确允许 HTTP 明文连接                                |
| `bun run test:relay --generate --model your-model-id` | 额外发送 JSON 与 SSE 请求，最多两次生成，可能产生消费 |

HTTP 生成检查也必须加 `--allow-http`。需要额外能力检查时：

```bash
bun run test:relay --generate --model your-model-id --tools --structured
```

`--tools` 增加工具调用和结果回传两次请求，`--structured` 增加严格 JSON Schema 一次请求；都必须显式启用生成并指定模型。全部成功时最多五次生成，任一步失败即停止。HTTP 200 本身不算语义验证通过。

正式入口不覆盖图片、Compact、采样控制和服务端存储。工具回传使用显式历史，不依赖 `previous_response_id`。真实服务结果及未验证范围见[服务能力](capabilities.md)。诊断只保留安全分类、状态码和经过校验的重试时间。

## GitHub 发布

发布由 `.github/workflows/release.yml` 在推送 `vX.Y.Z` 源码标签后触发，标签必须与 `package.json.version` 完全一致，只接受稳定的三段版本号。维护顺序为：

1. 更新版本与 `CHANGELOG.md`，完成审查和常规验证，将源码提交推送到 `main`。
2. 在该源码提交上创建并推送 `vX.Y.Z` 标签。
3. 确认发布工作流完成后，核对 GitHub Release、构建包及清单中的 `gitHead`，再验证源码安装和入口加载。

工作流执行冻结安装、格式检查、`check`、全量测试及固定宿主沙箱。`check` 只构建一次，`release:prepare` 从已有构建创建 `.release/package/` 和 `.release/TET-vX.Y.Z.tar.gz`，并将更新记录对应版本提取到 `.release/notes.md`。归档时间固定，同内容重跑产生相同字节。随后验证源码入口和归档入口，使用 GitHub CLI 创建正式 Release、上传构建包并标为 Latest；不生成产物提交或产物分支。

每版只有一个 `vX.Y.Z` 源码标签，同名 GitHub Release 提供说明和固定版本构建包。工作流在 Release 已存在时验证源码 SHA 并下载附件逐字节比较，不覆盖已有内容；相同版本、源码和产物可安全重跑。若上传中断留下草稿，先排查并删除未完成草稿，再重跑工作流。发布身份需要仓库 `contents: write` 权限。

默认安装地址跟随 `main`，因此主分支只合入可供用户使用的修改；开发中的改动在独立分支审查。Magpie 根据仓库提交变化识别更新，不会自动选择最新 Release 的附件。固定版本使用 `#vX.Y.Z`，安装地址见 [README](../README.md#安装与更新)。

## JSDoc 规范

生产源码的导出函数、类型、常量和业务字段使用中文 JSDoc。说明契约和限制，不描述开发过程，不重复 TypeScript 类型。

- 类型说明数据归属、适用状态和关键不变量；字段注明单位、范围、默认或缺失语义。`null` 与 `undefined` 含义不同的字段分别说明。
- 函数用 `@param` 描述参数与前置条件、`@returns` 描述结果、`@throws` 描述实际可见错误；异步错误对应 Promise 拒绝。
- 并发合并、缓存、重试、取消与凭据保存等约束写在所属接口。复杂用法才需要 `@example`，示例只使用合成数据。
- 私有实现只注释不直观的业务约束；注释不得承诺未验证行为，也不通过 `any` 或类型断言替代外部校验。

修改契约时同步更新类型、JSDoc、调用方与行为测试，审查其单位、可选值、错误分类和副作用是否一致。

## 开发参考

- [Magpie 插件开发规范](https://usemagpie.ai/docs/zh/plugins)：核对宿主接口，结合目标宿主版本验证。
- [Magpie 社区插件](https://github.com/magpie-community/plugins)：参考实现思路，不作为 TET 服务能力的依据。

## 文档与本地材料

文档各自维护一个主题：README 为使用入口，[配置说明](configuration.md)记录操作与选项，[架构说明](architecture.md)记录模块及运行约束，[领域术语](../GLOSSARY.md)统一含义，[能力记录](capabilities.md)保留带日期的实测证据，[更新记录](../CHANGELOG.md)记录版本变化。

本机环境、凭据、探索脚本和报告保留在 `docs/local/`。`pre-commit` 和 `check` 均通过 `check:local-materials` 调用 `scripts/checks/local-materials.mjs`，验证 Git 与 Prettier 的整目录忽略规则生效，并拒绝索引中已有的跟踪或强制暂存文件；包白名单校验阻止本地材料进入发布包。检查不读取本地材料内容，也不要求 CI 存在该目录。

需要时按本地 README 选择探测；公开能力记录只接受脱敏结论，不复制私有环境值或原始响应。报告可清理，后续探测自动重建目录。

整理本地材料时保留 `docs/local/` 根路径与整目录忽略规则；移动公开文档或运行时代码后，检查本地索引及探索脚本的相对路径，并确认本地文件未进入暂存区或发布包。

`design/icons/` 保存图标设计材料，不是运行时依赖；`preview.svg.png` 衍生产物保持忽略。
