/**
 * parser.ts — import/require extraction.
 *
 * Two strategies:
 *   1. TypeScript compiler API (preferred). Robust: it understands all the
 *      import forms (static import, import type, dynamic import(), re-export,
 *      require()) without us hand-rolling a grammar.
 *   2. Regex fallback. Used when `typescript` is not installed (e.g. an
 *      offline `npm install`). Less precise but covers the common forms.
 *
 * The compiler API is loaded lazily via dynamic import so that the regex
 * fallback path has *zero* hard dependency on the `typescript` package — the
 * tool still runs with only Node built-ins.
 */

import { readFileSync } from 'node:fs';
import { extname } from 'node:path';

export type ImportKind = 'import' | 'require' | 'dynamic' | 'export-from';

export interface ImportRef {
  /** The raw module specifier, e.g. "./foo" or "rocketchat-core". */
  specifier: string;
  kind: ImportKind;
}

export interface ParseResult {
  imports: ImportRef[];
  /** Which strategy actually produced the result. */
  strategy: 'typescript' | 'regex';
}

export const SUPPORTED_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

export function isSupportedSource(file: string): boolean {
  return SUPPORTED_EXTENSIONS.includes(extname(file));
}

// Lazily resolved TypeScript module (or `false` once we know it is absent).
let tsModule: unknown = undefined;

async function loadTypeScript(): Promise<any | null> {
  if (tsModule === false) return null;
  if (tsModule !== undefined) return tsModule;
  try {
    const mod = await import('typescript');
    tsModule = (mod as any).default ?? mod;
    return tsModule;
  } catch {
    tsModule = false;
    return null;
  }
}

/** Force-disable the TS compiler path (used by tests to exercise the fallback). */
export function _disableTypeScriptForTesting(): void {
  tsModule = false;
}

function scriptKindFor(ts: any, file: string): any {
  switch (extname(file)) {
    case '.tsx':
      return ts.ScriptKind.TSX;
    case '.jsx':
      return ts.ScriptKind.JSX;
    case '.js':
    case '.mjs':
    case '.cjs':
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.TS;
  }
}

/**
 * Extract imports using the TypeScript AST. Walks the source file for every
 * node that introduces a module dependency.
 */
function parseWithTypeScript(ts: any, file: string, code: string): ImportRef[] {
  const sf = ts.createSourceFile(
    file,
    code,
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ true,
    scriptKindFor(ts, file),
  );

  const imports: ImportRef[] = [];

  const visit = (node: any): void => {
    // import x from "..."  /  import "..."  /  import type ...
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      imports.push({ specifier: node.moduleSpecifier.text, kind: 'import' });
    }
    // export { x } from "..."  /  export * from "..."
    else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      imports.push({ specifier: node.moduleSpecifier.text, kind: 'export-from' });
    }
    // import foo = require("...")  (TS import-equals)
    else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      imports.push({ specifier: node.moduleReference.expression.text, kind: 'require' });
    }
    // require("...")  and  import("...")
    else if (ts.isCallExpression(node)) {
      const expr = node.expression;
      const arg = node.arguments?.[0];
      const isStringArg = arg && ts.isStringLiteral(arg);
      if (isStringArg) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          imports.push({ specifier: arg.text, kind: 'dynamic' });
        } else if (ts.isIdentifier(expr) && expr.escapedText === 'require') {
          imports.push({ specifier: arg.text, kind: 'require' });
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sf);
  return dedupe(imports);
}

/**
 * Regex fallback. Strips line/block comments first (a cheap pass) so that
 * commented-out imports are ignored, then matches the common module forms.
 */
export function parseWithRegex(code: string): ImportRef[] {
  const src = stripComments(code);
  const imports: ImportRef[] = [];

  const patterns: Array<{ re: RegExp; kind: ImportKind }> = [
    // import ... from "x"   |   import "x"
    { re: /\bimport\b[^;'"]*?\bfrom\s*['"]([^'"]+)['"]/g, kind: 'import' },
    { re: /\bimport\s*['"]([^'"]+)['"]/g, kind: 'import' },
    // export ... from "x"
    { re: /\bexport\b[^;'"]*?\bfrom\s*['"]([^'"]+)['"]/g, kind: 'export-from' },
    // require("x")
    { re: /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g, kind: 'require' },
    // import("x")  (dynamic)
    { re: /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, kind: 'dynamic' },
  ];

  for (const { re, kind } of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      imports.push({ specifier: m[1], kind });
    }
  }
  return dedupe(imports);
}

/** Remove // line comments and block comments, but not inside strings. */
export function stripComments(code: string): string {
  let out = '';
  let i = 0;
  const n = code.length;
  let inString: string | null = null;

  while (i < n) {
    const c = code[i];
    const next = code[i + 1];

    if (inString) {
      out += c;
      if (c === '\\') {
        // copy escaped char verbatim
        if (i + 1 < n) out += code[i + 1];
        i += 2;
        continue;
      }
      if (c === inString) inString = null;
      i += 1;
      continue;
    }

    if (c === '"' || c === "'" || c === '`') {
      inString = c;
      out += c;
      i += 1;
      continue;
    }
    if (c === '/' && next === '/') {
      while (i < n && code[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < n && !(code[i] === '*' && code[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

function dedupe(refs: ImportRef[]): ImportRef[] {
  const seen = new Set<string>();
  const result: ImportRef[] = [];
  for (const r of refs) {
    const key = `${r.kind}:${r.specifier}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(r);
    }
  }
  return result;
}

/** Parse source code (already read). Picks TS compiler if available. */
export async function parseSource(file: string, code: string): Promise<ParseResult> {
  const ts = await loadTypeScript();
  if (ts) {
    try {
      return { imports: parseWithTypeScript(ts, file, code), strategy: 'typescript' };
    } catch {
      // Fall through to regex if the AST pass throws for any reason.
    }
  }
  return { imports: parseWithRegex(code), strategy: 'regex' };
}

/** Convenience: read a file from disk and parse it. */
export async function parseFile(file: string): Promise<ParseResult> {
  const code = readFileSync(file, 'utf8');
  return parseSource(file, code);
}
