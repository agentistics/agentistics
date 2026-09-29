import { describe, expect, test } from 'bun:test'
import { abandonedBranchLines } from './active-branch'

const user = (uuid: string, parent: string | null, text: string) =>
  JSON.stringify({ type: 'user', uuid, parentUuid: parent, message: { role: 'user', content: text } })
const asst = (uuid: string, parent: string | null, text: string) =>
  JSON.stringify({ type: 'assistant', uuid, parentUuid: parent, message: { role: 'assistant', content: [{ type: 'text', text }] } })
const toolUse = (uuid: string, parent: string) =>
  JSON.stringify({ type: 'assistant', uuid, parentUuid: parent, message: { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Read', input: {} }] } })
const toolResult = (uuid: string, parent: string) =>
  JSON.stringify({ type: 'user', uuid, parentUuid: parent, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } })

describe('abandonedBranchLines', () => {
  test('a rewind: the turns after the restored point are abandoned', () => {
    // Measured shape: ONE, um, TWO, TWO-answer, THREE, THREE-answer, then AFTER whose parent is "um".
    const lines = [
      user('u1', null, 'REWIND-ONE'), asst('a1', 'u1', 'um'),
      user('u2', 'a1', 'REWIND-TWO'), asst('a2', 'u2', 'TWO'),
      user('u3', 'a2', 'REWIND-THREE'), asst('a3', 'u3', 'THREE'),
      user('u4', 'a1', 'REWIND-AFTER'), asst('a4', 'u4', 'depois'),
    ]
    expect([...abandonedBranchLines(lines, 100)].sort()).toEqual([2, 3, 4, 5])
  })

  test('parallel tool results are siblings, NOT a rewind — nothing is hidden', () => {
    // Measured in 18 of 25 ordinary transcripts: results of parallel calls hang off one parent.
    const lines = [
      user('u1', null, 'do two reads'), toolUse('c1', 'u1'), toolUse('c2', 'c1'),
      toolResult('r1', 'c2'), toolResult('r2', 'c2'),
      asst('a1', 'r2', 'done'),
    ]
    expect(abandonedBranchLines(lines, 100).size).toBe(0)
  })

  test('an ancestry that leaves the parsed tail is kept', () => {
    const lines = [user('u9', 'missing', 'old'), asst('a9', 'u9', 'x'), user('u10', 'elsewhere', 'new'), asst('a10', 'u10', 'y')]
    expect(abandonedBranchLines(lines, 100).size).toBe(0)
  })

  test('lines with no uuid (titles, modes) are never touched', () => {
    const lines = [user('u1', null, 'one'), asst('a1', 'u1', 'um'), JSON.stringify({ type: 'ai-title', title: 't' })]
    expect(abandonedBranchLines(lines, 100).size).toBe(0)
  })
})
