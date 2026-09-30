import { describe, expect, it } from 'bun:test'
import { buildAgentManifest, type AgentManifestInput } from './agentManifest'
import { AGENT_TOOL_NAMES, AGENT_TOOL_POLICY } from './agentToolPolicy'

const ALL_ON = { localShell: true, localChat: true, localTranscripts: true, localProcesses: true, mcpAdmin: true }
const ALL_OFF = { localShell: false, localChat: false, localTranscripts: false, localProcesses: false, mcpAdmin: false }
const GATES = { chat: false, shell: true, editor: true }

const local: AgentManifestInput = { profile: 'local', central: false, capabilities: ALL_ON, gates: GATES }
const central: AgentManifestInput = { profile: 'lan', central: true, capabilities: ALL_OFF, gates: { chat: false, shell: false, editor: false } }

const byName = (m: ReturnType<typeof buildAgentManifest>) => new Map(m.tools.map((t) => [t.name, t]))

describe('buildAgentManifest', () => {
  it('has one row per policy row, in the table order', () => {
    expect(buildAgentManifest(local).tools.map((t) => t.name)).toEqual([...AGENT_TOOL_NAMES])
  })

  it('a solo machine withholds only the central-only tools, and says why', () => {
    const withheld = buildAgentManifest(local).tools.filter((t) => !t.available)
    expect(withheld.map((t) => t.name)).toEqual(['agentistics_team_members'])
    expect(withheld[0]!.withheld).toMatchObject({ code: 'not-central' })
    expect(withheld[0]!.withheld!.reason.length).toBeGreaterThan(0)
  })

  it('a central withholds every host tool and keeps the reads that work there', () => {
    const m = byName(buildAgentManifest(central))
    for (const name of AGENT_TOOL_NAMES) {
      const row = m.get(name)!
      expect(row.available, name).toBe(AGENT_TOOL_POLICY[name].central !== 'refuse')
      if (AGENT_TOOL_POLICY[name].central === 'refuse') expect(row.withheld!.code, name).toBe('central')
    }
    expect(m.get('agentistics_team_members')!.available).toBe(true)
  })

  it('a profile that switches off a capability withholds its tools and names it', () => {
    const m = byName(buildAgentManifest({ ...local, profile: 'public', capabilities: { ...ALL_ON, localShell: false } }))
    expect(m.get('agentistics_tasks')).toMatchObject({ available: false, withheld: { code: 'capability', capability: 'localShell' } })
    expect(m.get('agentistics_tasks')!.withheld!.reason).toContain('"public"')
    expect(m.get('agentistics_summary')!.available).toBe(true)
  })

  it('agentistics_capabilities is always available — it is how a withheld tool gets explained', () => {
    for (const input of [local, central]) expect(byName(buildAgentManifest(input)).get('agentistics_capabilities')!.available).toBe(true)
  })

  it('carries the facts it was built from, and no allowances before P3', () => {
    const m = buildAgentManifest(central)
    expect(m).toMatchObject({ version: 1, profile: 'lan', central: true, capabilities: ALL_OFF, allowances: [] })
    expect(m.gates).toEqual({ chat: false, shell: false, editor: false })
  })

  it('an available row carries no withheld field', () => {
    for (const t of buildAgentManifest(local).tools) if (t.available) expect(t.withheld, t.name).toBeUndefined()
  })
})
