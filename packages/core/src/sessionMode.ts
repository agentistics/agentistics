/**
 * sessionMode.ts — PURE: the permission MODE of a session, in the four words the owner chose for every
 * harness (MODE.EVERYWHERE, 2026-10-09): ask before acting ("default"), accept edits, plan, and no
 * questions. The New session "Mode" field offers exactly these, and the composer's mode chip colours a
 * harness's own mode by the canonical one it means.
 *
 * A harness keeps its OWN words on screen (`SessionMode.label` — "Auto Edit", "plan mode", "YOLO"); the
 * canonical id is what makes those comparable across harnesses. A harness mode that means none of the four
 * (claude's classifier `auto`) has no canonical, and is shown as itself.
 *
 * `default` is "whatever the harness's own configuration says" when CHOSEN at spawn — nothing is passed —
 * which is why the field calls it "the harness's default" and the chip then shows what the harness reports.
 * Kept equal to `@agentistics/engine-api`'s `CanonicalMode` by `session-mode-mirror.test.ts` (server).
 */

export type CanonicalMode = 'default' | 'accept-edits' | 'plan' | 'no-questions'
export const CANONICAL_MODES: readonly CanonicalMode[] = ['default', 'accept-edits', 'plan', 'no-questions']

/** One mode a session is in, or can be set to. `id` is what the session takes back. */
export interface SessionMode {
  id: string
  label: string
  canonical?: CanonicalMode
}

export function isCanonicalMode(v: unknown): v is CanonicalMode {
  return typeof v === 'string' && (CANONICAL_MODES as readonly string[]).includes(v)
}

/** The words for each canonical mode, EN + PT: the field's option, its one-line hint. */
export const CANONICAL_MODE_TEXT: Record<CanonicalMode, { en: { label: string; hint: string }; pt: { label: string; hint: string } }> = {
  default: {
    en: { label: "Harness's default", hint: 'Whatever this harness is configured to do — usually it asks before acting.' },
    pt: { label: 'Padrão do harness', hint: 'O que a configuração deste harness disser — em geral ele pede antes de agir.' },
  },
  'accept-edits': {
    en: { label: 'Accept edits', hint: 'Edits files without asking; commands still ask.' },
    pt: { label: 'Aceitar edições', hint: 'Edita arquivos sem pedir; comandos ainda pedem.' },
  },
  plan: {
    en: { label: 'Plan', hint: 'Reads and plans only — changes nothing until you say so.' },
    pt: { label: 'Plano', hint: 'Só lê e planeja — não altera nada até você mandar.' },
  },
  'no-questions': {
    en: { label: 'No questions', hint: 'Runs everything without asking.' },
    pt: { label: 'Sem perguntas', hint: 'Executa tudo sem pedir.' },
  },
}

/**
 * The warning "no questions" carries wherever it can be chosen (the New session field AND the chip's
 * menu): the one mode where nothing stops a command before it runs.
 */
export const NO_QUESTIONS_WARNING = {
  en: 'The session will edit, delete and run commands WITHOUT asking you first. Use it only in a project where that is safe.',
  pt: 'A sessão vai editar, apagar e rodar comandos SEM pedir sua confirmação. Use só num projeto onde isso é seguro.',
} as const

/**
 * The canonical mode of a TERMINAL (TUI) mode id, as `mode-spec.ts` reads it off the footer. Only claude's
 * footer has been driven; its `auto` (the classifier mode) means none of the four.
 */
const TUI_CANONICAL: Readonly<Record<string, CanonicalMode>> = {
  manual: 'default',
  'accept-edits': 'accept-edits',
  plan: 'plan',
}
export function canonicalOfTuiMode(id: string): CanonicalMode | undefined {
  return TUI_CANONICAL[id]
}
