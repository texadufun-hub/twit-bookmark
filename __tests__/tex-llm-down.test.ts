import { describe, it, expect, vi, beforeEach } from 'vitest'

const update = vi.fn()
vi.mock('@/lib/db', () => ({
  default: { mediaItem: { findFirst: vi.fn().mockResolvedValue(null), update: (...a: unknown[]) => update(...a) } },
}))

import { waitForLlm, checkLlm, isLlmUnavailableError, LlmUnavailableError } from '@/lib/llm-health'

describe('LLM availability', () => {
  it('classifies outages vs. real errors', () => {
    expect(isLlmUnavailableError(Object.assign(new Error('Connection error.'), { name: 'APIConnectionError' }))).toBe(true)
    expect(isLlmUnavailableError(Object.assign(new Error('Request timed out.'), { name: 'APIConnectionTimeoutError' }))).toBe(true)
    expect(isLlmUnavailableError(Object.assign(new Error('Bad gateway'), { status: 502 }))).toBe(true)
    expect(isLlmUnavailableError(new Error('connect ECONNREFUSED 10.0.0.216:8094'))).toBe(true)
    expect(isLlmUnavailableError(new LlmUnavailableError('x'))).toBe(true)
    expect(isLlmUnavailableError(Object.assign(new Error('Bad request'), { status: 400 }))).toBe(false)
    expect(isLlmUnavailableError(new SyntaxError('Unexpected token'))).toBe(false)
  })

  it('pauses while down, re-checks every retryMs, resumes when back', async () => {
    const results = [{ ok: false, reason: 'HTTP 502' }, { ok: false, reason: 'HTTP 502' }, { ok: true }]
    const check = vi.fn(async () => results.shift()!)
    const slept: number[] = []
    const onUnavailable = vi.fn()
    const onAvailable = vi.fn()
    const ok = await waitForLlm({ check, sleep: async (ms) => { slept.push(ms) }, retryMs: 600_000, onUnavailable, onAvailable })
    expect(ok).toBe(true)
    expect(check).toHaveBeenCalledTimes(3)
    expect(onUnavailable).toHaveBeenCalledTimes(2)
    expect(onUnavailable.mock.calls[0][0]).toBe('HTTP 502')
    expect(onAvailable).toHaveBeenCalledTimes(1)
    expect(slept.reduce((a, b) => a + b, 0)).toBe(2 * 600_000) // two full 10-minute waits, in 5 s slices
    expect(Math.max(...slept)).toBe(5_000)
  })

  it('stops waiting promptly when the user stops the pipeline', async () => {
    let aborted = false
    let sleeps = 0
    const ok = await waitForLlm({
      check: async () => ({ ok: false, reason: 'down' }),
      sleep: async () => { if (++sleeps === 3) aborted = true },
      shouldAbort: () => aborted,
      retryMs: 600_000,
    })
    expect(ok).toBe(false)
    expect(sleeps).toBe(3)
  })

  it('checkLlm: up only if /models answers and lists the expected model', async () => {
    process.env.OPENAI_BASE_URL = 'http://llm.test/v1'
    process.env.OPENAI_API_KEY = 'k'
    process.env.SIFTLY_EXPECTED_MODEL = 'qwen3.8-flash-next-q2_0'
    const respond = (status: number, ids: string[]) =>
      vi.fn(async () => new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status }))
    expect(await checkLlm(respond(200, ['qwen3.8-flash-next-q2_0']) as unknown as typeof fetch)).toEqual({ ok: true })
    expect((await checkLlm(respond(200, ['other-model']) as unknown as typeof fetch)).ok).toBe(false)
    expect((await checkLlm(respond(502, []) as unknown as typeof fetch)).ok).toBe(false)
    const refused = vi.fn(async () => { throw new TypeError('fetch failed') })
    expect((await checkLlm(refused as unknown as typeof fetch)).ok).toBe(false)
    const fetchSpy = respond(200, ['qwen3.8-flash-next-q2_0'])
    await checkLlm(fetchSpy as unknown as typeof fetch)
    expect(fetchSpy).toHaveBeenCalledWith('http://llm.test/v1/models', expect.objectContaining({ headers: { Authorization: 'Bearer k' } }))
  })
})

describe('vision while the LLM is down', () => {
  beforeEach(() => update.mockReset())

  it('does not mark the image as attempted (no imageTags = "{}")', async () => {
    const sharp = (await import('sharp')).default
    const png = await sharp({ create: { width: 2000, height: 1000, channels: 3, background: '#336699' } }).png().toBuffer()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(png, { status: 200, headers: { 'content-type': 'image/png' } })))
    const { analyzeItem } = await import('@/lib/vision-analyzer')
    const down = { provider: 'openai' as const, createMessage: vi.fn(async () => { throw Object.assign(new Error('Connection error.'), { name: 'APIConnectionError' }) }) }

    await expect(analyzeItem({ id: 'm1', url: 'https://pbs.twimg.com/media/x.png', thumbnailUrl: null, type: 'photo' }, down, 'm')).rejects.toThrow('Connection error')
    expect(update).not.toHaveBeenCalled()

    // The image that was about to be sent was downscaled to a 1024 px long side, as JPEG.
    const sent = down.createMessage.mock.calls[0] as unknown as [{ messages: { content: { source?: { data: string; media_type: string } }[] }[] }]
    const src = sent[0].messages[0].content[0].source!
    expect(src.media_type).toBe('image/jpeg')
    const meta = await sharp(Buffer.from(src.data, 'base64')).metadata()
    expect([meta.width, meta.height]).toEqual([1024, 512])
    vi.unstubAllGlobals()
  })

  it('a real model error still marks the image attempted (upstream behaviour)', async () => {
    const sharp = (await import('sharp')).default
    const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#000' } }).png().toBuffer()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(png, { status: 200 })))
    const { analyzeItem } = await import('@/lib/vision-analyzer')
    const bad = { provider: 'openai' as const, createMessage: vi.fn(async () => { throw Object.assign(new Error('400 invalid image'), { status: 400 }) }) }
    await expect(analyzeItem({ id: 'm2', url: 'https://pbs.twimg.com/media/y.png', thumbnailUrl: null, type: 'photo' }, bad, 'm')).resolves.toBe(0)
    expect(update).toHaveBeenCalledWith({ where: { id: 'm2' }, data: { imageTags: '{}' } })
    vi.unstubAllGlobals()
  })
})
