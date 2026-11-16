import React, { useMemo } from "react";
import { computeTextWordDiff } from "../utils/diff";

/** Inline track-changes view of two plain-text versions. */
export const WordDiff: React.FC<{
  before: string;
  after: string;
  lang?: string;
  className?: string;
}> = ({ before, after, lang, className }) => {
  const parts = useMemo(
    () => computeTextWordDiff(before, after),
    [before, after],
  );
  return (
    <div lang={lang} className={`word-diff ${className ?? ""}`}>
      {parts.map((part, i) =>
        part.added ? (
          <ins key={i}>{part.value}</ins>
        ) : part.removed ? (
          <del key={i}>{part.value}</del>
        ) : (
          <React.Fragment key={i}>{part.value}</React.Fragment>
        ),
      )}
    </div>
  );
};
