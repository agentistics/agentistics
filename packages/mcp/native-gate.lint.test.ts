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
import { HARNESS_ORDER, SURFACE_HARNESS_ORDER } from '@agentistics/core'
import { harnessParam, toolsForGate } from './session-tokens'

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
  test('the harness enum names the native harness ONLY while the native runtime is visible', () => {
    expect(harnessParam(true).enum).toEqual(['all', ...SURFACE_HARNESS_ORDER])
    expect(harnessParam(false).enum).toEqual(['all', ...HARNESS_ORDER])
    expect((harnessParam(false).enum as readonly string[]).includes('agentistics')).toBe(false)
  })
  test('ListTools re-derives every harness parameter for the gate, hidden included', () => {
    const tools = [
      { name: 'a', inputSchema: { type: 'object', properties: { harness: harnessParam(true) } } },
      { name: 'b', inputSchema: { type: 'object', properties: {} } },
    ]
    const off = toolsForGate(tools, false)
    expect((off[0]!.inputSchema.properties as { harness: { enum: string[] } }).harness.enum.includes('agentistics')).toBe(false)
    expect(off[1]).toBe(tools[1]!)
    const on = toolsForGate(tools, true)
    expect((on[0]!.inputSchema.properties as { harness: { enum: string[] } }).harness.enum.includes('agentistics')).toBe(true)
  })
  test('the server never lists tools before asking the gate', () => {
    const src = readFileSync(join(import.meta.dir, 'agentistics-mcp.ts'), 'utf8')
    expect(src).toContain('toolsForGate(TOOLS, await nativeVisibleNow())')
    expect(src).not.toMatch(/ListToolsRequestSchema,\s*async \(\) => \(\{ tools: TOOLS \}\)/)
  })
})
