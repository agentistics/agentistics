import { useEffect } from 'react'
import { refreshAway, useAway } from '../lib/awayMode'

/** Shared wording for every fleet-wide confirmation. Counts come from the server registry. */
export function AwayImpact({ pt, open = true }: { pt: boolean; open?: boolean }) {
  const away = useAway()
  useEffect(() => { if (open) void refreshAway() }, [open])
  return <p role="status" style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
    {away.activeSessions === undefined ? (pt ? 'Carregando sessões ativas…' : 'Loading active sessions…')
      : pt ? `Isto avisa ${away.activeSessions} sessões ativas.` : `This notifies ${away.activeSessions} active sessions.`}
    {' '}{pt ? 'Enquanto ligado, toda sessão nova — Nova sessão, linha de comando, MCP, passagem de líder, worker reaberto ou relançado — nasce no modo "sem perguntas", salvo modo escolhido; sessões vivas não mudam de modo.'
      : 'While on, every new session — New session, command line, MCP, leader hand-off, reopened or relaunched worker — is born in "no questions" mode unless a mode is chosen; live sessions keep their mode.'}
    {' '}{pt ? 'Avisos aguardam 45 s sem alterações e são limitados a um por sessão a cada 5 min.'
      : 'Notices wait for 45 s without changes and are limited to one per session every 5 min.'}
    {(away.cooldownMs ?? 0) > 0 && <> {pt ? 'Uma alteração recente ainda está no período de espera.' : 'A recent change is still in its cooldown period.'}</>}
  </p>
}
