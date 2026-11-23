import { openVaultPage } from '../../lib/browserCard'

/** The "Open the Vault" action a refusal offers (`refusalOpensVault`) — ONE button for the padlock and the repository editor. */
export function OpenVaultButton({ pt, mobile, onOpen, marker }: { pt: boolean; mobile?: boolean; onOpen?: () => void; marker?: boolean }) {
  const ORANGE = 'var(--anthropic-orange)'
  return (
    <button type="button" {...(marker ? { 'data-browser-open-vault': '' } : {})} onClick={onOpen ?? openVaultPage} style={{
      flexShrink: 0, padding: '4px 10px', borderRadius: 7, border: `1px solid ${ORANGE}`, background: 'var(--anthropic-orange-dim)',
      color: ORANGE, fontFamily: 'inherit', fontSize: 11.5, fontWeight: 600, cursor: 'pointer', minHeight: mobile ? 44 : undefined,
    }}>{pt ? 'Abrir o Cofre' : 'Open the Vault'}</button>
  )
}
