/**
 * owner-intent.ts — PURE. FLUXO.CICLO-COMPLETO item 7 (owner 08/11 ~01:40Z: "deve ser corrigido com certeza"): what an owner
 * composer message IS before it may become a request (a pedido, and then a queue piece).
 *
 * Two false requests were measured on the live board:
 *  (a) HAND-OFF text. The "hand off to a new session" button types a fixed sentence into the leader with no header, and the
 *      successor's first prompt (`agentop session --handoff -p "…"`) is the PREDECESSOR's words. Both sat in the transcripts as
 *      plain user turns, so the composer path recorded the first as an owner request and every later hand-off RELAYED both as
 *      the owner's own messages (s-0ea631c94f / p-6c864908a6d1 replayed the previous hand-off's prompt). They now carry a
 *      header (`markHandoffRequest`, `markSuccessorPrompt`) that every owner-turn classifier already refuses, and the legacy
 *      unmarked texts are recognised by `isHandoffText`.
 *  (b) A plain QUESTION the leader answers in the same turn ("quando sai as coisas?", s-1d57ab4c2b) became a staged piece and a
 *      10-minute reminder. `classifyOwnerMessage` separates a question from a work request; a question is HELD by the host and
 *      recorded `answered` when the leader's reply lands (`owner-questions.ts`), and only an unanswered one becomes a request.
 *
 * The classifier is deliberately conservative toward WORK: any work verb ("corrige", "implementa", "fix", "add"…) keeps the
 * message a request even when it ends in "?" ("pode corrigir o login?" is a request). A question needs an interrogative shape.
 */

/** The header kind both hand-off texts travel under. */
export const HANDOFF_KIND = 'passagem'

const HEADED = /^\s*\[from (?:agentistics|session [^\s\]·]+|flow [a-z0-9-]+) · [^\]\r\n]+\]/

/** The hand-off REQUEST typed into a leader (the button, or any surface asking a leader to hand off) — never the owner's request. */
export function markHandoffRequest(text: string): string {
  return HEADED.test(text) ? text : `[from agentistics · ${HANDOFF_KIND}]\n${text}`
}

/** The successor's first prompt: the PREDECESSOR's words (`--handoff -p`), headed with its id so no relay replays it as the owner's. */
export function markSuccessorPrompt(text: string, predecessorId: string | undefined): string {
  if (!text.trim() || HEADED.test(text)) return text
  return `[from session ${predecessorId && /^[\w.:-]{1,80}$/.test(predecessorId) ? predecessorId : 'predecessor'} · ${HANDOFF_KIND}]\n${text}`
}

/** The fixed sentences the hand-off button typed before it carried a header (pt and en), recognised in old transcripts. */
const LEGACY_HANDOFF = /^\s*(?:Quero passar a liderança agora\.|Hand off leadership now\.)/

/** PURE. A hand-off text from before the header existed. */
export function isHandoffText(text: string): boolean {
  return LEGACY_HANDOFF.test(text)
}

/** Verbs that ask for WORK (pt stems + en). Any of them keeps the message a request. */
const WORK = /(?:^|[^\p{L}])(?:corrij\p{L}*|corrig\p{L}*|consert\p{L}*|arrum\p{L}*|implement\p{L}*|cri[ea]r?|crie[m]?|adicion\p{L}*|acrescent\p{L}*|coloqu\p{L}*|coloca[r]?|mud[ea]r?|mude[m]?|troqu\p{L}*|troca[r]?|remov\p{L}*|tir[ae]r?|delet\p{L}*|apag\p{L}*|ajust\p{L}*|refa[cçz]\p{L}*|fa[cç]a[m]?|fazer|ger[ae]r?|constru\p{L}*|mont[ae]r?|escrev\p{L}*|atualiz\p{L}*|integr[ae]r?|migr[ae]r?|publiqu\p{L}*|rode|rodar|testar|valid[ae]r?|revis[ae]r?|investigu\p{L}*|investigar|resolv[ae]r?|prepar[ae]r?|configur[ae]r?|instal[ae]r?|suba|subir|fix|fixes|implement|create|add|build|make|change|remove|delete|update|refactor|rewrite|write|investigate|resolve|prepare|configure|install)(?=$|[^\p{L}])/iu

/** An interrogative OPENING (pt and en). */
const ASKS = /^(?:e\s+)?(?:quando|quanto|quantos|quantas|qual|quais|quem|onde|como|por\s*que|porque|pq|o\s+que|oque|cad[eê]|ser[aá]|j[aá]|tem|t[aá]|est[aá]|ficou|saiu|sai|deu|vai|when|what|which|who|whom|where|why|how|is|are|was|were|did|does|has|have|will|any\s+news)(?=$|[^\p{L}])/iu

export type OwnerIntent = 'question' | 'request'

/**
 * PURE. A message is a QUESTION only when it asks (ends in "?" or opens like a question), is short (one paragraph, ≤ 280
 * characters), and names no work verb. Everything else is a work REQUEST — the existing path, unchanged.
 */
export function classifyOwnerMessage(text: string): OwnerIntent {
  const t = text.trim()
  if (!t || t.length > 280 || /\n\s*\n/.test(t)) return 'request'
  if (WORK.test(t)) return 'request'
  const asks = /\?\s*$/.test(t) || ASKS.test(t)
  return asks ? 'question' : 'request'
}
