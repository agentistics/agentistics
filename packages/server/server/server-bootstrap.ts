/** Shared listener bootstrap for the CLI service and the direct development server. */
import './vault/holder'
import { startVaultSocket } from './vault/socket'

/** Non-secret reports and unlock requests must work before a vault exists or is unlocked. */
export async function bootstrapServer(): Promise<void> {
  const r = await startVaultSocket()
  if (!r.ok && r.reason === 'in-use') console.warn('agentop: another service already answers on the vault socket; this one does not take it over.')
  else if (!r.ok) console.warn(`agentop: the vault socket could not be opened (${r.reason}); local reports and unlock requests will not reach this service.`)
}
