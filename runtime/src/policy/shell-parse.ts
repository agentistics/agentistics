/**
 * policy/shell-parse.ts — a shell command string, parsed into the SEGMENTS it would run
 * (spec docs/superpowers/specs/2026-09-20-runtime-b3-tool-catalogue.md, D-T3 rule 2).
 *
 * ## Why a parser, and not a pattern over the string
 *
 * Measured on this machine's own transcripts: 55,7 % of shell calls are CHAINS, 76,9 % contain a
 * pipe, 63,3 % a redirect and 46 % start with `cd `. A rule that matches the command STRING
 * ("starts with `git pull`") authorises everything chained after it — `git pull; rm -rf ~` starts
 * with `git pull` too. So the policy judges each thing the command would RUN, one at a time, and
 * this module is what finds them. The repo has already paid the weak version of this lesson:
 * `countGitCommands` had to split chains because a wrapper masked 62 commits as 2.
 *
 * ## What a segment is
 *
 * One simple command: its argv after UNWRAPPING (below), the redirections attached to it, the
 * leading `VAR=value` assignments, and where it sits — its SCOPE (a subshell, a `$( )`, a pipeline
 * element and a `bash -c` string each run in their own, so a `cd` inside one does not move the
 * next) and its PIPELINE position (so "a download piped into a shell" can be recognised).
 * Command substitutions, backticks and process substitutions are segments too, recorded BEFORE the
 * command whose words contain them (that is the order they run in) and pointing back at it (`host`).
 *
 * ## Wrappers are unwrapped, so a wrapper cannot smuggle a segment past a rule
 *
 * `sudo rm -rf /`, `env FOO=1 rm -rf /`, `timeout 5 git push --force`, `xargs rm -rf`,
 * `bash -c "rm -rf ~"` — the segment the policy judges is the INNER command. Every stage is kept
 * (`stages`, outermost first) so a DENY rule written against the wrapper still matches, while an
 * ALLOW rule has to name the command that really runs. `bash -c` / `sh -c` / `zsh -c` and `watch`
 * hand a STRING to a shell, so that string is parsed recursively. `find -exec CMD` runs CMD, so CMD
 * becomes a segment of its own (not in the spec's list; it is the classic way to run `rm` "inside"
 * a read-only-looking command).
 *
 * ## Opaque: what this module refuses to guess
 *
 * Anything whose effect cannot be read off the text with certainty yields a segment marked
 * `opaque` with a reason: `eval`, `source`/`.`, `trap`, a variable or substitution in the command
 * NAME (`$CMD args`), a `bash -c` whose string is built at run time, `case`, `select`, function
 * definitions, `coproc`, array assignments, `for ((…))`, unbalanced quotes or parentheses, a
 * here-document without its terminator or with a command substitution in its body, arithmetic or
 * `${…}` containing a command substitution, `env -S`/`env -C`, an option of a wrapper this module
 * does not know. The policy turns opaque into ASK — fail toward a person — and never into allow.
 * A structural failure (an unbalanced quote) stops the parse of that string: segments after it are
 * NOT reported, which is why the policy must ask about the whole command rather than allow the
 * segments it did see.
 *
 * Loops and conditionals are HANDLED, not opaque: `if/then/else/elif/fi`, `while/until/do/done`,
 * `for NAME in WORDS; do …; done`, `!`, `[[ … ]]` and `(( … ))` — their bodies are ordinary
 * segments, and a loop variable is simply a dynamic word.
 *
 * PURE: no I/O, no environment, no clock. Never throws: an internal defect becomes an opaque
 * segment, because a parser that cannot answer must not be read as "nothing to run".
 */

// ── The result ──────────────────────────────────────────────────────────────────────────────────

export interface ShellWord {
  /** The literal value after quote removal. Expansions that cannot be known are kept in source form. */
  text: string
  /** Contains an expansion (`$x`, `$( )`, backticks, brace expansion, `~user`) whose value is unknown. */
  dynamic: boolean
  /** Contains an unquoted glob character (`*`, `?`, `[`). */
  glob: boolean
  /**
   * Began with `~`, `$HOME` or `${HOME}` (unquoted, or `$HOME` in double quotes). `text` is then the
   * REST of the word (`''` or `/…`), so a caller that knows the home directory can resolve it.
   */
  home: boolean
}

export type RedirOp = '>' | '>>' | '>|' | '<' | '<>' | '&>' | '&>>' | '>&' | '<&' | '<<' | '<<-' | '<<<'

export interface Redirection {
  op: RedirOp
  /** The explicit file descriptor (`2>`), or null. */
  fd: number | null
  /**
   * The FILE the redirection opens, or null when it opens none: fd duplication (`2>&1`, `>&-`),
   * a here-document / here-string (data, not a path), a process substitution.
   */
  target: ShellWord | null
  /** What the redirection does to `target`. `none` exactly when `target` is null. */
  access: 'read' | 'write' | 'none'
}

export interface ShellSegment {
  /** The argv that really runs, after unwrapping. `[]` for a redirection- or assignment-only command. */
  argv: string[]
  /** `argv` with quoting/expansion facts, for path analysis. Same length as `argv`. */
  words: ShellWord[]
  /** Every argv this segment had while being unwrapped, OUTERMOST first; the last one is `argv`. */
  stages: string[][]
  /** The wrappers removed, outermost first (`['sudo', 'env']`). */
  wrappers: string[]
  /** A wrapper that raises privilege (`sudo`, `doas`) was removed. */
  elevated: boolean
  /** `VAR=value` assignments before the command (and those given to `env`). */
  assignments: string[]
  redirects: Redirection[]
  /** The command also receives arguments this text does not show (`xargs`, `find -exec … {}`). */
  appendsArgs: boolean
  /** Present when this segment could not be read with certainty — the policy must ask. */
  opaque?: string
  /** Where a `cd` in this segment takes effect: `0` is the top level, `0.3` a subshell inside it. */
  scope: string
  /** Every pipeline this segment is an element of, innermost last, with its position in it. */
  pipes: Array<{ id: number; pos: number }>
  /** For a `$( )` / backtick / `<( )` segment: the index of the segment whose words contained it. */
  host?: number
  /** How this segment was reached, when not directly. */
  via?: 'cmdsub' | 'procsub' | 'shell-string' | 'find-exec'
}

export interface ShellParse {
  segments: ShellSegment[]
  /** One reason per opaque segment, in order. Empty means everything was read with certainty. */
  opaque: string[]
}

// ── Internals ───────────────────────────────────────────────────────────────────────────────────

/** Aborts the parse of ONE string (a structural failure: nothing after it can be trusted). */
class OpaqueStop {
  constructor(readonly reason: string) {}
}

interface Shared {
  segs: ShellSegment[]
  opaque: string[]
  scopeCounter: number
  pipeCounter: number
}

const MAX_DEPTH = 16
const BLANK = new Set([' ', '\t'])
/** Characters that end an unquoted word. */
const META = new Set([' ', '\t', '\n', ';', '&', '|', '<', '>', '(', ')'])
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'mksh', 'ash'])
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/

interface PendingHeredoc {
  delim: string
  strip: boolean
  quoted: boolean
}

interface WordBuild {
  word: ShellWord
  /** The word's text with only UNQUOTED characters, to spot brace expansion and assignments. */
  unquoted: string
  /** Any part of the word was quoted. */
  quoted: boolean
  /** Length of `word.text` when the first quoted character was appended (Infinity: none). */
  quoteAt: number
  /** Length of `word.text` when the first dynamic part was appended (Infinity: none). */
  dynAt: number
}

function basename(p: string): string {
  const i = p.lastIndexOf('/')
  return i === -1 ? p : p.slice(i + 1)
}

function renderWord(w: ShellWord): string {
  return w.home ? `~${w.text}` : w.text
}

function literalWord(text: string): ShellWord {
  return { text, dynamic: false, glob: false, home: false }
}

class Parser {
  private i = 0
  private pending: PendingHeredoc[] = []

  constructor(
    private readonly s: string,
    private readonly out: Shared,
    private readonly depth: number,
  ) {}

  // ── entry ──

  /** Parses the whole string as a list in `scope`. Never throws. */
  run(scope: string, pipes: Array<{ id: number; pos: number }>, via?: ShellSegment['via']): void {
    const before = this.out.segs.length
    try {
      if (this.depth > MAX_DEPTH) throw new OpaqueStop('commands nested too deeply to read')
      this.parseList(scope, pipes, 'eof')
      if (this.pending.length > 0) throw new OpaqueStop('a here-document has no body')
    } catch (e) {
      const reason = e instanceof OpaqueStop ? e.reason : 'the command could not be parsed'
      this.pushOpaque(reason, scope, pipes)
    }
    if (via) {
      for (let k = before; k < this.out.segs.length; k++) {
        const seg = this.out.segs[k]
        if (seg && seg.via === undefined) seg.via = via
      }
    }
  }

  private pushOpaque(reason: string, scope: string, pipes: Array<{ id: number; pos: number }>, argv: string[] = []): void {
    this.out.opaque.push(reason)
    this.out.segs.push({
      argv,
      words: argv.map(literalWord),
      stages: [argv],
      wrappers: [],
      elevated: false,
      assignments: [],
      redirects: [],
      appendsArgs: false,
      opaque: reason,
      scope,
      pipes: [...pipes],
    })
  }

  private newScope(parent: string): string {
    this.out.scopeCounter += 1
    return `${parent}.${this.out.scopeCounter}`
  }

  // ── character helpers ──

  private peek(o = 0): string {
    return this.s[this.i + o] ?? ''
  }

  private eof(): boolean {
    return this.i >= this.s.length
  }

  private startsWith(t: string): boolean {
    return this.s.startsWith(t, this.i)
  }

  /** Blanks and line continuations; newlines are NOT blanks (they separate commands). */
  private skipBlanks(): void {
    for (;;) {
      const c = this.peek()
      if (BLANK.has(c)) this.i++
      else if (c === '\\' && this.peek(1) === '\n') this.i += 2
      else return
    }
  }

  private skipBlanksAndNewlines(): void {
    for (;;) {
      this.skipBlanks()
      if (this.peek() === '\n') {
        this.i++
        this.readHeredocBodies()
      } else if (this.peek() === '#') {
        this.skipComment()
      } else return
    }
  }

  private skipComment(): void {
    while (!this.eof() && this.peek() !== '\n') this.i++
  }

  /** At a word boundary: does `kw` stand here as a whole word? */
  private atKeyword(kw: string): boolean {
    if (!this.startsWith(kw)) return false
    const next = this.s[this.i + kw.length] ?? ''
    return next === '' || META.has(next)
  }

  // ── grammar ──

  private parseList(scope: string, pipes: Array<{ id: number; pos: number }>, term: 'eof' | ')' | '}'): void {
    for (;;) {
      this.skipBlanks()
      const c = this.peek()
      if (this.eof()) {
        if (term === ')') throw new OpaqueStop('an opening parenthesis is never closed')
        if (term === '}') throw new OpaqueStop('a `{` group is never closed')
        return
      }
      if (c === '#') { this.skipComment(); continue }
      if (c === '\n') { this.i++; this.readHeredocBodies(); continue }
      if (c === ')') {
        if (term === ')') return
        throw new OpaqueStop('a closing parenthesis has no opening one')
      }
      if (c === '}' && term === '}' && this.atKeyword('}')) return
      if (this.startsWith(';;')) throw new OpaqueStop('a `case` clause could not be read')
      if (c === ';') { this.i++; continue }
      if (c === '&' && this.peek(1) !== '&' && this.peek(1) !== '>') { this.i++; continue }
      if (this.startsWith('&&') || this.startsWith('||')) {
        // A list may not start with a connector; bash refuses it, and so do we.
        throw new OpaqueStop('a `&&` or `||` has no command before it')
      }
      if (c === '|') throw new OpaqueStop('a pipe has no command before it')
      this.parsePipeline(scope, pipes)
      this.skipBlanks()
      if (this.startsWith('&&') || this.startsWith('||')) {
        this.i += 2
        this.skipBlanksAndNewlines()
        if (this.eof()) throw new OpaqueStop('a `&&` or `||` has no command after it')
      }
    }
  }

  private parsePipeline(scope: string, pipes: Array<{ id: number; pos: number }>): void {
    this.out.pipeCounter += 1
    const id = this.out.pipeCounter
    const ranges: Array<[number, number]> = []
    let pos = 0
    for (;;) {
      const start = this.out.segs.length
      this.parseCommand(scope, [...pipes, { id, pos }])
      ranges.push([start, this.out.segs.length])
      this.skipBlanks()
      if (this.startsWith('|&') || (this.peek() === '|' && this.peek(1) !== '|')) {
        this.i += this.startsWith('|&') ? 2 : 1
        this.skipBlanksAndNewlines()
        if (this.eof()) throw new OpaqueStop('a pipe has no command after it')
        pos++
        continue
      }
      break
    }
    if (ranges.length > 1) {
      // Every element of a multi-element pipeline runs in its own subshell: a `cd` there moves nothing.
      for (const [a, b] of ranges) {
        const child = this.newScope(scope)
        for (let k = a; k < b; k++) {
          const seg = this.out.segs[k]
          if (!seg) continue
          if (seg.scope === scope) seg.scope = child
          else if (seg.scope.startsWith(scope + '.')) seg.scope = child + seg.scope.slice(scope.length)
        }
      }
    }
  }

  private parseCommand(scope: string, pipes: Array<{ id: number; pos: number }>): void {
    this.skipBlanks()
    const c = this.peek()
    if (c === '(' && this.peek(1) === '(') {
      this.i += 2
      const body = this.scanBalanced('(', ')', 2)
      if (body.includes('$(') || body.includes('`')) {
        this.pushOpaque('an arithmetic command contains a command substitution', scope, pipes)
      }
      this.trailingRedirects(scope, pipes, this.out.segs.length)
      return
    }
    if (c === '(') {
      this.i++
      const start = this.out.segs.length
      this.parseList(this.newScope(scope), pipes, ')')
      this.i++ // the ')'
      this.trailingRedirects(scope, pipes, start)
      return
    }
    if (c === '{' && this.atKeyword('{')) {
      this.i++
      const start = this.out.segs.length
      this.parseList(scope, pipes, '}')
      this.i++ // the '}'
      this.trailingRedirects(scope, pipes, start)
      return
    }
    this.parseSimple(scope, pipes)
  }

  /** Redirections after `( )`, `{ }`, `done`, `fi`: they apply to every segment inside. */
  private trailingRedirects(scope: string, pipes: Array<{ id: number; pos: number }>, start: number): void {
    const redirects: Redirection[] = []
    for (;;) {
      this.skipBlanks()
      if (!this.atRedirect()) break
      redirects.push(this.readRedirect(scope, pipes))
    }
    if (redirects.length === 0) return
    const inner = this.out.segs.slice(start)
    if (inner.length === 0) {
      this.out.segs.push(this.makeSegment([], [], redirects, scope, pipes))
      return
    }
    for (const seg of inner) seg.redirects.push(...redirects)
  }

  private atRedirect(): boolean {
    const c = this.peek()
    if (c === '<' || c === '>') return !(this.peek(1) === '(')
    if (c === '&' && this.peek(1) === '>') return true
    if (/[0-9]/.test(c)) {
      let k = this.i
      while (/[0-9]/.test(this.s[k] ?? '')) k++
      const n = this.s[k] ?? ''
      return (n === '<' || n === '>') && this.s[k + 1] !== '('
    }
    return false
  }

  private readRedirect(scope: string, pipes: Array<{ id: number; pos: number }>): Redirection {
    let fd: number | null = null
    const m = /^[0-9]+/.exec(this.s.slice(this.i))
    if (m) {
      fd = Number(m[0])
      this.i += m[0].length
    }
    const ops: RedirOp[] = ['&>>', '&>', '<<<', '<<-', '<<', '<>', '<&', '>&', '>>', '>|', '<', '>']
    const op = ops.find(o => this.startsWith(o))
    if (!op) throw new OpaqueStop('a redirection could not be read')
    this.i += op.length
    this.skipBlanks()
    if (this.eof() || (META.has(this.peek()) && !(this.peek() === '<' || this.peek() === '>'))) {
      throw new OpaqueStop('a redirection has no target')
    }
    if (op === '<<' || op === '<<-') {
      const w = this.readWord(scope, pipes)
      this.pending.push({ delim: w.word.text, strip: op === '<<-', quoted: w.quoted })
      return { op, fd, target: null, access: 'none' }
    }
    if ((this.peek() === '<' || this.peek() === '>') && this.peek(1) === '(') {
      this.readProcSub(scope, pipes)
      return { op, fd, target: null, access: 'none' }
    }
    const w = this.readWord(scope, pipes).word
    if (op === '<<<') return { op, fd, target: null, access: 'none' }
    if (op === '>&' || op === '<&') {
      if (/^[0-9]+-?$|^-$/.test(w.text) && !w.dynamic) return { op, fd, target: null, access: 'none' }
      return { op, fd, target: w, access: op === '>&' ? 'write' : 'read' }
    }
    if (op === '<') return { op, fd, target: w, access: 'read' }
    return { op, fd, target: w, access: 'write' }
  }

  private readHeredocBodies(): void {
    const pending = this.pending
    this.pending = []
    for (const h of pending) {
      let found = false
      let body = ''
      while (!this.eof()) {
        const nl = this.s.indexOf('\n', this.i)
        const end = nl === -1 ? this.s.length : nl
        const line = this.s.slice(this.i, end)
        this.i = nl === -1 ? this.s.length : nl + 1
        const cmp = h.strip ? line.replace(/^\t+/, '') : line
        if (cmp === h.delim) { found = true; break }
        body += line + '\n'
      }
      if (!found) throw new OpaqueStop('a here-document is never terminated')
      if (!h.quoted && (body.includes('$(') || body.includes('`'))) {
        this.out.opaque.push('a here-document body contains a command substitution')
        this.out.segs.push({
          argv: [], words: [], stages: [[]], wrappers: [], elevated: false, assignments: [], redirects: [],
          appendsArgs: false, opaque: 'a here-document body contains a command substitution', scope: '0', pipes: [],
        })
      }
    }
  }

  /** Scans to the matching close of an already-consumed open (`depth` opens consumed). Returns the body. */
  private scanBalanced(open: string, close: string, depth: number): string {
    const start = this.i
    let d = depth
    while (!this.eof()) {
      const c = this.peek()
      if (c === '\\') { this.i += 2; continue }
      if (c === "'") {
        const e = this.s.indexOf("'", this.i + 1)
        if (e === -1) throw new OpaqueStop('a single quote is never closed')
        this.i = e + 1
        continue
      }
      if (c === open) d++
      else if (c === close) {
        d--
        if (d === 0) {
          const body = this.s.slice(start, this.i - (depth - 1))
          this.i++
          return body
        }
      }
      this.i++
    }
    throw new OpaqueStop(`a \`${open}\` is never closed`)
  }

  private readProcSub(scope: string, pipes: Array<{ id: number; pos: number }>): ShellWord {
    this.i += 2
    const child = this.newScope(scope)
    const before = this.out.segs.length
    this.parseList(child, pipes, ')')
    this.i++
    for (let k = before; k < this.out.segs.length; k++) {
      const seg = this.out.segs[k]
      if (seg && seg.via === undefined) seg.via = 'procsub'
    }
    return { text: '/dev/fd/63', dynamic: true, glob: false, home: false }
  }

  // ── words ──

  private readWord(scope: string, pipes: Array<{ id: number; pos: number }>): WordBuild {
    let text = ''
    let unquoted = ''
    let dynamic = false
    let glob = false
    let home = false
    let quoted = false
    let quoteAt = Infinity
    let dynAt = Infinity
    const markQuoted = (): void => { if (!quoted) quoteAt = text.length; quoted = true }
    const markDynamic = (): void => { if (!dynamic) dynAt = text.length; dynamic = true }
    const atStart = () => text === '' && !home && !quoted && !dynamic

    const homeFollows = (k: number): boolean => {
      const n = this.s[k] ?? ''
      return n === '' || n === '/' || META.has(n) || n === '"'
    }

    while (!this.eof()) {
      const c = this.peek()
      if (META.has(c)) break
      if (c === '\\') {
        if (this.peek(1) === '\n') { this.i += 2; continue }
        if (this.i + 1 >= this.s.length) { text += '\\'; this.i++; continue }
        markQuoted()
        text += this.peek(1)
        this.i += 2
        continue
      }
      if (c === "'") {
        const e = this.s.indexOf("'", this.i + 1)
        if (e === -1) throw new OpaqueStop('a single quote is never closed')
        markQuoted()
        text += this.s.slice(this.i + 1, e)
        this.i = e + 1
        continue
      }
      if (c === '$' && this.peek(1) === "'") {
        this.i += 2
        markQuoted()
        text += this.readAnsiC()
        continue
      }
      if (c === '"' || (c === '$' && this.peek(1) === '"')) {
        const start = atStart()
        this.i += c === '"' ? 1 : 2
        markQuoted()
        const r = this.readDoubleQuoted(scope, pipes, start)
        if (r.dynamic) markDynamic()
        if (r.home) { home = true; text = r.text } else text += r.text
        continue
      }
      if (c === '$') {
        const start = atStart()
        const r = this.readDollar(scope, pipes)
        if (start && r.isHome && homeFollows(this.i)) { home = true; continue }
        if (r.dynamic) markDynamic()
        text += r.text
        unquoted += r.text
        continue
      }
      if (c === '`') {
        markDynamic()
        text += this.readBacktick(scope, pipes)
        continue
      }
      if (c === '~' && atStart()) {
        this.i++
        if (homeFollows(this.i)) { home = true; continue }
        // `~user` / `~+` / `~-`: another home or a directory stack entry — not knowable here.
        markDynamic()
        text += '~'
        unquoted += '~'
        continue
      }
      if (c === '*' || c === '?' || c === '[') glob = true
      text += c
      unquoted += c
      this.i++
    }
    if (/\{[^{}]*(,|\.\.)[^{}]*\}/.test(unquoted)) markDynamic()
    return { word: { text, dynamic, glob, home }, unquoted, quoted, quoteAt, dynAt }
  }

  private readDoubleQuoted(scope: string, pipes: Array<{ id: number; pos: number }>, atWordStart: boolean): { text: string; dynamic: boolean; home: boolean } {
    let text = ''
    let dynamic = false
    let home = false
    for (;;) {
      if (this.eof()) throw new OpaqueStop('a double quote is never closed')
      const c = this.peek()
      if (c === '"') { this.i++; break }
      if (c === '\\') {
        const n = this.peek(1)
        if (n === '\n') { this.i += 2; continue }
        if (n === '$' || n === '`' || n === '"' || n === '\\') { text += n; this.i += 2; continue }
        text += '\\'
        this.i++
        continue
      }
      if (c === '$') {
        const start = atWordStart && text === '' && !home && !dynamic
        const r = this.readDollar(scope, pipes)
        if (start && r.isHome && (this.peek() === '/' || this.peek() === '"')) { home = true; continue }
        text += r.text
        if (r.dynamic) dynamic = true
        continue
      }
      if (c === '`') {
        text += this.readBacktick(scope, pipes)
        dynamic = true
        continue
      }
      text += c
      this.i++
    }
    return { text, dynamic, home }
  }

  /** At `$`. Consumes one expansion (or a literal `$`). */
  private readDollar(scope: string, pipes: Array<{ id: number; pos: number }>): { text: string; dynamic: boolean; isHome: boolean } {
    const start = this.i
    const n = this.peek(1)
    if (n === '(' && this.peek(2) === '(') {
      this.i += 3
      const body = this.scanBalanced('(', ')', 2)
      if (body.includes('$(') || body.includes('`')) {
        this.pushOpaque('an arithmetic expansion contains a command substitution', scope, pipes)
      }
      return { text: this.s.slice(start, this.i), dynamic: true, isHome: false }
    }
    if (n === '(') {
      this.i += 2
      const child = this.newScope(scope)
      const before = this.out.segs.length
      this.parseList(child, pipes, ')')
      this.i++
      for (let k = before; k < this.out.segs.length; k++) {
        const seg = this.out.segs[k]
        if (seg && seg.via === undefined) seg.via = 'cmdsub'
      }
      return { text: this.s.slice(start, this.i), dynamic: true, isHome: false }
    }
    if (n === '{') {
      this.i += 2
      const body = this.scanBalanced('{', '}', 1)
      if (body.includes('$(') || body.includes('`')) {
        this.pushOpaque('a parameter expansion contains a command substitution', scope, pipes)
      }
      return { text: this.s.slice(start, this.i), dynamic: true, isHome: body === 'HOME' }
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.s.slice(this.i + 1))
    if (name) {
      this.i += 1 + name[0].length
      return { text: this.s.slice(start, this.i), dynamic: true, isHome: name[0] === 'HOME' }
    }
    if (/[0-9@*#?$!-]/.test(n) && n !== '') {
      this.i += 2
      return { text: this.s.slice(start, this.i), dynamic: true, isHome: false }
    }
    this.i++
    return { text: '$', dynamic: false, isHome: false }
  }

  private readBacktick(scope: string, pipes: Array<{ id: number; pos: number }>): string {
    const start = this.i
    this.i++
    let inner = ''
    for (;;) {
      if (this.eof()) throw new OpaqueStop('a backtick is never closed')
      const c = this.peek()
      if (c === '\\' && (this.peek(1) === '`' || this.peek(1) === '\\' || this.peek(1) === '$')) {
        inner += this.peek(1)
        this.i += 2
        continue
      }
      if (c === '`') { this.i++; break }
      inner += c
      this.i++
    }
    new Parser(inner, this.out, this.depth + 1).run(this.newScope(scope), pipes, 'cmdsub')
    return this.s.slice(start, this.i)
  }

  private readAnsiC(): string {
    let out = ''
    for (;;) {
      if (this.eof()) throw new OpaqueStop("an ANSI-C quote ($'…') is never closed")
      const c = this.peek()
      if (c === "'") { this.i++; return out }
      if (c !== '\\') { out += c; this.i++; continue }
      const n = this.peek(1)
      this.i += 2
      const simple: Record<string, string> = {
        a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v',
        '\\': '\\', "'": "'", '"': '"', '?': '?',
      }
      const mapped = simple[n]
      if (mapped !== undefined) { out += mapped; continue }
      if (/[0-7]/.test(n)) {
        let digits = n
        while (digits.length < 3 && /[0-7]/.test(this.peek())) { digits += this.peek(); this.i++ }
        out += String.fromCharCode(parseInt(digits, 8))
        continue
      }
      const hex = (max: number): string => {
        let d = ''
        while (d.length < max && /[0-9a-fA-F]/.test(this.peek())) { d += this.peek(); this.i++ }
        return d
      }
      if (n === 'x') { const d = hex(2); out += d ? String.fromCharCode(parseInt(d, 16)) : '\\x'; continue }
      if (n === 'u') { const d = hex(4); out += d ? String.fromCodePoint(parseInt(d, 16)) : '\\u'; continue }
      if (n === 'U') { const d = hex(8); out += d ? String.fromCodePoint(Math.min(parseInt(d, 16), 0x10ffff)) : '\\U'; continue }
      if (n === 'c') { const ch = this.peek(); this.i++; out += String.fromCharCode(ch.charCodeAt(0) & 0x1f); continue }
      out += '\\' + n
    }
  }

  // ── simple commands ──

  private parseSimple(scope: string, pipes: Array<{ id: number; pos: number }>): void {
    const words: ShellWord[] = []
    const assignments: string[] = []
    const redirects: Redirection[] = []
    const subStart = this.out.segs.length
    let commandPosition = true

    for (;;) {
      this.skipBlanks()
      if (this.eof()) break
      const c = this.peek()
      if (c === '\n' || c === ';' || c === ')' || c === '|') break
      if (c === '&' && this.peek(1) !== '>') break
      if (c === '#') { this.skipComment(); break } // at a word start, so it is a comment
      if (this.atRedirect()) { redirects.push(this.readRedirect(scope, pipes)); continue }
      if ((c === '<' || c === '>') && this.peek(1) === '(') { words.push(this.readProcSub(scope, pipes)); commandPosition = false; continue }
      if (c === '(') {
        if (commandPosition && words.length === 0 && assignments.length > 0) throw new OpaqueStop('an array assignment could not be read')
        throw new OpaqueStop('a parenthesis appears where a word was expected')
      }

      if (commandPosition && words.length === 0) {
        // Reserved words are only reserved here, at the start of a command.
        if (assignments.length === 0 && redirects.length === 0) {
          const kw = this.reservedWord(scope, pipes)
          if (kw === 'skip') { this.parseCommand(scope, pipes); return }
          if (kw === 'end') {
            this.trailingRedirects(scope, pipes, this.out.segs.length)
            return
          }
        }
        const w = this.readWord(scope, pipes)
        const m = ASSIGNMENT.exec(w.word.home ? '' : w.word.text)
        if (m && m[0].length <= w.quoteAt && m[0].length <= w.dynAt) {
          if (this.peek() === '(' && m[0].length === w.word.text.length) throw new OpaqueStop('an array assignment could not be read')
          // `X=$(cmd)`: the substitution is already a segment of its own.
          assignments.push(w.word.text)
          continue
        }
        words.push(w.word)
        commandPosition = false
        // `name() { … }` — a function definition.
        const save = this.i
        this.skipBlanks()
        if (this.peek() === '(' && this.s.slice(this.i).match(/^\(\s*\)/)) throw new OpaqueStop('a function definition could not be read')
        this.i = save
        continue
      }
      words.push(this.readWord(scope, pipes).word)
    }

    const idx = this.out.segs.length
    this.emit(words, assignments, redirects, scope, pipes)
    for (let k = subStart; k < idx; k++) {
      const seg = this.out.segs[k]
      if (seg && seg.host === undefined && (seg.via === 'cmdsub' || seg.via === 'procsub')) seg.host = idx
    }
  }

  /** At command position. `skip` = a prefix keyword consumed; `end` = a terminator consumed. */
  private reservedWord(scope: string, pipes: Array<{ id: number; pos: number }>): 'skip' | 'end' | null {
    for (const kw of ['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!']) {
      if (this.atKeyword(kw)) { this.i += kw.length; return 'skip' }
    }
    for (const kw of ['fi', 'done']) {
      if (this.atKeyword(kw)) { this.i += kw.length; return 'end' }
    }
    if (this.atKeyword('for')) {
      this.i += 3
      this.skipBlanks()
      if (this.startsWith('((')) throw new OpaqueStop('an arithmetic `for ((…))` loop could not be read')
      this.readWord(scope, pipes) // the loop variable
      this.skipBlanks()
      if (this.atKeyword('in')) {
        this.i += 2
        for (;;) {
          this.skipBlanks()
          const c = this.peek()
          if (this.eof() || c === ';' || c === '\n') break
          if (META.has(c)) throw new OpaqueStop('a `for` loop header could not be read')
          this.readWord(scope, pipes)
        }
      }
      return 'skip'
    }
    if (this.startsWith('[[') && (BLANK.has(this.peek(2)) || this.peek(2) === '\n')) {
      const end = this.s.indexOf(']]', this.i + 2)
      if (end === -1) throw new OpaqueStop('a `[[` test is never closed')
      const body = this.s.slice(this.i + 2, end)
      if (body.includes('$(') || body.includes('`')) throw new OpaqueStop('a `[[` test contains a command substitution')
      this.i = end + 2
      return 'end'
    }
    for (const kw of ['case', 'select', 'function', 'coproc']) {
      if (this.atKeyword(kw)) throw new OpaqueStop(`a \`${kw}\` construct is not read by the policy`)
    }
    return null
  }

  private makeSegment(words: ShellWord[], assignments: string[], redirects: Redirection[], scope: string, pipes: Array<{ id: number; pos: number }>): ShellSegment {
    const argv = words.map(renderWord)
    return {
      argv, words, stages: [argv], wrappers: [], elevated: false, assignments, redirects,
      appendsArgs: false, scope, pipes: [...pipes],
    }
  }

  /** Builds the segment for one simple command, unwrapping wrappers. */
  private emit(words: ShellWord[], assignments: string[], redirects: Redirection[], scope: string, pipes: Array<{ id: number; pos: number }>): void {
    const seg = this.makeSegment(words, assignments, redirects, scope, pipes)
    if (words.length === 0) {
      if (redirects.length > 0 || assignments.length > 0) this.out.segs.push(seg)
      return
    }
    let cur = words
    for (let guard = 0; guard < 32; guard++) {
      const w0 = cur[0]
      if (!w0) break
      if (w0.dynamic && !w0.home) {
        this.finishOpaque(seg, cur, 'the command name is a variable or a substitution, so what runs cannot be known')
        return
      }
      const name = basename(w0.text)
      const unwrapped = unwrap(name, cur)
      if (unwrapped.kind === 'none') break
      if (unwrapped.kind === 'opaque') { this.finishOpaque(seg, cur, unwrapped.reason); return }
      if (unwrapped.kind === 'shell-string') {
        seg.wrappers.push(name)
        const str = unwrapped.script
        if (str.dynamic) { this.finishOpaque(seg, cur, 'a shell is given a command string built at run time'); return }
        const child = this.newScope(scope)
        const before = this.out.segs.length
        new Parser(str.text, this.out, this.depth + 1).run(child, pipes, 'shell-string')
        for (let k = before; k < this.out.segs.length; k++) {
          const inner = this.out.segs[k]
          if (!inner) continue
          inner.wrappers.unshift(...seg.wrappers)
          if (seg.elevated) inner.elevated = true
          inner.stages.unshift(...seg.stages)
          inner.redirects.push(...redirects)
          inner.assignments.unshift(...seg.assignments)
        }
        if (this.out.segs.length === before && redirects.length > 0) {
          this.out.segs.push({ ...this.makeSegment([], [], redirects, scope, pipes), wrappers: [...seg.wrappers] })
        }
        return
      }
      if (unwrapped.kind === 'find-exec') {
        // `find` itself stays the segment; each -exec command becomes a segment of its own.
        for (const cmd of unwrapped.commands) {
          const inner = this.makeSegment(cmd, [], [], scope, pipes)
          inner.appendsArgs = true
          inner.via = 'find-exec'
          inner.wrappers = [...seg.wrappers, 'find']
          inner.elevated = seg.elevated
          inner.stages = [...seg.stages, cmd.map(renderWord)]
          if (inner.argv.length > 0) {
            const w = inner.words[0]
            if (w && w.dynamic && !w.home) { inner.opaque = 'find -exec runs a command whose name is a variable'; this.out.opaque.push(inner.opaque) }
            this.out.segs.push(inner)
          }
        }
        break
      }
      // A plain wrapper: record it and continue with the command it runs.
      seg.wrappers.push(name)
      if (unwrapped.elevated) seg.elevated = true
      if (unwrapped.appendsArgs) seg.appendsArgs = true
      seg.assignments.push(...unwrapped.assignments)
      if (unwrapped.rest.length === 0) break
      cur = unwrapped.rest
      seg.stages.push(cur.map(renderWord))
    }
    seg.words = cur
    seg.argv = cur.map(renderWord)
    const name0 = basename(seg.argv[0] ?? '')
    const opaqueName: Record<string, string> = {
      eval: '`eval` runs a string as a command',
      source: '`source` runs the commands in a file',
      '.': '`.` runs the commands in a file',
      trap: '`trap` registers a command to run later',
    }
    const reason = opaqueName[name0]
    if (reason && !(name0 === 'trap' && seg.argv.length <= 1)) { seg.opaque = reason; this.out.opaque.push(reason) }
    this.out.segs.push(seg)
  }

  private finishOpaque(seg: ShellSegment, cur: ShellWord[], reason: string): void {
    seg.words = cur
    seg.argv = cur.map(renderWord)
    seg.opaque = reason
    this.out.opaque.push(reason)
    this.out.segs.push(seg)
  }
}

// ── Wrappers ────────────────────────────────────────────────────────────────────────────────────

type Unwrapped =
  | { kind: 'none' }
  | { kind: 'opaque'; reason: string }
  | { kind: 'wrapper'; rest: ShellWord[]; elevated: boolean; appendsArgs: boolean; assignments: string[] }
  | { kind: 'shell-string'; script: ShellWord }
  | { kind: 'find-exec'; commands: ShellWord[][] }

function wrapper(rest: ShellWord[], extra: Partial<{ elevated: boolean; appendsArgs: boolean; assignments: string[] }> = {}): Unwrapped {
  return { kind: 'wrapper', rest, elevated: extra.elevated ?? false, appendsArgs: extra.appendsArgs ?? false, assignments: extra.assignments ?? [] }
}

/**
 * Walks a wrapper's own options. `withArg` are short options taking a value (attached or next
 * word); `flags` take none; `longWithArg` are long options whose value may be the next word.
 * Unknown options make the wrapper opaque — guessing an option's arity is how a command name
 * gets read as an option value, or the reverse.
 */
function skipOptions(
  words: ShellWord[],
  from: number,
  spec: { flags: string; withArg: string; longFlags?: string[]; longWithArg?: string[]; numericShort?: boolean },
): number | string {
  let j = from
  while (j < words.length) {
    const w = words[j]
    if (!w || w.dynamic) break
    const t = w.text
    if (t === '--') return j + 1
    if (!t.startsWith('-') || t === '-') break
    if (t.startsWith('--')) {
      const name = t.slice(2).split('=')[0] ?? ''
      if (spec.longWithArg?.includes(name)) { j += t.includes('=') ? 1 : 2; continue }
      if (spec.longFlags?.includes(name)) { j++; continue }
      return `unknown option ${t}`
    }
    if (spec.numericShort && /^-[0-9]+$/.test(t)) { j++; continue }
    let k = 1
    let consumedNext = false
    for (; k < t.length; k++) {
      const ch = t[k] ?? ''
      if (spec.withArg.includes(ch)) {
        if (k === t.length - 1) consumedNext = true
        k = t.length
        break
      }
      if (!spec.flags.includes(ch)) return `unknown option -${ch}`
    }
    j += consumedNext ? 2 : 1
  }
  return j
}

function afterOptions(name: string, words: ShellWord[], spec: Parameters<typeof skipOptions>[2], extra: Partial<{ elevated: boolean; appendsArgs: boolean }> = {}): Unwrapped {
  const j = skipOptions(words, 1, spec)
  if (typeof j === 'string') return { kind: 'opaque', reason: `\`${name}\` was given an option the policy does not know (${j})` }
  return wrapper(words.slice(j), extra)
}

function unwrap(name: string, words: ShellWord[]): Unwrapped {
  switch (name) {
    case 'sudo':
      return afterOptions(name, words, {
        flags: 'AbEeHiKklnPSsVv', withArg: 'CDghpRrtTUu',
        longFlags: ['preserve-env', 'login', 'shell', 'non-interactive', 'stdin', 'background', 'askpass', 'set-home', 'reset-timestamp', 'remove-timestamp'],
        longWithArg: ['user', 'group', 'chdir', 'host', 'prompt', 'role', 'type', 'command-timeout', 'other-user', 'close-from', 'chroot'],
      }, { elevated: true })
    case 'doas':
      return afterOptions(name, words, { flags: 'ns', withArg: 'uC' }, { elevated: true })
    case 'nohup':
    case 'builtin':
      return wrapper(words.slice(1))
    case 'time':
      return afterOptions(name, words, { flags: 'pvq', withArg: 'fo', longFlags: ['portability', 'verbose', 'quiet', 'append'], longWithArg: ['format', 'output'] })
    case 'command': {
      const first = words[1]?.text ?? ''
      if (first === '-v' || first === '-V') return { kind: 'none' }
      return afterOptions(name, words, { flags: 'p', withArg: '' })
    }
    case 'exec':
      return afterOptions(name, words, { flags: 'cl', withArg: 'a' })
    case 'nice':
      return afterOptions(name, words, { flags: '', withArg: 'n', longWithArg: ['adjustment'], numericShort: true })
    case 'setsid':
      return afterOptions(name, words, { flags: 'cfw', withArg: '', longFlags: ['ctty', 'fork', 'wait'] })
    case 'stdbuf':
      return afterOptions(name, words, { flags: '', withArg: 'ioe', longWithArg: ['input', 'output', 'error'] })
    case 'timeout': {
      const j = skipOptions(words, 1, { flags: 'v', withArg: 'sk', longFlags: ['preserve-status', 'foreground', 'verbose'], longWithArg: ['signal', 'kill-after'] })
      if (typeof j === 'string') return { kind: 'opaque', reason: `\`timeout\` was given an option the policy does not know (${j})` }
      return wrapper(words.slice(j + 1)) // skip the DURATION
    }
    case 'env': {
      const assignments: string[] = []
      let j = 1
      while (j < words.length) {
        const w = words[j]
        if (!w) break
        const t = w.text
        if (t === '--') { j++; continue }
        if (t === '-' || t === '-i' || t === '-0' || t === '-v' || t === '--ignore-environment' || t === '--null' || t === '--debug') { j++; continue }
        if (t === '-u' || t === '--unset') { j += 2; continue }
        if (t.startsWith('-u') || t.startsWith('--unset=')) { j++; continue }
        if (t === '-C' || t.startsWith('-C') || t.startsWith('--chdir')) return { kind: 'opaque', reason: '`env -C` runs the command in another directory' }
        if (t === '-S' || t.startsWith('-S') || t.startsWith('--split-string')) return { kind: 'opaque', reason: '`env -S` splits a string into a command' }
        if (t.startsWith('-')) return { kind: 'opaque', reason: `\`env\` was given an option the policy does not know (${t})` }
        if (ASSIGNMENT.test(t)) { assignments.push(t); j++; continue }
        break
      }
      return wrapper(words.slice(j), { assignments })
    }
    case 'xargs': {
      const j = skipOptions(words, 1, {
        flags: '0rtpxo', withArg: 'adEIiLlnPse',
        longFlags: ['null', 'no-run-if-empty', 'verbose', 'interactive', 'exit', 'open-tty'],
        longWithArg: ['arg-file', 'delimiter', 'eof', 'replace', 'max-lines', 'max-args', 'max-procs', 'max-chars', 'process-slot-var'],
      })
      if (typeof j === 'string') return { kind: 'opaque', reason: `\`xargs\` was given an option the policy does not know (${j})` }
      const rest = words.slice(j)
      // With no command, xargs runs `echo`: harmless, and there is nothing further to unwrap.
      return wrapper(rest.length > 0 ? rest : [literalWord('echo')], { appendsArgs: true })
    }
    case 'watch': {
      let exec = false
      let j = 1
      while (j < words.length) {
        const t = words[j]?.text ?? ''
        if (!t.startsWith('-') || t === '-') break
        if (t === '--') { j++; break }
        if (t === '-x' || t === '--exec') { exec = true; j++; continue }
        if (t === '-n' || t === '--interval' || t === '-q' || t === '--equexit') { j += 2; continue }
        if (/^-n[0-9.]+$/.test(t) || t.startsWith('--interval=') || t.startsWith('--differences') || t.startsWith('--equexit=')) { j++; continue }
        if (/^-[dtbegcpwh]+$/.test(t) || ['--no-title', '--beep', '--errexit', '--chgexit', '--color', '--precise', '--no-wrap'].includes(t)) { j++; continue }
        return { kind: 'opaque', reason: `\`watch\` was given an option the policy does not know (${t})` }
      }
      const rest = words.slice(j)
      if (rest.length === 0) return { kind: 'none' }
      if (exec) return wrapper(rest)
      // watch hands `sh -c` its arguments joined by spaces.
      return { kind: 'shell-string', script: { text: rest.map(renderWord).join(' '), dynamic: rest.some(w => w.dynamic && !w.home), glob: false, home: false } }
    }
    case 'find': {
      const commands: ShellWord[][] = []
      for (let j = 1; j < words.length; j++) {
        const t = words[j]?.text ?? ''
        if (t === '-exec' || t === '-execdir' || t === '-ok' || t === '-okdir') {
          const cmd: ShellWord[] = []
          let k = j + 1
          for (; k < words.length; k++) {
            const u = words[k]
            if (!u) break
            if (u.text === ';' || u.text === '+') break
            if (u.text === '{}') continue
            cmd.push(u)
          }
          commands.push(cmd)
          j = k
        }
      }
      return commands.length > 0 ? { kind: 'find-exec', commands } : { kind: 'none' }
    }
    default:
      break
  }
  if (SHELLS.has(name)) {
    let j = 1
    let hasC = false
    while (j < words.length) {
      const t = words[j]?.text ?? ''
      if (t === '--' || t === '-') { j++; break }
      if (!(t.startsWith('-') || t.startsWith('+'))) break
      if (t === '-o' || t === '+o' || t === '-O' || t === '+O') { j += 2; continue }
      if (t.startsWith('--')) { j++; continue }
      if (t.startsWith('-') && t.includes('c')) hasC = true
      j++
    }
    if (!hasC) return { kind: 'none' }
    const script = words[j]
    if (!script) return { kind: 'opaque', reason: `\`${name} -c\` was given no command string` }
    return { kind: 'shell-string', script }
  }
  return { kind: 'none' }
}

// ── Public entry ────────────────────────────────────────────────────────────────────────────────

/** Parses `command` into the segments it would run. Pure; never throws. */
export function parseShell(command: string): ShellParse {
  const out: Shared = { segs: [], opaque: [], scopeCounter: 0, pipeCounter: 0 }
  try {
    new Parser(command, out, 0).run('0', [])
  } catch {
    out.opaque.push('the command could not be parsed')
    out.segs.push({
      argv: [], words: [], stages: [[]], wrappers: [], elevated: false, assignments: [], redirects: [],
      appendsArgs: false, opaque: 'the command could not be parsed', scope: '0', pipes: [],
    })
  }
  return { segments: out.segs, opaque: out.opaque }
}

/** The basename of a command word (`/usr/bin/rm` → `rm`). Exported for the policy. */
export function commandName(argv0: string): string {
  return basename(argv0)
}
