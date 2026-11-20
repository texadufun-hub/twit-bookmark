/**
 * One process-wide limiter for every LLM request (tex patch).
 * The local server handles one request at a time, so all callers (vision, enrichment,
 * categorization, category suggestions, summaries, AI search) queue here.
 */
import { aiConcurrency } from './tex-config'

export class QueueTimeoutError extends Error {
  constructor(ms: number) {
    super(`Timed out after ${ms}ms waiting for a free LLM slot`)
    this.name = 'QueueTimeoutError'
  }
}

interface Waiter {
  resolve: () => void
  reject: (err: Error) => void
  timer?: ReturnType<typeof setTimeout>
}

export class Limiter {
  private active = 0
  private queue: Waiter[] = []

  constructor(private readonly limit: () => number) {}

  get running(): number {
    return this.active
  }

  get waiting(): number {
    return this.queue.length
  }

  private acquire(waitTimeoutMs?: number): Promise<void> {
    if (this.active < this.limit()) {
      this.active++
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve: () => {
          if (waiter.timer) clearTimeout(waiter.timer)
          this.active++
          resolve()
        },
        reject,
      }
      if (waitTimeoutMs !== undefined) {
        waiter.timer = setTimeout(() => {
          this.queue = this.queue.filter((w) => w !== waiter)
          reject(new QueueTimeoutError(waitTimeoutMs))
        }, waitTimeoutMs)
      }
      this.queue.push(waiter)
    })
  }

  private release(): void {
    this.active--
    while (this.active < this.limit() && this.queue.length > 0) {
      this.queue.shift()!.resolve()
    }
  }

  /** Run fn when a slot is free. waitTimeoutMs bounds only the time spent queued. */
  async run<T>(fn: () => Promise<T>, opts: { waitTimeoutMs?: number } = {}): Promise<T> {
    await this.acquire(opts.waitTimeoutMs)
    try {
      return await fn()
    } finally {
      this.release()
    }
  }
}

// Survive Next.js dev hot reloads / multiple module instances in one process.
const g = globalThis as unknown as { __siftlyAiLimiter?: Limiter }
export const aiLimiter: Limiter = g.__siftlyAiLimiter ?? (g.__siftlyAiLimiter = new Limiter(aiConcurrency))
