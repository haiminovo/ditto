# Ditto

Ditto 是一个仅保留 Web 运行形态的通用 Agent Harness，并内置一套以项目、资产、规则和审批为核心的 MCP 实施交付平台。

项目分为四层：

1. `lib/harness` 负责通用模型与工具循环。
2. `lib/sdk` 负责 Provider、消息协议、SSE 和 Web 聊天接入。
3. `lib/core`、`lib/rules`、`lib/capabilities` 负责领域模型、规则和能力包。
4. `lib/mcp` 与 `app` 负责把领域能力暴露给 Web UI 和 HTTP MCP。

项目不启动 stdio 子进程。所有运行入口都来自 Web 服务：浏览器 UI、`/api/chat`、`/api/models` 和 `/api/mcp`。

## 快速开始

```bash
npm install
npm run workspace:init
npm run dev
```

默认地址：

- Web UI：`http://localhost:3000`
- HTTP MCP：`http://localhost:3000/api/mcp`

## 目录总览

```text
app/                    Next.js Web 应用与 API Routes
components/             浏览器端页面、聊天面板和基础 UI
lib/
  harness/              Provider 中立的 Agent Harness
  sdk/                  Provider 适配、模型注册、SSE 和聊天服务端
  core/                 领域类型、文件存储和唯一业务操作层
  rules/                声明式规则引擎
  capabilities/         能力包、模板和内置通用底座
  mcp/                  进程内 MCP 服务端、工具、资源和提示词
  workspace/             工作区选择协议与共享类型
scripts/                工作区初始化、冒烟测试和辅助脚本
workspace/              运行时数据，默认不纳入 git
```

## 根目录配置

| 文件 | 职责 |
|---|---|
| `package.json` | 项目依赖、Node 版本和全部运行/测试命令。 |
| `package-lock.json` | npm 依赖锁定文件。 |
| `next.config.js` | Next.js 构建配置。 |
| `tsconfig.json` | TypeScript 编译选项和 `@/*` 路径别名。 |
| `tailwind.config.ts` | Tailwind 扫描范围和主题扩展。 |
| `postcss.config.js` | Tailwind 与 Autoprefixer 的 PostCSS 配置。 |
| `next-env.d.ts` | Next.js 自动生成的类型声明。 |
| `.gitignore` | 忽略构建产物、环境文件和工作区运行数据。 |

## `app/`

`app` 是 Next.js App Router 入口，只负责 Web 页面和 HTTP 适配，不实现领域逻辑。

| 文件 | 职责 |
|---|---|
| `app/layout.tsx` | 根布局、全局样式和站点元数据。 |
| `app/page.tsx` | Web 首页。未配置 Provider 时显示配置向导，配置完成后显示聊天页面。 |
| `app/providers.tsx` | 客户端全局状态。负责加载配置、创建模型集合、保存 Provider、发送聊天请求。 |
| `app/globals.css` | Tailwind 入口和全局基础样式。 |
| `app/icon.png`、`app/apple-icon.png`、`app/favicon.ico` | Web 应用图标。 |

### `app/api/`

| 路由 | 职责 |
|---|---|
| `app/api/chat/route.ts` | 聊天 HTTP 入口。把请求交给 `handleChatRequest`，并向下传递浏览器断开信号。 |
| `app/api/models/route.ts` | Provider 模型列表代理，避免浏览器直连第三方 API 时的 CORS 问题。 |
| `app/api/mcp/route.ts` | HTTP Streamable MCP 入口。每次请求创建临时 MCP 服务端，响应结束后清理。 |
| `app/api/workspaces/route.ts` | 工作区列表、添加、切换、初始化和移除绑定。 |

`/api/mcp` 是 Web 形态下的对外 MCP 传输。Web 聊天则通过进程内 `InMemoryTransport` 使用同一套工具定义。

## `components/`

`components` 只负责浏览器交互和展示，不直接读写工作区文件。

| 文件 | 职责 |
|---|---|
| `components/chat.tsx` | 主聊天界面。管理会话、消息、图片、流式状态、工具卡片、Token 估算和设置弹窗。 |
| `components/setup.tsx` | 首次配置向导。选择 Provider、填写 API Key、拉取模型并保存配置。 |
| `components/tool-call-card.tsx` | 工具调用卡片。展示工具名、参数、执行状态和结果。 |
| `components/use-provider-models.ts` | 客户端 Hook。调用 `/api/models`、处理加载状态、缓存和手动模型列表。 |
| `components/use-workspaces.ts` | 客户端 Hook。读取并管理工作区列表和当前选择。 |
| `components/workspace-switcher.tsx` | 侧边栏工作区入口和选择弹窗。 |
| `components/multi-model-setup.tsx` | 多模型讨论配置：参与者增删、顺序、发言次数和讨论主题。 |
| `components/ui/*` | 基础 UI 组件，包括 Button、Card、Input、Select、Table、Textarea 和 Badge。 |

`components/ui` 不应承载业务规则。领域状态和动作必须通过 API 或服务端操作层完成。

## `lib/harness/`

通用 Agent Harness。它不依赖 Ditto、MCP、Anthropic 或 OpenAI，只处理模型轮次与工具循环。

| 文件 | 职责 |
|---|---|
| `lib/harness/types.ts` | Harness 公共契约：消息、工具源、模型适配器、权限、审批和运行事件。 |
| `lib/harness/runtime.ts` | `runHarness` 主循环。负责多轮模型调用、工具执行、结果回注、取消和超时。 |
| `lib/harness/policy.ts` | 工具策略实现，提供 allow-all、显式白名单和统一拒绝策略。 |
| `lib/harness/index.ts` | Harness 公共出口。 |

核心扩展点：

- `HarnessModelAdapter`：把某个模型 Provider 接入运行时。
- `HarnessToolSource`：提供工具定义并执行工具。
- `HarnessToolPolicy`：决定工具是 allow、deny 还是需要审批。
- `HarnessApprovalHandler`：处理需要人工确认的工具调用。

`runHarness` 不持久化会话。调用方持有消息历史，并消费 `HarnessRunEvent`。

## `lib/sdk/`

Provider 客户端和 Web 聊天服务端。

| 文件 | 职责 |
|---|---|
| `lib/sdk/types.ts` | Provider 配置、模型信息、聊天消息和 ChatModel 接口。消息类型复用 Harness 契约。 |
| `lib/sdk/llm.ts` | 浏览器侧模型封装，负责把请求发到 `/api/chat`。 |
| `lib/sdk/server.ts` | 服务端聊天处理。解析 Anthropic/OpenAI 兼容协议，并把单轮模型调用适配为 Harness。 |
| `lib/sdk/tools.ts` | Ditto MCP ToolSource。创建进程内 MCP 客户端，并实施聊天工具白名单。 |
| `lib/sdk/multi-model.ts` | 多模型讨论调度与参与者视角的消息构造。 |
| `lib/sdk/registry.ts` | 模型元数据、Token 估算、上下文裁剪和工具消息配对修复。 |
| `lib/sdk/protocol.ts` | SSE 流协议。定义 item 生命周期、工具调用、文本增量和客户端状态归并。 |
| `lib/sdk/index.ts` | 浏览器可安全导入的 SDK 出口。 |

### `lib/sdk/server.ts` 的边界

该文件的聊天链路只做两件事：

1. 把不同 Provider 的流式输出转换为 `text_delta` 和 `round_end`。
2. 把 Harness 事件序列化为 Web 使用的 SSE。

文件还包含 `/api/models` 使用的 Provider 模型列表处理逻辑。

工具权限、审批、最大轮数和超时不由 Provider 适配层决定，而是交给 `lib/harness`。

## `lib/core/`

领域层。这里定义 Ditto 的业务对象、状态机、磁盘布局和唯一业务操作实现。

### 根文件

| 文件 | 职责 |
|---|---|
| `lib/core/types.ts` | 纯类型与常量。定义项目、资产、审批、规则结果、操作者和错误码等共享结构。 |
| `lib/core/identity.ts` | 项目固有变量。模板渲染和规则校验共用同一套变量解析。 |
| `lib/core/errors.ts` | 领域错误。业务层抛 `CoreError`，入口层负责转换为 HTTP 或 MCP 错误。 |
| `lib/core/actors.ts` | 操作者构造。区分 Web 对话、HTTP MCP、本地脚本和系统操作者。 |
| `lib/core/ids.ts` | ULID 生成和 `ditto://` URI 解析。 |

### `lib/core/ops/`

`ops` 是唯一允许实现领域业务动作的目录。MCP 工具只能调用这里。

| 文件 | 职责 |
|---|---|
| `lib/core/ops/context.ts` | 操作上下文。包含工作区根目录、操作者、时钟和 ID 生成器。 |
| `lib/core/ops/project-ops.ts` | 创建、更新、流转项目，以及挂载能力包。 |
| `lib/core/ops/asset-ops.ts` | 创建、更新、改版、删除和查询资产，并维护版本历史。 |
| `lib/core/ops/template-ops.ts` | 使用能力包模板生成资产骨架。 |
| `lib/core/ops/rule-ops.ts` | 合并规则包、执行规则并保存运行记录。 |
| `lib/core/ops/approval-ops.ts` | 审批状态机和发布闸门。放行前重新计算规则。 |
| `lib/core/ops/delivery-ops.ts` | 导出已发布资产和交付清单。 |
| `lib/core/ops/handoff.ts` | 生成 AI 客户端的上下文交接摘要和下一步建议。 |
| `lib/core/ops/index.ts` | 操作层公共出口。 |

### `lib/core/store/`

存储层只负责可靠的磁盘 I/O，不决定业务规则。

| 文件 | 职责 |
|---|---|
| `lib/core/store/paths.ts` | 解析工作区，生成项目、能力包路径，并执行路径逃逸检查。 |
| `lib/core/store/fsjson.ts` | 原子写文件和 JSON，计算哈希与 canonical JSON。 |
| `lib/core/store/lock.ts` | 项目写锁。包含进程内 mutex 和跨进程 mkdir 锁。 |
| `lib/core/store/workspace.ts` | 初始化工作区和读取工作区概览。 |
| `lib/core/store/audit.ts` | 追加式 JSONL 审计流水和哈希链校验。 |
| `lib/core/store/projects.ts` | 项目文件的纯读写。 |
| `lib/core/store/assets.ts` | 资产索引、正文和历史版本的纯读写。 |
| `lib/core/store/runs.ts` | 规则执行记录读写。 |
| `lib/core/store/approvals.ts` | 审批单据读写。 |
| `lib/core/store/capabilities.ts` | 扫描工作区能力包和规则包。 |
| `lib/core/store/workspace-registry.ts` | Web 工作区注册表。校验路径、持久化选择和初始化自选目录。 |
| `lib/core/store/index.ts` | 存储层公共出口。 |

除 `fsjson.ts` 外，其他模块不应直接调用底层文件写入 API。

## `lib/rules/`

规则引擎把质量要求表达为数据，而不是可执行代码。

| 文件 | 职责 |
|---|---|
| `lib/rules/schema.ts` | 校验规则包结构，禁止可执行键和不安全正则。 |
| `lib/rules/engine.ts` | 合并规则、匹配资产、执行检查器并生成确定性结果。 |
| `lib/rules/checkers.ts` | 内置检查器。支持内容、JSON、Markdown、路径、大小等检查。 |
| `lib/rules/glob.ts` | 零依赖 glob 匹配，支持 `**`、`*`、`?` 和 `{a,b}`。 |

规则包来源优先级为：能力包自带规则，然后是工作区 `rulepacks/` 覆盖。

## `lib/capabilities/`

能力包把平台差异放在数据里，而不是散落在业务代码中。

| 文件 | 职责 |
|---|---|
| `lib/capabilities/loader.ts` | 扫描并校验 `capability.json`、模板和规则包。 |
| `lib/capabilities/render.ts` | 渲染模板变量、条件、循环和局部模板。 |
| `lib/capabilities/builtin/general.ts` | 通用底座能力包清单和种子入口。 |
| `lib/capabilities/builtin/general-templates.ts` | 项目方案、需求、部署、测试、验收等模板。 |
| `lib/capabilities/builtin/general-rules.ts` | 通用交付质量规则。 |

新增平台能力通常只需要在 `workspace/capabilities/<id>/` 下放入能力包数据。

## `lib/mcp/`

MCP 是领域能力的调用协议层，不承载业务逻辑。

| 文件 | 职责 |
|---|---|
| `lib/mcp/server.ts` | 组装 MCP 服务端，注册工具、资源和提示词。 |
| `lib/mcp/result.ts` | 统一工具返回值，把领域错误转换为 MCP 可读错误。 |
| `lib/mcp/resources.ts` | 注册工作区、项目、资产等可挂载资源。 |
| `lib/mcp/prompts.ts` | 提供建项、写资产、整改、验收和交接提示词。 |

### `lib/mcp/tools/`

| 文件 | 职责 |
|---|---|
| `lib/mcp/tools/project-asset.ts` | 项目、资产、工作区和交接类工具。 |
| `lib/mcp/tools/capability-rule.ts` | 能力包、模板和规则执行工具。 |
| `lib/mcp/tools/approval-audit.ts` | 审批、发布、导出和审计工具。 |

工具适配器只负责 zod 参数校验和文本结果转换，必须调用 `lib/core/ops`。

## `lib/workspace/`

| 文件 | 职责 |
|---|---|
| `lib/workspace/types.ts` | 浏览器与服务端共享的工作区展示结构和 API 返回类型。 |

## `scripts/`

| 脚本 | 职责 |
|---|---|
| `scripts/workspace-init.ts` | 初始化工作区并安装内置能力包。 |
| `scripts/core-smoke.ts` | 领域层端到端测试，不经过 MCP。 |
| `scripts/harness-smoke.ts` | 通用 Harness 测试，使用假模型和假工具。 |
| `scripts/multi-model-smoke.ts` | 多模型轮转顺序和视角消息构造测试。 |
| `scripts/chat-tools-smoke.ts` | Web 聊天、Harness、MCP ToolSource 和 SSE 的集成测试。 |
| `scripts/mcp-smoke.ts` | 通过 HTTP MCP 驱动的端到端交付测试。 |
| `scripts/models-smoke.ts` | Provider 模型列表、错误处理、超时和密钥脱敏测试。 |
| `scripts/race-test.ts` | 多进程并发写测试。 |
| `scripts/workspace-smoke.ts` | 工作区注册、切换、安全路径和移除绑定测试。 |
| `scripts/make-favicon.ts` | 生成 Web 图标资源。 |

## `workspace/`

`workspace` 是默认运行时数据目录，不纳入 git。

```text
workspace/
  ditto.workspace.json
  audit/YYYY-MM.jsonl
  capabilities/<capability>/
    capability.json
    templates/
    rules/
  rulepacks/
  projects/<project>/
    project.json
    assets.json
    assets/<logical-path>
    versions/<asset-id>/v<N>.<ext>
    runs/
    approvals/
  exports/<project>-<timestamp>/
```

工作区路径按以下顺序解析：

1. `DITTO_WORKSPACE`
2. 从当前目录向上查找包含 `workspace/ditto.workspace.json` 的目录
3. 当前目录下的 `workspace/`

Web 工作区选择保存在 `.ditto/workspaces.json`。该文件记录默认工作区和用户
添加的本机目录，但不会把工作区内容复制进仓库。删除或移除工作区绑定不会删除
磁盘目录。

## 多模型讨论

Web 聊天支持配置两个或更多模型参与同一场讨论。模型可以通过隐藏控制指令指定
下一位发言者；未指定或指定无效时，按参与者列表顺序轮转。每次发言都能看到用户
主题以及其他模型此前的全部发言。当前模型自己的历史输出作为 assistant 消息，
其他模型的输出作为带署名的 user 消息。

每个参与者都有独立实例 id，而不是用模型名充当身份，因此同一个 Provider/模型可以
重复加入并分别设置角色名称与角色说明，例如“GPT-4o · 正方”和“GPT-4o · 反方”。

讨论由客户端串行调度，不会让多个模型同时执行工具或写工作区。自动讨论期间工具
被禁用；达到最大发言次数或点击停止后结束。结束后可以输入新话题，继续使用同一组模型。

## 主要调用链

### Web 聊天

```text
components/chat.tsx
  -> app/api/chat/route.ts
  -> lib/sdk/server.ts
  -> lib/harness/runtime.ts
  -> lib/sdk/tools.ts
  -> lib/mcp/server.ts
  -> lib/mcp/tools/*
  -> lib/core/ops/*
  -> lib/core/store/*
```

### HTTP MCP

```text
app/api/mcp/route.ts
  -> lib/mcp/server.ts
  -> lib/mcp/tools/*
  -> lib/core/ops/*
  -> lib/core/store/*
```

### 项目交付

```text
创建项目
  -> 渲染能力包模板
  -> 执行规则
  -> 整改并重跑
  -> 提交审批
  -> 放行
  -> 导出已发布资产
```

## 依赖边界

推荐依赖方向：

```text
app -> sdk -> harness
app -> mcp -> core
mcp -> rules -> core
capabilities -> rules
```

必须遵守的结构规则：

- 领域动作只在 `lib/core/ops` 实现。
- `lib/core/store` 只做存储，不实现业务规则。
- `lib/mcp/tools` 只是 `lib/core/ops` 的协议适配层。
- `lib/harness` 不依赖 Ditto 领域类型或 MCP。
- 所有使用 `node:fs` 的模块只能被服务端代码导入。
- 客户端组件只能导入类型和浏览器安全模块。

## 常用命令

```bash
npm run dev
npm run build
npm run typecheck
npm run workspace:init
npm run workspace:smoke
npm run core:smoke
npm run harness:smoke
npm run multi-model:smoke
npm run models:smoke
npm run chat-tools:smoke
npm run mcp:smoke
npm run race:test
```

`mcp:smoke` 需要先启动 Web 服务，并默认访问 `http://localhost:3000/api/mcp`。

## 环境变量

| 变量 | 用途 |
|---|---|
| `DITTO_WORKSPACE` | 指定工作区根目录。 |
| `DITTO_WORKSPACE_REGISTRY` | 覆盖 Web 工作区注册表文件位置。 |
| `DITTO_HARNESS_MAX_ROUNDS` | Harness 最大模型轮数。 |
| `DITTO_HARNESS_TOOL_TIMEOUT_MS` | 单个工具执行超时。 |
| `DITTO_HARNESS_RUN_TIMEOUT_MS` | 单次 Harness 运行超时。 |
| `DITTO_MCP_TOKENS` | HTTP MCP 的记名 token 表，不构成认证。 |

## 修改代码时去哪里

| 需求 | 主要目录 |
|---|---|
| 修改 Agent 循环、工具权限或审批 | `lib/harness/` |
| 接入新的模型协议 | `lib/sdk/` |
| 修改多模型讨论顺序或上下文 | `lib/sdk/multi-model.ts`、`components/multi-model-setup.tsx` |
| 修改聊天页面或 Provider 设置 | `app/`、`components/` |
| 修改工作区选择或路径校验 | `app/api/workspaces/`、`lib/core/store/workspace-registry.ts`、`components/workspace-switcher.tsx` |
| 修改项目、资产、审批业务逻辑 | `lib/core/ops/` |
| 修改磁盘格式或并发保护 | `lib/core/store/` |
| 修改质量规则 | `lib/rules/`、`workspace/rulepacks/` |
| 新增平台能力包或模板 | `lib/capabilities/`、`workspace/capabilities/` |
| 修改 Web 对外工具 | `lib/mcp/tools/` |
| 增加测试 | `scripts/` |

## 当前边界

- 只支持 Web 运行形态，不提供 stdio MCP。
- 本机目录选择要求 Web 服务与用户在同一台机器上。
- Web UI 只移除工作区绑定，不提供删除磁盘目录的操作。
- Web MCP 无状态，每个请求创建独立服务端实例。
- 操作者身份是自报字段，用于审计留痕，不是鉴权。
- YAML 资产目前只支持通用内容和大小检查，不解析结构。
- Web 聊天中的工具是显式白名单，默认不允许写操作和审批。
