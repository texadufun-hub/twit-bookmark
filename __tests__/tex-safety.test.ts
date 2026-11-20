import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/db', () => ({ default: { setting: { findUnique: vi.fn().mockResolvedValue({ value: 'anthropic' }) } } }))

const ENV = { ...process.env }

describe('tex safety switches', () => {
  beforeEach(() => vi.resetModules())
  afterEach(() => { process.env = { ...ENV } })

  it('SIFTLY_AI_PROVIDER overrides the provider saved in Settings', async () => {
    process.env.SIFTLY_AI_PROVIDER = 'openai'
    const { getProvider } = await import('@/lib/settings')
    expect(await getProvider()).toBe('openai') // DB says anthropic
  })

  it('SIFTLY_DISABLE_CLI=1 never spawns claude/codex and never reads CLI credentials', async () => {
    process.env.SIFTLY_DISABLE_CLI = '1'
    const spawn = vi.fn()
    vi.doMock('child_process', async (orig) => ({ ...(await orig<typeof import('child_process')>()), spawn, execSync: vi.fn(), spawnSync: vi.fn() }))
    const readFileSync = vi.fn(() => { throw new Error('should not read') })
    vi.doMock('fs', async (orig) => ({ ...(await orig<typeof import('fs')>()), readFileSync }))

    const { getCliAvailability, claudePrompt } = await import('@/lib/claude-cli')
    const { getCodexCliAvailability, codexPrompt } = await import('@/lib/codex-cli')
    const { getCliOAuthToken } = await import('@/lib/claude-cli-auth')
    const { getCodexAuthMode } = await import('@/lib/openai-auth')

    expect(await getCliAvailability()).toBe(false)
    expect(await getCodexCliAvailability()).toBe(false)
    expect((await claudePrompt('hi')).success).toBe(false)
    expect((await codexPrompt('hi')).success).toBe(false)
    expect(getCliOAuthToken()).toBeNull()
    expect(getCodexAuthMode()).toBeNull()
    expect(spawn).not.toHaveBeenCalled()
    expect(readFileSync).not.toHaveBeenCalled()
  })

  it('OPENAI_API_KEY wins over a Codex CLI login', async () => {
    process.env.OPENAI_API_KEY = 'env-key'
    process.env.OPENAI_BASE_URL = 'http://127.0.0.1:1/v1'
    delete process.env.SIFTLY_DISABLE_CLI
    vi.doMock('fs', async (orig) => ({
      ...(await orig<typeof import('fs')>()),
      readFileSync: vi.fn((p: string, ...rest: unknown[]) => {
        if (String(p).includes('codex')) return JSON.stringify({ OPENAI_API_KEY: 'codex-key' })
        return (orig as unknown as { readFileSync: (...a: unknown[]) => unknown }).readFileSync?.(p, ...rest)
      }),
    }))
    const { resolveOpenAIClient } = await import('@/lib/openai-auth')
    const client = resolveOpenAIClient({})
    expect(client.apiKey).toBe('env-key')
    expect(client.baseURL).toBe('http://127.0.0.1:1/v1')
    expect(client.timeout).toBe(600_000)
  })
})
