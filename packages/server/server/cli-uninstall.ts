/**
 * cli-uninstall.ts — `agentop uninstall`. The decisions are in uninstall-plan.ts; this runs them.
 *
 * Order matters: services first (so nothing restarts what is being removed), the binary last among
 * the removals (it is the program doing the removing), and the data directory only on its own
 * separate, default-NO answer.
 */
import { rm, unlink } from 'fs/promises'
import { existsSync } from 'fs'
import { AGENTISTICS_DATA_DIR, HOME_DIR } from './config'
import { isWSL } from './wsl-ports-io'
import { isInstalledBinary } from './upgrade'
import {
  binaryTargets, DATA_WARNING, parseUninstallArgs, planUninstall, safeDataDir, UNINSTALL_HELP,
} from './uninstall-plan'

export async function runUninstall(args: string[]): Promise<number> {
  const parsed = parseUninstallArgs(args)
  if (parsed.kind === 'help') { process.stdout.write(UNINSTALL_HELP); return 0 }
  if (parsed.kind === 'unknown') {
    process.stderr.write(`agentop uninstall: unknown argument "${parsed.arg}" — nothing was removed.\n\n${UNINSTALL_HELP}`)
    return 2
  }
  const interactive = !!process.stdin.isTTY && !!process.stdout.isTTY
  if (!parsed.yes && !interactive) {
    process.stderr.write('agentop uninstall needs a terminal to confirm — or pass --yes.\n')
    return 2
  }
  const { confirm } = await import('./cli-ui')
  const installed = isInstalledBinary(process.execPath, process.argv[1])
  const wsl = isWSL()

  if (!parsed.yes) {
    const steps = planUninstall({ wsl, installedBinary: installed, deleteData: false })
    process.stdout.write(`This will: stop and disable the autostart service, remove the shell update hook${wsl ? ', remove the Windows logon entry' : ''}${steps.includes('binary') ? `, and remove ${process.execPath}` : ''}.\n`)
    if (!(await confirm('Uninstall agentop?', false))) { process.stdout.write('Nothing was changed.\n'); return 0 }
  }

  let deleteData = false
  if (!parsed.keepData && interactive && existsSync(AGENTISTICS_DATA_DIR)) {
    if (!safeDataDir(AGENTISTICS_DATA_DIR, HOME_DIR)) {
      process.stdout.write(`Not offering to delete ${AGENTISTICS_DATA_DIR}: it does not look like a dedicated data directory.\n`)
    } else {
      process.stdout.write(`\n${DATA_WARNING}\n`)
      deleteData = await confirm(`Also delete ${AGENTISTICS_DATA_DIR}?`, false)
    }
  }

  const out = (m: string) => process.stdout.write(`  ${m}\n`)
  let ok = true
  for (const step of planUninstall({ wsl, installedBinary: installed, deleteData })) {
    try {
      if (step === 'services') {
        const a = await import('./autostart')
        for (const mode of ['server', 'watch', 'machine'] as const) {
          if (await a.unitInstalled(mode)) out((await a.disableAutostart(mode, { stop: true })).message.split('\n').pop() ?? '')
        }
      } else if (step === 'update-hook') {
        out((await (await import('./autostart')).uninstallUpdateHook()).message)
      } else if (step === 'windows-entry') {
        for (const l of await (await import('./autostart')).removeWslLogonEntries()) out(l)
      } else if (step === 'binary') {
        for (const f of binaryTargets(process.execPath)) {
          if (existsSync(f)) { await unlink(f); out(`Removed ${f}`) }
        }
      } else if (step === 'data') {
        await rm(AGENTISTICS_DATA_DIR, { recursive: true, force: true })
        out(`Deleted ${AGENTISTICS_DATA_DIR}`)
      }
    } catch (err: any) {
      ok = false
      out(`Could not finish "${step}": ${err?.message ?? err}`)
    }
  }
  if (!deleteData && existsSync(AGENTISTICS_DATA_DIR)) out(`Kept ${AGENTISTICS_DATA_DIR} (delete it yourself when you are sure).`)
  process.stdout.write(ok ? '\nagentop was uninstalled.\n' : '\nUninstall finished with problems — see above.\n')
  return ok ? 0 : 1
}
