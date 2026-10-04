/**
 * The native harness and the providers are experimental (owner decision 2026-10-03). The MCP offers
 * no native or provider tool and reaches no native route: its figures come from the server's
 * `/api/data` and `/api/runtime/metrics`, which leave the native harness out while the flag is off
 * (`native-gate.ts`).
 * This guard keeps it that way — a tool that called a native route directly would bypass the gate.
 */
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SURFACE_HARNESS_ORDER } from '@agentistics/core'
import { harnessParam } from './session-tokens'

describe('MCP: no native or provider surface of its own', () => {
  test('no source names a native or provider route', () => {
    for (const f of readdirSync(import.meta.dir).filter(n => n.endsWith('.ts') && !n.endsWith('.test.ts'))) {
      const src = readFileSync(join(import.meta.dir, f), 'utf8')
      expect(src.includes('/api/runtime/sessions')).toBe(false)
      expect(src.includes('/api/provider')).toBe(false)
    }
  })
  // NATIVE.SURF: the harness enum NAMES the native harness — its sessions reach the MCP only through
  // `/api/data` and `/api/runtime/metrics`, which leave them out while the flag is off, so the gate is
  // the server's and a name in an enum opens nothing.
  test('the harness enum lists every surface harness, the native one included', () => {
    expect(harnessParam().enum).toEqual(['all', ...SURFACE_HARNESS_ORDER])
    expect((harnessParam().enum as readonly string[]).includes('agentistics')).toBe(true)
  })
})
