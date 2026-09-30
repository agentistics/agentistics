/**
 * replay-core.test.ts — the native hash is core's hash, byte for byte.
 *
 * `replay-core.ts` computes event ids and entity ids with `node:crypto` instead of core's
 * dependency-free `sha256Hex` (A1.7, a first-ingest cost). An id that changed would make every
 * replayed event a NEW row beside the old one in any existing journal — so the two are pinned equal
 * here over every class of input that could make them diverge.
 */
import { describe, expect, test } from 'bun:test'
import { deriveEventId, sha256Hex, type EventIdInput } from '@agentistics/core'
import { claudeEventId, sha256HexNative } from './replay-core'

const TEXTS = [
  '',
  'a',
  'abc',
  'claude:3f5f21a8-b0c1-4d2e-9a7b-000000000000:1234',
  'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(63), 'x'.repeat(64), 'x'.repeat(65), 'x'.repeat(10_000),
  'ação — sessão ñ ü 日本語',
  '😀 astral 𝄞',
  'lone high \uD800 end',
  'lone low \uDC00 end',
  'reversed pair \uDC00\uD800',
  '\u0000 nul \u0001',
  JSON.stringify(['agentistics.claude-entity/v1', 'tool', 'conv', 'toolu_01ABC']),
]

describe('sha256HexNative', () => {
  test('equals core sha256Hex on every input class, lone surrogates included', () => {
    for (const t of TEXTS) expect(sha256HexNative(t)).toBe(sha256Hex(t))
  })

  test('equals core sha256Hex on random strings over the whole UTF-16 range', () => {
    let seed = 7
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31
    for (let i = 0; i < 500; i++) {
      let s = ''
      const len = Math.floor(rnd() * 200)
      for (let k = 0; k < len; k++) s += String.fromCharCode(Math.floor(rnd() * 0x10000))
      expect(sha256HexNative(s)).toBe(sha256Hex(s))
    }
  })
})

describe('claudeEventId', () => {
  test('equals deriveEventId on both key paths', () => {
    const inputs: EventIdInput[] = [
      { sourceKind: 'harness', sourceId: 'claude', sourceRef: 'claude:c1:7', type: 'tool.requested' },
      { sourceKind: 'harness', sourceId: 'claude', sourceRef: 'claude:c1:7', type: 'tool.requested', ordinal: 3 },
      { sourceKind: 'harness', sourceId: 'claude', sourceRef: 'claude:c1:9', type: 'model.completed', providerRequestId: 'msg_01XYZ' },
      { sourceKind: 'harness', sourceId: 'claude', sourceRef: 'claude:c1:9', type: 'model.invoked', providerRequestId: '' },
      { sourceKind: 'harness', sourceId: 'claude', sourceRef: 'claude:c1/subagents/a\uD800:1', type: 'agent.ended' },
    ]
    for (const i of inputs) expect(claudeEventId(i)).toBe(deriveEventId(i))
  })
})
