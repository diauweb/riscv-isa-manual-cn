import { useCallback, useEffect, useState } from "react";

/** How the bilingual text is laid out. */
export type ReadingLang = "zh" | "parallel" | "interleave" | "en";
export type FontSize = "sm" | "md" | "lg";
export type Theme = "system" | "light" | "dark";

export interface ReaderSettings {
  lang: ReadingLang;
  fontSize: FontSize;
  theme: Theme;
  /** Mark machine-translated / unreviewed paragraphs in the margin. */
  showStatus: boolean;
  /** Show normative anchor ids next to blocks. */
  showAnchors: boolean;
  /** In single-language mode, clicking a paragraph reveals the other language. */
  tapToReveal: boolean;
}

const DEFAULTS: ReaderSettings = {
  lang: "zh",
  fontSize: "md",
  theme: "system",
  showStatus: true,
  showAnchors: false,
  tapToReveal: true,
};

const KEY = "riscv-cn:reader-settings:v1";

function load(): ReaderSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULTS;
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<ReaderSettings>) };
  } catch {
    return DEFAULTS;
  }
}

export function useReaderSettings() {
  const [settings, setSettings] = useState<ReaderSettings>(load);

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(settings));
    } catch {
      // storage unavailable (private mode); settings stay in memory
    }
  }, [settings]);

  // Theme: explicit choice or follow the OS.
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark =
        settings.theme === "dark" ||
        (settings.theme === "system" && mq.matches);
      document.documentElement.classList.toggle("dark", dark);
      document.documentElement.style.colorScheme = dark ? "dark" : "light";
      document
        .querySelector('meta[name="theme-color"]')
        ?.setAttribute("content", dark ? "#141519" : "#fbfbfa");
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [settings.theme]);

  useEffect(() => {
    document.documentElement.dataset.fontSize = settings.fontSize;
  }, [settings.fontSize]);

  const update = useCallback(
    <K extends keyof ReaderSettings>(key: K, value: ReaderSettings[K]) =>
      setSettings((s) => ({ ...s, [key]: value })),
    [],
  );

  return { settings, update };
}
