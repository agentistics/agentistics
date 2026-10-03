import { describe, expect, test } from 'bun:test'
import { nativeAsks, nativeChatTurns, nativeLiveText, nativeSendParts } from './nativeChatSource'
import type { NativeChatItem } from './nativeChat'

const ask = { questionId: 'x1:q', kind: 'permission' as const, text: 'Run it?', options: [{ label: 'Allow once' }], subjects: ['ls'] }
const items: NativeChatItem[] = [
  { kind: 'turn', key: 'm1', turn: { role: 'user', text: 'hi' }, attachments: [{ url: '/a/1', mediaType: 'image/png', name: 'deadbeef-shot.png' }] },
  { kind: 'tool', key: 't1', card: { key: 't1', name: 'shell.run', detail: 'ls', status: 'completed' } },
  { kind: 'tool', key: 't2', card: { key: 't2', name: 'file.read', detail: 'a.ts', status: 'failed' } },
  { kind: 'turn', key: 'm2', turn: { role: 'assistant', text: 'done' }, stopped: true },
  { kind: 'approval', key: 'q', ask },
  { kind: 'turn', key: 'live', turn: { role: 'assistant', text: 'typing…' } },
]

describe('nativeChatSource — the native chat through the standard seam', () => {
  test('turns: attachments as markdown, consecutive tools as one chip row, stopped said, live excluded', () => {
    const t = nativeChatTurns(items, 'en')
    expect(t[0]).toEqual({ role: 'user', text: '![shot.png](/a/1)\n\nhi' })
    expect(t[1]).toEqual({ role: 'assistant', text: '', tools: [{ name: 'shell.run', detail: 'ls' }, { name: 'file.read', detail: 'a.ts · failed' }] })
    expect(t[2]!.text).toMatch(/^done\n\n_Stopped by you/)
    expect(t).toHaveLength(3)
  })
  test('live text and the waiting questions are their own slots', () => {
    expect(nativeLiveText(items)).toBe('typing…')
    expect(nativeAsks(items)).toEqual([ask])
  })
  test('the composer message back into words + stored upload names', () => {
    const p = nativeSendParts('/home/u/.agentistics/attachments/ab12-shot.png\n/home/u/.agentistics/attachments/notes.zip\n\nlook')
    expect(p).toEqual({ text: 'look', uploads: [{ name: 'ab12-shot.png', mediaType: 'image/png', size: 0 }], refused: ['notes.zip'] })
  })
})
