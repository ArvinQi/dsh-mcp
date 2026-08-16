# 更新日志（Changelog）

**[English](CHANGELOG.en.md) | 简体中文**

本项目的所有重要变更都会记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 新增

- **进程级环境变量**：Settings → MCP 页新增「进程环境变量」配置区（全局 KV，跨所有服务器，默认展开，支持批量添加与加载失败重试）；MCP 服务器请求头 value 可直接写 `变量名` 或 `${变量名}` 引用，连接时自动替换为配置值（替换优先级：服务器 env > 进程级 env > 系统环境变量）；secret 值写入凭据文档，留空保留原值
- **页面布局**：注入模式置顶 → 环境变量模块（默认展开）→ MCP 配置模块；添加/编辑服务器表单内联展示在列表上方（列表始终可见）；JSON 配置面板展开时隐藏 UI 列表，应用后自动恢复列表
- **服务器表单不再编辑环境变量**（由进程级环境变量统一管理）：保存时不提交 env，已有服务器 env 保持不变（JSON 配置编辑器仍可全量编辑 env）
- **请求头环境变量替换**：`streamable-http` 服务器的请求头 value 支持 `${ENV}` 占位符与裸变量名，连接时按该服务器配置的环境变量（含 secret，从凭据文档解析）、进程级环境变量或进程环境替换（如 `Authorization: Bearer ${TOKEN}`）；未匹配的占位符原样保留，避免误清空
- **HTTP 服务器环境变量配置**：streamable-http 服务器现在同样提供环境变量配置区（此前仅 stdio），作为请求头替换的来源；JSON 配置编辑器已天然支持
- **JSON 维护服务器配置列表**：Settings → MCP 页新增「JSON 维护配置」面板，以纯 JSON 数组查看/编辑**全部 MCP 服务器配置**（serverName / transport / enabled / url / command / args / cwd / headers / 超时 / failOnStartupError / env）；应用时按列表全量替换——已列出的服务器创建或更新、未列出的删除（host 新增 `upsertJson` 批量方法，点应用直接保存），保存后自动刷新服务器列表与工具列表
- 服务器列表导出（`list`）中的非 secret 环境变量值随配置返回，可随 JSON 往返编辑；secret 值仍只存凭据文档（导出仅 `configured` 标记，留空保留原值）

### 修复

- **OAuth token 刷新失效后不再触发授权**（JSON 保存/重启后 OAuth 服务器连接失败且不弹浏览器）：根因是 OAuth client（client_id）未持久化——每次进程重新动态注册新 client，token 刷新被服务器以 `client_id mismatch` 拒绝，且 SDK 要求的 `invalidateCredentials` 未实现导致 token 无法清除、重试仍失败。修复：client 信息随 token 持久化（凭据文档），并实现 `invalidateCredentials`，失效后自动进入新的浏览器授权流程

## [1.3.0] - 2026-08-16

### 新增

- **Windows 工作目录支持**：stdio 服务器的 cwd 接受 Windows 盘符绝对路径（如 `C:\Users\...`、`C:/...`），与 POSIX `/`、UNC `\\` 路径一致（PR #2，感谢 @coding-chong）

### 修复

- 表单操作失败时展示真实错误信息：保存 / 删除 / 测试连接失败不再只显示笼统文案，直接展示 `code: message`（如 `MCP_SERVER_NAME_CONFLICT: serverName "x" is already used...`），便于定位问题
- 刷新与保存/删除解耦：`refresh()` 失败不再误报保存结果，停留编辑页并显示刷新失败原因（`refresh()` 保留 try/catch 并返回结果）
- 清理死代码：移除已无引用的 `failureLocaleKey`（错误展示改为直接显示 `code: message`）

## [1.2.0] - 2026-08-16

### 新增

- **OAuth 认证支持**：`streamable-http` 服务器支持 MCP OAuth（授权码 + PKCE），连接时自动打开浏览器授权；token 持久化（凭据文档）并由 SDK 自动刷新（24 小时内活跃自动续期）（`lib/oauth.js`）

### 修复

- OAuth token 凭据引用名与服务器名中的连字符冲突导致 `resolve` 校验失败（凭据引用名仅允许 `[A-Za-z_][A-Za-z0-9_]*`）：引用名改为清洗后的服务器名 + 稳定哈希，避免非法字符与命名碰撞
- OAuth 交互授权探测预算从 90 秒提升到 5 分钟：首次授权需在浏览器完成登录/同意，慢于 90 秒会导致探测提前超时并误报连接失败（授权其实已成功、token 已保存），现授权完成后测试结果会自动展示
- 禁用状态的服务器不再重复展示两个「未启用」徽标（badge 与补充文案叠加）
- 设置页 primary 按钮（添加/保存）与「连接中」徽标使用了不存在的主题 token，导致文字颜色异常：改用 web shell 真实主题 token（`--dsw-alias-button-primary-fill` / `--dsw-alias-label-primary-foreground` / `--dsw-alias-brand-primary`）

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
