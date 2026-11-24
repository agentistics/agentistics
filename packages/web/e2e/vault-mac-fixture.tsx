// Real setup wizard; browser tests supply HTTP responses, never a real vault or recovery key.
import { createRoot } from 'react-dom/client'
import { EnrolWizard } from '../src/components/vault/VaultFlows'
import type { VaultView } from '../src/lib/vaultApi'
import '../src/index.css'

const initial = { state: 'open', wrappers: ['keychain'], presence: false, presenceAvailable: ['touchid', 'password'],
  unlockMethods: [{ id: 'touchid', advanced: false, gestures: { enroll: 1, unlock: 1 } }, { id: 'password', advanced: false, gestures: { enroll: 0, unlock: 0 } }],
  recoveryCreatedAt: null, autoLockMinutes: 30, gates: {}, setupCode: { owed: false }, loopback: true,
} as unknown as VaultView
createRoot(document.getElementById('root')!).render(<EnrolWizard lang="pt" isMobile={innerWidth < 768} initial={initial} steps={['presence', 'recovery']} fixedKind="touchid" onClose={() => {}} />)
