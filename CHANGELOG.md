# 更新记录

## Unreleased

- 移除模型品牌、版本和模态名称过滤，保留账号模型目录；支持按模型配置 Responses、Chat Completions、Messages 和 Gemini 协议及输入输出模态，兼容默认 Responses。
- 新增 TET CodePlane 账号登录、网关 Key 自动获取和会话恢复；保留已有 TET CodePlane 绑定的读取兼容。
- 动态发现账号可见的分组及关联上游，展示共享周期额度、重置次数和分组并发。
- 收敛为 TET CodePlane 账号登录和 API Key 两种方式，分开处理 TET CodePlane 会话和网关认证。
- 按认证、额度读取和展示拆分 TET CodePlane 模块，集中联调脚本，保持插件入口与命令兼容。
- 按配置、架构、开发验证与能力证据重组文档，合并领域术语；本地测试材料继续忽略且不随发布包交付。

## 0.1.0 · 2026-10-30

- 首次发布 TET 供应商插件，支持 API 地址与 Key 登录。
- 提供 GPT-5/6 模型发现、Responses 转发及余额与用量查询。
- 支持模型配置和流量统计开关，无运行时依赖。
