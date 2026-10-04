import { describe, expect, test } from 'bun:test'
import { lineText, lineWidth } from './code'
import { DEFAULT_SHELL_KEYS, resolveShellKey } from './nav'
import {
  bindingConflict, openSettings, sectionLines, settingsKey, settingsLines, SETTINGS_SECTIONS,
  type SettingsData, type SettingsKey, type SettingsState,
} from './settings'

const data = (over: Partial<SettingsData> = {}): SettingsData => ({
  providers: {
    ok: true,
    providers: [
      { id: 'anthropic', label: 'Anthropic', kind: 'direct', state: 'present', keyOptional: false, last4: 'a1b2' },
      { id: 'openai', label: 'OpenAI', kind: 'direct', state: 'absent', keyOptional: false },
      { id: 'ollama', label: 'Ollama', kind: 'local', state: 'present', keyOptional: true, keyless: true },
    ],
  },
  defaultModel: { provider: 'anthropic', model: 'claude-sonnet-5', source: 'last-session' },
  tests: {},
  prices: [
    { model: 'claude-sonnet-5', price: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }, priceSource: { source: 'platform.claude.com/docs/en/about-claude/pricing', verifiedAt: '2026-09-25' }, window: { tokens: 1_000_000, source: 'x', verifiedAt: '2026-09-25' } },
    { model: 'mystery-1', price: null, priceSource: null, window: null, offered: '(openrouter)' },
    { model: 'qwen2.5-coder:7b', price: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, priceSource: 'local', window: null, offered: '(ollama)' },
  ],
  floor: ['~/.claude/.credentials.json', '~/.codex/auth.json'],
  sessionOpen: false,
  theme: 'dark',
  density: 'compact',
  binds: { ...DEFAULT_SHELL_KEYS },
  lang: 'en',
  ...over,
})

const k = (over: Partial<SettingsKey> = {}): SettingsKey => ({ input: '', ...over })

function press(st: SettingsState, keys: Partial<SettingsKey>[], d = data(), narrow = false) {
  let state = st
  let effect = settingsKey(state, k(), d, narrow).effect
  for (const key of keys) ({ state, effect } = settingsKey(state, k(key), d, narrow))
  return { state, effect }
}

describe('settings — navigation', () => {
  test('opens on the asked section, in the section itself', () => {
    const st = openSettings('models')
    expect(SETTINGS_SECTIONS[st.section]).toBe('models')
    expect(st.pane).toBe('content')
  })

  test('esc walks back to the list, then closes', () => {
    const a = press(openSettings(), [{ escape: true }])
    expect(a.state.pane).toBe('nav')
    expect(press(a.state, [{ escape: true }]).effect.kind).toBe('close')
  })

  test('↑↓ on the list moves between the seven sections, wrapping', () => {
    const nav = { ...openSettings(), pane: 'nav' as const }
    expect(press(nav, [{ upArrow: true }]).state.section).toBe(SETTINGS_SECTIONS.length - 1)
    expect(press(nav, [{ downArrow: true }, { downArrow: true }]).state.section).toBe(2)
  })
})

describe('ST-01 providers', () => {
  test('t tests the selected provider; K opens a masked key field; enter stores it', () => {
    expect(press(openSettings(), [{ input: 't' }]).effect).toEqual({ kind: 'test', provider: 'anthropic' })
    const typing = press(openSettings(), [{ downArrow: true }, { input: 'K' }, { input: 's' }, { input: 'k' }, { input: '-' }, { input: 'x' }])
    expect(typing.state.keyInput).toEqual({ provider: 'openai', value: 'sk-x' })
    expect(press(typing.state, [{ return: true }]).effect).toEqual({ kind: 'set-key', provider: 'openai', key: 'sk-x' })
  })

  test('the key being typed is never drawn — only its length', () => {
    const typing = press(openSettings(), [{ input: 'K' }, { input: 'sk-ant-secretvalue' }])
    const text = sectionLines(typing.state, data(), 80, 30).map(lineText).join('\n')
    expect(text).not.toContain('secretvalue')
    expect(text).toContain('18 characters')
  })

  test('a stored key shows only its end', () => {
    const text = sectionLines(openSettings(), data(), 90, 30).map(lineText).join('\n')
    expect(text).toContain('…a1b2')
    expect(text).toContain('● ready')
    expect(text).toContain('○ not configured')
  })

  test('a local provider needs no key and says so instead of asking for one', () => {
    const r = press(openSettings(), [{ downArrow: true }, { downArrow: true }, { input: 'K' }])
    expect(r.state.keyInput).toBeNull()
    expect(r.effect.kind).toBe('say')
  })

  test('the host refusing (gate off, service down) is shown in its own words', () => {
    const d = data({ providers: { ok: false, sentence: 'The native Agentistics harness and model providers are experimental.' } })
    expect(sectionLines(openSettings(), d, 90, 30).map(lineText).join(' ')).toContain('experimental')
  })
})

describe('ST-02 models & pricing', () => {
  test('a price, its source and date; an unpriced model reads N/A; a local one $0', () => {
    const text = sectionLines(openSettings('models'), data(), 100, 30).map(lineText).join('\n')
    expect(text).toContain('$2 · $10 · $0.20 · $2.50')
    expect(text).toContain('claude.com · 2026-09-25')
    expect(text).toContain('N/A · N/A · N/A · N/A')
    expect(text).toContain('no verified price')
    expect(text).toContain('$0 · runs on this machine, costs nothing')
  })
})

describe('ST-03 permissions', () => {
  test('each protected place once, and a star that changes the meaning is kept', () => {
    const d = data({ floor: ['~/.codex/auth.json', '~/.codex/auth.json*', '~/.codex/auth.json*/**', '~/.claude/**/*.key*', '~/.claude/**/*.key*/**'] })
    const text = sectionLines(openSettings('permissions'), d, 100, 40).map(lineText).join('\n')
    expect(text).toContain('2 places denied')
    expect(text).toContain('~/.claude/**/*.key*')
    expect(text).not.toContain('auth.json*')
  })

  test('the floor is listed as never lifted', () => {
    const text = sectionLines(openSettings('permissions'), data(), 100, 30).map(lineText).join('\n')
    expect(text).toContain('FLOOR — never lifted')
    expect(text).toContain('~/.codex/auth.json')
  })
})

describe('ST-04 / ST-06 appearance and language', () => {
  test('enter cycles the theme and toggles the density; enter switches the language', () => {
    expect(press(openSettings('appearance'), [{ return: true }]).effect).toEqual({ kind: 'theme', theme: 'light' })
    expect(press(openSettings('appearance'), [{ downArrow: true }, { return: true }]).effect).toEqual({ kind: 'density', density: 'comfortable' })
    expect(press(openSettings('lang'), [{ return: true }]).effect).toEqual({ kind: 'lang', lang: 'pt' })
  })
})

describe('ST-05 keybindings', () => {
  test('enter waits for a key; a free one is bound and the shell answers it', () => {
    const waiting = press(openSettings('keys'), [{ downArrow: true }, { downArrow: true }, { downArrow: true }, { return: true }])
    expect(waiting.state.capture).toBe('settings')
    const r = press(waiting.state, [{ input: 'e', ctrl: true }])
    expect(r.effect.kind).toBe('bind')
    if (r.effect.kind !== 'bind') return
    expect(r.effect.binds.settings).toBe('ctrl+e')
    expect(resolveShellKey({ input: 'e', ctrl: true }, { tab: 'home', arrows: true, mouse: false, binds: r.effect.binds })).toEqual({ kind: 'settings' })
    expect(resolveShellKey({ input: ',' }, { tab: 'home', arrows: true, mouse: false, binds: r.effect.binds })).toBeNull()
  })

  test('a key another shell action holds is refused, naming it', () => {
    expect(bindingConflict('help', 'q', DEFAULT_SHELL_KEYS, 'en')).toContain('"quit"')
  })

  test('a key a screen answers is refused, naming the screen and what it does there', () => {
    const why = bindingConflict('help', 'x', DEFAULT_SHELL_KEYS, 'en')
    expect(why).not.toBeNull()
    expect(why!).toContain('taken in')
  })

  test('a code-tab chord is refused too (ctrl+o expands output there)', () => {
    expect(bindingConflict('settings', 'ctrl+o', DEFAULT_SHELL_KEYS, 'en')).toContain('taken in')
  })

  test('the default settings key collides with no screen (`,` pages the dashboard)', () => {
    expect(bindingConflict('settings', DEFAULT_SHELL_KEYS.settings, DEFAULT_SHELL_KEYS, 'en')).toBeNull()
    expect(bindingConflict('settings', ',', DEFAULT_SHELL_KEYS, 'en')).toContain('dashboard')
  })

  test('ctrl+c is reserved', () => {
    expect(bindingConflict('quit', 'ctrl+c', DEFAULT_SHELL_KEYS, 'en')).toContain('reserved')
  })

  test('the last row puts every key back', () => {
    const last = press(openSettings('keys'), [{ upArrow: true }, { return: true }], data({ binds: { ...DEFAULT_SHELL_KEYS, help: 'H' } }))
    expect(last.effect.kind).toBe('bind')
    if (last.effect.kind === 'bind') expect(last.effect.binds).toEqual(DEFAULT_SHELL_KEYS)
  })
})

describe('GL-07 — every line fits, wide and narrow', () => {
  for (const [width, narrow] of [[104, false], [76, true]] as const) {
    test(`${width} columns${narrow ? ' (one pane)' : ''}`, () => {
      for (let i = 0; i < SETTINGS_SECTIONS.length; i++) {
        for (const pane of ['nav', 'content'] as const) {
          for (const lang of ['en', 'pt'] as const) {
            const st: SettingsState = { ...openSettings(SETTINGS_SECTIONS[i]), pane }
            const lines = settingsLines(st, data({ lang }), width, 26, narrow)
            expect(lines.length).toBeLessThanOrEqual(26)
            for (const l of lines) expect(lineWidth(l)).toBeLessThanOrEqual(width)
          }
        }
      }
    })
  }

  test('narrow shows one pane: the list, or the section headed by its name', () => {
    const nav = settingsLines({ ...openSettings(), pane: 'nav' }, data(), 76, 26, true).map(lineText).join('\n')
    expect(nav).toContain('Providers')
    expect(nav).not.toContain('…a1b2')
    const content = settingsLines(openSettings(), data(), 76, 26, true).map(lineText)
    expect(content[0]).toContain('‹ Providers')
  })
})
