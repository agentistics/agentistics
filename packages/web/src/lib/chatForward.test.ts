import { describe, expect, test } from 'bun:test'
import {
  appendToDraft, composeForward, copyTurnsText, draftedNotice, forwardBlock, forwardConfirmLabel,
  forwardHeader, selectedTurns, selectionCountLabel, toggleTurn, turnKey, type ForwardTurn,
} from './chatForward'

const u = (text: string, at = ''): ForwardTurn => ({ role: 'user', text, at })
const a = (text: string, at = ''): ForwardTurn => ({ role: 'assistant', text, at })
const from = { title: 'Billing «refactor»', harness: 'Claude Code' }

describe('selection', () => {
  const turns = [u('one', '1'), a('two', '2'), u('three', '3')]
  test('toggles in and out', () => {
    let s = toggleTurn(new Set(), turns[1]!)
    expect(s.has(turnKey(turns[1]!))).toBe(true)
    s = toggleTurn(s, turns[1]!)
    expect(s.size).toBe(0)
  })
  test('is returned in conversation order, not click order', () => {
    let s = new Set<string>()
    s = toggleTurn(s, turns[2]!)
    s = toggleTurn(s, turns[0]!)
    expect(selectedTurns(turns, s).map(t => t.text)).toEqual(['one', 'three'])
  })
  test('survives the window sliding (keyed on the turn, not its index)', () => {
    const s = toggleTurn(new Set(), turns[1]!)
    const slid = turns.slice(1)
    expect(selectedTurns(slid, s).map(t => t.text)).toEqual(['two'])
  })
  test('a key no turn carries any more drops out', () => {
    const s = toggleTurn(new Set(), u('gone', '0'))
    expect(selectedTurns(turns, s)).toEqual([])
  })
  test('the count, in words', () => {
    expect(selectionCountLabel(1, true)).toBe('1 selecionada')
    expect(selectionCountLabel(3, false)).toBe('3 selected')
  })
})

describe('the forwarded block', () => {
  test('names the origin once, quotes the text, no other metadata', () => {
    expect(forwardHeader(from, true)).toBe('> encaminhado de «Billing refactor» (Claude Code):')
    expect(forwardBlock(from, [a('line 1\nline 2')], false))
      .toBe('> forwarded from «Billing refactor» (Claude Code):\n> line 1\n> line 2')
  })
  test('several messages keep their order, a quoted blank line apart', () => {
    expect(forwardBlock(from, [a('first'), a('second')], true))
      .toBe('> encaminhado de «Billing refactor» (Claude Code):\n> first\n>\n> second')
  })
  test('a mixed selection says who said what — and only then', () => {
    const out = forwardBlock(from, [u('why?'), a('because')], true)
    expect(out).toContain('> (você)\n> why?')
    expect(out).toContain('> (Claude Code)\n> because')
  })
  test('blank lines inside a message stay quoted', () => {
    expect(forwardBlock(from, [a('a\n\nb')], false).split('\n').slice(1)).toEqual(['> a', '>', '> b'])
  })
  test('nothing forwardable is nothing — never a lone origin line', () => {
    expect(forwardBlock(from, [a('   ')], true)).toBe('')
    expect(composeForward({ from, turns: [], comment: 'x', pt: true })).toBe('')
  })
  test('the comment leads, a blank line above the block', () => {
    expect(composeForward({ from, turns: [a('x')], comment: '  use this  ', pt: false }))
      .toBe('use this\n\n> forwarded from «Billing refactor» (Claude Code):\n> x')
  })
  test('is never capped', () => {
    const long = Array.from({ length: 40 }, (_, i) => `l${i}`).join('\n')
    expect(forwardBlock(from, [a(long)], false).split('\n')).toHaveLength(41)
  })
})

describe('the draft', () => {
  test('a forward is appended, never replacing what was typed', () => {
    expect(appendToDraft('', 'block')).toBe('block\n\n')
    expect(appendToDraft('half an instruction  ', 'block')).toBe('half an instruction\n\nblock\n\n')
  })
  test('an empty forward leaves the draft alone', () => {
    expect(appendToDraft('keep', '  ')).toBe('keep')
  })
})

test('copy is the messages, a blank line apart', () => {
  expect(copyTurnsText([u(' a '), a(''), a('b')])).toBe('a\n\nb')
})

describe('labels', () => {
  test('the confirm button carries the count and the mode', () => {
    expect(forwardConfirmLabel(0, false, true)).toEqual({ enabled: false, label: 'Nenhuma escolhida' })
    expect(forwardConfirmLabel(2, false, true).label).toBe('Pôr no rascunho de 2 sessões')
    expect(forwardConfirmLabel(1, true, false).label).toBe('Send to 1 session')
  })
  test('the drafted notice names where to go', () => {
    expect(draftedNotice(['A'], false)).toContain('«A»')
    expect(draftedNotice(['A', 'B', 'C', 'D', 'E'], true)).toBe(
      'Encaminhado para o rascunho de 5 sessões: «A», «B», «C» e mais 2.',
    )
    expect(draftedNotice([], true)).toBe('')
  })
})
