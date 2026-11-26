import { protectedLineIndices, protectedRanges } from "../clipping/protected-markdown";

/**
 * Verbatim-quote matching for evidence returned by the model.
 *
 * Only Markdown emphasis that wraps text is removed (`**x**`, `==x==`, `*x*`, `` `x` ``, `<u>x</u>`).
 * A marker must touch the text on both sides, so operators such as `count == limit`, `a * b` or `<=` keep
 * their meaning and cannot be dropped to make a quote match.
 */
export function sourceContainsQuote(content: string, quote: string): boolean {
  const normalizedQuote = normalizeQuote(quote);
  return isQuotable(normalizedQuote) && (content.includes(quote) || normalizeQuote(content).includes(normalizedQuote));
}

/** At least four characters, and not only punctuation or markup. */
function isQuotable(normalized: string): boolean {
  return normalized.replace(/\s/g, "").length >= 4 && /[\p{L}\p{N}]/u.test(normalized);
}

export function normalizeQuote(value: string): string {
  const lines = value.replace(/\r\n/g, "\n").split("\n");
  const protectedLines = protectedLineIndices(protectedRanges(lines));
  return lines.map((line, index) => protectedLines.has(index) ? line : unwrapInlineMarkup(line))
    .join("\n")
    .replace(/[ \t]*(?:\n[ \t]*)+/g, " ")
    .trim();
}

function unwrapInlineMarkup(line: string): string {
  const parts = line.split(/(?<![`\\])(`+)(?!`)(.+?)(?<!`)\1(?!`)/g);
  return parts.map((part, index) => {
    if (index % 3 === 1) return "";
    if (index % 3 === 2) return part;
    return part.replace(/<u>(.+?)<\/u>/gi, "$1")
      .replace(/(^|[^\p{L}\p{N}\\*~=])(\*\*|==|~~|\*)(?=\S)(.*?\S)\2(?=$|[^\p{L}\p{N}*~=])/gu, "$1$3");
  }).join("");
}
