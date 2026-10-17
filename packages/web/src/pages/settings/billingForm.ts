/**
 * billingForm.ts — PURE: the billing period form's draft shape, its prefill and its refusals.
 *
 * Extracted from `BillingSettings.tsx` so the rules can be tested without mounting a drawer, the
 * same split `accountForm.ts` uses. The SEMANTICS live in `@agentistics/core/billing`
 * (`validatePeriod`); this file only maps a form's strings to and from a `BillingPeriod` and
 * decides what the catalog contributes.
 */
import {
  findPlan,
  validatePeriod,
  sortPeriods,
  dayIndex,
  type BillingCurrency,
  type BillingMode,
  type BillingPeriod,
  type BillingPeriodError,
  type PlanCatalogEntry,
  type BillingDay,
} from '@agentistics/core'

export interface PeriodDraft {
  /** Empty for a new period; the existing id when editing, so an edit never becomes an insert. */
  id: string
  planId: string
  /** Only meaningful for `planId === 'other'`. */
  label: string
  /** As typed. Kept as a string so a half-typed "1" is not read as one dollar. */
  amount: string
  currency: BillingCurrency
  from: string
  to: string
  /** `to` is empty AND the period is declared open-ended. Distinct from "the user has not typed
   *  the end date yet", which must not silently become "this plan is still active". */
  ongoing: boolean
}

export function emptyDraft(): PeriodDraft {
  return { id: '', planId: '', label: '', amount: '', currency: 'USD', from: '', to: '', ongoing: true }
}

export function draftFromPeriod(period: BillingPeriod): PeriodDraft {
  return {
    id: period.id,
    planId: period.planId ?? '',
    label: period.label ?? '',
    amount: period.price ? amountText(period.price.amount) : '',
    currency: period.price?.currency ?? 'USD',
    from: period.from,
    to: period.to ?? '',
    ongoing: period.to === undefined,
  }
}

/**
 * Apply a catalog choice to the draft.
 *
 * The amount is filled ONLY when the catalog actually has a verified figure. An entry without one
 * leaves the field blank and required, which is the whole point of the catalog's provenance rule:
 * a plan whose price no vendor page states must be typed from an invoice, not inherited from a
 * guess. An amount the user has ALREADY typed is never overwritten — re-picking the same plan to
 * re-read its note would otherwise silently discard their figure.
 */
export function applyPlan(draft: PeriodDraft, entry: PlanCatalogEntry): PeriodDraft {
  const next: PeriodDraft = { ...draft, planId: entry.id }

  if (entry.mode !== 'subscription') {
    // A non-subscription period has no monthly price by definition; carrying one over from a
    // previous choice would be stored and then double-counted.
    return { ...next, amount: '', currency: 'USD', label: '' }
  }

  if (entry.monthly && draft.amount.trim() === '') {
    next.amount = String(entry.monthly.amount)
    next.currency = entry.monthly.currency
  }
  if (entry.id !== 'other') next.label = ''
  return next
}

/** The mode a draft's plan implies. Unknown ids read as a subscription: a period the user typed
 *  an amount for is one they pay monthly, whatever build wrote the id. */
export function draftMode(draft: PeriodDraft): BillingMode {
  return findPlan(draft.planId)?.mode ?? 'subscription'
}

/** True when the amount field should be shown at all. */
export function draftWantsPrice(draft: PeriodDraft): boolean {
  return draftMode(draft) === 'subscription'
}

/**
 * The draft as a period. Always produces one — validation is a separate question, so the form can
 * show errors against a half-filled row rather than refusing to represent it.
 */
export function periodFromDraft(draft: PeriodDraft, newId: () => string): BillingPeriod {
  const mode = draftMode(draft)
  const amount = Number(draft.amount.replace(',', '.'))
  const period: BillingPeriod = {
    id: draft.id || newId(),
    mode,
    from: draft.from,
  }
  if (draft.planId) period.planId = draft.planId
  if (draft.planId === 'other' && draft.label.trim()) period.label = draft.label.trim()
  if (!draft.ongoing && draft.to) period.to = draft.to
  if (mode === 'subscription' && draft.amount.trim() !== '' && Number.isFinite(amount)) {
    period.price = { amount, currency: draft.currency }
  }
  return period
}

/**
 * Everything wrong with the draft, in the context of the timeline it is joining.
 *
 * `others` is the FULL period list; `validatePeriod` skips the draft's own id, so editing a period
 * never reports it overlapping its previous self.
 */
export function validateDraft(
  draft: PeriodDraft,
  others: readonly BillingPeriod[],
  newId: () => string = () => 'draft',
): BillingPeriodError[] {
  return validatePeriod(periodFromDraft(draft, newId), others)
}

/**
 * One sentence per error, in the user's language.
 *
 * Rendered INLINE under the offending field, never as a toast: on a phone the form is a
 * full-screen drawer, and a toast over it is a message read once and impossible to re-read.
 */
export function describeError(error: BillingPeriodError, lang: 'pt' | 'en', planName?: string): string {
  const pt = lang === 'pt'
  switch (error.code) {
    case 'missing_from':
      return pt ? 'Informe a data de início.' : 'Enter the start date.'
    case 'bad_day':
      return pt
        ? `"${error.value}" não é uma data válida.`
        : `"${error.value}" is not a valid date.`
    case 'inverted_range':
      return pt
        ? 'A data de término é anterior à de início.'
        : 'The end date comes before the start date.'
    case 'missing_plan':
      return pt ? 'Escolha um plano.' : 'Choose a plan.'
    case 'missing_label':
      return pt ? 'Dê um nome a este plano.' : 'Give this plan a name.'
    case 'missing_price':
      return pt
        ? 'Informe quanto você paga por mês.'
        : 'Enter what you pay per month.'
    case 'non_positive_price':
      return pt ? 'O valor precisa ser maior que zero.' : 'The amount must be greater than zero.'
    case 'price_on_non_subscription':
      return pt
        ? 'Este tipo de cobrança não tem valor mensal.'
        : 'This billing type has no monthly amount.'
    case 'overlap':
      // Named by plan, never by index: a list the user just re-sorted makes "period 2" meaningless.
      return planName
        ? (pt
            ? `Este período se sobrepõe a "${planName}". Dois planos não podem cobrir o mesmo dia.`
            : `This period overlaps "${planName}". Two plans cannot cover the same day.`)
        : (pt
            ? 'Este período se sobrepõe a outro. Dois planos não podem cobrir o mesmo dia.'
            : 'This period overlaps another. Two plans cannot cover the same day.')
  }
}

// ── what the screen leads with ───────────────────────────────────────────────────────────────

/**
 * Split a timeline into the plan in force TODAY and everything else.
 *
 * The screen leads with the current plan because that is the question people arrive with — "what
 * am I paying?" — while the timeline is the data model that makes a plan CHANGE priceable. Both
 * are needed; only one belongs at the top.
 *
 * With overlapping periods (a hand edit, refused everywhere else) the latest start wins, so the
 * screen still renders something coherent while the timeline warns separately.
 */
export function splitTimeline(
  periods: readonly BillingPeriod[],
  today: BillingDay,
): { current: BillingPeriod | null; history: BillingPeriod[] } {
  const now = dayIndex(today)
  if (now === null) return { current: null, history: sortPeriods(periods) }

  let current: BillingPeriod | null = null
  let bestStart = -Infinity
  for (const p of periods) {
    const from = dayIndex(p.from)
    if (from === null || from > now) continue
    const to = p.to ? dayIndex(p.to) : Number.POSITIVE_INFINITY
    if (to === null || to < now) continue
    if (from > bestStart) { current = p; bestStart = from }
  }

  return {
    current,
    // Newest first: a history list is read backwards from where you are now.
    history: sortPeriods(periods.filter(p => p.id !== current?.id)).reverse(),
  }
}

/** How this period is billed, in the user's words. The screen says it out loud because it changes
 *  what every figure in the app means — a third-party period computes no plan cost at all. */
export function modeLabel(mode: BillingMode, lang: 'pt' | 'en'): string {
  const pt = lang === 'pt'
  switch (mode) {
    case 'subscription': return pt ? 'Assinatura' : 'Subscription'
    case 'api': return pt ? 'Pago por token' : 'Billed per token'
    case 'thirdparty': return pt ? 'Cobrado por terceiro' : 'Billed by a third party'
    default: return pt ? 'Cobrança desconhecida' : 'Billing unknown'
  }
}

// ── the amount field ─────────────────────────────────────────────────────────────────────────

/**
 * Whatever the user typed → a canonical amount (dot decimal, no grouping).
 *
 * Deliberately NOT the "last two digits are cents" trick most money inputs use. That reads "100"
 * as one real and is maddening when the amount you are typing genuinely has no cents — which is
 * true of every plan price in the catalog. This keeps what was typed and only cleans it: digits,
 * at most one separator, at most two decimals. Either separator is accepted, because a pt-BR
 * keyboard produces a comma and a US one a dot, and the field should not care.
 */
export function parseAmountInput(raw: string): string {
  const cleaned = raw.replace(/[^\d.,]/g, '')
  const digitsOnly = () => cleaned.replace(/\D/g, '')

  const lastSep = Math.max(cleaned.lastIndexOf('.'), cleaned.lastIndexOf(','))
  if (lastSep === -1) return digitsOnly()

  // A separator the user just typed, with nothing after it yet. Preserved so the decimal can
  // actually be entered — collapsing it the instant the key is pressed makes that impossible.
  if (lastSep === cleaned.length - 1) return `${cleaned.slice(0, lastSep).replace(/\D/g, '')}.`

  const tail = cleaned.slice(lastSep + 1).replace(/\D/g, '')
  // The last separator is the DECIMAL one only when 1-2 digits follow it. Three or more means it
  // was grouping — and this matters beyond pedantry: the field displays the grouped form, so
  // "1.234.567" comes straight back through this function on the next keystroke. Reading its last
  // dot as a decimal point would turn one million into one thousand while the user watched.
  if (tail.length > 2) return digitsOnly()
  return `${cleaned.slice(0, lastSep).replace(/\D/g, '')}.${tail}`
}

/** The symbol shown in front of the field. */
export function currencySymbol(currency: BillingCurrency): string {
  return currency === 'BRL' ? 'R$' : '$'
}

/**
 * A canonical amount → what the field shows.
 *
 * Grouping is applied to the integer part only, and the separators follow the CURRENCY rather
 * than the interface language: someone reading the app in English who pays in reais still expects
 * `R$ 1.234,56`. A trailing separator is preserved while typing — reformatting "1," to "1" the
 * instant the comma is pressed makes the decimal impossible to enter.
 */
export function formatAmountDisplay(canonical: string, currency: BillingCurrency): string {
  if (canonical === '') return ''
  const brl = currency === 'BRL'
  const group = brl ? '.' : ','
  const decimal = brl ? ',' : '.'

  const [intRaw = '', decRaw] = canonical.split('.')
  const int = (intRaw || '0').replace(/\B(?=(\d{3})+(?!\d))/g, group)
  if (decRaw === undefined) return int
  return `${int}${decimal}${decRaw}`
}

/** A stored amount as text: whole amounts stay whole, anything else carries exactly two decimals
 *  (110.5 → "110.50"), so a price never reads with its trailing zero dropped. */
export function amountText(amount: number): string {
  return Number.isInteger(amount) ? String(amount) : amount.toFixed(2)
}

/** A price as the page prints it, separators following the currency: `R$ 110,50`, `$ 20`. */
export function formatPrice(amount: number, currency: BillingCurrency): string {
  return `${currencySymbol(currency)} ${formatAmountDisplay(amountText(amount), currency)}`
}

/** The display name of a period: its own label, else the catalog's, else the raw id. */
export function periodName(period: BillingPeriod): string {
  if (period.label) return period.label
  const entry = period.planId ? findPlan(period.planId) : undefined
  return entry?.label ?? period.planId ?? ''
}
