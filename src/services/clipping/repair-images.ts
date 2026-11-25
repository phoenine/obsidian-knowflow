import { requestUrl, TFile, type App } from "obsidian";
import { protectedLineIndices, protectedRanges } from "./protected-markdown";
import { withTimeout } from "../ai/ai-transport";

const EMBED = /!\[\[([^\]\n]+)\]\]|!\[((?:\\.|[^\]\\])*)\]\((<[^<>\n]+>(?:[ \t]+["'][^"']*["'])?|(?:\\.|[^()\\\n]|\([^()\n]*\))+?)\)/g;
const LOCAL_IMAGE = /\.(?:png|jpe?g|gif|webp|avif|bmp|svg|ico|heic)$/i;
const PAGE_IMAGE_NOISE = /(?:^|[\/_\-.\s])(?:avatar|favicon|logo|qrcode|qr-code|emoji|loading)(?:$|[\/_\-.\s])/i;
const IMAGE_LIMIT = 15 * 1024 * 1024;

interface ImageReference {
  line: number;
  start: number;
  end: number;
  target: string;
  rawTarget: string;
  alt: string;
  wiki: boolean;
  renderedPath: boolean;
  anchors: string[];
}

interface ImageBytes {
  filename: string;
  bytes: ArrayBuffer;
  dimensions: Dimensions;
}

interface ImageRepair {
  index: number;
  ref: ImageReference;
  asset: TFile | ImageBytes;
}

interface Dimensions { width: number; height: number }
interface SourceImage { url: URL; before: string[]; after: string[]; alt: string }

export async function planImageRepairs(app: App, notePath: string, content: string, sourceUrl?: string): Promise<{
  repairs: ImageRepair[]; unavailable: number;
}> {
  const refs = imageReferences(content);
  const source = publicUrl(sourceUrl);
  const repairs: ImageRepair[] = [];
  const previews = new Map<string, ReturnType<typeof probeImage>>();
  const unresolved: Array<{ index: number; ref: ImageReference; url?: URL }> = [];
  const downloads = new Map<string, Promise<ImageBytes | null>>();
  const download = (url: URL): Promise<ImageBytes | null> => {
    let pending = downloads.get(url.href);
    if (!pending) {
      pending = downloadImage(url, source);
      downloads.set(url.href, pending);
    }
    return pending;
  };

  for (let index = 0; index < refs.length; index += 4) {
    await Promise.all(refs.slice(index, index + 4).map(async (ref, offset) => {
      const position = index + offset;
      const url = publicUrl(ref.target.startsWith("//") ? `https:${ref.target}` : ref.target);
      if (url) {
        let pending = previews.get(url.href);
        if (!pending) {
          pending = probeImage(url.href);
          previews.set(url.href, pending);
        }
        const preview = await pending;
        if (preview === undefined) return;
        // WeChat may serve a small placeholder that still fires the load event.
        if (preview && (!isWechatImage(url) || preview.width > 400 || preview.height > 400)) return;
        const asset = await download(url);
        if (preview && (!asset || asset.dimensions.width * asset.dimensions.height <= preview.width * preview.height * 2)) return;
        if (asset) repairs.push({ index: position, ref, asset });
        else unresolved.push({ index: position, ref, url });
        return;
      }

      if (!LOCAL_IMAGE.test(ref.target) || /^[a-z][a-z\d+.-]*:|^\/\//i.test(ref.target)) return;
      const local = resolveLocalImage(app, notePath, ref.target);
      if (local?.direct && ref.renderedPath) return;
      if (local) repairs.push({ index: position, ref, asset: local.file });
      else unresolved.push({ index: position, ref });
    }));
  }

  if (unresolved.length === 0 || !source) return { repairs, unavailable: unresolved.length };
  const images = await readSourceImages(source);
  let unavailable = 0;
  for (const missing of unresolved) {
    const match = matchSourceImage(missing.ref, missing.url, images);
    const asset = match ? await download(match.url) : null;
    if (asset) repairs.push({ index: missing.index, ref: missing.ref, asset });
    else unavailable += 1;
  }
  return { repairs, unavailable };
}

export async function saveImageRepairs(app: App, sourcePath: string, content: string, repairs: ImageRepair[], created: TFile[]): Promise<{
  content: string; restored: number; targets: Set<string>;
}> {
  const targets = new Set<string>();
  if (!repairs.length) return { content, restored: 0, targets };
  const refs = imageReferences(content);
  const attachments = new Map<ImageBytes, TFile>();
  const lines = content.split("\n");
  let restored = 0;
  for (const { index, ref, asset } of [...repairs].sort((a, b) => b.index - a.index)) {
    const current = refs[index];
    if (!current || current.target !== ref.target || current.rawTarget !== ref.rawTarget || current.alt !== ref.alt) continue;
    let file = asset instanceof TFile ? asset : attachments.get(asset);
    if (!file && !(asset instanceof TFile)) {
      const path = await app.fileManager.getAvailablePathForAttachment(asset.filename, sourcePath);
      file = await app.vault.createBinary(path, asset.bytes);
      created.push(file);
      attachments.set(asset, file);
    }
    if (!file) continue;
    const path = file.path.split("/").map((part) => encodeURIComponent(part).replace(/[()]/g, (char) => char === "(" ? "%28" : "%29")).join("/");
    const destination = current.wiki ? file.path : path;
    const line = lines[current.line];
    lines[current.line] = line.slice(0, current.start) + destination + line.slice(current.end);
    targets.add(current.target);
    restored += 1;
  }
  return { content: lines.join("\n"), restored, targets };
}

function imageReferences(content: string): ImageReference[] {
  const lines = content.split("\n");
  const protectedLines = protectedLineIndices(protectedRanges(lines));
  return lines.flatMap((line, index) => {
    if (protectedLines.has(index)) return [];
    const inlineCode = [...line.matchAll(/(`+)([^`]*?)\1/g)];
    return [...line.matchAll(EMBED)].flatMap((match) => {
      const offset = match.index ?? 0;
      if (line[offset - 1] === "\\" || inlineCode.some((code) => (code.index ?? 0) < offset && offset < (code.index ?? 0) + code[0].length)) return [];
      const wiki = match[1] !== undefined;
      const destination = wiki ? match[1].split("|", 1)[0] : match[3].replace(/[ \t]+["'][^"']*["']$/, "");
      const angle = !wiki && destination.startsWith("<") && destination.endsWith(">");
      const rawTarget = angle ? destination.slice(1, -1) : destination;
      const start = offset + (wiki ? 3 : 4 + match[2].length) + (angle ? 1 : 0);
      return [{ line: index, start, end: start + rawTarget.length, rawTarget, wiki, alt: wiki ? "" : match[2],
        target: rawTarget.trim().replace(/\\([\\()[\]<> ])/g, "$1"),
        renderedPath: wiki || ((angle || !/[ \t]/.test(rawTarget)) && !/%(?![\da-f]{2})/i.test(rawTarget)),
        anchors: [nearbyText(lines, index, -1), nearbyText(lines, index, 1)] }];
    });
  });
}

function nearbyText(lines: string[], index: number, direction: number): string {
  for (let line = index + direction; lines[line] !== undefined; line += direction) {
    const text = lines[line].trim();
    if (!text) continue;
    return /^!\[|^\[!\[|^#{1,6}\s|^[`~]{3}/.test(text) ? "" : text;
  }
  return "";
}

function resolveLocalImage(app: App, notePath: string, target: string): { file: TFile; direct: boolean } | null {
  let decoded: string;
  try { decoded = decodeURIComponent(target.replace(/%(?![\da-f]{2})/gi, "%25")); } catch { decoded = target; }
  const folder = notePath.split("/").slice(0, -1).join("/");
  for (const candidate of [`${folder}/${decoded}`, decoded]) {
    const parts: string[] = [];
    for (const part of candidate.split("/")) {
      if (part === "..") parts.pop();
      else if (part && part !== ".") parts.push(part);
    }
    const file = app.vault.getAbstractFileByPath(parts.join("/"));
    if (file instanceof TFile && file.stat.size > 0) return { file, direct: true };
  }
  const name = decoded.split("/").pop();
  if (!name || /^(?:0|640|image|img|image\d+)\./i.test(name)) return null;
  const matches = app.vault.getFiles().filter((file) => file.name === name && file.stat.size > 0);
  return matches.length === 1 ? { file: matches[0], direct: !decoded.includes("/") } : null;
}

async function readSourceImages(source: URL): Promise<SourceImage[]> {
  try {
    const result = await withTimeout(requestUrl({ url: source.href, headers: { Accept: "text/html" }, throw: false }), 8000, "原文读取超时");
    if (result.status < 200 || result.status >= 300 || !result.text || result.text.length > 5_000_000) return [];
    const doc = new DOMParser().parseFromString(result.text, "text/html");
    const root = doc.querySelector("#js_content") ?? doc.querySelector('[itemprop="articleBody"], .markdown-body, article, main');
    if (!root) return [];
    return Array.from(root.querySelectorAll("img")).flatMap((image) => {
      const alt = image.getAttribute("alt") ?? "";
      const url = ["data-src", "data-original", "src"].map((attribute) => publicUrl(image.getAttribute(attribute), source)).find(Boolean);
      if (!url || PAGE_IMAGE_NOISE.test(`${url.pathname} ${alt}`)) return [];
      const before: string[] = [];
      const after: string[] = [];
      for (let element: Element | null = image; element && element !== root; element = element.parentElement) {
        const previousText = element.previousElementSibling?.textContent?.trim();
        const nextText = element.nextElementSibling?.textContent?.trim();
        if (previousText) before.push(previousText.slice(-140));
        if (nextText) after.push(nextText.slice(0, 140));
        const caption = element.tagName === "FIGURE" ? element.querySelector("figcaption")?.textContent : null;
        if (caption) after.push(caption);
      }
      return [{ url, alt, before, after }];
    });
  } catch {
    return [];
  }
}

function matchSourceImage(ref: ImageReference, url: URL | undefined, images: SourceImage[]): SourceImage | undefined {
  if (url) {
    const exact = images.filter((image) => image.url.hostname === url.hostname && image.url.pathname === url.pathname);
    const unique = new Map(exact.map((image) => [image.url.href, image]));
    if (unique.size === 1) return unique.values().next().value;
  }
  const [previous, next] = ref.anchors;
  const matches = images.filter((image) => matchesAnchor(ref.alt, [image.alt])
    || (!/^[—–]/.test(previous) && matchesAnchor(previous, image.before)) || matchesAnchor(next, image.after));
  const unique = new Map(matches.map((image) => [image.url.href, image]));
  return unique.size === 1 ? unique.values().next().value : undefined;
}

function matchesAnchor(value: string, possible: string[]): boolean {
  const key = comparableText(value);
  return key.length >= 10 && possible.some((value) => {
    const text = comparableText(value);
    return text.length >= 10 && (key.includes(text) || text.includes(key));
  });
}

function comparableText(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

function publicUrl(value: string | null | undefined, base?: URL): URL | undefined {
  if (!value?.trim()) return undefined;
  try {
    const url = new URL(value, base);
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || !host.includes(".") || host.endsWith(".local")
      || /^(?:127\.|0\.|10\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(host)) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

function isWechatImage(url: URL): boolean {
  return /^(?:mmbiz(?:-bin)?\.qpic\.cn|mmbiz\.qlogo\.cn)$/i.test(url.hostname);
}

function probeImage(src: string): Promise<Dimensions | null | undefined> {
  return new Promise((resolve) => {
    const image = new Image();
    const finish = (size?: Dimensions | null): void => {
      window.clearTimeout(timer);
      image.onload = null;
      image.onerror = null;
      resolve(size);
    };
    const timer = window.setTimeout(() => finish(), 4000);
    image.onload = () => finish(image.naturalWidth && image.naturalHeight ? { width: image.naturalWidth, height: image.naturalHeight } : null);
    image.onerror = () => finish(null);
    image.src = src;
  });
}

async function downloadImage(url: URL, source: URL | undefined): Promise<ImageBytes | null> {
  const referers = isWechatImage(url) ? ["https://mp.weixin.qq.com/"] : [...new Set([
    ...(source ? [`${source.origin}${source.pathname}`, `${source.origin}/`] : []),
    ...(url.hostname === "cdnfile.sspai.com" ? ["https://sspai.com/"] : []), ""
  ])];
  for (const referer of referers) {
    try {
      const result = await withTimeout(requestUrl({ url: url.href, throw: false, headers: {
        Accept: "image/avif,image/webp,image/*,*/*;q=0.7",
        ...(referer ? { Referer: referer } : {})
      } }), 8000, "图片下载超时");
      if (result.status < 200 || result.status >= 300 || !result.arrayBuffer?.byteLength || result.arrayBuffer.byteLength > IMAGE_LIMIT) continue;
      const extension = imageFormat(result.arrayBuffer);
      if (!extension) continue;
      const blob = URL.createObjectURL(new Blob([result.arrayBuffer], { type: `image/${extension === "jpg" ? "jpeg" : extension}` }));
      let dimensions: Dimensions | null | undefined;
      try { dimensions = await probeImage(blob); } finally { URL.revokeObjectURL(blob); }
      if (!dimensions) continue;
      if (isWechatImage(url) && result.arrayBuffer.byteLength < 4096
        && dimensions.width / dimensions.height > 3 && dimensions.height <= 100) continue;
      const base = url.pathname.split("/").pop()?.replace(/\.[^.]+$/, "").replace(/[^a-z\d_-]/gi, "-").slice(0, 56);
      return { filename: `${base || "clipped-image"}.${extension}`, bytes: result.arrayBuffer, dimensions };
    } catch {
      continue;
    }
  }
  return null;
}

function imageFormat(buffer: ArrayBuffer): string | null {
  const bytes = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 32));
  const header = String.fromCharCode(...bytes);
  if (bytes[0] === 0x89 && header.slice(1, 4) === "PNG") return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  if (/^GIF8[79]a/.test(header)) return "gif";
  if (header.startsWith("RIFF") && header.slice(8, 12) === "WEBP") return "webp";
  if (header.slice(4, 8) === "ftyp" && /avif|avis/.test(header.slice(8))) return "avif";
  if (header.startsWith("BM")) return "bmp";
  return null;
}
