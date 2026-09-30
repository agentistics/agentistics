/**
 * Reading `GET /api/agent/manifest` (MCP spec P1.3) on the MCP side: which tools to LIST, and the
 * manifest read back in words for `agentistics_capabilities`.
 *
 * Pure, and deliberately free of `@agentistics/core`: this package is published standalone, so the
 * shape is restated here and validated rather than imported. The server decides every rule; this
 * module only applies the answer.
 *
 * An absent manifest (an older server with no route, or one that cannot be reached) withholds
 * NOTHING. Hiding tools on a guess would be the MCP inventing a policy; the server still refuses
 * whatever it refuses, and says so.
 */

export interface ManifestTool {
  name: string
  risk: string
  available: boolean
  withheld?: { code: string; reason: string; capability?: string }
}

export interface AgentManifest {
  version: 1
  profile: string
  central: boolean
  capabilities: Record<string, boolean>
  gates: { chat: boolean; shell: boolean; editor: boolean }
  allowances: unknown[]
  tools: ManifestTool[]
}

/** The body as a manifest, or null when it is not one this MCP understands. */
export function parseManifest(body: unknown): AgentManifest | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Partial<AgentManifest>
  if (b.version !== 1 || !Array.isArray(b.tools)) return null
  if (!b.tools.every((t) => t && typeof t.name === 'string' && typeof t.available === 'boolean')) return null
  return b as AgentManifest
}

/** The manifest's reason for withholding `name`, or null when it may be used (or nobody said). */
export function withheldReason(manifest: AgentManifest | null, name: string): string | null {
  const row = manifest?.tools.find((t) => t.name === name)
  if (!row || row.available) return null
  return row.withheld?.reason ?? 'withheld by this machine'
}

/** The tools to list: every tool the manifest does not withhold. A tool it does not name is kept. */
export function filterToolsByManifest<T extends { name: string }>(tools: readonly T[], manifest: AgentManifest | null): T[] {
  return tools.filter((t) => withheldReason(manifest, t.name) === null)
}

const onOff = (v: boolean) => (v ? 'on' : 'off')

/** The manifest in words — what `agentistics_capabilities` answers. */
export function describeManifest(manifest: AgentManifest | null): string {
  if (!manifest) {
    return 'This agentistics server did not report a capability manifest (it is older than this MCP, or unreachable). Every tool is listed; the server still refuses whatever it does not allow, with a reason.'
  }
  const lines: string[] = []
  lines.push(
    manifest.central
      ? `This machine is a central (exposure profile "${manifest.profile}"). Host tools — the task board, session folders, the fleet — are not reachable here.`
      : `This machine is not a central (exposure profile "${manifest.profile}").`,
  )
  const caps = Object.entries(manifest.capabilities).map(([k, v]) => `${k} ${onOff(v)}`).join(', ')
  lines.push(`Host capabilities: ${caps}.`)
  lines.push(`Switches: chat ${onOff(manifest.gates.chat)}, shell ${onOff(manifest.gates.shell)}, editor ${onOff(manifest.gates.editor)}.`)
  lines.push(manifest.allowances.length ? `Standing allowances in force: ${manifest.allowances.length}.` : 'No standing allowances are in force.')
  const available = manifest.tools.filter((t) => t.available)
  const withheld = manifest.tools.filter((t) => !t.available)
  lines.push(`Available tools: ${available.length} of ${manifest.tools.length}.`)
  if (withheld.length === 0) lines.push('Nothing is withheld.')
  else {
    lines.push('Withheld, and why:')
    for (const t of withheld) lines.push(`- ${t.name}: ${t.withheld?.reason ?? 'withheld by this machine'}`)
  }
  return lines.join('\n')
}
