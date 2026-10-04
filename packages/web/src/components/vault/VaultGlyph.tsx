import { KeyRound, LockKeyhole, Vault, type LucideProps } from 'lucide-react'
import { VAULT_ICON, type VaultIconName } from '../../lib/vaultGlyph'

const ICONS: Record<VaultIconName, typeof Vault> = { 'vault': Vault, 'lock-keyhole': LockKeyhole, 'key-round': KeyRound }

/** The vault's icon — the only place a surface should get it from (see `lib/vaultGlyph.ts`). */
export function VaultGlyph({ name = VAULT_ICON, ...rest }: LucideProps & { name?: VaultIconName }) {
  const Icon = ICONS[name]
  return <Icon {...rest} />
}
