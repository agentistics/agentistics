/**
 * NativeGate — a route that belongs to the native harness or the providers (Settings → Providers, a
 * native session's page). The native runtime is EXPERIMENTAL (owner decision 2026-10-03): unknown yet,
 * the fallback; not shown here (a community build, or the flag off), a notice naming the command that
 * turns it on — never the page, and never a page that would only fail its first request.
 */
import type { ReactNode } from 'react'
import { FlaskConical } from 'lucide-react'
import { useEngineCaps } from '../hooks/useEngineCaps'
import { NATIVE_EXPERIMENTAL_SENTENCE } from '../lib/nativeSession'

export function NativeExperimentalNotice({ lang }: { lang: 'pt' | 'en' }) {
  return (
    <div data-testid="native-experimental" role="status"
      style={{ maxWidth: 560, margin: '48px auto', padding: '16px 18px', borderRadius: 12, border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text-secondary)', fontSize: 13.5, lineHeight: 1.55, display: 'flex', gap: 10, boxSizing: 'border-box', width: 'calc(100% - 32px)' }}>
      <FlaskConical size={18} style={{ flexShrink: 0, marginTop: 2 }} />
      <span>{NATIVE_EXPERIMENTAL_SENTENCE[lang]}</span>
    </div>
  )
}

export function NativeGate({ lang, fallback, children, shown }: { lang: 'pt' | 'en'; fallback?: ReactNode; children: ReactNode; shown?: boolean | null }) {
  const caps = useEngineCaps()
  const on = shown !== undefined ? shown : caps.nativeRuntime
  if (on === null) return <>{fallback ?? null}</>
  if (!on) return <NativeExperimentalNotice lang={lang} />
  return <>{children}</>
}
