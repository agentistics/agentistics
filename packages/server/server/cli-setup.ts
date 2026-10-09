/** The local first-run wizard: history consent, then the optional server boot offer. */
import { readPreferencesOrExit, writePreferences, resolveArchiveMode, type ArchiveMode } from './preferences'
import { enableAutostart } from './autostart'
import { select, confirm } from './cli-ui'
import { suggestHooksLine } from './cli-hooks'

const ESC = '\x1b'
const D = `${ESC}[2m`
const R = `${ESC}[0m`

export async function ensureArchiveModeChosen(): Promise<void> {
  if (!process.stdin.isTTY) return
  const prefs = await readPreferencesOrExit()
  if (resolveArchiveMode(prefs) !== undefined) return
  process.stdout.write(`\n  ${D}Claude deletes session transcripts older than 30 days. How should agentistics preserve your history?${R}\n`)
  const mode = await select<ArchiveMode>({
    message: 'Preserve session history?',
    choices: [
      { name: 'consolidate', value: 'consolidate', hint: 'recommended — store computed per-session metrics (~KB each)' },
      { name: 'full', value: 'full', hint: 'archivist — also mirror raw transcripts so you can re-read chats (heavy)' },
      { name: 'off', value: 'off', hint: "do nothing — use Claude's default 30-day cleanup" },
    ],
  })
  await writePreferences({ archiveMode: mode })
  process.stdout.write(`\n  ${D}archive mode set to ${mode}.${R}\n`)
}

export const SETUP_USAGE = `Usage: agentop setup

Interactive first-run wizard: history consent, start on boot, Claude Code hooks hint.
Needs an interactive terminal.

Options:
  -h, --help   Show this help
`

export async function runSetup(args: string[] = []): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(SETUP_USAGE)
    return 0
  }
  if (!process.stdin.isTTY) {
    process.stderr.write('setup needs an interactive terminal.\n')
    return 1
  }
  await ensureArchiveModeChosen()
  if (await confirm('Start the server on boot?', false)) {
    const res = await enableAutostart('server')
    process.stdout.write(`\n  ${res.message.replace(/\n/g, '\n  ')}\n`)
  }
  const line = await suggestHooksLine()
  if (line) process.stdout.write(`\n  ${D}${line}${R}\n`)
  return 0
}
