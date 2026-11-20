/**
 * LLM availability (tex patch). The local model server is switched off or swapped for
 * another model from time to time; that is normal and must never mark bookmarks as failed.
 */
import { expectedModel, llmRetryMs } from './tex-config'

export class LlmUnavailableError extends Error {
  constructor(reason: string) {
    super(`LLM unavailable: ${reason}`)
    this.name = 'LlmUnavailableError'
  }
}

const UNAVAILABLE_MESSAGE = /ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|socket hang up|fetch failed|Connection error|Request timed out|timed out|other side closed/i

/** True for errors that mean "the server is not there right now", not "this input is bad". */
export function isLlmUnavailableError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  if (err instanceof LlmUnavailableError) return true
  const e = err as { name?: string; status?: number; message?: string; cause?: unknown }
  if (e.name === 'APIConnectionError' || e.name === 'APIConnectionTimeoutError') return true
  if (typeof e.status === 'number' && [502, 503, 504].includes(e.status)) return true
  if (typeof e.message === 'string' && UNAVAILABLE_MESSAGE.test(e.message)) return true
  return e.cause ? isLlmUnavailableError(e.cause) : false
}

export interface LlmCheck {
  ok: boolean
  reason?: string
}

/**
 * GET {OPENAI_BASE_URL}/models. Only meaningful for an OpenAI-compatible local server;
 * without OPENAI_BASE_URL there is nothing to probe and the check passes.
 * The API key is sent as a header and never logged.
 */
export async function checkLlm(fetchImpl: typeof fetch = fetch): Promise<LlmCheck> {
  const base = process.env.OPENAI_BASE_URL?.trim().replace(/\/+$/, '')
  if (!base) return { ok: true }
  const key = process.env.OPENAI_API_KEY?.trim()
  try {
    const res = await fetchImpl(`${base}/models`, {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return { ok: false, reason: `GET /models returned HTTP ${res.status}` }
    const want = expectedModel()
    if (want) {
      const body = (await res.json()) as { data?: { id?: string }[] }
      const ids = (body.data ?? []).map((m) => m.id).filter(Boolean)
      if (!ids.includes(want)) return { ok: false, reason: `model ${want} not loaded (serving: ${ids.join(', ') || 'none'})` }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message.slice(0, 120) : String(err) }
  }
}

export interface WaitOptions {
  shouldAbort?: () => boolean
  onUnavailable?: (reason: string, nextCheckAt: Date) => void
  onAvailable?: () => void
  check?: () => Promise<LlmCheck>
  sleep?: (ms: number) => Promise<void>
  retryMs?: number
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * Block until the LLM answers. Re-checks every retryMs (default SIFTLY_LLM_RETRY_MS, 10 min),
 * sleeping in short slices so a Stop request is honoured quickly.
 * Returns false only when aborted.
 */
export async function waitForLlm(opts: WaitOptions = {}): Promise<boolean> {
  const check = opts.check ?? (() => checkLlm())
  const sleep = opts.sleep ?? realSleep
  const retryMs = opts.retryMs ?? llmRetryMs()
  let paused = false
  for (;;) {
    if (opts.shouldAbort?.()) return false
    const result = await check()
    if (result.ok) {
      if (paused) opts.onAvailable?.()
      return true
    }
    paused = true
    const reason = result.reason ?? 'unavailable'
    console.warn(`[llm] unavailable (${reason}); retrying in ${Math.round(retryMs / 1000)}s`)
    opts.onUnavailable?.(reason, new Date(Date.now() + retryMs))
    for (let slept = 0; slept < retryMs; slept += 5_000) {
      if (opts.shouldAbort?.()) return false
      await sleep(Math.min(5_000, retryMs - slept))
    }
  }
}
