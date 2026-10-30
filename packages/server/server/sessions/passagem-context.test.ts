import { expect, test } from 'bun:test'
import { contextText } from './agentistics-context'
import { parseSessionArgs } from './cli-parse'
import { isOwnerTurn } from './handoff-relay'
import { withPassagem } from './spawn-context'

test('ORQ.H2: the generated hand-off reaches the successor as a system item, never as an owner message', () => {
  const doc = '# Passagem gerada do quadro · t-1\n\nPEDIDOS ABERTOS DO DONO (1) — …\n- p-1 (há 5 min): «e as correções???»'
  const text = contextText({ sessionId: 's', cwd: '/w', role: 'leader', handoffTakeover: true, passagem: doc })
  expect(text).toContain('[from agentistics · passagem]\n# Passagem gerada do quadro · t-1')
  expect(text).toContain('«e as correções???»')
  expect(isOwnerTurn({ role: 'user', text: `[from agentistics · passagem]\n${doc}` })).toBe(false) // 0 pedidos created by it
  expect(contextText({ sessionId: 's', cwd: '/w', role: 'leader' })).not.toContain('[from agentistics · passagem]')
})

test('withPassagem is a no-op unless it is a hand-off with a task', async () => {
  expect(await withPassagem({ taskId: 't-1' }, false)).toEqual({ taskId: 't-1' })
  const lines: string[] = []
  expect(await withPassagem({}, true, { flowsOn: () => true, log: l => { lines.push(l) } })).toEqual({})
  expect(lines).toEqual([expect.stringContaining('filed on no task')])
})

test('QA R4: a TASKLESS hand-off with flows off and a cited file is told the file was not checked', async () => {
  const lines: string[] = []
  expect(await withPassagem({}, true, { flowsOn: () => false, handoffFile: '/w/H.md', log: l => { lines.push(l) } })).toEqual({})
  expect(lines).toEqual([expect.stringContaining('/w/H.md was NOT checked')])
  lines.length = 0
  expect(await withPassagem({}, true, { flowsOn: () => true, handoffFile: '/w/H.md', log: l => { lines.push(l) } })).toEqual({})
  expect(lines).toEqual([expect.stringContaining('/w/H.md was NOT checked')])
})

test('QA F8: flows off, a missing document or a failed read is said in one line — never swallowed', async () => {
  const lines: string[] = []
  const log = (l: string) => { lines.push(l) }
  expect(await withPassagem({ taskId: 't-1' }, true, { flowsOn: () => false, handoffFile: '/w/H.md', log })).toEqual({ taskId: 't-1' })
  expect(lines.at(-1)).toContain('/w/H.md was NOT checked')
  expect(await withPassagem({ taskId: 't-1' }, true, { flowsOn: () => false, log })).toEqual({ taskId: 't-1' })
  expect(lines.at(-1)).toContain('Flows are off')
  expect(await withPassagem({ taskId: 't-1' }, true, { flowsOn: () => true, read: async () => null, log })).toEqual({ taskId: 't-1' })
  expect(lines.at(-1)).toContain('No generated hand-off was found for task t-1')
  expect(await withPassagem({ taskId: 't-1' }, true, { flowsOn: () => true, read: async () => { throw new Error('boom') }, log })).toEqual({ taskId: 't-1' })
  expect(lines.at(-1)).toContain('could not be read (boom)')
  expect(await withPassagem({ taskId: 't-1' }, true, { flowsOn: () => true, read: async () => ({ text: '# doc' }), log })).toEqual({ taskId: 't-1', passagem: '# doc' })
  expect(lines).toHaveLength(4)
})

test('--handoff-file is parsed for a hand-off start', () => {
  const cmd = parseSessionArgs(['claude', '--bg', '--handoff', '--handoff-file', '/w/HANDOFF.md', '-p', 'x'])
  expect(cmd.kind).toBe('start')
  if (cmd.kind === 'start') expect(cmd.handoffFile).toBe('/w/HANDOFF.md')
})
