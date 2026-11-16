export interface BibEntry {
  key: string;
  type: string;
  title?: string;
  author?: string;
  year?: string;
  venue?: string;
  url?: string;
  doi?: string;
}

function cleanBibValue(raw: string): string {
  return raw
    .replace(/\s+/g, " ")
    .replace(/\\&/g, "&")
    .replace(/~/g, " ")
    .replace(/[{}]/g, "")
    .trim();
}

function readBalanced(src: string, start: number, openChar: string, closeChar: string): [string, number] {
  let depth = 0;
  let i = start;
  const outStart = start + 1;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\" && i + 1 < src.length) {
      i += 2;
      continue;
    }
    if (ch === openChar) depth++;
    else if (ch === closeChar) {
      depth--;
      if (depth === 0) {
        return [src.slice(outStart, i), i + 1];
      }
    }
    i++;
  }
  return [src.slice(outStart), src.length];
}

function readQuoted(src: string, start: number): [string, number] {
  let i = start + 1;
  const outStart = i;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\" && i + 1 < src.length) {
      i += 2;
      continue;
    }
    if (ch === '"') {
      return [src.slice(outStart, i), i + 1];
    }
    i++;
  }
  return [src.slice(outStart), src.length];
}

/** Parse BibTeX `.bib` content into a key-indexed map of entries. */
export function parseBibtex(content: string): Map<string, BibEntry> {
  const entries = new Map<string, BibEntry>();
  let i = 0;
  while (i < content.length) {
    const at = content.indexOf("@", i);
    if (at < 0) break;
    const headerMatch = /^@([a-zA-Z]+)\s*([{(])/.exec(content.slice(at));
    if (!headerMatch) {
      i = at + 1;
      continue;
    }
    const type = headerMatch[1].toLowerCase();
    const open = headerMatch[2];
    const close = open === "{" ? "}" : ")";
    const bodyStart = at + headerMatch[0].length - 1;
    const [body, nextIdx] = readBalanced(content, bodyStart, open, close);
    i = nextIdx;

    if (type === "comment" || type === "preamble" || type === "string") continue;

    const commaIdx = body.indexOf(",");
    if (commaIdx < 0) continue;
    const key = body.slice(0, commaIdx).trim();
    if (!key) continue;

    const fields: Record<string, string> = {};
    let pos = commaIdx + 1;
    while (pos < body.length) {
      while (pos < body.length && /[\s,]/.test(body[pos])) pos++;
      if (pos >= body.length) break;
      const nameMatch = /^([a-zA-Z0-9_-]+)\s*=\s*/.exec(body.slice(pos));
      if (!nameMatch) break;
      const fieldName = nameMatch[1].toLowerCase();
      pos += nameMatch[0].length;
      if (pos >= body.length) break;

      let val = "";
      if (body[pos] === "{") {
        const [v, np] = readBalanced(body, pos, "{", "}");
        val = v;
        pos = np;
      } else if (body[pos] === '"') {
        const [v, np] = readQuoted(body, pos);
        val = v;
        pos = np;
      } else {
        const end = body.slice(pos).search(/[,\n]/);
        const sliceEnd = end < 0 ? body.length : pos + end;
        val = body.slice(pos, sliceEnd).trim();
        pos = sliceEnd;
      }
      fields[fieldName] = cleanBibValue(val);
    }

    entries.set(key, {
      key,
      type,
      title: fields.title,
      author: fields.author || fields.editor,
      year: fields.year,
      venue: fields.booktitle || fields.journal || fields.institution || fields.publisher || fields.howpublished,
      url: fields.url,
      doi: fields.doi,
    });
  }
  return entries;
}

export function formatBibEntry(entry: BibEntry): string {
  const parts: string[] = [];
  if (entry.author) parts.push(entry.author);
  if (entry.title) parts.push(`"${entry.title}"`);
  if (entry.venue) parts.push(entry.venue);
  if (entry.year) parts.push(entry.year);
  if (entry.doi) parts.push(`doi:${entry.doi}`);
  else if (entry.url) parts.push(entry.url);
  return parts.join(", ") || entry.key;
}
