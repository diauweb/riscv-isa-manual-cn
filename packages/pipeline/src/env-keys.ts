// Side-effect-free so the test preload can import it before config.ts snapshots INITIAL_ENV.

/**
 * Every non-secret environment key the config loader understands (plus CI markers).
 * Hermetic contexts (unit tests, the `check` e2e rehearsal) clear these.
 */
export const DEFAULT_AI_MAX_INPUT_TOKENS = 272_000;
export const DEFAULT_AI_MAX_OUTPUT_TOKENS = 728_000;
export const DEFAULT_AI_CONCURRENCY = 1;
export const REASONING_EFFORT_VALUES = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;
export type ReasoningEffort = (typeof REASONING_EFFORT_VALUES)[number];

export const CONFIG_ENV_KEYS = [
  "CI",
  "GITHUB_ACTIONS",
  "GITHUB_OUTPUT",
  "GITHUB_REPOSITORY_OWNER",
  "DOTENV",
  "ENV_FILE",
  "WORK_DIR",
  "UPSTREAM_REPO",
  "UPSTREAM_CACHE",
  "UPSTREAM_REPO_URL",
  "DATA_DIR",
  "DATA_REMOTE",
  "DATA_REPO",
  "DATA_REPO_URL",
  "SITE_OUT_DIR",
  "DIST_DIR",
  "PUBLISH",
  "AI_PROVIDER",
  "AI_MODEL",
  "AI_BASE_URL",
  "DEEPSEEK_BASE_URL",
  "GOOGLE_GENERATIVE_AI_BASE_URL",
  "OPENAI_BASE_URL",
  "ANTHROPIC_BASE_URL",
  "AI_REASONING_EFFORT",
  "AI_CONCURRENCY",
  "AI_MAX_INPUT_TOKENS",
  "AI_MAX_OUTPUT_TOKENS",
  "LANGSMITH_TRACING",
  "LANGSMITH_ENDPOINT",
  "LANGSMITH_PROJECT",
  "LANGSMITH_AGENT_ID",
  "LANGSMITH_AGENT_ENVIRONMENT",
  "LANGSMITH_WORKSPACE_ID",
  "LANGCHAIN_TRACING_V2",
  "LANGCHAIN_TRACING",
  "LANGCHAIN_ENDPOINT",
  "LANGCHAIN_PROJECT",
  "BASELINE_DATE",
  "SYNC_MAX_MINUTES",
  "SYNC_MAX_BATCHES",
  "SYNC_COMMIT",
  "SYNC_FAIL_FAST",
  "VIEWER_BASE_PATH",
  "VIEWER_PORT",
  "VITE_DATA_URL",
  "JOBS",
  "VERBOSE",
  "DEBUG",
] as const;
