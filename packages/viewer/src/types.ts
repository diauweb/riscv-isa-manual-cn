import type {
  AnchorIndex,
  AnchorTarget,
  BlockEntry,
  BlockKind,
  ChapterStructure,
  ChapterUnitPack,
  DiffStatus,
  NormalizedBlockAnchor,
  RenderedUnit,
  SearchEntry,
  SiteChapterEntry,
  SiteIndex,
  SiteSectionNode,
  SiteSnapshot,
  SiteTree,
  SiteVolume,
  TranslationStatus,
  UnitHtmlOverride,
  UnitMeta,
  UnitMetaShard,
  UnitRevisionEntry,
  UnitUpstreamRef,
  VolumeId,
} from "@riscv-cn/schema";
export { blockEntryUnitId, normalizeBlockEntry } from "@riscv-cn/schema";

export type {
  AnchorIndex,
  AnchorTarget,
  BlockEntry,
  BlockKind,
  ChapterStructure,
  ChapterUnitPack,
  DiffStatus,
  NormalizedBlockAnchor,
  RenderedUnit,
  SearchEntry,
  SiteChapterEntry,
  SiteIndex,
  SiteSectionNode,
  SiteSnapshot,
  SiteTree,
  SiteVolume,
  TranslationStatus,
  UnitHtmlOverride,
  UnitMeta,
  UnitMetaShard,
  UnitRevisionEntry,
  UnitUpstreamRef,
  VolumeId,
};

export type SiteChapter = SiteChapterEntry;

export interface ResolvedChapter {
  struct_hash: string;
  pack_hash: string;
  volume_id: VolumeId;
  chapter_id: string;
  sectname: string;
  sectnum: string | null;
  title_en: string;
  title_zh: string;
  title_unit_id?: string;
  sections: SiteSectionNode[];
  units: Record<string, RenderedUnit>;
}

export type CompareChangeKind = "unchanged" | "added" | "modified" | "moved" | "deleted";

export interface CompareRow {
  rowKey: string;
  sectionId: string;
  sectionTitleEn: string;
  sectionTitleZh: string;
  sectionLevel: number;
  sectionSectnum: string | null;
  opensSection?: boolean;
  changeKind: CompareChangeKind;
  unitId: string;
  baseBlock?: RenderedUnit;
  targetBlock?: RenderedUnit;
  baseRef?: NormalizedBlockAnchor;
  targetRef?: NormalizedBlockAnchor;
  anchorId?: string;
  extraAnchors?: string[];
  movedFromSection?: string;
}
