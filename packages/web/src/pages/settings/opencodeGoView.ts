/**
 * PURE view model of the OpenCode plan + allowance card (Usage → Accounts → OpenCode providers).
 * It turns the `/api/opencode/usage` answer into words and rows; it holds no rule about the plan itself
 * (`@agentistics/core` `opencodeGo.ts` does) and draws nothing.
 */
import type { GoUsage, GoWindowKind, OpencodePlanId } from '@agentistics/core'

export interface OcUsageReply {
  plan: { id: OpencodePlanId; label: string; priceUsd: number | null; perMember: boolean; chosen: boolean }
  usage: GoUsage | null
  reason?: 'no-go-plan' | 'unreadable'
  estimated: true
  blocked?: { at: number; message: string }
  now: number
}

export const OC_PLAN_CHOICES: readonly OpencodePlanId[] = ['go', 'go-plus', 'go-teams', 'zen', 'none']

/** Whole dollars when it is one, two decimals above a dollar, and up to four below it (a response costs fractions of a cent), no trailing zeros. */
export const fmtUsd = (n: number): string => {
  if (n >= 1) return `US$ ${Number.isInteger(n) ? n : n.toFixed(2)}`
  if (n === 0) return 'US$ 0'
  const s = n.toFixed(4).replace(/0+$/, '')
  return `US$ ${s.length < 4 ? s.padEnd(4, '0') : s}`
}

export const OC_USAGE_COPY = (pt: boolean) => ({
  section: pt ? 'Plano e limites' : 'Plan and limits',
  estimated: pt
    ? 'Estimado a partir do custo que o OpenCode registra em cada resposta nesta máquina. Respostas de outros aparelhos não entram.'
    : 'Estimated from the cost OpenCode records on each response on this machine. Responses from other devices are not counted.',
  planLabel: pt ? 'Plano' : 'Plan',
  planAuto: pt ? 'Detectar pela chave' : 'Detect from the key',
  planChosen: pt ? 'escolhido por você' : 'chosen by you',
  planInferred: pt ? 'deduzido da chave' : 'inferred from the key',
  planHint: pt ? 'Nenhum arquivo local diferencia Go, Go Plus e Go Teams; escolha o seu.' : 'No local file tells Go, Go Plus and Go Teams apart; pick yours.',
  price: (priceUsd: number | null, perMember: boolean) =>
    priceUsd === null ? (pt ? 'crédito pré-pago' : 'pay-as-you-go credit')
      : priceUsd === 0 ? (pt ? 'gratuito' : 'free')
        : `US$ ${priceUsd}${pt ? '/mês' : '/month'}${perMember ? (pt ? ' por membro' : ' per member') : ''}`,
  planName: (id: OpencodePlanId): string => ({
    go: 'OpenCode Go', 'go-plus': 'OpenCode Go Plus', 'go-teams': 'OpenCode Go Teams',
    zen: 'OpenCode Zen', none: pt ? 'Sem assinatura' : 'No subscription',
  })[id],
  window: (k: GoWindowKind) => (k === '5h' ? (pt ? '5 horas' : '5 hours') : k === 'week' ? (pt ? 'Semana' : 'Week') : (pt ? 'Mês' : 'Month')),
  windowShort: (k: GoWindowKind) => (k === '5h' ? '5 h' : k === 'week' ? (pt ? 'sem' : 'wk') : (pt ? 'mês' : 'mo')),
  of: (used: string, limit: string) => `${used} / ${limit}`,
  modelsTitle: pt ? 'Custo local por modelo (últimos 30 dias)' : 'Local cost per model (last 30 days)',
  trains: pt ? 'treina com seus dados' : 'trains on your data',
  noUse: pt ? 'Nenhuma resposta do Go nesta máquina no último mês.' : 'No Go response on this machine in the last month.',
  noGoPlan: (plan: string) => pt ? `${plan} não tem limite por janela para mostrar aqui.` : `${plan} has no per-window limit to show here.`,
  unreadable: pt ? 'Não foi possível ler o histórico do OpenCode.' : 'Could not read the OpenCode history.',
  unlisted: (ids: string[]) => pt ? `Sem limite listado (grátis ou novo demais): ${ids.join(', ')}.` : `No listed limit (free, or too new): ${ids.join(', ')}.`,
  resets: pt ? 'libera' : 'frees up',
})

export interface OcRing { kind: GoWindowKind; label: string; pct: number | null; detail: string; model: string | null }
export interface OcModelRow { model: string; pct: number | null; binding: GoWindowKind; amount: string; trains: boolean }
export interface OcUsageView {
  title: string
  price: string
  basis: string
  rings: OcRing[]
  models: OcModelRow[]
  notes: string[]
  showEstimate: boolean
}

/** Whole-percent reading of a fraction; never negative, may exceed 100 (a model can be over its allowance). */
export const pctOf = (f: number): number => Math.max(0, Math.round(f * 100))

export function ocUsageView(r: OcUsageReply, pt: boolean): OcUsageView {
  const t = OC_USAGE_COPY(pt)
  const notes: string[] = []
  if (r.plan.id.startsWith('go')) notes.push(r.blocked
    ? (pt ? 'Go bloqueado pelo limite do provedor. Renovação desconhecida; aguardando recuperação confirmada.' : 'Go is blocked by the provider limit. Reset unknown; awaiting confirmed recovery.')
    : (pt ? 'Quota e renovação do provedor: sem medição. Os custos locais abaixo não determinam disponibilidade.' : 'Provider quota and reset: unknown. Local costs below do not determine availability.'))
  const rings: OcRing[] = (['5h', 'week', 'month'] as const).map((kind): OcRing => {
    const m = r.usage?.tightest[kind] ?? null
    return {
      kind, label: t.window(kind), model: m?.model ?? null,
      pct: null,
      detail: pt ? 'sem medição' : 'unknown',
    }
  })
  const models: OcModelRow[] = (r.usage?.models ?? []).map(m => ({
    model: m.model, pct: null, binding: 'month',
    amount: fmtUsd(m.windows.find(w => w.kind === 'month')!.usedUsd), trains: m.trainsOnData,
  }))
  if (r.reason === 'no-go-plan') notes.push(t.noGoPlan(t.planName(r.plan.id)))
  else if (r.reason === 'unreadable') notes.push(t.unreadable)
  else if (models.length === 0) notes.push(t.noUse)
  if (r.usage?.unlisted.length) notes.push(t.unlisted(r.usage.unlisted))
  return {
    title: t.planName(r.plan.id), price: t.price(r.plan.priceUsd, r.plan.perMember),
    basis: r.plan.chosen ? t.planChosen : t.planInferred,
    rings: models.length ? rings : [], models, notes,
    showEstimate: r.usage !== null,
  }
}
