/**
 * NativeSessionPage — a NATIVE Agentistics session at `/sessions/:id` (UI.3). Reached through the
 * same URL as a fleet session (`sessionPath`); the route sends a native id here (`isNativeSessionId`,
 * `SessionRoute`) because a native session is not a fleet row — no process to find, no terminal — and
 * the fleet's page would wait for one that never comes. A header (back, the mark, the title, the
 * model and provider, the state) over `NativeSessionChat`.
 */
import { useNavigate, useOutletContext, useParams } from 'react-router-dom'
import { ChevronLeft } from 'lucide-react'
import type { AppContext } from '../lib/app-context'
import { HarnessMark } from '../components/sessions/HarnessMark'
import { NativeSessionChat } from '../components/sessions/NativeSessionChat'
import { useNativeSession } from '../hooks/useNativeSession'
import { NATIVE_HARNESS_ID, NATIVE_HARNESS_LABEL } from '../lib/nativeSession'

export default function NativeSessionPage() {
  const { lang } = useOutletContext<AppContext>()
  const pt = lang === 'pt'
  const { sessionId = '' } = useParams()
  const navigate = useNavigate()
  const live = useNativeSession(sessionId, lang)
  const s = live.state.window?.session
  // An OpenAI-compatible session names its endpoint (`credential.id`): six endpoints share that provider.
  const providerLabel = s ? (s.provider === 'openai-compatible' ? s.credential?.id ?? s.provider : s.provider) : ''
  return (
    <div data-testid="native-session" style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, minWidth: 0 }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderBottom: '1px solid var(--border-subtle)', minWidth: 0 }}>
        <button
          type="button"
          onClick={() => navigate('/sessions')}
          aria-label={pt ? 'Voltar às sessões' : 'Back to sessions'}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 34, height: 34, borderRadius: 9, border: 'none', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', flexShrink: 0 }}
        >
          <ChevronLeft size={18} />
        </button>
        <HarnessMark harness={NATIVE_HARNESS_ID} size={22} />
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
          <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {s?.title || NATIVE_HARNESS_LABEL}
          </span>
          <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {s ? `${NATIVE_HARNESS_LABEL} · ${s.model}${providerLabel ? ` · ${providerLabel}` : ''}` : '…'}
          </span>
        </div>
        <span
          data-testid="native-state"
          style={{
            fontSize: 11, padding: '3px 8px', borderRadius: 999, flexShrink: 0,
            background: live.state.running ? 'var(--anthropic-orange-dim)' : 'var(--bg-elevated)',
            color: live.state.running ? 'var(--anthropic-orange)' : 'var(--text-tertiary)',
          }}
        >
          {live.state.running ? (pt ? 'trabalhando' : 'working') : (pt ? 'pronta' : 'ready')}
        </span>
      </header>
      <NativeSessionChat live={live} lang={lang} />
    </div>
  )
}
