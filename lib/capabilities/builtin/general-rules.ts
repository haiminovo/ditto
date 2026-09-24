/**
 * Ditto 实施平台 - 「通用底座」能力包规则集
 *
 * 全部是**声明式数据**。加载时会经过 lib/rules/schema.ts 的校验：
 * 拒绝任何可执行键，拒绝嵌套量词正则（ReDoS）。
 *
 * 关于严重级别的取舍：
 *   - 明文口令、TODO 残留、示例域名 → error（交付物里出现即不合格）
 *   - 私网 IP 出现在**脚本**里 → error（部署脚本必须参数化，硬编码内网地址是真缺陷）
 *   - 私网 IP 出现在**文档**里 → warn（拓扑说明里出现内网地址可能是合理的）
 *
 * 这个区分不是随手定的：把可能合法的东西一律判死刑，规则就会被整体忽略，
 * 闸门随之失效。
 */

import type { RulePack } from "../../core/types";

/* ------------------------------------------------------------------ */
/* 复用片段                                                            */
/* ------------------------------------------------------------------ */

/**
 * 疑似真实口令/密钥的字面量。
 *
 * 刻意不匹配 {{占位符}} —— 占位符是合规写法，不是缺陷。
 * 键名两侧的可选引号是必须的：JSON 里写作 `"password": "..."`，
 * 只允许空白分隔会让这条规则对 JSON 完全失效。
 */
const SECRET_LITERAL =
  '(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)' +
  '\\s*["\\x27]?\\s*[:=]\\s*["\\x27]?[A-Za-z0-9+/=_-]{8,}';

/** 未替换的模板变量残留 */
const UNRESOLVED_VAR = "\\{\\{[A-Za-z0-9_.@]+\\}\\}";

/** 示例/占位域名 —— 交付物里出现说明没换成真实域名 */
const PLACEHOLDER_DOMAIN = "(example\\.(com|org|net)|test\\.local|your-domain|xxx\\.com)";

/** 交付前必须消灭的待办标记 */
const TODO_MARKERS = "(TODO|FIXME|XXX|待补充|待确认|待填写|占位)";

/* ------------------------------------------------------------------ */
/* 1. 基础：元数据与结构                                                */
/* ------------------------------------------------------------------ */

const BASE: RulePack = {
  schemaVersion: 1,
  id: "general-base",
  name: "通用底座 · 基础规范",
  version: "1.0.0",
  description: "资产元数据完整性、路径唯一性、跨资产引用完整性、能力包参数兼容性",
  blockingSeverities: ["error", "warn"],
  rules: [
    {
      id: "base-required-meta",
      name: "资产元数据必填",
      description: "每个资产都必须有名称、类型、格式与责任人",
      severity: "error",
      enabled: true,
      appliesTo: {},
      checker: {
        type: "required-fields",
        scope: "meta",
        fields: ["name", "kind", "format", "owner"],
      },
      remediation: "在资产元数据里补齐 name / kind / format / owner。可通过 MCP 调用 ditto_asset_update 的 patch 参数编辑。",
    },
    {
      id: "base-unique-path",
      name: "资产路径唯一",
      severity: "error",
      enabled: true,
      appliesTo: {},
      checker: { type: "unique-path" },
      remediation: "同一路径只能有一个资产；重命名或删除重复项。",
    },
    {
      id: "base-reference-integrity",
      name: "跨资产引用有效",
      description: "正文中 [[asset:路径]] 引用的资产必须存在",
      severity: "error",
      enabled: true,
      appliesTo: { formats: ["markdown"] },
      checker: { type: "reference-integrity", allowExternal: false },
      remediation: "修正引用路径，或先创建被引用的资产。",
    },
    {
      id: "base-capability-vars",
      name: "能力包所需变量齐备",
      severity: "error",
      enabled: true,
      appliesTo: {},
      checker: { type: "capability-compat" },
      remediation: "在项目变量里补齐必填项，或调整能力包参数。",
    },
  ],
};

/* ------------------------------------------------------------------ */
/* 2. 文档                                                            */
/* ------------------------------------------------------------------ */

const DOCS: RulePack = {
  schemaVersion: 1,
  id: "general-docs",
  name: "通用底座 · 交付文档规范",
  version: "1.0.0",
  description: "文档结构、内容禁忌与篇幅约束",
  rules: [
    {
      id: "docs-heading-deploy-plan",
      name: "部署方案章节完整",
      severity: "warn",
      enabled: true,
      appliesTo: { paths: ["design/*.md"], formats: ["markdown"] },
      checker: {
        type: "heading-structure",
        requiredHeadings: ["实施步骤", "回滚"],
        ordered: false,
      },
      remediation: "补齐「实施步骤」与「回滚方案」章节 —— 缺回滚方案的部署文档不予放行。",
    },
    {
      id: "docs-heading-test-plan",
      name: "测试方案章节完整",
      severity: "warn",
      enabled: true,
      appliesTo: { paths: ["test/*.md"], formats: ["markdown"] },
      checker: {
        type: "heading-structure",
        requiredHeadings: ["测试用例", "测试结论"],
        ordered: false,
      },
      remediation: "补齐「测试用例」与「测试结论」章节。",
    },
    {
      id: "docs-heading-acceptance",
      name: "验收报告章节完整",
      severity: "warn",
      enabled: true,
      appliesTo: { paths: ["acceptance/*.md"], formats: ["markdown"] },
      checker: {
        type: "heading-structure",
        requiredHeadings: ["验收清单", "验收结论"],
        ordered: false,
      },
      remediation: "补齐「验收清单」与「验收结论」章节。",
    },
    {
      id: "docs-todo-residue",
      name: "文档无待办残留",
      severity: "error",
      enabled: true,
      appliesTo: { formats: ["markdown"] },
      checker: {
        type: "forbidden-content",
        patterns: [TODO_MARKERS],
        flags: "i",
        scan: "content",
      },
      remediation: "把 TODO / 待补充 替换为实际内容。这些标记说明文档还没写完。",
    },
    {
      id: "docs-placeholder-domain",
      name: "文档无示例域名",
      severity: "error",
      enabled: true,
      appliesTo: { formats: ["markdown"] },
      checker: {
        type: "forbidden-content",
        patterns: [PLACEHOLDER_DOMAIN],
        flags: "i",
        scan: "content",
      },
      remediation: "把 example.com / test.local 换成真实域名，或在项目变量里设置 domain。",
    },
    {
      id: "docs-unresolved-var",
      name: "文档无未替换变量",
      severity: "error",
      enabled: true,
      appliesTo: { formats: ["markdown"] },
      checker: {
        type: "forbidden-content",
        patterns: [UNRESOLVED_VAR],
        flags: "",
        scan: "content",
      },
      remediation: "模板变量未被替换，请重新渲染该资产。",
    },
    {
      id: "docs-private-ip-warn",
      name: "文档中的内网地址需复核",
      description: "拓扑文档里出现内网地址可能是合理的，故只提示不阻断",
      severity: "warn",
      enabled: true,
      appliesTo: { formats: ["markdown"] },
      checker: {
        type: "forbidden-content",
        patterns: ["\\b(10\\.[0-9]{1,3}|192\\.168\\.|172\\.(1[6-9]|2[0-9]|3[01])\\.)"],
        flags: "",
        scan: "content",
      },
      remediation: "确认该内网地址是交付必需的；如属于测试残留请删除。",
    },
    {
      id: "docs-min-length",
      name: "文档篇幅达标",
      severity: "warn",
      enabled: true,
      appliesTo: { kinds: ["doc", "design"], formats: ["markdown"] },
      checker: { type: "size-limit", minBytes: 300 },
      remediation: "文档内容过少，补充实质描述。",
    },
  ],
};

/* ------------------------------------------------------------------ */
/* 3. 配置                                                            */
/* ------------------------------------------------------------------ */

const CONFIG: RulePack = {
  schemaVersion: 1,
  id: "general-config",
  name: "通用底座 · 配置规范",
  version: "1.0.0",
  description: "应用配置的结构化校验与凭据禁忌",
  rules: [
    {
      id: "config-schema-app",
      name: "应用配置结构合规",
      severity: "error",
      enabled: true,
      appliesTo: { kinds: ["config"], formats: ["json"], paths: ["config/*.json"] },
      checker: {
        type: "json-schema",
        schema: {
          type: "object",
          required: ["application", "server", "datasource", "logging"],
          properties: {
            application: {
              type: "object",
              required: ["name", "code", "environment", "domain", "version"],
              properties: {
                name: { type: "string", minLength: 1 },
                code: { type: "string", minLength: 1 },
                environment: { type: "string", enum: ["dev", "test", "staging", "prod"] },
                domain: { type: "string", minLength: 3 },
                version: { type: "string", pattern: "^[0-9]+\\.[0-9]+\\.[0-9]+" },
              },
            },
            server: {
              type: "object",
              required: ["port"],
              properties: {
                port: { type: "integer", minimum: 1, maximum: 65535 },
                maxThreads: { type: "integer", minimum: 1 },
              },
            },
            datasource: {
              type: "object",
              required: ["url", "username", "password"],
              properties: {
                url: { type: "string", minLength: 1 },
                username: { type: "string", minLength: 1 },
                password: { type: "string", minLength: 1 },
                pool: { type: "object" },
              },
            },
            logging: {
              type: "object",
              required: ["level", "path"],
              properties: {
                level: { type: "string", enum: ["DEBUG", "INFO", "WARN", "ERROR"] },
                path: { type: "string", minLength: 1 },
              },
            },
            security: { type: "object" },
          },
        },
      },
      remediation: "按 config/app-config.json 模板的结构补齐字段；environment 必须是 dev/test/staging/prod 之一。",
    },
    {
      id: "config-json-valid",
      name: "配置文件语法合法",
      severity: "error",
      enabled: true,
      appliesTo: { formats: ["json"] },
      checker: { type: "format-valid", format: "json" },
      remediation: "修复 JSON 语法错误。",
    },
    {
      id: "config-secret-literal",
      name: "配置中不得出现明文口令",
      description: "只拦疑似真实口令的字面量；{{占位符}} 与 ${变量} 是合规写法",
      severity: "error",
      enabled: true,
      appliesTo: { formats: ["json", "yaml", "text"] },
      checker: {
        type: "forbidden-content",
        patterns: [SECRET_LITERAL],
        flags: "i",
        scan: "content",
      },
      remediation: "改为从密钥管理服务或环境变量注入；配置文件中只保留占位符。",
    },
    {
      id: "config-todo-residue",
      name: "配置无待办残留",
      severity: "error",
      enabled: true,
      appliesTo: { formats: ["json"] },
      checker: {
        type: "forbidden-content",
        patterns: [TODO_MARKERS],
        flags: "i",
        scan: "content",
      },
      remediation: "补齐配置项。",
    },
  ],
};

/* ------------------------------------------------------------------ */
/* 4. 脚本                                                            */
/* ------------------------------------------------------------------ */

const SCRIPT: RulePack = {
  schemaVersion: 1,
  id: "general-script",
  name: "通用底座 · 运维脚本规范",
  version: "1.0.0",
  description: "运维脚本的安全与健壮性约束",
  rules: [
    {
      id: "script-secret-literal",
      name: "脚本中不得硬编码凭据",
      severity: "error",
      enabled: true,
      appliesTo: { kinds: ["script"], formats: ["shell"] },
      checker: {
        type: "forbidden-content",
        patterns: [SECRET_LITERAL],
        flags: "i",
        scan: "content",
      },
      remediation: "凭据必须来自环境变量或密钥服务，不得写死在脚本里。",
    },
    {
      id: "script-hardcoded-ip",
      name: "脚本中不得硬编码内网地址",
      description: "部署脚本必须参数化，硬编码内网 IP 会导致换环境即失效",
      severity: "error",
      enabled: true,
      appliesTo: { kinds: ["script"], formats: ["shell"] },
      checker: {
        type: "forbidden-content",
        patterns: [
          "\\b(10\\.[0-9]{1,3}\\.[0-9]{1,3}|192\\.168\\.[0-9]{1,3}|172\\.(1[6-9]|2[0-9]|3[01])\\.[0-9]{1,3})\\.[0-9]{1,3}",
          "\\b(127\\.0\\.0\\.1|localhost)\\b",
        ],
        flags: "",
        scan: "content",
      },
      remediation: "把地址提取为变量或配置文件，脚本通过参数读取。",
    },
    {
      id: "script-todo-residue",
      name: "脚本无待办残留",
      severity: "error",
      enabled: true,
      appliesTo: { kinds: ["script"], formats: ["shell"] },
      checker: {
        type: "forbidden-content",
        patterns: [TODO_MARKERS],
        flags: "i",
        scan: "content",
      },
      remediation: "脚本里的 TODO 说明关键逻辑未实现，补齐后再交付。",
    },
    {
      id: "script-unresolved-var",
      name: "脚本无未替换变量",
      severity: "error",
      enabled: true,
      appliesTo: { kinds: ["script"], formats: ["shell"] },
      checker: {
        type: "forbidden-content",
        patterns: [UNRESOLVED_VAR],
        flags: "",
        scan: "content",
      },
      remediation: "模板变量未被替换，请重新渲染该脚本。",
    },
  ],
};

/* ------------------------------------------------------------------ */
/* 5. 交付齐套性                                                       */
/* ------------------------------------------------------------------ */

const DELIVERY: RulePack = {
  schemaVersion: 1,
  id: "general-delivery",
  name: "通用底座 · 交付物齐套性",
  version: "1.0.0",
  description: "项目级交付物完整性与验收检查单完成度",
  blockingSeverities: ["error", "warn"],
  rules: [
    {
      id: "delivery-required-assets",
      name: "必备交付物齐全",
      severity: "error",
      enabled: true,
      appliesTo: {},
      checker: {
        type: "file-exists",
        globs: [
          "docs/*.md",
          "design/*.md",
          "config/*.json",
          "scripts/*.sh",
          "test/*.md",
          "acceptance/*.md",
        ],
      },
      remediation: "在对应目录下补齐缺失的交付物；可用 ditto_template_apply 从能力包生成。",
    },
    {
      id: "delivery-acceptance-checklist",
      name: "验收检查单已完成",
      severity: "error",
      enabled: true,
      appliesTo: {},
      checker: {
        type: "checklist-complete",
        path: "acceptance/01-验收报告.md",
        requireEvidence: true,
      },
      remediation: "逐项完成并勾选验收清单；要求附证据的条目必须先取得证据。",
    },
    {
      id: "delivery-scripts-present",
      name: "部署与回滚脚本齐备",
      severity: "error",
      enabled: true,
      appliesTo: {},
      checker: {
        type: "file-exists",
        globs: ["scripts/deploy.sh", "scripts/rollback.sh"],
        atLeast: 2,
      },
      remediation: "部署脚本与回滚脚本缺一不可 —— 没有回滚方案的交付不允许上线。",
    },
  ],
};

/* ------------------------------------------------------------------ */
/* 6. 项目级                                                            */
/* ------------------------------------------------------------------ */

const PROJECT: RulePack = {
  schemaVersion: 1,
  id: "general-project",
  name: "通用底座 · 项目发布门禁",
  version: "1.0.0",
  description: "项目级发布前的元数据完整性",
  blockingSeverities: ["error", "warn"],
  rules: [
    {
      id: "project-required-meta",
      name: "项目元数据完整",
      severity: "error",
      enabled: true,
      appliesTo: {},
      checker: {
        type: "project-metadata",
        fields: ["name", "code", "customer", "owner"],
      },
      remediation: "补齐项目名称、编号、客户与责任人。",
    },
    {
      id: "project-vars-required",
      name: "项目变量齐备",
      description: "渲染模板所需的项目变量必须已填写",
      severity: "error",
      enabled: true,
      appliesTo: {},
      checker: {
        type: "required-fields",
        scope: "vars",
        fields: ["customer.name", "domain", "env.name"],
      },
      remediation:
        "用 ditto_project_update 补齐项目变量；domain 填真实域名，" +
        "placeholder 域名会被 docs-placeholder-domain 规则拦下。",
    },
  ],
};

/** 通用底座的规则包集合 */
export const GENERAL_RULE_PACKS: RulePack[] = [
  BASE,
  DOCS,
  CONFIG,
  SCRIPT,
  DELIVERY,
  PROJECT,
];

export { SECRET_LITERAL, UNRESOLVED_VAR, PLACEHOLDER_DOMAIN, TODO_MARKERS };
