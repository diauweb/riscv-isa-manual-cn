export interface TagClassification {
  ratified_tag: string | null;
  draft_tags: string[];
}

const RATIFIED_TAG_RE = /^\d{8}$/;
const DRAFT_TAG_RE = /^riscv-isa-release-/;

function ensureEntry(
  map: Map<string, TagClassification>,
  sha: string,
): TagClassification {
  let entry = map.get(sha);
  if (!entry) {
    entry = { ratified_tag: null, draft_tags: [] };
    map.set(sha, entry);
  }
  return entry;
}

function applyTag(
  map: Map<string, TagClassification>,
  sha: string,
  tag: string,
): void {
  if (RATIFIED_TAG_RE.test(tag)) {
    const entry = ensureEntry(map, sha);
    if (entry.ratified_tag === null || tag > entry.ratified_tag) {
      entry.ratified_tag = tag;
    }
    return;
  }

  if (DRAFT_TAG_RE.test(tag)) {
    const entry = ensureEntry(map, sha);
    if (!entry.draft_tags.includes(tag)) {
      entry.draft_tags.push(tag);
    }
  }
}

/**
 * Classify upstream git tags into ratified (`YYYYMMDD`) and draft (`riscv-isa-release-*`)
 * annotations keyed by commit SHA.
 */
export function classifyUpstreamTags(
  tags: Record<string, string[]> | Array<{ tag: string; sha: string }>,
): Map<string, TagClassification> {
  const result = new Map<string, TagClassification>();

  if (Array.isArray(tags)) {
    for (const item of tags) {
      if (item && item.sha && item.tag) {
        applyTag(result, item.sha, item.tag);
      }
    }
  } else {
    for (const [sha, tagList] of Object.entries(tags)) {
      if (!Array.isArray(tagList)) continue;
      for (const tag of tagList) {
        applyTag(result, sha, tag);
      }
    }
  }

  for (const entry of result.values()) {
    entry.draft_tags.sort((a, b) => a.localeCompare(b));
  }

  return result;
}
