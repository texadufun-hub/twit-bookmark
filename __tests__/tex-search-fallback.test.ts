import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const BOOKMARKS = ['b1', 'b2', 'b3'].map((id, i) => ({
  id, tweetId: `t${i}`, text: `rust async runtime post ${i}`, authorHandle: '@a', authorName: 'A',
  tweetCreatedAt: new Date('2026-01-01'), importedAt: new Date('2026-01-02'), semanticTags: null, entities: null,
  mediaItems: [], categories: [],
}))

const settings: Record<string, string> = {}
vi.mock('@/lib/db', () => ({
  default: {
    setting: { findUnique: vi.fn(async ({ where }: { where: { key: string } }) => (settings[where.key] ? { value: settings[where.key] } : null)) },
    category: { findMany: vi.fn(async () => []) },
    bookmark: {
      findMany: vi.fn(async (args: { where?: { id?: { in?: string[] } | string } }) => {
        const where = args?.where?.id
        if (where === 'never') return []
        if (where && typeof where === 'object' && where.in) return BOOKMARKS.filter((b) => where.in!.includes(b.id))
        return BOOKMARKS
      }),
    },
  },
}))
vi.mock('@/lib/fts', () => ({ ftsSearch: vi.fn(async () => ['b2', 'b1']) }))
vi.mock('@/lib/settings', () => ({ getActiveModel: async () => 'm', getProvider: async () => 'openai' }))
vi.mock('@/lib/claude-cli-auth', () => ({ getCliAvailability: async () => false, claudePrompt: vi.fn(), modelNameToCliAlias: () => 'haiku' }))
vi.mock('@/lib/codex-cli', () => ({ getCodexCliAvailability: async () => false, codexPrompt: vi.fn() }))

const createMessage = vi.fn()
vi.mock('@/lib/ai-client', () => ({ resolveAIClient: async () => ({ provider: 'openai', createMessage }) }))

async function search(query: string) {
  const { POST } = await import('@/app/api/search/ai/route')
  const res = await POST(new NextRequest('http://x/api/search/ai', { method: 'POST', body: JSON.stringify({ query }) }))
  return { status: res.status, body: (await res.json()) as { bookmarks: { id: string }[]; explanation: string } }
}

describe('AI Search without the LLM', () => {
  beforeEach(() => {
    vi.resetModules() // fresh 5-minute result cache per test
    createMessage.mockReset()
    for (const k of Object.keys(settings)) delete settings[k]
  })

  it('reranking off (default): FTS results, no LLM call', async () => {
    const { status, body } = await search('rust async')
    expect(status).toBe(200)
    expect(body.bookmarks.map((b) => b.id)).toEqual(['b2', 'b1']) // FTS order kept
    expect(body.explanation).toContain('AI reranking is off')
    expect(createMessage).not.toHaveBeenCalled()
  })

  it('reranking on but the LLM fails: falls back to FTS results (not HTTP 500)', async () => {
    settings.aiSearchRerank = 'true'
    createMessage.mockRejectedValue(Object.assign(new Error('Connection error.'), { name: 'APIConnectionError' }))
    const { status, body } = await search('rust async')
    expect(status).toBe(200)
    expect(body.bookmarks.map((b) => b.id)).toEqual(['b2', 'b1'])
    expect(body.explanation).toContain('showing keyword matches')
  })

  it('reranking on: the call carries the 20 s budget (queue wait + request)', async () => {
    settings.aiSearchRerank = 'true'
    createMessage.mockResolvedValue({ text: JSON.stringify({ matches: [{ id: 'b1', score: 9, reason: 'about rust async' }], explanation: 'ok' }) })
    const { body } = await search('rust async')
    expect(body.bookmarks.map((b) => b.id)).toEqual(['b1'])
    const params = createMessage.mock.calls[0][0] as { waitTimeoutMs: number; timeoutMs: number }
    expect(params.waitTimeoutMs).toBe(20_000)
    expect(params.timeoutMs).toBeLessThanOrEqual(20_000)
  })

  it('a fallback is not cached: the next search tries the LLM again', async () => {
    settings.aiSearchRerank = 'true'
    createMessage.mockRejectedValueOnce(new Error('Request timed out.'))
    await search('rust async')
    createMessage.mockResolvedValueOnce({ text: JSON.stringify({ matches: [{ id: 'b3', score: 8, reason: 'r' }], explanation: 'ok' }) })
    const { POST } = await import('@/app/api/search/ai/route')
    const res = await POST(new NextRequest('http://x/api/search/ai', { method: 'POST', body: JSON.stringify({ query: 'rust async' }) }))
    expect(((await res.json()) as { bookmarks: { id: string }[] }).bookmarks.map((b) => b.id)).toEqual(['b3'])
  })
})
