/**
 * vault/holder.ts — imported FIRST by the HTTP service (index.ts), so that whichever way the service
 * is started (`agentop server`, which also runs bootVault, or `bun run dev`) it is the vault's holder
 * before any other module evaluates (SECRETS.4 §5.2). ES modules evaluate in import order.
 */
import { becomeVaultHolder } from './service'
import { installVaultOps } from './ops'

becomeVaultHolder()
installVaultOps()
