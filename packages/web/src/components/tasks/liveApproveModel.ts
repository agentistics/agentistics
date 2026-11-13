/** PURE: the words and the states of the Live card's human-gate answer (`LiveApprove.tsx`). */

export type ApproveState =
  | { kind: 'idle' }
  | { kind: 'sending'; decision: 'approve' | 'reject' }
  | { kind: 'proving'; decision: 'approve' | 'reject' }
  | { kind: 'done'; decision: 'approve' | 'reject' }
  | { kind: 'failed'; sentence: string }

const PHASE_WORD: Record<string, { pt: string; en: string }> = {
  executando: { pt: 'a execução', en: 'execution' },
  qa: { pt: 'o QA', en: 'QA' },
  ajuste: { pt: 'o ajuste', en: 'the adjustment' },
  revisao_lider: { pt: 'a revisão do líder', en: 'the leader review' },
  pr_merge: { pt: 'o PR e merge', en: 'PR and merge' },
  ci: { pt: 'a publicação (CI)', en: 'publishing (CI)' },
  publicado: { pt: 'a publicação', en: 'publishing' },
}

/** The question the owner is answering, in words. An unknown phase is named as it is, never hidden. */
export function approveSentence(phase: string, pt: boolean): string {
  const w = PHASE_WORD[phase]
  const name = w ? (pt ? w.pt : w.en) : phase
  return pt ? `Precisa da sua aprovação para entrar em ${name}.` : `Needs your approval to enter ${name}.`
}

/** What the card says while the vault is asked to confirm it is the owner (ENTREGA.GARANTIDA §2.3.1). */
export function provingSentence(pt: boolean): string {
  return pt ? 'Confirme que é você (senha ou biometria do cofre)…' : 'Confirm it is you (vault password or biometrics)…'
}
