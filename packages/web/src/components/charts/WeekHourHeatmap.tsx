import { useState } from 'react'

/** Local weekday × hour counts. SVG preserves compact cells on phones without page overflow. */
export function WeekHourHeatmap({ cells, lang }: { cells: number[][]; lang: 'pt' | 'en' }) {
  const days = lang === 'pt' ? ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'] : ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
  const [selected, setSelected] = useState<string | null>(null)
  const max = Math.max(1, ...cells.flat())
  const message = (day: number, hour: number, count: number) => `${days[day]} · ${hour}h · ${count} ${lang === 'pt' ? 'mensagens' : 'messages'}`
  return <div style={{ maxWidth: 760 }}>
    <style>{`.usage-hour-grid text { font-size: 11px; } @media (max-width: 767px) { .usage-hour-grid text { font-size: 19px; } .usage-hour-grid .minor-hour { display: none; } }`}</style>
    <svg className="usage-hour-grid" viewBox="0 0 664 214" style={{ width: '100%', display: 'block' }} role="img" aria-label={lang === 'pt' ? 'Mensagens por dia da semana e hora, últimos 14 dias' : 'Messages by weekday and hour, last 14 days'}>
      {Array.from({ length: 24 }, (_, hour) => <text className={hour % 3 && hour !== 23 ? 'minor-hour' : undefined} key={hour} x={44 + hour * 26} y={14} textAnchor="middle" fill="var(--text-secondary)" fontSize={10}>{hour}h</text>)}
      {days.map((day, d) => <g key={day}>
        <text x={0} y={40 + d * 26} fill="var(--text-secondary)" fontSize={11}>{day}</text>
        {Array.from({ length: 24 }, (_, hour) => {
          const count = cells[d]?.[hour] ?? 0
          const label = message(d, hour, count)
          return <rect key={hour} x={32 + hour * 26} y={24 + d * 26} width={23} height={23} rx={3}
            fill={count ? 'var(--anthropic-orange)' : 'var(--bg-elevated)'} fillOpacity={count ? 0.2 + 0.8 * count / max : 1}
            onPointerEnter={() => setSelected(label)} onPointerLeave={() => setSelected(null)} onClick={() => setSelected(label)}><title>{label}</title></rect>
        })}
      </g>)}
    </svg>
    <div aria-live="polite" style={{ minHeight: 20, fontSize: 12, color: 'var(--text-secondary)' }}>{selected ?? (lang === 'pt' ? 'Mais laranja = mais mensagens · horário local' : 'More orange = more messages · local time')}</div>
  </div>
}
