/**
 * Ditto 实施平台 - 「通用底座」能力包模板
 *
 * 这些是**起点，不是成品**。
 *
 * 刻意保留 TODO 占位与示例域名的原因是：渲染出来的资产默认就应该过不了
 * 质量闸门 —— 它还没被填过项目实情。规则引擎会把这些标出来，这正是
 * 「以规则引擎保证交付质量」的实际形态。想让它变绿，只有一条路：
 * 补齐项目信息。没有后门。
 */

export const GENERAL_TEMPLATES: Record<string, string> = {
  /* ---------------------------------------------------------------- */
  /* 文档                                                              */
  /* ---------------------------------------------------------------- */
  "project-charter.md": `# {{project.name}} 项目实施方案

| 项目 | 内容 |
| --- | --- |
| 项目名称 | {{project.name}} |
| 项目编号 | {{project.code}} |
| 客户名称 | {{customer.name}} |
| 目标环境 | {{env.name}} |
| 编制日期 | {{date}} |

## 一、项目背景

<!-- TODO: 补充项目建设背景与业务诉求 -->

## 二、实施范围

### 2.1 纳入范围

<!-- TODO: 逐条列出本次实施覆盖的业务模块与系统边界 -->

### 2.2 不纳入范围

<!-- TODO: 明确排除项，避免验收时扯皮 -->

## 三、实施目标

<!-- TODO: 用可验证的语句写目标，例如"完成 3 个业务模块上线并稳定运行 7 天" -->

## 四、里程碑计划

| 阶段 | 交付物 | 计划开始 | 计划结束 | 责任人 |
| --- | --- | --- | --- | --- |
| 需求确认 | 需求确认单 | <!-- TODO --> | <!-- TODO --> | <!-- TODO --> |
| 环境准备 | 部署方案 | <!-- TODO --> | <!-- TODO --> | <!-- TODO --> |
| 部署实施 | 部署记录 | <!-- TODO --> | <!-- TODO --> | <!-- TODO --> |
| 测试验证 | 测试报告 | <!-- TODO --> | <!-- TODO --> | <!-- TODO --> |
| 上线验收 | 验收报告 | <!-- TODO --> | <!-- TODO --> | <!-- TODO --> |

## 五、组织与职责

| 角色 | 姓名 | 职责 | 联系方式 |
| --- | --- | --- | --- |
| 项目经理 | <!-- TODO --> | 整体协调 | <!-- TODO --> |
| 技术负责人 | <!-- TODO --> | 技术方案与实施 | <!-- TODO --> |
| 客户接口人 | <!-- TODO --> | 需求确认与验收 | <!-- TODO --> |

## 六、风险与应对

| 风险 | 影响 | 应对措施 |
| --- | --- | --- |
| <!-- TODO --> | <!-- TODO --> | <!-- TODO --> |

## 七、沟通机制

<!-- TODO: 例会频率、汇报路径、问题升级机制 -->
`,

  "requirements.md": `# {{project.name}} 需求确认单

| 项目 | 内容 |
| --- | --- |
| 项目编号 | {{project.code}} |
| 客户名称 | {{customer.name}} |
| 确认日期 | {{date}} |

## 一、功能需求

| 序号 | 需求描述 | 优先级 | 验收标准 | 客户确认 |
| --- | --- | --- | --- | --- |
| 1 | <!-- TODO --> | 高 | <!-- TODO --> | [ ] |
| 2 | <!-- TODO --> | 中 | <!-- TODO --> | [ ] |

## 二、非功能需求

| 类别 | 要求 | 备注 |
| --- | --- | --- |
| 性能 | <!-- TODO: 并发数、响应时间 --> | |
| 可用性 | <!-- TODO: 可用率、容灾要求 --> | |
| 安全 | <!-- TODO: 等保级别、加密要求 --> | |
| 兼容性 | <!-- TODO: 浏览器/客户端版本 --> | |

## 三、集成需求

<!-- TODO: 列出需要对接的第三方系统、接口协议、数据流向 -->

## 四、约束与假设

<!-- TODO: 列出前提条件，例如"客户提供服务器资源" -->

## 五、客户确认

- [ ] 需求范围已与客户逐条确认
- [ ] 非功能指标已达成一致
- [ ] 集成接口清单已确认

> 签字：______________ 日期：______________
`,

  "topology.md": `# {{project.name}} 部署拓扑

| 项目 | 内容 |
| --- | --- |
| 项目编号 | {{project.code}} |
| 目标环境 | {{env.name}} |
| 访问域名 | {{domain}} |
| 编制日期 | {{date}} |

## 一、网络分区

<!-- TODO: 描述 DMZ / 应用区 / 数据区的划分与访问控制策略 -->

## 二、节点清单

| 序号 | 主机名 | 角色 | IP 地址 | 规格 | 操作系统 |
| --- | --- | --- | --- | --- | --- |
| 1 | <!-- TODO --> | 应用节点 | <!-- TODO --> | <!-- TODO --> | <!-- TODO --> |
| 2 | <!-- TODO --> | 数据库 | <!-- TODO --> | <!-- TODO --> | <!-- TODO --> |

## 三、组件部署关系

<!-- TODO: 用文字或图描述各组件部署在哪些节点、端口如何分配 -->

## 四、端口与协议

| 端口 | 协议 | 用途 | 来源 | 是否对外 |
| --- | --- | --- | --- | --- |
| <!-- TODO --> | TCP | <!-- TODO --> | <!-- TODO --> | 否 |

## 五、外部依赖

| 依赖项 | 地址 | 用途 | 责任人 |
| --- | --- | --- | --- |
| <!-- TODO --> | <!-- TODO --> | <!-- TODO --> | <!-- TODO --> |

## 六、访问入口

- 生产域名：{{domain}}
- <!-- TODO: 补充负载均衡、CDN、WAF 等入口配置 -->
`,

  "deploy-plan.md": `# {{project.name}} 部署实施步骤

| 项目 | 内容 |
| --- | --- |
| 项目编号 | {{project.code}} |
| 目标环境 | {{env.name}} |
| 实施窗口 | <!-- TODO: 填写计划维护窗口 --> |
| 编制日期 | {{date}} |

## 一、实施前检查

- [ ] 服务器资源已按拓扑清单就绪
- [ ] 网络策略已开通
- [ ] 应用包与配置文件已就位
- [ ] 回滚方案已评审
- [ ] 客户已确认实施窗口

## 二、实施步骤

### 2.1 基础环境准备

<!-- TODO: 逐条列出操作系统参数、依赖组件、目录结构 -->

### 2.2 应用部署

<!-- TODO: 逐条列出应用包解压、配置替换、权限设置 -->

### 2.3 服务启动与验证

<!-- TODO: 逐条列出启停命令与验证方式 -->

## 三、验证清单

| 序号 | 验证项 | 预期结果 | 实际结果 | 验证人 |
| --- | --- | --- | --- | --- |
| 1 | 服务进程状态 | 正常运行 | | |
| 2 | 健康检查接口 | 返回 200 | | |
| 3 | 关键业务功能 | 可正常访问 | | |

## 四、回滚方案

<!-- TODO: 写清触发条件、回滚步骤与预计耗时 -->
详见 \`[[asset:scripts/rollback.sh]]\`。

## 五、实施记录

| 时间 | 操作 | 操作人 | 结果 |
| --- | --- | --- | --- |
| <!-- TODO --> | | | |
`,

  "handover.md": `# {{project.name}} 运维交接手册

| 项目 | 内容 |
| --- | --- |
| 项目编号 | {{project.code}} |
| 客户名称 | {{customer.name}} |
| 交接日期 | {{date}} |

## 一、系统概述

<!-- TODO: 用一段话说明系统做什么、服务哪些用户 -->

## 二、部署架构

详见 \`[[asset:design/01-部署拓扑.md]]\`。

## 三、日常运维

### 3.1 服务启停

<!-- TODO: 列出各服务的启动、停止、重启命令 -->

### 3.2 日志位置

| 服务 | 日志路径 | 保留周期 |
| --- | --- | --- |
| <!-- TODO --> | <!-- TODO --> | <!-- TODO --> |

### 3.3 备份策略

| 对象 | 频率 | 保留 | 存放位置 |
| --- | --- | --- | --- |
| <!-- TODO --> | 每日 | 30 天 | <!-- TODO --> |

## 四、监控与告警

<!-- TODO: 列出监控项、阈值、告警接收人 -->

## 五、常见问题处理

| 现象 | 可能原因 | 处理办法 |
| --- | --- | --- |
| <!-- TODO --> | <!-- TODO --> | <!-- TODO --> |

## 六、应急联系

| 角色 | 姓名 | 电话 |
| --- | --- | --- |
| 一线运维 | <!-- TODO --> | <!-- TODO --> |
| 二线支持 | <!-- TODO --> | <!-- TODO --> |
`,

  "test-plan.md": `# {{project.name}} 测试方案

| 项目 | 内容 |
| --- | --- |
| 项目编号 | {{project.code}} |
| 目标环境 | {{env.name}} |
| 编制日期 | {{date}} |

## 一、测试范围

<!-- TODO: 明确本次测试覆盖的功能模块与不覆盖的部分 -->

## 二、测试环境

| 项 | 说明 |
| --- | --- |
| 应用地址 | https://{{domain}} |
| 数据库 | <!-- TODO --> |
| 测试数据 | <!-- TODO --> |

## 三、测试用例

| 序号 | 用例名称 | 前置条件 | 操作步骤 | 预期结果 | 实际结果 | 结论 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | <!-- TODO --> | <!-- TODO --> | <!-- TODO --> | <!-- TODO --> | | |
| 2 | <!-- TODO --> | <!-- TODO --> | <!-- TODO --> | <!-- TODO --> | | |

## 四、性能测试

| 指标 | 目标值 | 实测值 | 结论 |
| --- | --- | --- | --- |
| 并发用户数 | <!-- TODO --> | | |
| 平均响应时间 | <!-- TODO --> | | |
| 错误率 | <!-- TODO --> | | |

## 五、缺陷记录

| 编号 | 描述 | 严重级别 | 状态 | 修复版本 |
| --- | --- | --- | --- | --- |
| <!-- TODO --> | | | | |

## 六、测试结论

<!-- TODO: 汇总通过率与遗留问题，给出是否具备上线条件的结论 -->
`,

  "acceptance.md": `# {{project.name}} 验收报告

| 项目 | 内容 |
| --- | --- |
| 项目名称 | {{project.name}} |
| 项目编号 | {{project.code}} |
| 客户名称 | {{customer.name}} |
| 验收日期 | {{date}} |

## 一、验收依据

<!-- TODO: 列出合同、需求确认单、测试方案等依据文件 -->

## 二、验收范围

<!-- TODO: 列明本次验收覆盖的内容 -->

## 三、验收清单

- [ ] 所有功能需求已按需求确认单交付（需证据）
- [ ] 非功能指标经测试验证达标（需证据）
- [ ] 部署文档与运维手册已移交（需证据）
- [ ] 客户完成验收测试并确认通过（需证据）
- [ ] 遗留问题已明确处理计划

## 四、交付物清单

| 序号 | 交付物 | 存放位置 | 是否移交 |
| --- | --- | --- | --- |
| 1 | 项目实施方案 | docs/01-项目实施方案.md | [ ] |
| 2 | 部署拓扑 | design/01-部署拓扑.md | [ ] |
| 3 | 运维交接手册 | docs/03-运维交接手册.md | [ ] |
| 4 | 测试方案 | test/01-测试方案.md | [ ] |

## 五、遗留问题

| 编号 | 问题描述 | 影响 | 计划解决时间 | 责任人 |
| --- | --- | --- | --- | --- |
| <!-- TODO: 无遗留问题则写"无" --> | | | | |

## 六、验收结论

<!-- TODO: 明确写出"通过 / 有条件通过 / 不通过" -->

## 七、签字确认

| 角色 | 姓名 | 签字 | 日期 |
| --- | --- | --- | --- |
| 客户项目负责人 | | | |
| 实施方项目负责人 | | | |
`,

  /* ---------------------------------------------------------------- */
  /* 配置（JSON）—— 值里的占位符会被 JSON 转义                        */
  /* ---------------------------------------------------------------- */
  "app-config.json": `{
  "application": {
    "name": "{{project.name}}",
    "code": "{{project.code}}",
    "environment": "{{env.name}}",
    "domain": "{{domain}}",
    "version": "1.0.0"
  },
  "server": {
    "port": 8080,
    "contextPath": "/",
    "maxThreads": 200,
    "sessionTimeoutMinutes": 30
  },
  "datasource": {
    "url": "jdbc:mysql://DB_HOST:3306/APP_DB?useUnicode=true&characterEncoding=utf8",
    "username": "APP_USER",
    "password": "CHANGE_ME_IN_VAULT",
    "pool": {
      "initialSize": 5,
      "minIdle": 5,
      "maxActive": 50,
      "validationQuery": "SELECT 1"
    }
  },
  "logging": {
    "level": "INFO",
    "path": "/var/log/{{project.code}}",
    "maxHistoryDays": 30
  },
  "security": {
    "enableHttps": true,
    "allowedOrigins": ["https://{{domain}}"]
  }
}
`,

  /* ---------------------------------------------------------------- */
  /* 脚本（shell）—— 值会被 POSIX 单引号转义                            */
  /* ---------------------------------------------------------------- */
  "deploy.sh": `#!/usr/bin/env bash
#
# {{project.name}} 部署脚本
# 由 ditto 能力包 general 生成，请勿手工修改生成部分。
#
set -euo pipefail

APP_NAME={{project.code}}
APP_ENV={{env.name}}
APP_DOMAIN={{domain}}
APP_HOME="/opt/apps/\${APP_NAME}"
BACKUP_DIR="/opt/backups/\${APP_NAME}"

log() { echo "[\$(date '+%Y-%m-%d %H:%M:%S')] \$*"; }
fail() { log "ERROR: \$*" >&2; exit 1; }

[ -d "\${APP_HOME}" ] || fail "应用目录不存在：\${APP_HOME}"

log "开始部署 \${APP_NAME} (\${APP_ENV})"

# 1) 备份当前版本
BACKUP_PATH="\${BACKUP_DIR}/\$(date '+%Y%m%d%H%M%S')"
mkdir -p "\${BACKUP_PATH}"
cp -a "\${APP_HOME}/current/." "\${BACKUP_PATH}/"
log "已备份至 \${BACKUP_PATH}"

# 2) 停止服务
if systemctl is-active --quiet "\${APP_NAME}"; then
  systemctl stop "\${APP_NAME}"
  log "服务已停止"
fi

# 3) 分发应用包
# TODO: 填写制品来源，例如从制品库拉取或从本地释放目录同步
tar -xzf /tmp/\${APP_NAME}.tar.gz -C "\${APP_HOME}/current"

# 4) 校验配置文件
CONFIG="\${APP_HOME}/current/config/app-config.json"
[ -f "\${CONFIG}" ] || fail "缺少配置文件：\${CONFIG}"
log "配置文件校验通过"

# 5) 启动服务
systemctl start "\${APP_NAME}"
sleep 5

# 6) 健康检查
HTTP_CODE=\$(curl -s -o /dev/null -w '%{http_code}' "https://\${APP_DOMAIN}/actuator/health" || true)
if [ "\${HTTP_CODE}" != "200" ]; then
  fail "健康检查失败（HTTP \${HTTP_CODE}），请执行回滚脚本"
fi

log "部署完成：\${APP_NAME} @ \${APP_DOMAIN}"
`,

  "rollback.sh": `#!/usr/bin/env bash
#
# {{project.name}} 回滚脚本
#
set -euo pipefail

APP_NAME={{project.code}}
APP_HOME="/opt/apps/\${APP_NAME}"
BACKUP_DIR="/opt/backups/\${APP_NAME}"

log() { echo "[\$(date '+%Y-%m-%d %H:%M:%S')] \$*"; }
fail() { log "ERROR: \$*" >&2; exit 1; }

# 用法：./rollback.sh [备份目录名]   省略则回滚到最近一次备份
TARGET="\${1:-}"

if [ -z "\${TARGET}" ]; then
  TARGET=\$(ls -1 "\${BACKUP_DIR}" 2>/dev/null | sort -r | head -n 1 || true)
fi
[ -n "\${TARGET}" ] || fail "找不到可用备份"
[ -d "\${BACKUP_DIR}/\${TARGET}" ] || fail "备份不存在：\${BACKUP_DIR}/\${TARGET}"

log "准备回滚到 \${TARGET}"

systemctl stop "\${APP_NAME}" || true

rm -rf "\${APP_HOME}/current"
mkdir -p "\${APP_HOME}/current"
cp -a "\${BACKUP_DIR}/\${TARGET}/." "\${APP_HOME}/current/"

systemctl start "\${APP_NAME}"
sleep 5

if systemctl is-active --quiet "\${APP_NAME}"; then
  log "回滚完成，服务已恢复"
else
  fail "回滚后服务未能启动，请人工介入"
fi
`,
};
