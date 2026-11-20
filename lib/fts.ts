/**
 * SQLite FTS5 virtual table for fast full-text search across bookmarks.
 * FTS5 uses Porter stemming and tokenization — much faster than LIKE '%keyword%' table scans.
 *
 * The table is rebuilt after enrichment runs. At search time it provides ranked ID lists
 * that replace the LIKE-based keyword conditions in the search route.
 */

import prisma from '@/lib/db'

const FTS_TABLE = 'bookmark_fts'

// tex: summary columns added; an older table without them is dropped and recreated
const FTS_COLUMNS = ['bookmark_id', 'text', 'semantic_tags', 'entities', 'image_tags', 'summary', 'one_line', 'key_points']
let ftsReady = false

export async function ensureFtsTable(): Promise<void> {
  if (ftsReady) return
  const cols = await prisma.$queryRawUnsafe<{ name: string }[]>(`PRAGMA table_info(${FTS_TABLE})`)
  if (cols.length > 0 && !FTS_COLUMNS.every((c) => cols.some((x) => x.name === c))) {
    await prisma.$executeRawUnsafe(`DROP TABLE ${FTS_TABLE}`)
  }
  await prisma.$executeRawUnsafe(`
    CREATE VIRTUAL TABLE IF NOT EXISTS ${FTS_TABLE} USING fts5(
      bookmark_id UNINDEXED,
      text,
      semantic_tags,
      entities,
      image_tags,
      summary,
      one_line,
      key_points,
      tokenize='porter unicode61'
    )
  `)
  ftsReady = true
}

const FTS_SOURCE_SELECT = {
  id: true,
  text: true,
  semanticTags: true,
  entities: true,
  summary: true,
  oneLine: true,
  keyPoints: true,
  mediaItems: { select: { imageTags: true } },
} as const

type FtsSource = {
  id: string
  text: string
  semanticTags: string | null
  entities: string | null
  summary: string | null
  oneLine: string | null
  keyPoints: string | null
  mediaItems: { imageTags: string | null }[]
}

function ftsInsert(b: FtsSource) {
  const imageTagsText = b.mediaItems
    .map((m) => m.imageTags ?? '')
    .filter(Boolean)
    .join(' ')
  return prisma.$executeRaw`
    INSERT INTO bookmark_fts(bookmark_id, text, semantic_tags, entities, image_tags, summary, one_line, key_points)
    VALUES (${b.id}, ${b.text}, ${b.semanticTags ?? ''}, ${b.entities ?? ''}, ${imageTagsText},
            ${b.summary ?? ''}, ${b.oneLine ?? ''}, ${b.keyPoints ?? ''})
  `
}

/** tex: refresh one bookmark's row (after a re-summarize) without a full rebuild. */
export async function updateFtsRow(bookmarkId: string): Promise<void> {
  await ensureFtsTable()
  const b = await prisma.bookmark.findUnique({ where: { id: bookmarkId }, select: FTS_SOURCE_SELECT })
  await prisma.$executeRaw`DELETE FROM bookmark_fts WHERE bookmark_id = ${bookmarkId}`
  if (b) await ftsInsert(b)
}

/**
 * tex: main search box. All terms must match (prefix match per term), across text,
 * tags, image analysis and summaries. Returns [] on error so callers keep LIKE results.
 */
export async function ftsMatchIds(q: string, limit = 500): Promise<string[]> {
  const terms = q
    .split(/\s+/)
    .map((t) => t.replace(/["*()^:+\-]/g, ' ').trim())
    .flatMap((t) => t.split(/\s+/))
    .filter((t) => t.length >= 2)
  if (terms.length === 0) return []
  try {
    await ensureFtsTable()
    const match = terms.map((t) => `"${t}"*`).join(' ')
    const rows = await prisma.$queryRaw<{ bookmark_id: string }[]>`
      SELECT bookmark_id FROM bookmark_fts WHERE bookmark_fts MATCH ${match} ORDER BY rank LIMIT ${limit}
    `
    return rows.map((r) => r.bookmark_id)
  } catch {
    return []
  }
}

/**
 * Rebuild the FTS5 table from all bookmarks. Fast (local SQLite) and idempotent.
 * Call after import or enrichment runs.
 */
export async function rebuildFts(): Promise<void> {
  await ensureFtsTable()
  await prisma.$executeRawUnsafe(`DELETE FROM ${FTS_TABLE}`)

  const bookmarks = await prisma.bookmark.findMany({ select: FTS_SOURCE_SELECT })

  if (bookmarks.length === 0) return

  // Insert in batches of 200 to stay within SQLite variable limits
  const BATCH = 200
  for (let i = 0; i < bookmarks.length; i += BATCH) {
    const batch = bookmarks.slice(i, i + BATCH)
    await prisma.$transaction(batch.map((b) => ftsInsert(b)))
  }
}

/**
 * Search FTS5 table for bookmarks matching the given keywords.
 * Returns bookmark IDs ordered by relevance rank.
 * Returns [] on error (caller should fall back to LIKE queries).
 */
export async function ftsSearch(keywords: string[]): Promise<string[]> {
  if (keywords.length === 0) return []

  try {
    await ensureFtsTable()

    // Sanitize each keyword: remove FTS5 special chars, wrap in quotes for phrase safety
    const terms = keywords
      .map((kw) => kw.replace(/["*()]/g, ' ').trim())
      .filter((kw) => kw.length >= 2)

    if (terms.length === 0) return []

    // Build FTS5 MATCH query with OR between terms
    const matchQuery = terms.join(' OR ')

    const results = await prisma.$queryRaw<{ bookmark_id: string }[]>`
      SELECT bookmark_id FROM bookmark_fts
      WHERE bookmark_fts MATCH ${matchQuery}
      ORDER BY rank
      LIMIT 150
    `
    return results.map((r) => r.bookmark_id)
  } catch {
    // FTS table may not be populated yet or query has syntax error — fall back gracefully
    return []
  }
}
