/**
 * useStagedFire — FIRING a staged session (t-918cc82233), the one implementation every surface that
 * offers "Fire" calls: the delivery's own page (`DeliveryDetail`) and the board's table
 * (`TaskTable`'s inline subtask rows). It used to live inside `DeliveryDetail` alone, which is why the
 * table could compose a draft but never fire one — a second copy would be a second set of spawn rules.
 *
 * Two paths, decided by whether the draft already names BOTH a harness and a folder, exactly the split
 * `SessionsPage.tsx`'s `selectPreset` draws for a `SessionPreset`: a direct-launch confirm, or the
 * ordinary wizard pre-filled with whatever the draft DOES have, seeded to auto-file under this exact
 * subtask once the session exists.
 */

import { useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { composePromptWithPaths } from '@agentistics/core'
import { sessionPath } from '../../lib/sessionRoute'
import { forcedNote, isAdmissionRefusal } from '../../lib/spawnAdmission'
import { pushNotification } from '../../lib/notifications'
import { markSessionPending } from '../../lib/pendingSessionStore'
import { NewSessionModal } from '../sessions/NewSessionModal'
import { StagedSessionLaunchConfirm } from './StagedSessionLaunchConfirm'
import {
  attachSession, materializeStagedAttachments, type Subtask, type TaskFile,
} from '../../lib/tasks'
import type { Lang } from './copy'

export interface FireTarget {
  taskId: string
  subtask: Subtask
  files: readonly TaskFile[]
  /** Re-read the delivery once the session exists and is filed. */
  reload: () => Promise<unknown> | void
}

export interface BlockedFiling { taskId: string; subtaskId: string; sessionId: string; blockedBy: string[] }

export function useStagedFire(lang: Lang, onBlocked?: (b: BlockedFiling) => void): {
  startFire: (t: FireTarget) => Promise<void>
  /** The subtask id whose attachments are being materialized — its Fire row reads busy. */
  preparingId: string | null
  element: ReactNode
} {
  const navigate = useNavigate()
  const [firing, setFiring] = useState<FireTarget | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** Only after a memory-budget refusal on THIS request — see `StagedSessionLaunchConfirm.onForce`. */
  const [forceable, setForceable] = useState(false)
  const [prefill, setPrefill] = useState<{ target: FireTarget; prompt: string } | null>(null)
  const [preparingId, setPreparingId] = useState<string | null>(null)

  async function startFire(t: FireTarget) {
    const draft = t.subtask.stagedSession
    if (!draft) return
    setError(null)
    setForceable(false)
    if (draft.harness && draft.cwd) { setFiring(t); return }
    // The wizard needs the composed prompt UP FRONT: `initialPreset` seeds its textarea once.
    setPreparingId(t.subtask.id)
    const paths = await materializeStagedAttachments(lang, draft.attachmentIds ?? [], t.files)
    setPreparingId(null)
    setPrefill({ target: t, prompt: composePromptWithPaths(paths, draft.prompt) })
  }

  async function confirmFire(force = false) {
    if (!firing) return
    const t = firing
    const draft = t.subtask.stagedSession!
    setBusy(true)
    setError(null)
    try {
      const paths = await materializeStagedAttachments(lang, draft.attachmentIds ?? [], t.files)
      // The SAME route the wizard and the preset shelf call — never a second, unvalidated path.
      const res = await fetch(`/api/fleet/new?lang=${lang}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          harness: draft.harness,
          cwd: draft.cwd,
          ...(draft.model ? { model: draft.model } : {}),
          ...(draft.effort ? { effort: draft.effort } : {}),
          prompt: composePromptWithPaths(paths, draft.prompt),
          label: t.subtask.title,
          ...(force ? { force: true as const } : {}),
        }),
      })
      const json = await res.json() as { ok: boolean; message: string; id?: string }
      if (!json.ok) {
        setError(json.message)
        setForceable(isAdmissionRefusal(json))
        setBusy(false)
        return
      }
      const note = forcedNote(json)
      if (note) pushNotification({ type: 'success', code: 'sessions.forced_start', meta: { note } })
      setFiring(null)
      setBusy(false)
      setForceable(false)
      if (json.id) {
        // The session EXISTS now — the first moment its filing can actually be attempted.
        const attach = await attachSession(t.taskId, json.id, t.subtask.id)
        if (!attach.ok && attach.reason === 'blocked') {
          onBlocked?.({ taskId: t.taskId, subtaskId: t.subtask.id, sessionId: json.id, blockedBy: attach.blockedBy ?? [] })
        }
        await t.reload()
        navigate(sessionPath(json.id))
      }
    } catch {
      setError(lang === 'pt' ? 'Erro de rede ao falar com esta máquina.' : 'Network error talking to this machine.')
      setForceable(false)
      setBusy(false)
    }
  }

  const element = (
    <>
      {firing && (
        <StagedSessionLaunchConfirm
          lang={lang}
          subtaskTitle={firing.subtask.title}
          draft={firing.subtask.stagedSession!}
          attachmentNames={(firing.subtask.stagedSession!.attachmentIds ?? [])
            .map(fid => firing.files.find(f => f.id === fid)?.name)
            .filter((n): n is string => !!n)}
          busy={busy}
          error={error}
          forceable={forceable}
          onCancel={() => { setFiring(null); setForceable(false) }}
          onConfirm={() => void confirmFire()}
          onForce={() => void confirmFire(true)}
        />
      )}
      {prefill && (
        <NewSessionModal
          lang={lang}
          initialTaskId={prefill.target.taskId}
          initialSubtaskId={prefill.target.subtask.id}
          initialPreset={{
            ...(prefill.target.subtask.stagedSession?.harness
              ? { harness: prefill.target.subtask.stagedSession.harness } : {}),
            prompt: prefill.prompt,
            ...(prefill.target.subtask.stagedSession?.model
              ? { model: prefill.target.subtask.stagedSession.model } : {}),
            ...(prefill.target.subtask.stagedSession?.effort
              ? { effort: prefill.target.subtask.stagedSession.effort } : {}),
            label: prefill.target.subtask.title,
          }}
          onClose={() => setPrefill(null)}
          onStarted={(sessionId, started) => {
            if (sessionId) markSessionPending({ id: sessionId, ...started })
            const t = prefill.target
            setPrefill(null)
            void t.reload()
          }}
        />
      )}
    </>
  )

  return { startFire, preparingId, element }
}
