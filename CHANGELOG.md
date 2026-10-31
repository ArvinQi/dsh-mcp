# 更新日志（Changelog）

**[English](CHANGELOG.en.md) | 简体中文**

本项目的所有重要变更都会记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## 兼容性

- **支持版本**：**dsh `0.2.0-rc.2`** —— 最新版本在 `0.2.0-rc.2` 上开发与验证（`package.json` → `dsh.supported` 同步声明）；历史版本条目各自声明当时验证的版本。DSH 与插件版本不匹配时，设置页会给出排查诊断（核对 bundle 是否已选中 → 重启 `dsh web` → 硬刷新 → 同步升级）。
- **发版约定**：每个版本条目都要声明 `- **支持版本**：dsh <版本>`，并在 GitHub Release notes 中同步。Release 正文用**中文**（与本文档一致），标题层级与条目一致。

## [1.14.3] - 2026-10-31

- **支持版本**：**dsh `0.2.0-rc.2`**

### 修复

- **授权服务器「声明支持 RFC 9207 `iss` 却不在回调里带」时，浏览器已显示授权成功、插件仍判失败（[#18](https://github.com/ArvinQi/dsh-mcp/issues/18)）**：Notion 的授权服务器元数据（`https://mcp.notion.com/.well-known/oauth-authorization-server`）写着 `authorization_response_iss_parameter_supported: true`，但真实的回调 URL 里**没有** `iss` 参数；MCP SDK 2.0.0 的 `validateAuthorizationResponseIssuer()` 把「声明支持 + 回调缺失」直接当作授权服务器混同攻击并抛 `IssuerMismatchError`，于是浏览器页面上授权已经成功、插件侧却报 `Issuer mismatch in authorization response (RFC 9207): expected "https://mcp.notion.com", received undefined`，在服务端修好元数据之前无法绕过。修复包含两点（`lib/oauth.js`）：① 回调 URL 里的 `iss` 现在会原样交给 `exchangeAuthorization()`——此前它被**丢弃**，SDK 只能拿到 `undefined`，于是反过来两头都错：「声明支持 `iss` 且确实回了正确 `iss` 的服务器」照样被判失败，「没声明支持、却带回错误 `iss` 的混同响应」反倒被静默放行；② 只有当回调**确实没带** `iss`、而元数据又声明支持时，才把这一条声明从交给令牌交换的元数据**副本**上去掉，并打一条 warning 日志（RFC 9207 中 `iss` 本就是可选参数，缺失本身不是攻击信号，声明只是与本次响应不符）。带着 `iss` 的回调仍走 SDK 的严格字符串比对，`iss` 与 `metadata.issuer` 不一致照样抛错；设置页 / tool-auth 的回调监听器与「无 serverUrl」的旧版兜底监听器两条路径都已修正

### 说明

- 新增 3 个回归用例到 `test/oauth-flow.test.mjs`（该文件依赖 DSH 模块闭包，只在本地装有 DSH 的环境执行）：① 声明支持但回调不带 `iss` → 授权成功（#18 的复现，修复前失败）；② 回调带正确的 `iss` → 授权成功（修复前同样失败：`iss` 被丢弃后校验看到的是 `undefined`）；③ 回调带错误的 `iss` → 仍然拒绝并报 `Issuer mismatch`，且不落任何 token
- 本次只改宿主侧 `lib/oauth.js`：客户端包 `lib/client.js` 与所有 Remote 接口未变，升级后无需重新构建产物

## [1.14.2] - 2026-10-29

- **支持版本**：**dsh `0.2.0-rc.2`**

### 修复

- **Windows OAuth 授权页无法打开（[#16](https://github.com/ArvinQi/dsh-mcp/issues/16)）**：此前 `openBrowser` 在 Windows 上执行 `spawn("start", [url])`，而 `start` 是 `cmd.exe` 的内置命令、并非可执行文件，不经过 shell 启动只会得到 `ENOENT`，该错误又被 `child.on("error", () => {})` 静默吞掉，于是 Windows 上发起 OAuth 授权时浏览器根本不打开、也没有任何提示（`lib/oauth.js` 里 `oauthStart` 与 `allowBrowserOnMount` 两处调用都受影响）。现改用 `rundll32.exe url.dll,FileProtocolHandler`，授权 URL 作为**单个原样参数**传递、不经过 shell，因此查询参数中的 `&` 不会被拆成命令；同时也避免了 `cmd /c start "" <url>` 那种把 URL 重新交给 shell 解析带来的命令注入面。macOS（`open`）/ Linux（`xdg-open`）的打开方式与「尽力打开」（错误回调、`detached`、`unref`）语义均保持不变（PR [#17](https://github.com/ArvinQi/dsh-mcp/pull/17)，感谢 [@Nyarlathoteppppp](https://github.com/Nyarlathoteppppp)）

### 说明

- 新增零依赖模块 `lib/browser-command.js`：`browserCommand(url, platform)` 按平台返回「命令 + 参数数组」，把「用哪个程序打开」从 `openBrowser` 里剥出来以便断言
- 新增 `test/oauth-browser.test.mjs`：断言 win32 下含 `&` 的授权 URL 作为单个参数交给 `rundll32.exe url.dll,FileProtocolHandler`，且 darwin / linux 的启动命令保持不变；该测试不依赖 DSH 模块闭包，因此在 CI 的 `npm test` 中也会执行（不会像 `oauth-flow.test.mjs` 那样被跳过）
- 本次只改变宿主侧打开浏览器的方式：客户端包 `lib/client.js` 与所有 Remote 接口未变，升级后无需重新构建产物

## [1.14.1] - 2026-10-20

- **支持版本**：**dsh `0.2.0-rc.2`**

### 修复

- **插件样式不再泄漏到宿主界面，控件样式一律改为 class（[#14](https://github.com/ArvinQi/dsh-mcp/issues/14)）**：`ServerForm.module.css` 与 `McpSettingsSection.module.css` 里各有一条没有父级限定的 `button { … }` 规则，另外还有 `.field input` / `.row input` / `.actions button` / `.retryRow button` 等以元素为右端的选择器；而客户端样式表是原样注入宿主 `<head>` 的——构建的 CSS Modules 只做恒等类名映射，没有任何作用域边界——于是这些规则命中了宿主页面上对应的**每一个**元素。DSH 输入框左下角的加号按钮（28×28）与右下角的发送按钮（34×34）靠 `display: grid; place-items: center` 让图标居中、自身不声明 `padding`，被泄漏的 `padding: 5px 12px` 把内容盒从 16px / 22px 挤到 4px / 10px，14px / 16px 的图标横向溢出、按起始边对齐，图标因此在圆内向右偏移（实测 +5.0 px 与 +3.0 px）。现在**不再有任何以元素为目标的样式**（`button` / `input` / `select` / `textarea` / `label` / `p` 全部消失）：基础控件样式集中到新的 `src/client/controls.module.css`，以类名定义——`.button`（连同 `:hover` / `:focus-visible` / `:disabled`）、`.buttonSmall`、`.primary`、`.control`（`<input>` / `<select>` / `<textarea>` 共用）、`.controlMono`、`.checkbox`；各组件只从这个模块取**类名**，自己的样式表保留布局与 `.active` / `.danger` / `.dangerButton` / `.moduleTitle` 等修饰类，也全部只按 class 匹配。因为恒等类名映射下同名类就是全局的，共享类只在 `controls.module.css` 里定义一次；优先级也不再依赖技巧（此前用 `:where()` 压低权重），改为「同一个表内 `.primary` 排在 `.button` 之后 + 组件样式表固定在共享表之后注入」

### 说明

- 重写 `test/client-style-scope.test.mjs`：① 逐条检查 `src/client/*.module.css` 的选择器，要求是纯 class 链（出现元素选择器 / `*` / `:root` 即失败）；② 按宿主加载器格式装载 `lib/client.js`，检查它实际注入的样式表同样没有元素选择器；③ 断言共享控件类只定义一次、`controls.module.css` 排在其它样式表之前，且 `.primary` / `.buttonSmall` / `.controlMono` 规则顺序保证变体覆盖基础类；④ 扫描所有 `.tsx`，每个 `<button>` 必须带 `controls.button`（避免漏类名退回无样式）。用修复前的构建产物跑该测试会失败
- `scripts/build.mjs` 生成恒等类名表前先剥离 CSS 注释（注释里提到的类名不再成为死 key）；构建脚本头部改为说明「注入的样式表是全局的，规则必须是纯 class 选择器，控件共享类集中在 controls.module.css」
- 本次只有客户端包内容变化（宿主 `lib/index.js` 与所有 Remote 接口未变），升级插件后硬刷新 DSH 页面即可看到图标居中

## [1.14.0] - 2026-10-13

- **支持版本**：**dsh `0.2.0-rc.2`**

### 变更

- **HTTPS 服务器默认按系统证书校验**：宿主的 `streamable-http` 连接、OAuth 元数据发现/动态注册/token 交换此前都走 Node 自带的根证书库，于是内网域名（Ctrip Root CA、Zscaler/Sangfor 代理根等只装在系统钥匙串里的 CA）报 `fetch failed` / `UNABLE_TO_VERIFY_LEAF_SIGNATURE`，必须先给 `dsh web` 加 `NODE_OPTIONS=--use-system-ca` 或 `NODE_EXTRA_CA_CERTS` 才能用。现在新模块 `lib/system-ca.js` 在插件启动时把**操作系统信任库的根证书并入 Node 默认库**（`tls.getCACertificates('system')`，保留 Node 自带根、重复调用幂等），HTTPS 请求即按系统证书校验；宿主 Node 较旧（< 24.9，无该 API）时退回用 undici Agent 携带系统根做定向 fetch，两条路径都不影响 `http` 服务器与原本就信任的站点。真机实测：本机识别 135 条系统根证书；且 DSH 桌面的 Electron-as-Node 运行时会直接丢弃 `NODE_OPTIONS`（日志 `Node.js environment variables are disabled…`），所以内网 HTTPS 正是靠这个合并才通——证书签发者为 `Ctrip Root Certificate Authority` 的 MCP 服务器在未设该环境变量时也能连通
- **OAuth 授权改为「按钮 + 5 秒轮询」，浏览器由宿主打开**：服务器卡片在授权缺失时显示「OAuth 授权」按钮（新增 Remote `oauthStart` / `oauthStatus`）；点击后由**宿主**用系统浏览器打开授权页——客户端 `window.open` 在 DSH 外壳里会被拒绝、只闪一下空白标签页，这是"点了没反应"的根因；随后行上显示「授权中…」并每 5 秒查询一次授权状态，token 落库后照旧经 `credentials/reference-updated` 自动重挂载，按钮消失、工具出现。挂载与「测试连接」共用同一个回环回调流程（`createToolAuthorizationUrl` 增加同服务器并发去重），先挂载再点按钮不会重复起监听、不会抢同一个固定端口
- **编辑表单不再有自己的授权按钮**：删掉「打开授权页面」按钮与链接段落（外壳里打不开、只会制造噪音），编辑页只保留 OAuth 勾选、一行说明与「授权中／授权成功」状态；「测试连接」仍是表单里的探测方式
- **授权结果可见**：宿主按服务器记录最近一次流程结果，`oauthStatus` 返回 `pending` 与 `error`（授权服务器回的 `access_denied`、或 token 交换失败），列表行据此显示「授权中… / 授权失败: 原因 / 授权未完成（可重试）」，不再是"点完没有任何反馈"；新增 `oauthAuthorized` 视图字段（列表/upsert/adopt 结果）作为按钮与徽标的依据

### 修复

- **授权完成前不再显示「授权失败」**：此前 OAuth 服务器的挂载/测试在用户尚未授权时就以红色「挂载失败」+ 原文错误呈现，测试连接还会自动弹浏览器并最多阻塞 5 分钟。现在 `test` 对 OAuth 服务器不再自动开浏览器、不再阻塞，改为立即返回带 `oauthRequired` 标记的结果；挂载侧由 provider 回调在抛错前标记 `status.oauthRequired`（`mcp-client` 会包装错误、吞掉稳定错误码，所以标记必须提前完成）；设置页遇到该标记只显示「等待授权」徽标与一行提示
- **回环回调端口不再泄漏，重试不再被旧连接顶掉**：回调此前用 keep-alive 应答，`server.close()` 会一直等连接释放；同一稳定端口的下一次授权可能把回环请求投递给上一个已关闭的监听器，新监听器永远收不到回调（表现为一直"授权中"）。现在回调响应带 `Connection: close`，处理结束强制 `closeAllConnections()`，回归测试里"先拒绝再重试"必须成功且进程不残留端口
- **不再把正常工作的 OAuth 服务器标成未授权**：服务器 `live` 且有工具（静态 token 已够用）时保持正常状态徽标，只留一个普通「OAuth 授权」按钮；红色「未授权」徽标/红色按钮与提示仅用于授权确实卡住挂载（失败、无工具）的服务器
- **未授权时不再显示授权链接长文本**：挂载错误里那条几百字符的授权 URL（带 `response_type=code`）被识别并收敛成一行「点击「OAuth 授权」完成授权即可」，其余真实故障仍原样显示

### 说明

- 新增 `test/oauth-flow.test.mjs`：用一个内置的假 OAuth 服务器（RFC 9728 资源元数据 + RFC 8414 授权服务器元数据 + 注册/token 端点，`/mcp` 一律回 401 挑战）真跑 SDK 授权链路，覆盖 `oauthStart` 参数校验与"宿主负责打开浏览器"、`pending → authorized` 轮询、测试连接返回 `oauthRequired` 而非失败、挂载 `status.oauthRequired`、以及"先拒绝（`access_denied`）再重试必须成功且不残留监听端口"
- 新增 `test/system-ca.test.mjs`：用 openssl 现造 127.0.0.1 自签证书起 HTTPS 服务，断言合并前 `fetch` 失败、合并后成功，且 Node 自带根证书全部保留（无 openssl 或 Node < 24.9 的环境自动跳过）
- 新增 `test/client-bundle.test.mjs`：按 shell 的 `__ModuleLoader__` 线上格式加载构建产物，断言导出与新增文案/Remote，防止 `lib/client.js` 陈旧
- 真机验证：`dsh web`（`web` profile）宿主 `mcpManager/oauthStart` / `oauthStatus` 正常应答（`octop-memory-oauth: authorized:false`、`bigdata-adhoc-mcp-oauth: authorized:true`），`list` 返回 `oauthAuthorized`，客户端包 rev 与仓库构建一致

## [1.13.0] - 2026-10-08

- **支持版本**：**dsh `0.1.6-alpha.2`**

### 变更

- **声明 `dsh.bundle`，插件现在能作为 bundle 安装/启用**：此前包内没有 `dsh.bundle`，DSH Web 的插件管理页在 `plugin-manager.inspect()` 的 `not-a-bundle` 分支直接拒掉安装——报错 `dsh-mcp declares no dsh.bundle`（registry 与本地路径两种来源都拒），`dsh plugin add` 也只把包当作普通依赖装进 profile，必须再手写 `- insert: [{ id: dsh-mcp, name: dsh-mcp }]` 注册行才生效。现在 `package.json` 声明 `dsh.bundle.patch` → 包根 `cordis.patch.yml`：安装时 DSH 自动把 `dsh-mcp` 写入 `dsh.profile.bundles`，并由该 patch insert 插件行；`cordis.patch.yml` 已加入 `files`，随 tarball 发布
- **注册行移入包内，用户 patch 层只做配置覆盖**：`$DSH_HOME/profiles/<profile>/cordis.patch.yml`（用户层）与 `$DSH_HOME/cordis.patch.yml`（机器层）不再 insert 同一 id，改用 id-targeted 条目覆盖 `config`（`probeTimeoutMs` / `allowBrowserOnMount`）——同一 id 由两层声明会让 loader 组合失败。README 中英的安装、注册与排查章节据此重写，并说明「包内 bundle patch」与「声明式服务器用的 profile patch」是两个文件

### 说明

- 新增 `test/bundle-manifest.test.mjs`：断言清单声明 `dsh.bundle.patch`、被引用的 patch 文件存在且列入 `files`、patch 解析后恰好 insert 一行 `{ id: dsh-mcp, name: dsh-mcp }`（解析用 `js-yaml`；无 DSH 模块闭包的环境只跳过该子测试）

## [1.12.1] - 2026-10-07

- **支持版本**：**dsh `0.1.6-alpha.2`**

### 修复

- **stdio 服务器现在真的能拿到进程级环境变量（[#11](https://github.com/ArvinQi/dsh-mcp/issues/11)）**：`global_env` 此前只用于 `streamable-http` 的请求头替换，stdio 分支把它整个丢掉；而父进程环境也不是替代通道——`dsh-mcp-client` 会把 `KEY`/`TOKEN`/`SECRET`/`PASSWORD` 形状的父环境变量剥离后再与服务器 env 合并。于是像 `tavily`（`npx -y tavily-mcp`）这类只吃环境变量、且表单不再编辑 per-server env 的 stdio 服务器，只能以「无密钥」状态启动（表现为 `tavily_research` 报 "requires an API key"，而 keyless 的 `tavily_search`/`tavily_extract` 正常）。现在 `toClientConfig()` 的 stdio 分支把 `global_env` 与服务器自身 env 合并后注入子进程，同名时**服务器 env 优先**；设置页提示、README 中英与本文档同步改为「stdio 子进程注入 + HTTP 请求头引用」的实际作用域
- **凭据引用更新后的自动重挂载恢复正常（[#12](https://github.com/ArvinQi/dsh-mcp/issues/12)）**：`managedServerId()` 用 `lastIndexOf("_")` 从 `DSH_MCP_<serverId>_<变量名>` 反解服务器 id，而 id（`mcp_<12位十六进制>`）与变量名都可能含 `_`：只要变量名带下划线（`TAVILY_API_KEY`、`MY_VAR`）就切错位置、解析出表里不存在的 id，`credentials/reference-updated` 处理器于是静默跳过重挂载——**通过凭据管理界面或其它插件轮换密钥后，服务器继续用旧值直到手动刷新**。现在按 id 的固定格式 `mcp_[0-9a-f]{12}` 精确匹配，并对 `DSH_MCP_ENV_*`（进程级）与 `DSH_MCP_OAUTH_*` 引用保持不解析

### 说明

- 两个修复各配一条回归测试：`test/stdio-env.test.mjs` 通过真实挂载 + 真实子进程读回环境变量（改回旧实现即失败），`test/managed-server-id.test.mjs` 直接读 `lib/index.js` 中发布态的函数做引用解析矩阵

## [1.12.0] - 2026-09-18

- **支持版本**：**dsh `0.1.6-alpha.2`**

### 变更

- **迁移到官方 MCP SDK 2.0 拆分包**：DSH `0.1.6-alpha.1` 起，框架内的 `dsh-mcp-client` 已从单体包 `@modelcontextprotocol/sdk@1.x` 迁到 `@modelcontextprotocol/{client,server,node}@2.0.0`，旧包不再是 DSH 的依赖。本插件同步迁移 `lib/transport.js`、`lib/probe.js`、`lib/mcp-client.js`、`lib/oauth.js`，并在 `package.json` 显式声明 `@modelcontextprotocol/client@2.0.0` 与 `zod@^4.2.0`，不再依赖宿主 profile 的依赖提升——否则在 DSH `0.1.6-alpha.1` 上会以 `ERR_MODULE_NOT_FOUND: Cannot find package '@modelcontextprotocol/sdk'` 加载失败，设置页与 tool search 一并不可用
- **适配 SDK 2.0 的两处破坏性变更**：其一，`Client` 选项不再接受 `authProvider`，OAuth provider 改由 **transport** 携带（本插件的 `createTransport` 一直从 `config.authProvider` 读取并传给 transport，因此 OAuth 流程行为不变）；其二，`setNotificationHandler` 的第一个参数由 schema 改为**方法名**，工具列表变更通知改用 `notifications/tools/list_changed`
- **结果 schema 改从新包的 `specTypeSchemas` 取**：`ListToolsResultSchema` → `specTypeSchemas.ListToolsResult`；`ToolListChangedNotificationSchema` 不再需要（通知按方法名注册）
- **重新生成客户端半以适配 Typert `create()` 契约**：`@deepseek-ai/dsh-typert-generator` 生成的 `src/client/remote-contribution.js` 此前只携带 `schema: TypertSchema`，而 DSH 自 `0.1.6-alpha.1` 起把该字段改成 `create: () => TypertSchema`，registry 以 `record.value ??= record.create()` **无条件调用**它——于是设置页的 Remote 描述符在挂载时抛 `create is not a function`，整块 MCP 设置页失效。现已用当前生成器重新生成（21 个 strict 描述符全部补上 `create`）并重建 `lib/client.js`。此前一直没暴露，是因为常驻宿主自 9/14 起跑的是 `0.1.5-rc.1`（当时契约仍是 `schema`）

### 修复

- **OAuth 工具调用的「不弹浏览器」保护恢复生效**：`startConnection` 的 `opts` 一直缺少 `url` 与 `authProvider` 两个字段，于是「已存 token 缺失/过期时不要从工具调用里打开浏览器，改为返回授权链接」这段判断从未触发——实际行为是让 SDK 在工具调用中弹浏览器（同一会话可能连开多个标签）。现在在 `opts` 中补上这两项，行为回到代码注释所述

## [1.11.1] - 2026-09-13

### 修复

- **OAuth 改为显式开关，不再凭请求头猜测（停止反复弹出浏览器授权）**：此前规则是"streamable-http 且没有 `Authorization` 头 → 挂 OAuth provider"，于是用静态 token/自定义头（`x-bbzai-mcp-token`、`X-Mcp-Token`、`Private-Token`）认证的服务器也被当成 OAuth 服务器。这类服务器返回 401 时（token 失效、网关挑战等），SDK 会要求授权 → 插件打开浏览器并起回环回调（`127.0.0.1:<port>/callback`），而该流程永远无法让它们通过 → 每次重连/重挂载就再弹一次。现在服务器配置新增 **`oauth: true`** 开关（设置页勾选「使用 OAuth 授权」，默认关；接管声明时若该声明没有 `Authorization` 头则默认勾上，之后仍可修改）
- **升级自动迁移**：已存在 OAuth 凭据（token 或 client 注册记录）的服务器会保留 `oauth: true`，其余一律关闭——因此**现有真正需要 OAuth 的服务器不受影响，误判的那批立刻停止弹窗**
- **自动弹窗熔断**：同一服务器**每个进程最多自动打开一次**浏览器授权；之后的自动尝试不再弹窗，改为返回带授权链接的错误（沿用 1.8.0 的能力），手动点「测试连接」仍可随时发起授权

## [1.11.0] - 2026-09-13

### 新增

- **读取 `cordis.patch.yml` 的声明式 MCP 服务器**：设置页现在同时展示由组合原生挂载的 `@deepseek-ai/dsh-mcp-client` 行——profile 级 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 与机器级 `$DSH_HOME/cordis.patch.yml`（后者按组合层级覆盖前者），标记为「cordis 声明」并只读展示其来源文件。解析复用组合自身的 YAML 方言（`!!js` 表达式按源码文本展示），文件缺失不算异常、格式错误降级为页面诊断，不影响 manager 运行
- **声明优先，避免同名双挂载**：若某 `serverName` 已在 patch 层声明并由组合挂载，本插件不再挂载存储 domain 中的同名行（同名两处挂载会撞工具注册表并让整代工具回滚），设置页对该行给出冲突说明；patch 层热更新（`web`/`desktop` 为 live reload）后挂载归属自动跟随
- **OAuth 边界提示**：声明行无法携带 OAuth provider（原生客户端只接受静态配置）。对没有静态 `Authorization` 头的 streamable-http 声明行，设置页提示：如需浏览器授权，请在插件中新增同名服务器并停用声明行
- **接管 / 释放（声明式服务器获得 OAuth 能力）**：设置页对声明式服务器提供「接管」——插件在 `cordis.patch.yml` 的**受管块**内写入 id-targeted `disabled: true`（首次写入前生成 `.dsh-mcp.bak` 备份；原子替换、幂等、可逆、只动自己那一块），声明行因此让出该 `serverName`，随后由插件挂载同名行，从而启用 **OAuth 授权、凭据托管、`${VAR}` 头替换、测试连接**等插件能力。挂载**硬失败**（如 `failOnStartupError: true` 且连接失败）会自动回滚：移除受管块、行退回镜像状态并返回失败原因；「释放」则移除受管块、把挂载交还声明行并删除插件行。缺少显式 `id` 或含 `!!js` 的声明不可接管，返回明确错误码（`MCP_ADOPT_NO_ID` / `MCP_ADOPT_JS_EXPR`）
- **热重载未提交时安全降级（`pendingTakeover`）**：写入停用块后若原生工具在 5 秒内没有注销（该 profile 的 patch 热重载未提交——某个兄弟条目重建失败会让整代回滚），插件**登记接管但暂不挂载**：管理行落库并标记 `pendingTakeover`，重启 dsh 后由插件挂载；「释放」同样在热重载未提交时提示需要重启。此外，挂载前若发现同名 `mcp__<server>__` 工具已存在且不是本插件挂载的，一律跳过挂载——任何情况下都不会与仍在挂载的声明行争抢同名工具（那会撞注册表并让一方整代回滚）
- **声明读取升级为「生效态」**：按层回放 id-targeted patch（`applyEntryPatches`），因此本插件写入的停用块、以及跨层（profile → 机器级）的同 id 覆盖都会被正确反映；被接管的声明显示为已停用，归属仍记在声明它那一层

### 说明

- **声明式服务器导入 storages（镜像行）**：启动（以及每次刷新列表）时把声明行导入存储 domain，id 为 `cordis:<rowId>`，并带来源元数据（`origin: cordis`、`declaredIn`、`declaredRowId`）。规则：**只导入不覆盖**——本插件自己创建的行（`origin: plugin`）永不改写；同源镜像按 patch 内容刷新；声明从文件消失的镜像**自动删除**（镜像只是声明的副本，无主后不应堆积在列表里；早期版本留下的 `stale` 行也会被一并清理）；含 `!!js` 表达式的声明**跳过导入**（值无法在 Loader 之外还原），仅在页面按文件原样展示并标注原因。镜像行**永不挂载**（挂载归组合），因此不会与原生行争抢同名工具
- **tool search 无需改动即覆盖声明式服务器**：注入层按 `mcp__` 前缀处理整个工具集，声明式服务器的工具自动进入检索/热注入与单工具开关，并计入 `mcp-tool-control` 的服务器列表

### 变更

- **`allowBrowserOnMount` 默认值改为 `true`**：启动挂载 OAuth 服务器时若需要授权会直接打开浏览器完成授权（此前默认 `false`，表现为挂载静默失败、工具不注册）；仍可在 dsh-mcp 条目下显式设为 `false` 关闭该行为

### 修复

- **保存会丢掉声明来源**：`upsert`/`upsertJson` 重建行时没有保留 `declaredIn`/`declaredRowId`，导致已接管的服务器在禁用/启用或编辑一次后失去"来自声明"标记——「释放」按钮消失、释放报"没有声明来源"。现在保存会保留来源；并且启动时会根据**本插件受管块里的 id** 自动补回丢失的来源（只针对本插件自己停用过的 id）
- **禁用→启用后无法重新挂载（一直显示未启用）**：新增的"同名工具已存在则跳过挂载"护栏会把本插件**上一次挂载残留**的工具误判为外部占用。现在按 id 记录"本插件挂载过"，并在挂载前等待自身残留工具注销；由组合挂载的声明式占用仍会被正确跳过
- **声明行信息排版溢出**：来源文件路径改为独占一行并允许任意位置换行，标题徽标与操作按钮区允许换行，窄宽度下不再挤出卡片
- **JSON 编辑器会把声明式条目物化成插件行**：编辑器文档此前由**完整列表**（含 `source: cordis`）生成，保存时把声明行当普通服务器写回，于是出现"同号插件行 + 声明行"的冲突态（页面显示未启用、启停无效）。现在编辑器**只序列化插件自有的行**；宿主侧同时加了兜底——JSON 文档不会改写声明镜像（`origin: cordis`），也不会删除镜像或已接管行（`declaredIn`），被跳过的条数在编辑器提示里显示为「跳过声明式 N」
- **由声明提供的行不再误显示为「未启用」**：这类行当前由组合提供工具，页面此前显示挂载阶段（`stopped` → "未启用"）并给出无效的启停按钮。现在显示「由声明提供」/「待重启接管」徽标，并隐藏启停按钮
- **释放后"一直连接中、没有工具"（`needsPlugin`）**：声明式挂载由组合的原生客户端完成，而它**既没有 OAuth**（授权码+PKCE、token 托管都是插件的功能）**也不解析 `${VAR}`/裸变量名占位符**（也是插件的功能），因此"需要插件认证"的声明一旦释放就必然连不上。现在插件会识别这类声明——streamable-http 且没有 `Authorization` 头（OAuth 候选），或 header 值命中 `global_env` 的占位符——在页面上标记为**挂载失败并给出原因**（不再假装"连接中"），`status.error` 也会在页面显示；「释放」对这类行改用更强的确认文案，并在结果里返回说明性告警。要恢复工具只需重新「接管」
- **发布流水线被测试导入错误阻断**：本包零运行时依赖，`@deepseek-ai/*` 与 `js-yaml` 来自 DSH 安装；公共 CI 没有该安装，而 1.11.0 新增的 3 个测试文件在**导入期**就引用它们，导致 `npm test` 失败、发布 job 被跳过。现在 `npm test`（`scripts/test.mjs`）按环境自适应：缺少 DSH 模块闭包时自动跳过这些文件并说明，本机则跑全量

## [1.10.0] - 2026-09-02

### 新增

- **设置页对 host 缺失给出可操作诊断**：服务器列表加载失败若源于 `/api/mcpManager/*` HTTP 404（插件 host 半未注册或 client/host 版本不匹配），页面除原始错误外额外显示排查指引（核对 `cordis.patch.yml` 注册行 → 重启 `dsh web` → 硬刷新 → 同步升级），README 故障排查同步补充

### 修复

- **host 端文案国际化**：设置页双语早已齐备，但 host 半部（`lib/index.js`/`lib/oauth.js`/`lib/mcp-client.js`）的模型可见文案与 OAuth 错误一直是硬编码中文——`mcp_tool_search` 描述与参数说明、检索结果文案、注入的 `mcp-tool-control` 系统提示、OAuth 授权/回调页文案现均按 DSH `locale.preference`（settings 文档）选择 zh/en（新增 `lib/host-locales.js` 文案表；读不到时回退中文，与旧行为一致）
- **OAuth 判定不再依赖文本匹配**：`mcp-client` 的工具授权预检曾用 `error.message.includes("授权")` 决定是否重抛带链接的错误，翻译消息会静默破坏 OAuth 错误传播——现统一改用稳定的错误码 `MCP_OAUTH_REQUIRED`（`error.code`），控制流与显示文案解耦
- **静态凭据服务器不再被误当作 OAuth**：只有配置了 OAuth 授权码 + PKCE 且**没有**静态 `Authorization` 请求头的 streamable-http 服务器才挂 OAuth provider；带静态 token 的服务器遇到 401 时直接呈现认证失败，不再触发浏览器授权流程

## [1.9.0] - 2026-08-28

### 新增

- **工具列表稳定化增强（提升 prompt cache 命中）**：注册前对工具 schema 做规范化（递归排序键），服务器返回的键顺序变化不再导致工具被误判为变化而注销重注册；系统提示词中 MCP 工具按名称稳定排序，同一工具集合的渲染文本恒定——热注入集（search 模式每次调用都会变动）与服务器 `tools/list` 顺序不再影响提示词稳定性

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
