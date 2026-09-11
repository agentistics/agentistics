/**
 * shellCeiling.ts — PURE. What the band shows when the shell ceiling refuses an open.
 *
 * `SHELL_CAP` is 8 and the refusal has always been a SENTENCE — "Já há 8 terminais abertos. Feche
 * um para abrir outro." It is a correct sentence and it was a DEAD END: nothing in this product
 * listed or closed a shell. The only close was the trash can on a band you already had open, so if
 * the eight were spread across eight other sessions, you were told to close one with no way to find
 * them. That is the one refusal in this feature a person can actually act on, and it was the one
 * with no action.
 *
 * The ceiling itself is deliberately a CEILING and not a timer (`shell-spec.ts` records why: a TTL
 * kills the `bun test` that finished at minute 61). So the answer is not to raise it — it is to
 * make the moment it fires the moment you can do something.
 *
 * **THE DIRECTORY IS NOT ENOUGH TO TELL THEM APART.** Measured on the machine this was written for:
 * all three open shells sat in `/home/mithrandir/agentistics`, because that is what a per-session
 * shell in a repository looks like. A picker whose rows all read the same is not a picker, so the
 * SESSION's own name leads, the directory is beside it, and the HANDLE — the eight characters
 * `agentop session attach` resolves — is always drawn, so two rows that still read alike are told
 * apart by something.
 */

import { shellWhere } from './shellBand'

/** One open shell as the list receives it. `sessionTitle` is what `?titles=1` adds. */
export interface CeilingShell {
  id: string
  sessionId?: string
  cwd?: string
  createdMs?: number
  sessionTitle?: string
}

export interface CeilingRow {
  id: string
  /** What the row is CALLED: the session's own name, or where the shell is when nobody could name it. */
  title: string
  /** The trimmed directory, in the same form the band's own title row uses. */
  where: string
  /** The handle, so two rows that read alike are still distinguishable. */
  short: string
}

/** Only the FULL refusal opens the list. The other three are impossible rather than full — there is
 *  no tmux, the row records no directory, the directory is gone — and offering to close somebody
 *  else's shell would not help any of them. */
export function atCap(reason: string | null | undefined): boolean {
  return reason === 'at-cap'
}

/**
 * The rows, OLDEST FIRST — the one a person is most likely finished with, and the only ordering
 * that does not change under them while they read it.
 */
export function ceilingRows(shells: readonly CeilingShell[]): CeilingRow[] {
  return [...shells]
    .sort((a, b) => (a.createdMs ?? 0) - (b.createdMs ?? 0))
    .map(s => {
      const where = shellWhere(s.cwd)
      return {
        id: s.id,
        // A blank row is not a closable row: with no name, WHERE it is has to serve as the name.
        title: s.sessionTitle?.trim() || where || s.id.slice(0, 8),
        where,
        short: s.id.slice(0, 8),
      }
    })
}

/** The sentence over the list. It names the ceiling, because "close one" without "of eight" reads
 *  as an arbitrary refusal. */
export function ceilingTitle(cap: number, lang: 'pt' | 'en'): string {
  return lang === 'pt'
    ? `Os ${cap} terminais possíveis estão abertos. Encerre um para abrir este.`
    : `All ${cap} terminals are open. End one to open this.`
}
