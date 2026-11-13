/**
 * ownerProof.ts — the owner's fresh proof for a delivery move (ENTREGA.GARANTIDA §2.3.1), from the browser.
 *
 * `requestOwnerGrant` asks the vault (`POST /api/vault/delivery-owner`) to prove the owner NOW: the service raises
 * the vault's own gesture (Windows Hello / Touch ID / a key) or, for a vault confirmed by its password, `vaultApi`
 * mounts the ONE password prompt the app already has and asks again. The reply is a single-use grant scoped to one
 * piece + move; `withOwnerGrant` sends the delivery request with it in `X-Agentop-Owner-Grant` — a header, never
 * a URL. Nothing here stores the grant or the password.
 */
import { vaultPost } from './vaultApi'

/** MUST equal the server's `ownerMove` (`delivery/principal.ts`): the grant is scoped to this exact spelling. */
export function ownerMove(action: string, detail?: string): string {
  return `${action}${detail ? `:${detail}` : ''}`
}

export const OWNER_GRANT_HEADER = 'X-Agentop-Owner-Grant'

export type OwnerGrant = { ok: true; grant: string } | { ok: false; code: string; sentence: string }

export async function requestOwnerGrant(pieceKey: string, move: string): Promise<OwnerGrant> {
  const r = await vaultPost<{ ownerGrant: string }>('/api/vault/delivery-owner', { pieceKey, move })
  if (r.ok && typeof r.ownerGrant === 'string') return { ok: true, grant: r.ownerGrant }
  return { ok: false, code: r.ok ? 'failed' : r.code, sentence: r.ok ? '' : r.sentence }
}

/** The refusals a delivery request answers when the owner's proof is what is missing. */
export const needsOwnerProof = (error: unknown): boolean => error === 'owner_proof_required' || error === 'grant_invalid'

export interface OwnerCall { status: number; body: { error?: string; sentence?: string } & Record<string, unknown> }

/**
 * POST a delivery move. Sent plain first (legacy mode answers the browser as itself); when the server says the
 * owner's proof is required it asks the vault, then repeats the SAME request with the single-use grant.
 */
export async function postWithOwnerProof(
  url: string, body: unknown, scope: { pieceKey: string; move: string }, onProving?: () => void, pt = false, ask: typeof requestOwnerGrant = requestOwnerGrant,
): Promise<OwnerCall> {
  const send = async (grant?: string): Promise<OwnerCall> => {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(grant ? { [OWNER_GRANT_HEADER]: grant } : {}) }, body: JSON.stringify(body) })
    return { status: res.status, body: await res.json().catch(() => ({})) as OwnerCall['body'] }
  }
  const first = await send()
  if (first.status < 400 || !needsOwnerProof(first.body.error)) return first
  onProving?.()
  const g = await ask(scope.pieceKey, scope.move)
  if (!g.ok) return { status: 403, body: { error: g.code, sentence: g.sentence || ownerProofSentence(g.code, pt) } }
  return send(g.grant)
}

/**
 * S0d.7 (QA F7): the request-principal and guard refusals in plain words, EN and PT. The server answers these codes
 * with an English sentence; the person reads one of these instead. The server's vault spells one code with hyphens
 * (`owner-proof-local-only`) and the delivery route with underscores (`owner_proof_local_only`): both are here.
 */
const REFUSALS: Record<string, { en: string; pt: string }> = {
  owner_proof_required: { en: 'This needs you to confirm it is you, with the vault (password, Windows Hello or Touch ID).', pt: 'Isto pede que você confirme que é você, pelo cofre (senha, Windows Hello ou Touch ID).' },
  so_o_dono: { en: 'Only the owner can do this — not a session and not an unidentified caller.', pt: 'Só o dono pode fazer isto — nem uma sessão nem quem não se identificou.' },
  so_o_lider: { en: 'Only the leader of this piece (or the owner) can do this.', pt: 'Só o líder desta entrega (ou o dono) pode fazer isto.' },
  reserved_actor: { en: 'The names "owner", "you", "dono" and "flow:…" are decided by agentistics, not typed into a request.', pt: 'Os nomes "owner", "you", "dono" e "flow:…" são decididos pelo agentistics, não escritos num pedido.' },
  unverified_sender: { en: 'The session that sent this could not prove which session it is. Nothing was changed.', pt: 'A sessão que enviou isto não conseguiu provar qual sessão é. Nada foi alterado.' },
  grant_scope: { en: 'That confirmation was for a different item or action. Confirm again for this one.', pt: 'Essa confirmação era para outro item ou outra ação. Confirme de novo para esta.' },
  grant_invalid: { en: 'That confirmation expired or was already used. Confirm again.', pt: 'Essa confirmação expirou ou já foi usada. Confirme de novo.' },
  owner_proof_local_only: { en: 'This confirmation can only be given on this computer.', pt: 'Esta confirmação só pode ser feita neste computador.' },
  guard_busy: { en: 'Another agentistics process is writing the board right now. Try again in a moment.', pt: 'Outro processo do agentistics está gravando o quadro agora. Tente de novo em instantes.' },
  lock_order: { en: 'An internal ordering rule refused this write; nothing was changed. Please report it.', pt: 'Uma regra interna de ordem recusou esta gravação; nada foi alterado. Por favor, avise.' },
  json_required: { en: 'This change was sent in a format the board does not accept. Nothing was changed.', pt: 'Esta alteração foi enviada num formato que o quadro não aceita. Nada foi alterado.' },
}

/** The localized sentence for a refusal code, or `null` when this module does not know the code. */
export function refusalSentence(code: unknown, pt: boolean): string | null {
  if (typeof code !== 'string') return null
  const r = REFUSALS[code.replace(/-/g, '_')]
  return r ? (pt ? r.pt : r.en) : null
}

/** What to show for a refused request: our words for a known code, else the server's sentence, else the code. */
export function refusalText(body: { error?: unknown; sentence?: unknown; message?: unknown } | null | undefined, pt: boolean, status?: number): string {
  return refusalSentence(body?.error, pt)
    ?? (typeof body?.sentence === 'string' ? body.sentence : typeof body?.message === 'string' ? body.message : typeof body?.error === 'string' ? body.error : String(status ?? ''))
}

/** Plain words for the refusals of the owner's proof. */
export function ownerProofSentence(code: string, pt: boolean): string {
  const known = refusalSentence(code, pt)
  if (known) return known
  switch (code) {
    case 'owner-proof-unavailable': return pt ? 'O cofre só tem proteção silenciosa. Adicione uma senha ou Windows Hello / Touch ID ao cofre.' : 'The vault has silent protection only. Add a password or Windows Hello / Touch ID to the vault.'
    case 'locked': return pt ? 'Destranque o cofre para confirmar que é você.' : 'Unlock the vault to confirm it is you.'
    case 'stepup-frozen': return pt ? 'O cofre está congelado. Veja o aviso no cofre.' : 'The vault is frozen. See the notice in the vault.'
    case 'recovery-mode': return pt ? 'O cofre está em modo de recuperação.' : 'The vault is in recovery mode.'
    case 'owner-proof-local-only': return pt ? 'Esta confirmação só pode ser feita neste computador.' : 'This confirmation can only be given on this computer.'
    case 'presence-cancelled': return pt ? 'Confirmação cancelada. Nada foi alterado.' : 'Confirmation cancelled. Nothing was changed.'
    default: return pt ? 'Não foi possível confirmar que é você. Nada foi alterado.' : 'Could not confirm it is you. Nothing was changed.'
  }
}
