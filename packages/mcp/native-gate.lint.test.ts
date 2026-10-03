/**
 * The native harness and the providers are experimental (owner decision 2026-10-03). The MCP offers
 * no native or provider tool and reaches no native route: its figures come from the server's
 * `/api/runtime/metrics`, which leaves the native harness out while the flag is off (`native-gate.ts`).
 * This guard keeps it that way — a tool that called a native route directly would bypass the gate.
 */
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { HARNESS_ORDER } from '@agentistics/core'

describe('MCP: no native or provider surface of its own', () => {
  test('no source names a native or provider route; the harness enum has no native harness', () => {
    for (const f of readdirSync(import.meta.dir).filter(n => n.endsWith('.ts') && !n.endsWith('.test.ts'))) {
      const src = readFileSync(join(import.meta.dir, f), 'utf8')
      expect(src.includes('/api/runtime/sessions')).toBe(false)
      expect(src.includes('/api/provider')).toBe(false)
    }
    expect((HARNESS_ORDER as readonly string[]).includes('agentistics')).toBe(false)
  })
})
