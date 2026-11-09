/**
 * liveCardModel — PURE. Every sentence and every decision the Live card (option A) draws:
 * the state word, what a waiting card is waiting for, the stage bar, the time row, the two
 * estimate boxes, the Bloqueado line, which tasks are "recent", which columns start collapsed,
 * when a column offers its search, and which cards just left the board and why.
 *
 * Nothing here reads the clock or a store: `nowMs` and the fleet come in, so each rule has a test.
 */

import { parseLivePeriod, parseLiveSort, parseLiveTab, type LivePeriod, type LiveSortId, type LiveTab } from '@agentistics/core'
import { startsLine } from './queueTime'
import type { FleetRow } from '../../lib/fleet'
import {
  fmtClock, fmtSpan, isQueued, STAGE_LABEL, LIVE_STAGES, LIVE_DEFAULTS, type HiddenReason, type LiveBlock, type LiveCard, type LiveDeliveryRecord,
  type LiveHidden, type LiveStage, type StageVisit, type WorkerWord,
} from './liveDeliveryModel'

type Pt = boolean

// ------------------------------------------------------------------------------------ state

const WORKER_WORD: Record<WorkerWord, { pt: string; en: string }> = {
  working: { pt: 'trabalhando', en: 'working' },
  'needs-you': { pt: 'precisa de você', en: 'needs you' },
  blocked: { pt: 'bloqueado', en: 'blocked' },
  delivered: { pt: 'entregou', en: 'delivered' },
  'awaiting-review': { pt: 'aguardando revisão', en: 'awaiting review' },
  idle: { pt: 'ocioso', en: 'idle' },
}
export const workerWordText = (w: WorkerWord, pt: Pt): string => WORKER_WORD[w][pt ? 'pt' : 'en']

/** A worker's state in its own words (mirror of the server's `workerWord`, for rows the fleet carries). */
export function workerWordOf(state: string, stage: LiveStage | null | undefined): WorkerWord {
  if (state === 'waiting-approval') return 'needs-you'
  if (stage === 'blocked') return 'blocked'
  if (state === 'working') return 'working'
  if (stage === 'leader') return 'awaiting-review'
  if (stage === 'qa' || stage === 'merge' || stage === 'published') return 'delivered'
  return 'idle'
}

/** The state word of a card. `waiting` is NEVER "esperando você" — only a dialog on a person is. */
export function cardStateWord(c: LiveCard, pt: Pt): string {
  if (isQueued(c)) return pt ? 'na fila' : 'queued'
  switch (c.liveState) {
    case 'working': return workerWordText('working', pt)
    case 'needs-you': return workerWordText('needs-you', pt)
    case 'waiting': return workerWordText(workerWordOf('waiting', c.d.stage), pt)
    case 'down': return pt ? 'parado' : 'stopped'
    default: return pt ? 'sem agente vivo' : 'no live agent'
  }
}

/** The first line of a dialog on screen, as the question a person is being asked. */
function questionOf(row: FleetRow | undefined): string | null {
  const line = (row?.approvalLines ?? []).map(l => l.trim()).filter(l => l.length > 6 && !/^[❯>]?\s*\d+[.)]/.test(l))[0]
  return line ? (line.length > 80 ? `${line.slice(0, 79)}…` : line) : null
}

/**
 * What a WAITING card is waiting for, in one short line — read from signals the product already has
 * (the dialog on screen, the stage, the queue, the piece's stated block, its last event). When
 * nothing is known it says so; it never guesses a reason.
 */
export function waitingReason(c: LiveCard, fleet: readonly FleetRow[], pt: Pt): string | null {
  if (isQueued(c)) {
    // The card already says WHY it is not starting when the leader decided (não / agendar / the open question) or when the
    // slot gate says a slot is free: a generic "waiting for a machine slot" beside either would contradict it.
    if (c.d.queue || c.d.slot?.ok === true) return null
    return pt ? 'esperando vaga na máquina' : 'waiting for a machine slot'
  }
  // A blocked card says WHY in its own block (reason, who lifts it) — a second line would contradict it.
  if (c.d.stage === 'blocked') return null
  if (c.liveState === 'needs-you') {
    const row = fleet.find(r => r.id === c.agents.find(a => a.state === 'waiting-approval')?.id)
    const q = questionOf(row)
    return pt ? `esperando resposta sua${q ? ` (pergunta: ${q})` : ''}` : `waiting for your answer${q ? ` (question: ${q})` : ''}`
  }
  if (c.liveState !== 'waiting') return null
  switch (c.d.stage) {
    case 'leader': return pt ? 'esperando revisão do líder' : 'waiting for the leader\'s review'
    case 'qa': return pt ? 'esperando a QA' : 'waiting for QA'
    case 'merge': return pt ? 'esperando o CI / merge' : 'waiting for CI / merge'
    case 'ci': return pt ? 'esperando o sinal do release' : 'waiting for the release signal'
    case 'adjust': return pt ? 'esperando o ajuste' : 'waiting for the fix'
    default: break
  }
  if (c.d.blockedReason) return pt ? `esperando: ${c.d.blockedReason}` : `waiting: ${c.d.blockedReason}`
  if (c.d.lastAction?.kind === 'handback') return pt ? 'entregou, esperando o líder' : 'handed back, waiting for the leader'
  return pt ? 'esperando (sem motivo conhecido)' : 'waiting (no known reason)'
}

// ------------------------------------------------------------------------------------ stage bar

/** The seven marks of the way a piece travels. `adjust` sits on QA's mark (it is QA sending it back). */
export const BAR_STAGES: readonly LiveStage[] = ['queue', 'running', 'qa', 'leader', 'merge', 'ci', 'published']

export interface BarSegment { stage: LiveStage; state: 'done' | 'cur' | 'todo'; color: string }

/** PURE: the 6-segment bar. The active segment wears the COLOUR OF THE COLUMN the card is in; done ones are grey. */
export function stageBar(stage: LiveStage, origin: LiveStage | null | undefined): BarSegment[] {
  const at = stage === 'adjust' ? 'qa' : stage === 'blocked' ? (origin && origin !== 'blocked' ? (origin === 'adjust' ? 'qa' : origin) : 'queue') : stage
  const i = BAR_STAGES.indexOf(at)
  return BAR_STAGES.map((s, k) => ({
    stage: s,
    state: k < i ? 'done' as const : k === i ? 'cur' as const : 'todo' as const,
    color: k === i ? STAGE_LABEL[stage].color : k < i ? '#4b5563' : '#2a2f3c',
  }))
}

// ------------------------------------------------------------------------------------ per-stage percent

/**
 * The fixed, known steps inside each stage. A piece REPORTS which step it is on (a `step` event from the
 * delivery flow); the words are ours, so a step number the flow states is always read the same way.
 */
export const STAGE_STEPS: Partial<Record<LiveStage, { pt: readonly string[]; en: readonly string[] }>> = {
  running: {
    pt: ['lendo o pedido', 'implementando', 'rodando os testes', 'salvando (commit)', 'entregando'],
    en: ['reading the request', 'implementing', 'running the tests', 'saving (commit)', 'handing over'],
  },
  qa: {
    pt: ['preparando o ambiente', 'testes automáticos', 'passada no navegador e Mac', 'relatório'],
    en: ['preparing the environment', 'automatic tests', 'browser and Mac pass', 'report'],
  },
  adjust: {
    pt: ['corrigindo', 'testes', 'salvando (commit)', 'devolvendo ao QA'],
    en: ['fixing', 'tests', 'saving (commit)', 'handing back to QA'],
  },
  leader: {
    pt: ['lendo as mudanças', 'conferindo o que foi apagado', 'decidindo'],
    en: ['reading the changes', 'checking what was deleted', 'deciding'],
  },
  merge: { pt: ['abrindo o PR', 'checagens do PR', 'merge'], en: ['opening the PR', 'PR checks', 'merge'] },
  ci: { pt: ['merge no main', 'publicação rodando', 'versão publicada'], en: ['merge on main', 'publication running', 'version published'] },
}

export interface StagePercent { pct: number; step: number; of: number; label: string }

/**
 * PURE: "<pct>% desta etapa · passo k de n: <step>". pct = (k-1)/n — a step you are ON is not done —
 * and 100 once the last step is reported done. A stage with no fixed steps, or a piece that reported
 * none, answers null: the line is hidden, never filled with a guess.
 */
export function stagePercent(stage: LiveStage, step: number | null | undefined, pt: Pt, done = false): StagePercent | null {
  const steps = STAGE_STEPS[stage]?.[pt ? 'pt' : 'en']
  if (!steps || step === null || step === undefined || !Number.isFinite(step) || step < 1) return null
  const k = Math.min(Math.floor(step), steps.length)
  return { pct: done ? 100 : Math.round((100 * (k - 1)) / steps.length), step: k, of: steps.length, label: done ? (pt ? 'pronto' : 'done') : steps[k - 1]! }
}

/** PURE: the percent line of a card — from the CI signal in CI, from the reported step elsewhere; null = hide. */
export function cardPercent(d: Pick<LiveDeliveryRecord, 'stage' | 'ci' | 'step'>, pt: Pt): StagePercent | null {
  if (d.stage === 'ci') {
    if (!d.ci) return null
    const step = !d.ci.mergedMain ? 1 : !d.ci.releaseGreen ? 2 : 3
    return stagePercent('ci', step, pt, d.ci.tagPublished)
  }
  return stagePercent(d.stage, d.step, pt)
}

const SIGNAL_WORD: Record<string, { pt: string; en: string }> = {
  session: { pt: 'a sessão está aberta', en: 'the session is open' },
  edit: { pt: 'a sessão editou arquivos', en: 'the session edited files' },
  tests: { pt: 'a sessão rodou testes', en: 'the session ran tests' },
  commit: { pt: 'houve um commit no ramo da peça', en: 'there is a commit on the piece\'s branch' },
  handback: { pt: 'a sessão entregou (handback)', en: 'the session handed back' },
  browser: { pt: 'a QA abriu o navegador', en: 'QA drove a browser' },
  verdict: { pt: 'o veredito da QA foi registrado', en: 'the QA verdict is recorded' },
  'deletions-gate': { pt: 'o portão de apagados rodou', en: 'the deletions gate ran' },
  review: { pt: 'a decisão do líder foi registrada', en: 'the leader\'s decision is recorded' },
  pr: { pt: 'o PR existe', en: 'the PR exists' },
  merged: { pt: 'o PR foi mergeado', en: 'the PR is merged' },
  stage: { pt: 'a peça entrou nesta etapa', en: 'the piece entered this stage' },
}

/** PURE: where the shown step comes from, in words — "relatado pelo worker" or the observed fact. Null = nothing to say. */
export function stepSourceNote(d: Pick<LiveDeliveryRecord, 'stepSource' | 'stepSignal'>, pt: Pt): string | null {
  if (d.stepSource === 'reported') return pt ? 'passo relatado pelo worker ou pelo fluxo' : 'step reported by the worker or the flow'
  if (d.stepSource === 'signals') {
    const w = d.stepSignal ? SIGNAL_WORD[d.stepSignal]?.[pt ? 'pt' : 'en'] : undefined
    return pt ? `passo lido de fatos observados${w ? `: ${w}` : ''}` : `step read from observed facts${w ? `: ${w}` : ''}`
  }
  return null
}

export interface CiLine { key: 'merge' | 'release' | 'tag'; done: boolean; text: string }

/** PURE: the three-line signal checklist of a piece in CI · publicando. */
export function ciChecklist(ci: { mergedMain: boolean; releaseGreen: boolean; tagPublished: boolean; tag: string | null }, pt: Pt): CiLine[] {
  return [
    { key: 'merge', done: ci.mergedMain, text: pt ? 'merge no main' : 'merge on main' },
    { key: 'release', done: ci.releaseGreen, text: pt ? 'release.yml terminou verde' : 'release.yml finished green' },
    { key: 'tag', done: ci.tagPublished, text: ci.tag ? (pt ? `tag ${ci.tag} publicada` : `tag ${ci.tag} published`) : (pt ? 'tag publicada' : 'tag published') },
  ]
}

// ------------------------------------------------------------------------------------ leaders pill

export interface LeaderCounts { working: number; waiting: number; blocked: number; workers: number }

/**
 * PURE: the three dot counters of the Líderes pill, from the REAL worker list — one count per distinct
 * worker (a worker listed under two leaders is one worker). The old strip counted per leader and said
 * "3 active" with two.
 */
export function leaderCounts(leaders: readonly { workers: readonly { id: string; state: string; word?: WorkerWord; stage?: LiveStage | null }[] }[]): LeaderCounts {
  const seen = new Map<string, WorkerWord>()
  for (const l of leaders) for (const w of l.workers) if (!seen.has(w.id)) seen.set(w.id, w.word ?? workerWordOf(w.state, w.stage))
  let working = 0, blocked = 0
  for (const word of seen.values()) { if (word === 'working') working++; else if (word === 'blocked') blocked++ }
  return { working, blocked, waiting: seen.size - working - blocked, workers: seen.size }
}

export type LocateAnswer = { kind: 'card'; key: string; stage: LiveStage } | { kind: 'filtered' } | { kind: 'none' }

/** PURE: where a worker row leads — to its card, to "filtered out by your filters", or nowhere. */
export function locateWorker(w: { cardKey?: string | null }, shown: readonly LiveCard[], all: readonly LiveCard[]): LocateAnswer {
  if (!w.cardKey) return { kind: 'none' }
  const hit = shown.find(c => c.d.key === w.cardKey)
  if (hit) return { kind: 'card', key: hit.d.key, stage: hit.d.stage }
  return all.some(c => c.d.key === w.cardKey) ? { kind: 'filtered' } : { kind: 'none' }
}

// ------------------------------------------------------------------------------------ time row

const stageName = (s: LiveStage, pt: Pt) => STAGE_LABEL[s][pt ? 'pt' : 'en'].toLowerCase()

export interface TimeRow {
  /** Round time beside a percent; otherwise the existing stage/publication clock. */
  inStage: string
  /** "total 52 min" — this card's real work, never the task's age. */
  total: string
  /** "(2ª etapa)" — how many stages it has passed through, when the log says. */
  stageNo: string | null
  title: string
}

export function timeRow(c: LiveCard, nowMs: number, pt: Pt): TimeRow {
  const d = c.d
  const done = d.stage === 'published'
  const inStageMs = d.stageSinceMs === null ? null : nowMs - d.stageSinceMs
  const percent = cardPercent(d, pt) !== null
  const roundMs = d.round?.startedAtMs == null ? null : Math.max(0, nowMs - d.round.startedAtMs)
  const workMs = d.workMs !== undefined ? d.workMs : (d.startedAtMs === null ? null : nowMs - d.startedAtMs)
  const trail = d.trail ?? []
  const n = trail.length
  const ord = (k: number) => pt ? `${k}ª` : `${k}${k === 1 ? 'st' : k === 2 ? 'nd' : k === 3 ? 'rd' : 'th'}`
  const lines = trail.map(v => `${stageName(v.stage, pt)} ${fmtSpan(v.ms)}`)
  return {
    // A published card is not "in a stage" any more: it says when it was published, and what it cost in work.
    inStage: done
      ? `${pt ? 'publicado' : 'published'} ${d.deliveredAtMs ? fmtClock(d.deliveredAtMs) : '—'}`
      : percent
        ? `${d.round && d.round.number > 1 ? `${pt ? 'rodada' : 'round'} ${d.round.number} · ` : ''}${pt ? 'tempo da rodada' : 'time in this round'} ${fmtSpan(roundMs)}`
        : `${pt ? 'tempo nessa etapa' : 'time in this stage'} ${fmtSpan(inStageMs)}`,
    total: `total ${fmtSpan(workMs)}`,
    stageNo: n > 0 ? (pt ? `${ord(n)} etapa` : `${ord(n)} stage`) : null,
    title: [
      percent
        ? (pt ? '“Tempo da rodada”: desde o início observado da rodada atual, a mesma rodada do percentual.' : '“Time in this round”: since the observed start of the current round, the same round as the percent.')
        : (pt ? '“Tempo nessa etapa”: tempo desde a última mudança de status registrada; pode abranger outras rodadas.' : '“Time in this stage”: time since the last recorded status change; it may span other rounds.'),
      ...(percent ? [pt ? `Desde a última mudança de status (pode incluir outras rodadas): ${fmtSpan(inStageMs)}.` : `Since the last status change (may include other rounds): ${fmtSpan(inStageMs)}.`] : []),
      pt ? '“Total”: tempo de trabalho real das sessões deste cartão — não a idade da tarefa.' : '“Total”: the real work time of this card\'s sessions — not the task\'s age.',
      ...(lines.length ? [pt ? `Etapas por onde passou: ${lines.join(' → ')}` : `Stages it went through: ${lines.join(' → ')}`] : []),
    ].join('\n'),
  }
}

// ------------------------------------------------------------------------------------ the two estimates

export interface EtaBox { label: string; value: string; tone: 'ok' | 'none' | 'late'; title: string }

/** PURE: [próxima etapa, publicação]. "sem estimativa" is a legitimate answer; an invented time is not. */
export function etaBoxes(d: LiveDeliveryRecord, pt: Pt): [EtaBox, EtaBox] | null {
  if (d.stage === 'published') return null
  const stageEta = d.stageEta, pub = d.publishEta
  const nextWord = (stageEta && stageEta.kind === 'estimate' && stageEta.nextStage) ? ` (${stageName(stageEta.nextStage, pt)})` : ''
  const none = pt ? 'sem estimativa' : 'no estimate'
  let first: EtaBox
  if (stageEta?.kind === 'estimate') {
    first = {
      label: `${pt ? 'próxima etapa' : 'next stage'}${nextWord}`, value: `~${fmtClock(stageEta.atMs)}`, tone: 'ok',
      title: pt ? `Mediana de ${stageEta.n} passagens por “${stageName(d.stage, pt)}”: ${fmtSpan(stageEta.medianMs)}.` : `Median of ${stageEta.n} passes through “${stageName(d.stage, pt)}”: ${fmtSpan(stageEta.medianMs)}.`,
    }
  } else if (stageEta?.kind === 'none' && stageEta.reason === 'beyond-range') {
    first = {
      label: pt ? 'próxima etapa' : 'next stage',
      value: pt ? `mais demorado que o normal (típico ~${fmtSpan(stageEta.typicalMs)})` : `slower than usual (typical ~${fmtSpan(stageEta.typicalMs)})`, tone: 'late',
      title: pt ? 'Compara o tempo desta etapa com o que as outras peças levaram nela. Já passou do intervalo normal; não há número honesto.' : 'Compares this stage\'s time with what other pieces took in it. It is past the normal range; there is no honest number.',
    }
  } else {
    first = {
      label: pt ? 'próxima etapa' : 'next stage', value: none, tone: 'none',
      title: pt ? 'Ainda não há passagens suficientes por esta etapa para estimar.' : 'Not enough passes through this stage to estimate.',
    }
  }
  let second: EtaBox
  if (pub?.kind === 'none' && pub.reason === 'beyond-range') {
    second = {
      label: pt ? 'publicação' : 'publication', value: pt ? 'mais demorado que o normal' : 'slower than usual', tone: 'late',
      title: pt ? 'Já passou do intervalo normal; não há número honesto (nunca mostramos “agora”).' : 'It is past the normal range; there is no honest number (we never show "now").',
    }
  } else if (pub?.kind === 'estimate') {
    const parts = pub.parts.map(p => `${stageName(p.stage, pt)} ${fmtSpan(p.medianMs)}`)
    second = {
      label: pt ? 'publicação' : 'publication', value: `~${fmtClock(pub.atMs)}`, tone: 'ok',
      title: pub.source === 'stages'
        ? (pt ? `Soma das durações típicas das etapas que faltam${parts.length ? `: ${parts.join(' + ')}` : ''}.` : `Sum of the typical durations of the stages still ahead${parts.length ? `: ${parts.join(' + ')}` : ''}.`)
        : (pt ? `Sem histórico por etapa: usa a duração total de ${pub.n} entregas parecidas.` : `No per-stage history: uses the total duration of ${pub.n} similar deliveries.`),
    }
  } else {
    second = {
      label: pt ? 'publicação' : 'publication', value: none, tone: 'none',
      title: pt ? 'Falta histórico das etapas que ainda vêm; nada é inventado.' : 'The stages still ahead have no history; nothing is invented.',
    }
  }
  return [first, second]
}

// ------------------------------------------------------------------------------------ Bloqueado

export const BLOCK_WORD: Record<LiveBlock['reason'], { pt: string; en: string }> = {
  dependencia: { pt: 'espera outra subtarefa', en: 'waits for another subtask' },
  pedido_de_bloqueio: { pt: 'o worker pediu ajuda', en: 'the worker asked for help' },
  limite: { pt: 'limite de uso / login', en: 'usage limit / login' },
  maquina: { pt: 'máquina sem recursos', en: 'machine out of resources' },
  externo: { pt: 'serviço externo (CI / infra)', en: 'external service (CI / infra)' },
  fora_das_autorizacoes: { pt: 'fora das autorizações — o líder adiou (caminho seguro)', en: 'outside the authorisations — deferred by the leader (safe path)' },
  decisao_do_dono: { pt: 'decisão do dono', en: 'owner decision' },
}

/**
 * PURE: the pre-dispatch line of a queued card — "claude · opus · high · conta X" and the expected slot.
 * A field nobody staged is left out (never guessed); no staged session at all answers null.
 */
export function queueLines(d: Pick<LiveDeliveryRecord, 'staged' | 'slot'> & { queue?: LiveDeliveryRecord['queue'] }, pt: Pt, accountName?: (harness: string, account: string) => string, nowMs: number = Date.now()): { staged: string | null; slot: string | null; slotOk: boolean | null; slotRaw: string | null; wait: string | null } {
  const base = queueLinesBase(d, pt, accountName)
  return { ...base, wait: queueWaitLine(d.queue, pt, nowMs) }
}

/**
 * PURE (FILA.PRIORIDADE): why a queued card is NOT being started even if a slot is free — the leader's `não` with its
 * reason, an `agendar` with its hour ("começa às 14:00"), the open question, or an approval waiting for a slot.
 */
export function queueWaitLine(q: LiveDeliveryRecord['queue'] | undefined, pt: Pt, nowMs: number): string | null {
  if (!q) return null
  if (q.hold) {
    return q.hold.kind === 'nao'
      ? (pt ? `não por enquanto: ${q.hold.reason}` : `not for now: ${q.hold.reason}`)
      : `${q.hold.until ? startsLine(q.hold.until, nowMs, pt) : (pt ? 'agendada' : 'scheduled')} · ${q.hold.reason}`
  }
  if (q.approved) return pt ? 'aprovada — abre quando houver vaga' : 'approved — opens when a slot is free'
  if (q.asking) return pt ? 'esperando a resposta do líder' : 'waiting for the leader\'s answer'
  return null
}

function queueLinesBase(d: Pick<LiveDeliveryRecord, 'staged' | 'slot'>, pt: Pt, accountName?: (harness: string, account: string) => string): { staged: string | null; slot: string | null; slotOk: boolean | null; slotRaw: string | null } {
  const s = d.staged
  // The account is said by NAME; one the resolver cannot name (it hands the raw `acc_…` id back) is left out rather than shown as an id.
  const accountWord = s?.account ? (s.harness && accountName ? accountName(s.harness, s.account) : s.account) : null
  const accountPart = accountWord && accountWord !== s?.account && !/^acc_/i.test(accountWord) ? `${pt ? 'conta' : 'account'} ${accountWord}` : null
  const staged = s ? [s.harness, s.model, s.effort, accountPart].filter(Boolean).join(' · ') || null : null
  if (!d.slot) return { staged, slot: s ? (pt ? 'vaga: ainda não checada' : 'slot: not checked yet') : null, slotOk: null, slotRaw: null }
  // The gate's own sentence is English, carries account ids and is for the log: the card says it in a few plain words,
  // and the raw text stays in the tooltip (`slotRaw`) for whoever needs the detail.
  return {
    staged, slotOk: d.slot.ok, slotRaw: d.slot.ok ? null : d.slot.reason,
    slot: d.slot.ok ? (pt ? 'vaga: livre agora' : 'slot: free now') : humanSlotReason(d.slot.reason, pt, accountName),
  }
}

/**
 * PURE: the `vaga` gate's refusal (`delivery/gates.ts` `judgeVaga`: "no slot: a; b; c") in a few words a person reads —
 * "esperando vaga: 4 de 4 sessões em uso", "esperando a conta Codex liberar", "esperando memória livre". Ids never appear;
 * a part it does not recognise is said generically, never copied raw. Missing text = "no slot".
 */
export function humanSlotReason(raw: string | null | undefined, pt: Pt, accountName?: (harness: string, account: string) => string): string {
  const generic = pt ? 'esperando vaga' : 'waiting for a slot'
  const body = (raw ?? '').replace(/^no slot:\s*/i, '').trim()
  if (!body) return generic
  // A name, never an id: with no label known the account resolver hands the raw id back, and that must not reach a card.
  const acct = (h: string, a: string): string | null => {
    const n = accountName ? accountName(h, a) : null
    return n && n !== a && !/^acc_/i.test(n) ? n : null
  }
  const parts = body.split(/;\s*/).map(x => x.trim()).filter(Boolean).map((part): string => {
    let m: RegExpMatchArray | null
    if ((m = part.match(/^(\d+) workers running \(machine ceiling (\d+)\)/))) return pt ? `esperando vaga: ${m[1]} de ${m[2]} sessões em uso` : `waiting for a slot: ${m[1]} of ${m[2]} sessions in use`
    if ((m = part.match(/^(\d+) \S+ top-tier workers running \(cap (\d+)\)/))) return pt ? `esperando vaga: ${m[1]} de ${m[2]} sessões do modelo mais forte em uso` : `waiting for a slot: ${m[1]} of ${m[2]} top-model sessions in use`
    if ((m = part.match(/^fresh plan_limits reading for ([^:\s]+):(\S+)/))) {
      const a = acct(m[1]!, m[2]!)
      return pt ? `esperando a leitura dos limites${a ? ` da conta ${a}` : ' da conta'}` : `waiting for the limits reading${a ? ` of account ${a}` : ' of the account'}`
    }
    if ((m = part.match(/^5 h window at (\d+)%/))) return pt ? `esperando a conta liberar (janela de 5 h em ${m[1]}%)` : `waiting for the account to free up (5 h window at ${m[1]}%)`
    if ((m = part.match(/^week at (\d+)%/))) return pt ? `esperando a conta liberar (semana em ${m[1]}%)` : `waiting for the account to free up (week at ${m[1]}%)`
    if (/^free memory/.test(part)) return pt ? 'esperando memória livre' : 'waiting for free memory'
    return generic
  })
  return [...new Set(parts)].join(pt ? ' · ' : ' · ')
}
const UNLOCKER_WORD = { leader: { pt: 'líder', en: 'leader' }, owner: { pt: 'dono', en: 'owner' }, self: { pt: 'destrava sozinho', en: 'lifts by itself' } }

export function blockLines(b: LiveBlock, sinceMs: number | null, nowMs: number, pt: Pt): { reason: string; unlocker: string; since: string; origin: string | null } {
  const l = pt ? 'pt' : 'en'
  const why = BLOCK_WORD[b.reason][l] + (b.text ? ` — ${b.text}` : '')
  return {
    reason: `${pt ? 'bloqueado por' : 'blocked by'}: ${why}`,
    unlocker: `${pt ? 'quem destrava' : 'who lifts it'}: ${UNLOCKER_WORD[b.unlocker][l]}`,
    since: sinceMs === null ? '' : `${pt ? 'há' : ''} ${fmtSpan(nowMs - sinceMs)}${pt ? '' : ' ago'}`,
    origin: b.originStage ? `${pt ? 'volta para' : 'returns to'}: ${stageName(b.originStage, pt)}` : null,
  }
}

// ------------------------------------------------------------------------------------ tasks filter

export interface TaskOption { value: string; label: string; recent: boolean; live: number }

/**
 * PURE: the tasks the filter offers. Those with live agents or movement in the last day come FIRST
 * ("Recentes"), so the list opens on the work that is actually going on; the rest follow alphabetically.
 */
export function taskOptions(cards: readonly LiveCard[], nowMs: number, extra: ReadonlyMap<string, string> = new Map()): TaskOption[] {
  const m = new Map<string, TaskOption>()
  const add = (id: string, label: string) => { if (!m.has(id)) m.set(id, { value: id, label, recent: false, live: 0 }) }
  for (const [id, label] of extra) add(id, label)
  for (const c of cards) {
    add(c.d.taskId, c.d.taskTitle)
    const o = m.get(c.d.taskId)!
    const live = c.agents.filter(a => a.state === 'working' || a.state === 'waiting' || a.state === 'waiting-approval').length
    o.live += live
    if (live > 0 || (c.d.stageSinceMs !== null && nowMs - c.d.stageSinceMs < 24 * 3600_000 && c.d.stage !== 'published')) o.recent = true
  }
  return [...m.values()].sort((a, b) => Number(b.recent) - Number(a.recent) || b.live - a.live || a.label.localeCompare(b.label))
}

/** The task a session belongs to: the live line's own answer (its piece, its filing) — a leader included. */
export function taskOfSession(
  sessionId: string | null | undefined,
  o: { sessionTasks?: Record<string, string>; cards: readonly LiveCard[]; leaders?: readonly { id: string; taskId?: string | null }[] },
): string | null {
  if (!sessionId) return null
  const filed = o.sessionTasks?.[sessionId]
  if (filed) return filed
  const card = o.cards.find(c => c.d.sessionIds.includes(sessionId))
  if (card) return card.d.taskId
  return o.leaders?.find(l => l.id === sessionId)?.taskId ?? null
}

// ------------------------------------------------------------------------------------ columns

export type CollapsedPrefs = Partial<Record<LiveStage, boolean>>

/**
 * PURE: is a column drawn collapsed? The user's choice wins; else a column with cards is OPEN and an empty one is
 * collapsed (filtros v2). Publicado is the one empty column that stays open while its tab is showing — its header
 * carries the period picker, and "nothing published in this period" is an answer to read, not a gap.
 */
export function columnCollapsed(stage: LiveStage, count: number, prefs: CollapsedPrefs, keepOpen = false): boolean {
  return prefs[stage] ?? (count === 0 && !keepOpen)
}

const PREFS_KEY = 'agentistics.live.collapsed.v1'
export function readCollapsedPrefs(storage: Pick<Storage, 'getItem'> | null = safeStorage()): CollapsedPrefs {
  try {
    const raw = storage?.getItem(PREFS_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const out: CollapsedPrefs = {}
    for (const s of LIVE_STAGES) if (typeof parsed[s] === 'boolean') out[s] = parsed[s] as boolean
    return out
  } catch { return {} }
}
export function writeCollapsedPrefs(p: CollapsedPrefs, storage: Pick<Storage, 'setItem'> | null = safeStorage()): void {
  try { storage?.setItem(PREFS_KEY, JSON.stringify(p)) } catch { /* a private window: the choice lasts until reload */ }
}
function safeStorage(): Storage | null { try { return window.localStorage } catch { return null } }

/** The filter bar's saved choices — kept like the column preferences above (this browser, this origin). */
export interface LiveViewPrefs { tab: LiveTab; period: LivePeriod; sort: LiveSortId }
// v2: the two v1 switches (apenas ativas / exibir fila) became the tabs; the old key is simply never read again.
const VIEW_KEY = 'agentistics.live.view.v2'
export function readViewPrefs(storage: Pick<Storage, 'getItem'> | null = safeStorage()): LiveViewPrefs {
  const dflt: LiveViewPrefs = { tab: LIVE_DEFAULTS.tab, period: LIVE_DEFAULTS.period, sort: LIVE_DEFAULTS.sort }
  try {
    const raw = storage?.getItem(VIEW_KEY)
    if (!raw) return dflt
    const p = JSON.parse(raw) as Record<string, unknown>
    return { tab: parseLiveTab(p.tab), period: parseLivePeriod(p.period), sort: parseLiveSort(p.sort) }
  } catch { return dflt }
}
export function writeViewPrefs(p: LiveViewPrefs, storage: Pick<Storage, 'setItem'> | null = safeStorage()): void {
  try { storage?.setItem(VIEW_KEY, JSON.stringify(p)) } catch { /* a private window: the choice lasts until reload */ }
}

/** The leader cards' open/closed memory, per leader. Absent = collapsed (the default). */
const LEADER_KEY = 'agentistics.live.leaders.open.v1'
export function readOpenLeaders(storage: Pick<Storage, 'getItem'> | null = safeStorage()): Record<string, boolean> {
  try { const o = JSON.parse(storage?.getItem(LEADER_KEY) ?? '{}') as unknown; return o && typeof o === 'object' ? o as Record<string, boolean> : {} } catch { return {} }
}
export function writeOpenLeaders(p: Record<string, boolean>, storage: Pick<Storage, 'setItem'> | null = safeStorage()): void {
  try { storage?.setItem(LEADER_KEY, JSON.stringify(p)) } catch { /* see above */ }
}

/**
 * PURE: the board's `scrollLeft` that puts a card fully in view with the least movement (centred when it
 * fits, flush to the nearest edge otherwise). Both rects share one coordinate space. Horizontal ONLY: the
 * old `scrollIntoView({block:'center'})` also scrolled the page's own scroller vertically (QA MED 6), and a
 * card that sits past the board's right edge was not even reached (scrollLeft 30 of 142 needed).
 */
export function revealScrollLeft(o: { scrollLeft: number; viewLeft: number; viewWidth: number; cardLeft: number; cardWidth: number; scrollWidth: number }): number {
  const rel = o.cardLeft - o.viewLeft + o.scrollLeft
  const want = o.cardWidth >= o.viewWidth ? rel : rel - (o.viewWidth - o.cardWidth) / 2
  return Math.max(0, Math.min(Math.round(want), Math.max(0, o.scrollWidth - o.viewWidth)))
}

// ------------------------------------------------------------------------------------ column body

/**
 * A column is ONE vertical stack with its own scroll (owner, 07/11): the grid of full cards plus compact rows
 * and the "+N" control are gone. The page stays free of vertical scroll; only a column's body scrolls.
 */

/** A column's search appears once MORE than this many cards are out of view. */
export const COLUMN_SEARCH_AFTER = 3

/**
 * PURE: how many cards are NOT visible in the column's scroll area — entirely above or below the viewport.
 * `rects` are the cards' vertical extents and `view` the scroll area's, in the same coordinate space. A card
 * that shows even a few pixels counts as visible: a half-visible card is one the reader can already see.
 */
export function countOutOfView(rects: readonly { top: number; bottom: number }[], view: { top: number; bottom: number }): number {
  let n = 0
  for (const r of rects) if (r.bottom <= view.top + 1 || r.top >= view.bottom - 1) n++
  return n
}

/**
 * PURE: is the column's search shown? Only when more than three cards are out of view, and never while
 * something is typed in it (a filter that removes cards must not make its own field disappear). Once shown it
 * holds on a hair longer than it took to appear (the field takes room, which hides one more card) so it
 * cannot flicker at the threshold.
 */
export function showColumnSearch(o: { outOfView: number; query: string; wasShown: boolean }): boolean {
  if (o.query.trim() !== '') return true
  return o.wasShown ? o.outOfView >= COLUMN_SEARCH_AFTER : o.outOfView > COLUMN_SEARCH_AFTER
}

/** PURE: the column search — a card matches when the query appears in its title, its task, or its subtask (case-folded, every word). */
export function matchesColumnQuery(c: Pick<LiveCard, 'd'>, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  const hay = `${c.d.title} ${c.d.taskTitle}`.toLowerCase()
  return words.every(w => hay.includes(w))
}

// ------------------------------------------------------------------------------------ departures

export const GONE_LINGER_MS = 30_000
export const GONE_RECENT_MS = 10 * 60_000
export const GONE_RECENT_MAX = 8

export interface Gone { key: string; title: string; reason: string; atMs: number; kind: 'card' | 'leader' }

const HIDDEN_WORD: Record<HiddenReason, { pt: string; en: string }> = {
  'no-live-session': { pt: 'a sessão encerrou e a peça segue sem agente', en: 'the session ended and the piece has no agent' },
  'status-unplaced': { pt: 'status sem etapa reconhecida', en: 'status with no known stage' },
  'published-old': { pt: 'publicado há mais de 24 h', en: 'published over 24 h ago' },
  'queue-idle': { pt: 'saiu da fila (sessão em espera removida)', en: 'left the queue (staged session removed)' },
  'legacy-review-old': { pt: 'em revisão há mais de 72 h, sem sessão viva e sem commit publicado', en: 'in review for over 72 h, no live session and no published commit' },
}
export const hiddenWord = (r: HiddenReason, pt: Pt): string => HIDDEN_WORD[r][pt ? 'pt' : 'en']

export interface BoardSnapshot { cards: ReadonlyMap<string, { title: string; stage: LiveStage }>; leaders: ReadonlyMap<string, string>; filterSig: string }

export function snapshotOf(shown: readonly LiveCard[], leaders: readonly { id: string; title: string }[], filterSig: string): BoardSnapshot {
  return {
    cards: new Map(shown.map(c => [c.d.key, { title: c.d.title, stage: c.d.stage }])),
    leaders: new Map(leaders.map(l => [l.id, l.title])),
    filterSig,
  }
}

/**
 * PURE: what left the board between two snapshots and WHY. Every path has its own sentence:
 *  - still in the unfiltered cards but not shown -> the filter bar (task, "apenas ativas", "exibir itens na fila");
 *  - named in the server's `hidden` -> that reason;
 *  - nowhere -> removed from the book (deleted, moved to a group, out of the window).
 * A change of the user's own filters is not a departure — they asked for it — so it reports nothing.
 */
export function planDepartures(
  prev: BoardSnapshot | null, next: BoardSnapshot,
  ctx: { allKeys: ReadonlySet<string>; hidden: readonly LiveHidden[]; leaderIdsNow: ReadonlySet<string>; nowMs: number; pt: Pt },
): Gone[] {
  if (!prev || prev.filterSig !== next.filterSig) return []
  const out: Gone[] = []
  const hiddenBy = new Map(ctx.hidden.map(h => [h.key, h]))
  for (const [key, was] of prev.cards) {
    if (next.cards.has(key)) continue
    let reason: string
    if (ctx.allKeys.has(key)) reason = ctx.pt ? 'ficou fora dos filtros da barra' : 'it is outside the filter bar’s filters'
    else if (hiddenBy.has(key)) reason = hiddenWord(hiddenBy.get(key)!.reason, ctx.pt)
    else reason = ctx.pt ? 'removido do quadro (tarefa apagada, agrupada ou fora da janela)' : 'removed from the board (task deleted, grouped or out of the window)'
    out.push({ key, title: was.title, reason, atMs: ctx.nowMs, kind: 'card' })
  }
  for (const [id, title] of prev.leaders) {
    if (next.leaders.has(id)) continue
    out.push({ key: `leader:${id}`, title, reason: ctx.leaderIdsNow.has(id) ? (ctx.pt ? 'líder parado' : 'leader stopped') : (ctx.pt ? 'sessão do líder encerrada' : 'leader session ended'), atMs: ctx.nowMs, kind: 'leader' })
  }
  return out
}

/** PURE: merge new departures into the standing list, drop what is older than the recent window. */
export function mergeGone(list: readonly Gone[], fresh: readonly Gone[], nowMs: number): Gone[] {
  const by = new Map(list.map(g => [g.key, g]))
  for (const g of fresh) by.set(g.key, g)
  return [...by.values()].filter(g => nowMs - g.atMs <= GONE_RECENT_MS).sort((a, b) => b.atMs - a.atMs).slice(0, GONE_RECENT_MAX * 2)
}
export const lingering = (list: readonly Gone[], nowMs: number): Gone[] => list.filter(g => nowMs - g.atMs < GONE_LINGER_MS)

export const sinceWord = (atMs: number, nowMs: number, pt: Pt): string => {
  const s = Math.max(0, Math.round((nowMs - atMs) / 1000))
  const v = s < 60 ? `${s} s` : fmtSpan(nowMs - atMs)
  return pt ? `há ${v}` : `${v} ago`
}

export type { StageVisit }
