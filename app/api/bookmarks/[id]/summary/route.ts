// tex: per-bookmark summary — GET the fields, POST to re-summarize this one bookmark
import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/db'
import { resolveAIClient } from '@/lib/ai-client'
import { getActiveModel } from '@/lib/settings'
import { summarizeBookmark } from '@/lib/summarizer'
import { checkLlm, isLlmUnavailableError } from '@/lib/llm-health'
import { updateFtsRow } from '@/lib/fts'

const SELECT = {
  id: true, summary: true, oneLine: true, keyPoints: true, action: true,
  summaryStatus: true, summaryError: true, summarizedAt: true,
} as const

function format(b: { id: string; summary: string | null; oneLine: string | null; keyPoints: string | null; action: string | null; summaryStatus: string | null; summaryError: string | null; summarizedAt: Date | null }) {
  let keyPoints: string[] = []
  try { keyPoints = b.keyPoints ? (JSON.parse(b.keyPoints) as string[]) : [] } catch { /* ignore */ }
  return { ...b, keyPoints, summarizedAt: b.summarizedAt?.toISOString() ?? null }
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const b = await prisma.bookmark.findUnique({ where: { id }, select: SELECT })
  if (!b) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(format(b))
}

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!(await prisma.bookmark.findUnique({ where: { id }, select: { id: true } }))) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  const health = await checkLlm()
  if (!health.ok) return NextResponse.json({ error: 'LLM unavailable, try again later', reason: health.reason }, { status: 503 })
  try {
    const client = await resolveAIClient({})
    await summarizeBookmark(client, await getActiveModel(), id)
    await updateFtsRow(id).catch((err) => console.error('[summary] FTS update failed:', err))
  } catch (err) {
    if (isLlmUnavailableError(err)) return NextResponse.json({ error: 'LLM unavailable, try again later' }, { status: 503 })
    return NextResponse.json({ error: err instanceof Error ? err.message.slice(0, 200) : String(err) }, { status: 500 })
  }
  const b = await prisma.bookmark.findUnique({ where: { id }, select: SELECT })
  return NextResponse.json(format(b!))
}
