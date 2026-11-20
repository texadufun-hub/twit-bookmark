/**
 * Per-bookmark summaries (tex patch).
 * One bookmark per LLM call, strict JSON validated in code, one retry on invalid
 * output, then summaryStatus = 'needsReview'. An unavailable LLM is NOT a failure:
 * those errors propagate so the pipeline can pause and retry the same bookmark.
 */
import prisma from '@/lib/db'
import type { AIClient } from '@/lib/ai-client'
import { stripThinking } from '@/lib/ai-client'
import { buildImageContext } from '@/lib/image-context'
import { isLlmUnavailableError } from '@/lib/llm-health'

export const SUMMARY_ACTIONS = ['read', 'try', 'reference', 'discard'] as const
export type SummaryAction = (typeof SUMMARY_ACTIONS)[number]

export interface BookmarkSummary {
  summary: string
  oneLine: string
  keyPoints: string[]
  action: SummaryAction
}

export const SUMMARY_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'oneLine', 'keyPoints', 'action'],
  properties: {
    summary: { type: 'string', description: '2-4 sentences' },
    oneLine: { type: 'string', description: 'one line, at most 120 characters' },
    keyPoints: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 5 },
    action: { type: 'string', enum: [...SUMMARY_ACTIONS] },
  },
}

export interface SummaryInput {
  text: string
  authorName: string
  authorHandle: string
  tweetCreatedAt: Date | null
  imageTags: (string | null)[]
  urls: string[]
}

export type ValidationResult = { ok: true; value: BookmarkSummary } | { ok: false; error: string }

function countSentences(text: string): number {
  return text.split(/(?<=[.!?…])\s+(?=\S)/).filter((s) => s.trim().length > 0).length
}

/** Validate the model output. Accepts 1-5 sentences (the prompt asks for 2-4) to avoid noise on very short tweets. */
export function validateSummary(raw: unknown): ValidationResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'expected a JSON object' }
  const o = raw as Record<string, unknown>
  const extra = Object.keys(o).filter((k) => !['summary', 'oneLine', 'keyPoints', 'action'].includes(k))
  if (extra.length) return { ok: false, error: `unexpected keys: ${extra.join(', ')}` }

  if (typeof o.summary !== 'string' || !o.summary.trim()) return { ok: false, error: 'summary must be a non-empty string' }
  const summary = o.summary.trim()
  if (summary.length > 1200) return { ok: false, error: 'summary is longer than 1200 characters' }
  const sentences = countSentences(summary)
  if (sentences < 1 || sentences > 5) return { ok: false, error: `summary must be 2-4 sentences (got ${sentences})` }

  if (typeof o.oneLine !== 'string' || !o.oneLine.trim()) return { ok: false, error: 'oneLine must be a non-empty string' }
  const oneLine = o.oneLine.trim()
  if (oneLine.includes('\n') || oneLine.length > 160) return { ok: false, error: 'oneLine must be one line of at most 160 characters' }

  if (!Array.isArray(o.keyPoints) || o.keyPoints.length < 1 || o.keyPoints.length > 5)
    return { ok: false, error: 'keyPoints must be an array of 1-5 strings' }
  if (!o.keyPoints.every((k) => typeof k === 'string' && k.trim().length > 0 && k.length <= 240))
    return { ok: false, error: 'each keyPoint must be a non-empty string of at most 240 characters' }

  if (typeof o.action !== 'string' || !(SUMMARY_ACTIONS as readonly string[]).includes(o.action))
    return { ok: false, error: `action must be one of ${SUMMARY_ACTIONS.join('|')}` }

  return {
    ok: true,
    value: { summary, oneLine, keyPoints: (o.keyPoints as string[]).map((k) => k.trim()), action: o.action as SummaryAction },
  }
}

/** Pull one JSON object out of a model reply (tolerates <think> blocks and code fences). */
export function parseSummaryText(text: string): ValidationResult {
  const cleaned = stripThinking(text).trim()
  const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = fenced ? fenced[1] : cleaned
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start === -1 || end <= start) return { ok: false, error: 'no JSON object in the reply' }
  let parsed: unknown
  try {
    parsed = JSON.parse(body.slice(start, end + 1))
  } catch (err) {
    return { ok: false, error: `invalid JSON: ${err instanceof Error ? err.message : String(err)}` }
  }
  return validateSummary(parsed)
}

export function buildSummaryPrompt(input: SummaryInput): string {
  const images = input.imageTags.map((t) => buildImageContext(t ?? undefined)).filter(Boolean)
  const lines = [
    `Author: ${input.authorName} (${input.authorHandle})`,
    `Date: ${input.tweetCreatedAt ? input.tweetCreatedAt.toISOString().slice(0, 10) : 'unknown'}`,
    `Post text:\n${input.text.slice(0, 4000)}`,
  ]
  if (images.length) lines.push(`Images (from image analysis):\n${images.map((c, i) => `${i + 1}. ${c}`).join('\n')}`)
  if (input.urls.length)
    lines.push(`Linked URLs (page content NOT available, do not guess what they contain):\n${input.urls.slice(0, 5).join('\n')}`)

  return `Summarize this saved X/Twitter bookmark for its owner's personal archive.

Use ONLY the information below. Do not add facts, context or claims that are not in it. If the post is short or unclear, say so plainly rather than inventing detail.

Return ONLY a JSON object with exactly these keys:
- "summary": 2-4 sentences on what the post says or shows
- "oneLine": a single line of at most 120 characters
- "keyPoints": 1-5 short strings
- "action": one of "read" (worth reading in depth), "try" (a tool, technique or code to try), "reference" (keep for lookup), "discard" (no lasting value)

BOOKMARK
${lines.join('\n\n')}`
}

export type SummaryOutcome =
  | { status: 'ok'; value: BookmarkSummary }
  | { status: 'needsReview'; error: string }

/**
 * Summarize one bookmark: first attempt, one retry on invalid JSON/validation, then needsReview.
 * LLM-unavailable errors are rethrown untouched.
 */
export async function summarizeOne(client: AIClient, model: string, input: SummaryInput): Promise<SummaryOutcome> {
  const prompt = buildSummaryPrompt(input)
  const messages: Parameters<AIClient['createMessage']>[0]['messages'] = [{ role: 'user', content: prompt }]
  let lastError = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    let text: string
    try {
      const res = await client.createMessage({
        model,
        max_tokens: 1500,
        messages,
        jsonSchema: { name: 'bookmark_summary', schema: SUMMARY_JSON_SCHEMA },
      })
      text = res.text
    } catch (err) {
      if (isLlmUnavailableError(err)) throw err
      lastError = `request failed: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`
      continue
    }
    const result = parseSummaryText(text)
    if (result.ok) return { status: 'ok', value: result.value }
    lastError = result.error
    messages.push(
      { role: 'assistant', content: text.slice(0, 4000) },
      { role: 'user', content: `That reply was not valid: ${result.error}. Return ONLY the corrected JSON object with keys summary, oneLine, keyPoints, action.` },
    )
  }
  return { status: 'needsReview', error: lastError.slice(0, 500) }
}

export const SUMMARY_SELECT = {
  id: true,
  text: true,
  authorName: true,
  authorHandle: true,
  tweetCreatedAt: true,
  entities: true,
  mediaItems: { select: { imageTags: true }, take: 4 },
} as const

type SummaryRow = {
  text: string
  authorName: string
  authorHandle: string
  tweetCreatedAt: Date | null
  entities: string | null
  mediaItems: { imageTags: string | null }[]
}

export function toSummaryInput(row: SummaryRow): SummaryInput {
  let urls: string[] = []
  if (row.entities) {
    try {
      const e = JSON.parse(row.entities) as { urls?: unknown }
      if (Array.isArray(e.urls)) urls = e.urls.map(String).filter(Boolean)
    } catch { /* ignore */ }
  }
  return {
    text: row.text,
    authorName: row.authorName,
    authorHandle: row.authorHandle,
    tweetCreatedAt: row.tweetCreatedAt,
    imageTags: row.mediaItems.map((m) => (m.imageTags && m.imageTags !== '{}' ? m.imageTags : null)).filter(Boolean),
    urls,
  }
}

/** Summarize a bookmark by id and store the result. Rethrows LLM-unavailable errors. */
export async function summarizeBookmark(client: AIClient, model: string, bookmarkId: string): Promise<SummaryOutcome | null> {
  const row = await prisma.bookmark.findUnique({ where: { id: bookmarkId }, select: SUMMARY_SELECT })
  if (!row) return null
  const outcome = await summarizeOne(client, model, toSummaryInput(row))
  const now = new Date()
  if (outcome.status === 'ok') {
    await prisma.bookmark.update({
      where: { id: bookmarkId },
      data: {
        summary: outcome.value.summary,
        oneLine: outcome.value.oneLine,
        keyPoints: JSON.stringify(outcome.value.keyPoints),
        action: outcome.value.action,
        summaryStatus: 'ok',
        summaryError: null,
        summarizedAt: now,
      },
    })
  } else {
    // Keep any earlier good summary; just flag it.
    await prisma.bookmark.update({
      where: { id: bookmarkId },
      data: { summaryStatus: 'needsReview', summaryError: outcome.error, summarizedAt: now },
    })
  }
  return outcome
}
