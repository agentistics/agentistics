import { describe, it, expect } from 'bun:test'
import { execFailed, spawnOutcome } from './spawn-outcome'

describe('spawnOutcome', () => {
  it('reads the refusal that produced three dead rows called MAIN', () => {
    // Captured verbatim from the pane. The conversation was running as a background agent, Claude
    // refused to resume it, and the process was gone before the spawn call returned — so a row was
    // written for it. Every press of Reopen made another.
    const frame = [
      'Session 581deab7-8aa7-4438-9371-5d4f1668c1ab is currently running as a',
      'background agent (bg). Use `claude agents` to find and attach to it, or add',
      '--fork-session to branch off a copy.',
      'Pane is dead (status 1, Sat Aug 15 01:31:03 2026)',
    ]
    const out = spawnOutcome(frame)
    expect(out.died).toBe(true)
    expect(out.status).toBe(1)
    // The words are what make it actionable: "it did not start" is not, "already open elsewhere" is.
    expect(out.message).toContain('background agent')
    expect(out.message).toContain('581deab7')
  })

  it('finds the words even with a pane full of blank rows between', () => {
    // The shape tmux actually produces, measured: the message on the FIRST row, the notice on the
    // LAST, and 33 blank rows in between. A fixed window of the lines immediately before the notice
    // collected nothing, and the user was told only "exited (status 1)" — true, and useless.
    const frame = [
      'Session 581deab7-… is currently running as a background agent (bg).',
      'a copy.',
      ...Array<string>(33).fill(''),
      'Pane is dead (status 1, Sat Aug 15 01:59:20 2026)',
    ]
    const out = spawnOutcome(frame)
    expect(out.died).toBe(true)
    expect(out.message).toContain('background agent')
    // …and in the order they were printed, not reversed by the upward scan.
    expect(out.message.indexOf('Session')).toBeLessThan(out.message.indexOf('a copy.'))
  })

  it('says nothing died when the session is drawing its first frame', () => {
    const out = spawnOutcome(['', '❯ ', '  ⏵⏵ auto mode on (shift+tab to cycle)'])
    expect(out.died).toBe(false)
    expect(out.message).toBe('')
  })

  it('still reports DEAD when tmux words the notice without a status', () => {
    // The notice is tmux's and its shape is not ours to depend on. Losing the number is a smaller
    // error than concluding the program is running.
    const out = spawnOutcome(['boom', 'Pane is dead'])
    expect(out.died).toBe(true)
    expect(out.status).toBeUndefined()
    expect(out.message).toBe('boom')
  })

  it('takes the LAST notice, and carries no words when there were none', () => {
    expect(spawnOutcome(['Pane is dead (status 1)']).message).toBe('')
    expect(spawnOutcome(['Pane is dead (status 1)', 'x', 'Pane is dead (status 7)']).status).toBe(7)
  })
})

describe('execFailed — the binary never ran', () => {
  it('reads tmux\'s silent execvp failure as one', () => {
    // A multi-word argv is exec'd by tmux itself, and a failed exec `_exit(1)`s printing nothing —
    // captured verbatim from a service whose PATH could not reach `claude`.
    const out = spawnOutcome(['Pane is dead (status 1, Mon Sep 28 13:22:23 2026)'])
    expect(execFailed(out, 'claude')).toBe(true)
  })

  it('reads the shell\'s "command not found" as one', () => {
    const out = spawnOutcome([
      'bash: line 1: codex: command not found',
      'Pane is dead (status 127, Mon Sep 28 13:31:03 2026)',
    ])
    expect(execFailed(out, 'codex')).toBe(true)
  })

  it('never reinterprets a harness that ran and REFUSED', () => {
    const out = spawnOutcome([
      'Session 581deab7 is currently running as a background agent (bg).',
      'Pane is dead (status 1, Sat Aug 15 01:31:03 2026)',
    ])
    expect(execFailed(out, 'claude')).toBe(false)
    // Nor another binary's missing file.
    expect(execFailed(spawnOutcome(['git: No such file or directory', 'Pane is dead (status 1)']), 'claude')).toBe(false)
  })

  it('is false for a pane that is alive', () => {
    expect(execFailed(spawnOutcome(['> ']), 'claude')).toBe(false)
  })
})
