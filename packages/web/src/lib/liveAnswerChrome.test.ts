import { describe, expect, test } from 'bun:test'
import { holdLiveAnswer, liveAnswerText } from './liveAnswer'

// A pane capture as the owner saw it: the answer wrapped at the pane's width, then the done status,
// the monitor count, a collapsed shell group and its header, the mode line, the input box.
const pane = [
  '● Fixed the bug in the parser. The cause was a missing newline at the end of the',
  '  buffer, so the last record was never flushed before the reader closed.',
  '',
  '  - first item',
  '  - second item',
  '',
  '✻ Worked for 10s · done 8:27 AM · 1 monitor still running',
  'Running 1 shell command…',
  'Bash cat >> /tmp/notes.txt <<EOF …',
  '1 monitor still running',
  '────────────────────────────────',
  '> ',
  '────────────────────────────────',
  '  ⏵⏵ auto mode on (shift+tab to cycle)',
]
const committed =
  'Fixed the bug in the parser. The cause was a missing newline at the end of the buffer, so the last record was never flushed before the reader closed.\n\n- first item\n- second item'

describe('liveAnswerText — no terminal chrome, no wrap breaks', () => {
  test('the bubble holds the answer only, unwrapped', () => {
    const t = liveAnswerText({ harness: 'claude', lines: pane, working: true })
    expect(t).toBe(
      'Fixed the bug in the parser. The cause was a missing newline at the end of the buffer, so the last record was never flushed before the reader closed.\n\n- first item\n- second item',
    )
    for (const chrome of ['Worked for', 'monitor', 'Running 1', 'Bash', 'auto mode', '─']) expect(t).not.toContain(chrome)
  })

  test('once the finished turn is on screen the live bubble is gone, even with chrome under it', () => {
    expect(liveAnswerText({ harness: 'claude', lines: pane, working: true, lastCommitted: committed })).toBeNull()
  })

  test('prose that opens with a tool name is not chrome', () => {
    const t = liveAnswerText({ harness: 'claude', lines: ['● Read the file first, then edit it.', '', '────'], working: true })
    expect(t).toBe('Read the file first, then edit it.')
  })

  test('hold: no duplicate after the turn lands, no gap before it', () => {
    const live = liveAnswerText({ harness: 'claude', lines: pane, working: true })
    const shown = holdLiveAnswer(null, live, 4, 'older answer', 1000)
    expect(shown.text).toBe(live)
    // screen moved on, turn not landed yet: still shown (no gap)
    const gap = holdLiveAnswer(shown.held, null, 4, 'older answer', 3000)
    expect(gap.text).toBe(live)
    // turn landed: gone — and also gone if the screen STILL shows the answer
    expect(holdLiveAnswer(gap.held, null, 5, committed, 4000).text).toBeNull()
    expect(holdLiveAnswer(gap.held, live, 5, committed, 4000).text).toBeNull()
  })
})
