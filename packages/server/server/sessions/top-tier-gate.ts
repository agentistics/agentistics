/**
 * top-tier-gate.ts — FLUXO.AVISOS 5: the owner's per-provider cap on TOP-TIER workers, for every `agentop session` door.
 *
 * Until now only the delivery flow's `vaga` gate (`judgeVaga`) asked: `agentop session <harness>` start / batch / reopen did
 * not, so a leader could fill a provider's top tier from the command line while the flow believed it was holding the cap.
 * The decision is the SAME pure `topTierFull` the slot gate uses. A refusal is a sentence naming the count and the cap, and
 * `--force` overrides it — printed, never silent, exactly like the memory gate's override note.
 *
 * Only WORKERS count and only WORKERS are refused: a leader (an explicit `--role leader` or a hand-off) never reserves
 * a worker slot, which is how `judgeVaga` counts too.
 */
import { defaultGateFacts, isTopTier, topTierFull, type SessionFact } from '../delivery/gates'

export interface TopTierRequest { harness: string; model?: string | undefined; /** 'leader' is never refused. */ role?: string | undefined }
export interface TopTierRefusal { harness: string; model: string; running: number; cap: number; adding: number }

/** PURE. The first provider whose top tier would overflow, counting every worker request in `requests` together. */
export function topTierRefusal(requests: readonly TopTierRequest[], sessions: readonly SessionFact[], capOf: (harness: string) => number): TopTierRefusal | null {
  const byHarness = new Map<string, { model: string; adding: number }>()
  for (const r of requests) {
    if (r.role === 'leader' || !r.model || !isTopTier(r.harness, r.model)) continue
    const cur = byHarness.get(r.harness)
    byHarness.set(r.harness, { model: cur?.model ?? r.model, adding: (cur?.adding ?? 0) + 1 })
  }
  for (const [harness, { model, adding }] of byHarness) {
    const full = topTierFull(harness, model, sessions, capOf(harness), adding)
    if (full) return { harness, model, running: full.running, cap: full.cap, adding }
  }
  return null
}

export function topTierMessage(r: TopTierRefusal, lang: 'en' | 'pt'): string {
  return lang === 'pt'
    ? `Nada foi iniciado: o teto de workers top-tier de ${r.harness} está cheio (${r.running} rodando, teto ${r.cap}; este pedido acrescentaria ${r.adding} de ${r.model}). Espere uma terminar, use um modelo de outra faixa, ou --force para iniciar mesmo assim.`
    : `Nothing was started: the ${r.harness} top-tier worker cap is full (${r.running} running, cap ${r.cap}; this request would add ${r.adding} of ${r.model}). Wait for one to finish, use a model of another tier, or pass --force to start anyway.`
}

export function topTierOverrideNote(r: TopTierRefusal, lang: 'en' | 'pt'): string {
  return lang === 'pt'
    ? `--force: o teto de top-tier de ${r.harness} foi ignorado (${r.running} rodando, teto ${r.cap}); iniciando mesmo assim.`
    : `--force: the ${r.harness} top-tier cap was overridden (${r.running} running, cap ${r.cap}); starting anyway.`
}

export function topTierRefusalBody(r: TopTierRefusal, lang: 'en' | 'pt'): Record<string, unknown> {
  return { started: false, code: 'top-tier-cap', harness: r.harness, model: r.model, running: r.running, cap: r.cap, adding: r.adding, message: topTierMessage(r, lang) }
}

/** The IO half: read the running workers and the owner's cap once, decide, print. Returns true when the command must stop. */
export async function checkTopTier(
  requests: readonly TopTierRequest[], force: boolean, lang: 'en' | 'pt', json: boolean,
  facts: Pick<ReturnType<typeof defaultGateFacts>, 'sessions' | 'topCap'> = defaultGateFacts(),
): Promise<boolean> {
  const harnesses = [...new Set(requests.filter(r => r.role !== 'leader' && r.model && isTopTier(r.harness, r.model)).map(r => r.harness))]
  if (harnesses.length === 0) return false
  // A cap or a fleet that cannot be read must never block a start: the gate is a courtesy over evidence, not a lock.
  const sessions = await facts.sessions().catch(() => null)
  if (!sessions) return false
  const caps = new Map<string, number>()
  for (const h of harnesses) caps.set(h, await facts.topCap(h).catch(() => Number.POSITIVE_INFINITY))
  const refusal = topTierRefusal(requests, sessions, h => caps.get(h) ?? Number.POSITIVE_INFINITY)
  if (!refusal) return false
  if (force) { console.error(topTierOverrideNote(refusal, lang)); return false }
  if (json) console.log(JSON.stringify(topTierRefusalBody(refusal, lang), null, 2))
  else console.error(topTierMessage(refusal, lang))
  return true
}
