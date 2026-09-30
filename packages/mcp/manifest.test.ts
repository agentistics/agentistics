import { describe, expect, it } from 'bun:test'
import { buildAgentManifest } from '@agentistics/core'
import { describeManifest, filterToolsByManifest, parseManifest, withheldReason } from './manifest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(import.meta.dir, 'agentistics-mcp.ts'), 'utf8')
const TOOLS = [...SRC.slice(SRC.indexOf('const TOOLS'), SRC.indexOf('server.setRequestHandler(ListToolsRequestSchema'))
  .matchAll(/name:\s*["'`](agentistics_\w+)["'`]/g)].map((m) => ({ name: m[1]! }))

const ALL_ON = { localShell: true, localChat: true, localTranscripts: true, localProcesses: true, mcpAdmin: true }
const ALL_OFF = { localShell: false, localChat: false, localTranscripts: false, localProcesses: false, mcpAdmin: false }

/** A manifest from the REAL server-side builder, round-tripped through JSON as the wire carries it. */
const wire = (m: ReturnType<typeof buildAgentManifest>) => parseManifest(JSON.parse(JSON.stringify(m)))

const solo = wire(buildAgentManifest({ profile: 'local', central: false, capabilities: ALL_ON, gates: { chat: true, shell: true, editor: true } }))
const central = wire(buildAgentManifest({ profile: 'lan', central: true, capabilities: ALL_OFF, gates: { chat: false, shell: false, editor: false } }))

describe('the MCP lists only what the manifest allows', () => {
  it('a manifest that withholds one tool drops exactly that tool from the list', () => {
    expect(solo).not.toBeNull()
    const listed = filterToolsByManifest(TOOLS, solo).map((t) => t.name)
    expect(TOOLS.map((t) => t.name).filter((n) => !listed.includes(n))).toEqual(['agentistics_team_members'])
  })

  it('on a central the host tools are not listed, and agentistics_capabilities still is', () => {
    const listed = new Set(filterToolsByManifest(TOOLS, central).map((t) => t.name))
    expect(listed.has('agentistics_tasks')).toBe(false)
    expect(listed.has('agentistics_session_groups')).toBe(false)
    expect(listed.has('agentistics_summary')).toBe(true)
    expect(listed.has('agentistics_team_members')).toBe(true)
    expect(listed.has('agentistics_capabilities')).toBe(true)
  })

  it('no manifest withholds nothing — the MCP never invents a policy', () => {
    expect(filterToolsByManifest(TOOLS, null)).toEqual(TOOLS)
    expect(parseManifest({ error: 'Not found' })).toBeNull()
    expect(parseManifest({ version: 2, tools: [] })).toBeNull()
    expect(parseManifest({ version: 1, tools: [{ name: 'x' }] })).toBeNull()
  })

  it('a tool the manifest does not name stays listed', () => {
    expect(filterToolsByManifest([{ name: 'agentistics_future' }], solo)).toEqual([{ name: 'agentistics_future' }])
    expect(withheldReason(solo, 'agentistics_future')).toBeNull()
  })
})

describe('agentistics_capabilities says it in words', () => {
  it('names every withheld tool with its reason', () => {
    const text = describeManifest(central)
    expect(text).toContain('This machine is a central')
    for (const t of central!.tools.filter((t) => !t.available)) expect(text).toContain(`- ${t.name}: ${t.withheld!.reason}`)
  })

  it('says when nothing is reported, instead of claiming everything works', () => {
    expect(describeManifest(null)).toContain('did not report a capability manifest')
  })
})
