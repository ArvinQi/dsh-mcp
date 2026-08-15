# 更新日志（Changelog）

**[English](CHANGELOG.en.md) | 简体中文**

本项目的所有重要变更都会记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.0.0] - 2026-08-15

首个正式版本。

### 新增

- **MCP 服务器托管**（host 半部，`lib/index.js`）：
  - 持久化服务器注册表（storage-domain `mcp_servers`）
  - 按服务器挂载 `@deepseek-ai/dsh-mcp-client` 实例，工具以 `mcp__<serverName>__<tool>` 注册
  - 环境变量注入（明文入定义、secret 走凭据文档）
  - 连接探测（test）
- **Web 设置管理页**（client 半部，`src/client/*`）：
  - Settings → MCP：服务器列表 / 新建 / 编辑 / 删除 / 测试连接
  - 服务器级启用 / 禁用（禁用后工具即时注销）
  - 每服务器刷新按钮（重新拉取服务器状态与工具列表）
- **工具控制**：
  - 注入模式：`search`（按需检索，默认，模型通过 `mcp_tool_search` 热注入）与 `full`（全量注入）
  - 每服务器展开工具列表，默认全选，可取消勾选指定加载部分工具，立即生效
- **Remote 自挂载**：client 半部在 `apply()` 内自行 `ctx.remote.$mount()` 挂载 `mcpManager` 命名空间，无需任何 in-box 包改动
- 零 npm 运行时依赖（`@deepseek-ai/*` 从 DSH profiles 模块解析）
