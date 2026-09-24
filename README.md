# Ditto

**以项目为中心，以实施资产为对象，以能力包适配不同平台，以 MCP 连接 AI 客户端，以规则引擎和审批机制保证交付质量。**

一个基于 MCP 的实施交付平台。AI 客户端（Claude Code / Cursor / Claude Desktop）通过 MCP
端到端驱动「建项目 → 渲染资产 → 跑规则 → 整改 → 提交审批 → 放行 → 导出交付物」；

> 仓库里原有的多 Provider LLM 聊天客户端（`lib/sdk/` + `components/chat.tsx`）仍在 `/`
> 提供服务。它**通过进程内 MCP 连到实施平台**，可以在对话里查询项目、资产、规则与审计，
> 但调不动任何写操作。见「聊天客户端」一节。

---

## 快速开始

```bash
npm install
npm run workspace:init      # 初始化工作区，安装内置能力包
npm run dev                 # 对话界面：http://localhost:3000
```

接入 Claude Code：

```bash
claude mcp add ditto --scope user \
  -e DITTO_WORKSPACE=/绝对路径/ditto/workspace \
  -- /绝对路径/ditto/node_modules/.bin/tsx /绝对路径/ditto/mcp/stdio.ts

claude mcp list && claude mcp get ditto
```

> **cwd 是头号坑**：`claude mcp add` 用 Claude Code 会话自己的 cwd 启动服务端，
> 在别的目录开会话就会把 `./workspace` 解析到错的地方。
> 必须显式传 `DITTO_WORKSPACE` 并用绝对路径引用 `tsx`。

接入 Cursor：同形配置写在 `~/.cursor/mcp.json`。
接入 Claude Desktop：`claude_desktop_config.json`；其 PATH 受限，`npx` 解析不到时用
`command: "/bin/zsh", args: ["-lc", "npx tsx /绝对路径/mcp/stdio.ts"]`。

HTTP 通道（需先 `npm run dev`）：

```bash
claude mcp add --transport http ditto-local http://localhost:3000/api/mcp
```

---

## 五个核心概念

| 概念 | 说明 |
|---|---|
| **项目** | 一切的中心。资产属于项目，规则挂载在项目上，审批发生在项目内。 |
| **实施资产** | 交付物对象，是工作区磁盘上的**真实文件**，可被 git 管理和人工直接查看。 |
| **能力包** | 平台适配载体。决定项目能用哪些模板、受哪些规则约束。 |
| **规则引擎** | **声明式数据**，不是代码。产出 error / warn / info 三级结论。 |
| **审批闸门** | 放行时刻**重新计算**规则。存量结论只是证据，不是权威。 |

---

## 工作流

```
建项目（补齐变量）
   ↓
从能力包渲染资产骨架        ← 模板是骨架，默认过不了规则，这是设计如此
   ↓
执行规则 ──→ 有命中 ──→ 整改 ──→ 重跑（循环）
   ↓ 无命中
闸门预检（dry-run，不改状态）
   ↓
提交评审 → 审批决策 → 发布
   ↓
导出交付包（只有已发布的资产会进包）
```

平台提供 5 个 MCP Prompt 作为作业指导书：`ditto_new_project`、`ditto_asset_authoring`、
`ditto_fix_findings`、`ditto_pre_acceptance_review`、`ditto_handover_summary`。
每个都要求先调 `ditto_handoff` —— 一次调用拿全状态与建议的下一步动作。

---

## 命令

```bash
npm run typecheck        # tsc --noEmit（tsx 不做类型检查，必须单独跑）
npm run workspace:init   # 初始化工作区
npm run core:smoke       # 领域层端到端（71 项断言，不涉及 MCP）
npm run mcp:smoke        # MCP 端到端（85 项断言，走真实 MCP 协议）
npm run mcp:smoke:http   # 同上，走 HTTP 通道（需先 npm run dev）
npm run chat-tools:smoke # 聊天 ↔ 实施平台（113 项断言，含工具循环，不需要 LLM）
npm run race:test        # 并发写保护（3 进程 × 50 并发写入）
npm run dev              # 开发服务器
npm run build            # 生产构建
```

三个冒烟脚本都以退出码反映结果，可直接进 CI。

---

## 架构

```
lib/core/          纯领域层
  types.ts         类型与状态机（零 import）
  identity.ts      项目固有变量（渲染与规则共用同一份）
  store/           文件工作区 I/O：原子写、跨进程锁、审计哈希链
  ops/             ★ 共享操作层：唯一实现，含审计发射
lib/rules/         规则引擎（纯函数，注入 I/O）
lib/capabilities/  能力包加载与模板渲染
lib/mcp/           MCP 服务端装配：工具 / 资源 / 提示词
mcp/stdio.ts       stdio 入口
app/api/mcp/       HTTP Streamable 入口
workspace/         运行时数据（gitignore）
```

**依赖方向单向**：`core ← rules ← capabilities ← mcp ← {mcp/, app/}`。

### 最重要的一条结构规则

```
lib/core/ops/*.ts                 ← 唯一实现（业务逻辑 + 审计）
  └─ lib/mcp/tools/*.ts           ← MCP 适配器（zod 进）
```

入口层**必须只是薄壳**。各写一份逻辑的后果很具体：审计流水分叉，
同一个动作在不同入口得出不同结论，闸门随之失去意义。

---

## 数据布局

```
workspace/
  ditto.workspace.json
  audit/YYYY-MM.jsonl              追加式，哈希链
  capabilities/general/            能力包（数据，可改）
    capability.json  templates/  rules/
  rulepacks/                       工作区级规则包（可覆盖能力包规则）
  projects/<项目>/
    project.json  assets.json
    assets/<逻辑路径>               活跃版本真实文件
    versions/<assetId>/v<N>.<ext>  不可变历史
    runs/  approvals/
  exports/<项目>-<时间戳>/
```

**并发保护**（`next dev` 与 Claude Code 的 stdio 服务端会同时写同一工作区）：

1. 进程内 async mutex —— 按 projectId 串行
2. 跨进程 mkdir 锁 —— 带过期抢占
3. 原子写 —— tmp + fsync + rename + 目录 fsync
4. `rev` 乐观并发 —— 传入 `expectedRev`，不匹配返回 `E_CONFLICT`

---

## 扩展：新增一个平台能力包

**能力包是数据，不是代码 —— 加 K8s / Linux / 云厂商包不需要改任何 TypeScript。**

在 `workspace/capabilities/` 下新建目录，放入：

- `capability.json` —— 清单：模板列表、所需变量、规则包引用、适配平台
- `templates/` —— 模板文件，用 `{{变量}}` 占位
- `rules/` —— 该平台自带的规则包（纯 JSON）

下一次读取能力包列表即可看到。项目挂载时，平台标识匹配的包会自动挂载。

---

## 安全与鉴权边界

**必须说清楚的一件事**：操作者身份（actor）来自客户端自报，
**这不是身份认证，不构成安全边界**。它的作用是流程留痕与审计追溯。
真正的鉴权（MCP OAuth / 反向代理 SSO）不在本平台范围内。

配置 `DITTO_MCP_TOKENS="tokenA:张三,tokenB:李四"` 可让 HTTP 通道的审计区分到人，
但这仍然只是「记名」，不是「验证」。

规则引擎的另一条边界：**规则是数据，引擎内没有 `eval` / `new Function`**。
加载时会拒绝含可执行键（`code` / `fn` / `source` / `eval` …）的规则包，
并拒绝嵌套量词正则（`(a+)+` 这类 ReDoS 写法）。规则来自工作区文件，
是用户与 AI 都能写的输入，这条防线是必须的。

---

## 已知限制

- **HTTP 入口假定长驻单进程**（`npm run dev` / `next start`）。无状态模式每次请求新建实例，
  所以在无服务器平台上不会串会话，但也不保留跨请求状态（本平台工具集不需要）。
- **v1 不解析 YAML**。YAML 资产退化为 forbidden-content 与体积检查；
  `format-valid` 目前只支持 JSON 与 Markdown。
- **`error` 级 findings 可以带理由豁免**。这偏离了「错误无条件阻断」的直觉说法，
  但那是能用的版本：否则一条误报的规则就永远绕不过去。
  豁免必须逐一给出理由，且会写进审计流水与交付清单。
- **对话里的工具只读**。写操作、豁免、提交审批、放行一律不在白名单里
  （`lib/sdk/tools.ts`）。这是刻意的：让 AI 直接放行，「放行时刻重新计算规则」
  这条闸门就变成了摆设。
- **工具调用不做逐字动画**。参数是 JSON，服务端攒齐了才发 ——
  把半截 JSON 推给界面只能逼它去容错一串解析不了的东西。
- **非流式请求不带工具**。工具循环的意义是把中间过程推给用户看，而那正是流式才有的能力。
- **聊天客户端的模型列表向接口拉取，但上下文窗口只有 Anthropic 给得了**。
  OpenAI 兼容的 `/v1/models` 只返回模型 id，所以那些模型的 token 计量条显示
  「上下文窗口未知」而不是编一个数出来。见下节。

---

## 聊天客户端：Provider 与模型列表

支持的 Provider：**Anthropic / OpenAI / DeepSeek / 自定义 Provider**。

模型列表**不再硬编码**，改为向 provider 的 `GET /v1/models` 拉取（经 `/api/models` 代理，
原因同 `/api/chat`：api.openai.com 与 api.deepseek.com 都不返回宽松的 CORS 头）。
填完 API Key 会自动拉取，也可以手动刷新；结果在会话内缓存。

拉取失败**不阻断**：已保存的列表仍然可用，也仍然可以手工添加模型。
防火墙内、或网关不支持 `/models` 的场景必须还能配置。

### 接口能给的东西不对等

| | Anthropic | OpenAI / DeepSeek / 兼容网关 |
|---|---|---|
| 模型 id | ✅ | ✅ |
| 显示名 | ✅ | ❌ |
| 上下文窗口 | ✅ `max_input_tokens` | ❌ |
| 输出上限 | ✅ `max_tokens` | ❌ |
| 定价 | ❌ | ❌ |

拉取解决的是**列表**，不解决**元数据**。所以 OpenAI / DeepSeek 的模型查不到上下文窗口时，
计量条会如实显示「上下文窗口未知」并隐藏进度条 —— 一个凭空的窗口会让人以为还有余量，
比不显示更危险。

### 在设置里编辑 provider 时

接口返回的模型**不会自动覆盖**你已保存的列表。它会作为独立区块显示（「Provider 返回 N 个模型」），
你可以逐条添加，或点「全部替换为返回结果」。静默替换一份手工编过的列表是数据丢失。

### 旧配置迁移

`openrouter` / `qwen` / `ollama` 三个预设已删除。如果你之前配过它们，启动时会自动改写为
OpenAI 兼容条目（保留 Key 与接口地址，名称标注「已并入自定义 Provider」），
不需要重新配置。`localStorage` 里的配置会带上 `version` 字段，迁移只跑一次。

---

## 聊天客户端 × 实施平台

对话界面也是一个 AI 客户端 —— 只是它跑在同进程里，而不是通过 stdio/HTTP 连进来。

```
浏览器
  └─ chat.tsx ──→ /api/chat ──→ handleChatRequest（工具循环在这里）
                                   │
                                   ├─ 第一轮：模型要调工具
                                   ├─ 进程内 MCP Client ←→ McpServer（同一套 lib/mcp）
                                   ├─ 执行、把结果塞回 messages
                                   └─ 第二轮：模型作答
   ←────────── SSE：text / tool / tool_result item ──────────┘
```

**复用的是同一套工具定义**（`lib/mcp/server.ts` 装配的那 36 个），经
`InMemoryTransport` 进程内连接，而不是在浏览器里再写一个 MCP 客户端
（理由见 `lib/sdk/tools.ts` 的文件头）。所以工具行为与审计不会在不同通道间漂移。

### 白名单是显式的

`lib/sdk/tools.ts` 里逐条列出对话可用的 20 个工具，**不**从上游的
`readOnlyHint` 注解推导 —— 给对话新增一个工具应当是深思熟虑的动作。
不在表里的工具，模型既看不到、也调不动（`callTool` 里另有一层拦截，
因为参数是模型给的，不能假设它只点名自己见过的工具）。

审计里这些调用记成 `chat-ui（AI·对话）`，与 Claude Code 的 `mcp-stdio` 调用可分。

### 上下文裁剪会修工具配对

倒着裁历史时，`role:"tool"` 的消息比它的 assistant 新，会先被收进来。
预算正好卡在两者之间就会留下一条孤立的工具结果，provider 直接 400，
而错误信息只会说「tool_result 没有对应的 tool_use」，看不出根因是裁剪。
`trimMessagesToContextWindow` 因此多了一步 `repairToolPairing`。
