/**
 * OPENCODE.SESSAO — what the chat, the files panel and the live feed make of a REAL OpenCode turn, as the engine now
 * folds it (opencode 1.19.5 over ACP, model opencode/big-pickle, throwaway HOME, 2026-11-07; the engine's own fixture
 * `opencode-1.19.5-tools-real.jsonl`, run through `acpChatFold` + the receiver). Before the engine named the tools in the
 * shared vocabulary, the same turn carried `canonical: 'edit'` for the new file, `'think'` for the subagent and
 * `'other'` for the todo list — `BEFORE` below — and these surfaces read it wrong or not at all.
 */
import { describe, expect, test } from 'bun:test'
import { artifactsFromTurns } from './sessionArtifacts'
import { liveEvents } from './artifactTabs'
import { groupPerExchange, outputLabel, outputLines, summarize, type ActivityGroup } from './toolActivity'

type Turn = { role: 'user' | 'assistant'; text: string; at?: string; pending?: boolean; thinking?: string; tools?: Array<{ name: string; canonical?: string; detail?: string; ref?: string; output?: string; failed?: boolean }> }

const AFTER: Turn[] = [
  { role: 'user', text: 'First write a todo list …', at: '2026-11-07T00:00:01.614Z' },
  {
    role: 'assistant', at: '2026-11-07T00:00:08.926Z', thinking: 'The user wants me to follow a sequence.',
    text: 'Todo list created. Now inspecting the workspace.\n\nDirectory has only `notes.txt` (alpha/beta/gamma). Moving to the edit step.',
    tools: [
      { name: 'todowrite', canonical: 'TodoWrite', detail: '0/3 · Inspect: list directory and read notes.txt', ref: 'c1', output: '[~] Inspect: list directory and read notes.txt\n[ ] Edit: create hello.py and replace beta with BETA in notes.txt\n[ ] Verify: grep for gamma and confirm changes' },
      { name: 'bash', canonical: 'Bash', detail: 'ls -la && echo done-marker', ref: 'c2', output: 'total 12\n-rw-rw-r--  1 user user   17 Nov  7 00:59 notes.txt\ndone-marker' },
      { name: 'read', canonical: 'Read', detail: '/w/notes.txt', ref: 'c3', output: 'alpha\nbeta\ngamma' },
      { name: 'write', canonical: 'Write', detail: '/w/hello.py', ref: 'c4', output: '+print("hi")' },
      { name: 'edit', canonical: 'Edit', detail: '/w/notes.txt', ref: 'c5', output: '@@ -1,3 +1,3 @@\n alpha\n-beta\n+BETA\n gamma' },
      { name: 'grep', canonical: 'Grep', detail: 'gamma', ref: 'c6', output: 'Found 1 matches' },
    ],
  },
  { role: 'user', text: 'Use your task/subagent tool to delegate …', at: '2026-11-07T00:00:25.645Z' },
  { role: 'assistant', text: 'notes.txt has 3 lines.', at: '2026-11-07T00:00:27.118Z', tools: [{ name: 'task', canonical: 'Task', detail: 'Count lines in notes.txt', ref: 'c7', output: '3 — via `wc -l`.' }] },
]
/** The same turns as the fold carried them before: the ACP kind as `canonical`. */
const KIND: Record<string, string> = { todowrite: 'other', bash: 'execute', read: 'read', write: 'edit', edit: 'edit', grep: 'search', task: 'think' }
const BEFORE: Turn[] = AFTER.map(t => (t.tools ? { ...t, tools: t.tools.map(x => ({ ...x, canonical: KIND[x.name] })) } : t))

const groups = (turns: Turn[]): ActivityGroup[] => groupPerExchange(turns).flatMap(i => (i.type === 'activity' ? [i.group] : []))

describe('OPENCODE.SESSAO — a live OpenCode turn on the surfaces Claude feeds', () => {
  test('the files panel lists the new file as NEW and the edited one as EDITED, once each', () => {
    expect(artifactsFromTurns(AFTER).map(a => [a.name, a.kind, a.touches])).toEqual([['notes.txt', 'edited', 1], ['hello.py', 'new', 1]])
    // before: the panel selects by the shared name, so an OpenCode session wrote "nothing"
    expect(artifactsFromTurns(BEFORE)).toEqual([])
  })

  test('the live feed says what ran, what was read, written and delegated', () => {
    const kinds = liveEvents(AFTER).map(e => `${e.kind}:${e.text}`)
    expect(kinds).toEqual([
      'thought:The user wants me to follow a sequence.',
      'used:0/3 · Inspect: list directory and read notes.txt',
      'ran:ls -la && echo done-marker',
      'read:/w/notes.txt',
      'wrote:/w/hello.py',
      'wrote:/w/notes.txt',
      'read:gamma', // a Grep is a read, as for Claude
      'delegated:Count lines in notes.txt',
    ])
    expect(liveEvents(BEFORE).some(e => e.kind === 'ran' || e.kind === 'wrote' || e.kind === 'delegated')).toBe(false)
  })

  test('the activity line names each kind with its own verb (created, delegated, plan) as it does for Claude', () => {
    const [first, second] = groups(AFTER)
    expect(first!.steps.map(s => s.kind)).toEqual(['plan', 'run', 'read', 'write', 'edit', 'search'])
    expect(summarize(first!.steps, false, true)).toBe('Criou um arquivo, editou um arquivo, executou um comando e mais 3 ações')
    expect(second!.steps.map(s => [s.kind, s.object])).toEqual([['delegate', 'Count lines in notes.txt']])
    // before: the new file read as an edit, the subagent as "updated the plan"
    expect(groups(BEFORE)[0]!.steps.map(s => s.kind)).toEqual(['other', 'run', 'read', 'edit', 'edit', 'search'])
    expect(groups(BEFORE)[1]!.steps[0]!.kind).toBe('plan')
  })

  test('the folded text is named for what it is, and a change reads as a diff (a command\'s `-rw-` is not a deletion)', () => {
    const [first] = groups(AFTER)
    const edit = first!.steps.find(s => s.kind === 'edit')!
    expect(outputLabel('edit', true)).toBe('alterações')
    expect(outputLabel('plan', false)).toBe('list')
    expect(outputLabel('delegate', true)).toBe('resposta')
    expect(outputLabel('run', true)).toBe('saída')
    expect(outputLines('edit', edit.output!)!.map(l => l.mark)).toEqual(['hunk', null, 'del', 'add', null])
    const bash = first!.steps.find(s => s.kind === 'run')!
    expect(outputLines('run', bash.output!)).toBeNull()
    expect(outputLines('write', 'no diff here')).toBeNull()
  })
})
