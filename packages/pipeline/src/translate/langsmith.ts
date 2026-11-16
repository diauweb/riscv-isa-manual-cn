import { AgentAddress, Client, RunTree } from "langsmith";
import { isTruthyEnv } from "../config.ts";
import { vlog } from "../log.ts";

export interface LangSmithConfig {
  apiKey: string;
  endpoint: string;
  project?: string;
  agentId?: string;
  agentEnvironment?: string;
  workspaceId?: string;
}

export interface LlmRunInput {
  system: string;
  messages: ReadonlyArray<{ role: "user" | "assistant"; content: string }>;
  provider: string;
  modelId: string;
  baseUrl?: string;
  attempt: number;
  maxAttempts: number;
  chapterTitle: string;
}

export interface LlmRunSuccess {
  text: string;
  finishReason?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  responseId?: string;
  responseModelId?: string;
}

type FetchFn = typeof fetch;
let activeFetch: FetchFn | undefined;
let warnedMissingKey = false;

/**
 * Test hook to intercept LangSmith HTTP requests in unit tests.
 */
export function setLangSmithFetchForTest(fn?: FetchFn): void {
  activeFetch = fn;
  warnedMissingKey = false;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Resolves LangSmith configuration from environment variables (supporting both
 * `LANGSMITH_*` and legacy `LANGCHAIN_*` aliases). Returns `null` when tracing
 * is disabled or misconfigured without an API key.
 */
export function resolveLangSmithConfig(
  env: Record<string, string | undefined> = process.env,
): LangSmithConfig | null {
  const tracingRaw =
    nonEmpty(env.LANGSMITH_TRACING) ??
    nonEmpty(env.LANGCHAIN_TRACING_V2) ??
    nonEmpty(env.LANGCHAIN_TRACING);
  if (!isTruthyEnv(tracingRaw)) {
    return null;
  }

  const apiKey = nonEmpty(env.LANGSMITH_API_KEY) ?? nonEmpty(env.LANGCHAIN_API_KEY);
  if (!apiKey) {
    if (!warnedMissingKey) {
      warnedMissingKey = true;
      vlog(1, "LangSmith tracing is enabled but LANGSMITH_API_KEY is not set; skipping traces.");
    }
    return null;
  }

  const endpoint = (
    nonEmpty(env.LANGSMITH_ENDPOINT) ??
    nonEmpty(env.LANGCHAIN_ENDPOINT) ??
    "https://api.smith.langchain.com"
  ).replace(/\/+$/, "");

  const agentId = nonEmpty(env.LANGSMITH_AGENT_ID);
  const agentEnvironment = nonEmpty(env.LANGSMITH_AGENT_ENVIRONMENT);
  const explicitProject = nonEmpty(env.LANGSMITH_PROJECT) ?? nonEmpty(env.LANGCHAIN_PROJECT);
  const project = explicitProject ?? (agentId ? undefined : "default");

  const workspaceId = nonEmpty(env.LANGSMITH_WORKSPACE_ID);

  return {
    apiKey,
    endpoint,
    ...(project ? { project } : {}),
    ...(agentId ? { agentId } : {}),
    ...(agentEnvironment ? { agentEnvironment } : {}),
    ...(workspaceId ? { workspaceId } : {}),
  };
}

export interface LlmRunTracker {
  finish(result: LlmRunSuccess): void;
  fail(err: unknown): void;
}

/**
 * Collects a parent `chain` RunTree and child `llm` RunTrees for one
 * `translateChapterBatch` invocation and flushes them via the official `langsmith` SDK.
 */
export class LangSmithBatchTrace {
  private readonly config: LangSmithConfig;
  private readonly client: Client;
  private readonly chainRun: RunTree;
  private readonly llmRuns: RunTree[] = [];
  private readonly validationRetries: Array<{ attempt: number; errors: Record<string, string[]> }> =
    [];
  private closed = false;

  constructor(
    config: LangSmithConfig,
    meta: {
      chapterTitle: string;
      provider: string;
      modelId: string;
      baseUrl?: string;
      targetUnitIds: string[];
      contextBlockCount: number;
    },
  ) {
    this.config = config;
    this.client = new Client({
      apiKey: config.apiKey,
      apiUrl: config.endpoint,
      autoBatchTracing: false,
      timeout_ms: 5000,
      callerOptions: { maxRetries: activeFetch ? 0 : 2 },
      ...(config.workspaceId ? { workspaceId: config.workspaceId } : {}),
      ...(activeFetch ? { fetchImplementation: activeFetch } : {}),
    });

    const address =
      config.agentId && config.agentEnvironment
        ? new AgentAddress(config.agentId, config.agentEnvironment)
        : undefined;

    this.chainRun = new RunTree({
      name: "translateChapterBatch",
      run_type: "chain",
      ...(address ? { address } : { project_name: config.project ?? "default" }),
      client: this.client,
      inputs: {
        chapterTitle: meta.chapterTitle,
        targetUnitIds: meta.targetUnitIds,
        targetCount: meta.targetUnitIds.length,
        contextBlockCount: meta.contextBlockCount,
      },
      extra: {
        metadata: {
          ls_provider: meta.provider,
          ls_model_name: meta.modelId,
          ...(meta.baseUrl ? { base_url: meta.baseUrl } : {}),
        },
      },
    });
  }

  startLlmRun(input: LlmRunInput): LlmRunTracker {
    const llmRun = this.chainRun.createChild({
      name: "generateText",
      run_type: "llm",
      inputs: {
        messages: [
          { role: "system", content: input.system },
          ...input.messages.map((m) => ({ role: m.role, content: m.content })),
        ],
      },
      extra: {
        invocation_params: {
          model: input.modelId,
          provider: input.provider,
          ...(input.baseUrl ? { base_url: input.baseUrl } : {}),
        },
        metadata: {
          ls_provider: input.provider,
          ls_model_type: "chat",
          ls_model_name: input.modelId,
          attempt: input.attempt,
          max_attempts: input.maxAttempts,
          chapter_title: input.chapterTitle,
        },
      },
    });
    this.llmRuns.push(llmRun);

    return {
      finish: (result: LlmRunSuccess) => {
        const usageMetadata = result.usage
          ? {
              input_tokens: result.usage.promptTokens,
              output_tokens: result.usage.completionTokens,
              total_tokens: result.usage.totalTokens,
            }
          : undefined;

        const meta = (llmRun.extra?.metadata ?? {}) as Record<string, unknown>;
        if (usageMetadata) meta.usage_metadata = usageMetadata;
        if (result.responseId) meta.response_id = result.responseId;
        if (result.responseModelId) meta.response_model = result.responseModelId;

        void llmRun.end({
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: result.text,
              },
              finish_reason: result.finishReason ?? "stop",
            },
          ],
          ...(usageMetadata ? { usage_metadata: usageMetadata } : {}),
          ...(usageMetadata
            ? {
                llm_output: {
                  token_usage: {
                    prompt_tokens: result.usage!.promptTokens,
                    completion_tokens: result.usage!.completionTokens,
                    total_tokens: result.usage!.totalTokens,
                  },
                },
              }
            : {}),
        });
      },
      fail: (err: unknown) => {
        void llmRun.end(undefined, err instanceof Error ? err.message : String(err));
      },
    };
  }

  recordValidationRetry(attempt: number, errorsByUnit: Map<string, string[]>): void {
    if (errorsByUnit.size === 0) return;
    this.validationRetries.push({
      attempt,
      errors: Object.fromEntries(errorsByUnit),
    });
  }

  async finish(outputs: Record<string, unknown>): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.flush({ outputs });
  }

  async fail(err: unknown): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.flush({
      error: err instanceof Error ? err.message : String(err),
    });
  }

  private async flush(outcome: {
    outputs?: Record<string, unknown>;
    error?: string;
  }): Promise<void> {
    const meta = (this.chainRun.extra?.metadata ?? {}) as Record<string, unknown>;
    meta.llm_attempts = this.llmRuns.length;
    if (this.validationRetries.length > 0) {
      meta.validation_retries = this.validationRetries;
    }

    await this.chainRun.end(outcome.outputs, outcome.error);

    try {
      await this.chainRun.postRun();
      for (const llmRun of this.llmRuns) {
        await llmRun.postRun();
      }
      const target =
        this.config.agentId && this.config.agentEnvironment
          ? `agent=${this.config.agentId}/${this.config.agentEnvironment}`
          : `project=${this.config.project ?? "default"}`;
      vlog(
        2,
        `langsmith trace uploaded (${this.llmRuns.length} llm run(s), ${target}, trace_id=${this.chainRun.trace_id})`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      vlog(1, `LangSmith trace upload error: ${msg}`);
    }
  }
}
