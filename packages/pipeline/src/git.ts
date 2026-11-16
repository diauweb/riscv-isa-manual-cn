/** Shared git process helpers for the pipeline (sync, workspace, fixture). */

export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Hide credentials that may appear in `-c http.<url>.extraheader=...` arguments. */
function redact(args: string[]): string[] {
  return args.map((a) => (/extraheader=/i.test(a) ? a.replace(/(basic|bearer)\s+\S+/i, "$1 ***") : a));
}

/**
 * Runs git without ever prompting for credentials (a prompt would hang CI).
 * `env` entries are merged over the current environment.
 */
export function runGit(args: string[], cwd?: string, env: Record<string, string> = {}): GitResult {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env },
  });
  return {
    stdout: proc.stdout.toString("utf8"),
    stderr: proc.stderr.toString("utf8"),
    exitCode: proc.exitCode,
  };
}

export function runGitOrThrow(args: string[], cwd?: string, env: Record<string, string> = {}): string {
  const res = runGit(args, cwd, env);
  if (res.exitCode !== 0) {
    throw new Error(`git ${redact(args).join(" ")} failed (${res.exitCode}): ${res.stderr.trim()}`);
  }
  return res.stdout;
}
