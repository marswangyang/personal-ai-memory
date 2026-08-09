import { describe, it, expect, vi, afterEach } from 'vitest'
import { IMPORTERS } from '../../../src/importers/index'
import {
  parsePerplexityConversations,
  parsePerplexityTimestamp,
} from '../../../src/importers/perplexityConversations'

const importer = IMPORTERS.find((candidate) => candidate.id === 'perplexity')!

const syntheticExport = {
  conversations: [
    {
      context_uuid: 'synthetic-context-alpha',
      context_title: 'Anonymized research chat',
      created_at: '2025-03-04T10:11:12.000Z',
      updated_at: '2025-03-04T10:12:14.000Z',
      mode: 'concise',
      collection_uuid: 'synthetic-collection',
      entries: [
        {
          entry_uuid: 'synthetic-entry-one',
          query: 'What is a synthetic example?',
          answer: 'It is an example created for testing.',
          created_at: '2025-03-04T10:11:13.000Z',
          label: 'Synthetic label',
          query_status: 'completed',
        },
        {
          entry_uuid: 'synthetic-entry-two',
          query: 'Can it contain several turns?',
          answer: 'Yes, this export contains several turns.',
          created_at: '2025-03-04T10:11:14.000Z',
          label: null,
          query_status: 'completed',
        },
      ],
    },
    {
      context_uuid: 'synthetic-context-beta',
      context_title: 'Second anonymized chat',
      created_at: '2025-03-05T09:00:00.000Z',
      updated_at: '2025-03-05T09:01:00.000Z',
      mode: 'pro',
      collection_uuid: null,
      entries: [
        {
          entry_uuid: 'synthetic-entry-three',
          query: 'A query without an answer yet',
          answer: '',
          created_at: '2025-03-05T09:00:01.000Z',
          label: 'Pending',
          query_status: 'pending',
        },
      ],
    },
  ],
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('parsePerplexityTimestamp', () => {
  it('parses ISO timestamps', () => {
    expect(parsePerplexityTimestamp('2025-03-04T10:11:12.000Z')).toBe(
      Date.parse('2025-03-04T10:11:12.000Z'),
    )
  })

  it('treats timezone-less provider timestamps as UTC', () => {
    expect(parsePerplexityTimestamp('2025-03-04T10:11:12.000')).toBe(
      Date.parse('2025-03-04T10:11:12.000Z'),
    )
  })

  it('supports epoch seconds and milliseconds', () => {
    expect(parsePerplexityTimestamp(1_700_000_000)).toBe(1_700_000_000_000)
    expect(parsePerplexityTimestamp(1_700_000_000_000)).toBe(1_700_000_000_000)
  })

  it('uses the supplied fallback for missing or invalid dates', () => {
    expect(parsePerplexityTimestamp(undefined, 1234)).toBe(1234)
    expect(parsePerplexityTimestamp('not-a-date', 5678)).toBe(5678)
  })
})

describe('parsePerplexityConversations — happy path', () => {
  it('parses multiple conversations and entries into user/assistant records', () => {
    const records = parsePerplexityConversations(syntheticExport)

    expect(records).toHaveLength(5)
    expect(records.map((record) => record.id)).toEqual([
      'perplexity-import-synthetic-entry-one-user',
      'perplexity-import-synthetic-entry-one-assistant',
      'perplexity-import-synthetic-entry-two-user',
      'perplexity-import-synthetic-entry-two-assistant',
      'perplexity-import-synthetic-entry-three-user',
    ])
  })

  it('maps fields, flags, metadata, and session IDs', () => {
    const records = parsePerplexityConversations(syntheticExport)
    const user = records[0]
    const assistant = records[1]

    expect(user).toMatchObject({
      id: 'perplexity-import-synthetic-entry-one-user',
      role: 'user',
      content: 'What is a synthetic example?',
      provider: 'perplexity',
      sessionId: 'perplexity:synthetic-context-alpha',
      timestamp: Date.parse('2025-03-04T10:11:13.000Z'),
      createdAt: Date.parse('2025-03-04T10:11:13.000Z'),
      isPartial: false,
      isDeleted: false,
      isSuperseded: false,
      metadata: {
        source: 'perplexity-export',
        fromHistory: true,
        conversationTitle: 'Anonymized research chat',
      },
    })
    expect(assistant).toMatchObject({
      id: 'perplexity-import-synthetic-entry-one-assistant',
      role: 'assistant',
      content: 'It is an example created for testing.',
      timestamp: Date.parse('2025-03-04T10:11:13.000Z') + 1,
      createdAt: Date.parse('2025-03-04T10:11:13.000Z') + 1,
    })
  })

  it('keeps IDs stable and distinct for repeated parsing and roles', () => {
    const first = parsePerplexityConversations(syntheticExport)
    const second = parsePerplexityConversations(syntheticExport)

    expect(first.map((record) => record.id)).toEqual(second.map((record) => record.id))
    expect(new Set(first.map((record) => record.id)).size).toBe(first.length)
    expect(first[0].id).not.toBe(first[1].id)
  })
})

describe('parsePerplexityConversations — filtering and fallback', () => {
  it('skips blank query and answer values and entries without IDs', () => {
    const records = parsePerplexityConversations({
      conversations: [
        {
          context_uuid: 'synthetic-context',
          entries: [
            { entry_uuid: 'blank-entry', query: '  ', answer: '\n' },
            { entry_uuid: '', query: 'Should be skipped', answer: 'Also skipped' },
            { query: 'Missing entry ID', answer: 'Missing ID answer' },
            { entry_uuid: 'query-only', query: 'Retained query', answer: null },
            { entry_uuid: 'answer-only', query: null, answer: 'Retained answer' },
          ],
        },
      ],
    })

    expect(records).toHaveLength(2)
    expect(records.map((record) => record.content)).toEqual(['Retained query', 'Retained answer'])
    expect(records.map((record) => record.role)).toEqual(['user', 'assistant'])
  })

  it('uses a numeric fallback timestamp when entry and conversation dates are invalid', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_900_000_000_000)
    const records = parsePerplexityConversations({
      conversations: [
        {
          context_uuid: 'synthetic-context',
          created_at: 'invalid-conversation-date',
          entries: [
            { entry_uuid: 'fallback-entry', query: 'Fallback timestamp', answer: 'Answer', created_at: 'invalid-entry-date' },
          ],
        },
      ],
    })

    expect(records[0].timestamp).toBe(1_900_000_000_000)
    expect(records[1].timestamp).toBe(1_900_000_000_001)
  })

  it('falls back to the conversation timestamp when an entry date is invalid', () => {
    const records = parsePerplexityConversations({
      conversations: [
        {
          context_uuid: 'synthetic-context',
          created_at: '2025-04-01T00:00:00.000Z',
          entries: [
            { entry_uuid: 'conversation-fallback', query: 'Uses conversation date', created_at: 'invalid' },
          ],
        },
      ],
    })

    expect(records[0].timestamp).toBe(Date.parse('2025-04-01T00:00:00.000Z'))
  })

  it('returns an empty list for a valid empty export', () => {
    expect(parsePerplexityConversations({ conversations: [] })).toEqual([])
  })
})

describe('Perplexity importer detection', () => {
  it('recognizes Perplexity structure and leaves Grok structure to Grok', () => {
    expect(importer).toBeDefined()
    expect(importer.canHandle({ conversations: [] })).toBe(true)
    expect(importer.canHandle(syntheticExport)).toBe(true)
    expect(importer.canHandle({
      conversations: [
        {
          conversation: { id: 'synthetic-grok-conversation' },
          responses: [],
        },
      ],
    })).toBe(false)
    expect(importer.canHandle({ conversations: 'not-an-array' })).toBe(false)
    expect(importer.canHandle(null)).toBe(false)
  })
})

describe('parsePerplexityConversations — invalid input', () => {
  it('throws when the root shape is not a Perplexity export', () => {
    expect(() => parsePerplexityConversations({})).toThrow()
    expect(() => parsePerplexityConversations(null)).toThrow()
    expect(() => parsePerplexityConversations({ conversations: 'not-an-array' })).toThrow()
  })

  it('throws when a nonempty conversations array has only Grok-shaped records', () => {
    expect(() => parsePerplexityConversations({
      conversations: [
        {
          conversation: { id: 'synthetic-grok-conversation' },
          responses: [],
        },
      ],
    })).toThrow('Not a valid Perplexity export')
  })
})
