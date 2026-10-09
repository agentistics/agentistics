import { describe, expect, test } from 'bun:test'
import { HARNESS_ORDER, type HarnessId } from '@agentistics/core'
import { classifySendFailure, promptIsBlocked } from './prompt-guard'

/**
 * Per harness: a screen with a dialog open (its real footer, from `attention-rules.ts`'s probes) and a
 * screen sitting at an ordinary input. `null` is a harness nobody has probed — it can never be called
 * blocked, which the test pins rather than hides.
 */
const SCREENS: Record<HarnessId, { blocked: string[]; idle: string[] } | null> = {
  claude: {
    blocked: ['Bash command', '  rm -rf build', '', 'Do you want to proceed?', '❯ 1. Yes', '  2. No', '', 'Esc to cancel · Tab to amend'],
    idle: ['● Done.', '', '╭──────╮', '│ >    │', '╰──────╯', '  ? for shortcuts'],
  },
  codex: {
    blocked: ['', '  Would you like to run the following command?', '', '  $ touch b.txt', '', '› 1. Yes, proceed (y)', '  2. No (esc)', '', '  Press enter to confirm or esc to cancel'],
    idle: ['• Done.', '', '› Find and fix a bug in @filename', '', 'gpt-5.4-mini low · 100% left · /tmp/scratchpad'],
  },
  gemini: {
    blocked: ['Do you trust this folder?', '● 1. Yes', '  2. No', '', 'Enter to select · ↑/↓ to navigate · Esc to cancel'],
    idle: ['✦ Done.', '', '> Type your message or @path/to/file', ' ~/proj   gemini-2.5-pro'],
  },
  copilot: {
    blocked: ['Allow this tool?', '❯ 1. Yes', '  2. No', '', '↑/↓ to navigate · enter to select · esc to cancel'],
    idle: ['● Done.', '', '> ', ' ctrl+c exit · / commands'],
  },
  kimi: {
    blocked: ['Approve this action?', '❯ Yes', '  No', '', '↑↓ navigate · Enter select · Esc exit'],
    idle: ['Done.', '', '┃ ', 'kimi-k2 · ctrl+c to exit'],
  },
  antigravity: {
    blocked: ['Run command?', '  git push', '', '↑/↓ Navigate · enter Confirm · esc Cancel'],
    idle: ['Done.', '', '> ', 'agy · gemini-3.6-flash'],
  },
  opencode: null,
}

describe('prompt guard, per harness', () => {
  test('the table covers every harness there is', () => {
    expect(Object.keys(SCREENS).sort()).toEqual([...HARNESS_ORDER].sort())
  })

  for (const harness of HARNESS_ORDER) {
    const screens = SCREENS[harness]
    if (!screens) {
      test(`${harness}: never probed, so never called blocked`, () => {
        expect(promptIsBlocked(harness, ['anything'])).toBe(false)
      })
      continue
    }
    test(`${harness}: a dialog blocks, an ordinary input does not`, () => {
      expect(promptIsBlocked(harness, screens.blocked)).toBe(true)
      expect(promptIsBlocked(harness, screens.idle)).toBe(false)
    })
    test(`${harness}: a failed write is named by what the screen says AFTER it`, () => {
      expect(classifySendFailure(harness, screens.blocked, true)).toBe('prompt')
      // Alive and not on a dialog: the keys went in and the submit is unproven. NEVER "ended".
      expect(classifySendFailure(harness, screens.idle, true)).toBe('unconfirmed')
      // Only a pane that is gone is a real end, whatever its last frame said.
      expect(classifySendFailure(harness, screens.idle, false)).toBe('ended')
      expect(classifySendFailure(harness, screens.blocked, false)).toBe('ended')
    })
  }
})

describe('gemini usage-limit dialog (live capture)', () => {
  const frame = require('node:fs').readFileSync(require('node:path').join(import.meta.dir, 'fixtures/gemini-quota/limit.txt'), 'utf8').split('\n') as string[]
  test('is a blocking dialog although it has no select footer', () => {
    expect(promptIsBlocked('gemini', frame)).toBe(true)
    expect(classifySendFailure('gemini', frame, true)).toBe('prompt')
  })
})
