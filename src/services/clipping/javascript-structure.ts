import { parser } from "@lezer/javascript";

const typescript = parser.configure({ dialect: "ts" });
const jsx = parser.configure({ dialect: "jsx" });
const tsx = parser.configure({ dialect: "ts jsx" });
const QUOTED_PROPERTY = /^["'](?:\\.|[^"'\\\r\n])+["'][ \t]*:/;
const TRIVIA = /"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|\x60(?:\\.|[^\x60\\])*\x60|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g;
const ALIGNED_PROPERTY = /[ \t]{2,}(?=["'](?:\\.|[^"'\\\r\n])+["'][ \t]*:)/g;
const VERBATIM_NODES = new Set(["String", "RegExp", "TemplateString", "JSXText", "LineComment", "BlockComment"]);
const CONFIG_TOKEN = /[ \t]+|"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[{}\[\],:]|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|(?:true|false|null)\b/g;

/** Expand one flat list of configuration properties without reserializing any values. */
export function expandFlatPropertyList(source: string, language: string): string | undefined {
  const text = source.trim();
  if (!QUOTED_PROPERTY.test(text) || /[\r\n]/.test(text)) return;

  const tokens: string[] = [];
  let end = 0;
  for (const token of text.matchAll(CONFIG_TOKEN)) {
    if (token.index !== end) return;
    end += token[0].length;
    if (token[0].trim()) tokens.push(token[0]);
  }
  if (end !== text.length || syntaxOf(text, language, true).hasErrors) return;

  let depth = 0;
  let previous = "";
  const parts: string[] = [];
  for (const token of tokens) {
    const closes = token === "}" || token === "]";
    const afterOpening = previous === "{" || previous === "[";
    if (closes) depth -= 1;
    const emptyContainer = afterOpening && closes;
    if (!emptyContainer && (previous === "," || afterOpening || closes)) {
      parts.push("\n", "  ".repeat(depth));
    } else if (previous === ":") {
      parts.push(" ");
    }
    parts.push(token);
    if (token === "{" || token === "[") depth += 1;
    previous = token;
  }
  const formatted = parts.join("");
  return formatted.includes("\n") && formatted !== source ? formatted : undefined;
}

export function hasJavaScriptStructure(source: string, language: string): boolean {
  const propertyList = QUOTED_PROPERTY.test(source.trimStart());
  const parsed = syntaxOf(source, language, propertyList);
  return !parsed.hasErrors || propertyList && !syntaxOf(restorePropertiesAfterComments(source), language, true).hasErrors;
}

export function preservesJavaScriptStructure(source: string, formatted: string, language: string): boolean {
  const propertyList = QUOTED_PROPERTY.test(source.trimStart());
  const before = syntaxOf(source, language, propertyList);
  const after = syntaxOf(formatted, language, propertyList);
  if (before.signature === after.signature) return true;

  // A flattened object fragment can hide its next quoted property inside a line comment.
  // Use only the original alignment to recover this boundary, then require a clean, matching parse.
  if (!propertyList || !before.hasErrors || after.hasErrors) return false;
  const recovered = syntaxOf(restorePropertiesAfterComments(source), language, true);
  return !recovered.hasErrors && recovered.signature === after.signature;
}

function restorePropertiesAfterComments(source: string): string {
  return source.replace(TRIVIA, (token) => token.startsWith("//") ? token.replace(ALIGNED_PROPERTY, "\n") : token);
}

function syntaxOf(source: string, language: string, propertyList: boolean): { hasErrors: boolean; signature: string } {
  const languageParser = /^(?:ts|typescript|mts|cts)$/.test(language) ? typescript
    : language === "tsx" ? tsx : language === "jsx" ? jsx : parser;
  const text = propertyList ? "const config = {\n" + source + "\n};"
    : /^jsonc?$/.test(language) ? "const config = (\n" + source + "\n);" : source;
  const signature: Array<string | null> = [];
  let hasErrors = false;
  languageParser.parse(text).iterate({
    enter(node) {
      if (node.type.isError) hasErrors = true;
      signature.push(node.name);
      if (node.type.isError || !node.node.firstChild || VERBATIM_NODES.has(node.name)) {
        signature.push(text.slice(node.from, node.to));
      }
    },
    leave() {
      signature.push(null);
    }
  });
  return { hasErrors, signature: JSON.stringify(signature) };
}
