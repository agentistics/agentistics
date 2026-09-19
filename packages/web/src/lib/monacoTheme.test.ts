/**
 * What can be ASSERTED about a colour theme, as opposed to looked at.
 *
 * Four things, and each of them is a defect that has to be caught by a machine because the eye
 * cannot: (1) the theme really is derived from `index.css` and not from a copy of it that has since
 * drifted; (2) every value is a hex Monaco can parse — the `rules` half THROWS on anything else and
 * the `colors` half silently paints `Color.red`, so neither failure mode is one a reviewer notices;
 * (3) the rule table holds no colour of its own, i.e. the derivation is the only source; and (4) the
 * syntax colours clear the legibility floor the derivation exists to enforce, on BOTH grounds.
 *
 * What is NOT asserted here is whether it looks good. That was checked by eye, in both themes, over
 * real files of several languages.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import {
  AGENTISTICS_THEME_NAME, MIN_CODE_CONTRAST, MIN_UI_CONTRAST,
  TOKENS_DARK, TOKENS_LIGHT, TOKEN_PROPERTY,
  agentisticsThemeData, alpha, buildHighlightColors, buildPalette, codeThemeName, contrastRatio,
  defineAgentisticsThemes, flatten, parseCssColor, readable,
  type CodeHighlightColors, type CodePalette, type CodeThemeVariant, type ThemeTokens,
} from './monacoTheme'

const INDEX_CSS = join(import.meta.dir, '..', 'index.css')

/**
 * Monaco's OWN validator for a token rule's colour, copied from
 * `monaco-editor/esm/vs/editor/common/languages/supports/tokenization.js:105`. A value it rejects
 * reaches `throw new Error('Illegal value for token color: …')` four lines later, which takes the
 * whole editor down on mount.
 */
const MONACO_TOKEN_COLOR = /^#?([0-9A-Fa-f]{6})([0-9A-Fa-f]{2})?$/

/**
 * Monaco's own theme-NAME validator, from
 * `monaco-editor/esm/vs/editor/standalone/browser/standaloneThemeService.js:256`. `defineTheme`
 * throws `Illegal theme name!` on a name with a dot or an underscore in it.
 */
const MONACO_THEME_NAME = /^[a-z0-9\-]+$/i

/**
 * The declaration value of one custom property inside one CSS rule block, read out of `index.css`
 * itself. `null` when the block does not declare it — which is a real answer: the light block
 * inherits most of `:root`, and a token this theme reads must be declared in BOTH or the light
 * editor would silently be built out of dark values.
 */
function cssToken(selector: string, property: string): string | null {
  const css = readFileSync(INDEX_CSS, 'utf8')
  const at = css.indexOf(selector)
  if (at === -1) throw new Error(`index.css has no ${selector} block`)
  const open = css.indexOf('{', at)
  const close = css.indexOf('}', open)
  const block = css.slice(open + 1, close)
  // The property name is anchored at a line start (after optional indentation) so `--border` can
  // never be answered by `--border-subtle`'s declaration.
  const m = new RegExp(`^\\s*${property}\\s*:\\s*([^;]+);`, 'm').exec(block)
  return m === null ? null : m[1]!.trim()
}

describe('the tokens are index.css, verbatim', () => {
  const cases: readonly [string, string, ThemeTokens][] = [
    [':root', 'dark', TOKENS_DARK],
    ['[data-theme="light"]', 'light', TOKENS_LIGHT],
  ]
  for (const [selector, label, tokens] of cases) {
    test(`${label} mirrors every property it names`, () => {
      for (const key of Object.keys(tokens) as (keyof ThemeTokens)[]) {
        const property = TOKEN_PROPERTY[key]
        expect(cssToken(selector, property)).toBe(tokens[key])
      }
    })
  }

  test('every token this theme reads is declared in BOTH blocks', () => {
    // Otherwise the light theme would be built out of values the light page never uses.
    for (const property of Object.values(TOKEN_PROPERTY)) {
      expect(cssToken(':root', property)).not.toBeNull()
      expect(cssToken('[data-theme="light"]', property)).not.toBeNull()
    }
  })
})

describe('every colour is one Monaco can actually parse', () => {
  for (const variant of ['dark', 'light'] as CodeThemeVariant[]) {
    test(`${variant}: rules and colors are 6- or 8-digit hex`, () => {
      const data = agentisticsThemeData(variant)
      expect(data.rules.length).toBeGreaterThan(20)
      for (const rule of data.rules) {
        expect(rule.foreground, `token ${rule.token || '(default)'}`)
          .toMatch(MONACO_TOKEN_COLOR)
      }
      for (const [id, value] of Object.entries(data.colors)) {
        expect(value, `colour id ${id}`).toMatch(MONACO_TOKEN_COLOR)
      }
    })
  }

  test('the theme names are ones defineTheme accepts', () => {
    expect(AGENTISTICS_THEME_NAME.dark).toMatch(MONACO_THEME_NAME)
    expect(AGENTISTICS_THEME_NAME.light).toMatch(MONACO_THEME_NAME)
  })
})

describe('the rule table holds no colour of its own', () => {
  for (const variant of ['dark', 'light'] as CodeThemeVariant[]) {
    test(`${variant}: every value came out of the palette`, () => {
      const palette = buildPalette(variant === 'light' ? TOKENS_LIGHT : TOKENS_DARK)
      const derived = new Set(Object.values(palette))
      const data = agentisticsThemeData(variant)
      for (const rule of data.rules) {
        expect(derived.has(rule.foreground ?? ''), `token ${rule.token || '(default)'} → ${rule.foreground}`)
          .toBe(true)
      }
      for (const [id, value] of Object.entries(data.colors)) {
        expect(derived.has(value), `colour id ${id} → ${value}`).toBe(true)
      }
    })
  }

  test('and the two variants differ in every surface colour, so neither is a copy', () => {
    const dark = agentisticsThemeData('dark')
    const light = agentisticsThemeData('light')
    expect(dark.colors['editor.background']).not.toBe(light.colors['editor.background'])
    expect(dark.colors['editor.foreground']).not.toBe(light.colors['editor.foreground'])
    expect(dark.base).toBe('vs-dark')
    expect(light.base).toBe('vs')
  })
})

describe('the two variants are the same theme', () => {
  const dark = agentisticsThemeData('dark')
  const light = agentisticsThemeData('light')

  test('the same token classes', () => {
    expect(light.rules.map(r => r.token)).toEqual(dark.rules.map(r => r.token))
  })
  test('the same colour ids', () => {
    expect(Object.keys(light.colors).sort()).toEqual(Object.keys(dark.colors).sort())
  })
  test('the same font styles — a class is italic in both themes or in neither', () => {
    expect(light.rules.map(r => r.fontStyle)).toEqual(dark.rules.map(r => r.fontStyle))
  })
  test('both inherit, so the ~370 ids this theme does not name stay coherent', () => {
    expect(dark.inherit).toBe(true)
    expect(light.inherit).toBe(true)
  })
})

describe('legibility is the reason the derivation exists', () => {
  const SYNTAX_SLOTS: readonly (keyof CodePalette)[] = [
    'fg', 'muted', 'keyword', 'string', 'number', 'type', 'func', 'constant', 'error',
  ]
  for (const variant of ['dark', 'light'] as CodeThemeVariant[]) {
    test(`${variant}: every syntax colour clears the floor against the code surface`, () => {
      const palette = buildPalette(variant === 'light' ? TOKENS_LIGHT : TOKENS_DARK)
      for (const slot of SYNTAX_SLOTS) {
        expect(contrastRatio(palette[slot], palette.bg), `${slot} on ${palette.bg}`)
          .toBeGreaterThanOrEqual(MIN_CODE_CONTRAST)
      }
    })

    test(`${variant}: the gutter is deliberately BELOW it, and stays that way`, () => {
      // `faint` is the line numbers, the indent guides and the whitespace dots — things the EDITOR
      // draws, which the reader is meant to look past. Lifting it would make the quietest part of
      // the editor compete with the code; this pins that as a decision rather than leaving it one
      // careless edit from being "fixed".
      const palette = buildPalette(variant === 'light' ? TOKENS_LIGHT : TOKENS_DARK)
      expect(contrastRatio(palette.faint, palette.bg)).toBeLessThan(MIN_CODE_CONTRAST)
    })

    test(`${variant}: nothing a PERSON typed is drawn at the gutter's weight`, () => {
      // The exception that proves the line above, and it used to be broken: `delimiter` — every
      // `,` `;` `:` `.` in the file — wore `faint`, so the characters a reader hunts for when
      // something will not parse were drawn at 2.62:1 dark / 2.19:1 light. `white` (the whitespace
      // rendering) is the ONLY syntax class allowed down there, because it is not a character
      // anybody typed so much as a mark saying one is present.
      const palette = buildPalette(variant === 'light' ? TOKENS_LIGHT : TOKENS_DARK)
      const data = agentisticsThemeData(variant)
      const atFaint = data.rules.filter(r => r.foreground === palette.faint).map(r => r.token)
      expect(atFaint).toEqual(['white'])
      const byToken = new Map(data.rules.map(r => [r.token, r.foreground]))
      expect(contrastRatio(byToken.get('delimiter')!, palette.bg))
        .toBeGreaterThanOrEqual(MIN_CODE_CONTRAST)
    })

    test(`${variant}: the caret clears the SHAPE floor — it is how you find where you are`, () => {
      const palette = buildPalette(variant === 'light' ? TOKENS_LIGHT : TOKENS_DARK)
      const data = agentisticsThemeData(variant)
      expect(data.colors['editorCursor.foreground']).toBe(palette.accent)
      expect(contrastRatio(palette.accent, palette.bg)).toBeGreaterThanOrEqual(MIN_UI_CONTRAST)
    })

    test(`${variant}: a comment is dimmer than code, and not the same colour`, () => {
      const palette = buildPalette(variant === 'light' ? TOKENS_LIGHT : TOKENS_DARK)
      expect(palette.muted).not.toBe(palette.fg)
      expect(contrastRatio(palette.muted, palette.bg))
        .toBeLessThan(contrastRatio(palette.fg, palette.bg))
    })

    test(`${variant}: red is kept for what is wrong`, () => {
      const palette = buildPalette(variant === 'light' ? TOKENS_LIGHT : TOKENS_DARK)
      const data = agentisticsThemeData(variant)
      const byToken = new Map(data.rules.map(r => [r.token, r.foreground]))
      expect(byToken.get('invalid')).toBe(palette.error)
      expect(byToken.get('string.invalid')).toBe(palette.error)
      // A valid HTML tag is not an error, so it may never wear the fault colour.
      expect(byToken.get('tag')).toBe(palette.func)
      expect(byToken.get('tag')).not.toBe(palette.error)
    })
  }
})

describe('readable — the lift', () => {
  test('leaves a colour that already passes untouched', () => {
    // `--accent-cyan` is 8.14:1 on `--bg-base`; nothing to do.
    expect(readable('#06b6d4', '#0a0a0f')).toBe('#06b6d4')
  })
  test('lightens on a dark ground and darkens on a light one', () => {
    const onDark = readable('#6366f1', '#0a0a0f')
    expect(contrastRatio(onDark, '#0a0a0f')).toBeGreaterThanOrEqual(MIN_CODE_CONTRAST)
    expect(contrastRatio('#6366f1', '#0a0a0f')).toBeLessThan(MIN_CODE_CONTRAST)

    const onLight = readable('#f97316', '#f4f4f7')
    expect(contrastRatio(onLight, '#f4f4f7')).toBeGreaterThanOrEqual(MIN_CODE_CONTRAST)
    // Darker, not lighter: the same hue moved the only way that helps on a light ground.
    expect(contrastRatio(onLight, '#ffffff')).toBeGreaterThan(contrastRatio('#f97316', '#ffffff'))
  })
  test('terminates on a hue that can never reach the target instead of spinning', () => {
    // Pure yellow on white tops out far below 4.5:1. The answer is the closest it can get.
    const out = readable('#ffff00', '#ffffff')
    expect(out).toMatch(MONACO_TOKEN_COLOR)
  })
})

describe('colour arithmetic', () => {
  test('parseCssColor reads the forms this app writes, and refuses the rest', () => {
    expect(parseCssColor('#0a0a0f')).toEqual({ r: 10, g: 10, b: 15, a: 1 })
    expect(parseCssColor('#abc')).toEqual({ r: 170, g: 187, b: 204, a: 1 })
    expect(parseCssColor('rgba(255, 255, 255, 0.5)')).toEqual({ r: 255, g: 255, b: 255, a: 0.5 })
    expect(parseCssColor('rgb(1, 2, 3)')).toEqual({ r: 1, g: 2, b: 3, a: 1 })
    expect(parseCssColor('var(--text-primary)')).toBeNull()
    expect(parseCssColor('hsl(10 20% 30%)')).toBeNull()
  })
  test('flatten composites alpha over the surface it is drawn on', () => {
    expect(flatten('rgba(255, 255, 255, 0.5)', '#000000')).toBe('#808080')
    // The SAME token is a different colour over a different surface — which is why this is computed
    // rather than written down.
    expect(flatten('rgba(255, 255, 255, 0.3)', '#0a0a0f'))
      .not.toBe(flatten('rgba(255, 255, 255, 0.3)', '#1e1e2e'))
  })
  test('flatten normalizes case, so two spellings of one token cannot look like two colours', () => {
    expect(flatten('#D97706', '#000000')).toBe('#d97706')
  })
  test('alpha appends the eighth pair Monaco blends itself', () => {
    expect(alpha('#ffffff', 1)).toBe('#ffffffff')
    expect(alpha('#ffffff', 0)).toBe('#ffffff00')
    expect(alpha('#0a0a0f', 0.5)).toMatch(MONACO_TOKEN_COLOR)
  })
  test('a colour this module cannot read throws rather than guessing one', () => {
    expect(() => flatten('var(--nope)', '#000000')).toThrow()
  })
})

/**
 * **EVERY CHROME ID IS ONE MONACO ACTUALLY REGISTERS.**
 *
 * The module's own comment above `CHROME` already claimed this ("verified by walking its own
 * `registerColor(` calls") and the walk was done BY HAND, once, by a person. An id nobody
 * registered is not an error and not a warning — `standaloneThemeService` simply never asks for it
 * — so `editorLineNumber.forground` would be a carefully chosen colour doing nothing at all,
 * forever, with the gutter quietly inheriting the base theme instead. The hand check cannot be
 * repeated on every edit; this is the mechanical version, and it is the same shape (and the same
 * cost) as `languageIdsAreRegistered` in `monacoLanguage.test.ts` one directory over.
 *
 * The set is read from the INSTALLED package rather than from a list kept here — a list of monaco's
 * colour ids maintained in this repo would be the very thing it is meant to catch, one release out
 * of date.
 */
describe('chromeIdsAreRegistered', () => {
  const VS_CANDIDATES = [
    join(import.meta.dir, '../..', 'node_modules', 'monaco-editor/package.json'),
    join(import.meta.dir, '../../../..', 'node_modules', 'monaco-editor/package.json'),
  ]

  /** Every id monaco declares, from the `registerColor('<id>', …)` calls in its own sources. */
  function registeredColorIds(): Set<string> {
    const pkg = VS_CANDIDATES.find(p => existsSync(p))
    if (pkg === undefined) {
      // Same stance as the two lint tests beside this one: a check that cannot answer must FAIL,
      // never pass quietly — a green tick here would mean nothing was compared at all.
      throw new Error(`monaco-editor not installed; looked in:\n${VS_CANDIDATES.join('\n')}`)
    }
    const ids = new Set<string>()
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name)
        if (entry.isDirectory()) walk(p)
        else if (p.endsWith('.js')) {
          for (const m of readFileSync(p, 'utf8').matchAll(/registerColor\(\s*['"]([^'"]+)['"]/g)) {
            ids.add(m[1]!)
          }
        }
      }
    }
    walk(join(dirname(pkg), 'esm/vs'))
    return ids
  }

  test('every colour id this theme names is one the installed monaco declares', () => {
    const registered = registeredColorIds()
    // Read, not assumed: a parse that came back tiny would make the loop below vacuous.
    expect(registered.size).toBeGreaterThan(300)
    const named = Object.keys(agentisticsThemeData('dark').colors)
    expect(named.length).toBeGreaterThan(40)
    for (const id of named) {
      expect(registered.has(id), `colour id "${id}" is registered by nothing in monaco-editor`)
        .toBe(true)
    }
  })
})

describe('registration', () => {
  test('defines exactly the two names, with the matching bases', () => {
    const seen: { name: string; base: string }[] = []
    defineAgentisticsThemes({
      editor: { defineTheme: (name, data) => { seen.push({ name, base: data.base }) } },
    })
    expect(seen).toEqual([
      { name: 'agentistics-dark', base: 'vs-dark' },
      { name: 'agentistics-light', base: 'vs' },
    ])
  })
  test('codeThemeName follows <html data-theme>, and an absent attribute is the shipped theme', () => {
    expect(codeThemeName('light')).toBe(AGENTISTICS_THEME_NAME.light)
    expect(codeThemeName('dark')).toBe(AGENTISTICS_THEME_NAME.dark)
    expect(codeThemeName(null)).toBe(AGENTISTICS_THEME_NAME.dark)
    expect(codeThemeName('')).toBe(AGENTISTICS_THEME_NAME.dark)
  })
})

describe('buildHighlightColors — the code highlighter palette', () => {
  const getBgColor = (variant: CodeThemeVariant): string => {
    const tokens = variant === 'light' ? TOKENS_LIGHT : TOKENS_DARK
    const palette = buildPalette(tokens)
    return palette.bg
  }

  test('dark: all highlighted token kinds clear the contrast floor', () => {
    const bg = getBgColor('dark')
    const colors = buildHighlightColors('dark')
    expect(contrastRatio(colors.plain, bg)).toBeGreaterThanOrEqual(MIN_CODE_CONTRAST)
    expect(contrastRatio(colors.comment, bg)).toBeGreaterThanOrEqual(MIN_CODE_CONTRAST)
    expect(contrastRatio(colors.string, bg)).toBeGreaterThanOrEqual(MIN_CODE_CONTRAST)
    expect(contrastRatio(colors.number, bg)).toBeGreaterThanOrEqual(MIN_CODE_CONTRAST)
    expect(contrastRatio(colors.keyword, bg)).toBeGreaterThanOrEqual(MIN_CODE_CONTRAST)
    expect(contrastRatio(colors.punct, bg)).toBeGreaterThanOrEqual(MIN_CODE_CONTRAST)
  })

  test('light: all highlighted token kinds clear the contrast floor', () => {
    const bg = getBgColor('light')
    const colors = buildHighlightColors('light')
    expect(contrastRatio(colors.plain, bg)).toBeGreaterThanOrEqual(MIN_CODE_CONTRAST)
    expect(contrastRatio(colors.comment, bg)).toBeGreaterThanOrEqual(MIN_CODE_CONTRAST)
    expect(contrastRatio(colors.string, bg)).toBeGreaterThanOrEqual(MIN_CODE_CONTRAST)
    expect(contrastRatio(colors.number, bg)).toBeGreaterThanOrEqual(MIN_CODE_CONTRAST)
    expect(contrastRatio(colors.keyword, bg)).toBeGreaterThanOrEqual(MIN_CODE_CONTRAST)
    expect(contrastRatio(colors.punct, bg)).toBeGreaterThanOrEqual(MIN_CODE_CONTRAST)
  })

  test('derived from the same palette as the editor', () => {
    // The colours should come from the palette, not be hardcoded
    const darkPalette = buildPalette(TOKENS_DARK)
    const darkColors = buildHighlightColors('dark')
    expect(darkColors.plain).toBe(darkPalette.fg)
    expect(darkColors.comment).toBe(darkPalette.muted)
    expect(darkColors.string).toBe(darkPalette.string)
    expect(darkColors.number).toBe(darkPalette.number)
    expect(darkColors.keyword).toBe(darkPalette.keyword)
    expect(darkColors.punct).toBe(darkPalette.muted)

    const lightPalette = buildPalette(TOKENS_LIGHT)
    const lightColors = buildHighlightColors('light')
    expect(lightColors.plain).toBe(lightPalette.fg)
    expect(lightColors.comment).toBe(lightPalette.muted)
    expect(lightColors.string).toBe(lightPalette.string)
    expect(lightColors.number).toBe(lightPalette.number)
    expect(lightColors.keyword).toBe(lightPalette.keyword)
    expect(lightColors.punct).toBe(lightPalette.muted)
  })
})
