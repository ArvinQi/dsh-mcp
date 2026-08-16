# 更新日志（Changelog）

**[English](CHANGELOG.en.md) | 简体中文**

本项目的所有重要变更都会记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 新增

- **OAuth 认证支持**：`streamable-http` 服务器支持 MCP OAuth（授权码 + PKCE），连接时自动打开浏览器授权；token 持久化（凭据文档）并由 SDK 自动刷新（24 小时内活跃自动续期）（`lib/oauth.js`）

### 修复

- OAuth token 凭据引用名与服务器名中的连字符冲突导致 `resolve` 校验失败（凭据引用名仅允许 `[A-Za-z_][A-Za-z0-9_]*`）：引用名改为清洗后的服务器名 + 稳定哈希，避免非法字符与命名碰撞
- OAuth 交互授权探测预算从 90 秒提升到 5 分钟：首次授权需在浏览器完成登录/同意，慢于 90 秒会导致探测提前超时并误报连接失败（授权其实已成功、token 已保存），现授权完成后测试结果会自动展示
- 禁用状态的服务器不再重复展示两个「未启用」徽标（badge 与补充文案叠加）

### 优化

- 测试连接（streamable-http）期间提示浏览器授权：若弹出授权页，完成授权后返回，结果自动刷新
- 保存服务器后自动延迟刷新列表状态，挂载完成后「连接中」自动变为「已连接」

## [1.1.0] - 2026-08-15

### 新增

- **工具列表稳定化**：同一连接的 re-sync（如 `tools/list_changed` 通知）时，未变化的 MCP 工具保留原注册，不再反复注销/重注册，保持系统提示词工具列表稳定以提升 prompt cache 命中率（vendored `lib/mcp-client.js` 扩展）

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
