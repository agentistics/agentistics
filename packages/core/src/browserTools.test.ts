import { describe, test, expect } from 'bun:test'
import { HARNESS_ORDER, type HarnessId } from './types'
import {
  isBrowserTool, isOwnBrowserToolName, browserNotVisibleNote, harnessBrowserToolsNote, BROWSER_TOOL_FORMATS,
} from './browserTools'

/** Each harness's own spelling of the same two calls. */
const SPELL: Record<HarnessId, { ours: string; playwright: string; chrome: string; nearMiss: string }> = {
  claude: {
    ours: 'mcp__agentistics__agentistics_browser_click',
    playwright: 'mcp__playwright__browser_click',
    chrome: 'mcp__claude-in-chrome__navigate',
    nearMiss: 'mcp__agentistics__agentistics_tasks',
  },
  codex: {
    ours: 'mcp__agentistics__agentistics_browser_click',
    playwright: 'mcp__playwright__browser_click',
    chrome: 'mcp__claude-in-chrome__navigate',
    nearMiss: 'mcp__playwrightx__browser_click',
  },
  gemini: {
    ours: 'mcp_agentistics_agentistics_browser_click',
    playwright: 'mcp_playwright_browser_click',
    chrome: 'mcp_claude-in-chrome_navigate',
    nearMiss: 'mcp_agentistics_agentistics_browsers_click',
  },
  copilot: {
    ours: 'agentistics-agentistics_browser_click',
    playwright: 'playwright-browser_click',
    chrome: 'claude-in-chrome-navigate',
    nearMiss: 'agentistics-agentistics_task_click',
  },
  antigravity: {
    ours: 'mcp_agentistics_agentistics_browser_click',
    playwright: 'mcp_playwright_browser_click',
    chrome: 'mcp_claude-in-chrome_navigate',
    nearMiss: 'call_mcp_tool',
  },
  kimi: {
    ours: 'mcp__agentistics__agentistics_browser_click',
    playwright: 'mcp__playwright__browser_click',
    chrome: 'mcp__claude-in-chrome__navigate',
    nearMiss: 'mcp__agentistics__agentistics_browser_',
  },
  opencode: {
    ours: 'agentistics_agentistics_browser_click',
    playwright: 'playwright_browser_click',
    chrome: 'claude-in-chrome_navigate',
    nearMiss: 'playwrightx_browser_click',
  },
  hermes: {
    ours: 'mcp_agentistics_agentistics_browser_click',
    playwright: 'mcp_playwright_browser_click',
    chrome: 'mcp_claude-in-chrome_navigate',
    nearMiss: 'mcp_agentistic_agentistic_browser_click',
  },
}

describe('isBrowserTool', () => {
  test('the format table and the spelling table cover exactly the harness registry', () => {
    expect(Object.keys(BROWSER_TOOL_FORMATS).sort()).toEqual([...HARNESS_ORDER].sort())
    expect(Object.keys(SPELL).sort()).toEqual([...HARNESS_ORDER].sort())
  })

  for (const h of HARNESS_ORDER) {
    describe(h, () => {
      test('our tool is recognised as ours', () => {
        expect(isBrowserTool(h, SPELL[h].ours)).toEqual({ kind: 'ours' })
      })
      test('a third-party browser is recognised as foreign', () => {
        const p = isBrowserTool(h, SPELL[h].playwright)
        expect(p?.kind).toBe('foreign')
        const c = isBrowserTool(h, SPELL[h].chrome)
        expect(c).toEqual({ kind: 'foreign', foreign: 'claude-in-chrome' })
      })
      test('a near-miss name is refused', () => {
        expect(isBrowserTool(h, SPELL[h].nearMiss)).toBeNull()
        expect(isBrowserTool(h, 'Read')).toBeNull()
        expect(isBrowserTool(h, '')).toBeNull()
        expect(isBrowserTool(h, 'mcp__github__create_issue')).toBeNull()
      })
    })
  }

  test('a name in ANOTHER harness\'s format is not read as this one\'s', () => {
    // dunder is claude/codex/kimi; copilot never writes `mcp__`
    expect(isBrowserTool('copilot', 'mcp__playwright__browser_click')).toBeNull()
    expect(isBrowserTool('gemini', 'mcp__playwright__browser_click')).toBeNull()
  })

  test('foreign kinds are told apart', () => {
    expect(isBrowserTool('claude', 'mcp__playwright__browser_click')).toEqual({ kind: 'foreign', foreign: 'third-party' })
    expect(isBrowserTool('claude', 'mcp__chrome-devtools__take_snapshot')).toEqual({ kind: 'foreign', foreign: 'third-party' })
    expect(isBrowserTool('claude', 'mcp__computer-use-mcp__computer')).toEqual({ kind: 'foreign', foreign: 'computer-use' })
    expect(isBrowserTool('claude', 'mcp__remote-devices__computer_click')).toEqual({ kind: 'foreign', foreign: 'computer-use' })
    expect(isBrowserTool('claude', 'mcp__Claude_Browser__navigate')).toEqual({ kind: 'foreign', foreign: 'app-browser' })
    expect(isBrowserTool('claude', 'mcp__remote-devices__Claude_Browser__navigate')).toEqual({ kind: 'foreign', foreign: 'app-browser' })
  })

  test("agy's own browser is the harness's own, and only agy's", () => {
    expect(isBrowserTool('antigravity', 'browser_subagent')).toEqual({ kind: 'foreign', foreign: 'harness-own' })
    expect(isBrowserTool('antigravity', 'browser_navigate')).toEqual({ kind: 'foreign', foreign: 'harness-own' })
    expect(isBrowserTool('codex', 'browser_subagent')).toBeNull()
  })

  test('our bare tool name is ours in every harness', () => {
    for (const h of HARNESS_ORDER) expect(isBrowserTool(h, 'agentistics_browser_status')).toEqual({ kind: 'ours' })
  })

  test('is case-insensitive on the server part only where spelling varies', () => {
    expect(isBrowserTool('claude', 'MCP__Playwright__browser_click')?.kind).toBe('foreign')
  })

  test('isOwnBrowserToolName answers for any harness spelling', () => {
    for (const h of HARNESS_ORDER) expect(isOwnBrowserToolName(SPELL[h].ours)).toBe(true)
    expect(isOwnBrowserToolName('mcp__playwright__browser_click')).toBe(false)
    expect(isOwnBrowserToolName('agentistics_browser_')).toBe(false)
  })
})

describe('sentences', () => {
  test('the Claude in Chrome sentence', () => {
    expect(browserNotVisibleNote({ kind: 'foreign', foreign: 'claude-in-chrome' }, 'claude', 'pt'))
      .toBe('Esta sessão está usando o seu Chrome (Claude in Chrome). O agentistics não mostra esse navegador.')
    expect(browserNotVisibleNote({ kind: 'foreign', foreign: 'claude-in-chrome' }, 'claude', 'en'))
      .toBe('This session is using your Chrome (Claude in Chrome). agentistics does not show that browser.')
  })
  test("agy's own browser sentence", () => {
    expect(browserNotVisibleNote({ kind: 'foreign', foreign: 'harness-own' }, 'antigravity', 'pt')).toContain('este navegador é do Antigravity e não aparece aqui')
    expect(browserNotVisibleNote({ kind: 'foreign', foreign: 'harness-own' }, 'antigravity', 'en')).toContain('This browser belongs to Antigravity')
  })
  test('ours has no "not visible" sentence', () => {
    expect(browserNotVisibleNote({ kind: 'ours' }, 'claude', 'pt')).toBeNull()
  })
  test('every foreign kind has a sentence in both languages', () => {
    for (const f of ['claude-in-chrome', 'computer-use', 'app-browser', 'third-party', 'harness-own'] as const)
      for (const l of ['pt', 'en'] as const) expect(browserNotVisibleNote({ kind: 'foreign', foreign: f }, 'claude', l)!.length).toBeGreaterThan(10)
  })
  test('Hermes is the only harness told it receives no browser tools yet', () => {
    expect(harnessBrowserToolsNote('hermes', 'pt')).toBe('Hermes ainda não recebe as ferramentas de navegador do agentistics')
    expect(harnessBrowserToolsNote('hermes', 'en')).toBe('Hermes does not receive the agentistics browser tools yet')
    for (const h of HARNESS_ORDER) if (h !== 'hermes') expect(harnessBrowserToolsNote(h, 'pt')).toBeNull()
  })
})
