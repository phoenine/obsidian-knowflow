import { protectedLineIndices, protectedRanges } from "./protected-markdown";

const HTML_TAGS = new Set([
  "a", "abbr", "address", "area", "article", "aside", "audio", "b", "base", "bdi", "bdo", "blockquote", "body",
  "br", "button", "canvas", "caption", "cite", "code", "col", "colgroup", "data", "datalist", "dd", "del",
  "details", "dfn", "dialog", "div", "dl", "dt", "em", "embed", "fieldset", "figcaption", "figure", "footer",
  "form", "h1", "h2", "h3", "h4", "h5", "h6", "head", "header", "hgroup", "hr", "html", "i", "iframe", "img",
  "input", "ins", "kbd", "label", "legend", "li", "link", "main", "map", "mark", "menu", "meta", "meter",
  "nav", "noscript", "object", "ol", "optgroup", "option", "output", "p", "picture", "pre", "progress", "q",
  "rp", "rt", "ruby", "s", "samp", "script", "search", "section", "select", "slot", "small", "source", "span",
  "strong", "style", "sub", "summary", "sup", "table", "tbody", "td", "template", "textarea", "tfoot", "th",
  "thead", "time", "title", "tr", "track", "u", "ul", "var", "video", "wbr",
  "acronym", "applet", "big", "center", "font", "marquee", "nobr", "strike", "tt"
]);

/** Escape tag-like names that are not HTML, so real tags such as video keep working. */
export function escapeLiteralHtmlTags(content: string): { content: string; escaped: number } {
  const lines = content.split("\n");
  const protectedLines = protectedLineIndices(protectedRanges(lines));
  const pieces: string[] = [];
  let escaped = 0;
  let inComment = false;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (protectedLines.has(lineIndex)) {
      pieces.push(line);
    } else {
      const result = escapeLine(line, inComment);
      pieces.push(result.text);
      escaped += result.count;
      inComment = result.inComment;
    }
    if (lineIndex < lines.length - 1) pieces.push("\n");
  }
  return { content: pieces.join(""), escaped };
}

function escapeLine(line: string, inComment: boolean): { text: string; count: number; inComment: boolean } {
  let text = "";
  let count = 0;
  let index = 0;

  while (index < line.length) {
    if (!inComment && line[index] === "`") {
      const marker = /^`+/.exec(line.slice(index))?.[0] ?? "`";
      const closeAt = line.indexOf(marker, index + marker.length);
      if (closeAt !== -1) {
        const end = closeAt + marker.length;
        text += line.slice(index, end);
        index = end;
        continue;
      }
      text += marker;
      index += marker.length;
      continue;
    }

    if (!inComment && line.startsWith("<!--", index)) {
      const closeAt = line.indexOf("-->", index + 4);
      if (closeAt === -1) {
        text += line.slice(index);
        return { text, count, inComment: true };
      }
      const end = closeAt + 3;
      text += line.slice(index, end);
      index = end;
      continue;
    }

    if (inComment) {
      const closeAt = line.indexOf("-->", index);
      if (closeAt === -1) {
        text += line.slice(index);
        return { text, count, inComment: true };
      }
      const end = closeAt + 3;
      text += line.slice(index, end);
      index = end;
      inComment = false;
      continue;
    }

    if (line[index] === "\\" && line[index + 1] === "<") {
      const escapedTag = /^<\/?\s*([A-Za-z][\w:-]*)\b[^>\n]*?>/.exec(line.slice(index + 1));
      if (escapedTag && HTML_TAGS.has(escapedTag[1].toLowerCase())) {
        text += escapedTag[0];
        index += 1 + escapedTag[0].length;
        count += 1;
        continue;
      }
      text += "\\<";
      index += 2;
      continue;
    }

    if (line[index] === "<") {
      const rest = line.slice(index);
      const autolink = /^<(?:https?:\/\/[^>\s]+|mailto:[^>\s]+)>/i.exec(rest);
      if (autolink) {
        text += autolink[0];
        index += autolink[0].length;
        continue;
      }
      const tag = /^<\/?\s*([A-Za-z][\w:-]*)\b[^>\n]*?>/.exec(rest);
      if (tag) {
        if (HTML_TAGS.has(tag[1].toLowerCase())) {
          text += tag[0];
        } else {
          text += `\\${tag[0]}`;
          count += 1;
        }
        index += tag[0].length;
        continue;
      }
    }

    text += line[index];
    index += 1;
  }

  return { text, count, inComment };
}
