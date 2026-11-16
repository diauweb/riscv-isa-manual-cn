import React, { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useBodyScrollLock, useMediaQuery } from "../lib/scroll";

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/**
 * Official RISC-V square mark with rounded corners (`rx = 80` in `574.461`, ~14%):
 * - Matches `y = 80.949` where the top-left white opening meets the navy stem,
 *   avoiding acute corner slivers.
 * - White backing is chamfered away from the three colored corners so dark mode
 *   never exhibits a white anti-aliasing halo, while light mode gets an inset
 *   hairline stroke to keep the white top-left corner crisp against `--bg`.
 */
export const RiscvLogo: React.FC<{ className?: string }> = ({ className }) => {
  const rawId = useId();
  const clipId = `rv-clip-${rawId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return (
    <svg
      viewBox="0 0 574.461 574.461"
      aria-hidden="true"
      className={cx("block shrink-0 select-none", className)}
    >
      <defs>
        <clipPath id={clipId}>
          <rect width="574.461" height="574.461" rx="80" ry="80" />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clipId})`}>
        <path
          d="M -2 -2 H 420 L 577 140 V 350 L 420 577 H 220 L -2 350 Z"
          fill="#ffffff"
        />
        <path
          d="M 321.398 179.68 C 321.398 263.191 270.754 339.078 172.117 356.856 L 311.27 521.317 L 323.859 503.664 L 574.465 149.277 V 0 H 167.051 C 270.754 10.125 321.398 96.133 321.398 179.68 Z"
          fill="#f3ab0d"
        />
        <path
          d="M 392.188 549.121 L 576.926 290.992 V 574.461 H 373.672 Z M 35.461 280.871 H 131.594 C 202.395 280.871 237.883 230.324 237.883 179.68 C 237.883 129 202.395 80.949 131.594 80.949 L 0 80.949 V 574.461 H 245.535 L 35.461 321.395 V 280.871 Z"
          fill="#283272"
        />
        <rect
          x="0"
          y="0"
          width="574.461"
          height="574.461"
          rx="80"
          ry="80"
          fill="none"
          strokeWidth="1.5"
          vectorEffect="non-scaling-stroke"
          className="stroke-black/[0.08] dark:stroke-transparent"
        />
      </g>
    </svg>
  );
};

export const Kbd: React.FC<{ children: React.ReactNode; className?: string }> = ({
  children,
  className,
}) => (
  <kbd
    className={cx(
      "inline-flex min-w-[1.25rem] items-center justify-center rounded border border-[var(--line)] bg-[var(--bg-subtle)] px-1 font-mono text-[10px] leading-4 text-[var(--fg-muted)]",
      className,
    )}
  >
    {children}
  </kbd>
);

/**
 * Click-to-open popover anchored to its trigger on desktop, and presented as a
 * viewport-safe bottom sheet on mobile (`< 640px`).
 */
export const Popover: React.FC<{
  trigger: (props: { open: boolean; toggle: () => void }) => React.ReactNode;
  children: (close: () => void) => React.ReactNode;
  align?: "left" | "right";
  className?: string;
  panelClassName?: string;
  mobileTitle?: string;
  ariaLabel?: string;
}> = ({ trigger, children, align = "left", className, panelClassName, mobileTitle, ariaLabel }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const touchStartY = useRef<number | null>(null);
  const isMobile = useMediaQuery("(max-width: 639px)");

  useBodyScrollLock(open && isMobile);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (ref.current?.contains(target)) return;
      if (sheetRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const close = () => setOpen(false);

  return (
    <div ref={ref} className={cx("relative", className)}>
      {trigger({ open, toggle: () => setOpen((o) => !o) })}
      {open &&
        (isMobile
          ? createPortal(
              <div className="fixed inset-0 z-[58] flex flex-col justify-end sm:hidden">
                <div className="fade-in absolute inset-0 bg-black/30" onClick={close} />
                <div
                  ref={sheetRef}
                  role="dialog"
                  aria-modal="true"
                  aria-label={mobileTitle ?? ariaLabel}
                  className="slide-in-up relative flex max-h-[85dvh] w-full flex-col overflow-hidden rounded-t-2xl border-t border-[var(--line)] bg-[var(--bg-elevated)] pb-[env(safe-area-inset-bottom)] shadow-[var(--shadow-pop)]"
                >
                  <div
                    className="flex shrink-0 items-center justify-between px-4 pt-2.5 pb-1.5 select-none"
                    onTouchStart={(e) => {
                      touchStartY.current = e.touches[0]?.clientY ?? null;
                    }}
                    onTouchEnd={(e) => {
                      const startY = touchStartY.current;
                      touchStartY.current = null;
                      const endY = e.changedTouches[0]?.clientY;
                      if (startY !== null && endY !== undefined && endY - startY > 45) {
                        close();
                      }
                    }}
                  >
                    {mobileTitle ? (
                      <>
                        <span className="text-[14px] font-semibold text-[var(--fg)]">
                          {mobileTitle}
                        </span>
                        <button
                          type="button"
                          onClick={close}
                          aria-label="关闭"
                          className="-mr-1.5 inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg text-[var(--fg-faint)] active:bg-[var(--bg-subtle)]"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </>
                    ) : (
                      <span className="mx-auto h-1 w-9 rounded-full bg-[var(--line-strong)]" />
                    )}
                  </div>
                  <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
                    {children(close)}
                  </div>
                </div>
              </div>,
              document.body,
            )
          : (
              <div
                className={cx(
                  "pop-in absolute top-full z-50 mt-2 max-w-[calc(100vw-1.5rem)] rounded-xl border border-[var(--line)] bg-[var(--bg-elevated)] shadow-[var(--shadow-pop)]",
                  align === "right" ? "right-0" : "left-0",
                  panelClassName,
                )}
              >
                {children(close)}
              </div>
            ))}
    </div>
  );
};

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  className,
}: {
  value: T;
  options: Array<{ value: T; label: React.ReactNode; title?: string }>;
  onChange: (v: T) => void;
  className?: string;
}) {
  return (
    <div
      role="radiogroup"
      className={cx(
        "flex rounded-lg bg-[var(--bg-subtle)] p-0.5 text-[13px]",
        className,
      )}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cx(
            "min-h-8 flex-1 cursor-pointer rounded-md px-2 py-1.5 transition-colors sm:min-h-0 sm:py-1",
            value === o.value
              ? "bg-[var(--bg-elevated)] font-medium text-[var(--fg)] shadow-sm"
              : "text-[var(--fg-muted)] hover:text-[var(--fg)] active:text-[var(--fg)]",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export const Switch: React.FC<{
  checked: boolean;
  onChange: (v: boolean) => void;
  label: React.ReactNode;
  hint?: React.ReactNode;
}> = ({ checked, onChange, label, hint }) => (
  <label
    className={cx(
      "flex cursor-pointer justify-between gap-3 py-2 sm:py-1.5",
      hint ? "items-start" : "items-center",
    )}
  >
    <span className="min-w-0">
      <span className="block text-[13.5px] text-[var(--fg)] sm:text-[13px]">{label}</span>
      {hint && (
        <span className="block text-xs leading-snug text-[var(--fg-faint)]">
          {hint}
        </span>
      )}
    </span>
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cx(
        "relative h-5.5 w-10 shrink-0 cursor-pointer rounded-full transition-colors sm:h-5 sm:w-9",
        Boolean(hint) && "mt-0.5",
        checked ? "bg-[var(--accent)]" : "bg-[var(--line-strong)]",
      )}
    >
      <span
        className={cx(
          "absolute top-0.5 left-0.5 h-4.5 w-4.5 rounded-full bg-white shadow transition-transform sm:h-4 sm:w-4",
          checked && "translate-x-4.5 sm:translate-x-4",
        )}
      />
    </button>
  </label>
);

export const IconButton = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }
>(({ className, active, ...props }, ref) => (
  <button
    ref={ref}
    type="button"
    className={cx(
      "inline-flex h-9 min-w-9 shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-lg px-2 text-[13px] transition-colors sm:h-8 sm:min-w-0",
      active
        ? "bg-[var(--accent-soft)] text-[var(--accent-fg)]"
        : "text-[var(--fg-muted)] hover:bg-[var(--bg-subtle)] hover:text-[var(--fg)] active:bg-[var(--bg-subtle)]",
      className,
    )}
    {...props}
  />
));
IconButton.displayName = "IconButton";

export const Spinner: React.FC<{ label?: string }> = ({ label }) => (
  <div className="flex items-center justify-center gap-3 py-24 text-sm text-[var(--fg-faint)]">
    <span className="h-4 w-4 animate-spin rounded-full border-2 border-[var(--line-strong)] border-t-[var(--accent)]" />
    {label && <span>{label}</span>}
  </div>
);
