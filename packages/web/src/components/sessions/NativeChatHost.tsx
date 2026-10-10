/**
 * NativeChatHost — a NATIVE Agentistics session's conversation, drawn by the STANDARD `SessionChat`
 * (UI.UNIFY). It owns nothing visual: it opens the runtime's stream (`useNativeSession`), shapes it
 * through the pure `nativeChatSource.ts` into the `ChatSource` seam, and hands it over. The composer,
 * the bubbles, the working note, the bottom bar and every shortcut are `SessionChat`'s own, exactly
 * as for Claude, Codex or any other harness; the two native-only pieces arrive as SLOTS —
 * `NativeApprovalCard` where `ApprovalCard` is drawn, `NativeRunsStrip` in the bottom bar.
 *
 * A component rather than a branch inside `SessionChat` because the hook must be called
 * unconditionally: the panel mounts this only for a native id, so a CLI session never opens a
 * runtime stream.
 */
import { useCallback, useMemo } from 'react'
import { SessionChat, type SessionChatProps } from './SessionChat'
import { NativeApprovalCard } from './NativeApprovalCard'
import { NativeRunsStrip } from './NativeRunsStrip'
import type { ChatAct, ChatSource } from './chatSource'
import { useNativeSession } from '../../hooks/useNativeSession'
import { nativeChatItems } from '../../lib/nativeChat'
import { nativeAsks, nativeChatTurns, nativeControls, nativeProviderKey, nativeLiveReasoning, nativeLiveText, nativeRunningTools, nativeSendParts } from '../../lib/nativeChatSource'
import { useNativeProviders } from '../../hooks/useNativeProviders'
import { nativeAct } from '../../lib/nativeFleet'
import { nativeSessionStats } from '../../lib/nativeStats'

export function NativeChatHost(props: Omit<SessionChatProps, 'source'>) {
  const { session, lang } = props
  const pt = lang === 'pt'
  const live = useNativeSession(session.id, lang)
  const { state, runs, loadError, send, answer, stop, switchModel, setEffort, addDir, setBrowser } = live
  // The session's settings in the composer's standard menu (what the old native page drew).
  const { models } = useNativeProviders(state.window !== null, nativeProviderKey(state.window?.session), lang)
  const controls = useMemo(
    () => nativeControls(state.window?.session ?? null, state.running, models, { switchModel, setEffort, addDir, setBrowser }),
    [state.window, state.running, models, switchModel, setEffort, addDir, setBrowser],
  )
  const items = useMemo(() => nativeChatItems(state), [state])
  const turns = useMemo(() => (state.window === null ? null : nativeChatTurns(items, lang)), [state.window, items, lang])
  const asks = useMemo(() => nativeAsks(items), [items])
  const emptyAnswer = state.emptyAnswerReason !== undefined
    ? (pt
      ? `O assistente terminou sem responder${state.emptyAnswerReason ? ` — motivo: ${state.emptyAnswerReason}` : '.'}`
      : `The assistant finished without answering${state.emptyAnswerReason ? ` — reason: ${state.emptyAnswerReason}` : '.'}`)
    : null

  const act = useCallback<ChatAct>(async req => {
    if (req.action === 'prompt') {
      const parts = nativeSendParts(req.text ?? '')
      if (parts.refused.length > 0) {
        return {
          ok: false,
          message: pt
            ? `O runtime nativo aceita imagens e PDF — não anexa ${parts.refused.join(', ')}.`
            : `The native runtime takes images and PDFs — it does not attach ${parts.refused.join(', ')}.`,
        }
      }
      // A refused send puts its sentence on the state (`send-failed`), which the source's `notice` says.
      const ok = await send(parts.text, parts.uploads)
      return { ok, message: '' }
    }
    if (req.action === 'interrupt') { await stop(); return { ok: true, message: '' } }
    // The row verbs (rename, stop the session, reopen) — the same engine routes the menu reaches.
    return nativeAct(req, lang)
  }, [send, stop, lang, pt])

  const source: ChatSource = {
    turns,
    ...(state.window === null && loadError ? { unavailable: loadError } : {}),
    working: state.running,
    liveText: nativeLiveText(items),
    liveReasoning: nativeLiveReasoning(items),
    runningTools: nativeRunningTools(items),
    act,
    canStop: state.runId !== undefined,
    approvals: asks.length > 0
      ? <>{asks.map(a => <NativeApprovalCard key={a.questionId} ask={a} lang={lang} onAnswer={x => answer(a.questionId, x)} />)}</>
      : null,
    // The gauge is the composer's ring now (`stats`); the strip keeps the per-run lines.
    status: <NativeRunsStrip runs={runs} lang={lang} gauge={false} />,
    notice: state.notice ?? emptyAnswer ?? (state.window !== null ? loadError : null),
    ...(controls ? { controls } : {}),
  }
  // The composer's context meter and metrics card, from the engine's real usage (`nativeStats.ts`).
  const stats = nativeSessionStats({
    sessionId: session.id, runs, turns,
    ...(state.window?.session.model ? { model: state.window.session.model } : {}),
  })
  const metrics = props.metrics ? { ...props.metrics, stats } : undefined
  return <SessionChat {...props} {...(metrics ? { metrics } : {})} source={source} />
}
