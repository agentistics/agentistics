/**
 * billing-detect.ts — the impure half of billing detection: read the files, extract the whitelist,
 * hand the result to the pure `detectBilling` in @agentistics/core.
 *
 * Same split as `codex.ts` / `codex-parse.ts`: all filesystem contact lives here, all reasoning
 * lives in the pure module, and this file holds no logic worth testing beyond "did it extract the
 * right fields, and only those".
 *
 * ── THIS MODULE IS A NARROW WINDOW ONTO SENSITIVE FILES ──────────────────────────────────────
 * The files it opens are the most sensitive this product touches. Besides the plan facts, they
 * hold live OAuth secrets, the user's mail address, and the identifiers of their account and
 * organization. NONE of those may be read, copied, logged, audited or returned, and none of their
 * field names appears anywhere in this file — `billing-detect.test.ts` reads this module's own
 * source and fails if one does. A field this module cannot name is a field it cannot leak.
 *
 * The narrow `BillingSignals` type is the contract; `pick()` below is the only place a value
 * crosses from a parsed file into it, and it takes a fixed list of keys rather than an object.
 *
 * Anthropic's key variable is reduced to the literal `'set'` on the way in: its PRESENCE is the
 * signal and its value is a credential we have no reason to hold, not even in memory.
 *
 * On macOS the credentials file does not exist — that data lives in the login Keychain. This
 * module does NOT shell out to `security` to reach it: probing the Keychain raises a system
 * prompt, and a metrics dashboard has no business asking someone to unlock their keychain. An
 * absent signal is simply absent, and the chain falls through to the next one.
 *
 * ── EXPOSURE ────────────────────────────────────────────────────────────────────────────────
 * The route is registered in `capability-guard.ts` under `localTranscripts`. Detection describes
 * ONE machine's own configuration, and the result must never enter an audit event.
 */

import { safeReadJson } from './utils'
import {
  CLAUDE_CREDENTIALS_FILE,
  CLAUDE_JSON_FILE,
  CLAUDE_SETTINGS_FILE,
  CLAUDE_SETTINGS_LOCAL_FILE,
  STATS_CACHE_FILE,
  CODEX_AUTH_FILE,
} from './config'
import { detectBilling, detectCodexBilling } from '@agentistics/core'
import type { BillingDetection, BillingSignals, CodexSignals, HarnessId, StatsCache } from '@agentistics/core'

/** The env keys that indicate third-party routing. Their values are plain configuration. */
const ROUTING_KEYS = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'ANTHROPIC_BASE_URL'] as const
/** The key whose PRESENCE is a signal and whose value is a credential. */
const KEY_PRESENCE_ONLY = 'ANTHROPIC_API_KEY'

type SettingsShape = { env?: Record<string, unknown>; apiKeyHelper?: unknown }

/**
 * Copy exactly `keys` out of `source`, as strings, dropping anything absent or non-string.
 *
 * Deliberately takes a key list rather than spreading an object: a spread would carry whatever
 * the file happens to contain, which is the entire failure mode this module is written to avoid.
 */
function pick<K extends string>(
  source: Record<string, unknown> | undefined,
  keys: readonly K[],
): Partial<Record<K, string>> {
  const out: Partial<Record<K, string>> = {}
  if (!source) return out
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value !== '') out[key] = value
  }
  return out
}

/**
 * The env a Claude Code run would actually see: this process's environment, with the settings
 * files layered under it.
 *
 * Process env wins, matching Claude Code's own precedence — a user can be on Bedrock purely
 * through their shell rc with nothing in any settings file, and reading only the files would
 * confidently report a subscription for work Amazon is billing.
 */
function resolveEnv(files: readonly (SettingsShape | null)[]): Record<string, unknown> {
  const merged: Record<string, unknown> = {}
  for (const file of files) {
    if (file?.env && typeof file.env === 'object') Object.assign(merged, file.env)
  }
  Object.assign(merged, process.env)
  return merged
}

/** Read the four sources and extract the whitelist. Never throws: an unreadable or malformed
 *  file yields an absent signal, which the chain simply falls through. */
export async function readBillingSignals(): Promise<BillingSignals> {
  const [settings, settingsLocal, claudeJson, credentials, stats] = await Promise.all([
    safeReadJson<SettingsShape>(CLAUDE_SETTINGS_FILE),
    safeReadJson<SettingsShape>(CLAUDE_SETTINGS_LOCAL_FILE),
    safeReadJson<Record<string, unknown>>(CLAUDE_JSON_FILE),
    safeReadJson<Record<string, unknown>>(CLAUDE_CREDENTIALS_FILE),
    safeReadJson<StatsCache>(STATS_CACHE_FILE),
  ])

  // Project-scoped settings are deliberately not read: they belong to one repository, while a
  // billing period describes the machine.
  const env = resolveEnv([settings, settingsLocal])
  const routing = pick(env, ROUTING_KEYS)

  const signals: BillingSignals = {
    env: {
      ...routing,
      ...(typeof env[KEY_PRESENCE_ONLY] === 'string' && env[KEY_PRESENCE_ONLY] !== ''
        ? { [KEY_PRESENCE_ONLY]: 'set' as const }
        : {}),
    },
    hasApiKeyHelper:
      typeof settings?.apiKeyHelper === 'string' && settings.apiKeyHelper !== ''
        ? true
        : typeof settingsLocal?.apiKeyHelper === 'string' && settingsLocal.apiKeyHelper !== '',
  }

  const profile = claudeJson?.['oauthAccount']
  if (profile && typeof profile === 'object') {
    const picked = pick(profile as Record<string, unknown>, [
      'billingType',
      'organizationType',
      'organizationRateLimitTier',
    ])
    if (Object.keys(picked).length > 0) signals.oauth = picked
  }

  const session = credentials?.['claudeAiOauth']
  if (session && typeof session === 'object') {
    const picked = pick(session as Record<string, unknown>, ['subscriptionType', 'rateLimitTier'])
    if (Object.keys(picked).length > 0) signals.credentials = picked
  }

  if (stats?.modelUsage) {
    let totalCostUSD = 0
    let totalTokens = 0
    for (const usage of Object.values(stats.modelUsage)) {
      totalCostUSD += usage.costUSD ?? 0
      totalTokens += (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
        + (usage.cacheReadInputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0)
    }
    signals.usage = { totalCostUSD, totalTokens }
  }

  return signals
}

/**
 * One claim out of a JWT, without ever handling the JWT as a credential.
 *
 * A JWT is three dot-separated base64url segments: header, payload, signature. Only the PAYLOAD is
 * read, only the named claim is returned, and the token string never leaves this function — it is
 * not stored, not logged and not put in `CodexSignals`. The signature is deliberately NOT verified:
 * verifying would need OpenAI's keys over the network, and the point here is not to trust the token
 * but to read what the user's own machine already believes about their plan. A forged token in the
 * user's own home directory would mis-price only their own dashboard.
 *
 * Returns null for anything that is not a readable payload — this is a convenience, never a gate.
 */
export function readJwtClaim(jwt: string, claim: string): unknown {
  try {
    const payload = jwt.split('.')[1]
    if (!payload) return null
    const json = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    return (JSON.parse(json) as Record<string, unknown>)[claim] ?? null
  } catch {
    return null
  }
}

/** The claim OpenAI stamps the ChatGPT tier into. */
const CHATGPT_PLAN_CLAIM = 'https://api.openai.com/auth'

/**
 * Codex's signals, from `~/.codex/auth.json`.
 *
 * Two fields and nothing else: whether an API key is configured (presence only — the value is a
 * credential) and the plan tier lifted out of the OAuth id token's payload. The account id, the
 * bearer tokens and the expiry all sit in the same file and none of them is read.
 */
export async function readCodexSignals(): Promise<CodexSignals> {
  const auth = await safeReadJson<Record<string, unknown>>(CODEX_AUTH_FILE)
  if (!auth) return {}

  const signals: CodexSignals = {}
  if (typeof auth['OPENAI_API_KEY'] === 'string' && auth['OPENAI_API_KEY'] !== '') {
    signals.apiKey = 'set'
  }

  const tokens = auth['tokens']
  const idToken = tokens && typeof tokens === 'object'
    ? (tokens as Record<string, unknown>)['id_token']
    : undefined
  if (typeof idToken === 'string' && idToken !== '') {
    // The claim's value is itself an object and the plan is one of its keys. Read defensively — a
    // shape change upstream must yield no plan, never a throw and never a wrong plan.
    const auth0 = readJwtClaim(idToken, CHATGPT_PLAN_CLAIM)
    const planType = auth0 && typeof auth0 === 'object'
      ? (auth0 as Record<string, unknown>)['chatgpt_plan_type']
      : undefined
    if (typeof planType === 'string' && planType !== '') signals.planType = planType.toLowerCase()
  }

  return signals
}

/**
 * One proposal per harness in scope.
 *
 * Only Claude has signals on disk today. The others still get an entry, with `source: 'none'`,
 * rather than being omitted — a silent gap reads as "already handled", while an explicit "nothing
 * detected for Codex" tells the user the timeline for that harness is theirs to fill in.
 */
export async function detectBillingLocal(harnesses: readonly HarnessId[]): Promise<BillingDetection[]> {
  const [signals, codex] = await Promise.all([readBillingSignals(), readCodexSignals()])
  return harnesses.map((harness) => {
    if (harness === 'claude') return detectBilling(signals)
    if (harness === 'codex') return detectCodexBilling(codex)
    return {
      harness,
      mode: 'unknown' as const,
      source: 'none' as const,
      confidence: 'guess' as const,
      evidenceEn: 'This product cannot read how this harness is billed — enter it yourself.',
      evidencePt: 'Este produto não consegue ler como este harness é cobrado — informe você mesmo.',
      proposalOnly: true as const,
    }
  })
}
