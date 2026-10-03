/**
 * Run as a CHILD process by client-role.test.ts, with NODE_ENV unset — i.e. as an ordinary
 * `agentop …` CLI process would be: the vault CLIENT. Prints one JSON line of what it observed.
 * Never prints a secret: only booleans, codes and sealed (ciphertext) bytes.
 */
import { ensureVaultOpen, openFromFile, sealBytes, vaultIsOpen, vaultRole } from '../service'
import { readGithubConfigDetailed } from '../../backup/github-store'

const [sealedPath, marker] = process.argv.slice(2)
const out: Record<string, unknown> = { role: vaultRole() }
out.opened = (await ensureVaultOpen()) !== null
const read = await openFromFile(sealedPath!, 'github-backup', 'github-backup')
out.readCode = read.ok ? 'READ-PLAINTEXT' : read.absent ? 'absent' : read.code
const sealed = await sealBytes('central-token', 'probe', new TextEncoder().encode(marker!))
out.sealed = Buffer.from(sealed).toString('base64')
const gh = await readGithubConfigDetailed()
out.gh = gh.state === 'ok' ? { state: 'ok', token: gh.config.token, owner: gh.config.owner } : { state: gh.state }
out.holdsKey = vaultIsOpen()
process.stdout.write(JSON.stringify(out) + '\n')
