/**
 * Ditto 实施平台 - 手写 glob
 *
 * 零依赖，支持 `**` `*` `?` `{a,b}`。
 * Node 22 的 fs.glob 仍是实验特性，不依赖它。
 *
 * 匹配对象是资产的**逻辑路径**（始终以正斜杠分隔）。
 */

const REGEX_SPECIALS = new Set([
  ".",
  "+",
  "(",
  ")",
  "|",
  "^",
  "$",
  "\\",
  "[",
  "]",
]);

/**
 * 把 glob 编译成正则。
 *
 * `**\/` 匹配零个或多个目录层级（所以 `**\/*.md` 能匹配根目录下的 `a.md`），
 * `**` 单独出现时匹配任意字符（含斜杠）。
 */
export function globToRegExp(glob: string): RegExp {
  let out = "";
  let i = 0;

  while (i < glob.length) {
    const ch = glob[i];

    if (ch === "*") {
      if (glob[i + 1] === "*") {
        // ** 或 **/
        if (glob[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 3;
        } else {
          out += ".*";
          i += 2;
        }
      } else {
        out += "[^/]*";
        i += 1;
      }
      continue;
    }

    if (ch === "?") {
      out += "[^/]";
      i += 1;
      continue;
    }

    if (ch === "{") {
      const close = findClosingBrace(glob, i);
      if (close === -1) {
        // 没有配对的 }，按字面量处理
        out += "\\{";
        i += 1;
        continue;
      }
      const body = glob.slice(i + 1, close);
      const options = splitTopLevel(body);
      out += "(?:" + options.map((o) => globToRegExpSource(o)).join("|") + ")";
      i = close + 1;
      continue;
    }

    if (REGEX_SPECIALS.has(ch)) {
      out += "\\" + ch;
      i += 1;
      continue;
    }

    out += ch;
    i += 1;
  }

  return new RegExp("^" + out + "$");
}

/** 递归编译，供 {a,b} 分支使用 */
function globToRegExpSource(glob: string): string {
  const re = globToRegExp(glob);
  // 去掉 ^ 与 $
  return re.source.slice(1, -1);
}

function findClosingBrace(glob: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < glob.length; i++) {
    if (glob[i] === "{") depth += 1;
    else if (glob[i] === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitTopLevel(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of body) {
    if (ch === "{") depth += 1;
    if (ch === "}") depth -= 1;
    if (ch === "," && depth === 0) {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out;
}

const cache = new Map<string, RegExp>();

export function matchGlob(path: string, glob: string): boolean {
  let re = cache.get(glob);
  if (!re) {
    re = globToRegExp(glob);
    cache.set(glob, re);
  }
  return re.test(path);
}

export function matchAnyGlob(path: string, globs: string[]): boolean {
  return globs.some((g) => matchGlob(path, g));
}

/** 判断 glob 是否含有通配符（用于 file-exists 的精确计数语义） */
export function isPatternGlob(glob: string): boolean {
  return /[*?{[]/.test(glob);
}
