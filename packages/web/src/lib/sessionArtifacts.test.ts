import { describe, expect, it } from 'bun:test'
import { artifactShortfall, artifactsFromTurns, hasUnlistedWrites } from './sessionArtifacts'

const turn = (tools: { name: string; detail?: string }[], pending = false) =>
  ({ role: 'assistant' as const, text: '', tools, ...(pending ? { pending: true } : {}) })

describe('artifactsFromTurns', () => {
  it('lists a written file, newest first', () => {
    const out = artifactsFromTurns([
      turn([{ name: 'Write', detail: '/home/u/p/a.ts' }]),
      turn([{ name: 'Write', detail: '/home/u/p/docs/b.md' }]),
    ])
    expect(out.map(a => a.path)).toEqual(['/home/u/p/docs/b.md', '/home/u/p/a.ts'])
  })

  it('splits a path into the name and the directory that carries it', () => {
    const [a] = artifactsFromTurns([turn([{ name: 'Write', detail: '/home/u/p/docs/specs/b.md' }])])
    expect(a!.name).toBe('b.md')
    expect(a!.dir).toBe('/home/u/p/docs/specs')
  })

  it('NEVER takes a Bash command for a path', () => {
    // `toolDetail` reads `command` FIRST, so a shell call's detail is a shell line. Selecting by
    // the shape of `detail` would put `rm -rf build/` in a list of files.
    expect(artifactsFromTurns([turn([{ name: 'Bash', detail: 'rm -rf build/' }])])).toEqual([])
  })

  it('excludes Read — the list is what the session PRODUCED', () => {
    expect(artifactsFromTurns([turn([{ name: 'Read', detail: '/home/u/p/a.ts' }])])).toEqual([])
  })

  it('folds repeated touches of one path into one row and counts them', () => {
    const out = artifactsFromTurns([
      turn([{ name: 'Write', detail: '/home/u/p/a.ts' }]),
      turn([{ name: 'Edit', detail: '/home/u/p/a.ts' }]),
      turn([{ name: 'Edit', detail: '/home/u/p/a.ts' }]),
    ])
    expect(out).toHaveLength(1)
    expect(out[0]!.touches).toBe(3)
  })

  it('calls it new when the session first WROTE it, edited when it first edited it', () => {
    const written = artifactsFromTurns([
      turn([{ name: 'Write', detail: '/home/u/p/a.ts' }]),
      turn([{ name: 'Edit', detail: '/home/u/p/a.ts' }]),
    ])
    expect(written[0]!.kind).toBe('new')
    const edited = artifactsFromTurns([turn([{ name: 'Edit', detail: '/home/u/p/b.ts' }])])
    expect(edited[0]!.kind).toBe('edited')
  })

  it('marks the file of a PENDING turn as the one being written now', () => {
    const out = artifactsFromTurns([
      turn([{ name: 'Write', detail: '/home/u/p/a.ts' }]),
      turn([{ name: 'Write', detail: '/home/u/p/b.ts' }], true),
    ])
    expect(out.find(a => a.name === 'b.ts')!.live).toBe(true)
    expect(out.find(a => a.name === 'a.ts')!.live).toBe(false)
  })

  it('marks nothing live once the pending turn has finished', () => {
    const out = artifactsFromTurns([turn([{ name: 'Write', detail: '/home/u/p/a.ts' }])])
    expect(out.every(a => !a.live)).toBe(true)
  })

  it('takes MultiEdit and NotebookEdit too', () => {
    const out = artifactsFromTurns([
      turn([{ name: 'MultiEdit', detail: '/home/u/p/a.ts' }]),
      turn([{ name: 'NotebookEdit', detail: '/home/u/p/n.ipynb' }]),
    ])
    expect(out).toHaveLength(2)
  })

  it('ignores a tool call with no detail — there is no path to show', () => {
    expect(artifactsFromTurns([turn([{ name: 'Write' }])])).toEqual([])
  })

  it('is empty for a conversation with no tools at all, and never throws', () => {
    expect(artifactsFromTurns([])).toEqual([])
    expect(artifactsFromTurns([{ role: 'user', text: 'hi' } as never])).toEqual([])
  })

  it('ignores a truncated detail — `toolDetail` appends an ellipsis past 200 chars', () => {
    // A truncated path names no file, and asking the server for one would be a refusal every time.
    const long = `/home/u/${'x'.repeat(210)}.ts`
    const detail = `${long.slice(0, 200)}…`
    expect(artifactsFromTurns([turn([{ name: 'Write', detail }])])).toEqual([])
  })
})

describe('files the SHELL wrote', () => {
  it('counts a redirection as a file this session wrote', () => {
    // Measured on a real conversation: 400 turns, 263 Bash calls, ZERO file-tool calls. Reading
    // only the file tools reported "nothing written" over eighty files.
    const a = artifactsFromTurns([
      { tools: [{ name: 'Bash', detail: 'cd /repo', writes: ['packages/web/src/x.ts'] }] },
    ])
    expect(a.map(x => x.path)).toEqual(['packages/web/src/x.ts'])
  })

  it('a shell write and a file-tool write of the same path are ONE row', () => {
    const a = artifactsFromTurns([
      { tools: [{ name: 'Bash', detail: 'cd /r', writes: ['a.ts'] }] },
      { tools: [{ name: 'Edit', detail: 'a.ts' }] },
    ])
    expect(a).toHaveLength(1)
    expect(a[0]!.touches).toBe(2)
  })

  it('says when writes exist that it CANNOT list, so "nothing" is never claimed falsely', () => {
    expect(hasUnlistedWrites([{ tools: [{ name: 'Bash', detail: 'cd /r', opaqueWrite: true }] }]))
      .toBe(true)
    expect(hasUnlistedWrites([{ tools: [{ name: 'Bash', detail: 'git status' }] }])).toBe(false)
    expect(hasUnlistedWrites([])).toBe(false)
  })
})

describe('a harness that does not speak Claude', () => {
  it('finds an agy write through `canonical`, while the bubble keeps agy\'s own name', () => {
    // The turn carries both readings: `name` is what agy called the tool and is what the
    // conversation shows; `canonical` is the shared vocabulary this set is written in. Selecting on
    // the displayed name would leave this panel blind on every harness but Claude, and rewriting
    // the displayed name to suit this set put Claude's tool names in an Antigravity session.
    const out = artifactsFromTurns([{
      tools: [
        { name: 'write_to_file', canonical: 'Write', detail: '/repo/a.ts' },
        { name: 'replace_file_content', canonical: 'Edit', detail: '/repo/b.ts' },
        { name: 'view_file', canonical: 'Read', detail: '/repo/c.ts' },
      ],
    }])
    // The write and the edit are found; the READ is not — this panel answers what the session
    // PRODUCED. Order is the panel's own (newest first) and is asserted by the tests above.
    expect(out.map(a => a.path).sort()).toEqual(['/repo/a.ts', '/repo/b.ts'])
    expect(out.find(a => a.path === '/repo/a.ts')!.kind).toBe('new')
    expect(out.find(a => a.path === '/repo/b.ts')!.kind).toBe('edited')
  })

  it('a tool with no canonical reading is judged by its own name, as Claude\'s always were', () => {
    expect(artifactsFromTurns([{ tools: [{ name: 'Write', detail: '/repo/x.ts' }] }]))
      .toHaveLength(1)
    expect(artifactsFromTurns([{ tools: [{ name: 'manage_task', detail: 'complete' }] }]))
      .toEqual([])
  })
})

describe('why the count is short', () => {
  /** The server's own sentence, as `listSessionArtifacts` words it. */
  const OUTSIDE_EN = '3 file(s) this session wrote are outside its own folder and cannot be opened here.'
  const OUTSIDE_PT = '3 arquivo(s) que esta sessão escreveu estão fora da pasta dela e não podem ser abertos aqui.'

  it('says NOTHING when there is nothing to qualify — the ordinary case costs no line', () => {
    expect(artifactShortfall({ lang: 'en' })).toEqual([])
    expect(artifactShortfall({ lang: 'pt' })).toEqual([])
    expect(artifactShortfall({ unlisted: false, lang: 'en' })).toEqual([])
  })

  it('passes the server\'s sentence through VERBATIM, in either language', () => {
    expect(artifactShortfall({ outside: OUTSIDE_EN, lang: 'en' })).toEqual([OUTSIDE_EN])
    // The server localizes it; this side never inspects it, so a pt sentence is carried as given.
    expect(artifactShortfall({ outside: OUTSIDE_PT, lang: 'pt' })).toEqual([OUTSIDE_PT])
    expect(artifactShortfall({ outside: OUTSIDE_PT, lang: 'en' })).toEqual([OUTSIDE_PT])
  })

  it('words the unlistable writes itself, and differently per language', () => {
    const en = artifactShortfall({ unlisted: true, lang: 'en' })
    const pt = artifactShortfall({ unlisted: true, lang: 'pt' })
    expect(en).toHaveLength(1)
    expect(pt).toHaveLength(1)
    expect(en[0]).not.toBe(pt[0])
    expect(en[0]).toContain('cannot be read')
    expect(pt[0]).toContain('não dá para ler')
  })

  /**
   * IT STANDS ALONE. The header's count is drawn only when there is at least one artifact, and this
   * flag's primary case is a session whose every write was opaque — so the sentence is routinely
   * read with NO count beside it. "…not in this count" pointed at a number that was not on screen.
   */
  it('the unlistable-writes sentence points at no count', () => {
    const en = artifactShortfall({ unlisted: true, lang: 'en' })[0] ?? ''
    const pt = artifactShortfall({ unlisted: true, lang: 'pt' })[0] ?? ''
    expect(en).not.toMatch(/this count|that count/i)
    expect(pt).not.toMatch(/nesta contagem|dessa contagem|desta contagem/i)
    // It still says what it is for: those files are missing from what this panel shows.
    expect(en).toMatch(/counted/i)
    expect(pt).toMatch(/contados/i)
  })

  it('says BOTH when both hold, the unnameable ones first', () => {
    const out = artifactShortfall({ unlisted: true, outside: OUTSIDE_EN, lang: 'en' })
    expect(out).toHaveLength(2)
    expect(out[0]).toContain('cannot be read')
    expect(out[1]).toBe(OUTSIDE_EN)
  })

  it('an empty `outside` is an absent one — the server omits the field rather than sending ""', () => {
    expect(artifactShortfall({ outside: '', lang: 'en' })).toEqual([])
  })
})
