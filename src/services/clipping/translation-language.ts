export function translationProse(value: string): string {
  if (isLibraryMetadata(value)) return "";
  const withoutCode = value.replace(/(`+)[\s\S]*?\1/g, "").replace(/\$[^$\n]+\$/g, "");
  // Standalone links are references, even when their labels contain many letters.
  const links = /!?\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)|\[\[[^\]]+\]\]|<https?:\/\/[^>]+>/g;
  const outsideLinks = withoutCode.replace(links, "").replace(/https?:\/\/\S+/g, "");
  if (!/\p{L}/u.test(outsideLinks)) return "";
  return withoutCode
    .replace(/!\[[^\]]*\]\((?:[^()]|\([^()]*\))*\)/g, "")
    .replace(/\[([^\]]+)\]\((?:[^()]|\([^()]*\))*\)/g, "$1")
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_match, target: string, label?: string) => label ?? target)
    .replace(/https?:\/\/\S+/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/[*_~]/g, "")
    .trim();
}

function isLibraryMetadata(value: string): boolean {
  if (/[\r\n]/.test(value)) return false;
  const fields = value.replace(/\*\*|__/g, "").split(/\s+[—–]\s+|[｜|]/).map((field) => field.trim());
  return fields.length >= 3 && Boolean(fields[0]) && fields.slice(1).every((field) =>
    /^`[^`]+`$/.test(field)
      || /^(?:GitHub\s+)?Stars?\s*:?\s*[\d,.]+[kKmM]?$/i.test(field)
      || /^v?\d+(?:\.\d+)+(?:[-+][\w.-]+)?$/.test(field)
      || /^(?:MIT|ISC|Apache-\d+(?:\.\d+)*|BSD-\d-Clause|(?:A?GPL|LGPL|MPL)-\d+(?:\.\d+)*(?:-(?:only|or-later))?)$/.test(field)
  );
}
