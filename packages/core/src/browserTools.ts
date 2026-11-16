/**
 * browserTools.ts — which tool calls are BROWSER calls, in each harness's own spelling (NAVEGADOR S6,
 * spec §2 "Correção de paridade embutida").
 *
 * The same MCP tool is written differently by every harness (`mcp__agentistics__agentistics_browser_click`
 * in Claude, Codex and Kimi; `mcp_agentistics_…` in Gemini, Antigravity and Hermes; `server-tool` in
 * Copilot; `server_tool` in OpenCode). A regex written for Claude's format silently saw no browser at all in
 * the other seven, so `BROWSER_FORMATS` is a `Record<HarnessId, …>`: adding a harness fails the build until
 * somebody says how it spells an MCP tool.
 *
 * The answer carries WHICH kind of browser it is, because the two are treated differently:
 *   - `ours`    — an `agentistics_browser_*` tool: the session's own throwaway browser, streamable;
 *   - `foreign` — somebody else's browser (the person's Chrome through Claude in Chrome, Playwright MCP,
 *                 chrome-devtools, computer use, Antigravity's own): recognised so the chat knows a
 *                 navigation happened, NEVER streamed and never unlocked.
 *
 * Pure; no I/O. A name that matches nothing is `null` — a near-miss is refused, not guessed.
 */
import { HARNESS_ORDER, type HarnessId } from './types'

export type ForeignBrowser =
  | 'claude-in-chrome' // the person's own Chrome, driven by the Claude in Chrome extension
  | 'computer-use'     // desktop control (screenshots + clicks); not a browser pane
  | 'app-browser'      // the Claude desktop app's built-in browser pane
  | 'third-party'      // Playwright / chrome-devtools / puppeteer / … MCPs
  | 'harness-own'      // the harness's own browser (Antigravity)

export type BrowserToolMatch = { kind: 'ours' } | { kind: 'foreign'; foreign: ForeignBrowser }

/** `server`+`tool` joined by one `_`, lower-cased, `-` read as `_` — or null when the name is not in this harness's MCP format. */
type Splitter = (name: string) => string | null

const norm = (s: string): string => s.toLowerCase().replace(/-/g, '_').replace(/_{2,}/g, '_')

const dunder = (optionalPrefix: boolean): Splitter => (name) => {
  const m = (optionalPrefix ? /^(?:mcp__)?(.+?)__(.+)$/i : /^mcp__(.+?)__(.+)$/i).exec(name)
  return m ? norm(`${m[1]}_${m[2]}`) : null
}
const mcpUnderscore: Splitter = (name) => {
  const m = /^mcp_(.+)$/i.exec(name)
  return m ? norm(m[1]!) : null
}
const asWritten: Splitter = (name) => norm(name)

/**
 * How each harness spells an MCP tool in its transcript. Measured: Claude/Kimi `mcp__server__tool`; Codex the
 * same (the prefix is optional in a rollout's function name); Antigravity `mcp_` with ONE underscore (and a
 * `call_mcp_tool` wrapper that does not name the tool, so it is never a match); Gemini/Hermes `mcp_<server>_<tool>`
 * (not measured here — spec §2 "a medir"); Copilot `<server>-<tool>`; OpenCode `<server>_<tool>`.
 */
export const BROWSER_TOOL_FORMATS: Record<HarnessId, Splitter> = {
  claude: dunder(false),
  codex: dunder(true), // unmeasured: spelling in a real transcript not yet captured (spec §2 "a medir")
  gemini: mcpUnderscore, // unmeasured: spelling in a real transcript not yet captured (spec §2 "a medir")
  copilot: asWritten, // unmeasured: spelling in a real transcript not yet captured (spec §2 "a medir")
  antigravity: mcpUnderscore, // `mcp_` measured; the `call_mcp_tool` wrapper form is unmeasured
  kimi: dunder(false),
  opencode: asWritten, // unmeasured: spelling in a real transcript not yet captured (spec §2 "a medir")
  hermes: mcpUnderscore, // unmeasured: spelling in a real transcript not yet captured (spec §2 "a medir")
}

const OURS = /^(agentistics_)?agentistics_browser_[a-z0-9_]+$/
const OURS_BARE = /^agentistics_browser_[a-z0-9_]+$/i

const FOREIGN: ReadonlyArray<readonly [RegExp, ForeignBrowser]> = [
  [/^claude_in_chrome_./, 'claude-in-chrome'],
  [/^(remote_devices_)?claude_browser_./, 'app-browser'],
  [/^(remote_devices_computer_|computer_use(_mcp)?_)./, 'computer-use'],
  [/^(playwright|chrome_devtools|puppeteer|browsermcp|browsers?|chromedriver|chrome)_./, 'third-party'],
]

/**
 * Copilot/OpenCode native `browser_*` tools: spec §2 gives only Antigravity a browser of its own and marks the
 * others unknown, so a bare `browser_*` there stays `third-party` (unmeasured; revisit when P-probes measure).
 */

/** Antigravity's own browser tools (`browser_subagent`, `browser_navigate`, …) carry no server prefix. */
const AGY_OWN = /^browser_[a-z0-9_]+$/i

/** Is this tool call a browser call in `harness`'s format, and whose browser? `null` = not a browser tool. */
export function isBrowserTool(harness: HarnessId, name: string): BrowserToolMatch | null {
  if (!name) return null
  if (OURS_BARE.test(name)) return { kind: 'ours' }
  if (harness === 'antigravity' && AGY_OWN.test(name)) return { kind: 'foreign', foreign: 'harness-own' }
  const rest = BROWSER_TOOL_FORMATS[harness](name)
  if (rest === null) return null
  if (OURS.test(rest)) return { kind: 'ours' }
  for (const [re, foreign] of FOREIGN) if (re.test(rest)) return { kind: 'foreign', foreign }
  return null
}

/** Is `name` one of OUR browser tools in ANY harness's spelling (a caller that does not know the harness). */
export function isOwnBrowserToolName(name: string): boolean {
  return HARNESS_ORDER.some(h => isBrowserTool(h, name)?.kind === 'ours')
}

// ── the sentences ────────────────────────────────────────────────────────────────────────────────

type Lang = 'pt' | 'en'

const NOT_VISIBLE: Record<ForeignBrowser, Record<Lang, string>> = {
  'claude-in-chrome': {
    pt: 'Esta sessão está usando o seu Chrome (Claude in Chrome). O agentistics não mostra esse navegador.',
    en: 'This session is using your Chrome (Claude in Chrome). agentistics does not show that browser.',
  },
  'harness-own': {
    pt: 'Esta sessão está usando um navegador próprio: este navegador é do Antigravity e não aparece aqui.',
    en: 'This browser belongs to Antigravity and does not appear here.',
  },
  'computer-use': {
    pt: 'Esta sessão está controlando a tela do seu computador (computer use). O agentistics não mostra isso.',
    en: 'This session is controlling your computer screen (computer use). agentistics does not show that.',
  },
  'app-browser': {
    pt: 'Esta sessão está usando o navegador do aplicativo Claude. O agentistics não mostra esse navegador.',
    en: "This session is using the Claude app's built-in browser. agentistics does not show that browser.",
  },
  'third-party': {
    pt: 'Esta sessão está usando um navegador de outra ferramenta. O agentistics não mostra esse navegador.',
    en: "This session is using another tool's browser. agentistics does not show that browser.",
  },
}

/** What the card says about a recognised-but-not-shown browser; `null` for ours (it IS shown). */
export function browserNotVisibleNote(match: BrowserToolMatch, _harness: HarnessId, lang: Lang): string | null {
  return match.kind === 'foreign' ? NOT_VISIBLE[match.foreign][lang] : null
}

/** A harness that does not receive our browser tools at all (Hermes: no MCP entry yet). `null` = it does. */
export const HARNESS_BROWSER_TOOLS_NOTE: Record<HarnessId, Record<Lang, string> | null> = {
  claude: null, codex: null, gemini: null, copilot: null, antigravity: null, kimi: null, opencode: null,
  hermes: {
    pt: 'Hermes ainda não recebe as ferramentas de navegador do agentistics',
    en: 'Hermes does not receive the agentistics browser tools yet',
  },
}

export function harnessBrowserToolsNote(harness: HarnessId, lang: Lang): string | null {
  return HARNESS_BROWSER_TOOLS_NOTE[harness]?.[lang] ?? null
}
