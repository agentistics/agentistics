/**
 * vault/phone-http.ts — `/api/vault/phone*` (VAULT.PERSONAL §10): opening the vault from a phone and
 * approving a phone on the computer. Thin doors onto phone.ts + gate.ts; answers only through the
 * `reply` http.ts hands it (the page filter). No route here ever returns a vault secret: the ONE value
 * that leaves is a NEW device key, to the phone the computer just approved, once.
 */
import { enrolKinds } from '@agentistics/core'
import { originMatchesRp } from '@agentistics/vault'
import { readJsonLimited } from '../limits'
import * as gate from './gate'
import * as phone from './phone'
import { phoneLabel, readMobile, removeDevice } from './mobile'
import { vaultAudit, vaultLang, vaultStatus } from './service'

type Reply = (r: { ok: boolean } & Record<string, unknown>, extra?: Record<string, unknown>) => Response
export interface PhoneHttpCtx { req: Request; path: string; url: URL; session: string; grant: string | null; loopback: boolean; reply: Reply }

const pt = () => vaultLang() === 'pt'
const fail = (code: string, en: string, ptText: string) => ({ ok: false as const, code, sentence: pt() ? ptText : en })
const bad = () => fail('bad-request', 'Bad request.', 'Requisição inválida.')
const desktopOnly = () => fail('desktop-only', 'Do this on the computer itself.', 'Faça isto no próprio computador.')
const notSecure = () => fail('insecure-context',
  'Biometrics on this device need a secure address (https). Turn on HTTPS certificates in your Tailscale admin and open Agentistics by the machine\'s https name.',
  'A digital neste aparelho precisa de um endereço seguro (https). Ligue os certificados HTTPS no painel do Tailscale e abra o Agentistics pelo nome https da máquina.')

function phoneFail(code: string) {
  switch (code) {
    case 'no-challenge': return fail('passkey-expired', 'That confirmation expired (60 seconds) or was already used. Try again.', 'Essa confirmação expirou (60 segundos) ou já foi usada. Tente de novo.')
    case 'no-verification': return fail('passkey-no-uv', 'The phone did not confirm it was you (fingerprint, face or PIN). Try again.', 'O celular não confirmou que é você (digital, rosto ou PIN). Tente de novo.')
    case 'counter': return fail('passkey-clone', 'This passkey answered with an old counter, which is what a copied passkey does. It was refused.', 'Esta passkey respondeu com um contador antigo, que é o que uma passkey copiada faz. Ela foi recusada.')
    case 'unknown-device': return fail('phone-unknown', 'This phone is no longer approved to open the vault. Approve it again on the computer.', 'Este celular não está mais aprovado para abrir o cofre. Aprove-o de novo no computador.')
    case 'bad-secret': return fail('phone-no-key', 'This phone did not send its key (biometrics without the PRF extension?). Nothing was opened.', 'Este celular não mandou a chave dele (digital sem a extensão PRF?). Nada foi aberto.')
    default: return { ...fail('passkey-refused', 'The phone\'s confirmation could not be verified. Nothing was opened.', 'A confirmação do celular não pôde ser verificada. Nada foi aberto.'), check: code }
  }
}

export async function handlePhoneHttp(c: PhoneHttpCtx): Promise<Response | null> {
  const { req, path, session, grant, loopback, reply } = c
  if (!path.startsWith('/api/vault/phone')) return null
  const origin = req.headers.get('origin') ?? `${c.url.protocol}//${c.url.host}`
  const rpId = c.url.hostname
  const secure = originMatchesRp(origin, rpId)
  const body = async (): Promise<Record<string, unknown>> => {
    const r = await readJsonLimited<Record<string, unknown>>(req, 8192)
    return r.ok && r.value && typeof r.value === 'object' ? r.value : {}
  }
  const codeOf = (b: Record<string, unknown>) => (typeof b.code === 'string' && b.code.length > 0 && b.code.length <= 16 ? b.code : undefined)

  // ── what this page may offer (readable while LOCKED: counts and opaque ids only) ──
  if (path === '/api/vault/phone' && req.method === 'GET') {
    const st = await vaultStatus()
    const facts = await phone.phoneUnlockFacts(rpId)
    const open = st.state === 'open'
    const codeOnly = open ? (await readMobile()).codeReveal : null
    return reply({
      ok: true, state: st.state, loopback, secure, ...facts, codeOnly,
      enrolKinds: open && !loopback ? enrolKinds({ secure, codeOnly: codeOnly === true }) : [],
    })
  }
  if (path === '/api/vault/phone/enrol/status' && req.method === 'GET') {
    return reply({ ok: true, status: phone.requestStatus(session, c.url.searchParams.get('id') ?? '') })
  }
  if (path === '/api/vault/phone/requests' && req.method === 'GET') {
    if (!loopback) return reply(desktopOnly())
    return reply({ ok: true, requests: phone.pendingRequests() })
  }
  if (req.method !== 'POST') return null
  const b = await body()

  // ── opening the vault from the phone ──
  if (path === '/api/vault/phone/unlock/begin') {
    if (!secure) return reply(notSecure())
    const r = await phone.beginPhoneUnlock(session, rpId, origin)
    if (!r.ok) return reply(fail('no-passkey', 'This phone has no passkey that can open the vault yet. Register it first (it asks your code here and an approval on the computer).', 'Este celular ainda não tem uma passkey que abra o cofre. Registre-o primeiro (pede o seu código aqui e uma aprovação no computador).'))
    return reply(r)
  }
  if (path === '/api/vault/phone/unlock') {
    if (b.kind !== 'device' && b.kind !== 'passkey') return reply(bad())
    if (b.kind === 'passkey' && !secure) return reply(notSecure())
    const code = codeOf(b)
    // The code is ALWAYS asked from a phone — before anything is unwrapped, so nothing waits for it.
    if (!code) return reply(fail('stepup-required', 'Type the code from your authenticator app.', 'Digite o código do seu app autenticador.'))
    const guard = await gate.phoneUnlockGuard()
    if (guard) return reply(guard)
    const s = await phone.stageFromPhone(session, b)
    if (!s.ok) {
      vaultAudit({ type: 'vault.phone-unlock-failed' })
      return reply('sentence' in s && s.sentence ? s as { ok: false; code: string; sentence: string } : phoneFail(s.code))
    }
    if (s.state === 'open') return reply({ ok: true, state: 'open' })
    const done = await gate.completeUnlock(code, { audit: false })
    if (!done.ok) { vaultAudit({ type: 'vault.phone-unlock-failed' }); return reply(done) }
    vaultAudit({ type: 'vault.unlock', device: (await phoneLabel(s.id)) ?? (pt() ? 'celular' : 'phone') })
    // The code just verified is the step-up too (owner 2026-10-03): the list asks nothing more.
    return reply({ ok: true, state: 'open', grant: gate.mintGrant(session, 'read') })
  }

  // ── registering a phone: the request (phone) ──
  if (path === '/api/vault/phone/enrol/request') {
    if (loopback) return reply(fail('not-a-phone', 'This computer opens the vault with its own confirmation; register a phone from the phone.', 'Este computador abre o cofre com a confirmação dele; registre um celular a partir do celular.'))
    const kind = b.kind === 'device' ? 'device' : b.kind === 'passkey' ? 'passkey' : null
    if (!kind) return reply(bad())
    const st = await vaultStatus()
    if (st.state !== 'open') return reply(fail('locked', 'Open the vault on the computer first: registering this phone needs the vault open there.', 'Abra o cofre no computador primeiro: registrar este celular pede o cofre aberto lá.'))
    const allowed = enrolKinds({ secure, codeOnly: (await readMobile()).codeReveal })
    if (!allowed.includes(kind)) return reply(kind === 'passkey' ? notSecure() : fail('code-only-off', 'Opening with the code alone is turned off. Turn it on in the vault settings on the computer, or use biometrics over https.', '"Abrir só com o código" está desligado. Ligue nos ajustes do cofre, no computador, ou use a digital pelo https.'))
    const g = await gate.requireVaultStepUp('phone-enrol-request', { grant, session, loopback, code: codeOf(b) })
    if (!g.ok) return reply(g)
    const label = typeof b.label === 'string' && b.label.trim() ? b.label.trim().slice(0, 60) : (pt() ? 'Celular' : 'Phone')
    const r = phone.requestEnrol(session, label, kind)
    if (!r.ok) return reply(fail('too-many', 'Too many phones are waiting for approval. Answer them on the computer first.', 'Há celulares demais esperando aprovação. Responda-os no computador primeiro.'))
    vaultAudit({ type: 'vault.phone-enrol-request', device: label })
    return reply(r)
  }
  // ── the approval (computer) ──
  if (path === '/api/vault/phone/requests/decide') {
    if (!loopback) return reply(desktopOnly())
    const id = typeof b.id === 'string' ? b.id : ''
    if (typeof b.approve !== 'boolean') return reply(bad())
    if (b.approve) {
      const g = await gate.requireVaultStepUp('phone-enrol-approve', { grant, session, loopback })
      if (!g.ok) return reply(g)
    }
    const r = phone.decideRequest(id, b.approve)
    if (!r.ok) return reply(fail('not-found', 'That request expired or was already answered.', 'Esse pedido expirou ou já foi respondido.'))
    vaultAudit({ type: b.approve ? 'vault.phone-enrol-approve' : 'vault.phone-enrol-deny', device: r.label })
    return reply({ ok: true })
  }
  // ── after approval: the device key (code alone) or the passkey's PRF copy ──
  if (path === '/api/vault/phone/enrol/device') {
    if (!(await readMobile()).codeReveal) return reply(fail('code-only-off', 'Opening with the code alone is turned off.', '"Abrir só com o código" está desligado.'))
    const r = await phone.issueDeviceKey(session, typeof b.requestId === 'string' ? b.requestId : '')
    if (!r.ok) return reply(fail('not-approved', 'The computer has not approved this phone (or the approval expired).', 'O computador não aprovou este celular (ou a aprovação expirou).'))
    vaultAudit({ type: 'vault.phone-key-add', device: r.label })
    return reply({ ok: true, deviceId: r.deviceId, deviceSecret: r.deviceSecret })
  }
  if (path === '/api/vault/phone/enrol/passkey-key') {
    const r = await phone.finishPasskeyKey(session, b)
    if (!r.ok) return reply(phoneFail(r.code))
    if (r.unlockable) vaultAudit({ type: 'vault.phone-key-add', device: (await phoneLabel(String(b.credentialId ?? ''))) ?? '' })
    const noPrf = (x: { code: string; sentence: string }) => ({ ok: true, unlockable: false, code: x.code, sentence: x.sentence })
    return reply(r.unlockable ? { ok: true, unlockable: true } : noPrf(fail('no-prf', 'This phone registered its passkey, but it does not offer the PRF extension, so it can confirm actions but cannot OPEN a locked vault. Use a phone and browser with passkey PRF support (recent Android Chrome, iOS 18+ Safari).', 'Este celular registrou a passkey, mas não oferece a extensão PRF: ele confirma ações, mas não ABRE o cofre trancado. Use um celular e navegador com suporte a PRF (Chrome recente no Android, Safari no iOS 18+).')))
  }
  // ── the computer's housekeeping ──
  if (path === '/api/vault/phone/devices/remove') {
    if (!loopback) return reply(desktopOnly())
    const g = await gate.requireVaultStepUp('mobile-passkey-remove', { grant, session, loopback, code: codeOf(b) })
    if (!g.ok) return reply(g)
    if (!(await removeDevice(typeof b.id === 'string' ? b.id : ''))) return reply(fail('not-found', 'That phone is not approved.', 'Esse celular não está aprovado.'))
    vaultAudit({ type: 'vault.phone-key-remove' })
    return reply({ ok: true })
  }
  if (path === '/api/vault/phone/stale/clear') {
    if (!loopback) return reply(desktopOnly())
    const g = await gate.requireVaultStepUp('mobile-passkey-remove', { grant, session, loopback, code: codeOf(b) })
    if (!g.ok) return reply(g)
    const n = await phone.dropStalePhoneWraps()
    if (n > 0) vaultAudit({ type: 'vault.phone-key-remove' })
    return reply({ ok: true, removed: n })
  }
  return null
}
