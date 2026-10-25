import { describe, expect, it } from 'bun:test'
import { LS_DEFAULT, parseDurationMs, parseSessionArgs } from './cli-parse'

describe('parseSessionArgs', () => {
  it('parses an explicit spawn role', () => {
    expect(parseSessionArgs(['codex', '--role', 'leader'])).toMatchObject({ kind: 'start', harness: 'codex', role: 'leader' })
    expect(parseSessionArgs(['codex', '--role', 'other'])).toMatchObject({ kind: 'error' })
  })
  it('starts a background session on the given harness', () => {
    expect(parseSessionArgs(['claude', '--bg', '-p', 'fix the tests'])).toEqual({
      kind: 'start', harness: 'claude', background: true, prompt: 'fix the tests',
    })
  })

  it('attaches by default when --bg is absent', () => {
    expect(parseSessionArgs(['claude', '-p', 'hi'])).toEqual({
      kind: 'start', harness: 'claude', background: false, prompt: 'hi',
    })
  })

  it('reads model, effort, cwd and name', () => {
    expect(parseSessionArgs([
      'codex', '-p', 'do X', '--model', 'o3', '--effort', 'high', '--cwd', '/srv/app', '--name', 'refactor auth',
    ])).toEqual({
      kind: 'start', harness: 'codex', background: false, prompt: 'do X',
      model: 'o3', effort: 'high', cwd: '/srv/app', label: 'refactor auth',
    })
  })

  it('accepts a start with no prompt at all', () => {
    expect(parseSessionArgs(['kimi'])).toEqual({ kind: 'start', harness: 'kimi', background: false })
  })

  it('reads --force and --json on a start, for the memory gate', () => {
    expect(parseSessionArgs(['claude', '--force'])).toEqual({
      kind: 'start', harness: 'claude', background: false, force: true,
    })
    expect(parseSessionArgs(['claude', '--json', '--force'])).toEqual({
      kind: 'start', harness: 'claude', background: false, json: true, force: true,
    })
  })

  it('reads the subcommands', () => {
    expect(parseSessionArgs(['list'])).toEqual({ kind: 'list' })
    expect(parseSessionArgs(['attach', 'a1'])).toEqual({ kind: 'attach', ref: 'a1' })
    expect(parseSessionArgs(['kill', 'a1'])).toEqual({ kind: 'kill', ref: 'a1' })
    expect(parseSessionArgs(['rename', 'a1', 'refactor auth'])).toEqual({ kind: 'rename', ref: 'a1', label: 'refactor auth' })
    expect(parseSessionArgs(['note', 'a1', 'split the god object'])).toEqual({ kind: 'note', ref: 'a1', text: 'split the god object' })
  })

  it('ls defaults to the running sessions, grouped by project', () => {
    expect(parseSessionArgs(['ls'])).toEqual({ kind: 'ls', all: false, group: 'project' })
    expect(LS_DEFAULT).toEqual({ all: false, group: 'project' })
  })

  it('ls takes --all, --group, --json, --width and the colour override', () => {
    expect(parseSessionArgs(['ls', '--all', '--group', 'repo', '--json'])).toEqual({
      kind: 'ls', all: true, group: 'repo', json: true,
    })
    expect(parseSessionArgs(['ls', '-a', '-g', 'task'])).toEqual({ kind: 'ls', all: true, group: 'task' })
    expect(parseSessionArgs(['ls', '--width', '80', '--no-color'])).toEqual({
      kind: 'ls', all: false, group: 'project', width: 80, color: false,
    })
    expect(parseSessionArgs(['ls', '--color'])).toEqual({
      kind: 'ls', all: false, group: 'project', color: true,
    })
  })

  it('ls refuses a grouping the table cannot draw', () => {
    expect(parseSessionArgs(['ls', '--group', 'nonsense'])).toEqual({
      kind: 'error', message: expect.stringContaining('nonsense'),
    })
  })

  it('ls never swallows the next flag as a value', () => {
    // `--group --json` used to be the shape that grouped by "--json" and then printed no JSON.
    expect(parseSessionArgs(['ls', '--group', '--json'])).toEqual({
      kind: 'error', message: expect.stringContaining('Missing value'),
    })
    expect(parseSessionArgs(['ls', '--width', '--all'])).toEqual({
      kind: 'error', message: expect.stringContaining('Missing value'),
    })
  })

  it('ls refuses a width that is not a positive number of columns', () => {
    expect(parseSessionArgs(['ls', '--width', 'wide'])).toEqual({
      kind: 'error', message: expect.stringContaining('--width'),
    })
    expect(parseSessionArgs(['ls', '--width', '0'])).toEqual({
      kind: 'error', message: expect.stringContaining('--width'),
    })
  })

  it('ls rejects an option it does not know rather than ignoring it', () => {
    expect(parseSessionArgs(['ls', '--sort'])).toEqual({
      kind: 'error', message: expect.stringContaining('--sort'),
    })
  })

  it('list is untouched by ls — a script reading it keeps its dump', () => {
    expect(parseSessionArgs(['list'])).toEqual({ kind: 'list' })
    expect(parseSessionArgs(['list', '--json'])).toEqual({ kind: 'list', json: true })
  })

  it('rejects a harness that is not a harness', () => {
    expect(parseSessionArgs(['nonsense'])).toEqual({ kind: 'error', message: expect.stringContaining('nonsense') })
  })

  it('rejects a flag with no value instead of swallowing the next token', () => {
    expect(parseSessionArgs(['claude', '--model'])).toEqual({ kind: 'error', message: expect.stringContaining('--model') })
    expect(parseSessionArgs(['claude', '--model', '--bg'])).toEqual({ kind: 'error', message: expect.stringContaining('--model') })
  })

  it('rejects an unknown option instead of silently ignoring it', () => {
    expect(parseSessionArgs(['claude', '--nope'])).toEqual({ kind: 'error', message: expect.stringContaining('--nope') })
  })

  it('rejects two adjacent value flags rather than one swallowing the other as its value', () => {
    // `--model` has no value of its own here — `--cwd` is the next TOKEN, not a model id — so this
    // must be the same "missing value" error as `--model` followed by nothing at all.
    expect(parseSessionArgs(['claude', '--model', '--cwd', '/srv/app']))
      .toEqual({ kind: 'error', message: expect.stringContaining('--model') })
  })

  it('rejects a subcommand missing its reference', () => {
    expect(parseSessionArgs(['attach'])).toEqual({ kind: 'error', message: expect.stringContaining('attach') })
    expect(parseSessionArgs(['rename', 'a1'])).toEqual({ kind: 'error', message: expect.stringContaining('rename') })
  })

  it('asks for help with no arguments', () => {
    expect(parseSessionArgs([])).toEqual({ kind: 'help' })
  })
})

describe('batch — the form an assistant drives', () => {
  it('parses a task and one session per --session', () => {
    const cmd = parseSessionArgs([
      'batch', '--task', 'auth', '--session', 'claude: fix the store', '--session', 'codex: port tests',
    ])
    expect(cmd).toMatchObject({
      kind: 'batch',
      task: 'auth',
      specs: [
        { harness: 'claude', prompt: 'fix the store' },
        { harness: 'codex', prompt: 'port tests' },
      ],
    })
  })

  it('applies a shared --cwd to every session, and lets @ override it', () => {
    // A batch is usually many assistants on ONE repository, and repeating the path per session is
    // how a generated command line gets long enough to be got wrong.
    const cmd = parseSessionArgs([
      'batch', '--task', 't', '--cwd', '/repo',
      '--session', 'claude: a', '--session', 'codex@/other: b',
    ])
    expect(cmd).toMatchObject({
      specs: [{ cwd: '/repo' }, { cwd: '/other' }],
    })
  })

  it('defers an omitted batch task to verified parent inheritance', () => {
    expect(parseSessionArgs(['batch', '--session', 'claude: a'])).toMatchObject({ kind: 'batch', task: '' })
  })

  it('refuses a batch with no sessions', () => {
    expect(parseSessionArgs(['batch', '--task', 't'])).toMatchObject({ kind: 'error' })
  })

  it('refuses an unknown harness by name rather than starting nothing silently', () => {
    const cmd = parseSessionArgs(['batch', '--task', 't', '--session', 'gpt5: hi'])
    expect(cmd).toMatchObject({ kind: 'error' })
    expect((cmd as { message: string }).message).toContain('gpt5')
  })

  it('takes a session with no prompt at all', () => {
    expect(parseSessionArgs(['batch', '--task', 't', '--session', 'claude'])).toMatchObject({
      specs: [{ harness: 'claude' }],
    })
  })

  it('carries --json through', () => {
    expect(parseSessionArgs(['batch', '--task', 't', '--session', 'claude: a', '--json']))
      .toMatchObject({ json: true })
    expect(parseSessionArgs(['list', '--json'])).toMatchObject({ kind: 'list', json: true })
  })

  it('parses open with a multi-word task name', () => {
    expect(parseSessionArgs(['open', 'auth', 'refactor'])).toMatchObject({
      kind: 'open', task: 'auth refactor',
    })
  })

  it('carries --force through on a batch, gating the whole batch rather than one session', () => {
    expect(parseSessionArgs(['batch', '--task', 't', '--session', 'claude: a', '--force']))
      .toMatchObject({ force: true })
  })

  it('strips --force out of an open task name, same as --json', () => {
    expect(parseSessionArgs(['open', 'auth', 'refactor', '--force'])).toEqual({
      kind: 'open', task: 'auth refactor', force: true,
    })
    expect(parseSessionArgs(['open', 'auth', '--json', '--force'])).toEqual({
      kind: 'open', task: 'auth', json: true, force: true,
    })
  })
})

describe('batch --attempt', () => {
  it('applies to the sessions that follow it, until the next one', () => {
    const cmd = parseSessionArgs([
      'batch', '--task', 'pizzeria',
      '--attempt', 'opus, prompt only',
      '--session', 'claude: build it',
      '--session', 'claude: keep going',
      '--attempt', 'agy + flash, sdd',
      '--session', 'antigravity: build it',
    ])
    expect(cmd.kind).toBe('batch')
    if (cmd.kind !== 'batch') return
    expect(cmd.specs.map(s => s.attempt)).toEqual([
      'opus, prompt only', 'opus, prompt only', 'agy + flash, sdd',
    ])
  })

  it('leaves attempt unset when none was named, so a plain batch still works', () => {
    const cmd = parseSessionArgs(['batch', '--task', 'x', '--session', 'claude: go'])
    expect(cmd.kind).toBe('batch')
    if (cmd.kind !== 'batch') return
    expect(cmd.specs[0]!.attempt).toBeUndefined()
  })

  it('refuses an --attempt with no value rather than swallowing the next flag', () => {
    const cmd = parseSessionArgs(['batch', '--task', 'x', '--attempt', '--session', 'claude: go'])
    expect(cmd.kind).toBe('error')
  })
})

describe('--notify', () => {
  it('reads on|off on a start', () => {
    const off = parseSessionArgs(['claude', '--bg', '--notify', 'off'])
    expect(off.kind === 'start' && off.notify).toBe('off')
    const on = parseSessionArgs(['claude', '--notify', 'on'])
    expect(on.kind === 'start' && on.notify).toBe('on')
    const none = parseSessionArgs(['claude'])
    expect(none.kind === 'start' && none.notify).toBeUndefined()
  })
  it('refuses any other value, and a missing one', () => {
    expect(parseSessionArgs(['claude', '--notify', 'maybe']).kind).toBe('error')
    expect(parseSessionArgs(['claude', '--notify']).kind).toBe('error')
    expect(parseSessionArgs(['claude', '--notify', '--bg']).kind).toBe('error')
  })
  it('is a positional default on batch, like --model', () => {
    const c = parseSessionArgs([
      'batch', '--task', 't',
      '--session', 'claude: lead',
      '--notify', 'off',
      '--session', 'claude: worker',
    ])
    expect(c.kind).toBe('batch')
    if (c.kind !== 'batch') return
    expect(c.specs[0]!.notify).toBeUndefined()
    expect(c.specs[1]!.notify).toBe('off')
  })
  it('refuses a bad value on batch', () => {
    expect(parseSessionArgs(['batch', '--task', 't', '--notify', 'x', '--session', 'claude: a']).kind).toBe('error')
  })
})

describe('--folder', () => {
  it('start takes --folder', () => {
    const c = parseSessionArgs(['claude', '--bg', '--folder', 'Work/Workers'])
    expect(c.kind === 'start' && c.folder).toBe('Work/Workers')
    expect(parseSessionArgs(['claude', '--folder']).kind).toBe('error')
  })
  it('batch --folder is a default for the following sessions, overridable', () => {
    const c = parseSessionArgs(['batch', '--task', 't', '--folder', 'A', '--session', 'claude: x', '--folder', 'B', '--session', 'codex: y'])
    expect(c.kind === 'batch' && c.specs.map(s => s.folder)).toEqual(['A', 'B'])
    const d = parseSessionArgs(['batch', '--task', 't', '--session', 'claude: x'])
    expect(d.kind === 'batch' && d.specs[0]!.folder).toBeUndefined()
  })
  it('open and kill take --folder anywhere', () => {
    expect(parseSessionArgs(['open', 'my task', '--folder', 'A/B'])).toEqual({ kind: 'open', task: 'my task', folder: 'A/B' })
    expect(parseSessionArgs(['kill', 'abc', '--folder', 'A/Finalizadas'])).toEqual({ kind: 'kill', ref: 'abc', folder: 'A/Finalizadas' })
    expect(parseSessionArgs(['kill', '--folder', 'X', 'abc'])).toEqual({ kind: 'kill', ref: 'abc', folder: 'X' })
    expect(parseSessionArgs(['kill', 'abc'])).toEqual({ kind: 'kill', ref: 'abc' })
    expect(parseSessionArgs(['kill', 'abc', '--folder']).kind).toBe('error')
  })
  it('folders lists, with --json', () => {
    expect(parseSessionArgs(['folders'])).toEqual({ kind: 'folders' })
    expect(parseSessionArgs(['folders', '--json'])).toEqual({ kind: 'folders', json: true })
  })
})

describe('per-session away flags', () => {
  it('start takes --away / --no-away', () => {
    expect(parseSessionArgs(['claude', '--away'])).toMatchObject({ kind: 'start', away: true })
    expect(parseSessionArgs(['codex', '--no-away', '--bg'])).toMatchObject({ kind: 'start', away: false, background: true })
    expect(parseSessionArgs(['claude'])).not.toHaveProperty('away')
  })
  it('batch takes them for every session', () => {
    expect(parseSessionArgs(['batch', '--task', 't', '--away', '--session', 'codex: x'])).toMatchObject({ kind: 'batch', away: true })
    expect(parseSessionArgs(['batch', '--task', 't', '--session', 'codex: x', '--no-away'])).toMatchObject({ kind: 'batch', away: false })
  })
})

describe('retire', () => {
  it('parses the ref, --cancel, durations, --folder and --json', () => {
    expect(parseSessionArgs(['retire', 'a1'])).toEqual({ kind: 'retire', ref: 'a1' })
    expect(parseSessionArgs(['retire', 'a1', '--cancel'])).toEqual({ kind: 'retire', ref: 'a1', cancel: true })
    expect(parseSessionArgs(['retire', '--quiet-for', '30s', 'a1', '--deadline', '10m', '--folder', 'A/Finalizadas', '--json']))
      .toEqual({ kind: 'retire', ref: 'a1', quietForMs: 30_000, deadlineMs: 600_000, folder: 'A/Finalizadas', json: true })
  })
  it('refuses a missing ref, a bad duration, an unknown flag and two refs', () => {
    expect(parseSessionArgs(['retire']).kind).toBe('error')
    expect(parseSessionArgs(['retire', 'a1', '--deadline', 'soon']).kind).toBe('error')
    expect(parseSessionArgs(['retire', 'a1', '--deadline', '0']).kind).toBe('error')
    expect(parseSessionArgs(['retire', 'a1', '--force']).kind).toBe('error')
    expect(parseSessionArgs(['retire', 'a1', 'b2']).kind).toBe('error')
  })
  it('parseDurationMs', () => {
    expect(parseDurationMs('60s')).toBe(60_000)
    expect(parseDurationMs('1.5h')).toBe(5_400_000)
    expect(parseDurationMs('90')).toBe(90_000)
    expect(parseDurationMs('250ms')).toBe(250)
    expect(parseDurationMs('x')).toBeNull()
  })
})

describe('retire minimum quiet interval', () => {
  it('rejects zero and short quietFor; accepts two poll intervals', () => {
    for (const value of ['0', '1s', '9999ms']) {
      expect(parseSessionArgs(['retire', 'a1', '--quiet-for', value])).toMatchObject({ kind: 'error' })
    }
    expect(parseSessionArgs(['retire', 'a1', '--quiet-for', '10s']))
      .toMatchObject({ kind: 'retire', quietForMs: 10_000 })
  })
})

describe('spawn filing flags (S4)', () => {
  it('start takes --task, --subtask and --shared-cwd', () => {
    const cmd = parseSessionArgs(['claude', '--bg', '--task', 't-1', '--subtask', 'Planner', '--shared-cwd'])
    expect(cmd).toMatchObject({ kind: 'start', task: 't-1', subtask: 'Planner', sharedCwd: true })
  })
  it('--shared-cwd is a switch: it never eats the next flag as its value', () => {
    expect(parseSessionArgs(['claude', '--shared-cwd', '--name', 'x'])).toMatchObject({ kind: 'start', sharedCwd: true, label: 'x' })
  })
  it('a value flag followed by --shared-cwd is a missing value', () => {
    expect(parseSessionArgs(['claude', '--cwd', '--shared-cwd'])).toMatchObject({ kind: 'error' })
  })
  it('batch takes --subtask and --shared-cwd', () => {
    const cmd = parseSessionArgs(['batch', '--task', 'T', '--subtask', 'S', '--shared-cwd', '--session', 'claude: go'])
    expect(cmd).toMatchObject({ kind: 'batch', task: 'T', subtask: 'S', sharedCwd: true })
  })
  it('without the switch there is no sharedCwd key', () => {
    expect(parseSessionArgs(['claude'])).not.toHaveProperty('sharedCwd')
  })
})

describe('--handoff (leader hand-off from the CLI)', () => {
  it('start takes --handoff as a switch', () => {
    expect(parseSessionArgs(['claude', '--bg', '--handoff', '--name', 'x'])).toMatchObject({ kind: 'start', handoff: true, label: 'x' })
  })
  it('a value flag followed by --handoff is a missing value', () => {
    expect(parseSessionArgs(['claude', '--name', '--handoff'])).toMatchObject({ kind: 'error' })
  })
  it('without the switch there is no handoff key', () => {
    expect(parseSessionArgs(['claude'])).not.toHaveProperty('handoff')
  })
})

describe('--account (PLAN.ACCOUNTS D3)', () => {
  it('start takes an account id', () => {
    expect(parseSessionArgs(['codex', '--account', 'acc_1', '--bg'])).toMatchObject({ kind: 'start', harness: 'codex', account: 'acc_1', background: true })
  })
  it('a missing value is refused', () => {
    expect(parseSessionArgs(['codex', '--account'])).toMatchObject({ kind: 'error' })
  })
  it('batch: a positional default for the --session entries that follow it', () => {
    const c = parseSessionArgs(['batch', '--task', 't', '--session', 'claude: a', '--account', 'acc_2', '--session', 'claude: b'])
    expect(c.kind === 'batch' && c.specs.map(s => s.account)).toEqual([undefined, 'acc_2'])
  })
})

describe('ORQ.FORA approval mode flags', () => {
  it('CLI start and handoff keep mode separate from the role', () => {
    expect(parseSessionArgs(['claude', '--mode', 'no-questions', '--role', 'worker'])).toMatchObject({ kind: 'start', mode: 'no-questions', role: 'worker' })
    expect(parseSessionArgs(['claude', '--handoff', '--mode', 'default'])).toMatchObject({ kind: 'start', handoff: true, mode: 'default' })
    expect(parseSessionArgs(['claude', '--mode', 'auto'])).toMatchObject({ kind: 'error' })
    expect(parseSessionArgs(['claude', '--mode'])).toMatchObject({ kind: 'error' })
  })
  it('batch applies positional mode defaults and permits parent-task inheritance', () => {
    const command = parseSessionArgs(['batch', '--mode', 'accept-edits', '--session', 'claude: first', '--mode', 'default', '--session', 'codex: second'])
    expect(command.kind).toBe('batch')
    if (command.kind !== 'batch') return
    expect(command.task).toBe('')
    expect(command.specs.map(s => s.mode)).toEqual(['accept-edits', 'default'])
    expect(parseSessionArgs(['batch', '--mode', 'auto', '--session', 'claude: x']).kind).toBe('error')
  })
})
