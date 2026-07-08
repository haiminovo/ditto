# Ditto

多 Provider LLM 客户端 - 支持 OpenAI、Anthropic 原生 API，带 Web 界面。

## 快速开始

### 安装依赖

```bash
npm install
```

### 启动开发服务器

```bash
npm run dev
```

访问 http://localhost:3000

## 项目结构

```
ditto/
├── app/              # Next.js App Router
├── components/       # React 组件
│   └── ui/          # 基础 UI 组件
├── lib/
│   └── sdk/         # 核心 SDK
├── package.json
├── tailwind.config.ts
├── tsconfig.json
└── README.md
```

## 支持的 Providers

- **Anthropic** (原生 API) - Claude 3 系列
- **OpenAI** (兼容 API) - GPT-4 系列
- **OpenRouter** (兼容 API)
- **DeepSeek** (兼容 API)
- **Qwen** (通义千问，兼容 API)
- **Ollama** (本地，兼容 API)

## 配置持久化

- Web 版本使用 localStorage 存储配置
- 配置文件不会上传到任何服务器

## 命令行工具原理

使用:
- `commander` - 命令参数解析
- `inquirer` - 交互式菜单
- `chalk` - 彩色输出
- `ora` - 加载动画

配置保存到 `~/.ditto/config.json`
