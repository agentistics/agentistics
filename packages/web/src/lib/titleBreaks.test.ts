import { expect, test } from 'bun:test'
import { titlePieces } from './titleBreaks'

test('a dotted or underscored token gets break opportunities after the mark, never inside a word', () => {
  expect(titlePieces('MODO.AUTONOMO-SIMPLES')).toEqual(['MODO.', 'AUTONOMO-SIMPLES'])
  expect(titlePieces('AGENTASK.sessions_filter')).toEqual(['AGENTASK.', 'sessions_', 'filter'])
  expect(titlePieces('a/b/c')).toEqual(['a/', 'b/', 'c'])
})
test('pieces always re-join to the exact title (a break opportunity adds no character)', () => {
  for (const t of ['MODO.AUTONOMO-SIMPLES · só liga', 'x', '', '..', 'a. b', 'v2.200.8 +fix', 'ends.']) expect(titlePieces(t).join('')).toBe(t)
})
test('no opportunity before a space, inside a run of marks, or at the end', () => {
  expect(titlePieces('a. b')).toEqual(['a. b'])
  expect(titlePieces('a..b')).toEqual(['a..', 'b'])
  expect(titlePieces('ends.')).toEqual(['ends.'])
  expect(titlePieces('')).toEqual([''])
})
