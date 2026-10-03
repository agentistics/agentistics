/**
 * vault/holder.ts — imported FIRST by the HTTP service (index.ts), so that whichever way the service
 * is started (`agentop server`, which also runs bootVault, or `bun run dev`) it is the vault's holder
 * before any other module evaluates (SECRETS.4 §5.2). ES modules evaluate in import order.
 */
import { becomeVaultHolder, hardenThisProcess, lockVault, vaultAudit, vaultIsOpen } from './service'
import { startSleepWatch } from './sleep-watch'
import { underTest } from '../data-dir'
import { installVaultOps } from './ops'

becomeVaultHolder()
installVaultOps()
// §5.3: as early as possible; every unwrap path also awaits it, so this is about WHEN, not WHETHER.
void hardenThisProcess()
// §5.1: the key leaves memory on the way out (SIGTERM/SIGINT end in process.exit, which fires this)
// and when the machine sleeps or the screen locks (best-effort, see sleep-watch.ts).
process.once('exit', () => lockVault('user'))
if (!underTest(process.env)) startSleepWatch(why => { if (!vaultIsOpen()) return; lockVault('auto-lock'); vaultAudit({ type: 'vault.auto-locked', source: 'host', name: why }) })
