function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const VERBATIM_FENCE_RE = /^(\-{4,}|\.{4,}|\+{4,}|`{3,})(.*)$/;
const INLINE_PROTECTED_RE =
  /(\+\+\+[\s\S]*?\+\+\+|pass:\w*\[[^\]]*\]|"`[^`]*`"|'`[^`]*`'|``[^`\n]+?''|`{2,}[^`\n]+?`{2,}|`[^`\n]+`)/g;

const RISCV_MACRO_RE =
  /(extlink|ext|insnlink|insn|inst|csr|qty):([A-Za-z0-9_.*+:-]*)\[([^\]]*)\]/g;

function hasMacroWordBoundaryBefore(segment: string, offset: number): boolean {
  if (offset === 0) return true;
  const prev = segment[offset - 1];
  if (prev === "_") {
    // Allow italic `_insn:lr[]_` while rejecting snake_case `my_insn:foo[]`.
    return offset < 2 || !/[A-Za-z0-9]/.test(segment[offset - 2]);
  }
  return !/[A-Za-z0-9]/.test(prev);
}

/** Canonicalize a RISC-V extension target name (`h` -> `H`, `zicntr` -> `Zicntr`, `rv32i` -> `RV32I`). */
export function formatRiscvExtensionName(target: string): string {
  const t = target.trim();
  if (!t) return "";
  if (/^[a-z]$/i.test(t)) return t.toUpperCase();
  if (/^rv(?:32|64|128)[a-z]{0,5}$/i.test(t) && !/^rv\d+[zsx]/i.test(t)) {
    return t.toUpperCase();
  }
  if (t === t.toLowerCase()) {
    return t.charAt(0).toUpperCase() + t.slice(1);
  }
  return t;
}

/** Canonicalize an instruction macro (`insn:jalr[x1,0(rs1)]` -> `JALR x1, 0(rs1)`). */
export function formatRiscvInsnText(target: string, attr: string): string {
  const mnem = target.trim().toUpperCase();
  const cleanAttr = attr.trim().replace(/,(\S)/g, ", $1");
  if (cleanAttr) {
    return mnem ? `${mnem} ${cleanAttr}` : cleanAttr;
  }
  return mnem;
}

/** Canonicalize a CSR macro (`csr:mstatus[tvm]` -> `mstatus.tvm`, `csr::[elp]` -> `elp`). */
export function formatRiscvCsrText(target: string, attr: string): string {
  const cleanTarget = target.replace(/^:+/, "").trim();
  const cleanAttr = attr.trim();
  if (cleanTarget && cleanAttr) return `${cleanTarget}.${cleanAttr}`;
  return cleanTarget || cleanAttr;
}

function normalizeInsnAnchorSlug(target: string): string {
  return target
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function replaceInlineMacrosInSegment(
  segment: string,
  mode: "html" | "plain",
): string {
  RISCV_MACRO_RE.lastIndex = 0;
  return segment.replace(
    RISCV_MACRO_RE,
    (full, macro: string, target: string, attr: string, offset: number) => {
      if (!hasMacroWordBoundaryBefore(segment, offset)) {
        return full;
      }
      switch (macro) {
        case "insn":
        case "inst": {
          if (!target && !attr) return full;
          const text = formatRiscvInsnText(target, attr);
          return mode === "html"
            ? `+++<code>${escapeHtml(text)}</code>+++`
            : text;
        }
        case "insnlink": {
          if (!target) return full;
          const label = attr.trim() || formatRiscvInsnText(target, "");
          if (mode === "plain") return label;
          const slug = normalizeInsnAnchorSlug(target);
          return `+++<a class="rv-insnlink" data-rv-insnlink="${escapeHtml(target.trim())}" href="#insns-${escapeHtml(slug)}"><code>${escapeHtml(label)}</code></a>+++`;
        }
        case "csr": {
          const text = formatRiscvCsrText(target, attr);
          if (!text) return full;
          return mode === "html"
            ? `+++<code>${escapeHtml(text)}</code>+++`
            : text;
        }
        case "ext": {
          if (!target) return full;
          const label = attr.trim() || formatRiscvExtensionName(target);
          return mode === "html"
            ? `+++<span class="rv-ext">${escapeHtml(label)}</span>+++`
            : label;
        }
        case "extlink": {
          if (!target) return full;
          const label = attr.trim() || formatRiscvExtensionName(target);
          if (mode === "plain") return label;
          const rawTarget = target.trim();
          return `+++<a class="rv-extlink" data-rv-extlink="${escapeHtml(rawTarget)}" href="#${escapeHtml(rawTarget.toLowerCase())}">${escapeHtml(label)}</a>+++`;
        }
        case "qty": {
          const num = target.trim();
          const unit = attr.trim();
          if (!num || !unit) return full;
          return mode === "html"
            ? `+++<span class="rv-qty">${escapeHtml(num)}&#160;${escapeHtml(unit)}</span>+++`
            : `${num} ${unit}`;
        }
        default:
          return full;
      }
    },
  );
}

interface TextChunk {
  fenced: boolean;
  text: string;
}

/**
 * Split AsciiDoc text into verbatim-fenced vs non-fenced chunks while keeping
 * consecutive non-fenced lines together so multi-line passthroughs and curved
 * quotes are matched intact.
 */
function splitVerbatimFences(adoc: string): TextChunk[] {
  const lines = adoc.replace(/\r\n?/g, "\n").split("\n");
  const chunks: TextChunk[] = [];
  let activeFence: string | null = null;
  let buffer: string[] = [];

  const flush = (fenced: boolean) => {
    if (buffer.length > 0) {
      chunks.push({ fenced, text: buffer.join("\n") });
      buffer = [];
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (activeFence !== null) {
      buffer.push(line);
      if (
        trimmed === activeFence ||
        (activeFence.startsWith("`") && trimmed.startsWith(activeFence) && /^`+$/.test(trimmed))
      ) {
        flush(true);
        activeFence = null;
      }
      continue;
    }

    const fenceMatch = VERBATIM_FENCE_RE.exec(trimmed);
    if (fenceMatch) {
      const delim = fenceMatch[1];
      const rest = fenceMatch[2].trim();
      if (delim.startsWith("`")) {
        flush(false);
        activeFence = delim.slice(0, 3);
        buffer.push(line);
        continue;
      }
      if (rest === "") {
        flush(false);
        activeFence = delim;
        buffer.push(line);
        continue;
      }
    }

    buffer.push(line);
  }

  flush(activeFence !== null);
  return chunks;
}

function mapUnprotectedSegments(
  chunk: string,
  onUnprotected: (segment: string) => string | void,
): string {
  INLINE_PROTECTED_RE.lastIndex = 0;
  let result = "";
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = INLINE_PROTECTED_RE.exec(chunk)) !== null) {
    if (match.index > lastIndex) {
      const replaced = onUnprotected(chunk.slice(lastIndex, match.index));
      if (typeof replaced === "string") {
        result += replaced;
      }
    }
    result += match[0];
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < chunk.length) {
    const replaced = onUnprotected(chunk.slice(lastIndex));
    if (typeof replaced === "string") {
      result += replaced;
    }
  }
  return result;
}

function transformUnprotectedText(
  adoc: string,
  mode: "html" | "plain",
): string {
  return splitVerbatimFences(adoc)
    .map((chunk) =>
      chunk.fenced
        ? chunk.text
        : mapUnprotectedSegments(chunk.text, (segment) =>
            replaceInlineMacrosInSegment(segment, mode),
          ),
    )
    .join("\n");
}

/**
 * Pre-expand upstream RISC-V custom inline macros outside fenced verbatim blocks
 * and inline code spans into unconstrained AsciiDoc passthroughs (`+++...+++`)
 * before invoking `asciidoctor.convert`.
 */
export function expandRiscvMacrosForHtml(adoc: string): string {
  return transformUnprotectedText(adoc, "html");
}

/**
 * Expand upstream RISC-V custom inline macros into clean display plain text
 * for section titles, TOC entries, and search indexing.
 */
export function expandRiscvMacrosPlain(text: string): string {
  return transformUnprotectedText(text, "plain");
}

/**
 * Extract canonical validation tokens for RISC-V custom inline macros present in
 * an English source block so translation QA can catch dropped or mangled macros.
 * `extlink:`, `insnlink:`, and `qty:` return `macro:target[` prefixes so localized
 * display/unit text inside brackets remains valid, and `inst:` canonicalizes to `insn:`.
 */
export function extractRiscvMacroTokens(adoc: string): string[] {
  const tokens: string[] = [];
  for (const chunk of splitVerbatimFences(adoc)) {
    if (chunk.fenced) continue;
    mapUnprotectedSegments(chunk.text, (segment) => {
      RISCV_MACRO_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = RISCV_MACRO_RE.exec(segment)) !== null) {
        if (!hasMacroWordBoundaryBefore(segment, m.index)) continue;
        const [, macro, target, attr] = m;
        const canonicalMacro = macro === "inst" ? "insn" : macro;
        if (canonicalMacro === "qty" || canonicalMacro === "extlink" || canonicalMacro === "insnlink") {
          tokens.push(`${canonicalMacro}:${target}[`);
        } else {
          tokens.push(`${canonicalMacro}:${target}[${attr}]`);
        }
      }
    });
  }
  return tokens;
}
