/**
 * Ditto 实施平台 - 项目固有变量
 *
 * 纯函数，零 I/O。
 *
 * 存在的理由：模板渲染与规则校验**必须对"项目变量"这件事有一致的理解**。
 * 曾经两边各算各的 —— 渲染用了派生出来的 customer.name，规则只看原始
 * project.vars —— 结果是一份渲染得好好的文档被判"必填项缺失"。
 * 闸门一旦和渲染器说法不一致，它就不再可信。
 */

import type { Project, VarSpec } from "./types";

export interface ProjectIdentity {
  id: string;
  name: string;
  code: string;
  customer: string;
}

/**
 * 把项目固有属性摊平成模板变量。
 *
 * `customer.name` 映射到 project.customer 是刻意的：这两者是同一件事，
 * 分成两个独立可编辑的位置必然漂移 —— 项目改了客户名，交付文档却还是旧的。
 * 需要"以别名出具交付物"时，显式设置同名变量覆盖即可。
 */
export function identityToVars(project: ProjectIdentity): Record<string, string> {
  return {
    "project.id": project.id,
    "project.name": project.name,
    "project.code": project.code,
    "project.customer": project.customer,
    "customer.name": project.customer,
  };
}

/**
 * 计算项目**有效变量**：合并顺序（越靠后优先级越高）
 *   项目固有属性 → 能力包默认值 → 项目显式变量
 *
 * 渲染与规则校验都调用这个函数，保证两边看到的是同一份东西。
 */
export function effectiveVars(
  project: Pick<Project, "id" | "name" | "code" | "customer" | "vars">,
  varSpecs: VarSpec[] = []
): Record<string, string> {
  const out: Record<string, string> = {};

  Object.assign(out, identityToVars(project));

  for (const spec of varSpecs) {
    if (spec.default !== undefined) out[spec.key] = spec.default;
  }

  for (const [k, v] of Object.entries(project.vars)) {
    if (v !== undefined && v !== null && v !== "") out[k] = String(v);
  }

  return out;
}
