/**
 * The product briefing installed into harnesses.
 *
 * This is deliberately the only source of the managed onboarding text.  The installer merely
 * chooses whether a harness gets Agent Skills directories or a managed instruction block.
 */
import { join } from 'node:path'
import { flowBriefing } from './briefing-flow'
import type { HarnessId } from '@agentistics/core'

export const BRIEFING_VERSION = 2
export const MANAGED_OPEN = '<!-- agentistics-managed-briefing: v'
export const MANAGED_CLOSE = '<!-- /agentistics-managed-briefing -->'
export const PLAN_LIMITS_TOOL = 'agentistics_plan_limits'

export type BriefingSkill = {
  name: string
  description: string
  body: string
}

const common = `
## Agentistics operating environment

Agentistics is the harness, the Agentask board, parent and child sessions, leader threads, the
vault (use \`vault://name\` references), Nay, and the QA/release workflow together. The board is the
durable record of work; sessions are its workers, not a replacement for it.

## Obligations

Describe each task and its done criteria. Break independent work into subtasks or groups, file every
session on the subtask it serves, and keep live statuses accurate. Comment at meaningful milestones.
Use \`in_progress → in_review → done\`: a handback is ready for review, never proof of acceptance.
Create a missing status, type, folder, or subtask when the board needs one; do not silently downgrade
the work to fit the current vocabulary. Never leave a running worker outside the board.

Keep secrets out of prompts and commits; never ask for, print, or confirm a secret value.
Ask the person in the conversation when a decision is needed. At a hand-off, write state, running sessions,
queue, and decisions to the durable hand-off file, then tell the successor to close the old leader
after taking over. When a leader receives a hand-off hint after 150k tokens or 35% of its window, do
that immediately; then once per +50k.
`

export const BRIEFING_PT = `
## Ambiente operacional do agentistics

Agentistics é o harness, o quadro Agentask, sessões mãe/filhas, threads de líderes, o cofre (use
referências \`vault://nome\`), Nay e o fluxo de QA/release juntos. O quadro é o registro durável do
trabalho; sessões são trabalhadoras, não substitutas do quadro.

## Obrigações

Descreva cada tarefa e o critério de pronto. Separe trabalho independente em subtarefas/grupos,
vincule cada sessão à subtarefa que ela atende e mantenha os status vivos. Comente nos marcos.
Use \`in_progress → in_review → done\` (em andamento → em revisão → concluído): handback significa
pronta para revisão, nunca aceite.
Crie status, tipo, pasta ou subtarefa que falte; não rebaixe o trabalho para caber no vocabulário.
Mantenha segredos fora dos prompts e commits; use referências \`vault://nome\` e nunca peça, imprima
ou confirme o valor de um segredo. Pergunte à pessoa na conversa quando uma decisão for necessária.
No hand-off, escreva estado, sessões ativas, fila e decisões no arquivo durável e diga ao sucessor
para fechar o líder antigo depois de assumir. Ao receber uma dica de hand-off após 150 mil tokens ou
35% da janela, faça isso imediatamente; depois, a cada 50 mil.
`

export const BRIEFING_SKILL_NAMES = [
  'agentistics-session-flow',
  'agentistics-board-agentask',
  'agentistics-sessions-hand-offs',
  'agentistics-vault',
  'agentistics-qa-releases',
] as const

export function briefingText(lang: 'en' | 'pt' = 'en', o: { planLimitsAvailable?: boolean } = {}): string {
  const text = lang === 'pt' ? BRIEFING_PT : common
  const limits = o.planLimitsAvailable
    ? lang === 'pt'
      ? '\nAntes de abrir sessões, leia agentistics_plan_limits e siga sua recomendação: mantenha em execução a quantidade de workers indicada por cadence.parallel; se paceStatus estiver under, puxe trabalho da fila. Só faça uma pausa quando a janela de 5 horas estiver em pelo menos 85% (pausa curta até a renovação); a cota semanal não é um freio, a menos que esteja em pelo menos 95%.\n'
      : '\nBefore opening sessions, read agentistics_plan_limits and follow its recommendation: keep cadence.parallel workers running; if paceStatus is under, pull work from the queue. Hold only when the 5-hour window is at least 85% (short pause until renewal); weekly quota is not a brake unless it is at least 95%.\n'
    : ''
  const installed = lang === 'pt' ? 'Habilidades gerenciadas instaladas' : 'Installed managed skills'
  return `${text.trim()}${limits}\n${installed}: ${BRIEFING_SKILL_NAMES.join(', ')}.`
}

const skills: readonly BriefingSkill[] = [
  {
    name: 'agentistics-session-flow',
    description: 'Use at the start of every session, in any project, to follow the numbered agentistics flow (role, task, progress, finish).',
    body: `# Session flow\n${flowBriefing()}`,
  },
  {
    name: 'agentistics-board-agentask',
    description: 'Use when planning, filing, updating, or delivering work on the Agentask board.',
    body: '# Agentask board\nCall the task and status/type listing tools before making assumptions. Claim work, file the current session, and put comments on the subtask where the work happens. A task is not done because a command passed: leave it in review until the owner validates it.',
  },
  {
    name: 'agentistics-sessions-hand-offs',
    description: 'Use when starting workers, coordinating parent and child sessions, or handing work over.',
    body: '# Sessions and hand-offs\nOpen other sessions only after explicit approval. Give each worker a complete prompt, task, subtask, done criteria, and files it must not touch. A worker reports with agentistics_session_message(kind=handback|block|question); the product moves a filed subtask to review on handback. A leader hand-off started from the CLI uses `agentop session <harness> --handoff` (from inside the old leader): the successor inherits folder, pin, title, check-in, role and away.',
  },
  {
    name: 'agentistics-vault',
    description: 'Use when a task needs credentials, provider keys, or other protected values.',
    body: '# Vault\nUse vault://name references and the vault tools. Never ask a person to paste a secret into chat, print a secret, put one in a prompt, or commit one. Request only the minimum secret and report the reference, not its value.',
  },
  {
    name: 'agentistics-qa-releases',
    description: 'Use when validating a delivery, preparing a release, or reviewing another harness output.',
    body: '# QA and releases\nQA is independent: use a different harness/model than the author. Test in agentop run --rm with throwaway HOME and ports, inspect desktop and 390px mobile when UI changes, and attach evidence to the task. A release is published only after QA and owner validation; do not mark work done automatically.',
  },
]

export function briefingSkills(o: { planLimitsAvailable?: boolean } = {}): readonly BriefingSkill[] {
  const limits = o.planLimitsAvailable
    ? '\nBefore opening sessions, read agentistics_plan_limits and follow its recommendation: use its harness/model, kind, and cadence.parallel. Keep that many workers running; if paceStatus is under, pull work forward. Hold only when the 5-hour window is at least 85% (short pause until renewal); weekly quota is not a brake unless it is at least 95%.\n'
    : ''
  return skills.map(skill => ({ ...skill, body: `${skill.body}${limits}` }))
}

export function skillMarkdown(skill: BriefingSkill, version = BRIEFING_VERSION): string {
  return `---\nname: ${skill.name}\ndescription: ${skill.description}\nmetadata:\n  agentistics-version: "${version}"\n---\n\n${MANAGED_OPEN}${version} ${skill.name} -->\n${skill.body.trim()}\n${MANAGED_CLOSE}\n`
}

export function managedBlock(skill: BriefingSkill, version = BRIEFING_VERSION): string {
  return `${MANAGED_OPEN}${version} ${skill.name} -->\n${skill.body.trim()}\n${MANAGED_CLOSE}`
}

export function replaceManagedBlock(file: string, block: string): string {
  const escaped = MANAGED_OPEN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const name = block.match(new RegExp(`${escaped}[^\\n]*?\\s([^ ]+)\\s*-->`))?.[1]
  const re = name
    ? new RegExp(`${escaped}[^\\n]*?\\s${name.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\s*-->[\\s\\S]*?${MANAGED_CLOSE}\\n?`, 'g')
    : new RegExp(`${escaped}[^\\n]*[\\s\\S]*?${MANAGED_CLOSE}\\n?`, 'g')
  const without = file.replace(re, '').replace(/\n{3,}/g, '\n\n').trimEnd()
  return without ? `${without}\n\n${block}\n` : `${block}\n`
}

export function removeManagedBlocks(file: string): string {
  const escaped = MANAGED_OPEN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return file.replace(new RegExp(`${escaped}[^\\n]*[\\s\\S]*?${MANAGED_CLOSE}\\n?`, 'g'), '').replace(/\n{3,}/g, '\n\n').trimEnd() + (file.trim() ? '\n' : '')
}

export type ManagedTarget = { harness: HarnessId; path: string; skills: boolean }

export function managedTargets(home: string): ManagedTarget[] {
  return [
    { harness: 'claude', path: join(home, '.claude', 'CLAUDE.md'), skills: true },
    { harness: 'codex', path: join(home, '.codex', 'AGENTS.md'), skills: false },
    { harness: 'gemini', path: join(home, '.gemini', 'GEMINI.md'), skills: false },
    { harness: 'copilot', path: join(home, '.copilot', 'copilot-instructions.md'), skills: false },
    { harness: 'antigravity', path: join(home, '.gemini', 'antigravity-cli', 'AGENTS.md'), skills: false },
    { harness: 'kimi', path: join(home, '.kimi-code', 'AGENTS.md'), skills: false },
  ]
}
