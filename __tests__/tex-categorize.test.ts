import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/db', () => ({ default: {} }))
vi.mock('@/lib/settings', () => ({ getActiveModel: async () => 'm', getProvider: async () => 'openai' }))
vi.mock('@/lib/claude-cli-auth', () => ({ getCliAvailability: async () => false, claudePrompt: vi.fn(), modelNameToCliAlias: () => 'haiku' }))
vi.mock('@/lib/codex-cli', () => ({ getCodexCliAvailability: async () => false, codexPrompt: vi.fn() }))

import { categorizeBatch } from '@/lib/categorizer'

const BM = [{ tweetId: '1', text: 'rust crate', imageTags: [], semanticTags: [] }]
const GOOD = JSON.stringify({ results: [{ tweetId: '1', assignments: [{ category: 'dev-tools', confidence: 0.9 }, { category: 'nope', confidence: 0.9 }] }] })

describe('categorizeBatch on a reasoning model', () => {
  it('asks for schema output with a large budget and parses {results}', async () => {
    const createMessage = vi.fn(async () => ({ text: GOOD }))
    const out = await categorizeBatch(BM as never, { provider: 'openai', createMessage } as never, {}, ['dev-tools', 'general'])
    expect(out).toEqual([{ tweetId: '1', assignments: [{ category: 'dev-tools', confidence: 0.9 }] }])
    const p = (createMessage.mock.calls[0] as unknown as [{ max_tokens: number; jsonSchema: { name: string } }])[0]
    expect(p.max_tokens).toBeGreaterThanOrEqual(8192)
    expect(p.jsonSchema.name).toBe('bookmark_categories')
  })

  it('retries once after truncated JSON', async () => {
    const createMessage = vi.fn().mockResolvedValueOnce({ text: '[{"tweetId": "1", "assignments": [{"category": "dev' }).mockResolvedValueOnce({ text: GOOD })
    const out = await categorizeBatch(BM as never, { provider: 'openai', createMessage } as never, {}, ['dev-tools'])
    expect(out[0].assignments[0].category).toBe('dev-tools')
    expect(createMessage).toHaveBeenCalledTimes(2)
  })

  it('still accepts a bare array (CLI / legacy output)', async () => {
    const createMessage = vi.fn(async () => ({ text: 'Here: [{"tweetId":"1","assignments":[{"category":"dev-tools","confidence":0.7}]}]' }))
    const out = await categorizeBatch(BM as never, { provider: 'openai', createMessage } as never, {}, ['dev-tools'])
    expect(out[0].assignments).toHaveLength(1)
  })
})
