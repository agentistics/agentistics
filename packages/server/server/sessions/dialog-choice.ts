/**
 * dialog-choice.ts — PURE. The OPTIONS a blocked session is offering, read off its screen.
 *
 * ## Why this exists
 *
 * `approval-spec.ts` shipped with one keystroke per harness and the honest warning that it
 * "confirms the highlighted option and is not approve". That warning turns out to describe a real
 * hole rather than a caveat, and a user found it: a session sitting on
 *
 *     ❯ 1. Só o meu fix, isolado
 *       2. Promover dev→main inteiro
 *       3. Parar em dev por enquanto
 *       4. Type something.
 *
 * has no "approve". Pressing a key called approve there picks, blind, between four things that do
 * different work on somebody's repository. It is the same class of mistake as the prompt that fell
 * into a dialog's filter and approved a command nobody had read — quieter, and just as bad.
 *
 * The fix is not a better keystroke, it is READING THE OPTIONS and letting a person choose one.
 * They are on the screen; the frame is already captured to decide the state.
 *
 * ## Why the discriminator is the options and not the footer
 *
 * The obvious design is to tell "yes/no" dialogs from "choose one of N" by their footers, the way
 * `attention-rules.ts` tells one claude dialog from another. It does not survive contact with the
 * data: claude's PERMISSION prompt is itself a numbered list —
 *
 *     ❯ 1. Yes
 *       2. Yes, allow all edits during this session (shift+tab)
 *       3. No
 *
 * — so there is no yes/no dialog to separate out. There is one select component whose options
 * differ, and "Yes" being first is a convention, not a guarantee. The footer answers "is a dialog
 * open"; only the options answer "what would I be choosing".
 *
 * ## Confidence, and what happens without it
 *
 * A list of numbers is easy to hallucinate: an assistant that printed `1. foo / 2. bar` in its
 * answer would look exactly like a menu. Three things bound that:
 *
 *  - This is only ever run on a frame `attention-rules.ts` has ALREADY matched as a dialog.
 *  - The scan runs BOTTOM-UP and stops at the first `1.` it meets, so it reads the last block on
 *    the screen — the dialog is drawn at the bottom.
 *  - The numbers must come out as exactly `1..n` with nothing missing and nothing repeated. A
 *    prose list that happens to sit at the bottom will usually fail this; when it cannot be shown
 *    to be a menu, the answer is NO options, and the caller says so instead of guessing.
 *
 * Verified against three real claude 2.1.232 dialogs on 2026-08-14 (a Bash permission prompt, a
 * Write permission prompt and an `AskUserQuestion`), all captured from live sessions.
 */

/** One option a dialog is offering. */
export interface DialogOption {
  /** The number the dialog printed, which is also what is typed to pick it. */
  number: number
  /** The option's own line, without its number and without the cursor. */
  label: string
  /** True for the one the dialog is currently highlighting. */
  selected: boolean
  /**
   * F3.3 — the option is a FIELD (picking it means typing an answer), as a structured session's
   * PROTOCOL states it (`StructuredOption.freeText`). Absent on a screen read: there the label decides
   * (`isFreeTextOption`).
   */
  freeText?: boolean
  /**
   * The option is a CHECKBOX of a multi-select question, and whether it is ticked now. Absent on a
   * single-choice option. Read off the `[ ]` / `[✔]` / `[x]` the harness prints (claude 2.1.309 and
   * agy 1.4.6, both 2026-10-23), which is STRIPPED from `label` — drawn as text it read as a literal
   * `[ ] Apple` in the card, with nothing saying a click only ticks a box.
   */
  checked?: boolean
}

/**
 * WHERE in a multi-step form this dialog is — PURE data, read off the same frame as the options.
 *
 * claude's `AskUserQuestion` with several questions draws a TAB STRIP above the question
 * (`←  ☒ Fruit  ☐ Color  ✔ Submit  →`, ☒ answered, ☐ not yet) and ends on a REVIEW step
 * (`Ready to submit your answers?` / `1. Submit answers` / `2. Cancel`); agy's `ask_question` prints
 * `Question 1/2: …` instead and has no review step. Without this the card showed one step of a form
 * as if it were the whole question, and the person could not move on, nor see what was left.
 */
export interface DialogForm {
  /** claude's tab strip, Submit excluded. Absent where the harness draws none. */
  steps?: { label: string; done: boolean }[]
  /** agy's `Question n/m`. Absent where the harness does not print one. */
  position?: { at: number; of: number }
  /** The REVIEW step: the answers are read back and the options are submit/cancel. */
  review?: true
  /** The options are checkboxes (`DialogOption.checked`): a pick toggles, it does not answer. */
  multi?: true
  /**
   * A STRUCTURED multi-select (engine-api 1.13): no key is pressed per tick — the card keeps the
   * ticks and sends them together as `choices`. Never set by a screen read.
   */
  together?: true
}

/**
 * A numbered option line.
 *
 * The cursor glyph is optional and is what marks the highlighted row. The label must start with a
 * non-space, so `1.` on its own is not an option — a bare number with no text is far more likely to
 * be an ordinal in prose than a menu entry.
 *
 * THREE GLYPHS, not the two this shipped with. `❯` (U+276F) is claude's; codex draws its own
 * numbered menus (its directory-trust prompt, `1. Yes, continue` / `2. No, quit`) with `›`
 * (U+203A) instead — measured live, codex 0.153.4, 2026-09-10. Missing it meant the cursor's own
 * row — almost always option 1, the default — never matched `(\d{1,2})` at all, `1.` was never
 * reached, and EVERY codex numbered dialog anchored on the row behind it and reported `unreadable`
 * / `no-anchor` instead of `options`. That is not a cosmetic miss: `no-anchor`'s `top` still points
 * at whatever WAS matched, which is what let `attentionOf`'s approval window widen over it anyway —
 * so the dialog still blocked correctly, but no caller could ever read WHAT it was offering to
 * choose between, on a menu this product ships and a first-time user meets on their very first
 * message.
 */
const OPTION = /^\s*(❯|›|>)?\s*(\d{1,2})\.\s+(\S.*?)\s*$/

/**
 * How far up the frame to look for the dialog's LAST option row.
 *
 * Below the last option there is only chrome — a rule, a footer, the input box — so this is a
 * bound on the harness's furniture, which does not grow. It is NOT a bound on the dialog.
 */
const LAST_OPTION_LINES = 40

/**
 * How far apart two option rows of ONE menu may sit.
 *
 * This replaced a flat 40-line ceiling on the whole block, and the distinction matters because a
 * flat line count is not a bound on the DIALOG — it is a bound on the TERMINAL WIDTH. The same
 * `AskUserQuestion` whose descriptions wrap onto two lines at 120 columns wraps onto four at 60,
 * and crosses any fixed ceiling purely by the window being narrow. That is exactly how this
 * survived its own tests: measured wide, reported from a narrow window.
 *
 * The gap is the structural fact instead. Between option k and option k+1 there is only option k's
 * own description, so the block extends as far as its options do and stops where prose begins.
 */
const MAX_OPTION_GAP = 14

/**
 * How far a dialog's LAST option row may sit from where the frame's real content actually ends.
 *
 * A genuinely open dialog has almost nothing below its last option — its own confirm footer, or a
 * queued message or two (the harness draws the input box under the dialog, one row per queued
 * line; the report this bound must still pass has 9 lines below the last option while still
 * blocked — see `attention.test.ts`'s "a QUEUED message pushes the dialog footer off the bottom").
 * A STALE menu — the same numbered block still sitting on screen long after it was answered,
 * because the harness never scrolled it away — has a whole new turn below it instead: a header, a
 * reply, a fresh idle prompt. Measured on a real codex session (v0.153.4): 25 lines of genuine
 * post-dialog content sat below the very "1. Yes, continue / 2. No, quit" trust prompt it had
 * already answered, and the block was still being read as an open dialog. Every first-time codex
 * user hits this on their very first prompt — codex's own directory-trust dialog is exactly this
 * numbered block, it never scrolls out of `LAST_OPTION_LINES` on a short quiet reply, and reading
 * it as still-open makes `attentionOf` report `waiting-approval` forever, degrading chat mode down
 * to "attach to answer it there" for a session that has nothing left to answer.
 *
 * The bound sits between the two measurements — comfortably above the legitimate 9, comfortably
 * below the stale 25.
 */
const MAX_TRAILING_GAP = 16

/** Why a dialog that IS on screen could not be read. Each is a fact about the frame. */
export type DialogUnreadable =
  /** Option rows were found and the scan never reached `1.` — the block ran off the top. */
  | 'no-anchor'
  /** The numbers did not come out `1..n`: a gap, a repeat, or a wrong start. */
  | 'gap'
  /** Two highlighted rows. A frame this parser does not understand. */
  | 'two-cursors'
  /**
   * A numberless block with MORE rows at its column past a blank line — options grouped with their
   * own description lines (kimi 0.41.0's trust prompt), which a contiguous-rows read would half-read.
   */
  | 'grouped'

/**
 * WHAT THE SCREEN IS OFFERING — PURE, and the ONE reader of the block.
 *
 * `kind` is the whole point of this type. An empty option list used to be the only answer for two
 * situations that could not be more different:
 *
 *  - `none`       — there is no menu. The codex-shaped `Press enter to continue`. A bare confirm
 *                   key is the RIGHT answer here, because there is nothing to choose between.
 *  - `unreadable` — there IS a menu and agentop could not read it. A bare confirm key takes
 *                   whichever row is highlighted, which is choosing for the user among things that
 *                   do different work.
 *
 * The caller read `[]` as the first and got the second, and the confirm button appeared on a
 * six-option `AskUserQuestion` that the reader had just refused. That is the exact accident this
 * module was written to remove, reintroduced through its own refusal. So the refusal is now a
 * VALUE, and a caller that wants to offer a confirm has to ask for `none` by name.
 */
export interface DialogRead {
  kind: 'options' | 'none' | 'unreadable'
  /** The options, in order. EMPTY unless `kind` is `options` — a half-read list is never offered. */
  options: DialogOption[]
  /**
   * HOW one of them is picked — and the reason this field exists is that the answer differs.
   *
   * `numbered` — the dialog printed `1.`…`n.` and typing the digit selects. `marker` — it printed
   * no numbers at all (claude's trust prompt: `❯ No, exit` / `  Yes, I trust this folder`), so the
   * only way to reach a row is to MOVE the cursor onto it. `number` on those options is a POSITION,
   * never something to type; a caller that sends it as a digit is typing into the dialog.
   *
   * `null` whenever `kind` is not `options`.
   */
  select: 'numbered' | 'marker' | null
  /** Present only on `unreadable`. */
  reason?: DialogUnreadable
  /** Index of the TOPMOST option row reached, `-1` when none was. Feeds the preview's window. */
  top: number
  /** Present only on `options`, and only when the dialog is one step of a form or a multi-select. */
  form?: DialogForm
}

/**
 * A line drawn INSIDE a box, without its borders — copilot draws its whole folder-trust dialog in
 * one (`│ ❯ 1. Yes                │`, GitHub Copilot CLI 1.0.98, 2026-10-23), and the numbered rule
 * anchors on the line's START, so every row of it was invisible: the dialog read as `none` and the
 * card offered a bare confirm over three options. Only a line bordered on BOTH sides is unwrapped
 * (nested boxes included), so text that merely contains a `│` is left exactly as it was. Indices
 * stay 1:1 with the frame.
 */
const BOXED = /^\s*│(.*)│\s*$/
function unbox(line: string): string {
  let l = line
  for (let i = 0; i < 3; i++) {
    const m = BOXED.exec(l)
    if (!m) break
    l = m[1]!
  }
  return l
}

/** A checkbox label: `[ ] Apple`, `[✔] Apple`, `[x] Apple`. */
const CHECKBOX = /^\[([ xX✔✓])\]\s+(\S.*)$/

/** claude's tab strip: `←  ☒ Fruit  ☐ Color  ✔ Submit  →`. */
const TAB_STRIP = /^\s*←\s+(.*?)\s+→\s*$/
const TAB = /^([☐☒✔✓])\s+(\S.*)$/
/** agy's `Question 1/2: Which fruits?`. */
const POSITION = /^\s*Question (\d+)\/(\d+):/
/** claude's review step, the line drawn directly above `1. Submit answers`. */
const REVIEW = /^\s*Ready to submit your answers\?\s*$/

/** How far above the first option the form's header may sit (a question can wrap). */
const FORM_HEADER_LINES = 16

/** Read the FORM around a numbered block — PURE. `undefined` when the dialog is a plain question. */
export function readForm(frame: readonly string[], top: number, options: readonly DialogOption[]): DialogForm | undefined {
  const form: DialogForm = {}
  if (options.some(o => o.checked !== undefined)) form.multi = true
  let nearest = true
  for (let i = top - 1; i >= 0 && top - i <= FORM_HEADER_LINES; i--) {
    const line = unbox(frame[i] ?? '')
    if (line.trim() === '') continue
    // The review sentence counts only DIRECTLY above the options: elsewhere it is a quotation.
    if (nearest && REVIEW.test(line)) form.review = true
    nearest = false
    const p = POSITION.exec(line)
    if (p && !form.position) form.position = { at: Number(p[1]), of: Number(p[2]) }
    const strip = TAB_STRIP.exec(line)
    if (strip) {
      const tabs = strip[1]!.split(/\s{2,}/)
        .map(t => TAB.exec(t.trim()))
        .filter((m): m is RegExpExecArray => m !== null)
      // `✔ Submit` is the review step's own tab, not a question.
      const questions = tabs.filter(t => t[1] === '☐' || t[1] === '☒')
      if (questions.length >= 1 && tabs.length >= 2) {
        form.steps = questions.map(t => ({ label: t[2]!.trim(), done: t[1] === '☒' }))
      }
      break
    }
  }
  return form.multi || form.review || form.steps || form.position ? form : undefined
}

/**
 * Read the dialog off the frame — PURE.
 *
 * Bottom-up, because the dialog is the last block on the screen, stopping at `1.` because that is
 * where the block begins. Everything the old `parseDialogOptions` refused it still refuses; it now
 * says WHICH refusal, and hands back where the block starts so the preview and the options can
 * never describe different parts of the screen.
 */
export function readDialog(
  frame: readonly string[],
  /**
   * Whether to try the NUMBERLESS shape when no numbers are found.
   *
   * Off by default, and that is the safe direction: a caller that does not know which harness drew
   * this frame must not go looking for a menu with the weaker signal. `ApprovalSpec.markerSelect`
   * is what turns it on, per harness and only where the shape has been measured — see that field
   * for the kimi frame that makes this a gate rather than a flag.
   */
  opts: MarkerOpts = {},
): DialogRead {
  const found: DialogOption[] = []
  let top = -1
  let bottom = -1
  let anchored = false

  for (let i = frame.length - 1; i >= 0; i--) {
    // The LAST option is near the bottom, under nothing but chrome. Past this bound with nothing
    // found, there is no dialog here — and reading further would be reading the scrollback.
    if (found.length === 0 && frame.length - 1 - i > LAST_OPTION_LINES) break
    const m = OPTION.exec(unbox(frame[i] ?? ''))
    if (!m) continue
    // Too far above the previous option to be part of the same menu: this is prose that happens to
    // be numbered, and joining it to the block would invent a menu.
    if (found.length > 0 && top - i > MAX_OPTION_GAP) break
    if (found.length === 0) bottom = i
    const box = CHECKBOX.exec(m[3]!)
    found.push(box
      ? { number: Number(m[2]), label: box[2]!, selected: m[1] !== undefined, checked: box[1] !== ' ' }
      : { number: Number(m[2]), label: m[3]!, selected: m[1] !== undefined })
    top = i
    if (Number(m[2]) === 1) { anchored = true; break }
  }

  found.reverse()

  // Nothing numbered at the bottom at all. It may still be a menu — claude's trust prompt prints
  // none — so the marker shape gets its turn. This is the ONLY place it runs: a frame whose numbers
  // were found and then refused keeps that refusal, or a `gap` would be re-read as two loose rows.
  if (found.length === 0) return opts.marker ? readMarkerSelect(frame, opts) : { kind: 'none', options: [], select: null, top: -1 }
  // Rows were found and `1.` never was. The block is real and its top is out of reach.
  if (!anchored) return { kind: 'unreadable', reason: 'no-anchor', options: [], select: null, top }

  // The block is anchored — but is it still THERE, or is it the same lines sitting unscrolled long
  // after somebody answered them? Trailing BLANK padding below the frame's real content is chrome
  // (a fixed-height pane draws nothing into the rows it has not reached yet) and never counts; a
  // whole subsequent turn does. See `MAX_TRAILING_GAP`.
  let contentEnd = frame.length
  // A box's own closing edge and empty boxed rows are chrome, like the blank padding.
  while (contentEnd > bottom + 1 && /^[\s│╰╯─]*$/.test(frame[contentEnd - 1] ?? '')) contentEnd--
  if (contentEnd - 1 - bottom > MAX_TRAILING_GAP) {
    return { kind: 'none', options: [], select: null, top: -1 }
  }
  // A menu is at least a choice. One option is a statement, and the caller confirms it instead.
  if (found.length < 2) return { kind: 'none', options: [], select: null, top }
  // Exactly `1..n`, in order. A gap, a repeat or a wrong start means this was not read correctly —
  // and half-read options are worse than none, because they would be offered as if they were whole.
  if (found.some((o, i) => o.number !== i + 1)) return { kind: 'unreadable', reason: 'gap', options: [], select: null, top }
  // At most one highlighted row. Two cursors is a frame this parser does not understand.
  if (found.filter(o => o.selected).length > 1) {
    return { kind: 'unreadable', reason: 'two-cursors', options: [], select: null, top }
  }

  const form = readForm(frame, top, found)
  return { kind: 'options', options: found, select: 'numbered', top, ...(form ? { form } : {}) }
}

/**
 * The select cursor, and ONLY the cursor.
 *
 * `readDialog`'s numbered rule also accepts a plain `>`, because there the digit carries the proof
 * that it is a menu. Here nothing else does, and a `>`-quoted block — two lines of somebody's mail,
 * a diff, a markdown quote — has exactly the shape this scan looks for. `❯` is the glyph claude's
 * select component draws and prose does not.
 */
const MARKER = /^(\s*)❯ (\S.*?)\s*$/

/**
 * How a harness whose select does NOT draw `❯` is read.
 *
 * antigravity's trust prompt draws its cursor as a plain `>` (captured from agy 1.2.14, 2026-10-01:
 * `> Yes, I trust this folder` / `  No, exit` over `↑/↓ Navigate · enter Confirm`), and `>` is also
 * the prompt of its chat — `> only say ok` is somebody's message — so the glyph alone proves
 * nothing. A harness that uses a glyph other than `❯` therefore MUST name the footer its dialogs
 * carry, and the menu is read only when that footer is among the last lines of the frame: the
 * footer is what says "a select is open", the glyph only says which row.
 */
export interface MarkerOpts {
  marker?: boolean
  /** The cursor glyph, when it is not `❯`. Requires `footer`. */
  glyph?: string
  /** The footer the harness's select draws; matched in the last lines only. */
  footer?: RegExp
}

/** The footer of a select is among the last few lines of content, never in the scrollback. */
const FOOTER_TAIL_LINES = 4

const escapeRe = (c: string) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * A sibling row: its text STARTS at the cursor's label column, exactly.
 *
 * Both halves are load-bearing. Nothing before the column (or the row belongs to some other block),
 * and a non-space AT it — testing only that the prefix is blank accepts a row indented further,
 * which is how an unrelated paragraph two columns to the right joined the menu.
 */
const siblingAt = (line: string, col: number): string | null => {
  if (line.length <= col) return null
  if (line.slice(0, col).trim() !== '') return null
  if (line[col] === ' ') return null
  return line.slice(col).trimEnd()
}

/**
 * The GROUPED shape around the cursor — PURE. `null` when the block is not grouped (no blank line
 * followed by another row at the option column), `'refuse'` when it is grouped and cannot be read
 * with confidence, else the option rows (each group's first row) in order.
 */
function readGroups(
  frame: readonly string[], at: number, col: number, footerAt: number, MARK: RegExp,
): { i: number; label: string }[] | null | 'refuse' {
  const atCol = (i: number): string | null => {
    const line = frame[i] ?? ''
    if (i === at) return MARK.exec(line)?.[2] ?? null
    if (MARK.test(line)) return null
    return siblingAt(line, col)
  }
  const end = footerAt >= 0 ? footerAt : frame.length
  // The region: rows at the column or blank, both ways from the cursor.
  let lo = at
  while (lo - 1 >= 0 && ((frame[lo - 1] ?? '').trim() === '' || atCol(lo - 1) !== null)) lo--
  let hi = at
  while (hi + 1 < end && ((frame[hi + 1] ?? '').trim() === '' || atCol(hi + 1) !== null)) hi++
  const groups: { i: number; label: string }[][] = []
  let cur: { i: number; label: string }[] = []
  for (let i = lo; i <= hi; i++) {
    const label = (frame[i] ?? '').trim() === '' ? null : atCol(i)
    if (label === null) { if (cur.length) groups.push(cur); cur = []; continue }
    cur.push({ i, label })
  }
  if (cur.length) groups.push(cur)
  if (groups.length < 2) return null
  // Grouped only when some group holds more than its option row; one-row groups are a plain list
  // split by blank lines, which the contiguous read already refuses to join.
  if (groups.every(g => g.length === 1)) return null
  // Every option carries the same shape (kimi: one row + one description). Groups of different
  // sizes are something else on the screen — a paragraph above a plain list — and the contiguous
  // read stands.
  if (groups.some(g => g.length !== groups[0]!.length)) return null
  const firsts = groups.map(g => g[0]!)
  if (!firsts.some(r => r.i === at)) return 'refuse'
  // A group longer than an option and two lines of description is not a menu group.
  if (groups.some(g => g.length > 3)) return 'refuse'
  return firsts
}

/**
 * A menu with NO numbers, read off the frame — PURE.
 *
 * Claude's trust prompt is the case, and it is the one dialog where being wrong costs the most: the
 * highlighted row is `No, exit`, so the bare confirm the caller used to fall back to answered every
 * one of them by quitting. Reported by a user who could only reach that row from the web and had to
 * open the terminal to say yes.
 *
 * The shape is a cursor row plus the rows CONTIGUOUS with it at the same indentation. That is a
 * weaker signal than `1..n`, so it is fenced accordingly: the `❯` glyph only, at most one of them,
 * a label on the cursor row (the composer's own `❯ ` is empty and must never read as a menu), at
 * least one sibling (one row is a statement — the codex `Press enter to continue` — and a caller
 * confirms those), and a blank line or a change of indentation ends the block.
 *
 * Provenance: the trust frame was captured from a live session on 2026-09-08; the numbered frames
 * and the idle composer in `dialog-marker.test.ts` were captured the same day from claude 2.1.x
 * driven under tmux, which is what pins that this scan leaves them alone.
 */
function readMarkerSelect(frame: readonly string[], opts: MarkerOpts = {}): DialogRead {
  let MARK = MARKER
  // In footer mode the FOOTER is the anchor: it says a select is open, and everything the harness
  // draws under it (agy pins its model line to the bottom row of the pane) is chrome, not a turn
  // that happened after the dialog.
  let footerAt = -1
  if (opts.glyph && opts.glyph !== '❯') {
    // A glyph that prose also uses is read only under a footer that says a select is open.
    if (!opts.footer) return { kind: 'none', options: [], select: null, top: -1 }
    let seen = 0
    for (let i = frame.length - 1; i >= 0 && seen < FOOTER_TAIL_LINES; i--) {
      if ((frame[i] ?? '').trim() === '') continue
      seen++
      if (opts.footer.test(frame[i]!)) { footerAt = i; break }
    }
    if (footerAt < 0) return { kind: 'none', options: [], select: null, top: -1 }
    MARK = new RegExp(`^(\\s*)${escapeRe(opts.glyph)} (\\S.*?)\\s*$`)
  }
  const cursors: number[] = []
  // Distance is counted from the last line with CONTENT, not from the bottom of the pane: a tall
  // pane under a short dialog (agy's trust prompt sits at the top of a 50-row pane, measured 41
  // rows above the pane's end) has nothing but blank rows below it, and those are not the
  // scrollback this bound exists to keep out.
  let last = footerAt >= 0 ? footerAt : frame.length - 1
  while (last > 0 && (frame[last] ?? '').trim() === '') last--
  for (let i = last; i >= 0; i--) {
    if (last - i > LAST_OPTION_LINES) break
    if (MARK.test(frame[i] ?? '')) cursors.push(i)
  }
  if (cursors.length === 0) return { kind: 'none', options: [], select: null, top: -1 }
  // Two highlighted rows is the same fact the numbered path refuses under this name: a frame this
  // parser does not understand, and guessing which cursor is the real one is how a menu gets
  // half-read and offered anyway.
  if (cursors.length > 1) return { kind: 'unreadable', reason: 'two-cursors', options: [], select: null, top: cursors[cursors.length - 1]! }

  const at = cursors[0]!
  const m = MARK.exec(frame[at] ?? '')!
  // The label's own column — the cursor glyph plus its space. A sibling is a row that starts its
  // text exactly there; anything else belongs to some other block.
  const col = m[1]!.length + 2
  const rows: { i: number; label: string }[] = [{ i: at, label: m[2]! }]

  for (let i = at - 1; i >= 0; i--) {
    const label = siblingAt(frame[i] ?? '', col)
    if (label === null || MARK.test(frame[i] ?? '')) break
    rows.unshift({ i, label })
  }
  for (let i = at + 1; i < frame.length; i++) {
    const label = siblingAt(frame[i] ?? '', col)
    if (label === null || MARK.test(frame[i] ?? '')) break
    rows.push({ i, label })
  }

  // One row is a statement, not a choice — and the caller may confirm it, which is exactly what
  // `none` grants and `unreadable` withholds.
  if (rows.length < 2) return { kind: 'none', options: [], select: null, top: at }

  // A blank line and then MORE rows at this column: the options are GROUPED with their own
  // description lines (kimi 0.41.0 / 2.1.1's trust prompt — `❯ Trust this folder` + its sentence,
  // blank, `Don't trust` + its sentence). The contiguous block is then an option plus its
  // description, so the groups are read instead: each group's FIRST row is the option, the rest is
  // its description, and the cursor must sit on a first row — otherwise it is refused.
  const grouped = readGroups(frame, at, col, footerAt, MARK)
  if (grouped === 'refuse') return { kind: 'unreadable', reason: 'grouped', options: [], select: null, top: rows[0]!.i }
  if (grouped) {
    return {
      kind: 'options', select: 'marker', top: grouped[0]!.i,
      options: grouped.map((r, n) => ({ number: n + 1, label: r.label, selected: r.i === at })),
    }
  }

  // Same staleness check the numbered path applies, and for the same reason: this marker menu is
  // the trust-prompt shape, which is exactly the kind of dialog that sits unscrolled on a short,
  // quiet session long after somebody already answered it. See `MAX_TRAILING_GAP`.
  const bottomRow = rows[rows.length - 1]!.i
  let contentEnd = footerAt >= 0 ? footerAt + 1 : frame.length
  while (contentEnd > bottomRow + 1 && (frame[contentEnd - 1] ?? '').trim() === '') contentEnd--
  if (contentEnd - 1 - bottomRow > MAX_TRAILING_GAP) {
    return { kind: 'none', options: [], select: null, top: -1 }
  }

  return {
    kind: 'options',
    select: 'marker',
    top: rows[0]!.i,
    // `number` is the POSITION, 1-based, so every caller can address an option the same way it
    // addresses a numbered one. `select: 'marker'` is what stops it being typed as a digit.
    options: rows.map((r, n) => ({ number: n + 1, label: r.label, selected: r.i === at })),
  }
}

/**
 * The options on screen, in order — EMPTY when they cannot be read with confidence.
 *
 * A thin reading of `readDialog`, kept because most callers only want the list. **A caller deciding
 * whether to send a confirm key must NOT use this** — `[]` conflates "no menu" with "unreadable
 * menu", and that conflation is what put a blind confirm button on a six-option dialog. Ask
 * `readDialog(...).kind === 'none'`.
 */
export function parseDialogOptions(
  frame: readonly string[],
  opts: { marker?: boolean } = {},
): DialogOption[] {
  return readDialog(frame, opts).options
}

/**
 * Does this dialog need a CHOICE rather than a confirmation? — PURE.
 *
 * The question the UI asks before deciding whether it may send a bare confirm key. `false` for a
 * dialog with no readable options, which is the codex-shaped `Press enter to continue` case: there
 * really is nothing to choose between.
 */
export function needsChoice(options: readonly DialogOption[]): boolean {
  return options.length > 1
}

/**
 * Did a form MOVE between two frames — PURE. The question line above the options or the options'
 * labels changed (another question, or the review step). A tick (only a box's state) and a caret
 * moving inside a typed field (the label growing, the field still open) are not a move — that is
 * how `Right` inside a field read as "moved to the next question" while the form stayed put.
 */
export function formMoved(before: readonly string[], after: readonly string[]): boolean {
  const a = readDialog(before)
  const b = readDialog(after)
  if (b.kind !== 'options') return a.kind === 'options'
  if (a.kind !== 'options') return true
  if (Boolean(a.form?.review) !== Boolean(b.form?.review)) return true
  if (a.form?.position?.at !== b.form?.position?.at) return true
  const head = (f: readonly string[], top: number): string => {
    for (let i = top - 1; i >= 0; i--) if ((f[i] ?? '').trim() !== '') return (f[i] ?? '').trim()
    return ''
  }
  if (head(before, a.top) !== head(after, b.top)) return true
  if (a.options.length !== b.options.length) return true
  // A label that only GREW or shrank at its end is the typed field taking keys, not another question.
  return a.options.some((o, i) => {
    const l = o.label, m = b.options[i]!.label
    return l !== m && !m.startsWith(l) && !l.startsWith(m)
  })
}
