/**
 * chatForward.ts — PURE: forwarding messages from one session's conversation to others, and the
 * WhatsApp-style selection that feeds it.
 *
 * FORWARDING CARRIES CONTENT; MENTIONING (`sessionMention.ts`) ONLY POINTS. So what travels here is
 * the text itself, as a short quoted block that says where it came from and nothing else:
 *
 *     > forwarded from «Session title» (claude):
 *     > the first message
 *     >
 *     > the second message
 *
 * FEW TOKENS, ON PURPOSE. No timestamps, no ids, no roles by default — every one of those is spent
 * in the receiving session's window. The one exception is a selection that MIXES both sides of the
 * conversation: without a speaker the reader cannot tell a question from its answer, so then (and
 * only then) each message opens with `(you)` / `(<harness>)`.
 *
 * NOT CAPPED. A reply quote is capped because the replier did not choose the length (`replyQuote.ts`,
 * decision 1); a forward is something somebody PICKED, message by message, precisely to carry it
 * across. Capping it would send a different message from the one that was composed — the same rule
 * `quoteFor` applies to an excerpt.
 *
 * THE DEFAULT DESTINATION IS THE DRAFT. A forward is almost always context for an instruction the
 * person has not written yet, so it lands in the target's composer (`sessionScratch`) to be finished
 * there; sending straight away is the explicit alternative, for when the forward is the whole message.
 */

/** A turn as this module needs it. Structural — the chat view's `ChatTurn` satisfies it. */
export interface ForwardTurn {
  role: 'user' | 'assistant'
  text: string
  at?: string
}

/**
 * A stable identity for a turn inside ONE conversation's window, for the selection set.
 *
 * Not the index: the conversation is a capped WINDOW (`older`), and when the window slides the same
 * index names a different message — a selection kept by index would forward something the person
 * never ticked. The timestamp plus the role plus the head of the text survives that slide; two turns
 * agreeing on all three are indistinguishable to a reader too.
 */
export function turnKey(t: ForwardTurn): string {
  return `${t.at ?? ''}|${t.role}|${t.text.length}|${t.text.slice(0, 80)}`
}

/** Flip one turn in or out of the selection. */
export function toggleTurn(selected: ReadonlySet<string>, t: ForwardTurn): Set<string> {
  const next = new Set(selected)
  const k = turnKey(t)
  if (next.has(k)) next.delete(k)
  else next.add(k)
  return next
}

/**
 * The selected turns IN CONVERSATION ORDER, whatever order they were ticked in.
 *
 * A forward is read top to bottom by the receiving session; the order somebody happened to click
 * in is not the order the conversation happened in. A key no turn on screen carries any more (the
 * window slid past it) drops out silently — there is nothing left to forward for it.
 */
export function selectedTurns<T extends ForwardTurn>(turns: readonly T[], selected: ReadonlySet<string>): T[] {
  const seen = new Set<string>()
  return turns.filter(t => {
    const k = turnKey(t)
    if (!selected.has(k) || seen.has(k)) return false
    seen.add(k)
    return true
  })
}

/** Whether a turn can be forwarded, selected or copied at all — it has to say something. */
export function forwardable(t: ForwardTurn): boolean {
  return t.text.trim() !== ''
}

export interface ForwardSource {
  /** The session the messages come FROM, by the name the fleet shows. */
  title: string
  /** Its harness label, as the rest of the product calls it (`Claude Code`, `Codex`…). */
  harness: string
}

function quote(text: string): string {
  return text.trim().split('\n').map(l => (l === '' ? '>' : `> ${l}`)).join('\n')
}

/** The origin line, alone — also what the modal previews above the block. */
export function forwardHeader(from: ForwardSource, pt: boolean): string {
  const title = from.title.replace(/[«»]/g, '').replace(/\s+/g, ' ').trim() || (pt ? 'sem título' : 'untitled')
  const harness = from.harness.trim()
  return pt
    ? `> encaminhado de «${title}»${harness ? ` (${harness})` : ''}:`
    : `> forwarded from «${title}»${harness ? ` (${harness})` : ''}:`
}

/**
 * The quoted block for these turns. Empty when nothing forwardable was given — a caller must not
 * deliver an origin line with nothing under it.
 */
export function forwardBlock(from: ForwardSource, turns: readonly ForwardTurn[], pt: boolean): string {
  const usable = turns.filter(forwardable)
  if (usable.length === 0) return ''
  const mixed = new Set(usable.map(t => t.role)).size > 1
  const body = usable.map(t => {
    const q = quote(t.text)
    if (!mixed) return q
    const who = t.role === 'user' ? (pt ? '(você)' : '(you)') : `(${from.harness.trim() || (pt ? 'assistente' : 'assistant')})`
    return `> ${who}\n${q}`
  }).join('\n>\n')
  return `${forwardHeader(from, pt)}\n${body}`
}

/**
 * What is delivered: the optional comment ABOVE the block, a blank line between them.
 *
 * The comment leads because it is the instruction and the block is the material it is about — the
 * order a person reads a forwarded mail in. A blank line and not a newline: a line directly under a
 * `>` block is folded into the quote by every markdown reader, the assistant's included.
 */
export function composeForward(o: {
  from: ForwardSource
  turns: readonly ForwardTurn[]
  comment?: string
  pt: boolean
}): string {
  const block = forwardBlock(o.from, o.turns, o.pt)
  if (block === '') return ''
  const comment = (o.comment ?? '').trim()
  return comment === '' ? block : `${comment}\n\n${block}`
}

/**
 * Put a forward into a draft that may already hold words.
 *
 * APPENDED, never replacing: the draft is the one thing in this product that exists nowhere else
 * (`sessionScratch.ts`), and a forward that overwrote a half-written instruction would destroy it.
 * A trailing blank line is left so the caret lands where the instruction goes.
 */
export function appendToDraft(existing: string, text: string): string {
  const head = existing.replace(/\s+$/, '')
  const body = text.trim()
  if (body === '') return existing
  return head === '' ? `${body}\n\n` : `${head}\n\n${body}\n\n`
}

/** The text COPY puts on the clipboard for a selection: the messages, a blank line apart. */
export function copyTurnsText(turns: readonly ForwardTurn[]): string {
  return turns.filter(forwardable).map(t => t.text.trim()).join('\n\n')
}

/** The selection bar's count, in words. */
export function selectionCountLabel(n: number, pt: boolean): string {
  if (pt) return n === 1 ? '1 selecionada' : `${n} selecionadas`
  return n === 1 ? '1 selected' : `${n} selected`
}

/**
 * The forward modal's primary button, by delivery mode — with the COUNT in it, always, for the
 * reason `pickConfirmLabel` gives: this writes into other sessions, and the number is what a person
 * checks before pressing.
 */
export function forwardConfirmLabel(
  count: number, direct: boolean, pt: boolean,
): { label: string; enabled: boolean } {
  if (count === 0) return { enabled: false, label: pt ? 'Nenhuma escolhida' : 'None picked' }
  const one = count === 1
  if (direct) {
    return {
      enabled: true,
      label: pt
        ? (one ? 'Enviar para 1 sessão' : `Enviar para ${count} sessões`)
        : (one ? 'Send to 1 session' : `Send to ${count} sessions`),
    }
  }
  return {
    enabled: true,
    label: pt
      ? (one ? 'Pôr no rascunho de 1 sessão' : `Pôr no rascunho de ${count} sessões`)
      : (one ? 'Put in 1 session’s draft' : `Put in ${count} sessions’ drafts`),
  }
}

/**
 * What happened, for the notice after a DRAFT delivery. Said with the names when there are few, so
 * the person knows where to go to finish the instruction.
 */
export function draftedNotice(titles: readonly string[], pt: boolean): string {
  if (titles.length === 0) return ''
  if (titles.length === 1) {
    return pt
      ? `Encaminhado para o rascunho de «${titles[0]}». Complete a instrução lá e envie.`
      : `Forwarded into «${titles[0]}»’s draft. Finish the instruction there and send it.`
  }
  const shown = titles.slice(0, 3).map(t => `«${t}»`).join(', ')
  const more = titles.length > 3 ? (pt ? ` e mais ${titles.length - 3}` : ` and ${titles.length - 3} more`) : ''
  return pt
    ? `Encaminhado para o rascunho de ${titles.length} sessões: ${shown}${more}.`
    : `Forwarded into ${titles.length} sessions’ drafts: ${shown}${more}.`
}
