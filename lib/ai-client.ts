import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { resolveAnthropicClient } from './claude-cli-auth'
import { resolveOpenAIClient } from './openai-auth'
import { resolveMiniMaxClient } from './minimax-auth'
import { getProvider } from './settings'
import { aiLimiter } from './ai-limiter'
import { aiTimeoutMs } from './tex-config'

export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>\s*/g, '').replace(/^[\s\S]*?<\/think>\s*/, '')
}

export interface AIContentBlock {
  type: 'text' | 'image'
  text?: string
  source?: { type: 'base64'; media_type: string; data: string }
}

export interface AIMessage {
  role: 'user' | 'assistant'
  content: string | AIContentBlock[]
}

export interface AIResponse {
  text: string
}

export interface CreateMessageParams {
  model: string
  max_tokens: number
  messages: AIMessage[]
  /** tex: per-request timeout once sent (default SIFTLY_AI_TIMEOUT_MS) */
  timeoutMs?: number
  /** tex: max time to wait for a free slot in the shared limiter */
  waitTimeoutMs?: number
  /** tex: JSON schema for structured output (OpenAI-compatible providers only) */
  jsonSchema?: { name: string; schema: Record<string, unknown> }
}

export interface AIClient {
  provider: 'anthropic' | 'openai' | 'minimax'
  createMessage(params: CreateMessageParams): Promise<AIResponse>
}

// Wrap Anthropic SDK
export class AnthropicAIClient implements AIClient {
  provider = 'anthropic' as const
  constructor(private sdk: Anthropic) {}

  async createMessage(params: CreateMessageParams): Promise<AIResponse> {
    const messages = params.messages.map(m => {
      if (typeof m.content === 'string') {
        return { role: m.role as 'user' | 'assistant', content: m.content }
      }
      const blocks = m.content.map(b => {
        if (b.type === 'image' && b.source) {
          return {
            type: 'image' as const,
            source: {
              type: 'base64' as const,
              media_type: b.source.media_type as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
              data: b.source.data,
            },
          }
        }
        return { type: 'text' as const, text: b.text ?? '' }
      })
      return { role: m.role as 'user' | 'assistant', content: blocks }
    })

    const msg = await this.sdk.messages.create({
      model: params.model,
      max_tokens: params.max_tokens,
      messages,
    })

    const textBlock = msg.content.find(b => b.type === 'text')
    return { text: textBlock && 'text' in textBlock ? textBlock.text : '' }
  }
}

// Wrap OpenAI SDK
export class OpenAIAIClient implements AIClient {
  provider = 'openai' as const
  constructor(private sdk: OpenAI) {}

  async createMessage(params: CreateMessageParams): Promise<AIResponse> {
    const messages: OpenAI.ChatCompletionMessageParam[] = params.messages.map((m): OpenAI.ChatCompletionMessageParam => {
      if (typeof m.content === 'string') {
        if (m.role === 'assistant') return { role: 'assistant' as const, content: m.content }
        return { role: 'user' as const, content: m.content }
      }
      const parts: OpenAI.ChatCompletionContentPart[] = m.content.map(b => {
        if (b.type === 'image' && b.source) {
          return {
            type: 'image_url' as const,
            image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` },
          }
        }
        return { type: 'text' as const, text: b.text ?? '' }
      })
      if (m.role === 'assistant') return { role: 'assistant' as const, content: parts.map(p => p.type === 'text' ? p : p).filter((p): p is OpenAI.ChatCompletionContentPartText => p.type === 'text') }
      return { role: 'user' as const, content: parts }
    })

    const completion = await this.sdk.chat.completions.create(
      {
        model: params.model,
        max_tokens: params.max_tokens,
        messages,
        ...(params.jsonSchema
          ? { response_format: { type: 'json_schema' as const, json_schema: { name: params.jsonSchema.name, schema: params.jsonSchema.schema, strict: true } } }
          : {}),
      },
      { timeout: params.timeoutMs ?? aiTimeoutMs() },
    )

    // Local reasoning models may emit <think> blocks; callers expect the answer only.
    return { text: stripThinking(completion.choices[0]?.message?.content ?? '') }
  }
}

// Wrap MiniMax via OpenAI-compatible SDK (temperature clamped to (0, 1])
export class MiniMaxAIClient implements AIClient {
  provider = 'minimax' as const
  constructor(private sdk: OpenAI) {}

  async createMessage(params: CreateMessageParams): Promise<AIResponse> {
    const messages: OpenAI.ChatCompletionMessageParam[] = params.messages.map((m): OpenAI.ChatCompletionMessageParam => {
      if (typeof m.content === 'string') {
        if (m.role === 'assistant') return { role: 'assistant' as const, content: m.content }
        return { role: 'user' as const, content: m.content }
      }
      const parts: OpenAI.ChatCompletionContentPart[] = m.content.map(b => {
        if (b.type === 'image' && b.source) {
          return {
            type: 'image_url' as const,
            image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` },
          }
        }
        return { type: 'text' as const, text: b.text ?? '' }
      })
      if (m.role === 'assistant') return { role: 'assistant' as const, content: parts.filter((p): p is OpenAI.ChatCompletionContentPartText => p.type === 'text') }
      return { role: 'user' as const, content: parts }
    })

    const completion = await this.sdk.chat.completions.create({
      model: params.model,
      max_tokens: params.max_tokens,
      messages,
    })

    let text = completion.choices[0]?.message?.content ?? ''
    // Strip thinking tags that MiniMax M2.5+ may include
    text = text.replace(/<think>[\s\S]*?<\/think>\s*/g, '')
    return { text }
  }
}

/** tex: routes every LLM request in the process through one limiter (SIFTLY_AI_CONCURRENCY). */
export class LimitedAIClient implements AIClient {
  constructor(private inner: AIClient) {}
  get provider() {
    return this.inner.provider
  }
  createMessage(params: CreateMessageParams): Promise<AIResponse> {
    return aiLimiter.run(() => this.inner.createMessage(params), { waitTimeoutMs: params.waitTimeoutMs })
  }
}

export async function resolveAIClient(options: {
  overrideKey?: string
  dbKey?: string
} = {}): Promise<AIClient> {
  const provider = await getProvider()

  if (provider === 'minimax') {
    const client = resolveMiniMaxClient(options)
    return new LimitedAIClient(new MiniMaxAIClient(client))
  }

  if (provider === 'openai') {
    const client = resolveOpenAIClient(options)
    return new LimitedAIClient(new OpenAIAIClient(client))
  }

  const client = resolveAnthropicClient(options)
  return new LimitedAIClient(new AnthropicAIClient(client))
}
