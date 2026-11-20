'use client'
// tex: summary, one-liner, key points and action for one bookmark, with a Re-summarize button

import { useEffect, useState } from 'react'
import { FileText, Loader2, RefreshCw, AlertTriangle } from 'lucide-react'

interface SummaryData {
  summary: string | null
  oneLine: string | null
  keyPoints: string[]
  action: 'read' | 'try' | 'reference' | 'discard' | null
  summaryStatus: 'ok' | 'needsReview' | null
  summaryError: string | null
  summarizedAt: string | null
}

const ACTION_STYLE: Record<string, string> = {
  read: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
  try: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  reference: 'bg-violet-500/15 text-violet-300 border-violet-500/30',
  discard: 'bg-zinc-700/40 text-zinc-400 border-zinc-600/40',
}

export default function SummaryPanel({ bookmarkId }: { bookmarkId: string }) {
  const [data, setData] = useState<SummaryData | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    fetch(`/api/bookmarks/${bookmarkId}/summary`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: SummaryData | null) => { if (!cancelled) setData(d) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [bookmarkId])

  async function resummarize() {
    setBusy(true)
    setError('')
    try {
      const res = await fetch(`/api/bookmarks/${bookmarkId}/summary`, { method: 'POST' })
      const d = (await res.json()) as SummaryData & { error?: string }
      if (!res.ok) throw new Error(d.error ?? `HTTP ${res.status}`)
      setData(d)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-3 rounded-2xl border border-zinc-800 bg-zinc-900/80 p-4 space-y-3 text-sm">
      <div className="flex items-center gap-2">
        <FileText size={14} className="text-zinc-500" />
        <span className="text-zinc-300 font-medium">Summary</span>
        {data?.action && (
          <span className={`text-[11px] px-2 py-0.5 rounded-full border ${ACTION_STYLE[data.action] ?? ''}`}>{data.action}</span>
        )}
        <button
          onClick={() => void resummarize()}
          disabled={busy}
          className="ml-auto flex items-center gap-1.5 text-xs text-zinc-400 hover:text-zinc-100 disabled:opacity-50"
          title="Ask the LLM to summarize this bookmark again (may queue behind other work)"
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
          {busy ? 'Summarizing…' : 'Re-summarize'}
        </button>
      </div>

      {data?.summaryStatus === 'needsReview' && (
        <p className="flex items-start gap-1.5 text-xs text-amber-300">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" />
          Needs review: {data.summaryError ?? 'the model did not return a valid summary'}
        </p>
      )}

      {data?.oneLine && <p className="text-zinc-100">{data.oneLine}</p>}
      {data?.summary && <p className="text-zinc-400 leading-relaxed">{data.summary}</p>}
      {data && data.keyPoints.length > 0 && (
        <ul className="list-disc pl-5 text-zinc-400 space-y-0.5">
          {data.keyPoints.map((k, i) => <li key={i}>{k}</li>)}
        </ul>
      )}
      {data && !data.summary && data.summaryStatus !== 'needsReview' && (
        <p className="text-zinc-600 text-xs">Not summarized yet.</p>
      )}
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  )
}
