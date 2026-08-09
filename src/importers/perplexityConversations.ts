import type { SerializableMemoryRecord } from '../types/memory'
import type { IConversationImporter } from './base'
import { registerImporter } from './base'

// ── Perplexity Conversation Parser ──────────────────────────────────────────

interface PerplexityEntry {
  entry_uuid?: unknown
  query?: unknown
  answer?: unknown
  created_at?: unknown
  label?: unknown
  query_status?: unknown
}

interface PerplexityConversation {
  context_uuid?: unknown
  context_title?: unknown
  created_at?: unknown
  updated_at?: unknown
  mode?: unknown
  collection_uuid?: unknown
  entries: unknown[]
}

interface PerplexityExport {
  conversations?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function nonBlankString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text ? text : null
}

/**
 * Parse a Perplexity export timestamp into epoch milliseconds.
 *
 * Perplexity exports normally use ISO date strings, but accepting epoch
 * seconds/milliseconds makes the importer tolerant of older exports and
 * keeps malformed values from preventing the rest of a file from importing.
 */
export function parsePerplexityTimestamp(raw: unknown, fallback = Date.now()): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw > 0 && raw < 100_000_000_000 ? raw * 1000 : raw
  }

  if (typeof raw === 'string') {
    const value = raw.trim()
    if (!value) return fallback

    const numeric = Number(value)
    if (Number.isFinite(numeric)) {
      return numeric > 0 && numeric < 100_000_000_000 ? numeric * 1000 : numeric
    }

    // Perplexity's UTC timestamps can omit the timezone designator. Treat
    // those values as UTC, matching the provider's history API semantics,
    // instead of interpreting them in the machine's local timezone.
    const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) ? value : `${value}Z`
    const parsed = Date.parse(normalized)
    if (Number.isFinite(parsed)) return parsed
  }

  return fallback
}

function isPerplexityConversation(value: unknown): value is PerplexityConversation {
  if (!isRecord(value)) return false
  return nonBlankString(value.context_uuid) !== null && Array.isArray(value.entries)
}

/**
 * Convert a Perplexity conversations export into normalised memory records.
 * Invalid conversations/entries are skipped so one incomplete record does not
 * discard otherwise valid history from the same export.
 */
export function parsePerplexityConversations(raw: unknown): SerializableMemoryRecord[] {
  if (!isRecord(raw) || !Array.isArray((raw as PerplexityExport).conversations)) {
    throw new Error('Not a valid Perplexity export (expected { conversations: [...] })')
  }

  const conversations = (raw as PerplexityExport).conversations as unknown[]
  if (conversations.length > 0 && !conversations.some(isPerplexityConversation)) {
    throw new Error('Not a valid Perplexity export (expected Perplexity conversation records)')
  }

  const records: SerializableMemoryRecord[] = []
  const now = Date.now()

  for (const rawConversation of conversations) {
    if (!isPerplexityConversation(rawConversation)) continue

    const contextUuid = nonBlankString(rawConversation.context_uuid)
    if (!contextUuid) continue

    const sessionId = `perplexity:${contextUuid}`
    const title = nonBlankString(rawConversation.context_title) ?? ''
    const conversationTimestamp = rawConversation.created_at

    for (const rawEntry of rawConversation.entries) {
      if (!isRecord(rawEntry)) continue

      const entryId = nonBlankString(rawEntry.entry_uuid)
      if (!entryId) continue

      const query = nonBlankString(rawEntry.query)
      const answer = nonBlankString(rawEntry.answer)
      if (!query && !answer) continue

      const conversationTimestampMs = parsePerplexityTimestamp(conversationTimestamp, now)
      const timestamp = parsePerplexityTimestamp(rawEntry.created_at, conversationTimestampMs)
      const metadata = {
        source: 'perplexity-export',
        fromHistory: true,
        conversationTitle: title,
      }

      if (query) {
        records.push({
          id: `perplexity-import-${entryId}-user`,
          role: 'user',
          content: query,
          provider: 'perplexity',
          sessionId,
          timestamp,
          createdAt: timestamp,
          isPartial: false,
          isDeleted: false,
          isSuperseded: false,
          metadata,
        })
      }

      if (answer) {
        records.push({
          id: `perplexity-import-${entryId}-assistant`,
          role: 'assistant',
          content: answer,
          provider: 'perplexity',
          sessionId,
          timestamp: timestamp + 1,
          createdAt: timestamp + 1,
          isPartial: false,
          isDeleted: false,
          isSuperseded: false,
          metadata,
        })
      }
    }
  }

  return records
}

class PerplexityConversationImporter implements IConversationImporter {
  readonly id = 'perplexity'
  readonly displayName = 'Perplexity (conversations.json)'
  readonly provider = 'perplexity' as const

  canHandle(raw: unknown): boolean {
    if (!isRecord(raw) || !Array.isArray((raw as PerplexityExport).conversations)) return false

    const conversations = (raw as PerplexityExport).conversations as unknown[]
    // An empty conversations array is a valid, structurally identifiable
    // Perplexity export. Non-empty files need Perplexity-only context/entries
    // fields so a Grok export is not accidentally claimed by this importer.
    return conversations.length === 0 || conversations.some(isPerplexityConversation)
  }

  parse(raw: unknown): SerializableMemoryRecord[] {
    return parsePerplexityConversations(raw)
  }
}

registerImporter(new PerplexityConversationImporter())
