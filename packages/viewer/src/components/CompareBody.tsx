import React, { useMemo, useState } from "react";
import { ArrowRightLeft, Minus, PenLine, Plus } from "lucide-react";
import type { CompareRow, RenderedUnit } from "../types";
import type { ReaderSettings } from "../lib/settings";
import { stripHtmlToText } from "../utils/diff";
import { DocBlock, prepareBlockHtml } from "./DocBlock";
import { WordDiff } from "./WordDiff";
import { cx } from "./ui";

interface CompareBodyProps {
  rows: CompareRow[];
  settings: ReaderSettings;
  changesOnly: boolean;
  activeRowKey: string | null;
  skipUnitId?: string;
  makePermalink: (at: string) => string;
  onInspect: (unitId: string) => void;
  onCopyLink: (href: string) => void;
}

type Item =
  | { type: "row"; row: CompareRow }
  | { type: "fold"; key: string; rows: CompareRow[] };

/** Fold runs of unchanged rows, keeping the heading that introduces each change. */
function buildItems(rows: CompareRow[], changesOnly: boolean): Item[] {
  if (!changesOnly) return rows.map((row) => ({ type: "row", row }));
  const visible = rows.map((r) => r.changeKind !== "unchanged");
  rows.forEach((r, i) => {
    if (r.changeKind === "unchanged") return;
    for (let j = i - 1; j >= 0; j--) {
      const b = rows[j].targetBlock ?? rows[j].baseBlock;
      if (b?.kind === "heading") {
        visible[j] = true;
        break;
      }
    }
  });
  const items: Item[] = [];
  let run: CompareRow[] = [];
  const flush = () => {
    if (run.length) items.push({ type: "fold", key: run[0].rowKey, rows: run });
    run = [];
  };
  rows.forEach((row, i) => {
    if (visible[i]) {
      flush();
      items.push({ type: "row", row });
    } else run.push(row);
  });
  flush();
  return items;
}

const VISUAL_KINDS = new Set(["diagram", "math"]);

const RenderedPair: React.FC<{ base: RenderedUnit; target: RenderedUnit }> = ({
  base,
  target,
}) => (
  <div className="grid gap-3 sm:grid-cols-2">
    {(
      [
        ["旧版", base, "cmp-base"],
        ["新版", target, "cmp-target"],
      ] as const
    ).map(([label, b, scope]) => (
      <div key={label} className="min-w-0">
        <div className="mb-1 text-[11px] font-medium text-[var(--fg-faint)]">
          {label}
        </div>
        <div
          className="doc-prose doc-scroll-x"
          dangerouslySetInnerHTML={{
            __html: prepareBlockHtml(b.en_html || (b.zh_html ?? ""), `${b.unit_id.slice(0, 8)}-${scope}`),
          }}
        />
      </div>
    ))}
  </div>
);

const CompareRowView: React.FC<{
  row: CompareRow;
  props: CompareBodyProps;
}> = ({ row, props }) => {
  const [showRendered, setShowRendered] = useState(false);
  const { settings } = props;
  const block = row.targetBlock ?? row.baseBlock;
  if (!block) return null;
  const ref = row.targetRef ?? row.baseRef;
  const anchorId = row.anchorId ?? ref?.anchor_id;
  const extraAnchors = row.extraAnchors ?? ref?.extra_anchors;
  const sectionId =
    block.kind === "heading" && row.changeKind !== "deleted"
      ? row.sectionId
      : undefined;
  const at = sectionId ?? anchorId ?? `u-${row.unitId.slice(0, 12)}`;

  const common = {
    unitId: row.unitId,
    level: row.sectionLevel,
    anchorId,
    extraAnchors,
    sectionId,
    sectnum: row.opensSection ? row.sectionSectnum : null,
    lang: settings.lang,
    tapToReveal: settings.tapToReveal,
    showAnchors: settings.showAnchors,
    permalink: props.makePermalink(at),
    onInspect: props.onInspect,
    onCopyLink: props.onCopyLink,
    domId: `row-${row.rowKey}`,
  };

  const active = props.activeRowKey === row.rowKey;

  if (row.changeKind === "unchanged") {
    return <DocBlock {...common} block={block} />;
  }

  let label: React.ReactNode;
  let zhOverride: React.ReactNode | undefined;
  let enOverride: React.ReactNode | undefined;

  switch (row.changeKind) {
    case "added":
      label = (
        <div className="chg-label">
          <Plus className="h-3 w-3" /> 新增
        </div>
      );
      break;
    case "deleted":
      label = (
        <div className="chg-label">
          <Minus className="h-3 w-3" /> 已删除
        </div>
      );
      break;
    case "moved":
      label = (
        <div className="chg-label">
          <ArrowRightLeft className="h-3 w-3" /> 移动
          {row.movedFromSection && (
            <span className="font-normal text-[var(--fg-faint)]">
              自「{row.movedFromSection}」
            </span>
          )}
        </div>
      );
      break;
    case "modified": {
      const base = row.baseBlock;
      const target = row.targetBlock;
      label = (
        <div className="chg-label">
          <PenLine className="h-3 w-3" /> 修改
          {base && target && !VISUAL_KINDS.has(block.kind) && (
            <button
              type="button"
              onClick={() => setShowRendered((v) => !v)}
              className="ml-1 cursor-pointer font-normal text-[var(--fg-faint)] underline-offset-2 hover:text-[var(--accent-fg)] hover:underline"
            >
              {showRendered ? "显示差异" : "显示新版排版"}
            </button>
          )}
        </div>
      );
      if (base && target && !showRendered) {
        if (VISUAL_KINDS.has(block.kind)) {
          enOverride = <RenderedPair base={base} target={target} />;
        } else {
          const baseZh = stripHtmlToText(base.zh_html ?? "");
          const targetZh = stripHtmlToText(target.zh_html ?? "");
          if (baseZh || targetZh) {
            zhOverride = (
              <WordDiff
                lang="zh-CN"
                className="doc-prose"
                before={baseZh}
                after={targetZh}
              />
            );
          }
          enOverride = (
            <WordDiff
              lang="en"
              className="doc-prose"
              before={stripHtmlToText(base.en_html)}
              after={stripHtmlToText(target.en_html)}
            />
          );
        }
      }
      break;
    }
  }

  return (
    <DocBlock
      {...common}
      block={block}
      label={label}
      zhOverride={zhOverride}
      enOverride={enOverride}
      className={cx("chg", `chg-${row.changeKind}`, active && "chg-active")}
    />
  );
};

export const CompareBody: React.FC<CompareBodyProps> = (props) => {
  const { rows, changesOnly, skipUnitId } = props;
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const items = useMemo(() => buildItems(rows, changesOnly), [rows, changesOnly]);

  if (rows.length === 0) {
    return (
      <p className="py-16 text-center text-sm text-[var(--fg-faint)]">
        两个版本中都没有本章内容。
      </p>
    );
  }

  const hasChanges = rows.some((r) => r.changeKind !== "unchanged");

  return (
    <div className="doc-body">
      {!hasChanges && (
        <div className="mb-8 rounded-lg bg-[var(--bg-subtle)] px-4 py-3 text-sm text-[var(--fg-muted)]">
          两个版本之间，本章内容没有变化。
        </div>
      )}
      {items.map((item) => {
        if (item.type === "row") {
          if (item.row.unitId === skipUnitId && item.row.changeKind === "unchanged") {
            return null;
          }
          return <CompareRowView key={item.row.rowKey} row={item.row} props={props} />;
        }
        if (expanded.has(item.key)) {
          return item.rows.map((row) =>
            row.unitId === skipUnitId ? null : (
              <CompareRowView key={row.rowKey} row={row} props={props} />
            ),
          );
        }
        return (
          <div key={`fold-${item.key}`} className="doc-fold">
            <button
              type="button"
              onClick={() =>
                setExpanded((s) => new Set(s).add(item.key))
              }
            >
              展开 {item.rows.length} 段未变更内容
            </button>
          </div>
        );
      })}
    </div>
  );
};
