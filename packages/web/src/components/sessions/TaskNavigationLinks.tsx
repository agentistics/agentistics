import { Activity, CalendarDays } from 'lucide-react'

export const TASK_NAVIGATION = [
  { path: '/tasks/calendar', pt: 'Calendário', en: 'Calendar', Icon: CalendarDays },
  { path: '/tasks/live', pt: 'Live', en: 'Live', Icon: Activity },
] as const

/** Navigation destinations, independent of session panel placement/hiding. */
export function TaskNavigationLinks({ lang, pathname = '', onNavigate, mobile = false, size = 32 }: {
  lang: 'pt' | 'en'; pathname?: string; onNavigate?: (to: string) => void; mobile?: boolean; size?: number
}) {
  return <nav aria-label={lang === 'pt' ? 'Acompanhamento das tarefas' : 'Task tracking'}
    style={{ display: 'flex', flexDirection: mobile ? 'row' : 'column', alignItems: 'center', gap: 2, flexShrink: 0 }}>
    {TASK_NAVIGATION.map(({ path, pt, en, Icon }) => {
      const label = lang === 'pt' ? pt : en
      const active = pathname === path || pathname.startsWith(path + '/')
      return <a key={path} href={path} aria-label={label} title={label} aria-current={active ? 'page' : undefined}
        onClick={e => { if (onNavigate && e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) { e.preventDefault(); onNavigate(path) } }}
        style={{ width: mobile ? undefined : size, minWidth: mobile ? 44 : size, height: mobile ? 44 : size,
          padding: mobile ? '0 8px' : 0, borderRadius: 8, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5,
          textDecoration: 'none', fontSize: 12, color: active ? 'var(--anthropic-orange)' : 'var(--text-secondary)',
          background: active ? 'var(--anthropic-orange-dim)' : 'transparent' }}>
        <Icon size={Math.round(size / 2)} />{mobile && label}
      </a>
    })}
  </nav>
}
