import { UnitTomlSchema, type UnitToml } from "@riscv-cn/schema";

/**
 * Returns the relative path inside the data repository for a given 32-hex unit ID.
 */
export function unitRelPath(unitId: string): string {
  return `units/${unitId.slice(0, 2)}/${unitId}.toml`;
}

/**
 * Parses and validates a unit TOML file strictly under the 3-state discriminated `UnitTomlSchema`.
 */
export function parseUnitToml(content: string): UnitToml {
  const raw = Bun.TOML.parse(content);
  return UnitTomlSchema.parse(raw);
}

function hasDisallowedLiteralControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0x0a || code === 0x09) continue; // LF and TAB are allowed in multi-line literal strings
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function escapeMultilineBasic(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    const code = value.charCodeAt(i);
    if (ch === "\\") {
      out += "\\\\";
    } else if (ch === '"') {
      out += '\\"';
    } else if (ch === "\r") {
      out += "\\r";
    } else if (ch === "\n") {
      out += "\n";
    } else if (ch === "\t") {
      out += "\t";
    } else if (code < 0x20 || code === 0x7f) {
      out += `\\u${code.toString(16).padStart(4, "0")}`;
    } else {
      out += ch;
    }
  }
  return out;
}

function formatMultilineTomlString(value: string): string {
  if (!value.includes("'''") && !hasDisallowedLiteralControlChars(value)) {
    return `'''\n${value}'''`;
  }
  return `"""\n${escapeMultilineBasic(value)}"""`;
}

/**
 * Serializes a `UnitToml` object deterministically under the strict 3-state discriminated format:
 * - Untranslatable units (`translatable = false`) omit `status` and `zh`.
 * - Translatable units (`translatable = true`) emit `status`, `en`, and `zh`.
 */
export function serializeUnitToml(unit: UnitToml): string {
  const validated = UnitTomlSchema.parse(unit);
  const lines: string[] = [
    `unit_id = ${JSON.stringify(validated.unit_id)}`,
    `kind = ${JSON.stringify(validated.kind)}`,
    `translatable = ${validated.translatable ? "true" : "false"}`,
  ];

  if (validated.translatable) {
    lines.push(`status = ${JSON.stringify(validated.status)}`);
    lines.push(`en = ${formatMultilineTomlString(validated.en)}`);
    lines.push(`zh = ${formatMultilineTomlString(validated.zh)}`);
  } else {
    lines.push(`en = ${formatMultilineTomlString(validated.en)}`);
  }

  const serialized = `${lines.join("\n")}\n`;
  const roundTrip = parseUnitToml(serialized);
  if (
    roundTrip.unit_id !== validated.unit_id ||
    roundTrip.kind !== validated.kind ||
    roundTrip.translatable !== validated.translatable ||
    roundTrip.en !== validated.en ||
    (roundTrip.translatable &&
      validated.translatable &&
      (roundTrip.status !== validated.status || roundTrip.zh !== validated.zh))
  ) {
    throw new Error(`TOML round-trip verification failed for unit ${validated.unit_id}`);
  }

  return serialized;
}
