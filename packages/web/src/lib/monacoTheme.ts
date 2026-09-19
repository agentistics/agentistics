/**
 * monacoTheme.ts — **the Agentistics code theme**: `agentistics-dark` and `agentistics-light`,
 * DERIVED from this dashboard's own design tokens rather than picked beside them.
 *
 * WHY IT EXISTS. The editor opened on a stock `vs` / `vs-dark`, so a file read in the Studio looked
 * like a different product from the same file read two panels away — `ArtifactDoc`'s own code view
 * already colours code in this app's palette, and `terminalStream.ts`'s `xtermTheme` already does
 * it for the terminal. This is the third surface that shows code, and it is now the same family as
 * the other two instead of Visual Studio's.
 *
 * **IT IS A SELF-CONTAINED, NAMED THING, on purpose.** Nothing here reads a CSS variable, touches
 * the DOM or imports a component; the only import is a TYPE. Both variants' `data` objects are
 * ordinary Monaco theme JSON (`IStandaloneThemeData`), so the theme can be lifted out of this
 * product and published on its own without a rewrite — which is why it is a theme with a name and
 * not a handful of overrides spread through the editor component.
 *
 * ── HOW IT IS DERIVED, in three steps ──────────────────────────────────────────────────────────
 *
 * 1. **`TOKENS` mirrors `index.css` VERBATIM.** Every entry is the literal declaration value of a
 *    custom property in `:root` (dark) or `[data-theme="light"]`, copied as written — `#0a0a0f`,
 *    `rgba(255, 255, 255, 0.92)` — never a hand-resolved equivalent. `monacoTheme.test.ts` PARSES
 *    `index.css` and asserts every one of them still matches, so a token the design changes fails
 *    the build here instead of leaving the editor on last season's palette.
 *
 * 2. **Monaco cannot take a CSS variable or an `rgba()`, so the alpha is COMPOSITED in code.**
 *    A token rule's colour is parsed by monaco's own
 *    `/^#?([0-9A-Fa-f]{6})([0-9A-Fa-f]{2})?$/` and **THROWS** on anything else
 *    (`monaco-editor/esm/vs/editor/common/languages/supports/tokenization.js:105,118`), while a
 *    `colors` entry goes through `Color.fromHex`, which silently yields **`Color.red`**
 *    (`base/common/color.js:182`, called at `standalone/browser/standaloneThemeService.js:73`) —
 *    i.e. one typo paints the gutter bright red with no error anywhere. So `flatten()` composites
 *    `rgba(…)` over the surface it is drawn on and every value in this file is 6- or 8-digit hex,
 *    asserted against that same regex by the test.
 *
 * 3. **A SYNTAX colour is LIFTED until it is legible; a CHROME colour never is.** `--accent-blue`
 *    (#6366f1) sits at 4.42:1 on `--bg-base` — fine for a 14px label, not for 12.5px code — so
 *    `readable()` walks its HSL lightness away from the background in 2% steps until it clears
 *    `MIN_CODE_CONTRAST` (4.5:1, WCAG AA for body text), and in the light theme the same function
 *    DARKENS `--anthropic-orange` from an unreadable 2.55:1 to 4.6:1. Gutter numbers, whitespace
 *    dots and indent guides are deliberately faint and are taken as-is: lifting them would turn
 *    the quietest part of the editor into a second column of text competing with the code.
 *
 *    **THE LINE BETWEEN THE TWO IS "DID SOMEBODY TYPE IT", and `delimiter` was on the wrong side
 *    of it.** The gutter is drawn BY the editor; a `,` `;` `:` is a character in the file, and one
 *    a reader goes looking for when something will not parse. It wore `faint` — 2.62:1 dark,
 *    2.19:1 light — which is the gutter's weight given to the file's own content. It is `muted`
 *    now, the same slot a comment takes: above the code floor, still quieter than the names it
 *    separates. `delimiter.bracket` was already excepted to `fg`, which is what bounded the damage
 *    and is also what made the inconsistency visible — `{` at 16.58:1 beside `;` at 2.62:1.
 *
 * **WHAT THE RULE TABLE IS.** A Monaco theme is not a palette swap: it is a token-rule table, and
 * a token class nobody names inherits the BASE theme's colour — so an unnamed class is a patch of
 * Visual Studio inside this theme. `SYNTAX` therefore covers the classes the grammars in this
 * bundle actually emit, read out of `node_modules/monaco-editor/esm/vs/languages/definitions/**`
 * and `languages/features/json/tokenization.js` rather than guessed: `comment`/`comment.doc`,
 * `string`/`string.key`/`string.escape`/`string.invalid`/`string.link`, `number`, `keyword`,
 * `type`/`type.identifier`, `identifier`, `function`, `variable`/`variable.predefined`, `constant`,
 * `predefined`, `namespace`, `operator`, `delimiter`, `tag`, `attribute.name`/`attribute.value`,
 * `metatag`, `key`, `regexp`, `annotation`, `invalid`, `emphasis`, `strong`, `meta`, `white`.
 * Matching is per dot-segment, so `keyword` also answers for `keyword.json` and `number` for
 * `number.hex.php`; the specific rules here are the ones that must NOT take the general answer.
 *
 * **RED MEANS WRONG, AND ONLY WRONG.** `invalid`, `string.invalid` and the error decorations are
 * the only things that get `--accent-red`; HTML/XML tags take the FUNCTION colour (VS Code's own
 * reading) rather than red, because a file of perfectly valid markup drawn in the fault colour is
 * the same lie this product refuses everywhere else.
 */

import type * as Monaco from 'monaco-editor'

// --- the tokens, mirrored from index.css ----------------------------------------------------------

/**
 * The `index.css` custom properties this theme is built out of, by their own names.
 *
 * Values are the declarations AS WRITTEN in that file (including the spaces inside `rgba(`), so the
 * test that parses it can compare strings rather than re-resolve colours — a comparison that
 * resolved both sides could agree while the editor showed something else.
 */
export interface ThemeTokens {
  /** `--bg-base` — the page's own ground, and the surface `ArtifactDoc` already draws code on. */
  bgBase: string
  /** `--bg-card` — a panel. Monaco's widgets (suggest, hover, find) sit on it. */
  bgCard: string
  /** `--bg-elevated` — a row under the pointer, a selected suggestion, an input. */
  bgElevated: string
  /** `--border` — the hairline between regions. */
  border: string
  /** `--text-primary` — code. */
  textPrimary: string
  /** `--text-secondary` — a comment: prose the reader chose to write, dimmer than the code. */
  textSecondary: string
  /** `--text-tertiary` — the gutter, whitespace, indent guides. Faint BY DESIGN; never lifted. */
  textTertiary: string
  /** `--anthropic-orange` — the product's own accent: the cursor, a find match, a bracket match. */
  orange: string
  /** `--anthropic-orange-light` — numbers, and the escape inside a string. */
  orangeLight: string
  /** `--accent-green` — strings. */
  green: string
  /** `--accent-blue` — functions, tags, links. */
  blue: string
  /** `--accent-purple` — keywords. */
  purple: string
  /** `--accent-cyan` — types, and the NAME side of a `key: value` (JSON, YAML, `.env`). */
  cyan: string
  /** `--accent-red` — invalid tokens and error decorations. Nothing else. */
  red: string
}

/** `:root` — the theme this product ships with. */
export const TOKENS_DARK: ThemeTokens = {
  bgBase: '#0a0a0f',
  bgCard: '#16161f',
  bgElevated: '#1e1e2e',
  border: 'rgba(255, 255, 255, 0.06)',
  textPrimary: 'rgba(255, 255, 255, 0.92)',
  textSecondary: 'rgba(255, 255, 255, 0.55)',
  textTertiary: 'rgba(255, 255, 255, 0.3)',
  orange: '#D97706',
  orangeLight: '#F59E0B',
  green: '#10b981',
  blue: '#6366f1',
  purple: '#8b5cf6',
  cyan: '#06b6d4',
  red: '#ef4444',
}

/** `[data-theme="light"]` — every one of these is redeclared there; none is inherited from above. */
export const TOKENS_LIGHT: ThemeTokens = {
  bgBase: '#f4f4f7',
  bgCard: '#ffffff',
  bgElevated: '#f0f1f5',
  border: 'rgba(0, 0, 0, 0.08)',
  textPrimary: '#18181b',
  textSecondary: 'rgba(24, 24, 27, 0.55)',
  textTertiary: 'rgba(24, 24, 27, 0.35)',
  orange: '#f97316',
  orangeLight: '#fb923c',
  green: '#047857',
  blue: '#4338ca',
  purple: '#7c3aed',
  cyan: '#0e7490',
  red: '#b91c1c',
}

/** The CSS custom property each `ThemeTokens` field mirrors. The test's map, kept beside the data. */
export const TOKEN_PROPERTY: Record<keyof ThemeTokens, string> = {
  bgBase: '--bg-base',
  bgCard: '--bg-card',
  bgElevated: '--bg-elevated',
  border: '--border',
  textPrimary: '--text-primary',
  textSecondary: '--text-secondary',
  textTertiary: '--text-tertiary',
  orange: '--anthropic-orange',
  orangeLight: '--anthropic-orange-light',
  green: '--accent-green',
  blue: '--accent-blue',
  purple: '--accent-purple',
  cyan: '--accent-cyan',
  red: '--accent-red',
}

// --- colour arithmetic (pure) --------------------------------------------------------------------

interface RGB { r: number; g: number; b: number }
interface RGBA extends RGB { a: number }

const HEX6 = /^#([0-9a-f]{6})$/i
const HEX3 = /^#([0-9a-f]{3})$/i
const RGB_FN = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i

/**
 * One CSS colour of the forms this app's tokens actually use — `#rgb`, `#rrggbb`, `rgb()`,
 * `rgba()`. `null` for anything else: a colour this module cannot read is never GUESSED, because a
 * guess here is a wrong colour on every line of every file.
 */
export function parseCssColor(css: string): RGBA | null {
  const s = css.trim()
  const six = HEX6.exec(s)
  if (six !== null) {
    const h = six[1]!
    return {
      r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16),
      a: 1,
    }
  }
  const three = HEX3.exec(s)
  if (three !== null) {
    const h = three[1]!
    const dup = (c: string): number => parseInt(c + c, 16)
    return { r: dup(h[0]!), g: dup(h[1]!), b: dup(h[2]!), a: 1 }
  }
  const fn = RGB_FN.exec(s)
  if (fn === null) return null
  const a = fn[4] === undefined ? 1 : Number(fn[4])
  if (!Number.isFinite(a)) return null
  return { r: Number(fn[1]), g: Number(fn[2]), b: Number(fn[3]), a: Math.min(1, Math.max(0, a)) }
}

const clampByte = (n: number): number => Math.min(255, Math.max(0, Math.round(n)))

function toHex({ r, g, b }: RGB): string {
  const pair = (n: number): string => clampByte(n).toString(16).padStart(2, '0')
  return `#${pair(r)}${pair(g)}${pair(b)}`
}

/**
 * A token's value as the OPAQUE hex it actually renders as, composited over the surface it is drawn
 * on. `rgba(255, 255, 255, 0.55)` is not a colour Monaco can hold — and it is not even a fixed
 * colour: over `--bg-base` it is one grey and over a widget it is another.
 *
 * Throws rather than returning a fallback, and that is deliberate: the only input is this file's own
 * `TOKENS`, every test in `monacoTheme.test.ts` imports this module, so an unreadable value fails
 * the suite at import. A silent fallback would ship a wrong colour to a reader instead.
 */
export function flatten(css: string, overHex: string): string {
  const fg = parseCssColor(css)
  if (fg === null) throw new Error(`monacoTheme: cannot read colour ${JSON.stringify(css)}`)
  if (fg.a >= 1) return toHex(fg)
  const bg = parseCssColor(overHex)
  if (bg === null) throw new Error(`monacoTheme: cannot read surface ${JSON.stringify(overHex)}`)
  return toHex({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
  })
}

/** `#rrggbbaa` — a translucent wash (a selection, a find match) Monaco blends itself. */
export function alpha(hex: string, a: number): string {
  const c = parseCssColor(hex)
  if (c === null) throw new Error(`monacoTheme: cannot read colour ${JSON.stringify(hex)}`)
  return `${toHex(c)}${clampByte(a * 255).toString(16).padStart(2, '0')}`
}

/** WCAG 2.1 relative luminance. */
function luminance({ r, g, b }: RGB): number {
  const channel = (v: number): number => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

/** WCAG 2.1 contrast ratio, 1..21. Order-independent. */
export function contrastRatio(aHex: string, bHex: string): number {
  const a = parseCssColor(aHex)
  const b = parseCssColor(bHex)
  if (a === null || b === null) throw new Error('monacoTheme: cannot read colour for contrast')
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

function toHsl({ r, g, b }: RGB): { h: number; s: number; l: number } {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  if (max === min) return { h: 0, s: 0, l }
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  const h = max === rn
    ? ((gn - bn) / d + (gn < bn ? 6 : 0))
    : max === gn ? (bn - rn) / d + 2 : (rn - gn) / d + 4
  return { h: h / 6, s, l }
}

function fromHsl(h: number, s: number, l: number): RGB {
  if (s === 0) return { r: l * 255, g: l * 255, b: l * 255 }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const channel = (t0: number): number => {
    let t = t0
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  return { r: channel(h + 1 / 3) * 255, g: channel(h) * 255, b: channel(h - 1 / 3) * 255 }
}

/** WCAG AA for body text. Code is 12.5px here, which is exactly the size this floor is for. */
export const MIN_CODE_CONTRAST = 4.5

/**
 * WCAG 1.4.11 (non-text contrast) for the things that are SHAPES rather than text: the caret, the
 * bracket-match outline, a warning squiggle, a focus ring.
 *
 * It is a separate, lower floor because those are not read letter by letter — but it is a floor all
 * the same: `--anthropic-orange` is 2.55:1 on the LIGHT `--bg-base`, so the caret taken straight
 * from the token was a pale orange line somebody has to hunt for on the one surface where losing
 * your cursor costs the most (a file you are about to type into).
 */
export const MIN_UI_CONTRAST = 3

/** How far one step moves a colour's HSL lightness. Small enough to stop at the first passing tint. */
const LIFT_STEP = 0.02

/**
 * The same HUE, at a lightness that clears `min` against `bg` — lighter on a dark ground, darker on
 * a light one, and returned UNTOUCHED when it already passes.
 *
 * This is what lets a SYNTAX colour be an accent token rather than a second, hand-tuned copy of it:
 * `--accent-blue` passes on the light theme and needs one step on the dark one, `--anthropic-orange`
 * is the other way round, and neither fact has to be remembered by a person editing a palette.
 * Saturation and hue never move, so the result is still recognisably the product's colour.
 */
export function readable(hex: string, bgHex: string, min = MIN_CODE_CONTRAST): string {
  const rgb = parseCssColor(hex)
  const bg = parseCssColor(bgHex)
  if (rgb === null || bg === null) throw new Error('monacoTheme: cannot read colour for lift')
  const lighten = luminance(bg) < 0.5
  const { h, s } = toHsl(rgb)
  let { l } = toHsl(rgb)
  // Bounded by construction: 101 steps of 0.02 cover the whole 0..1 range, so the loop cannot spin
  // on a hue that never reaches the target (a saturated yellow on white, say) — it ends at the
  // closest it can get, which is still the best available reading of that token.
  for (let i = 0; i <= 100; i++) {
    const candidate = toHex(fromHsl(h, s, l))
    if (contrastRatio(candidate, bgHex) >= min) return candidate
    const next = lighten ? l + LIFT_STEP : l - LIFT_STEP
    if (next < 0 || next > 1) return candidate
    l = next
  }
  return toHex(fromHsl(h, s, l))
}

// --- the palette ---------------------------------------------------------------------------------

/**
 * Every colour this theme uses, named by the JOB it does rather than by the hue it happens to be —
 * which is what makes the rule table below readable, and what makes the test able to prove that the
 * table holds no literal colour of its own.
 */
export interface CodePalette {
  // surfaces
  bg: string
  bgWidget: string
  bgElevated: string
  border: string
  // text
  fg: string
  muted: string
  faint: string
  // syntax
  keyword: string
  string: string
  number: string
  type: string
  func: string
  constant: string
  error: string
  // accents and washes
  accent: string
  selection: string
  selectionSoft: string
  lineHighlight: string
  guide: string
  guideActive: string
  findMatch: string
  findHighlight: string
  bracketMatch: string
  scrollbar: string
  scrollbarHover: string
  scrollbarActive: string
  diffAdd: string
  diffRemove: string
  transparent: string
}

/**
 * Tokens in, palette out. The only place a colour is decided.
 *
 * Read the three groups as three different rules: surfaces and faint text are the tokens themselves
 * (composited where they carry alpha), syntax colours are the accent tokens LIFTED to
 * `MIN_CODE_CONTRAST`, and the washes are derived from whichever of those they are a wash OF.
 */
export function buildPalette(tokens: ThemeTokens): CodePalette {
  const bg = flatten(tokens.bgBase, tokens.bgBase)
  const bgWidget = flatten(tokens.bgCard, tokens.bgBase)
  const fg = flatten(tokens.textPrimary, bg)
  const lift = (css: string): string => readable(css, bg)
  return {
    bg,
    bgWidget,
    bgElevated: flatten(tokens.bgElevated, bg),
    border: flatten(tokens.border, bgWidget),
    fg,
    // A comment in this codebase is a paragraph somebody wrote to be read, so it is lifted like
    // code rather than left at the gutter's weight — dimmer than `fg`, never faint.
    muted: lift(flatten(tokens.textSecondary, bg)),
    // NOT lifted. See the header: the gutter is meant to recede.
    faint: flatten(tokens.textTertiary, bg),
    keyword: lift(tokens.purple),
    string: lift(tokens.green),
    number: lift(tokens.orangeLight),
    type: lift(tokens.cyan),
    func: lift(tokens.blue),
    constant: lift(tokens.orange),
    error: lift(tokens.red),
    // The caret and the outlines: lifted to the SHAPE floor, not the text one. See `MIN_UI_CONTRAST`.
    accent: readable(tokens.orange, bg, MIN_UI_CONTRAST),
    // The selection is a wash of the TEXT colour, so it reads as "these characters", and it is the
    // same weight the terminal's own selection uses in `xtermTheme` (0.20 dark / 0.14 light).
    selection: alpha(fg, 0.22),
    selectionSoft: alpha(fg, 0.1),
    lineHighlight: alpha(fg, 0.045),
    guide: alpha(fg, 0.07),
    guideActive: alpha(fg, 0.16),
    findMatch: alpha(flatten(tokens.orange, bg), 0.38),
    findHighlight: alpha(flatten(tokens.orange, bg), 0.18),
    bracketMatch: alpha(flatten(tokens.orange, bg), 0.22),
    scrollbar: alpha(fg, 0.1),
    scrollbarHover: alpha(fg, 0.18),
    scrollbarActive: alpha(fg, 0.26),
    diffAdd: alpha(flatten(tokens.green, bg), 0.18),
    diffRemove: alpha(flatten(tokens.red, bg), 0.18),
    // A real value, not an omission: `editor.lineHighlightBorder` and the overview ruler's border
    // are drawn by the base theme and this theme wants NEITHER — the line highlight's own fill says
    // it already, and a ruler border is a vertical line beside a scrollbar in a 280px column.
    transparent: '#00000000',
  }
}

// --- the rule table ------------------------------------------------------------------------------

/** Which palette slot a Monaco token class takes, and whether it is drawn differently. */
interface SyntaxRule {
  token: string
  slot: keyof CodePalette
  fontStyle?: string
}

/**
 * The token classes, in the order Monaco reads them (the order is irrelevant to matching — it sorts
 * them — so they are grouped for a person instead).
 *
 * The `''` rule is the DEFAULT: plain text, and anything no other rule answers for.
 */
const SYNTAX: readonly SyntaxRule[] = [
  { token: '', slot: 'fg' },

  // prose the author wrote
  { token: 'comment', slot: 'muted' },
  { token: 'comment.doc', slot: 'muted' },
  { token: 'comment.content', slot: 'muted' },

  // values
  { token: 'string', slot: 'string' },
  { token: 'string.escape', slot: 'constant' },
  { token: 'string.invalid', slot: 'error' },
  { token: 'string.link', slot: 'func', fontStyle: 'underline' },
  { token: 'number', slot: 'number' },
  { token: 'regexp', slot: 'constant' },
  { token: 'constant', slot: 'constant' },
  { token: 'predefined', slot: 'constant' },
  { token: 'annotation', slot: 'constant' },

  // names
  { token: 'keyword', slot: 'keyword' },
  { token: 'type', slot: 'type' },
  { token: 'type.identifier', slot: 'type' },
  { token: 'namespace', slot: 'type' },
  { token: 'identifier', slot: 'fg' },
  { token: 'function', slot: 'func' },
  { token: 'variable', slot: 'fg' },
  { token: 'variable.predefined', slot: 'constant' },

  // THE NAME SIDE of a pair: `KEY=` in a `.env`, a JSON property, a YAML key. One colour for all
  // three, so a config file reads the same whichever of the three shapes it happens to use.
  { token: 'key', slot: 'type' },
  { token: 'string.key', slot: 'type' },
  { token: 'string.value', slot: 'string' },

  // markup
  { token: 'tag', slot: 'func' },
  { token: 'metatag', slot: 'keyword' },
  { token: 'attribute.name', slot: 'type' },
  { token: 'attribute.value', slot: 'string' },

  // punctuation and the in-between
  { token: 'operator', slot: 'fg' },
  // **PUNCTUATION IS CODE, SO IT IS NOT `faint`.** It was, and that slot is spent by its own doc
  // comment on the gutter, whitespace and indent guides — chrome the reader is meant to look past.
  // A `,` `;` `:` is none of those: it is a character the author typed and the one a reader hunts
  // for when something will not parse, and it was drawn at 2.62:1 dark / 2.19:1 light, under the
  // floor this whole module exists to enforce. `muted` (6.28 / 4.77) clears the CODE floor while
  // keeping punctuation quieter than the names around it, which is what `faint` was reaching for.
  // Checked by eye against both alternatives at 12.5px on both grounds: `faint` loses the colons
  // inside `(name: string, kind: 'file')` on the light theme, and `fg` gives a `;` the same weight
  // as an identifier. **THIS PUTS `delimiter` IN THE SAME SLOT AS `comment`**, so a `;` and a `//`
  // carry the exact same colour — deliberate, not an oversight: both are quieter-than-code prose
  // the reader looks past rather than reads for meaning, and neither competes with a name.
  { token: 'delimiter', slot: 'muted' },
  { token: 'delimiter.bracket', slot: 'fg' },
  { token: 'meta', slot: 'muted' },
  { token: 'white', slot: 'faint' },

  // markdown's own two, which are about WEIGHT rather than colour
  { token: 'emphasis', slot: 'fg', fontStyle: 'italic' },
  { token: 'strong', slot: 'fg', fontStyle: 'bold' },

  // and the one thing red is for
  { token: 'invalid', slot: 'error' },
]

/**
 * The editor's CHROME, by Monaco colour id.
 *
 * Every id here is registered in the installed monaco (verified by walking its own
 * `registerColor(` calls) — an id nobody registered is silently ignored, which would leave a
 * carefully chosen colour doing nothing at all.
 *
 * The six bracket-pair colours walk the syntax palette on purpose: nesting is read by HUE, and
 * reusing the syntax slots keeps a nested call from introducing a seventh colour nothing else uses.
 */
const CHROME: Record<string, keyof CodePalette> = {
  'editor.background': 'bg',
  'editor.foreground': 'fg',
  'editorGutter.background': 'bg',
  'editorStickyScroll.background': 'bg',
  'editorStickyScrollHover.background': 'bgElevated',

  'editorLineNumber.foreground': 'faint',
  'editorLineNumber.activeForeground': 'muted',
  'editorWhitespace.foreground': 'guideActive',
  'editorIndentGuide.background1': 'guide',
  'editorIndentGuide.activeBackground1': 'guideActive',
  'editorRuler.foreground': 'guide',

  'editorCursor.foreground': 'accent',
  'editorCursor.background': 'bg',

  'editor.selectionBackground': 'selection',
  'editor.inactiveSelectionBackground': 'selectionSoft',
  'editor.selectionHighlightBackground': 'selectionSoft',
  'editor.wordHighlightBackground': 'selectionSoft',
  'editor.wordHighlightStrongBackground': 'selectionSoft',
  'editor.lineHighlightBackground': 'lineHighlight',
  'editor.lineHighlightBorder': 'transparent',

  'editor.findMatchBackground': 'findMatch',
  'editor.findMatchHighlightBackground': 'findHighlight',
  'editorOverviewRuler.border': 'transparent',
  'editorOverviewRuler.findMatchForeground': 'accent',
  'editorOverviewRuler.errorForeground': 'error',
  'editorOverviewRuler.warningForeground': 'accent',

  'editorBracketMatch.background': 'bracketMatch',
  'editorBracketMatch.border': 'accent',
  'editorBracketHighlight.foreground1': 'func',
  'editorBracketHighlight.foreground2': 'constant',
  'editorBracketHighlight.foreground3': 'type',
  'editorBracketHighlight.foreground4': 'keyword',
  'editorBracketHighlight.foreground5': 'string',
  'editorBracketHighlight.foreground6': 'number',
  'editorBracketHighlight.unexpectedBracket.foreground': 'error',

  'editorError.foreground': 'error',
  'editorWarning.foreground': 'accent',
  'editorInfo.foreground': 'func',
  'editorLink.activeForeground': 'func',

  'editorWidget.background': 'bgWidget',
  'editorWidget.foreground': 'fg',
  'editorWidget.border': 'border',
  'editorSuggestWidget.background': 'bgWidget',
  'editorSuggestWidget.border': 'border',
  'editorSuggestWidget.selectedBackground': 'bgElevated',
  'editorHoverWidget.background': 'bgWidget',
  'editorHoverWidget.border': 'border',
  'quickInput.background': 'bgWidget',
  'input.background': 'bgElevated',
  'input.foreground': 'fg',
  'input.border': 'border',
  'list.hoverBackground': 'bgElevated',
  'list.focusBackground': 'bgElevated',
  'focusBorder': 'accent',

  'diffEditor.insertedTextBackground': 'diffAdd',
  'diffEditor.removedTextBackground': 'diffRemove',
}

/** What the theme is called in Monaco. Only `[a-z0-9-]` — `defineTheme` throws on anything else. */
export const AGENTISTICS_THEME_NAME = { dark: 'agentistics-dark', light: 'agentistics-light' } as const

export type CodeThemeVariant = keyof typeof AGENTISTICS_THEME_NAME

/**
 * The theme, as Monaco takes it.
 *
 * `inherit: true` is load-bearing: it keeps the base theme's answers for the ~370 colour ids this
 * file does not name (a peek-view border, a diff gutter), so the parts of Monaco this feature does
 * not use are still coherent rather than unstyled.
 */
export function agentisticsThemeData(variant: CodeThemeVariant): Monaco.editor.IStandaloneThemeData {
  const tokens = variant === 'light' ? TOKENS_LIGHT : TOKENS_DARK
  const palette = buildPalette(tokens)
  const colors: Record<string, string> = {}
  for (const [id, slot] of Object.entries(CHROME)) colors[id] = palette[slot]
  return {
    base: variant === 'light' ? 'vs' : 'vs-dark',
    inherit: true,
    rules: SYNTAX.map(r => ({
      token: r.token,
      foreground: palette[r.slot],
      ...(r.fontStyle === undefined ? {} : { fontStyle: r.fontStyle }),
    })),
    colors,
  }
}

/** The editor's theme name for an `<html data-theme>` value — the one place the app records it. */
export function codeThemeName(attr: string | null): string {
  return attr === 'light' ? AGENTISTICS_THEME_NAME.light : AGENTISTICS_THEME_NAME.dark
}

/** Colours for syntax-highlighting views like `ArtifactDoc`'s CodeView, mapped from lexer token kinds. */
export interface CodeHighlightColors {
  plain: string
  comment: string
  string: string
  number: string
  keyword: string
  punct: string
}

/**
 * Build a color map for the code highlighter, using the derived palette.
 * This ensures the reading view has the same contrast-compliant colours as the editor.
 *
 * Token mapping:
 * - `plain` → `fg` (the main foreground colour)
 * - `comment` → `muted` (prose the author wrote, lifted for readability)
 * - `string` → `string` (string literals, lifted)
 * - `number` → `number` (numeric literals, lifted)
 * - `keyword` → `keyword` (keywords, lifted)
 * - `punct` → `muted` (punctuation, lifted above code floor but dimmer than identifiers)
 */
export function buildHighlightColors(variant: CodeThemeVariant): CodeHighlightColors {
  const tokens = variant === 'light' ? TOKENS_LIGHT : TOKENS_DARK
  const palette = buildPalette(tokens)
  return {
    plain: palette.fg,
    comment: palette.muted,
    string: palette.string,
    number: palette.number,
    keyword: palette.keyword,
    punct: palette.muted,
  }
}

/**
 * The narrowest thing this module needs of Monaco: somewhere to define a theme. Structural on
 * purpose — it is what lets the registration be driven by a test without loading the editor.
 */
export interface ThemeHost {
  editor: { defineTheme(name: string, data: Monaco.editor.IStandaloneThemeData): void }
}

/**
 * Register both variants. **Must be called before the first `editor.create`**: Monaco's
 * `setTheme` falls back to plain `vs` for a name it does not know
 * (`standalone/browser/standaloneThemeService.js`), so an editor created with `theme:
 * 'agentistics-dark'` one tick too early comes up in the LIGHT Visual Studio theme on a dark page —
 * and nothing anywhere reports it. Idempotent: `defineTheme` replaces a theme of the same name and
 * refreshes it if it is the one currently applied.
 */
export function defineAgentisticsThemes(monaco: ThemeHost): void {
  monaco.editor.defineTheme(AGENTISTICS_THEME_NAME.dark, agentisticsThemeData('dark'))
  monaco.editor.defineTheme(AGENTISTICS_THEME_NAME.light, agentisticsThemeData('light'))
}
