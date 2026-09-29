/**
 * code-undo-text.ts — PURE: what `agentop code`'s `/undo` (and `agentop code undo`) print, in EN and
 * PT. The runtime answers in CODES and English sentences (`@agentistics/runtime`'s `session/undo.ts`
 * is language-free in the sense that matters: every refusal carries a `code`); this module is the one
 * place those codes become words a person reads here. A policy refusal is the exception — its
 * sentence is the policy's own (it names the rule that decided), passed through untouched.
 */
import type { SessionUndoResult, UndoReady, UndoRefusal } from '@agentistics/runtime'
import type { CliLang } from './cli-lang.ts'

const T = {
  en: {
    nothing: 'Nothing to undo: the agent has no file changes left to revert in this session.',
    scope: 'Undo covers only files the agent changed through its file tools; anything a shell command changed is not recorded and was not touched.',
    earlier: 'This change set is from an earlier turn, not the last one.',
    changed: (p: string) => `${p} changed after the agent wrote it (you or another process edited it) — it will be left as it is.`,
    unrecoverable: (p: string) => `${p} cannot be undone: its checkpoint could not be kept.`,
    op: { delete: 'remove', create: 'recreate', overwrite: 'restore' } as Record<UndoReady['op'], string>,
    willRevert: 'would revert',
    reverted: 'reverted',
    confirmRest: (n: number) => `Undo the other ${n} file(s)? [y/N] `,
    confirmSettle: 'Nothing here can be undone. Settle this change set so the next /undo reaches the one before it? [y/N] ',
    confirmEarlier: (n: number) => `Undo these ${n} file(s) from an earlier turn? [y/N] `,
    declined: 'Nothing was undone.',
    passYes: 'Nothing was undone — confirm on a terminal, or pass --yes.',
    done: (n: number) => `Undid ${n} file(s).`,
    kept: (n: number) => `${n} left as they are.`,
    failed: (n: number) => `${n} could not be written; run /undo again to retry them.`,
    denied: 'Undo refused:',
    refused: {
      'session-not-found': (id: string) => `No such session: ${id}.`,
      'run-in-progress': () => 'A run of this session is still in progress; cancel it or wait for it to end before undoing.',
      'no-checkpoint': () => 'This session keeps no durable edit checkpoint, so there is nothing it can undo.',
    },
  },
  pt: {
    nothing: 'Nada a desfazer: o agente não tem mais alterações de arquivo para reverter nesta sessão.',
    scope: 'O desfazer cobre só arquivos que o agente alterou pelas ferramentas de arquivo; o que um comando de shell alterou não é registrado e não foi tocado.',
    earlier: 'Este conjunto de alterações é de um turno anterior, não do último.',
    changed: (p: string) => `${p} mudou depois que o agente o escreveu (você ou outro processo o editou) — ele será deixado como está.`,
    unrecoverable: (p: string) => `${p} não pode ser desfeito: o checkpoint dele não pôde ser guardado.`,
    op: { delete: 'remover', create: 'recriar', overwrite: 'restaurar' } as Record<UndoReady['op'], string>,
    willRevert: 'reverteria',
    reverted: 'revertido',
    confirmRest: (n: number) => `Desfazer os outros ${n} arquivo(s)? [s/N] `,
    confirmSettle: 'Nada aqui pode ser desfeito. Encerrar este conjunto para que o próximo /undo alcance o anterior? [s/N] ',
    confirmEarlier: (n: number) => `Desfazer estes ${n} arquivo(s) de um turno anterior? [s/N] `,
    declined: 'Nada foi desfeito.',
    passYes: 'Nada foi desfeito — confirme num terminal, ou passe --yes.',
    done: (n: number) => `${n} arquivo(s) desfeito(s).`,
    kept: (n: number) => `${n} deixado(s) como está(ão).`,
    failed: (n: number) => `${n} não pôde(puderam) ser escrito(s); rode /undo de novo para tentar.`,
    denied: 'Desfazer recusado:',
    refused: {
      'session-not-found': (id: string) => `Sessão inexistente: ${id}.`,
      'run-in-progress': () => 'Uma execução desta sessão ainda está em andamento; cancele-a ou espere terminar antes de desfazer.',
      'no-checkpoint': () => 'Esta sessão não guarda checkpoint durável de edições, então não há o que desfazer.',
    },
  },
} as const

export function refusalLine(r: UndoRefusal, lang: CliLang): string {
  return r.code === 'changed' ? T[lang].changed(r.path) : T[lang].unrecoverable(r.path)
}

export interface UndoRender {
  lines: string[]
  /** Present exactly when the result waits on a person's yes: the question to put to them. */
  confirm?: string
  /** The exit code a one-shot command returns for this result. */
  code: number
}

/** PURE: a runtime undo result as lines to print, in `lang`. */
export function renderUndo(r: SessionUndoResult, lang: CliLang, sessionId: string): UndoRender {
  const t = T[lang]
  switch (r.status) {
    case 'nothing':
      return { lines: [t.nothing, t.scope], code: 0 }
    case 'refused':
      return { lines: [t.refused[r.reason](sessionId)], code: 1 }
    case 'denied':
      return { lines: [`${t.denied} ${r.sentence}`], code: 1 }
    case 'needs-confirmation': {
      const lines: string[] = []
      if (!r.lastTurn) lines.push(t.earlier)
      for (const x of r.refused) lines.push(refusalLine(x, lang))
      for (const x of r.ready) lines.push(`  ${t.willRevert}  ${x.path}  (${t.op[x.op]})`)
      const confirm = r.ready.length === 0
        ? t.confirmSettle
        : r.refused.length === 0 ? t.confirmEarlier(r.ready.length) : t.confirmRest(r.ready.length)
      return { lines, confirm, code: 1 }
    }
    case 'done': {
      const lines = r.restored.map(p => `  ${t.reverted}  ${p}`)
      for (const k of r.kept) lines.push(refusalLine(k, lang))
      const summary = [t.done(r.restored.length)]
      if (r.kept.length > 0) summary.push(t.kept(r.kept.length))
      if (r.failed.length > 0) summary.push(t.failed(r.failed.length))
      lines.push(summary.join(' '), t.scope)
      return { lines, code: r.failed.length > 0 ? 1 : 0 }
    }
  }
}

/** A `[y/N]` answer: only an explicit yes (`y`/`yes`/`s`/`sim`) counts — anything else declines. */
export function isYes(answer: string | null): boolean {
  if (answer === null) return false
  return /^(y|yes|s|sim)$/i.test(answer.trim())
}

export const UNDO_TEXT = T
