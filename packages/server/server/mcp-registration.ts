import { AGENTISTICS_DATA_DIR, DEFAULT_AGENTISTICS_DATA_DIR, HOME_DIR, WEB_PORT } from './config'
import { accountHome } from './account-home'

export interface McpRegistrationFacts {
  port: number
  webPort: number
  home: string
  dataDir: string
  defaultHome: string
  defaultDataDir: string
  explicitHome?: boolean
  explicitDataDir?: boolean
}

export interface McpRegistrationDecision {
  allowed: boolean
  reason?: string
}

/** Only the user's canonical, default server may mutate user-scope harness config. */
export function mcpRegistrationDecision(facts: McpRegistrationFacts): McpRegistrationDecision {
  if (facts.port !== 47291 || facts.webPort !== 47292) {
    return { allowed: false, reason: `non-default ports (${facts.port}/${facts.webPort})` }
  }
  if (facts.explicitHome || facts.home !== facts.defaultHome) {
    return { allowed: false, reason: 'non-default HOME' }
  }
  if (facts.explicitDataDir || facts.dataDir !== facts.defaultDataDir) {
    return { allowed: false, reason: 'non-default AGENTISTICS_DIR' }
  }
  return { allowed: true }
}

let refusalLogged = false

export function mayRegisterHarnessMcp(port: number): boolean {
  const decision = mcpRegistrationDecision({
    port,
    webPort: WEB_PORT,
    home: HOME_DIR,
    dataDir: AGENTISTICS_DATA_DIR,
    defaultHome: accountHome(),
    defaultDataDir: DEFAULT_AGENTISTICS_DATA_DIR,
    explicitHome: HOME_DIR !== accountHome(),
    explicitDataDir: Boolean(process.env.AGENTISTICS_DIR),
  })
  if (!decision.allowed && !refusalLogged) {
    refusalLogged = true
    console.info(`[mcp] harness registration skipped: ${decision.reason}`)
  }
  return decision.allowed
}
