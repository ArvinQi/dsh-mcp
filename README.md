# dsh-mcp — MCP 管理界面 + tool search：稳定工具列表、命中缓存、不撑爆上下文

**[English](README.en.md) | 简体中文**

[![dshfind](https://dshfind.com/api/badge/ArvinQi/dsh-mcp?lang=zh)](https://dshfind.com/zh/plugins/ArvinQi/dsh-mcp?ref=badge)

![设置页预览](static/snapshot.webp)

## 为什么用 dsh-mcp？

**解决的核心问题：**

- **MCP 工具全量注入烧 token**：接入多个 MCP 服务器后工具可达上百个，每轮全量注入开销巨大。`search` 按需检索模式让模型通过 `mcp_tool_search` 热注入所需工具，大幅节省 token。
- **工具列表反复更新破坏缓存**：`tools/list_changed` 通知会让同名工具被反复注销/重注册，系统提示词工具列表抖动、prompt cache 频繁失效。工具列表稳定化让未变化的工具保留原注册，最大化 cache 命中。
- **没有可视化管理入口**：服务器配置、启停、工具勾选全靠手工改文件。Settings → MCP 一站式可视化完成。

**功能优势：**

- **可视化管理**：服务器列表 / 新建 / 编辑 / 删除 / 测试连接 / 启停 / 刷新，全 UI 操作
- **进程级环境变量**：全局 KV 配置（默认展开、支持批量添加），服务器请求头 value 写 `变量名` 或 `${变量名}` 即可在连接时自动替换为配置值（如 `Authorization: Bearer ${TOKEN}`）
- **JSON 全量配置**：「JSON 维护配置」面板以一段 JSON 数组查看/编辑全部服务器配置，应用即保存（新增/更新/删除）
- **工具级精细控制**：每个服务器展开工具列表，默认全选，可取消勾选只加载需要的部分
- **双注入模式**：`search`（按需检索，省 token）与 `full`（全量注入）
- **零 npm 依赖**：直接对接 DeepSeek Harness 内部能力，安装即用
- **OAuth 认证支持**：`streamable-http` 服务器若走 MCP OAuth（授权码 + PKCE），连接时自动打开浏览器授权；token 与 client 信息持久化、由 SDK 自动刷新（24 小时内活跃自动续期），失效后自动重新授权
- **三种安装方式**：npm / GitHub git 源 / 本地 link；中英文界面与文档

## 功能

- **托管 MCP 服务器注册表**（host）：持久化定义（storage-domain `mcp_servers`）、按服务器挂载
  `@deepseek-ai/dsh-mcp-client` 实例、环境变量注入（明文入定义、secret 走 credentials）、
  连接探测（test）。
- **Web 设置管理页**（client）：Settings → MCP，列表/编辑/删除/测试服务器。
- **OAuth 认证**（host，`lib/oauth.js`）：`streamable-http` 服务器遇 401 + OAuth 挑战时自动走
  授权码 + PKCE 流程，打开浏览器授权、回环回调收码、token 持久化并按需自动刷新；
  测试连接与挂载共用同一份 token。
- **Remote 自挂载**：client 半部在 `apply()` 里自行 `ctx.remote.$mount()` 挂载 `mcpManager`
  命名空间（原实现依赖 api-remotes 的 in-box 修改，独立版不再需要任何 in-box 包改动）。

## 结构

```
dsh-mcp/
├── package.json          name=dsh-mcp；dsh.client 声明；零 npm dependencies
├── lib/
│   ├── index.js          host 半部（McpManagerService，源自 mcp-manager 构建产物）
│   ├── mcp-client.js     vendored MCP 客户端（源自 @deepseek-ai/dsh-mcp-client，含工具列表稳定扩展）
│   ├── oauth.js          MCP OAuth 客户端提供者（授权码 + PKCE、回环回调、token 持久化）
│   ├── probe.js          vendored 连接探测（源自 mcp-client/src/probe.ts）
│   ├── transport.js      vendored 传输工厂（源自 mcp-client/src/transport.ts）
│   └── client.js         浏览器半部（esbuild 打包，ModuleLoader wire format）
├── src/client/           浏览器半部源码（TSX + CSS Modules + 本地 types + remote-contribution）
└── scripts/build.mjs     构建脚本（esbuild 取自 DSH checkout，见下）
```

## 构建

```sh
node scripts/build.mjs
```

- esbuild 从 DSH 源码 checkout 解析：`$DSH_SOURCE` 未设置时尝试
  `~/.dsh/source/current`。
- 运行时依赖（`@deepseek-ai/*`、`zod`、`@modelcontextprotocol/sdk`）不装 npm 包，
  从 `$DSH_HOME/profiles/node_modules`（DSH profiles 模块 fallback，`$DSH_HOME` 默认 `~/.dsh`）解析；构建时经
  `nodePaths` 指向同一目录。
- CSS Modules 由 esbuild onLoad 插件处理：样式注入
  `<style data-plugin="dsh-mcp" data-file="…">`，默认导出 identity 类名映射。

## 安装使用

### 1. 安装

**方式一：npm（发布到 npm 后）**

```sh
dsh plugin --profile web add dsh-mcp
```

**方式二：GitHub git 源**

```sh
dsh plugin --profile web add github:ArvinQi/dsh-mcp
# 或
dsh plugin --profile web add git+https://github.com/ArvinQi/dsh-mcp.git
```

**方式三：本地开发（link）**

```sh
dsh plugin --profile web add link:<本仓库绝对路径>
```

> 注意：本地 `link:` 安装时，插件目录内含 `node_modules -> $DSH_HOME/profiles/node_modules`
> symlink（本机开发用，不入库），否则 `link:` 安装的 symlink 被 realpath 后无法解析
> `@deepseek-ai/*`。

### 2. 注册与生效（三种方式通用）

在 `$DSH_HOME/profiles/web/cordis.patch.yml`（`$DSH_HOME` 默认 `~/.dsh`）追加：

```yaml
- insert:
    - id: dsh-mcp
      name: dsh-mcp
```

> ⚠️ **这一步必须手动完成**：dsh-mcp 未声明 `dsh.bundle`，`dsh plugin add` 只负责把包装进
> profile，**不会自动进入运行组合**。漏掉注册行则插件完全不生效。

然后**重启 `dsh web`**，并**硬刷新浏览器**（`Cmd/Ctrl + Shift + R`）：

> ⚠️ **重启 + 硬刷新缺一不可**：
> - 设置页（client 半部）需要 **client roster** 生效，**插件集变更必须重启 `dsh web`**（刷新浏览器不够）；
> - 重启后浏览器必须**硬刷新**（`Cmd/Ctrl + Shift + R`），普通刷新可能仍使用缓存的旧页面。

### 3. 使用

**打开管理页**：重启后浏览器打开 DSH Web → **设置（Settings）→ MCP**。

### 4. 常见问题排查

**Q1：安装后设置页看不到「MCP」？**

按顺序检查：

1. **是否已注册插件行**：确认 `$DSH_HOME/profiles/web/cordis.patch.yml` 已追加
   `- insert: [{ id: dsh-mcp, name: dsh-mcp }]`（`id`/`name` 必须与插件包名 `dsh-mcp` 完全一致）。
   `dsh plugin add` 不等于生效，**没有注册行插件不会挂载**。
2. **是否重启了 `dsh web`**：仅刷新浏览器不够——设置页入口来自 client roster，
   插件集变更必须**重启进程**才进入 roster。
3. **是否硬刷新了浏览器**：重启后用 `Cmd/Ctrl + Shift + R`（Windows/Linux：`Ctrl + Shift + R`）
   强制刷新；普通 `F5` 可能加载缓存的旧页面。
4. **是否装到了正确的 profile**：确认安装与注册都在 `web` profile
   （`dsh plugin --profile web add dsh-mcp` + `$DSH_HOME/profiles/web/cordis.patch.yml`）；
   装到其他 profile 则在其他 profile 的设置页查看。
5. **是否为最新版本**：npm 元数据缓存可能导致装到旧版，可强制指定版本
   `dsh plugin --profile web add dsh-mcp@latest`（或 `@1.4.0`）。

**Q2：设置页能看到「MCP」，但服务器列表为空/报错？**

- 确认 `dsh web` 进程日志中 `mcp-manager` 没有初始化错误；
- 若升级过插件，请重启后**硬刷新**，避免旧 client bundle 与新版 host 不匹配
  （典型现象：操作报 `client api: ... 404` 或 `env is not iterable`，都是新旧版本混用所致）。

**Q3：MCP 工具没有出现在 agent 会话里？**

- 确认对应服务器状态为「已连接」且工具已勾选（默认全选）；
- 注入模式为「按需检索」时，模型会通过 `mcp_tool_search` 检索后热注入，未检索到的工具不在
  系统提示词中属正常现象；可切换到「全量注入」验证。

**添加服务器**：

1. 点击「添加服务器」（表单在列表上方就地展开）
2. 填写：服务器名称（`serverName`，决定工具前缀 `mcp__<serverName>__`）、传输方式
   （`streamable-http` 填 URL / `stdio` 填命令）、请求头、工具调用超时等
3. 点「测试连接」确认连通性与工具列表，点「保存」

**进程环境变量**（注入模式下方，默认展开）：

- 配置全局键值对，供所有服务器的请求头替换引用；secret 值写入凭据文档，留空保留原值
- 支持「批量添加」（粘贴多行 `NAME=value`）与「添加变量」逐行添加
- 服务器请求头 value 可直接写**变量名**或 **`${变量名}`**（如 `Authorization: Bearer ${GITLAB_TOKEN}`），
  连接时自动替换（优先级：服务器 env > 进程级 env > 系统环境变量）

**JSON 维护配置**（MCP 配置模块右上角）：

- 以一段 JSON 数组查看/编辑**全部服务器配置**；应用后按列表全量替换（新增/更新/删除），
  自动刷新列表与工具列表；JSON 面板展开时隐藏 UI 列表，应用后恢复
- 服务器级 env（含 secret 标记与 stdio 子进程注入）仍通过 JSON 配置维护

**OAuth 服务器**（`streamable-http` 走 MCP OAuth，如受 OAuth 保护的网关服务）：

- 只需正常填写 URL 并测试连接；服务器返回 401 + OAuth 挑战时，插件**自动打开浏览器**完成授权
- 在浏览器中登录/同意后返回 DSH，测试结果自动刷新（「连接成功 + 工具数」）
- token 与 OAuth client 信息持久化在凭据文档（按 `serverName` 隔离），由 MCP SDK 自动刷新
  （24 小时内活跃自动续期）；失效后自动重新授权，授权一次后挂载与测试复用
- 首次授权需浏览器交互，测试/连接等待时间放宽至 5 分钟；非 OAuth 服务器不受影响，连接失败即时返回

**日常管理**：

- **启用 / 禁用**：列表行按钮，禁用后该服务器所有工具即时注销，不再注入
- **刷新**：重新拉取服务器状态与工具列表（服务器重启后可同步新工具）
- **测试连接**：编辑页可随时测试

**工具控制（省 token 的关键）**：

- **注入模式**：页面顶部切换 `search`（按需检索，默认）或 `full`（全量注入）
  - `search` 模式下，模型需要某 MCP 工具时调用 `mcp_tool_search` 检索并热注入当前对话
- **工具勾选**：点「展开工具」查看该服务器全部工具（默认全选），取消勾选 = 不注入该工具，
  即时生效，无需保存

**验证效果**：

- 在任意 agent 会话中，可用工具应包含 `mcp__<服务器名>__<工具名>`
- `search` 模式下未检索到的工具不占系统提示词，节省 token 并提升 prompt cache 命中率
- 工具内容未变化时，`list_changed` 通知不会反复注销/重注册同名工具，工具列表保持稳定

## 版本注意

- host 半部 `lib/index.js` 是 mcp-manager 的**构建产物**（spec/types 已内联），改动请直接编辑
  lib 下文件，或改回 TS 后重新用仓库工具链构建。
- 浏览器半部改 `src/client/*` 后重新 `node scripts/build.mjs`；host 半部改动无需重装
  （link 安装直接生效）。
- 配置变更（bundles 增删、新插件行）需重启 `dsh web` 才进入 client roster。

[![dshfind](https://dshfind.com/api/card/ArvinQi/dsh-mcp?lang=zh)](https://dshfind.com/zh/plugins/ArvinQi/dsh-mcp?ref=badge)
