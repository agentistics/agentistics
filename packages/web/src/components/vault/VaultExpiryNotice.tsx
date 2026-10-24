/** The vault watcher only queues Nay notices; it never draws a second floating card. */
import { useEffect, useRef } from 'react'
import { pushNotification } from '../../lib/notifications'
import { WARN_INITIAL, WARN_BEFORE_MS, nextWarn, type WarnState } from '../../lib/vaultExpiry'
import { useVaultWatch } from '../../lib/vaultWatch'
import { dismissVaultExpiryAlert, pushAlert } from '../../lib/nayNotifyStore'
import { alertKey } from '../../lib/nayNotify'

export function VaultExpiryNotice({ lang }: { lang: 'pt' | 'en' }) {
  const w = useVaultWatch(true)
  const warn = useRef<WarnState>(WARN_INITIAL)
  useEffect(() => {
    const r = nextWarn(warn.current, w.autoLockInMs)
    warn.current = r.state
    if (r.fire) {
      pushAlert({ key: alertKey('vault-expiry', 'vault-expiry', w.at), kind: 'vault-expiry',
        sessionId: 'vault-expiry', name: lang === 'pt' ? 'Cofre' : 'Vault', sinceMs: w.at, sinceKnown: true })
      pushNotification({ type: 'warning', code: 'vault.autolock-soon',
        title: lang === 'pt' ? 'Seu cofre vai se trancar em 5 min' : 'Your vault locks in 5 min',
        message: lang === 'pt' ? 'Abra o chat da Nay para mantê-lo aberto ou trancar agora.' : 'Open the Nay chat to keep it open or lock it now.' })
    }
    if (w.autoLockInMs === null || w.autoLockInMs <= 0 || w.autoLockInMs > WARN_BEFORE_MS) dismissVaultExpiryAlert()
  }, [w.at, w.autoLockInMs, lang])
  return null
}
