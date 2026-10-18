import type { CSSProperties } from 'react'
import AwayPill from './AwayPill'
import { NotificationBell } from './NotificationBell'
import { VaultHeaderButton } from './vault/VaultHeaderButton'

const buttonStyle: CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  width: 32, height: 32, borderRadius: 8,
  border: '1px solid var(--border)', background: 'transparent',
  color: 'var(--text-tertiary)', cursor: 'pointer', position: 'relative',
}

/** Keep the approved vault → moon → bell order in every desktop and phone header. */
export function HeaderStatusButtons({ lang, isCentral, localShell, mobile = false }: {
  lang: 'pt' | 'en'; isCentral: boolean; localShell?: boolean; mobile?: boolean
}) {
  return <>
    <VaultHeaderButton lang={lang} enabled={!isCentral} buttonStyle={buttonStyle} />
    <AwayPill lang={lang} enabled={!isCentral && localShell !== false} />
    <NotificationBell lang={lang} buttonClassName={mobile ? 'ag-tap-icon' : undefined} buttonStyle={buttonStyle} />
  </>
}
