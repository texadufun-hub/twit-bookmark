/**
 * Local-LLM deployment knobs (tex patches). All read from the environment so the
 * service unit / env file is the single source of truth.
 */

function intEnv(name: string, fallback: number, min = 1): number {
  const n = Number.parseInt(process.env[name] ?? '', 10)
  return Number.isFinite(n) && n >= min ? n : fallback
}

/** SIFTLY_DISABLE_CLI=1: never spawn `claude`/`codex` and never read their credential files. */
export function cliDisabled(): boolean {
  return process.env.SIFTLY_DISABLE_CLI === '1'
}

/** SIFTLY_AI_PROVIDER=openai|anthropic|minimax overrides the provider saved in Settings. */
export function providerOverride(): 'anthropic' | 'openai' | 'minimax' | null {
  const v = process.env.SIFTLY_AI_PROVIDER?.trim().toLowerCase()
  return v === 'openai' || v === 'anthropic' || v === 'minimax' ? v : null
}

/** Max simultaneous LLM requests across the whole process (default 1). */
export function aiConcurrency(): number {
  return intEnv('SIFTLY_AI_CONCURRENCY', 1)
}

/** Per-request timeout once a request is actually sent (default 10 min). */
export function aiTimeoutMs(): number {
  return intEnv('SIFTLY_AI_TIMEOUT_MS', 600_000)
}

/** How long the pipeline waits between LLM availability checks while paused (default 10 min). */
export function llmRetryMs(): number {
  return intEnv('SIFTLY_LLM_RETRY_MS', 600_000)
}

/** If set, the LLM only counts as available when /v1/models lists this model id. */
export function expectedModel(): string | null {
  return process.env.SIFTLY_EXPECTED_MODEL?.trim() || null
}

/** AI search reranking: hard cap including time spent queued behind pipeline calls. */
export const SEARCH_RERANK_TIMEOUT_MS = 20_000
