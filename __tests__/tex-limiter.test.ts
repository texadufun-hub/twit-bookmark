import { describe, it, expect, vi } from 'vitest'
import { Limiter, QueueTimeoutError } from '@/lib/ai-limiter'

vi.mock('@/lib/db', () => ({ default: {}, prisma: {} }))

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('Limiter (SIFTLY_AI_CONCURRENCY)', () => {
  it.each([1, 2, 3])('never runs more than %i tasks at once', async (n) => {
    const limiter = new Limiter(() => n)
    let active = 0
    let peak = 0
    const task = async () => {
      active++
      peak = Math.max(peak, active)
      await tick(Math.random() * 5)
      active--
    }
    await Promise.all(Array.from({ length: 25 }, () => limiter.run(task)))
    expect(peak).toBe(n)
    expect(limiter.running).toBe(0)
    expect(limiter.waiting).toBe(0)
  })

  it('releases the slot when a task throws', async () => {
    const limiter = new Limiter(() => 1)
    await expect(limiter.run(async () => { throw new Error('boom') })).rejects.toThrow('boom')
    await expect(limiter.run(async () => 'ok')).resolves.toBe('ok')
  })

  it('waitTimeoutMs bounds only the time spent queued', async () => {
    const limiter = new Limiter(() => 1)
    let release!: () => void
    const holder = limiter.run(() => new Promise<void>((r) => { release = r }))
    await expect(limiter.run(async () => 'late', { waitTimeoutMs: 20 })).rejects.toBeInstanceOf(QueueTimeoutError)
    expect(limiter.waiting).toBe(0) // timed-out waiter removed from the queue
    release()
    await holder
    await expect(limiter.run(async () => 'next', { waitTimeoutMs: 20 })).resolves.toBe('next')
  })

  it('LimitedAIClient routes every createMessage through the shared limiter', async () => {
    process.env.SIFTLY_AI_CONCURRENCY = '1'
    const { LimitedAIClient } = await import('@/lib/ai-client')
    let active = 0
    let peak = 0
    const inner = {
      provider: 'openai' as const,
      createMessage: async () => {
        active++
        peak = Math.max(peak, active)
        await tick(3)
        active--
        return { text: 'x' }
      },
    }
    // Several independent client instances (as vision/enrich/categorize create) share one limiter.
    const clients = [new LimitedAIClient(inner), new LimitedAIClient(inner), new LimitedAIClient(inner)]
    await Promise.all(
      Array.from({ length: 12 }, (_, i) => clients[i % 3].createMessage({ model: 'm', max_tokens: 1, messages: [] })),
    )
    expect(peak).toBe(1)
  })
})
