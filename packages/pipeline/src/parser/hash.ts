import { createHash } from "node:crypto";
import type { BlockKind } from "@riscv-cn/schema";

const HASH_ANCHOR_LINE_RE = /^\[#([^\],\s]+)(?:\s*,[^\]]*)?\]$/;
const BRACKET_ANCHOR_LINE_RE = /^\[\[([^\],\s]+)(?:\s*,[^\]]*)?\]\]$/;

/**
 * Extract an anchor ID from a standalone AsciiDoc block-anchor line
 * (`[#id]`, `[#id,reftext=...]`, `[[id]]`, or `[[id,reftext]]`).
 */
export function parseAnchorLine(line: string): string | undefined {
  const trimmed = line.trim();
  const hashMatch = HASH_ANCHOR_LINE_RE.exec(trimmed);
  if (hashMatch) {
    return hashMatch[1];
  }
  const bracketMatch = BRACKET_ANCHOR_LINE_RE.exec(trimmed);
  if (bracketMatch) {
    return bracketMatch[1];
  }
  return undefined;
}

/**
 * Strip leading AsciiDoc section level markers (`=+ `) and symmetric trailing ` =+`
 * from heading text so heading content is independent of nesting depth (`level`).
 */
export function stripHeadingMarkers(text: string): string {
  const lines = text.split("\n");
  let changed = false;
  const out = lines.map((line) => {
    const trimmed = line.trim();
    if (/^=+\s+\S/.test(trimmed)) {
      changed = true;
      return trimmed
        .replace(/^=+\s+/, "")
        .replace(/\s+=+\s*$/, "")
        .trim();
    }
    return line;
  });
  return changed ? out.join("\n").trim() : text.trim();
}

/**
 * Normalize a raw AsciiDoc block for stable pure content hashing:
 * - Normalizes CRLF to LF and trims trailing whitespace per line
 * - Trims outer blank lines
 * - Strips leading outer block-anchor lines (`[#id]` / `[[id]]`) and returns
 *   `anchorId` plus any additional distinct `extraAnchorIds`
 * - Strips leading `=+ ` markers when `kind === "heading"`
 */
export function normalizeAdocBlock(
  raw: string,
  kind?: BlockKind,
): {
  normalized: string;
  anchorId?: string;
  extraAnchorIds?: string[];
} {
  const lines = raw
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""));

  let start = 0;
  while (start < lines.length && lines[start] === "") {
    start++;
  }
  let end = lines.length - 1;
  while (end >= start && lines[end] === "") {
    end--;
  }

  const anchors: string[] = [];
  while (start <= end) {
    if (lines[start] === "") {
      start++;
      continue;
    }
    const parsedAnchor = parseAnchorLine(lines[start]);
    if (parsedAnchor !== undefined) {
      anchors.push(parsedAnchor);
      start++;
      continue;
    }
    break;
  }

  let normalized = lines.slice(start, end + 1).join("\n");
  if (kind === "heading" && normalized) {
    normalized = stripHeadingMarkers(normalized);
  }

  const anchorId = anchors[0];
  const extraAnchorIds: string[] = [];
  for (let i = 1; i < anchors.length; i++) {
    const extra = anchors[i];
    if (extra !== anchorId && !extraAnchorIds.includes(extra)) {
      extraAnchorIds.push(extra);
    }
  }

  return {
    normalized,
    ...(anchorId !== undefined ? { anchorId } : {}),
    ...(extraAnchorIds.length > 0 ? { extraAnchorIds } : {}),
  };
}

/**
 * Compute pure content-addressed 32-char lowercase SHA-256 hex unit ID.
 * Identical `(kind, normalizedEn)` always maps to the exact same `unit_id`.
 */
export function computeUnitId(kind: BlockKind, normalizedEn: string): string {
  const payload = `${kind}\n${normalizedEn}`;
  return createHash("sha256").update(payload, "utf8").digest("hex").slice(0, 32);
}
