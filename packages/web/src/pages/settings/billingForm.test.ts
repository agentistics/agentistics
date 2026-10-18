import { describe, test, expect } from 'bun:test'
import {
  applyPlan,
  catalogPlanName,
  splitTimeline,
  modeLabel,
  currencySymbol,
  formatAmountDisplay,
  formatPrice,
  parseAmountInput,
  describeError,
  draftFromPeriod,
  draftMode,
  draftWantsPrice,
  emptyDraft,
  periodFromDraft,
  periodName,
  validateDraft,
} from './billingForm'
import { findPlan } from '@agentistics/core'
import type { BillingPeriod } from '@agentistics/core'
import { closeBefore } from './accountBilling'

const id = () => 'bp_new'
const plan = (planId: string) => findPlan(planId)!

describe('applyPlan', () => {
  test('fills the amount from a verified catalog price', () => {
    const out = applyPlan(emptyDraft(), plan('anthropic-pro'))
    expect(out.planId).toBe('anthropic-pro')
    expect(out.amount).toBe('20')
    expect(out.currency).toBe('USD')
  })

  test('leaves the amount blank when the catalog has no verified price', () => {
    // The point of the provenance rule: a plan no vendor page prices must be typed from an
    // invoice, never inherited from a guess.
    const out = applyPlan(emptyDraft(), plan('anthropic-max-20x'))
    expect(out.planId).toBe('anthropic-max-20x')
    expect(out.amount).toBe('')
  })

  test('never overwrites an amount the user already typed', () => {
    // Re-picking the same plan to re-read its note must not discard their figure.
    const typed = { ...emptyDraft(), amount: '137.50' }
    expect(applyPlan(typed, plan('anthropic-pro')).amount).toBe('137.50')
  })

  test('picking pay-as-you-go clears the price entirely', () => {
    // An api period's cost is its API estimate; a monthly amount left on it would be added to a
    // cost that already contains it.
    const withPrice = { ...emptyDraft(), amount: '100', currency: 'BRL' as const }
    const out = applyPlan(withPrice, plan('api-payg'))
    expect(out.amount).toBe('')
    expect(out.currency).toBe('USD')
  })

  test('the label survives only for the "other" plan', () => {
    const named = { ...emptyDraft(), label: 'Corp gateway' }
    expect(applyPlan(named, plan('other')).label).toBe('Corp gateway')
    expect(applyPlan(named, plan('anthropic-pro')).label).toBe('')
  })
})

describe('draftMode / draftWantsPrice', () => {
  test('follows the catalog', () => {
    expect(draftMode({ ...emptyDraft(), planId: 'api-payg' })).toBe('api')
    expect(draftWantsPrice({ ...emptyDraft(), planId: 'api-payg' })).toBe(false)
    expect(draftWantsPrice({ ...emptyDraft(), planId: 'anthropic-pro' })).toBe(true)
  })

  test('an unknown id reads as a subscription', () => {
    // A period the user typed an amount for is one they pay monthly, whatever build wrote the id.
    expect(draftMode({ ...emptyDraft(), planId: 'from-a-newer-build' })).toBe('subscription')
  })
})

describe('periodFromDraft', () => {
  test('builds a complete subscription period', () => {
    const draft = { ...emptyDraft(), planId: 'anthropic-max-5x', amount: '100', from: '2026-01-01', ongoing: true }
    expect(periodFromDraft(draft, id)).toEqual({
      id: 'bp_new', mode: 'subscription', planId: 'anthropic-max-5x',
      from: '2026-01-01', price: { amount: 100, currency: 'USD' },
    })
  })

  test('editing preserves the id — an edit is never an insert', () => {
    const draft = { ...emptyDraft(), id: 'bp_existing', planId: 'anthropic-pro', amount: '20', from: '2026-01-01' }
    expect(periodFromDraft(draft, id).id).toBe('bp_existing')
  })

  test('ongoing omits `to` rather than resolving it to today', () => {
    const draft = { ...emptyDraft(), planId: 'anthropic-pro', amount: '20', from: '2026-01-01', to: '2026-05-05', ongoing: true }
    expect(periodFromDraft(draft, id).to).toBeUndefined()
  })

  test('a closed period keeps its end date', () => {
    const draft = { ...emptyDraft(), planId: 'anthropic-pro', amount: '20', from: '2026-01-01', to: '2026-05-05', ongoing: false }
    expect(periodFromDraft(draft, id).to).toBe('2026-05-05')
  })

  test('a comma decimal is read as a decimal, not truncated', () => {
    // pt-BR keyboards type 24,99 — reading that as 24 would silently under-price every month.
    const draft = { ...emptyDraft(), planId: 'other', label: 'X', amount: '24,99', from: '2026-01-01' }
    expect(periodFromDraft(draft, id).price?.amount).toBeCloseTo(24.99, 9)
  })

  test('an api period never carries a price, even if one was typed', () => {
    const draft = { ...emptyDraft(), planId: 'api-payg', amount: '100', from: '2026-01-01' }
    expect(periodFromDraft(draft, id).price).toBeUndefined()
  })

  test('a blank amount produces no price rather than a zero', () => {
    const draft = { ...emptyDraft(), planId: 'anthropic-pro', amount: '', from: '2026-01-01' }
    expect(periodFromDraft(draft, id).price).toBeUndefined()
  })
})

describe('validateDraft', () => {
  const existing: BillingPeriod[] = [
    { id: 'bp_a', mode: 'subscription', planId: 'anthropic-pro', from: '2026-01-01', to: '2026-03-31', price: { amount: 20, currency: 'USD' } },
  ]

  test('a sound draft has no issues', () => {
    const draft = { ...emptyDraft(), planId: 'anthropic-max-5x', amount: '100', from: '2026-04-01' }
    expect(validateDraft(draft, existing, id)).toEqual([])
  })

  test('an overlap with an existing period is reported', () => {
    const draft = { ...emptyDraft(), planId: 'anthropic-max-5x', amount: '100', from: '2026-03-01' }
    expect(validateDraft(draft, existing, id).map(e => e.code)).toEqual(['overlap'])
  })

  test('editing a period does not report it overlapping itself', () => {
    const draft = draftFromPeriod(existing[0]!)
    expect(validateDraft(draft, existing, id)).toEqual([])
  })

  test('switching plans on their first day replaces the current period without an overlap', () => {
    const history = existing[0]!
    const current: BillingPeriod = { ...history, id: 'bp_current', from: '2026-04-01', to: undefined }
    const draft = applyPlan({ ...emptyDraft(), from: current.from }, plan('anthropic-max-5x'))
    const others = closeBefore([history, current], current.id, draft.from)
    expect(others).toEqual([history])
    expect(validateDraft(draft, others, id)).toEqual([])
    const saved = [...others, periodFromDraft(draft, id)]
    expect(saved).toHaveLength(2)
    expect(saved.some(p => p.id === current.id)).toBe(false)
    expect(splitTimeline(saved, current.from).current?.planId).toBe('anthropic-max-5x')
  })

  test('a missing amount is reported, not defaulted', () => {
    const draft = { ...emptyDraft(), planId: 'anthropic-max-20x', amount: '', from: '2026-04-01' }
    expect(validateDraft(draft, existing, id).map(e => e.code)).toEqual(['missing_price'])
  })

  test('an empty draft asks for the start date and the plan', () => {
    expect(validateDraft(emptyDraft(), [], id).map(e => e.code).sort()).toEqual(['missing_from', 'missing_plan', 'missing_price'])
  })
})

describe('describeError', () => {
  test('an overlap names the other plan, never its index', () => {
    // A list the user just re-sorted makes "period 2" meaningless.
    const msg = describeError({ code: 'overlap', withId: 'bp_a' }, 'en', 'Claude Pro')
    expect(msg).toContain('Claude Pro')
    expect(msg).not.toMatch(/\b\d+\b/)
  })

  test('falls back to a generic sentence when the other plan has no name', () => {
    expect(describeError({ code: 'overlap', withId: 'bp_a' }, 'en')).toContain('overlaps another')
  })

  test('every code has a distinct sentence in both languages', () => {
    const codes = [
      { code: 'missing_from' as const },
      { code: 'bad_day' as const, field: 'from' as const, value: 'x' },
      { code: 'inverted_range' as const, from: 'a', to: 'b' },
      { code: 'missing_plan' as const },
      { code: 'missing_label' as const },
      { code: 'missing_price' as const },
      { code: 'non_positive_price' as const, amount: 0 },
      { code: 'price_on_non_subscription' as const, mode: 'api' as const },
      { code: 'overlap' as const, withId: 'x' },
    ]
    for (const c of codes) {
      const en = describeError(c, 'en')
      const ptText = describeError(c, 'pt')
      expect(en.length).toBeGreaterThan(0)
      expect(ptText.length).toBeGreaterThan(0)
      expect(en).not.toBe(ptText)
    }
  })
})

describe('splitTimeline', () => {
  const sub = (id: string, from: string, to?: string): BillingPeriod => ({
    id, mode: 'subscription', planId: 'anthropic-pro', from, ...(to ? { to } : {}),
    price: { amount: 20, currency: 'USD' },
  })

  test('the ongoing plan is the current one', () => {
    const { current, history } = splitTimeline([sub('a', '2026-01-01', '2026-03-31'), sub('b', '2026-04-01')], '2026-08-13')
    expect(current?.id).toBe('b')
    expect(history.map(p => p.id)).toEqual(['a'])
  })

  test('a closed period covering today is current too', () => {
    const { current } = splitTimeline([sub('a', '2026-08-01', '2026-08-31')], '2026-08-13')
    expect(current?.id).toBe('a')
  })

  test('nothing covers today — the screen has no current plan to lead with', () => {
    const { current, history } = splitTimeline([sub('a', '2026-01-01', '2026-03-31')], '2026-08-13')
    expect(current).toBeNull()
    expect(history.map(p => p.id)).toEqual(['a'])
  })

  test('history reads backwards from now', () => {
    const { history } = splitTimeline(
      [sub('a', '2026-01-01', '2026-02-28'), sub('b', '2026-03-01', '2026-04-30'), sub('c', '2026-05-01')],
      '2026-08-13',
    )
    expect(history.map(p => p.id)).toEqual(['b', 'a'])
  })

  test('overlapping periods still render something — the latest start wins', () => {
    // Refused everywhere else, but preferences.json is hand-editable; the screen must not go
    // blank while the timeline warns separately.
    const { current } = splitTimeline([sub('a', '2026-01-01'), sub('b', '2026-06-01')], '2026-08-13')
    expect(current?.id).toBe('b')
  })

  test('a future period is not current', () => {
    expect(splitTimeline([sub('a', '2027-01-01')], '2026-08-13').current).toBeNull()
  })
})

describe('modeLabel', () => {
  test('says how you are billed, in words, in both languages', () => {
    expect(modeLabel('subscription', 'pt')).toBe('Assinatura')
    expect(modeLabel('api', 'pt')).toBe('Pago por token')
    expect(modeLabel('thirdparty', 'en')).toBe('Billed by a third party')
    expect(modeLabel('unknown', 'en')).toBe('Billing unknown')
  })
})

describe('parseAmountInput', () => {
  test('keeps what was typed — 100 is a hundred, not one', () => {
    // The "last two digits are cents" trick is maddening for prices that have no cents, which is
    // every plan in the catalog.
    expect(parseAmountInput('100')).toBe('100')
    expect(parseAmountInput('20')).toBe('20')
  })

  test('accepts either separator, because keyboards differ', () => {
    expect(parseAmountInput('24,99')).toBe('24.99')
    expect(parseAmountInput('24.99')).toBe('24.99')
  })

  test('drops grouping and keeps the last separator as decimal when 1-2 digits follow', () => {
    expect(parseAmountInput('1.234,56')).toBe('1234.56')
    expect(parseAmountInput('1,234.56')).toBe('1234.56')
    expect(parseAmountInput('1.5')).toBe('1.5')
  })

  test('a separator followed by three digits is GROUPING, not a decimal point', () => {
    // The field displays the grouped form, so this exact string comes back through the parser on
    // the next keystroke. Reading its last dot as a decimal would turn one million into one
    // thousand while the user watched.
    expect(parseAmountInput('1.234.567')).toBe('1234567')
    expect(parseAmountInput('1,234,567')).toBe('1234567')
  })

  test('strips anything that is not a digit or separator', () => {
    expect(parseAmountInput('R$ 100abc')).toBe('100')
    expect(parseAmountInput('')).toBe('')
  })

  test('a trailing separator survives so the decimal can be typed', () => {
    expect(parseAmountInput('24,')).toBe('24.')
  })
})

describe('formatAmountDisplay', () => {
  test('groups by the CURRENCY, not the interface language', () => {
    // Someone reading the app in English who pays in reais still expects R$ 1.234,56.
    expect(formatAmountDisplay('1234.56', 'BRL')).toBe('1.234,56')
    expect(formatAmountDisplay('1234.56', 'USD')).toBe('1,234.56')
  })

  test('an integer amount shows no decimal part', () => {
    expect(formatAmountDisplay('100', 'USD')).toBe('100')
    expect(formatAmountDisplay('1000', 'BRL')).toBe('1.000')
  })

  test('a half-typed decimal is left alone', () => {
    // Reformatting "1," to "1" the instant the comma is pressed makes the decimal impossible.
    expect(formatAmountDisplay('24.', 'BRL')).toBe('24,')
    expect(formatAmountDisplay('24.9', 'USD')).toBe('24.9')
  })

  test('empty stays empty rather than becoming a zero', () => {
    expect(formatAmountDisplay('', 'USD')).toBe('')
  })

  test('round-trips through the parser — what is displayed re-parses to itself', () => {
    // This is the invariant that keeps live formatting safe: every keystroke re-parses the string
    // the field is currently showing, so display → parse → display must be a fixed point.
    for (const [typed, currency] of [
      ['1.234,56', 'BRL'], ['1,234.56', 'USD'],
      ['1.234.567', 'BRL'], ['1,234,567', 'USD'],
      ['100', 'USD'], ['24,99', 'BRL'],
    ] as const) {
      const once = formatAmountDisplay(parseAmountInput(typed), currency)
      expect(once).toBe(typed)
      expect(formatAmountDisplay(parseAmountInput(once), currency)).toBe(typed)
    }
  })

  test('the symbol follows the currency', () => {
    expect(currencySymbol('BRL')).toBe('R$')
    expect(currencySymbol('USD')).toBe('$')
  })
})

describe('periodName', () => {
  test('generic catalog choices are localized in the picker and saved period names', () => {
    for (const [planId, pt, en] of [
      ['api-payg', 'API — paga pelo uso', 'API — pay as you go'],
      ['other', 'Outro plano', 'Other plan'],
    ] as const) {
      const entry = plan(planId)
      expect(catalogPlanName(entry, 'pt')).toBe(pt)
      expect(catalogPlanName(entry, 'en')).toBe(en)
      expect(periodName({ id: 'p', mode: entry.mode, from: '2026-10-17', planId }, 'pt')).toBe(pt)
    }
  })
  test('prefers the user label, then the catalog, then the raw id', () => {
    expect(periodName({ id: 'a', mode: 'subscription', from: '2026-01-01', label: 'Mine' })).toBe('Mine')
    expect(periodName({ id: 'a', mode: 'subscription', from: '2026-01-01', planId: 'anthropic-pro' })).toBe('Claude Pro')
    expect(periodName({ id: 'a', mode: 'subscription', from: '2026-01-01', planId: 'from-the-future' })).toBe('from-the-future')
  })
})

describe('formatPrice — a price never drops its cents', () => {
  test('BRL in pt-BR form, two decimals', () => {
    expect(formatPrice(110.5, 'BRL')).toBe('R$ 110,50')
    expect(formatPrice(1234.5, 'BRL')).toBe('R$ 1.234,50')
  })
  test('USD with a dot; whole amounts stay whole', () => {
    expect(formatPrice(19.9, 'USD')).toBe('$ 19.90')
    expect(formatPrice(550, 'BRL')).toBe('R$ 550')
  })
  test('the drawer field opens on 110,50, not 110,5', () => {
    const d = draftFromPeriod({ id: 'p', mode: 'subscription', from: '2026-10-01', price: { amount: 110.5, currency: 'BRL' } } as BillingPeriod)
    expect(formatAmountDisplay(d.amount, 'BRL')).toBe('110,50')
  })
})
