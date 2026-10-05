/**
 * memory-web.ts — B6.6 (§24.6): the person's view of the native runtime's memory.
 *
 * - `GET /api/memory` — every fact, current and closed (rule 1: inspectable in full);
 * - `DELETE /api/memory/:chainId` — forget one (rule 6: its versions leave memory and their statements
 *   are deleted).
 *
 * Experimental with the native harness (`native-gate.ts`): 403 with the flag off. Never on a central
 * (D14: memory stays on the machine). Facts are folded from the journal on every read
 * (`memory-service.ts`), so an answer is never staler than the journal.
 */
import { createMemoryService, type MemoryService } from './memory-service'
import { providerFlagOn } from './config'

// The native gate's rule and sentence (`native-gate.ts` on fix/native-experimental-gate, which this
// branch predates): ONE flag, the one `agentop experimental` command writes. When both branches meet,
// this becomes `import { EXPERIMENTAL_REFUSAL, nativeExperimentalOn } from './native-gate'`.
const EXPERIMENTAL_REFUSAL = {
  error: 'experimental',
  sentence: 'The native Agentistics harness is still in development and is not available in this version.',
  sentencePt: 'O harness nativo do Agentistics ainda está em desenvolvimento e não está disponível nesta versão.',
} as const
const nativeExperimentalOn = () => providerFlagOn()

export interface MemoryWebDeps {
  central: boolean
  nativeOn: boolean
  service: () => Promise<MemoryService | null>
}

export interface MemoryAnswer { status: number; body: unknown }

const CHAIN = /^mem_[0-9a-z]{8,40}$/

export async function handleMemoryRequest(req: Request, url: URL, d: MemoryWebDeps): Promise<MemoryAnswer> {
  if (!d.nativeOn) return { status: 403, body: { ...EXPERIMENTAL_REFUSAL } }
  if (d.central) return { status: 409, body: { error: 'unsupported_on_central', sentence: 'memory stays on the machine it was noted on; a central holds none.' } }
  const svc = await d.service()
  if (!svc) return { status: 503, body: { error: 'journal_unavailable', sentence: 'memory needs the journal, and it is not open on this machine.' } }
  if (url.pathname === '/api/memory') {
    if (req.method !== 'GET') return { status: 405, body: { error: 'method_not_allowed' } }
    return { status: 200, body: { facts: await svc.list() } }
  }
  const chainId = decodeURIComponent(url.pathname.slice('/api/memory/'.length))
  if (!CHAIN.test(chainId)) return { status: 404, body: { error: 'not_found' } }
  if (req.method !== 'DELETE') return { status: 405, body: { error: 'method_not_allowed' } }
  const out = await svc.forget(chainId)
  if (!out.ok) return out.reason === 'not-found' ? { status: 404, body: { error: 'not_found', sentence: `no remembered fact ${chainId}.` } } : { status: 503, body: { error: 'journal_unavailable', sentence: 'the journal could not take the change.' } }
  return { status: 200, body: { forgotten: chainId, versions: out.versions } }
}

let live: MemoryService | null = null

/** The server's own service: the journal opened once, lazily; the content store beside it. */
export async function liveMemoryDeps(central: boolean): Promise<MemoryWebDeps> {
  return {
    central,
    nativeOn: nativeExperimentalOn(),
    service: async () => {
      if (live) return live
      const [config, { openJournal }, { CURRENT_VERSION }] = await Promise.all([import('./config'), import('./journal/journal'), import('./version')])
      if (!config.JOURNAL_ENABLED) return null
      const journal = await openJournal()
      if (journal.status().state !== 'open') return null
      live = createMemoryService({ journal: async () => journal, contentDir: config.CONTENT_DIR, adapterVersion: `agentistics-server@${CURRENT_VERSION}` })
      return live
    },
  }
}
