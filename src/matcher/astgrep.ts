import type { SgNode, SgRoot } from "@ast-grep/napi";
import * as napi from "@ast-grep/napi";
import type { Candidate } from "../types.ts";
import type { Rule } from "../rules.ts";
import type { Matcher } from "./types.ts";

/**
 * 语言模块。ast-grep 的 index.d.ts 没有导出这些模块的类型（运行时是有的），
 * 这里用宽松的接口描述"能解析代码的模块"。
 */
interface LangModule {
  parse(code: string): SgRoot;
}

/**
 * 规则里的 language 字段 → ast-grep 的语言模块。
 * ast-grep 内置支持这几种语言；其它语言要用 registerDynamicLanguage 注册。
 */
const LANG_MODULES: Record<string, LangModule> = {
  ts: (napi as any).ts,
  tsx: (napi as any).tsx,
  js: (napi as any).js,
  jsx: (napi as any).jsx,
  css: (napi as any).css,
  html: (napi as any).html
};

/** language 字段的别名，统一映射到 LANG_MODULES 的键。 */
const LANG_ALIAS: Record<string, string> = {
  typescript: "ts",
  ts: "ts",
  tsx: "tsx",
  javascript: "js",
  js: "js",
  jsx: "jsx",
  css: "css",
  html: "html"
};

/**
 * ast-grep 匹配器。用语法树（AST）圈候选点，而不是正则。
 * 好处：pattern 是语法感知的，不会匹配到字符串字面量或注释里的假点。
 */
export class AstGrepMatcher implements Matcher {
  readonly engine = "ast-grep";

  findCandidates(filePath: string, content: string, rule: Rule): Candidate[] {
    const langKey = LANG_ALIAS[rule.language?.toLowerCase() ?? ""];
    if (!langKey) {
      throw new Error(
        `ast-grep 引擎不支持语言 "${rule.language}"（支持 typescript/javascript/tsx/jsx/css/html）`
      );
    }
    // LANG_ALIAS 的值都在 LANG_MODULES 里，这里用 ! 断言。
    const langModule = LANG_MODULES[langKey]!;

    // 代码有语法错误时 parse 可能抛错，跳过这个文件，别让整个扫描崩掉。
    let root: SgRoot;
    try {
      root = langModule.parse(content);
    } catch {
      return [];
    }

    const matches = root.root().findAll(rule.pattern);
    const candidates: Candidate[] = [];
    for (const match of matches) {
      const range = match.range();
      const line = range.start.line + 1; // ast-grep 行号从 0 数，转成从 1 数
      const replacement = rule.fix
        ? computeReplacement(match, rule.fix, content)
        : undefined;

      candidates.push({
        file: normalizePath(filePath),
        line,
        column: range.start.column + 1,
        offset: range.start.index, // 实测是 UTF-16 字符偏移，可直接用
        snippet: buildSnippet(content, line, rule.context),
        matched: match.text(),
        replacement
      });
    }
    return candidates;
  }
}

/**
 * 用 fix 模板算出改写后的完整文本。
 * fix 里的 $NAME（单节点）和 $$$NAME（多节点）会被替换成匹配到的内容。
 * ast-grep 的 getTransformed 在 JS 里不可用（返回 null），所以手动替换。
 */
function computeReplacement(match: SgNode, fix: string, code: string): string {
  return fix.replace(/\${1,3}([A-Za-z_]\w*)/g, (full, name: string) => {
    const dollars = full.match(/^\$+/)?.[0].length ?? 0;
    if (dollars >= 2) {
      // 多节点 metavariable（$$$NAME）：取所有节点的范围，保住中间的空白。
      const nodes = match.getMultipleMatches(name);
      if (nodes.length === 0) return full;
      const start = nodes[0]!.range().start.index;
      const end = nodes[nodes.length - 1]!.range().end.index;
      return code.slice(start, end);
    }
    // 单节点 metavariable（$NAME）。
    const node = match.getMatch(name);
    return node ? node.text() : full;
  });
}

/** 取给定行（从 1 数起）前后各 context 行的原文。 */
function buildSnippet(content: string, line: number, context: number): string {
  const lines = content.split("\n");
  const start = Math.max(1, line - context);
  const end = Math.min(lines.length, line + context);
  return lines.slice(start - 1, end).join("\n");
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}
