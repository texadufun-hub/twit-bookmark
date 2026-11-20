import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/db', () => ({ default: {} }))

import { validateSummary, parseSummaryText, summarizeOne, buildSummaryPrompt, type SummaryInput } from '@/lib/summarizer'
import type { AIClient } from '@/lib/ai-client'

const GOOD = {
  summary: 'The author shares a Rust crate for parsing logs. It claims a 3x speedup over regex.',
  oneLine: 'Rust crate for fast log parsing',
  keyPoints: ['new crate', '3x faster than regex'],
  action: 'try',
}

const INPUT: SummaryInput = {
  text: 'Just released logparse-rs, 3x faster than regex. https://t.co/x',
  authorName: 'Dev',
  authorHandle: '@dev',
  tweetCreatedAt: new Date('2026-05-01T10:00:00Z'),
  imageTags: ['{"style":"screenshot","scene":"terminal","text_ocr":["cargo add logparse"]}'],
  urls: ['https://github.com/dev/logparse-rs'],
}

function client(replies: (string | Error)[]): AIClient & { calls: unknown[] } {
  const calls: unknown[] = []
  return {
    provider: 'openai',
    calls,
    createMessage: vi.fn(async (params) => {
      calls.push(JSON.parse(JSON.stringify(params)))
      const r = replies.shift()
      if (r instanceof Error) throw r
      return { text: r ?? '' }
    }),
  }
}

describe('summary validation', () => {
  it('accepts a valid object', () => {
    expect(validateSummary(GOOD)).toEqual({ ok: true, value: GOOD })
  })
  it.each([
    [{ ...GOOD, action: 'maybe' }, 'action must be one of'],
    [{ ...GOOD, keyPoints: [] }, 'keyPoints'],
    [{ ...GOOD, keyPoints: 'a, b' }, 'keyPoints'],
    [{ ...GOOD, oneLine: 'line one\nline two' }, 'oneLine'],
    [{ ...GOOD, summary: '' }, 'summary'],
    [{ ...GOOD, summary: 'One. Two. Three. Four. Five. Six.' }, '2-4 sentences'],
    [{ ...GOOD, extra: 1 }, 'unexpected keys'],
    [[GOOD], 'expected a JSON object'],
  ])('rejects %j', (value, msg) => {
    const r = validateSummary(value)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain(msg)
  })
  it('parses JSON wrapped in <think> blocks and code fences', () => {
    const r = parseSummaryText('<think>let me see</think>\n```json\n' + JSON.stringify(GOOD) + '\n```')
    expect(r.ok).toBe(true)
  })
  it('reports invalid JSON', () => {
    const r = parseSummaryText('{"summary": "x",')
    expect(r.ok).toBe(false)
  })
})

describe('summarizeOne', () => {
  it('returns ok on the first valid reply and asks for strict JSON', async () => {
    const c = client([JSON.stringify(GOOD)])
    const out = await summarizeOne(c, 'm', INPUT)
    expect(out).toEqual({ status: 'ok', value: GOOD })
    const call = c.calls[0] as { jsonSchema?: { name: string } }
    expect(call.jsonSchema?.name).toBe('bookmark_summary')
  })

  it('retries once with the validation error, then succeeds', async () => {
    const c = client(['not json at all', JSON.stringify(GOOD)])
    const out = await summarizeOne(c, 'm', INPUT)
    expect(out.status).toBe('ok')
    expect(c.calls).toHaveLength(2)
    const retry = c.calls[1] as { messages: { role: string; content: string }[] }
    expect(retry.messages.at(-1)?.content).toContain('not valid')
  })

  it('marks needsReview after two invalid replies (no third call)', async () => {
    const c = client(['{"summary": 1}', JSON.stringify({ ...GOOD, action: 'later' })])
    const out = await summarizeOne(c, 'm', INPUT)
    expect(out.status).toBe('needsReview')
    if (out.status === 'needsReview') expect(out.error).toContain('action')
    expect(c.calls).toHaveLength(2)
  })

  it('does not mark needsReview when the LLM is unavailable: the error propagates', async () => {
    const down = Object.assign(new Error('Connection error.'), { name: 'APIConnectionError' })
    const c = client([down])
    await expect(summarizeOne(c, 'm', INPUT)).rejects.toThrow('Connection error')
  })

  it('grounds the prompt in the bookmark only', () => {
    const p = buildSummaryPrompt(INPUT)
    expect(p).toContain('Use ONLY the information below')
    expect(p).toContain('logparse-rs')
    expect(p).toContain('cargo add logparse') // image OCR from vision
    expect(p).toContain('page content NOT available')
    expect(p).toContain('2026-05-01')
  })
})
