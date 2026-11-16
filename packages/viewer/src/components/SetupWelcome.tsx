import React from "react";
import { Play } from "lucide-react";
import { RiscvLogo } from "./ui";

interface SetupWelcomeProps {
  onLoadDemo: () => void;
  errorMessage?: string | null;
}

export const SetupWelcome: React.FC<SetupWelcomeProps> = ({ onLoadDemo, errorMessage }) => (
  <div className="flex min-h-dvh items-center justify-center px-4 py-10">
    <div className="w-full max-w-xl space-y-5">
      <div className="flex items-center gap-3">
        <RiscvLogo className="h-9 w-9" />
        <h1 className="text-lg font-semibold tracking-tight sm:text-xl">RISC-V 指令集手册</h1>
      </div>

      <div className="rounded-xl bg-[var(--mod-bg)] px-4 py-3 text-sm">
        <p className="font-medium text-[var(--fg)]">
          未找到 <code className="font-mono text-[13px]">./data/index.json</code>
        </p>
        {errorMessage && (
          <p className="mt-1 font-mono text-xs break-all text-[var(--fg-muted)]">{errorMessage}</p>
        )}
      </div>

      <pre className="overflow-x-auto rounded-xl border border-[var(--line)] bg-[var(--bg-code)] p-3.5 font-mono text-[12px] leading-relaxed text-[var(--fg)] sm:p-4 sm:text-[12.5px]">
{`# Offline fixture + mock translator
bun run dev --upstream fixture --provider mock

# Build static artifact
bun run job:deploy && bun run preview`}
      </pre>

      <div className="pt-1">
        <button
          type="button"
          onClick={onLoadDemo}
          className="inline-flex min-h-10 w-full cursor-pointer items-center justify-center gap-2 rounded-lg bg-[var(--accent)] px-4 py-2.5 text-sm font-medium text-white transition-opacity hover:opacity-90 sm:w-auto sm:py-2 dark:text-[#141519]"
        >
          <Play className="h-4 w-4" /> 加载演示数据
        </button>
      </div>
    </div>
  </div>
);
