/**
 * handback-intent.ts — FLUXO.AVISOS 8: is a handback FINAL, or one slice of a longer piece?
 *
 * A worker that finishes "parte 2 de 5" sends a handback so the leader sees progress. The host used to move the subtask to
 * `in_review` on ANY handback and list it as delivered in the check-in, so the leader reviewed (and the flow tried to close)
 * work that was still going. The explicit way to say "intermediate" is `awaiting`; this PURE rule is the safety net for the
 * worker that forgot it: a progress marker in the text with no `awaiting` is read as intermediate — and the reply to the
 * worker says so, in words, so it can resend as final.
 *
 * It errs toward FINAL when the text also says it is: a wrongly-intermediate handback strands finished work in `in_progress`,
 * a wrongly-final one only makes the leader look early.
 */

/** "parte 2 de 5", "part 2 of 5", "etapa 3/6", "slice 2 of 4", "2 of 5 done". */
const PART_OF = /\b(?:parte|part|etapa|step|passo|fase|phase|slice|item|lote|batch)\s*#?\s*(\d+)\s*(?:de|of|\/)\s*(\d+)\b/i
/** A bare "N/M" where N < M and it is not a test/check count ("12/14 tests" is a result, "2/5" is progress). */
const BARE_FRACTION = /(?<![\w./-])(\d{1,3})\s*\/\s*(\d{1,3})(?![\w./-])(?!\s*(?:tests?|testes?|specs?|pass|passed|ok|green|verde|casos?|files?|arquivos?|checks?))/i
const MOVING_ON = /\b(?:seguindo (?:para|com|pra)|continuo com|continuando com|passo(?:u)? (?:para|pra) a próxima|próxima (?:parte|etapa|fatia)|moving (?:on )?to|moving on|next up|continuing with|on to (?:part|step|the next))\b/i
/** The sender says it is the end of the whole piece. */
const FINAL_SAYS = /\b(?:handback final|final handback|entrega final|tudo (?:pronto|feito|concluíd[oa])|all (?:parts|items|slices|steps) (?:are )?(?:done|complete)|concluí (?:tudo|todas)|nothing (?:else )?left|nada mais a fazer)\b/i

export interface HandbackVerdict {
  /** true = treat as one slice of a longer piece. */
  intermediate: boolean
  /** Why, for the reply to the worker; absent for a final one. */
  marker?: string
  /** `explicit` = the sender passed `awaiting`; `inferred` = a progress marker in the text. */
  source?: 'explicit' | 'inferred'
}

/** PURE. */
export function judgeHandback(body: string, awaiting?: string): HandbackVerdict {
  if (awaiting && awaiting.trim()) return { intermediate: true, source: 'explicit', marker: `awaiting: ${awaiting.trim()}` }
  const text = body.slice(0, 4000)
  if (FINAL_SAYS.test(text)) return { intermediate: false }
  const part = PART_OF.exec(text)
  if (part && Number(part[1]) < Number(part[2])) return { intermediate: true, source: 'inferred', marker: part[0].trim() }
  const frac = BARE_FRACTION.exec(text)
  if (frac && Number(frac[1]) < Number(frac[2]) && Number(frac[2]) <= 50) return { intermediate: true, source: 'inferred', marker: frac[0].trim() }
  const moving = MOVING_ON.exec(text)
  if (moving) return { intermediate: true, source: 'inferred', marker: moving[0].trim() }
  return { intermediate: false }
}

/** The sentence added to the reply when the host read a handback as intermediate without `awaiting`. */
export function intermediateNote(marker: string): string {
  return `Recorded as an INTERMEDIATE handback (the text says "${marker}", and no \`awaiting\` was given): your subtask stays in_progress and the leader's check-in does not list it as delivered. When the whole piece is final, send a handback without progress markers.`
}
