import { expect, test } from 'bun:test'
import { deliverMentions, extractMentionIds, mentionText, planMentionTargets, type MentionRow } from './task-mentions'

const rows: MentionRow[] = [
  { id: '3f5f21a8b0', state: 'waiting', actionable: true, conversationId: 'aaaa1111-0000' },
  { id: '9c1d00ffee', state: 'working', actionable: true },
  { id: '9c1d00aaaa', state: 'working', actionable: true },
  { id: '77e0000001', state: 'waiting-approval', actionable: true },
  { id: '5500000001', state: 'lost', actionable: true },
  { id: 'ext0000001', state: 'working', actionable: false },
]

test('chips are read from the body, distinct and lower-cased; plain # text is not a mention', () => {
  expect(extractMentionIds('see #«Fix login · 3F5F21A8» and #«Other · 9c1d00ff» and again #«Fix login · 3f5f21a8». issue #12')).toEqual(['3f5f21a8', '9c1d00ff'])
  expect(extractMentionIds('no chip here #heading')).toEqual([])
})

test('only live, hosted, non-dialog sessions are notified; ambiguous prefixes and the author are skipped', () => {
  expect(planMentionTargets(['3f5f21a8'], rows)).toEqual(['3f5f21a8b0'])
  expect(planMentionTargets(['aaaa1111'], rows)).toEqual(['3f5f21a8b0']) // by conversation id
  expect(planMentionTargets(['9c1d00'], rows)).toEqual([]) // ambiguous: two rows
  expect(planMentionTargets(['9c1d00ff'], rows)).toEqual(['9c1d00ffee'])
  expect(planMentionTargets(['77e00000', '55000000', 'ext00000'], rows)).toEqual([]) // dialog / lost / external
  expect(planMentionTargets(['3f5f21a8'], rows, ['3f5f21a8b0'])).toEqual([]) // the author
})

test('the text is a system item: header, task, author, excerpt without the chip id, link', () => {
  const t = mentionText({ taskId: 't-1', taskTitle: 'Ship', subtaskTitle: 'QA', author: 'owner', commentId: 'c-9', body: 'ping #«Fix login · 3f5f21a8» please check token=sk-abcdefghijklmnopqrstuvwxyz123456' })
  expect(t.startsWith('[from agentistics · mention]\n')).toBe(true)
  expect(t).toContain('"Ship" (t-1), subtask "QA"')
  expect(t).toContain('By: owner')
  expect(t).toContain('ping Fix login please')
  expect(t).not.toContain('3f5f21a8')
  expect(t).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456')
  expect(t).toContain('/tasks/t-1#comment-c-9')
})

test('delivery types the item into each live mentioned session once; not live = nothing typed', async () => {
  const typed: Array<[string, string]> = []
  const deps = { rows: async () => rows, prompt: async (id: string, text: string) => { typed.push([id, text]); return { ok: true } } }
  const base = { taskId: 't-1', taskTitle: 'Ship', author: 'owner', commentId: 'c-1' }
  expect(await deliverMentions({ ...base, body: '#«A · 3f5f21a8» #«A again · 3f5f21a8»' }, deps)).toEqual(['3f5f21a8b0'])
  expect(typed.length).toBe(1)
  expect(typed[0]![1].startsWith('[from agentistics · mention]')).toBe(true)
  expect(await deliverMentions({ ...base, body: '#«Gone · 55000000»' }, deps)).toEqual([])
  expect(typed.length).toBe(1)
  expect(await deliverMentions({ ...base, body: 'no mention' }, deps)).toEqual([])
})

test('a failing host never throws into the comment write', async () => {
  const deps = { rows: async () => { throw new Error('tmux gone') }, prompt: async () => ({ ok: true }) }
  expect(await deliverMentions({ taskId: 't', taskTitle: 'x', author: 'a', commentId: 'c', body: '#«A · 3f5f21a8»' }, deps)).toEqual([])
})
