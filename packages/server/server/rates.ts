import { MODEL_PRICING } from '@agentistics/core'
import type { PriceEntry, RatesCache } from '@agentistics/core'
import { fetchCommunityPricing, mergePricingLayers, type PriceOrigin } from './pricing-community'
import { fetchOpenAiPricing, fetchGooglePricing } from './pricing-official'
import { vetOfficialPricing } from './pricing-consensus'

// Use MODEL_PRICING from src/lib/types.ts as the canonical fallback
const FALLBACK_PRICING: Record<string, PriceEntry> = MODEL_PRICING

/** Model name (as shown in pricing table) → canonical model ID */
const PRICING_PAGE_MODEL_MAP: Record<string, string> = {
  // Newer rows first — the map is what lets the live scrape reach a model at all. Missing entries
  // are silent: `opus 4.8` and `opus 5` were absent, so the scrape never returned them and both
  // fell through to the shared fallback (Sonnet's $3/$15) instead of Opus's $5/$25.
  'fable 5.1':  'claude-fable-5-1',
  'fable 5':    'claude-fable-5',
  'mythos 5':   'claude-mythos-5',
  'opus 5.5':   'claude-opus-5-5',
  'opus 5':     'claude-opus-5',
  'opus 4.8':   'claude-opus-4-8',
  'opus 4.7':   'claude-opus-4-7',
  'sonnet 5':   'claude-sonnet-5',
  'opus 4.6':   'claude-opus-4-6',
  'opus 4.5':   'claude-opus-4-5-20251101',
  'opus 4.1':   'claude-opus-4-1-20250805',
  'opus 4':     'claude-opus-4-20250514',
  'sonnet 4.6': 'claude-sonnet-4-6',
  'sonnet 4.5': 'claude-sonnet-4-5-20250929',
  'sonnet 4':   'claude-sonnet-4-20250514',
  'haiku 4.5':  'claude-haiku-4-5-20251001',
  'haiku 3.5':  'claude-haiku-3-5-20241022',
  'haiku 3':    'claude-3-haiku-20240307',
}

/** Verified by hand against platform.claude.com on 2026-09-25 (and equal to MODEL_PRICING). A
 *  parse must reproduce ALL FOUR of these or the whole page is refused — the same anchoring
 *  `pricing-official.ts` applies to OpenAI and Google. Without it the page reordered its columns
 *  (Output moved from last to second) and the positional reader priced every cache READ at the 1h
 *  cache-WRITE rate, 20x too high: cache reads are ~96 % of the volume, so every cost surface
 *  jumped ~16x overnight while looking perfectly well-formed. */
const ANTHROPIC_ANCHOR = { model: 'claude-sonnet-5', input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }

type PriceColumn = 'input' | 'output' | 'cacheWrite' | 'cacheRead'

/** Which price each header cell names. `1h` writes are deliberately unmapped: the table prices the
 *  5-minute TTL, and `calcCost` splits the 1h share itself from the transcript's own counters. */
function columnOf(label: string): PriceColumn | null {
  const l = label.toLowerCase()
  if (/\b1h\b|1 ?hour/.test(l)) return null
  if (/\b5m\b|5 ?min/.test(l)) return 'cacheWrite'
  if (/hit|cache read/.test(l)) return 'cacheRead'
  if (/output|saída|saida/.test(l)) return 'output'
  if (/input|entrada/.test(l)) return 'input'
  return null
}

const cellText = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()

/** A page key names a model only when it is not the prefix of a longer version: "opus 5" must not
 *  claim the "Opus 5.5" row, which is a different model at a different price. */
const namesModel = (cell: string, key: string) => {
  const at = cell.indexOf(key)
  return at >= 0 && !/^[.\d]/.test(cell.slice(at + key.length))
}

export function parseAnthropicPricing(html: string): Record<string, PriceEntry> | null {
  const pricing: Record<string, PriceEntry> = {}
  // Longer keys first so "opus 4.6" matches before "opus 4"
  const keys = Object.keys(PRICING_PAGE_MODEL_MAP).sort((a, b) => b.length - a.length)

  // Columns are read by their HEADER, never by position — the page has already reordered them once.
  for (const table of html.match(/<table[\s\S]*?<\/table>/gi) ?? []) {
    let columns: Map<PriceColumn, number> | null = null
    for (const rowMatch of table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const row = rowMatch[1]!
      const headers = [...row.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map(m => cellText(m[1]!))
      if (headers.length > 0) {
        const found = new Map<PriceColumn, number>()
        headers.forEach((h, i) => { const c = columnOf(h); if (c && !found.has(c)) found.set(c, i) })
        // The last header row that names all four is the one the data rows line up with.
        if (found.size === 4) columns = found
        continue
      }
      if (!columns) continue
      const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m => cellText(m[1]!))
      const nameCell = (cells[0] ?? '').toLowerCase()
      if (!nameCell.includes('claude')) continue
      const key = keys.find(k => namesModel(nameCell, k))
      const modelId = key ? PRICING_PAGE_MODEL_MAP[key] : undefined
      if (!modelId) continue

      const amount = (c: PriceColumn) => {
        const m = /\$\s?([\d,]+(?:\.\d+)?)/.exec(cells[columns!.get(c)!] ?? '')
        return m ? Number(m[1]!.replace(/,/g, '')) : NaN
      }
      const entry = { input: amount('input'), output: amount('output'), cacheRead: amount('cacheRead'), cacheWrite: amount('cacheWrite') }
      if (Object.values(entry).some(v => !(v > 0))) continue
      pricing[modelId] = entry
    }
  }

  const a = pricing[ANTHROPIC_ANCHOR.model]
  const close = (x: number, y: number) => Math.abs(x - y) < 0.001
  if (!a || !close(a.input, ANTHROPIC_ANCHOR.input) || !close(a.output, ANTHROPIC_ANCHOR.output)
    || !close(a.cacheRead, ANTHROPIC_ANCHOR.cacheRead) || !close(a.cacheWrite, ANTHROPIC_ANCHOR.cacheWrite)) {
    return null
  }
  return Object.keys(pricing).length >= 3 ? pricing : null
}

export async function fetchBrlRate(): Promise<number> {
  try {
    const res = await fetch('https://economia.awesomeapi.com.br/json/last/USD-BRL', {
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json = await res.json() as Record<string, { bid: string }>
    const rate = parseFloat(json?.USDBRL?.bid ?? '')
    if (!isNaN(rate) && rate > 1 && rate < 20) return rate
  } catch (err) {
    console.warn('[rates] BRL fetch failed:', String(err))
  }
  return 5.70 // fallback
}

/** Anthropic's own page, for Claude models only. Returns just what it parsed — the layering below
 *  decides how it combines with the other sources. */
export async function fetchAnthropicPricing(): Promise<{ pricing: Record<string, PriceEntry>; source: 'live' | 'fallback' }> {
  try {
    const res = await fetch('https://platform.claude.com/docs/en/about-claude/pricing', {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; agentistics/1.0; +https://github.com)' },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const html = await res.text()
    const parsed = parseAnthropicPricing(html)
    if (parsed) {
      console.log('[rates] Anthropic pricing fetched live:', Object.keys(parsed).join(', '))
      // ONLY what the page actually stated. Merging the built-in table in here used to relabel
      // every fallback row as "official", which is precisely the false confidence this whole
      // provenance chain exists to prevent.
      return { pricing: parsed, source: 'live' }
    }
    console.warn('[rates] Anthropic pricing parse returned no results, using fallback')
  } catch (err) {
    console.warn('[rates] Anthropic pricing fetch failed:', String(err))
  }
  return { pricing: FALLBACK_PRICING, source: 'fallback' }
}

let ratesCache: RatesCache | null = null
const RATES_TTL_MS = 30 * 60 * 1000 // 30 minutes

/** Per-model provenance for the merged table, so the UI can show where each number came from
 *  instead of implying every row is equally fresh. Kept alongside the cache, not inside
 *  RatesCache, so the existing /api/rates shape is untouched. */
let originsCache: Record<string, PriceOrigin> = {}
let communityFetchedAt = 0
let communityOk = false

export function getPricingOrigins(): {
  origins: Record<string, PriceOrigin>
  communityFetchedAt: number
  communityOk: boolean
} {
  return { origins: originsCache, communityFetchedAt, communityOk }
}

export async function getRates(): Promise<RatesCache> {
  const now = Date.now()
  if (ratesCache && now - ratesCache.fetchedAt < RATES_TTL_MS) return ratesCache

  const [brlRate, anthropic, community, openai, google] = await Promise.all([
    fetchBrlRate(),
    fetchAnthropicPricing(),
    fetchCommunityPricing(),
    fetchOpenAiPricing(),
    fetchGooglePricing(),
  ])

  // Each vendor page is independent: one failing its anchor drops only that vendor to the
  // community figures, never the others.
  const scraped = (anthropic.source === 'live' || openai || google)
    ? { ...(anthropic.source === 'live' ? anthropic.pricing : {}), ...(openai ?? {}), ...(google ?? {}) }
    : null

  // A scraped row must AGREE with the layers below it before it wins (pricing-consensus.ts). The
  // prior is built-in + community, so a scrape bug falls back to a price that was already right.
  let official: Record<string, PriceEntry> | null = null
  if (scraped) {
    const { accepted, rejected } = vetOfficialPricing(scraped, { ...FALLBACK_PRICING, ...(community ?? {}) })
    if (rejected.length > 0) {
      console.warn(`[rates] refused ${rejected.length} official price row(s) that disagree with the other sources: `
        + rejected.map(r => r.reason === 'drift' ? `${r.id} (${r.field})` : `${r.id} (invalid row)`).join(', '))
    }
    official = Object.keys(accepted).length > 0 ? accepted : null
  }

  // Trust order, lowest first. The built-in table is the floor and is always present, so a source
  // that fails or returns junk costs us freshness, never the ability to price anything.
  const merged = mergePricingLayers({
    builtin: FALLBACK_PRICING,
    community,
    official,
  })

  const pricing: Record<string, PriceEntry> = {}
  const origins: Record<string, PriceOrigin> = {}
  for (const [id, { price, origin }] of Object.entries(merged)) {
    pricing[id] = price
    origins[id] = origin
  }
  originsCache = origins
  communityOk = community !== null
  if (community) communityFetchedAt = now

  const pricingSource: 'live' | 'fallback' =
    official || community ? 'live' : 'fallback'

  ratesCache = { fetchedAt: now, brlRate, pricing, pricingSource }
  const counts = Object.values(origins).reduce<Record<string, number>>((a, o) => {
    a[o] = (a[o] ?? 0) + 1; return a
  }, {})
  console.log(`[rates] BRL=${brlRate.toFixed(2)} models=${Object.keys(pricing).length} `
    + `official=${counts.official ?? 0} community=${counts.community ?? 0} builtin=${counts.builtin ?? 0}`)
  return ratesCache
}
