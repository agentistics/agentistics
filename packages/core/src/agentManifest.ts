/**
 * The agent MANIFEST — what this machine's agent may use right now, and why the rest is withheld.
 *
 * Spec: docs/superpowers/specs/2026-09-29-mcp-coverage-design.md §4.7 (listing) and §6 P1.3. The
 * server answers `GET /api/agent/manifest` with `buildAgentManifest(...)`; the MCP lists only the
 * tools marked available, and `agentistics_capabilities` reads the withheld ones back in words.
 *
 * Pure, and derived ONLY from the P1.1 policy table plus the facts the server already holds (the
 * exposure profile, `CAPS`, whether this is a central, the preference gates). It invents no rule of
 * its own: a tool is withheld exactly when its row says it cannot work here — `central: 'refuse'` on
 * a central, `central: 'only'` off one, or a `capability` the profile has switched off. An absent
 * tool with no sentence beside it is the same failure as a confident zero, so every withheld row
 * carries a code AND a reason.
 */
import {
  AGENT_TOOL_NAMES,
  AGENT_TOOL_POLICY,
  type AgentCapability,
  type AgentToolName,
  type AgentToolRisk,
} from './agentToolPolicy'

export type AgentProfile = 'local' | 'lan' | 'public'

export interface AgentManifestInput {
  profile: AgentProfile
  central: boolean
  /** `CAPS` from `exposure.ts`, narrowed to the switches a tool row can name. */
  capabilities: Record<AgentCapability, boolean>
  /**
   * The preference gates, each already resolved against its capability (`chatAllowed`,
   * `shellAllowedNow`, `editorAllowed`). No tool depends on one yet; they are reported so an agent
   * can say why a surface it knows about is off.
   */
  gates: { chat: boolean; shell: boolean; editor: boolean }
}

export type AgentWithheldCode = 'central' | 'not-central' | 'capability'

export interface AgentManifestTool {
  name: AgentToolName
  risk: AgentToolRisk
  available: boolean
  /** Present exactly when `available` is false. */
  withheld?: { code: AgentWithheldCode; reason: string; capability?: AgentCapability }
}

export interface AgentManifest {
  /** Bumped when the shape changes, so an MCP can tell an older server from a malformed answer. */
  version: 1
  profile: AgentProfile
  central: boolean
  capabilities: Record<AgentCapability, boolean>
  gates: { chat: boolean; shell: boolean; editor: boolean }
  /** Standing allowances in force (§4.4). None exist before P3.1, so this is always empty. */
  allowances: readonly never[]
  tools: AgentManifestTool[]
}

const CAPABILITY_WORDS: Record<AgentCapability, string> = {
  localShell: 'host actions (the task board, session folders, the fleet)',
  localChat: 'running an assistant on the host',
  localTranscripts: 'reading this host\'s raw transcripts',
  localProcesses: 'reading this host\'s process list',
  mcpAdmin: 'administering MCP servers',
}

/** Why a row cannot work here, or null when it can. The first applicable reason wins. */
export function withheldFor(
  name: AgentToolName,
  input: Pick<AgentManifestInput, 'profile' | 'central' | 'capabilities'>,
): AgentManifestTool['withheld'] | null {
  const p = AGENT_TOOL_POLICY[name]
  if (p.central === 'refuse' && input.central) {
    return { code: 'central', reason: 'this machine is a central: host tools are not reachable here' }
  }
  if (p.central === 'only' && !input.central) {
    return { code: 'not-central', reason: 'this machine is not a central: there is no team roster here' }
  }
  if (p.capability && !input.capabilities[p.capability]) {
    return {
      code: 'capability',
      capability: p.capability,
      reason: `the "${input.profile}" exposure profile switches off ${CAPABILITY_WORDS[p.capability]}`,
    }
  }
  return null
}

export function buildAgentManifest(input: AgentManifestInput): AgentManifest {
  const tools = AGENT_TOOL_NAMES.map((name): AgentManifestTool => {
    const withheld = withheldFor(name, input)
    const risk = AGENT_TOOL_POLICY[name].risk
    return withheld ? { name, risk, available: false, withheld } : { name, risk, available: true }
  })
  return {
    version: 1,
    profile: input.profile,
    central: input.central,
    capabilities: { ...input.capabilities },
    gates: { ...input.gates },
    allowances: [],
    tools,
  }
}
