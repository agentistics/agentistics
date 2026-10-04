/**
 * theme.ts — the terminal palette, mapped from the web dashboard's dark mode so the two
 * surfaces read as one product.
 *
 * Ink accepts hex colors and downsamples for terminals that cannot show them, so these are the
 * same values the web app uses rather than approximated 256-color indices.
 */

import type { SurfaceHarnessId } from '@agentistics/core'

const DARK = {
  /** Primary accent (Anthropic amber, #f59e0b in the web app). */
  accent: '#f59e0b',
  secondary: '#6366f1',
  success: '#10b981',
  /**
   * A session that is RUNNING — its own token, not `success`.
   *
   * `success` is emerald and reads as teal on a terminal: beside a cyan focus highlight it was
   * reported as "blue", and it is within a hair of `HARNESS_COLOR.codex` (#10a37f), so a codex row
   * that was working wore one colour twice. This green cannot be mistaken for either.
   */
  running: '#22c55e',
  danger: '#f43f5e',
  info: '#38bdf8',
  text: '#ffffff',
  muted: 'gray',
  /**
   * A pane's title when it does not have the keyboard.
   *
   * Lighter than the border and lighter than `dimColor`, which is what the titles used to be: a
   * label the terminal renders at half intensity over a dark background is not a quiet label, it is
   * an unreadable one — and these titles are the only thing saying what each box holds.
   */
  label: '#a1a1aa',
  border: '#3f3f46',
}

export type Palette = { [K in keyof typeof DARK]: string }

/** ST-04: the themes the terminal draws. `dark` is the web dashboard's dark mode (the default). */
export type ThemeId = 'dark' | 'light' | 'contrast'
export const THEME_IDS: readonly ThemeId[] = ['dark', 'light', 'contrast']

const PALETTES: Record<ThemeId, Palette> = {
  dark: DARK,
  // For a LIGHT terminal background: the web's light-mode inks, dark enough to read on white.
  light: {
    accent: '#b45309', secondary: '#4338ca', success: '#047857', running: '#15803d', danger: '#be123c',
    info: '#0369a1', text: '#18181b', muted: '#52525b', label: '#3f3f46', border: '#a1a1aa',
  },
  // Every colour lifted toward the background's opposite: no grey a dim terminal halves into nothing.
  contrast: {
    accent: '#fbbf24', secondary: '#a5b4fc', success: '#34d399', running: '#4ade80', danger: '#fb7185',
    info: '#7dd3fc', text: '#ffffff', muted: '#d4d4d8', label: '#e4e4e7', border: '#a1a1aa',
  },
}

/**
 * The palette every screen reads. ONE object, mutated in place by `applyTheme`, so every
 * `COLORS.accent` read at render time follows the theme without each screen taking it as a prop —
 * the shell re-renders after a switch and the whole frame is drawn in the new palette.
 */
export const COLORS: Palette = { ...DARK }

let current: ThemeId = 'dark'

export function applyTheme(id: ThemeId): void {
  current = PALETTES[id] ? id : 'dark'
  Object.assign(COLORS, PALETTES[current])
}

export function currentTheme(): ThemeId {
  return current
}

/** Mirrors HARNESS_COLORS in packages/web/src/lib/harness.ts — keep the two in step. */
export const HARNESS_COLOR: Record<SurfaceHarnessId, string> = {
  claude: '#D97706',
  codex: '#10a37f',
  gemini: '#4285f4',
  // Copilot's web grey (#6e7681) is unreadable against a dim terminal background, so the
  // terminal uses a lighter grey of the same hue. Every other harness matches the web exactly.
  copilot: '#9ca3af',
  antigravity: '#8b5cf6',
  kimi: '#e11d48',
  // Mirrors HARNESS_COLORS.opencode in packages/web/src/lib/harness.ts.
  opencode: '#06b6d4',
  // Mirrors HARNESS_COLORS.agentistics in packages/web/src/lib/harness.ts.
  agentistics: '#f97316',
}

export const HARNESS_LABEL: Record<SurfaceHarnessId, string> = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  copilot: 'Copilot',
  antigravity: 'Antigravity',
  kimi: 'Kimi',
  opencode: 'opencode',
  agentistics: 'Agentistics',
}

/**
 * A harness's name and colour for ANY id the data carries — the table above, plus the native
 * harness (`agentistics`, present in the figures once the experimental flag is on) and, for an id
 * nobody listed yet, the id itself. Indexing the tables directly handed `undefined` to a renderer
 * that called `.length` on it: the dashboard died the first day native usage reached the figures.
 */
export function harnessLabel(id: string | null | undefined): string {
  if (!id) return 'N/A'
  if (id === 'agentistics') return 'Agentistics'
  return (HARNESS_LABEL as Record<string, string>)[id] ?? id
}

export function harnessColor(id: string | null | undefined): string {
  if (id === 'agentistics') return COLORS.accent
  return (id ? (HARNESS_COLOR as Record<string, string>)[id] : undefined) ?? COLORS.label
}
