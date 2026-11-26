import { inlineCodeClosingIndex, protectedLineIndices, protectedRanges } from "../clipping/protected-markdown";

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
  const runs = /`+/g;
  let result = "";
  let last = 0;
  for (let run = runs.exec(line); run; run = runs.exec(line)) {
    if (line[run.index - 1] === "\\") continue;
    const closing = inlineCodeClosingIndex(line, run.index, run[0]);
    if (closing < 0) continue;
    result += unwrapProseMarkup(line.slice(last, run.index)) + line.slice(runs.lastIndex, closing);
    last = runs.lastIndex = closing + run[0].length;
  }
  return result + unwrapProseMarkup(line.slice(last));
}

function unwrapProseMarkup(text: string): string {
  return text.replace(/<u>(.+?)<\/u>/gi, "$1")
    .replace(/(^|[^\p{L}\p{N}\\*~=])(\*\*|==|~~|\*)(?=\S)(.*?\S)\2(?=$|[^\p{L}\p{N}*~=])/gu, "$1$3");
}
