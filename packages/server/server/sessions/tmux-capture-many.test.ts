import { describe, expect, it } from 'bun:test'
import { captureManyArgs, splitCaptureMany, TMUX_SOCKET, tmuxName } from './tmux-cli'

describe('captureManyArgs', () => {
  it('is one sequence: a capture then the separator, per id', () => {
    expect(captureManyArgs(['a', 'b'], 60, 'SEP')).toEqual([
      '-L', TMUX_SOCKET,
      'capture-pane', '-p', '-t', tmuxName('a'), '-S', '-60', ';', 'display-message', '-p', 'SEP', ';',
      'capture-pane', '-p', '-t', tmuxName('b'), '-S', '-60', ';', 'display-message', '-p', 'SEP',
    ])
  })
})

describe('splitCaptureMany', () => {
  it('cuts one frame per separator, trailing blanks trimmed', () => {
    expect(splitCaptureMany('a1\na2\n\n\nSEP\nb1\nSEP\n', 2, 'SEP')).toEqual([['a1', 'a2'], ['b1']])
  })
  it('an empty pane is an empty frame, not a missing one', () => {
    expect(splitCaptureMany('\n\nSEP\nb\nSEP\n', 2, 'SEP')).toEqual([[], ['b']])
  })
  it('a sequence that stopped (a session gone) answers only what arrived', () => {
    // tmux stops at the failing capture: nothing after the first separator.
    expect(splitCaptureMany('a\nSEP\n', 3, 'SEP')).toEqual([['a'], null, null])
    expect(splitCaptureMany('', 2, 'SEP')).toEqual([null, null])
  })
  it('a line that merely CONTAINS the separator is content', () => {
    expect(splitCaptureMany('x SEP y\nSEP\n', 1, 'SEP')).toEqual([['x SEP y']])
  })
})
