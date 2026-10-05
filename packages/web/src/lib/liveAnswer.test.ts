import { expect, test, describe } from 'bun:test'
import { liveAnswerText } from './liveAnswer'

// Frames shaped like Claude Code's own screen: the history above, then the input box between two
// rules, then the footer. `●` (or the older `⏺`) opens every assistant block.
const box = ['────────────────────────', '> ', '────────────────────────', '  ⏵⏵ auto mode on (shift+tab to cycle)']

describe('liveAnswerText', () => {
  test('the answer block being written, continuation lines unindented', () => {
    expect(liveAnswerText({
      harness: 'claude', working: true,
      lines: ['> what is the port?', '', '● The port is 47291 because the api and', '  the mcp share it.', '', '✻ Pondering… (3s · esc to interrupt)', '', ...box],
    })).toBe('The port is 47291 because the api and the mcp share it.')
  })

  test('grows with the frame — each capture yields a longer text', () => {
    const at = (words: string) => liveAnswerText({ harness: 'claude', working: true, lines: ['> q', '● ' + words, ...box] })
    expect(at('one')).toBe('one')
    expect(at('one two three')).toBe('one two three')
  })

  test('a block wrapped by the pane with no indent (a raw-mode program) is still one block', () => {
    expect(liveAnswerText({
      harness: 'claude', working: true,
      lines: ['> q', '● answer to q lorem ipsum dolor sit amet lorem ip', 'sum dolor sit amet'],
    })).toBe('answer to q lorem ipsum dolor sit amet lorem ip\nsum dolor sit amet')
  })

  test('the older ⏺ marker is read the same way', () => {
    expect(liveAnswerText({ harness: 'claude', working: true, lines: ['> q', '⏺ Reading it now.', ...box] })).toBe('Reading it now.')
  })

  test('a paragraph break inside the answer is kept, trailing blanks are not', () => {
    expect(liveAnswerText({
      harness: 'claude', working: true,
      lines: ['> q', '● First paragraph.', '', '  Second one.', '', '', ...box],
    })).toBe('First paragraph.\n\nSecond one.')
  })

  test('a tool call is not an answer', () => {
    expect(liveAnswerText({
      harness: 'claude', working: true,
      lines: ['> q', '● Bash(bun test)', '  ⎿  Running…', '', '✻ Working… (esc to interrupt)', ...box],
    })).toBeNull()
  })

  test('the newest block wins over an earlier one in the same turn', () => {
    expect(liveAnswerText({
      harness: 'claude', working: true,
      lines: ['> q', '● Let me look.', '', '● Read(a.ts)', '  ⎿  Read 10 lines', '', '● It is in a.ts.', ...box],
    })).toBe('It is in a.ts.')
  })

  test('the user has spoken after the last block: the answer has not started yet', () => {
    expect(liveAnswerText({
      harness: 'claude', working: true,
      lines: ['> first', '● The old answer.', '', '> second', '', '✻ Thinking…', ...box],
    })).toBeNull()
  })

  test('text typed into the input box does not hide the answer above it', () => {
    expect(liveAnswerText({
      harness: 'claude', working: true,
      lines: ['> q', '● Half an answer', '────────', '> I am typing', '────────'],
    })).toBe('Half an answer')
  })

  test('the screen still showing the committed answer is not a new one', () => {
    expect(liveAnswerText({
      harness: 'claude', working: true, lastCommitted: 'The port is taken. writtenAt=1',
      lines: ['> q', '● The port is', '  taken.', ...box],
    })).toBeNull()
  })

  test('not working, or not claude, or nothing on screen: null', () => {
    expect(liveAnswerText({ harness: 'claude', working: false, lines: ['> q', '● Done.'] })).toBeNull()
    // Another harness's screen has not been measured; guessing its chrome is the leak that once
    // got the raw screen bubble removed.
    expect(liveAnswerText({ harness: 'codex', working: true, lines: ['> q', '● Done.'] })).toBeNull()
    expect(liveAnswerText({ harness: 'claude', working: true, lines: [] })).toBeNull()
    expect(liveAnswerText({ harness: 'claude', working: true, lines: ['> q', '● ', ...box] })).toBeNull()
  })
})

test('a committed answer with markdown marks still on screen (rendered) is not drawn twice', () => {
  expect(liveAnswerText({
    harness: 'claude', working: true, lastCommitted: 'Use **`bun test`** here.',
    lines: ['> q', '● Use bun test here.', ...box],
  })).toBeNull()
})

test('a committed answer the pane wrapped MID-WORD is still recognised as committed', () => {
  expect(liveAnswerText({
    harness: 'claude', working: true, lastCommitted: 'answer to q lorem ipsum dolor writtenAt=1',
    lines: ['> q', '● answer to q lorem ip', 'sum dolor'],
  })).toBeNull()
})
