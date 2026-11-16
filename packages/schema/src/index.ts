import { z } from "zod";

export const Hex32Schema = z
  .string()
  .regex(/^[0-9a-f]{32}$/, "Expected 32-char lowercase hex string");
export type Hex32 = z.infer<typeof Hex32Schema>;

export const Hex16Schema = z
  .string()
  .regex(/^[0-9a-f]{16}$/, "Expected 16-char lowercase hex string");
export type Hex16 = z.infer<typeof Hex16Schema>;

export const BlockKindSchema = z.enum([
  "heading",
  "paragraph",
  "list",
  "table",
  "block",
  "code",
  "diagram",
  "math",
]);
export type BlockKind = z.infer<typeof BlockKindSchema>;

export const TranslatableBlockKindSchema = z.enum([
  "heading",
  "paragraph",
  "list",
  "table",
  "block",
]);
export type TranslatableBlockKind = z.infer<typeof TranslatableBlockKindSchema>;

export const UntranslatableBlockKindSchema = z.enum([
  "code",
  "diagram",
  "math",
  "block",
]);
export type UntranslatableBlockKind = z.infer<typeof UntranslatableBlockKindSchema>;

const UNTRANSLATABLE_DEFAULT_KINDS = new Set<BlockKind>(["code", "diagram", "math"]);

/** Whether a block kind is translatable by default (outside raw passthrough `block`). */
export function isDefaultTranslatableKind(kind: BlockKind): boolean {
  return !UNTRANSLATABLE_DEFAULT_KINDS.has(kind);
}

export const TranslationStatusSchema = z.enum([
  "untranslated",
  "machine",
  "approved",
]);
export type TranslationStatus = z.infer<typeof TranslationStatusSchema>;

export const DiffStatusSchema = z.enum([
  "added",
  "modified",
  "moved",
]);
export type DiffStatus = z.infer<typeof DiffStatusSchema>;

export const UntranslatableUnitTomlSchema = z
  .object({
    unit_id: Hex32Schema,
    kind: UntranslatableBlockKindSchema,
    translatable: z.literal(false),
    en: z.string(),
  })
  .strict();
export type UntranslatableUnitToml = z.infer<typeof UntranslatableUnitTomlSchema>;

const TranslatableUnitTomlObjectSchema = z
  .object({
    unit_id: Hex32Schema,
    kind: TranslatableBlockKindSchema,
    translatable: z.literal(true),
    status: TranslationStatusSchema,
    en: z.string(),
    zh: z.string(),
  })
  .strict();

export const TranslatableUnitTomlSchema = TranslatableUnitTomlObjectSchema.superRefine(
  (val, ctx) => {
    if (val.status === "untranslated") {
      if (val.zh !== "") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["zh"],
          message: 'status "untranslated" requires zh to be ""',
        });
      }
    } else if (val.zh.trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["zh"],
        message: `status "${val.status}" requires non-empty zh`,
      });
    }
  },
);
export type TranslatableUnitToml = z.infer<typeof TranslatableUnitTomlSchema>;

export const UnitTomlSchema = z
  .discriminatedUnion("translatable", [
    UntranslatableUnitTomlSchema,
    TranslatableUnitTomlObjectSchema,
  ])
  .superRefine((val, ctx) => {
    if (!val.translatable) return;
    if (val.status === "untranslated") {
      if (val.zh !== "") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["zh"],
          message: 'status "untranslated" requires zh to be ""',
        });
      }
    } else if (val.zh.trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["zh"],
        message: `status "${val.status}" requires non-empty zh`,
      });
    }
  });
export type UnitToml = z.infer<typeof UnitTomlSchema>;

export const BlockAnchorObjectSchema = z
  .object({
    unit_id: Hex32Schema,
    anchor_id: z.string().min(1).optional(),
    extra_anchors: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict()
  .refine(
    (val) =>
      val.anchor_id !== undefined ||
      (val.extra_anchors !== undefined && val.extra_anchors.length > 0),
    { message: "Plain unanchored block must be serialized as a bare Hex32 string" },
  );
export type BlockAnchorObject = z.infer<typeof BlockAnchorObjectSchema>;

export const BlockEntrySchema = z.union([Hex32Schema, BlockAnchorObjectSchema]);
export type BlockEntry = z.infer<typeof BlockEntrySchema>;

export interface NormalizedBlockAnchor {
  unit_id: Hex32;
  anchor_id?: string;
  extra_anchors?: string[];
}

export function blockEntryUnitId(entry: BlockEntry): Hex32 {
  return typeof entry === "string" ? entry : entry.unit_id;
}

export function normalizeBlockEntry(entry: BlockEntry): NormalizedBlockAnchor {
  return typeof entry === "string" ? { unit_id: entry } : entry;
}

export function compactBlockEntry(ref: {
  unit_id: Hex32;
  anchor_id?: string;
  extra_anchors?: string[];
}): BlockEntry {
  const extras = ref.extra_anchors?.filter((a) => a.length > 0);
  if (!ref.anchor_id && (!extras || extras.length === 0)) {
    return ref.unit_id;
  }
  return {
    unit_id: ref.unit_id,
    ...(ref.anchor_id ? { anchor_id: ref.anchor_id } : {}),
    ...(extras && extras.length > 0 ? { extra_anchors: extras } : {}),
  };
}

export const BlockRefSchema = z
  .object({
    unit_id: Hex32Schema,
    anchor_id: z.string().optional(),
    extra_anchors: z.array(z.string()).optional(),
    diff_status: DiffStatusSchema.optional(),
    moved_from: z.string().optional(),
    prev_unit_id: Hex32Schema.optional(),
  })
  .strict();
export type BlockRef = z.infer<typeof BlockRefSchema>;

export const SectionNodeSchema = z
  .object({
    id: z.string(),
    level: z.number().int().min(0).max(6),
    sectnum: z.string().nullable(),
    title: z.string(),
    heading_unit_id: Hex32Schema.optional(),
    heading_anchor_id: z.string().optional(),
    heading_extra_anchors: z.array(z.string()).optional(),
    heading_diff_status: DiffStatusSchema.optional(),
    heading_moved_from: z.string().optional(),
    heading_prev_unit_id: Hex32Schema.optional(),
    blocks: z.array(BlockRefSchema),
  })
  .strict();
export type SectionNode = z.infer<typeof SectionNodeSchema>;

export const ChapterNodeSchema = z
  .object({
    id: z.string(),
    sectname: z.string(),
    sectnum: z.string().nullable(),
    title_en: z.string(),
    title_unit_id: Hex32Schema.optional(),
    source_path: z.string(),
    sections: z.array(SectionNodeSchema),
  })
  .strict();
export type ChapterNode = z.infer<typeof ChapterNodeSchema>;

export const VolumeIdSchema = z.enum(["unpriv", "priv", "profiles", "debug"]);
export type VolumeId = z.infer<typeof VolumeIdSchema>;

export const VolumeNodeSchema = z
  .object({
    id: VolumeIdSchema,
    title_en: z.string(),
    title_unit_id: Hex32Schema.optional(),
    title_prev_unit_id: Hex32Schema.optional(),
    entry_file: z.string(),
    chapters: z.array(ChapterNodeSchema),
  })
  .strict();
export type VolumeNode = z.infer<typeof VolumeNodeSchema>;

export const DiffSummarySchema = z.object({
  added: z.number().int().nonnegative(),
  modified: z.number().int().nonnegative(),
  moved: z.number().int().nonnegative(),
  deleted: z.number().int().nonnegative(),
  touched_chapters: z.array(z.string()),
});
export type DiffSummary = z.infer<typeof DiffSummarySchema>;

export const DeletedBlockRefSchema = z.object({
  chapter_key: z.string(),
  section_id: z.string(),
  after_unit_id: z.string().nullable(),
  unit_id: Hex32Schema,
});
export type DeletedBlockRef = z.infer<typeof DeletedBlockRefSchema>;

export const ManifestSectionNodeSchema = z
  .object({
    id: z.string(),
    level: z.number().int().min(0).max(6),
    sectnum: z.string().nullable(),
    title: z.string(),
    heading_unit_id: Hex32Schema.optional(),
    heading_anchor_id: z.string().optional(),
    heading_extra_anchors: z.array(z.string().min(1)).min(1).optional(),
    blocks: z.array(BlockEntrySchema),
  })
  .strict();
export type ManifestSectionNode = z.infer<typeof ManifestSectionNodeSchema>;

export const ChapterManifestSchema = z
  .object({
    chap_hash: Hex16Schema,
    id: z.string(),
    sectname: z.string(),
    sectnum: z.string().nullable(),
    title_en: z.string(),
    title_unit_id: Hex32Schema.optional(),
    source_path: z.string(),
    sections: z.array(ManifestSectionNodeSchema),
  })
  .strict();
export type ChapterManifest = z.infer<typeof ChapterManifestSchema>;

export const SnapshotChapterRefSchema = z
  .object({
    id: z.string(),
    chap_hash: Hex16Schema,
  })
  .strict();
export type SnapshotChapterRef = z.infer<typeof SnapshotChapterRefSchema>;

export const SnapshotVolumeSchema = z
  .object({
    id: VolumeIdSchema,
    title_en: z.string(),
    title_unit_id: Hex32Schema.optional(),
    title_prev_unit_id: Hex32Schema.optional(),
    entry_file: z.string(),
    chapters: z.array(SnapshotChapterRefSchema),
  })
  .strict();
export type SnapshotVolume = z.infer<typeof SnapshotVolumeSchema>;

export const SnapshotSlotChangeSchema = z
  .object({
    chapter_key: z.string(),
    section_id: z.string(),
    slot: z.union([z.literal("heading"), z.number().int().nonnegative()]),
    unit_id: Hex32Schema,
    status: DiffStatusSchema,
    moved_from: z.string().optional(),
    prev_unit_id: Hex32Schema.optional(),
  })
  .strict();
export type SnapshotSlotChange = z.infer<typeof SnapshotSlotChangeSchema>;

export const SnapshotManifestSchema = z
  .object({
    sha: z.string(),
    parent_sha: z.string().nullable(),
    is_baseline: z.boolean(),
    date: z.string(),
    title: z.string(),
    ratified_tag: z.string().nullable(),
    draft_tags: z.array(z.string()),
    diff: DiffSummarySchema,
    changes: z.array(SnapshotSlotChangeSchema),
    deleted_blocks: z.array(DeletedBlockRefSchema),
    volumes: z.array(SnapshotVolumeSchema),
  })
  .strict();
export type SnapshotManifest = z.infer<typeof SnapshotManifestSchema>;

export const CommitIndexEntrySchema = z.object({
  sha: z.string(),
  parent_sha: z.string().nullable(),
  is_baseline: z.boolean(),
  date: z.string(),
  title: z.string(),
  ratified_tag: z.string().nullable(),
  draft_tags: z.array(z.string()),
  diff: DiffSummarySchema,
});
export type CommitIndexEntry = z.infer<typeof CommitIndexEntrySchema>;

export const ManifestIndexSchema = z.object({
  upstream_repo: z.string(),
  baseline_cutoff: z.string(),
  last_synced_sha: z.string().nullable(),
  known_tags: z.record(z.string(), z.string()),
  commits: z.array(CommitIndexEntrySchema),
});
export type ManifestIndex = z.infer<typeof ManifestIndexSchema>;

export const SiteChapterEntrySchema = z.object({
  id: z.string(),
  sectname: z.string(),
  sectnum: z.string().nullable(),
  title_en: z.string(),
  title_zh: z.string(),
  struct_hash: z.string(),
  pack_hash: z.string(),
  changed_blocks: z.number().int().positive().optional(),
});
export type SiteChapterEntry = z.infer<typeof SiteChapterEntrySchema>;

export const SiteVolumeSchema = z.object({
  id: VolumeIdSchema,
  title_en: z.string(),
  title_zh: z.string(),
  chapters: z.array(SiteChapterEntrySchema),
});
export type SiteVolume = z.infer<typeof SiteVolumeSchema>;

export const SiteTreeSchema = z.object({
  tree_hash: z.string(),
  volumes: z.array(SiteVolumeSchema),
});
export type SiteTree = z.infer<typeof SiteTreeSchema>;

export const SiteSnapshotSchema = z.object({
  sha: z.string(),
  parent_sha: z.string().nullable(),
  is_baseline: z.boolean(),
  date: z.string(),
  title: z.string(),
  ratified_tag: z.string().nullable(),
  draft_tags: z.array(z.string()),
  diff: DiffSummarySchema,
  approval_ratio: z.number().min(0).max(1),
  tree_hash: z.string(),
});
export type SiteSnapshot = z.infer<typeof SiteSnapshotSchema>;

export const SiteIndexSchema = z.object({
  generated_at: z.string(),
  data_repo_url: z.string(),
  upstream_repo_url: z.string(),
  glossary_markdown: z.string(),
  default_sha: z.string(),
  default_tree_hash: z.string(),
  default_volumes: z.array(SiteVolumeSchema),
  snapshots: z.array(SiteSnapshotSchema),
});
export type SiteIndex = z.infer<typeof SiteIndexSchema>;

export const SiteSectionNodeSchema = z
  .object({
    id: z.string(),
    level: z.number().int().min(0).max(6),
    sectnum: z.string().nullable(),
    title_en: z.string(),
    title_zh: z.string(),
    heading_unit_id: Hex32Schema.optional(),
    heading_anchor_id: z.string().optional(),
    heading_extra_anchors: z.array(z.string().min(1)).min(1).optional(),
    blocks: z.array(BlockEntrySchema),
  })
  .strict();
export type SiteSectionNode = z.infer<typeof SiteSectionNodeSchema>;

export const UnitHtmlOverrideSchema = z.object({
  en_html: z.string(),
  zh_html: z.string().optional(),
});
export type UnitHtmlOverride = z.infer<typeof UnitHtmlOverrideSchema>;

export const ChapterStructureSchema = z.object({
  struct_hash: z.string(),
  volume_id: VolumeIdSchema,
  chapter_id: z.string(),
  sectname: z.string(),
  sectnum: z.string().nullable(),
  title_en: z.string(),
  title_zh: z.string(),
  title_unit_id: Hex32Schema.optional(),
  sections: z.array(SiteSectionNodeSchema),
  unit_overrides: z.record(Hex32Schema, UnitHtmlOverrideSchema).optional(),
});
export type ChapterStructure = z.infer<typeof ChapterStructureSchema>;

export const RenderedUnitSchema = z.object({
  unit_id: Hex32Schema,
  kind: BlockKindSchema,
  translatable: z.boolean(),
  status: TranslationStatusSchema.optional(),
  prev_unit_id: Hex32Schema.optional(),
  en_html: z.string(),
  zh_html: z.string().optional(),
});
export type RenderedUnit = z.infer<typeof RenderedUnitSchema>;

export const ChapterUnitPackSchema = z.object({
  pack_hash: z.string(),
  volume_id: VolumeIdSchema,
  chapter_id: z.string(),
  units: z.record(Hex32Schema, RenderedUnitSchema),
});
export type ChapterUnitPack = z.infer<typeof ChapterUnitPackSchema>;

export const AnchorTargetSchema = z.object({
  volume_id: VolumeIdSchema,
  chapter_id: z.string(),
  section_id: z.string().optional(),
  anchor_id: z.string(),
});
export type AnchorTarget = z.infer<typeof AnchorTargetSchema>;

export const AnchorIndexSchema = z.object({
  anchors: z.record(z.string(), AnchorTargetSchema),
});
export type AnchorIndex = z.infer<typeof AnchorIndexSchema>;

export const UpstreamChangeKindSchema = z.enum([
  "baseline",
  "added",
  "modified",
  "moved",
]);
export type UpstreamChangeKind = z.infer<typeof UpstreamChangeKindSchema>;

export const UnitUpstreamRefSchema = z.object({
  sha: z.string(),
  date: z.string(),
  title: z.string(),
  ratified_tag: z.string().nullable(),
  change_kind: UpstreamChangeKindSchema,
  unit_id: Hex32Schema,
  prev_unit_id: Hex32Schema.optional(),
  moved_from: z.string().optional(),
});
export type UnitUpstreamRef = z.infer<typeof UnitUpstreamRefSchema>;

export const UnitRevisionEntrySchema = z.object({
  commit_sha: z.string(),
  date: z.string(),
  author: z.string(),
  message: z.string(),
  status: TranslationStatusSchema,
  zh: z.string(),
});
export type UnitRevisionEntry = z.infer<typeof UnitRevisionEntrySchema>;

export const UnitMetaSchema = z.object({
  unit_id: Hex32Schema,
  kind: BlockKindSchema,
  translatable: z.boolean(),
  status: TranslationStatusSchema.optional(),
  en_raw: z.string(),
  zh_raw: z.string().optional(),
  origin_hint: z.string().optional(),
  prev_unit_id: Hex32Schema.optional(),
  upstream_history: z.array(UnitUpstreamRefSchema),
  revisions: z.array(UnitRevisionEntrySchema),
});
export type UnitMeta = z.infer<typeof UnitMetaSchema>;

export const UnitMetaShardSchema = z.record(Hex32Schema, UnitMetaSchema);
export type UnitMetaShard = z.infer<typeof UnitMetaShardSchema>;

export const SearchEntrySchema = z.object({
  unit_id: z.string(),
  volume_id: VolumeIdSchema,
  chapter_id: z.string(),
  section_id: z.string(),
  chapter_title: z.string(),
  chapter_title_zh: z.string().optional(),
  section_title: z.string().optional(),
  section_title_zh: z.string().optional(),
  kind: BlockKindSchema.optional(),
  en: z.string(),
  zh: z.string(),
  symbols: z.array(z.string()).optional(),
  anchor_id: z.string().optional(),
  extra_anchors: z.array(z.string()).optional(),
});
export type SearchEntry = z.infer<typeof SearchEntrySchema>;

export const SearchIndexSchema = z.array(SearchEntrySchema);
export type SearchIndex = z.infer<typeof SearchIndexSchema>;
