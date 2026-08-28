# 更新日志（Changelog）

**[English](CHANGELOG.en.md) | 简体中文**

本项目的所有重要变更都会记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [1.8.0] - 2026-08-27

### 新增

- **OAuth 授权交互改进**：启动挂载不再自动弹浏览器（需授权时失败并提示，仅测试连接自动弹浏览器）；工具调用发现 token 缺失/过期时返回**可点击的授权链接**（后台回调监听器在稳定端口完成授权，并发请求复用同一流程）；全局授权队列保证同一时间最多一个授权流程
- **挂载失败直接附授权链接**：挂载需要授权时，失败信息直接附带**可点击的授权链接**，打开链接完成授权后 token 自动保存，无需再手动去设置页操作
- **新增 `allowBrowserOnMount` 配置**：默认 `false`（挂载不自动弹浏览器）；设为 `true` 可恢复旧行为（挂载时自动打开浏览器授权）。在 profile 的 `cordis.patch.yml` 中 dsh-mcp 条目下配置
- **stdio 表单参数输入改进**：参数支持 shell 风格解析（空格/换行分隔，支持引号、转义与显式空参数），命令行可直接粘贴即用；参数框下方实时预览解析结果，保存前即可发现参数拆分问题

### 修复

- **OAuth 授权链接未在挂载失败信息中展示**：底层连接错误（含授权链接）此前被塞进 `cause`，挂载失败视图只显示通用文案；现已将详情并入 message
- **OAuth 授权完成后工具不自动注册**：授权保存 token 后按 serverName 自动重挂载对应服务器，工具立即注册，无需手动刷新或重启（此前监听的事件名与凭据服务实际发出的事件不一致，自动重挂载一直未生效，现已修正）
- **授权回调端口冲突导致进程崩溃**：统一按服务器共享回调监听器（同服务器去重），并为所有 listen 增加错误处理——`EADDRINUSE` 不再导致 DSH 进程崩溃
- **授权链接 resource 参数错误**：链接中 `resource=undefined` 会导致授权服务器校验失败；改为传 URL 对象（优先使用 protected-resource 元数据的 resource）
- **stdio 工作目录留空时易踩坑**：表单为 cwd 补充说明——留空会继承 Host 工作目录，若该目录是 pnpm workspace，npx 等命令可能解析到错误的本地包；提示不含具体路径，由使用者自行填写

## [1.7.0] - 2026-08-21

### 新增

- **JSON 配置编辑器改为 key-value 格式**：服务器配置以「服务器名 → 配置对象」的 JSON 对象展示/编辑（`{ "服务器名": { "type": "streamable_http", "url": ..., "headers": {...}, "disabled": false } }`），替代原数组格式；`type` 取值 `streamable_http`/`stdio`，`disabled: true` 表示停用

### 修复

- **MCP 图片 admission 诊断不再误报**：区分图片数量、批量/单图字节数、MIME 类型、Base64、图片格式、解码像素数和最大边长限制；未知 admission 错误使用固定诊断，避免把有效但超尺寸的图片误报为无效图片数据，也不泄露 attachment 存储内部错误（PR #5，感谢 @coding-chong）
- 发布流水线增加 `npm test`（图片投影回归测试）后再校验语法并发布

## [1.6.0] - 2026-08-17

### 新增

- **MCP 工具图片结果**：工具返回的图片内容（image blocks）经附件服务投影为图片引用进入模型上下文，带严格的类型/大小/数量预检与降级文案；非图片内容（audio/resource 等）给出有界文本回退（PR #4，感谢 @coding-chong）

## [1.5.0] - 2026-08-17

### 新增

- **进程环境变量展示/取值 process.env 优先**：变量存在 process.env 时按同名取真实值（不改名），存储值作为兜底；界面功能不变（值输入、secret 保留），非 secret 变量展示 process.env 的值

### 修复

- **OAuth 授权页报 `redirect_uri_mismatch`**：回调端口原先每次进程随机生成，而持久化的 OAuth client 的 `redirect_uris` 在注册时固定——重启后新回调地址与注册地址不一致，CAS 拒绝授权。修复：回调端口按 serverName 稳定派生；`clientInformation()` 校验持久化 client 的 `redirect_uris` 是否覆盖当前回调地址，不匹配则丢弃并重新注册
- **OAuth 过期 token 导致静默连接失败**（不弹浏览器）：access_token 过期且 refresh_token 也失效时，SDK 抛 `InvalidTokenError` 且不做失效重试，直接连接失败。修复：provider 的 `tokens()` 解析 access_token 的 JWT `exp`，过期即清除凭据，SDK 自动转入新的浏览器授权流程
- **OAuth token 交换报 `code, code_verifier, client_id, redirect_uri are required`**：client 从持久化读取时内存闭包为 null，token 请求缺 `client_id`。修复：exchange 改用 provider 访问器（内存优先、持久化回退）
- **OAuth 并发授权端口冲突**：回调端口稳定后，挂载与测试连接同时授权会抢同一端口（EADDRINUSE）。修复：同服务器授权流程串行化
- **环境变量 secret 值未写入凭据**：编辑器保存 secret 行时丢弃了值。修复：填写值即提交（secret 写入凭据文档），留空保留原值

## [1.4.0] - 2026-08-16

### 新增

- **进程级环境变量**：Settings → MCP 页新增「进程环境变量」配置区（全局 KV，跨所有服务器，默认展开，支持批量添加与加载失败重试）；secret 值写入凭据文档，留空保留原值
- **请求头环境变量替换**：`streamable-http` 服务器的请求头 value 支持 `${ENV}` 占位符与裸变量名，连接时按服务器 env（含 secret）、进程级环境变量、系统环境变量依次替换（如 `Authorization: Bearer ${TOKEN}`）；未匹配的占位符原样保留，避免误清空
- **JSON 维护服务器配置列表**：Settings → MCP 页新增「JSON 维护配置」面板，以纯 JSON 数组查看/编辑**全部 MCP 服务器配置**（serverName / transport / enabled / url / command / args / cwd / headers / 超时 / failOnStartupError / env）；应用时按列表全量替换——已列出的服务器创建或更新、未列出的删除（host 新增 `upsertJson` 批量方法，点应用直接保存），保存后自动刷新服务器列表与工具列表
- **页面布局重构**：注入模式置顶 → 环境变量模块（默认展开）→ MCP 配置模块；添加/编辑服务器表单内联展示在列表上方或对应行下方（列表始终可见）；JSON 配置面板展开时隐藏 UI 列表，应用后自动恢复
- **服务器表单不再编辑环境变量**（由进程级环境变量统一管理）：表单保存不提交 env，已有服务器 env 保持不变；JSON 配置编辑器仍可全量编辑服务器 env（含 stdio 子进程注入）
- 服务器列表导出（`list`）中的非 secret 环境变量值随配置返回，可随 JSON 往返编辑；secret 值仍只存凭据文档（导出仅 `configured` 标记，留空保留原值）

### 修复

- **OAuth token 刷新失效后不再触发授权**（JSON 保存/重启后 OAuth 服务器连接失败且不弹浏览器）：根因是 OAuth client（client_id）未持久化——每次进程重新动态注册新 client，token 刷新被服务器以 `client_id mismatch` 拒绝，且 SDK 要求的 `invalidateCredentials` 未实现导致 token 无法清除、重试仍失败。修复：client 信息随 token 持久化（凭据文档），并实现 `invalidateCredentials`，失效后自动进入新的浏览器授权流程
- **表单保存/测试在未提交 env 时误报 "env is not iterable"**：host 对 `request.env` 的所有迭代补 `?? []` 兜底（未提交则保留已有 env）
- **JSON 应用后列表状态未刷新**：挂载为异步，应用后立即刷新并追加 2s/6s 延迟刷新，「连接中」自动变为「已连接」

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
