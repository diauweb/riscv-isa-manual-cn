import fs from "node:fs";
import path from "node:path";
import Asciidoctor from "@asciidoctor/core";
import { decode as decodeHtmlEntities } from "he";
import type {
  BlockKind,
  BlockRef,
  ChapterNode,
  SectionNode,
  VolumeId,
  VolumeNode,
} from "@riscv-cn/schema";
import { computeUnitId, normalizeAdocBlock } from "./hash.ts";
import { expandRiscvMacrosPlain } from "./macros.ts";
import { vlog } from "../log.ts";

export interface ExtractedUnit {
  unit_id: string;
  kind: BlockKind;
  translatable: boolean;
  en: string;
}

const asciidoctor = Asciidoctor();
asciidoctor.LoggerManager.setLogger(asciidoctor.NullLogger.create());

/**
 * Fallback attributes for `docs-resources/global-config.adoc` when the upstream
 * `docs-resources` submodule is absent (e.g. shallow/non-recursive clones).
 */
export const FALLBACK_GLOBAL_CONFIG_ADOC = [
  ":icons: font",
  ":lang: en",
  ":listing-caption: Listing",
  ":sectnums:",
  ":sectnumlevels: 5",
  ":toclevels: 5",
  ":toc: left",
  ":data-uri:",
  ":hide-uri-scheme:",
  ":stem: latexmath",
  ":footnote:",
  ":xrefstyle: short",
  "",
].join("\n");

function createGlobalConfigExtensionRegistry(
  repoRoot: string,
  entryDir: string,
) {
  const registry = asciidoctor.Extensions.create();
  registry.includeProcessor(function () {
    this.handles((target) =>
      /(?:^|[\\/])docs-resources[\\/]global-config\.adoc$/.test(String(target)),
    );
    this.process((doc, reader, target, attrs) => {
      const cursorDir =
        reader.getCursor?.()?.getDirectory?.() ||
        doc.getBaseDir?.() ||
        entryDir;
      const candidate1 = path.resolve(String(cursorDir), String(target));
      const candidate2 = path.resolve(
        repoRoot,
        "docs-resources/global-config.adoc",
      );
      const existingPath = fs.existsSync(candidate1)
        ? candidate1
        : fs.existsSync(candidate2)
          ? candidate2
          : null;
      const content = existingPath
        ? fs.readFileSync(existingPath, "utf8")
        : FALLBACK_GLOBAL_CONFIG_ADOC;
      reader.pushInclude(
        content,
        target,
        existingPath ?? candidate1,
        1,
        attrs,
      );
    });
  });
  return registry;
}

const DIAGRAM_STYLES = new Set([
  "wavedrom",
  "bytefield",
  "graphviz",
  "plantuml",
  "ditaa",
  "svgbob",
  "mermaid",
  "diagram",
]);

interface AstLocation {
  file?: string;
  dir?: string;
  path?: string;
  lineno?: number;
}

interface AstNode {
  getNodeName(): string;
  getContext(): string;
  getStyle?(): string | undefined;
  getSectionName?(): string | undefined;
  isNumbered?(): boolean;
  getParent?(): AstNode | undefined;
  $sectnum?(delimiter?: string, append?: string | boolean): unknown;
  getId?(): string | undefined;
  getLevel?(): number;
  getTitle?(): string | undefined;
  getBlocks?(): AstNode[];
  getSourceLines?(): string[];
  getSourceLocation?(): AstLocation | undefined;
  getAttributes?(): Record<string, unknown>;
  getAttribute?(name: string): unknown;
}

interface AstDocument extends AstNode {
  getDocumentTitle?(options?: Record<string, unknown>): string;
}

function toPosixRel(repoRoot: string, absPath: string): string {
  const rel = path.relative(repoRoot, absPath);
  return rel.split(path.sep).join("/");
}

function decodeBasicEntities(text: string): string {
  return decodeHtmlEntities(text);
}

function slugifyId(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug || "section";
}

function getFileLines(
  filePath: string,
  cache: Map<string, string[]>,
): string[] | undefined {
  const cached = cache.get(filePath);
  if (cached) {
    return cached;
  }
  if (!fs.existsSync(filePath)) {
    return undefined;
  }
  const content = fs.readFileSync(filePath, "utf8").replace(/\r\n?/g, "\n");
  const lines = content.split("\n");
  cache.set(filePath, lines);
  return lines;
}

function isMetadataLine(trimmed: string): boolean {
  if (!trimmed) return false;
  // Attribute list / anchor line: [NOTE], [#norm:id], [[id]], [cols="1,2"], etc.
  if (/^\[.*\]$/.test(trimmed)) return true;
  // Block title: .My Title (must not be ordered list ". item" or literal delimiter "....")
  if (/^\.[^\s.]/.test(trimmed)) return true;
  return false;
}

function scanMetadataUp(
  lines: string[],
  lineIdx: number,
  minLineIdx: number,
): number {
  let start = lineIdx;
  while (start > minLineIdx) {
    const prev = lines[start - 1]?.trim() ?? "";
    if (!isMetadataLine(prev)) {
      break;
    }
    start--;
  }
  return start;
}

function expandIncludesInLines(
  rawLines: string[],
  baseDir: string,
  fileCache: Map<string, string[]>,
  visiting: Set<string> = new Set(),
): string[] {
  const result: string[] = [];
  for (const line of rawLines) {
    const incMatch = /^include::([^\[]+)\[(.*?)\]\s*$/.exec(line.trim());
    if (incMatch) {
      const target = path.resolve(baseDir, incMatch[1]);
      if (!visiting.has(target)) {
        const incLines = getFileLines(target, fileCache);
        if (incLines) {
          visiting.add(target);
          // Drop trailing empty line from split if file ends with \n
          const trimmedInc =
            incLines.length > 0 && incLines[incLines.length - 1] === ""
              ? incLines.slice(0, -1)
              : incLines;
          result.push(
            ...expandIncludesInLines(
              trimmedInc,
              path.dirname(target),
              fileCache,
              visiting,
            ),
          );
          visiting.delete(target);
          continue;
        }
      }
    }
    result.push(line);
  }
  return result;
}

function getDelimiterMatch(
  line: string,
  context: string,
): string | undefined {
  const trimmed = line.trim();
  if (context === "table") {
    const m = /^([|,;:!])={3,}$/.exec(trimmed);
    return m ? trimmed : undefined;
  }
  const m = /^(--|={4,}|\*{4,}|_{4,}|\.{4,}|-{4,}|\+{4,}|\/{4,})$/.exec(
    trimmed,
  );
  return m ? trimmed : undefined;
}

function findMaxDescendantLineInFile(
  node: AstNode,
  filePath: string,
): { maxLine: number; lastNode: AstNode } {
  let maxLine =
    node.getSourceLocation?.()?.file === filePath
      ? (node.getSourceLocation?.()?.lineno ?? 0)
      : 0;
  let lastNode: AstNode = node;

  for (const child of node.getBlocks?.() ?? []) {
    const sub = findMaxDescendantLineInFile(child, filePath);
    if (sub.maxLine >= maxLine && sub.maxLine > 0) {
      maxLine = sub.maxLine;
      lastNode = sub.lastNode;
    }
  }
  return { maxLine, lastNode };
}

function extractNodeSource(
  block: AstNode,
  nextSibling: AstNode | undefined,
  minLineByFile: Map<string, number>,
  fileCache: Map<string, string[]>,
  includedFiles: Set<string>,
): { raw: string; filePath?: string; endLineIdx?: number } {
  const ctx = block.getContext();
  const loc = block.getSourceLocation?.();
  const filePath =
    loc?.file && loc.file !== "<stdin>" ? loc.file : undefined;
  if (filePath) {
    includedFiles.add(filePath);
  }
  const lineno = loc?.lineno;

  let effectiveFilePath = filePath;

  if (filePath && lineno && lineno >= 1) {
    const lines = getFileLines(filePath, fileCache);
    if (lines && lineno - 1 < lines.length) {
      const lineIdx = lineno - 1;
      const lineTrimmed = lines[lineIdx]?.trim() ?? "";

      // Asciidoctor's sourcemap cursor can pop back to the parent `include::` line
      // when a block sits at EOF of an included file. In that case, resolve the
      // included file path for origin tracking and fall back to AST source lines.
      const incMatch = /^include::([^\[]+)\[/.exec(lineTrimmed);
      if (incMatch) {
        effectiveFilePath = path.resolve(path.dirname(filePath), incMatch[1]);
        includedFiles.add(effectiveFilePath);
      } else {
        const minLine = minLineByFile.get(filePath) ?? 0;

        // Determine exclusive upper line bound from next sibling if in same file
        const nextLoc = nextSibling?.getSourceLocation?.();
        let maxExclusiveIdx = lines.length;
        if (
          nextLoc?.file === filePath &&
          nextLoc.lineno &&
          nextLoc.lineno - 1 > lineIdx
        ) {
          maxExclusiveIdx = scanMetadataUp(
            lines,
            nextLoc.lineno - 1,
            lineIdx + 1,
          );
        }

        if (ctx === "section" || ctx === "floating_title") {
          // Include only anchor lines directly above the heading
          let startIdx = lineIdx;
          while (startIdx > minLine) {
            const prev = lines[startIdx - 1]?.trim() ?? "";
            if (/^\[#[^\]]+\]$/.test(prev) || /^\[\[[^\]]+\]\]$/.test(prev)) {
              startIdx--;
            } else {
              break;
            }
          }
          return {
            raw: lines.slice(startIdx, lineIdx + 1).join("\n"),
            filePath,
            endLineIdx: lineIdx,
          };
        }

        if (ctx === "image") {
          const startIdx = scanMetadataUp(lines, lineIdx, minLine);
          return {
            raw: lines.slice(startIdx, lineIdx + 1).join("\n"),
            filePath,
            endLineIdx: lineIdx,
          };
        }

        const startIdx = scanMetadataUp(lines, lineIdx, minLine);
        const openingDelim = getDelimiterMatch(lines[lineIdx], ctx);

        if (openingDelim) {
          let endIdx = lineIdx + 1;
          while (endIdx < maxExclusiveIdx) {
            if (lines[endIdx].trim() === openingDelim) {
              break;
            }
            endIdx++;
          }
          if (endIdx >= maxExclusiveIdx) {
            endIdx = maxExclusiveIdx - 1;
          }
          const sliced = lines.slice(startIdx, endIdx + 1);
          const expanded = expandIncludesInLines(
            sliced,
            path.dirname(filePath),
            fileCache,
          );
          return {
            raw: expanded.join("\n"),
            filePath,
            endLineIdx: endIdx,
          };
        }

        if (ctx === "ulist" || ctx === "olist" || ctx === "dlist") {
          const { maxLine, lastNode } = findMaxDescendantLineInFile(
            block,
            filePath,
          );
          let endIdx = Math.max(lineIdx, maxLine > 0 ? maxLine - 1 : lineIdx);

          // If the last descendant inside the list is a delimited block, close it
          const lastDelim = getDelimiterMatch(
            lines[endIdx] ?? "",
            lastNode.getContext(),
          );
          if (lastDelim) {
            let d = endIdx + 1;
            while (d < maxExclusiveIdx) {
              if (lines[d].trim() === lastDelim) {
                endIdx = d;
                break;
              }
              d++;
            }
          } else {
            // Consume trailing continuation lines of the last list item
            while (endIdx + 1 < maxExclusiveIdx) {
              const nextTrimmed = lines[endIdx + 1]?.trim() ?? "";
              if (
                nextTrimmed === "" ||
                /^=+\s/.test(nextTrimmed) ||
                /^(include|ifdef|ifndef|endif|ifeval)::/.test(nextTrimmed) ||
                /^\/\/(?![^/])/.test(nextTrimmed) ||
                isMetadataLine(nextTrimmed) ||
                Boolean(getDelimiterMatch(nextTrimmed, ""))
              ) {
                break;
              }
              endIdx++;
            }
          }

          const sliced = lines.slice(startIdx, endIdx + 1);
          const expanded = expandIncludesInLines(
            sliced,
            path.dirname(filePath),
            fileCache,
          );
          return {
            raw: expanded.join("\n"),
            filePath,
            endLineIdx: endIdx,
          };
        }

        // Paragraph, inline admonition ("NOTE: ..."), or indented literal/listing
        if (ctx === "paragraph") {
          const srcLines = block.getSourceLines?.() ?? [];
          if (srcLines[0]?.startsWith("Unresolved directive in ")) {
            return { raw: "", filePath: effectiveFilePath };
          }
          if (srcLines.length > 0 && !lines[lineIdx]?.includes("include::")) {
            const metaLines = lines.slice(startIdx, lineIdx);
            const endIdx = Math.min(
              maxExclusiveIdx - 1,
              lineIdx + srcLines.length - 1,
            );
            return {
              raw: [...metaLines, ...srcLines].join("\n"),
              filePath,
              endLineIdx: endIdx,
            };
          }
        }

        let endIdx = lineIdx;
        while (endIdx + 1 < maxExclusiveIdx) {
          const nextTrimmed = lines[endIdx + 1]?.trim() ?? "";
          if (
            nextTrimmed === "" ||
            /^=+\s/.test(nextTrimmed) ||
            /^(include|ifdef|ifndef|endif|ifeval)::/.test(nextTrimmed) ||
            /^\/\/(?![^/])/.test(nextTrimmed)
          ) {
            break;
          }
          endIdx++;
        }
        const sliced = lines.slice(startIdx, endIdx + 1);
        return {
          raw: sliced.join("\n"),
          filePath,
          endLineIdx: endIdx,
        };
      }
    }
  }

  // Fallback for synthetic / stdin nodes or EOF-popped include blocks
  const srcLines = block.getSourceLines?.() ?? [];
  if (srcLines[0]?.startsWith("Unresolved directive in ")) {
    return { raw: "", filePath: effectiveFilePath };
  }
  if (srcLines.length > 0) {
    const style = block.getStyle?.() ?? "";
    const title = block.getTitle?.();
    const prefix: string[] = [];
    if (title) prefix.push(`.${title}`);

    if (ctx === "admonition") {
      return {
        raw: `${prefix.length ? prefix.join("\n") + "\n" : ""}${(style || "NOTE").toUpperCase()}: ${srcLines.join("\n")}`,
        filePath: effectiveFilePath,
      };
    }
    if (ctx === "listing") {
      const lang = block.getAttribute?.("language");
      const attr =
        style === "source" && lang
          ? `[source,${String(lang)}]`
          : style
            ? `[${style}]`
            : "";
      return {
        raw: [...(attr ? [attr] : []), ...prefix, "----", ...srcLines, "----"].join("\n"),
        filePath: effectiveFilePath,
      };
    }
    if (ctx === "literal") {
      const attr = style ? `[${style}]` : "";
      return {
        raw: [...(attr ? [attr] : []), ...prefix, "....", ...srcLines, "...."].join("\n"),
        filePath: effectiveFilePath,
      };
    }
    if (ctx === "stem") {
      return {
        raw: ["[stem]", ...prefix, "++++", ...srcLines, "++++"].join("\n"),
        filePath: effectiveFilePath,
      };
    }
    return {
      raw: [...prefix, ...srcLines].join("\n"),
      filePath: effectiveFilePath,
    };
  }

  if (ctx === "section" || ctx === "floating_title") {
    const lvl = block.getLevel?.() ?? 1;
    const title = decodeBasicEntities(block.getTitle?.() ?? "Untitled");
    return { raw: `${"=".repeat(lvl + 1)} ${title}`, filePath: effectiveFilePath };
  }

  if (ctx === "image") {
    const target = String(block.getAttribute?.("target") ?? "");
    const alt = String(block.getAttribute?.("alt") ?? "");
    return { raw: `image::${target}[${alt}]`, filePath: effectiveFilePath };
  }

  return { raw: "", filePath: effectiveFilePath };
}

function classifyBlock(block: AstNode): {
  kind: BlockKind;
  translatable: boolean;
} | null {
  const ctx = block.getContext();
  const style = (block.getStyle?.() ?? "").toLowerCase();

  switch (ctx) {
    case "section":
    case "floating_title":
      return { kind: "heading", translatable: true };
    case "paragraph":
      return { kind: "paragraph", translatable: true };
    case "ulist":
    case "olist":
    case "dlist":
      return { kind: "list", translatable: true };
    case "table":
      return { kind: "table", translatable: true };
    case "admonition":
    case "example":
    case "sidebar":
    case "quote":
      return { kind: "block", translatable: true };
    case "open":
      if (DIAGRAM_STYLES.has(style)) {
        return { kind: "diagram", translatable: false };
      }
      return { kind: "block", translatable: true };
    case "listing":
    case "literal":
      if (DIAGRAM_STYLES.has(style)) {
        return { kind: "diagram", translatable: false };
      }
      return { kind: "code", translatable: false };
    case "stem":
      return { kind: "math", translatable: false };
    case "image":
      return { kind: "diagram", translatable: false };
    case "pass":
      return { kind: "block", translatable: false };
    case "thematic_break":
    case "page_break":
    case "toc":
      return null;
    default:
      return { kind: "block", translatable: true };
  }
}

/**
 * Clean raw AsciiDoc heading/title syntax into plain display text for TOC & metadata,
 * stripping leading `=`, trailing `[[anchor]]`, curved quote markers, role spans, and backticks.
 */
export function cleanPlainHeadingTitle(raw: string): string {
  const firstLine = (raw.split("\n")[0] ?? "").trim();
  const withoutMarkers = firstLine
    .replace(/^=+\s+/, "")
    .replace(/\s+=+\s*$/, "")
    .replace(/\s*\[\[[^\]]+\]\]\s*$/, "")
    .trim();
  const decoded = decodeBasicEntities(expandRiscvMacrosPlain(withoutMarkers));
  return decoded
    .replace(/"`([^`]+)`"/g, '"$1"')
    .replace(/'`([^`]+)`'/g, "'$1'")
    .replace(/\[[^\]]+\]#([^#]+)#/g, "$1")
    .replace(/\bpass:\w*\[([^\]]*)\]/g, "$1")
    .replace(/\+`([^`]+)`\+/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanHeadingText(rawHeading: string, fallbackTitle: string): string {
  const cleaned = cleanPlainHeadingTitle(rawHeading);
  if (cleaned) {
    return cleaned;
  }
  return cleanPlainHeadingTitle(fallbackTitle);
}

interface ParseContext {
  repoRoot: string;
  volumeId: VolumeId;
  entryRelPath: string;
  maxSectnumLevel: number;
  units: Map<string, ExtractedUnit>;
  fileCache: Map<string, string[]>;
  minLineByFile: Map<string, number>;
  includedFiles: Set<string>;
}

function getDocSectnumLevels(doc: AstDocument): number {
  const raw = doc.getAttribute?.("sectnumlevels");
  if (raw === undefined || raw === null || raw === "") return 3;
  const parsed = Number.parseInt(String(raw), 10);
  return Number.isFinite(parsed) ? parsed : 3;
}

function computeSectionSectnum(
  sectionNode: AstNode,
  maxSectnumLevel: number,
): string | null {
  const level = sectionNode.getLevel?.() ?? 0;
  if (level < 1 || level > maxSectnumLevel) return null;
  if (!sectionNode.isNumbered?.()) return null;

  let cur = sectionNode.getParent?.();
  while (cur && cur.getContext?.() === "section" && (cur.getLevel?.() ?? 0) >= 1) {
    if (!cur.isNumbered?.()) return null;
    cur = cur.getParent?.();
  }

  const raw = sectionNode.$sectnum?.(".", false);
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

function extractUnitAndAnchors(
  ctx: ParseContext,
  block: AstNode,
  nextSibling: AstNode | undefined,
): {
  unit: ExtractedUnit;
  anchorId?: string;
  extraAnchorIds?: string[];
} | null {
  const classified = classifyBlock(block);
  if (!classified) {
    return null;
  }

  const extracted = extractNodeSource(
    block,
    nextSibling,
    ctx.minLineByFile,
    ctx.fileCache,
    ctx.includedFiles,
  );
  if (extracted.filePath && extracted.endLineIdx !== undefined) {
    ctx.minLineByFile.set(extracted.filePath, extracted.endLineIdx + 1);
  }

  const { normalized, anchorId: parsedAnchor, extraAnchorIds } = normalizeAdocBlock(
    extracted.raw,
    classified.kind,
  );
  if (!normalized) {
    return null;
  }

  const attrId = block.getAttributes?.()?.["id"];
  const anchorId =
    parsedAnchor ?? (typeof attrId === "string" ? attrId : undefined);

  const unitId = computeUnitId(classified.kind, normalized);

  const unit: ExtractedUnit = {
    unit_id: unitId,
    kind: classified.kind,
    translatable: classified.translatable,
    en: normalized,
  };

  ctx.units.set(unitId, unit);

  const dedupedExtras = (extraAnchorIds ?? []).filter((a) => a !== anchorId);
  return {
    unit,
    ...(anchorId !== undefined ? { anchorId } : {}),
    ...(dedupedExtras.length > 0 ? { extraAnchorIds: dedupedExtras } : {}),
  };
}

function recordBlock(
  ctx: ParseContext,
  block: AstNode,
  nextSibling: AstNode | undefined,
): { unit: ExtractedUnit; blockRef: BlockRef } | null {
  const extracted = extractUnitAndAnchors(ctx, block, nextSibling);
  if (!extracted) return null;

  const blockRef: BlockRef = {
    unit_id: extracted.unit.unit_id,
    ...(extracted.anchorId !== undefined ? { anchor_id: extracted.anchorId } : {}),
    ...(extracted.extraAnchorIds ? { extra_anchors: extracted.extraAnchorIds } : {}),
  };

  return { unit: extracted.unit, blockRef };
}

function collectSectionTree(
  ctx: ParseContext,
  sectionNode: AstNode,
  sectionsOut: SectionNode[],
): { headingUnitId?: string; sectionTitle: string } {
  const level = sectionNode.getLevel?.() ?? 1;
  const rawTitle = decodeBasicEntities(
    sectionNode.getTitle?.() ?? "Untitled",
  );
  const sectionId = sectionNode.getId?.() || slugifyId(rawTitle);
  const sectnum = computeSectionSectnum(sectionNode, ctx.maxSectnumLevel);

  const currentSection: SectionNode = {
    id: sectionId,
    level,
    sectnum,
    title: cleanPlainHeadingTitle(rawTitle) || rawTitle,
    blocks: [],
  };
  sectionsOut.push(currentSection);

  let headingUnitId: string | undefined;

  const children = sectionNode.getBlocks?.() ?? [];
  const firstChild = children[0];
  const headingRec = extractUnitAndAnchors(ctx, sectionNode, firstChild);
  if (headingRec) {
    headingUnitId = headingRec.unit.unit_id;
    currentSection.heading_unit_id = headingUnitId;
    if (headingRec.anchorId !== undefined) {
      currentSection.heading_anchor_id = headingRec.anchorId;
    }
    if (headingRec.extraAnchorIds) {
      currentSection.heading_extra_anchors = headingRec.extraAnchorIds;
    }
    currentSection.title = cleanHeadingText(headingRec.unit.en, rawTitle);
  }

  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (child.getContext() === "section") {
      collectSectionTree(ctx, child, sectionsOut);
      continue;
    }

    const nextSibling = children[i + 1];
    const rec = recordBlock(ctx, child, nextSibling);
    if (rec) {
      currentSection.blocks.push(rec.blockRef);
    }
  }

  return {
    headingUnitId,
    sectionTitle: currentSection.title,
  };
}

function buildChapterFromSection(
  ctx: ParseContext,
  sectionNode: AstNode,
): ChapterNode {
  const fallbackTitle = decodeBasicEntities(
    sectionNode.getTitle?.() ?? "Untitled Chapter",
  );
  const chapterId = sectionNode.getId?.() || slugifyId(fallbackTitle);
  const loc = sectionNode.getSourceLocation?.();
  const sourcePath =
    loc?.file && loc.file !== "<stdin>"
      ? toPosixRel(ctx.repoRoot, loc.file)
      : ctx.entryRelPath;

  const sections: SectionNode[] = [];
  const { headingUnitId, sectionTitle } = collectSectionTree(
    ctx,
    sectionNode,
    sections,
  );
  const rawSectname = sectionNode.getSectionName?.();
  const sectname =
    typeof rawSectname === "string" && rawSectname.length > 0
      ? rawSectname
      : "chapter";
  const sectnum =
    sections[0]?.sectnum ?? computeSectionSectnum(sectionNode, ctx.maxSectnumLevel);

  return {
    id: chapterId,
    sectname,
    sectnum,
    title_en: sectionTitle,
    ...(headingUnitId ? { title_unit_id: headingUnitId } : {}),
    source_path: sourcePath,
    sections,
  };
}

function isStubBackMatterSection(
  sectionNode: AstNode,
  chapter: ChapterNode,
  units: Map<string, ExtractedUnit>,
): boolean {
  const style = (sectionNode.getStyle?.() ?? "").toLowerCase();
  const idLower = chapter.id.toLowerCase();
  const titleLower = chapter.title_en.trim().toLowerCase();
  const isIndexOrBiblio =
    style === "index" ||
    style === "bibliography" ||
    /^_?(index|bibliography)(_\d+)?$/.test(idLower) ||
    titleLower === "index" ||
    titleLower === "bibliography";
  if (!isIndexOrBiblio) return false;

  for (const sec of chapter.sections) {
    for (const ref of sec.blocks) {
      const u = units.get(ref.unit_id);
      if (!u || u.kind === "heading") continue;
      const body = u.en.trim();
      if (!body) continue;
      if (/^(?:bibliography|toc)::[^\n]*$/i.test(body)) continue;
      return false;
    }
  }
  return true;
}

function appendSectionChapterIfValid(
  ctx: ParseContext,
  sectionNode: AstNode,
  chapters: ChapterNode[],
): void {
  const beforeUnitIds = new Set(ctx.units.keys());
  const chap = buildChapterFromSection(ctx, sectionNode);
  if (isStubBackMatterSection(sectionNode, chap, ctx.units)) {
    for (const id of ctx.units.keys()) {
      if (!beforeUnitIds.has(id)) ctx.units.delete(id);
    }
    return;
  }
  chapters.push(chap);
}

function extractChaptersFromDoc(
  ctx: ParseContext,
  doc: AstDocument,
): ChapterNode[] {
  const chapters: ChapterNode[] = [];
  const topBlocks = doc.getBlocks?.() ?? [];

  const preambleBlocks: AstNode[] = [];
  for (let i = 0; i < topBlocks.length; i++) {
    const b = topBlocks[i];
    const bCtx = b.getContext();
    if (bCtx === "preamble") {
      preambleBlocks.push(...(b.getBlocks?.() ?? []));
      continue;
    }
    if (bCtx === "section") {
      const level = b.getLevel?.() ?? 1;
      const childBlocks = b.getBlocks?.() ?? [];
      const hasSubChapters =
        level === 0 && childBlocks.some((c) => c.getContext() === "section");

      if (hasSubChapters) {
        // Book part (`= Part`) containing `== Chapter` sections
        const partChapters: ChapterNode[] = [];
        const partBlocksBeforeChapter: AstNode[] = [];
        for (const sub of childBlocks) {
          if (sub.getContext() === "section") {
            appendSectionChapterIfValid(ctx, sub, partChapters);
          } else {
            partBlocksBeforeChapter.push(sub);
          }
        }
        if (partChapters.length === 0 && partBlocksBeforeChapter.length > 0) {
          const implicit = buildImplicitChapter(
            ctx,
            partBlocksBeforeChapter,
            b,
          );
          if (implicit) {
            partChapters.push(implicit);
          }
        }
        chapters.push(...partChapters);
      } else {
        appendSectionChapterIfValid(ctx, b, chapters);
      }
      continue;
    }

    preambleBlocks.push(b);
  }

  // Only emit top-level preamble as an implicit chapter when the document has no
  // `==` chapters at all (single-file chapterless note). In `:doctype: book` manuals,
  // paragraphs before `== Preface` are colophon/license/contributors metadata.
  if (preambleBlocks.length > 0 && chapters.length === 0) {
    const implicit = buildImplicitChapter(ctx, preambleBlocks, doc);
    if (implicit) {
      chapters.unshift(implicit);
    }
  }

  return chapters;
}

function buildImplicitChapter(
  ctx: ParseContext,
  blocks: AstNode[],
  ownerNode: AstNode,
): ChapterNode | null {
  const firstLoc = blocks[0]?.getSourceLocation?.() ?? ownerNode.getSourceLocation?.();
  const sourcePath =
    firstLoc?.file && firstLoc.file !== "<stdin>"
      ? toPosixRel(ctx.repoRoot, firstLoc.file)
      : ctx.entryRelPath;

  const baseName = path.basename(sourcePath, path.extname(sourcePath));
  const chapterId =
    ownerNode.getContext() === "section"
      ? ownerNode.getId?.() || slugifyId(ownerNode.getTitle?.() ?? baseName)
      : slugifyId(baseName || "preamble");

  const title =
    ownerNode.getContext() === "section"
      ? decodeBasicEntities(ownerNode.getTitle?.() ?? baseName)
      : decodeBasicEntities(
          (ownerNode as AstDocument).getDocumentTitle?.({ sanitize: true }) ||
            baseName ||
            "Introduction",
        );

  const section: SectionNode = {
    id: chapterId,
    level: ownerNode.getLevel?.() ?? 1,
    sectnum: null,
    title,
    blocks: [],
  };

  for (let i = 0; i < blocks.length; i++) {
    const rec = recordBlock(ctx, blocks[i], blocks[i + 1]);
    if (rec) {
      section.blocks.push(rec.blockRef);
    }
  }

  if (section.blocks.length === 0) {
    return null;
  }

  return {
    id: chapterId,
    sectname: "chapter",
    sectnum: null,
    title_en: title,
    source_path: sourcePath,
    sections: [section],
  };
}

function collectIncludedFiles(
  entryFullPath: string,
  doc: AstDocument,
  fileCache: Map<string, string[]>,
  includedFiles: Set<string>,
): void {
  const walkAst = (node: AstNode) => {
    const locFile = node.getSourceLocation?.()?.file;
    if (locFile && locFile !== "<stdin>" && !locFile.endsWith("global-config.adoc")) {
      includedFiles.add(path.resolve(locFile));
    }
    for (const child of node.getBlocks?.() ?? []) {
      walkAst(child);
    }
  };
  walkAst(doc);

  const visited = new Set<string>();
  const scanFileIncludes = (absFile: string) => {
    const resolved = path.resolve(absFile);
    if (visited.has(resolved)) return;
    visited.add(resolved);
    const lines = getFileLines(resolved, fileCache);
    if (!lines) return;
    const dir = path.dirname(resolved);
    for (const line of lines) {
      const m = /^include::([^\[]+)\[/.exec(line.trim());
      if (!m) continue;
      const rawTarget = m[1].trim();
      if (rawTarget.endsWith("global-config.adoc") || rawTarget.includes("{")) continue;
      const targetAbs = path.resolve(dir, rawTarget);
      if (fs.existsSync(targetAbs)) {
        includedFiles.add(targetAbs);
        scanFileIncludes(targetAbs);
      }
    }
  };
  scanFileIncludes(entryFullPath);
}

function extractDocumentHeaderRaw(
  fullPath: string,
  doc: AstDocument,
  fileCache: Map<string, string[]>,
): string | null {
  const lines = getFileLines(fullPath, fileCache);
  if (lines) {
    for (const line of lines) {
      const trimmed = line.trim();
      if (/^==+\s+/.test(trimmed)) break;
      if (/^=\s+\S/.test(trimmed)) {
        return trimmed;
      }
    }
  }
  const rawDocTitle = doc.getDocumentTitle?.() ?? "";
  if (!rawDocTitle.trim()) return null;
  return `= ${decodeBasicEntities(rawDocTitle).trim()}`;
}

function deriveUntitledFallbackTitle(entryRelPath: string): string {
  const base = path.basename(entryRelPath, path.extname(entryRelPath));
  const cleaned = base.replace(/^riscv[-_]?/i, "").replace(/[-_]+/g, " ").trim();
  if (!cleaned) return "Manual";
  return cleaned.replace(/\b\w/g, (c) => c.toUpperCase());
}

const CANONICAL_VOLUME_ORDER: readonly VolumeId[] = ["unpriv", "priv", "profiles", "debug"];

function inferVolumeIdFromPart(partNode: AstNode): VolumeId | null {
  const title = decodeBasicEntities(partNode.getTitle?.() ?? "").toLowerCase();
  if (/\bvolume\s+iv\b/.test(title) || /\bdebug\s*(?:&|and)\s*trace\b/.test(title)) {
    return "debug";
  }
  if (/\bunprivileged\b/.test(title) || /\bvolume\s+i\b(?![ivx])/.test(title)) {
    return "unpriv";
  }
  if (/\bprivileged\b/.test(title) || /\bvolume\s+ii\b(?![ivx])/.test(title)) {
    return "priv";
  }
  if (/\bprofiles?\b/.test(title) || /\bvolume\s+iii\b/.test(title)) {
    return "profiles";
  }

  const locFile = partNode.getSourceLocation?.()?.file;
  if (locFile && locFile !== "<stdin>") {
    const base = path.basename(locFile).toLowerCase();
    if (!/^(?:riscv-spec|riscv-isa-manual|isa-manual)\.adoc$/.test(base)) {
      const lower = locFile.toLowerCase();
      if (lower.includes("debug") || lower.includes("trace")) return "debug";
      if (lower.includes("profile")) return "profiles";
      if (lower.includes("priv") && !lower.includes("unpriv")) return "priv";
      if (lower.includes("unpriv")) return "unpriv";
    }
  }
  return null;
}

function recordVolumeTitleUnit(
  ctx: ParseContext,
  rawHeadingLine: string | null,
  fallbackRelPath: string,
  fallbackTitleText?: string,
): { titleEn: string; titleUnitId?: string } {
  if (rawHeadingLine) {
    const { normalized } = normalizeAdocBlock(rawHeadingLine, "heading");
    const titleEn =
      cleanPlainHeadingTitle(normalized || rawHeadingLine) ||
      (fallbackTitleText ? cleanPlainHeadingTitle(fallbackTitleText) : "") ||
      deriveUntitledFallbackTitle(fallbackRelPath);
    if (normalized) {
      const unitId = computeUnitId("heading", normalized);
      ctx.units.set(unitId, {
        unit_id: unitId,
        kind: "heading",
        translatable: true,
        en: normalized,
      });
      return { titleEn, titleUnitId: unitId };
    }
    return { titleEn };
  }
  return {
    titleEn:
      (fallbackTitleText ? cleanPlainHeadingTitle(fallbackTitleText) : "") ||
      deriveUntitledFallbackTitle(fallbackRelPath),
  };
}

function parseBookEntryInternal(
  repoRoot: string,
  defaultVolumeId: VolumeId,
  entryRelPath: string,
  includedFiles: Set<string>,
  allowMultiVolumeSplit: boolean,
): { volumes: VolumeNode[]; units: Map<string, ExtractedUnit> } {
  vlog(2, `parse ${defaultVolumeId}: ${entryRelPath}`);
  const fullPath = path.resolve(repoRoot, entryRelPath);
  const entryDir = path.dirname(fullPath);
  const doc = asciidoctor.loadFile(fullPath, {
    safe: "unsafe",
    sourcemap: true,
    base_dir: entryDir,
    extension_registry: createGlobalConfigExtensionRegistry(
      repoRoot,
      entryDir,
    ),
  }) as unknown as AstDocument;

  includedFiles.add(fullPath);

  const units = new Map<string, ExtractedUnit>();
  const posixEntryRel = entryRelPath.split(path.sep).join("/");
  const ctx: ParseContext = {
    repoRoot: path.resolve(repoRoot),
    volumeId: defaultVolumeId,
    entryRelPath: posixEntryRel,
    maxSectnumLevel: getDocSectnumLevels(doc),
    units,
    fileCache: new Map(),
    minLineByFile: new Map(),
    includedFiles,
  };

  collectIncludedFiles(fullPath, doc, ctx.fileCache, includedFiles);

  const topBlocks = doc.getBlocks?.() ?? [];
  if (allowMultiVolumeSplit) {
    const detectedPartVols = new Set<VolumeId>();
    for (const b of topBlocks) {
      if (b.getContext() === "section" && (b.getLevel?.() ?? 1) === 0) {
        const vId = inferVolumeIdFromPart(b);
        if (vId) detectedPartVols.add(vId);
      }
    }
    const isUnifiedEntryName = /^(?:riscv-spec|riscv-isa-manual|isa-manual)\.adoc$/i.test(
      path.basename(posixEntryRel),
    );

    if (detectedPartVols.size >= 2 || (isUnifiedEntryName && detectedPartVols.size >= 1)) {
      const volMap = new Map<VolumeId, VolumeNode>();
      const ensureVol = (volId: VolumeId, partNode?: AstNode): VolumeNode => {
        const existing = volMap.get(volId);
        if (existing) return existing;

        let partRelPath = posixEntryRel;
        let rawLine: string | null = null;
        let fallbackTitle: string | undefined;

        if (partNode) {
          fallbackTitle = decodeBasicEntities(partNode.getTitle?.() ?? "");
          const extracted = extractNodeSource(
            partNode,
            undefined,
            ctx.minLineByFile,
            ctx.fileCache,
            ctx.includedFiles,
          );
          if (extracted.filePath && extracted.endLineIdx !== undefined) {
            ctx.minLineByFile.set(extracted.filePath, extracted.endLineIdx + 1);
          }
          if (extracted.filePath) {
            partRelPath = toPosixRel(ctx.repoRoot, extracted.filePath);
          }
          if (extracted.raw.trim()) {
            rawLine = extracted.raw;
          } else if (fallbackTitle.trim()) {
            rawLine = `= ${fallbackTitle.trim()}`;
          }
        }

        const { titleEn, titleUnitId } = recordVolumeTitleUnit(
          ctx,
          rawLine,
          partRelPath,
          fallbackTitle,
        );
        const created: VolumeNode = {
          id: volId,
          title_en: titleEn,
          ...(titleUnitId ? { title_unit_id: titleUnitId } : {}),
          entry_file: partRelPath,
          chapters: [],
        };
        volMap.set(volId, created);
        return created;
      };

      const inferNodeVolId = (node: AstNode, fallback: VolumeId): VolumeId => {
        const loc = node.getSourceLocation?.();
        if (loc?.file && loc.file !== "<stdin>") {
          const rel = toPosixRel(ctx.repoRoot, loc.file);
          return inferVolumeIdFromPath(rel);
        }
        return fallback;
      };

      for (const b of topBlocks) {
        if (b.getContext() !== "section") continue;
        const level = b.getLevel?.() ?? 1;
        const childBlocks = b.getBlocks?.() ?? [];
        const hasSubChapters =
          level === 0 && childBlocks.some((c) => c.getContext() === "section");

        if (hasSubChapters) {
          const partVolId = inferVolumeIdFromPart(b);
          const fixedVol = partVolId ? ensureVol(partVolId, b) : null;
          for (const sub of childBlocks) {
            if (sub.getContext() !== "section") continue;
            const targetVol = fixedVol ?? ensureVol(inferNodeVolId(sub, "unpriv"));
            ctx.volumeId = targetVol.id;
            appendSectionChapterIfValid(ctx, sub, targetVol.chapters);
          }
        } else {
          const targetVol = ensureVol(inferNodeVolId(b, "unpriv"));
          ctx.volumeId = targetVol.id;
          appendSectionChapterIfValid(ctx, b, targetVol.chapters);
        }
      }

      const orderedVolumes: VolumeNode[] = [];
      for (const id of CANONICAL_VOLUME_ORDER) {
        const v = volMap.get(id);
        if (v && v.chapters.length > 0) orderedVolumes.push(v);
      }
      vlog(
        2,
        `parsed unified book ${posixEntryRel} -> ${orderedVolumes.map((v) => `${v.id}(${v.chapters.length})`).join(", ")} (${units.size} units)`,
      );
      return { volumes: orderedVolumes, units };
    }
  }

  const headerRaw = extractDocumentHeaderRaw(fullPath, doc, ctx.fileCache);
  const { titleEn, titleUnitId } = recordVolumeTitleUnit(
    ctx,
    headerRaw,
    posixEntryRel,
  );
  const chapters = extractChaptersFromDoc(ctx, doc);

  const volume: VolumeNode = {
    id: defaultVolumeId,
    title_en: titleEn,
    ...(titleUnitId ? { title_unit_id: titleUnitId } : {}),
    entry_file: posixEntryRel,
    chapters,
  };

  vlog(
    2,
    `parsed ${defaultVolumeId}: ${posixEntryRel} (${chapters.length} chapters, ${units.size} units)`,
  );
  return { volumes: [volume], units };
}

function parseVolumeEntryInternal(
  repoRoot: string,
  volumeId: VolumeId,
  entryRelPath: string,
  includedFiles: Set<string>,
): { volume: VolumeNode; units: Map<string, ExtractedUnit> } {
  const res = parseBookEntryInternal(
    repoRoot,
    volumeId,
    entryRelPath,
    includedFiles,
    false,
  );
  return { volume: res.volumes[0], units: res.units };
}

/**
 * Parse a single volume entry AsciiDoc file (resolving `include::` directives)
 * into a `VolumeNode` and a map of extracted `ExtractedUnit`s.
 */
export function parseVolumeEntry(
  repoRoot: string,
  volumeId: VolumeId,
  entryRelPath: string,
): { volume: VolumeNode; units: Map<string, ExtractedUnit> } {
  return parseVolumeEntryInternal(
    repoRoot,
    volumeId,
    entryRelPath,
    new Set(),
  );
}

function inferVolumeIdFromPath(relPath: string): VolumeId {
  const lower = relPath.toLowerCase();
  if (lower.includes("debug") || lower.includes("trace")) return "debug";
  if (lower.includes("profile")) return "profiles";
  if (lower.includes("priv") && !lower.includes("unpriv")) return "priv";
  return "unpriv";
}

function listAdocFiles(dirPath: string): string[] {
  if (!fs.existsSync(dirPath)) return [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".adoc"))
    .map((e) => path.join(dirPath, e.name))
    .sort((a, b) => a.localeCompare(b));
}

function countLocalAdocIncludes(absFile: string): number {
  if (!fs.existsSync(absFile)) return 0;
  const content = fs.readFileSync(absFile, "utf8");
  let count = 0;
  for (const line of content.split(/\r?\n/)) {
    const m = /^include::([^\[]+)\[/.exec(line.trim());
    if (m && !m[1].trim().endsWith("global-config.adoc")) {
      count++;
    }
  }
  return count;
}

function rankFallbackEntry(relPath: string): number {
  const base = path.basename(relPath).toLowerCase();
  if (base.startsWith("riscv-")) return 0;
  if (base.includes("profiles") || base === "index.adoc" || base === "main.adoc" || base === "manual.adoc" || base === "book.adoc") {
    return 1;
  }
  return 2;
}

function sortEntryFilesUmbrellaFirst(absRoot: string, absFiles: string[]): string[] {
  const includeCounts = new Map<string, number>();
  for (const f of absFiles) {
    includeCounts.set(f, countLocalAdocIncludes(f));
  }
  return [...absFiles]
    .sort((a, b) => {
      const aHasInc = (includeCounts.get(a) ?? 0) > 0 ? 0 : 1;
      const bHasInc = (includeCounts.get(b) ?? 0) > 0 ? 0 : 1;
      if (aHasInc !== bHasInc) return aHasInc - bHasInc;
      const relA = toPosixRel(absRoot, a);
      const relB = toPosixRel(absRoot, b);
      const rankDiff = rankFallbackEntry(relA) - rankFallbackEntry(relB);
      if (rankDiff !== 0) return rankDiff;
      const countDiff = (includeCounts.get(b) ?? 0) - (includeCounts.get(a) ?? 0);
      if (countDiff !== 0) return countDiff;
      return relA.localeCompare(relB);
    })
    .map((f) => toPosixRel(absRoot, f));
}

/**
 * Auto-detect RISC-V ISA manual entry files (or fallback `.adoc` files in `src/` / root)
 * and parse all volumes in the repository snapshot with shared collision disambiguation.
 */
export function parseRepositorySnapshot(repoRoot: string): {
  volumes: VolumeNode[];
  units: Map<string, ExtractedUnit>;
} {
  const absRoot = path.resolve(repoRoot);
  const allUnits = new Map<string, ExtractedUnit>();
  const includedFiles = new Set<string>();
  const volumeMap = new Map<VolumeId, VolumeNode>();
  const volumeOrder: VolumeId[] = [];

  const mergeParsed = (parsed: { volumes: VolumeNode[]; units: Map<string, ExtractedUnit> }) => {
    for (const [id, unit] of parsed.units) {
      allUnits.set(id, unit);
    }
    for (const vol of parsed.volumes) {
      const existing = volumeMap.get(vol.id);
      if (!existing) {
        volumeMap.set(vol.id, vol);
        volumeOrder.push(vol.id);
      } else {
        existing.chapters.push(...vol.chapters);
      }
    }
  };

  const parseEntryIfUnseen = (volumeId: VolumeId, relPath: string, allowSplit: boolean) => {
    const absFile = path.resolve(absRoot, relPath);
    if (!fs.existsSync(absFile) || includedFiles.has(absFile)) return;
    mergeParsed(
      parseBookEntryInternal(
        absRoot,
        volumeId,
        relPath,
        includedFiles,
        allowSplit,
      ),
    );
  };

  // 1. Unified master book entry (e.g. `src/riscv-spec.adoc` since upstream PR #2770)
  for (const unifiedRel of ["src/riscv-spec.adoc", "src/riscv-isa-manual.adoc", "src/isa-manual.adoc"]) {
    if (fs.existsSync(path.join(absRoot, unifiedRel))) {
      parseEntryIfUnseen("unpriv", unifiedRel, true);
      break;
    }
  }

  // 2. Per-volume book entries (classic `src/riscv-unprivileged.adoc` / `src/riscv-privileged.adoc` + `src/profiles/`)
  const standardEntries: Array<{ volumeId: VolumeId; relPaths: string[] }> = [];
  if (fs.existsSync(path.join(absRoot, "src/riscv-unprivileged.adoc"))) {
    standardEntries.push({
      volumeId: "unpriv",
      relPaths: ["src/riscv-unprivileged.adoc"],
    });
  }
  if (fs.existsSync(path.join(absRoot, "src/riscv-privileged.adoc"))) {
    standardEntries.push({
      volumeId: "priv",
      relPaths: ["src/riscv-privileged.adoc"],
    });
  }
  if (fs.existsSync(path.join(absRoot, "src/riscv-profiles.adoc"))) {
    standardEntries.push({
      volumeId: "profiles",
      relPaths: ["src/riscv-profiles.adoc"],
    });
  } else {
    const profileFiles = listAdocFiles(path.join(absRoot, "src/profiles"));
    if (profileFiles.length > 0) {
      standardEntries.push({
        volumeId: "profiles",
        relPaths: sortEntryFilesUmbrellaFirst(absRoot, profileFiles),
      });
    }
  }
  if (fs.existsSync(path.join(absRoot, "src/riscv-debug.adoc"))) {
    standardEntries.push({
      volumeId: "debug",
      relPaths: ["src/riscv-debug.adoc"],
    });
  } else if (fs.existsSync(path.join(absRoot, "src/riscv-debug-and-trace.adoc"))) {
    standardEntries.push({
      volumeId: "debug",
      relPaths: ["src/riscv-debug-and-trace.adoc"],
    });
  } else {
    const debugFiles = listAdocFiles(path.join(absRoot, "src/debug"));
    if (debugFiles.length > 0) {
      standardEntries.push({
        volumeId: "debug",
        relPaths: sortEntryFilesUmbrellaFirst(absRoot, debugFiles),
      });
    }
  }

  for (const entry of standardEntries) {
    for (const relPath of entry.relPaths) {
      parseEntryIfUnseen(entry.volumeId, relPath, true);
    }
  }

  if (volumeMap.size > 0) {
    const ordered: VolumeNode[] = [];
    for (const id of CANONICAL_VOLUME_ORDER) {
      const v = volumeMap.get(id);
      if (v) ordered.push(v);
    }
    return { volumes: ordered, units: allUnits };
  }

  // 3. Fallback: detect any .adoc files in src/ or repo root
  let fallbackAbs = listAdocFiles(path.join(absRoot, "src"));
  if (fallbackAbs.length === 0) {
    fallbackAbs = listAdocFiles(absRoot);
  }

  const fallbackRel = sortEntryFilesUmbrellaFirst(absRoot, fallbackAbs);
  for (const relPath of fallbackRel) {
    parseEntryIfUnseen(inferVolumeIdFromPath(relPath), relPath, true);
  }

  return {
    volumes: volumeOrder.map((id) => volumeMap.get(id)!),
    units: allUnits,
  };
}
