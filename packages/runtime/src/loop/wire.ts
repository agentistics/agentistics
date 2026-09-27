/**
 * loop/wire.ts — PURE. The catalogue's names (`file.read`, `shell.start`) are namespaced with dots,
 * and both Anthropic and OpenAI reject a tool name outside `^[a-zA-Z0-9_-]{1,64}$`. So the loop
 * declares every tool under a WIRE name and maps the model's call back to the catalogue name on the
 * way in.
 *
 * The mapping is `.` → `__` and any other disallowed character → `_`. It is not required to be
 * invertible by string manipulation — the loop keeps both directions in a table — but it IS required
 * to be injective over the tools of one run, so two tools can never answer to the same wire name.
 * That is checked when the table is built, and a catalogue that collides (or repeats a name, or
 * produces a wire name longer than 64 characters) is REFUSED in words before any model call: a call
 * routed to the wrong tool would be an effect the policy judged under another tool's name.
 */

import type { ProviderToolDecl } from '../provider/client.ts'
import type { Tool } from '../tools/contract.ts'

export const WIRE_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/

export function toWireName(name: string): string {
  return name.replaceAll('.', '__').replace(/[^a-zA-Z0-9_-]/g, '_')
}

export interface WireTable {
  /** wire name → tool */
  byWire: ReadonlyMap<string, Tool<unknown>>
  /** catalogue name → wire name */
  wireOf: ReadonlyMap<string, string>
  decls: ProviderToolDecl[]
}

export type WireTableResult = { ok: true; table: WireTable } | { ok: false; sentence: string }

export function buildWireTable(tools: readonly Tool<unknown>[]): WireTableResult {
  const byWire = new Map<string, Tool<unknown>>()
  const wireOf = new Map<string, string>()
  const decls: ProviderToolDecl[] = []
  for (const tool of tools) {
    if (wireOf.has(tool.name)) {
      return { ok: false, sentence: `The tool catalogue names "${tool.name}" twice, so the run was not started.` }
    }
    const wire = toWireName(tool.name)
    if (!WIRE_NAME_PATTERN.test(wire)) {
      return { ok: false, sentence: `The tool "${tool.name}" has no name a provider accepts (at most 64 letters, digits, "_" or "-"), so the run was not started.` }
    }
    const clash = byWire.get(wire)
    if (clash) {
      return { ok: false, sentence: `The tools "${clash.name}" and "${tool.name}" would reach the model under the same name "${wire}", so the run was not started.` }
    }
    byWire.set(wire, tool)
    wireOf.set(tool.name, wire)
    decls.push({ name: wire, description: tool.description, inputSchema: tool.inputSchema })
  }
  return { ok: true, table: { byWire, wireOf, decls } }
}
