/**
 * DOCKER.AMBIENTES S2 — is this volume OURS? (SPEC-r3 §3.2, P11). PURE.
 *
 * Measured (P11): `docker volume create <name>` over an existing name answers success, keeps the OLD labels and
 * the OLD `CreatedAt`. So `create` proves nothing. The proof is three-part: (a) the name did not exist BEFORE;
 * (b) after, the labels are exactly the intent's and `CreatedAt` is not older than the intent (1 s resolution);
 * (c) the marker `{attemptId, nonce}` the init container wrote at the volume ROOT matches the ledger. Commands only
 * ever mount sub-paths, so repo code cannot reach the marker. Precondition, stated: whoever holds the Docker socket
 * is root; this detects an ACCIDENTAL replacement (another tool, another agentop), not a deliberate forgery by root.
 */

export interface VolumeIntent {
  name: string
  attemptId: string
  labels: Record<string, string>
  /** ISO time the intent was written, before `create`. */
  createdAfter: string
}

export type VolumeVerdict = { ok: true } | { ok: false; code: 'volume_preexistente' | 'volume_nao_nosso'; detail: string }

/** Step (a): the `volume inspect` BEFORE create. Anything but "no such volume" refuses — nothing is created. */
export function beforeCreate(inspectExitCode: number, stderr: string): VolumeVerdict {
  if (inspectExitCode === 0) return { ok: false, code: 'volume_preexistente', detail: 'a volume with this name already exists; nothing was created and it is not adopted' }
  if (/no such volume/i.test(stderr)) return { ok: true }
  return { ok: false, code: 'volume_preexistente', detail: `could not prove the name is free (${stderr.trim().slice(0, 120) || 'inspect failed'})` }
}

const truncSec = (iso: string): number => Math.floor(Date.parse(iso) / 1000)

/** Step (b): the `volume inspect` AFTER create. */
export function afterCreate(inspect: { Name?: string; Labels?: Record<string, string> | null; CreatedAt?: string } | null, intent: VolumeIntent): VolumeVerdict {
  if (!inspect) return { ok: false, code: 'volume_nao_nosso', detail: 'the volume is not there after create' }
  if (inspect.Name !== intent.name) return { ok: false, code: 'volume_nao_nosso', detail: `name ${inspect.Name}` }
  const have = inspect.Labels ?? {}
  const want = intent.labels
  const keys = new Set([...Object.keys(have).filter(k => k.startsWith('agentistics.')), ...Object.keys(want)])
  for (const k of keys) if (have[k] !== want[k]) return { ok: false, code: 'volume_nao_nosso', detail: `label ${k} is ${JSON.stringify(have[k] ?? null)}, expected ${JSON.stringify(want[k] ?? null)}` }
  const created = inspect.CreatedAt ? truncSec(inspect.CreatedAt) : NaN
  if (!Number.isFinite(created) || created < truncSec(intent.createdAfter)) return { ok: false, code: 'volume_nao_nosso', detail: `CreatedAt ${inspect.CreatedAt} is older than the intent (${intent.createdAfter})` }
  return { ok: true }
}

/** Step (c): the marker read back from the volume root (by a read-only init container). */
export function markerMatches(markerText: string | null, attemptId: string, nonce: string): VolumeVerdict {
  try {
    const m = JSON.parse(markerText ?? '') as { attemptId?: string; nonce?: string }
    if (m.attemptId === attemptId && m.nonce === nonce) return { ok: true }
  } catch {}
  return { ok: false, code: 'volume_nao_nosso', detail: 'the volume marker does not match the ledger' }
}
