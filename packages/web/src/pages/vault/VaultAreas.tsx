/**
 * Three of the `/vault` page's four tabs (VAULT v4): Métodos de desbloqueio, Dispositivos and
 * Configurações. Every control the old Settings → Vault screen and the old page's phone panel offered
 * lives here as ONE row — title, one line, a status, one action — and anything longer than a line sits
 * behind a "Saiba mais". The calls, gates and flows are the old ones (`useVaultControls`, `VaultFlows`,
 * `lib/passkey`, `lib/phoneVault`): this file only lays them out.
 */
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { FingerprintPattern, Laptop, Smartphone, Usb } from 'lucide-react'
import { ConfirmModal, DialogActions, Toggle, dialogButtonStyle } from '../settings/primitives'
import { Err } from '../../components/MfaSetup'
import { PhoneEnrol } from '../../components/vault/VaultUnlock'
import { AutoLockRow, Gate, HardeningBlock, HowStrip, Note, UnlockPolicyRow, presWordOf, soonKinds, unlockModeKey } from '../../components/vault/VaultFlows'
import { addableKinds, minutesLeft, remainingMs, type Reply } from '../../lib/vaultApi'
import { vt, vtf } from '../../lib/vaultText'
import { pt_, type PKey } from '../../lib/personalText'
import { wipeBackupHistory } from '../../lib/vaultPersonal'
import { hasPasskeyHere, passkeySupport, removePasskey, setCodeReveal, type MobileState } from '../../lib/passkey'
import { clearStalePhones, phoneFacts, readDeviceKey, removeDevice } from '../../lib/phoneVault'
import type { VaultControls } from './useVaultControls'
import { AfterRows, AreaHead, InfoBlocks, LearnMore, Pill, Rows, Sheet, VaultRow, dangerOutline, hotBtn, pageBtn } from './vaultUi'

type Lang = 'en' | 'pt'
export type Gated = <T>(run: (code?: string, token?: string) => Promise<Reply<T>>, gesture: false | { action: string; target: string }) => Promise<Reply<T>>

const fmtDate = (iso: string | null | undefined, lang: Lang): string => {
  if (!iso) return vt('unknown', lang)
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? vt('unknown', lang) : d.toLocaleDateString(lang === 'pt' ? 'pt-BR' : 'en-US')
}
const fmtTime = (iso: string, lang: Lang): string => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString(lang === 'pt' ? 'pt-BR' : 'en-US', { hour: '2-digit', minute: '2-digit' }) }
const fmtFull = (iso: string | null | undefined, lang: Lang): string => {
  if (!iso) return vt('unknown', lang)
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? vt('unknown', lang) : d.toLocaleString(lang === 'pt' ? 'pt-BR' : 'en-US')
}

// ── Métodos de desbloqueio ─────────────────────────────────────────────────────────────────────

export function MethodsArea({ lang, isMobile, c, mobile, isPhone, onGoDevices }: {
  lang: Lang; isMobile: boolean; c: VaultControls; mobile: MobileState | null; isPhone: boolean; onGoDevices: () => void
}) {
  const t = (k: PKey, v?: Record<string, string | number>) => pt_(k, lang, v)
  const [manage, setManage] = useState(false)
  const [learn, setLearn] = useState(false)
  const view = c.view
  if (!view) return null
  const btn = pageBtn(isMobile)
  const hot = hotBtn(isMobile)
  const styleFor = (id: 'authenticator' | 'presence') => (c.primary === id ? hot : btn)
  const addable = addableKinds(view)
  const soon = soonKinds(view)
  const hasHello = view.wrappers.includes('hello')
  const hasKey = view.wrappers.includes('fido2')
  // A kind gets a row when this machine offers it or it is already on; "coming soon" stays a row too.
  const helloRow = hasHello || view.presenceAvailable.includes('hello')
  const keyRow = hasKey || view.presenceAvailable.includes('fido2') || soon.includes('fido2')
  const turnOn = (k: 'hello' | 'fido2') => {
    // The first presence runs the whole missing flow; another kind beside one already on is "add another way".
    if (view.presence) { c.setWizardKind(k); c.setWizard(['presence']) } else c.startSetup('presence')
  }
  const presenceAction = (k: 'hello' | 'fido2', on: boolean) => on
    ? <button type="button" style={btn} onClick={() => setManage(true)}>{t('manage')}</button>
    : addable.includes(k) || (!view.presence && view.presenceAvailable.includes(k))
      ? (
        <button type="button" style={view.presence ? btn : styleFor('presence')} onClick={() => turnOn(k)}
          title={c.tip('enroll-presence')} aria-label={`${t('activate')}. ${c.tip('enroll-presence')}`}>
          {t('activate')} {view.presence && <Gate code={c.g('enroll-presence').code} gesture={c.g('enroll-presence').gesture} lang={lang} />}
        </button>
      )
      : null
  const passkeys = mobile?.passkeys.length ?? 0
  const here = isPhone && mobile ? hasPasskeyHere(mobile, typeof window !== 'undefined' ? window.location.hostname : '') : false
  const auth = view.authenticator
  const authTone = auth?.frozen ? 'bad' : auth?.pausedUntil ? 'warn' : auth ? 'ok' : 'off'
  const authStatus = auth?.frozen ? t('st_frozen') : auth?.pausedUntil ? t('st_paused') : auth ? t('st_active') : t('st_missing')
  return (
    <section data-vault-area="methods">
      <AreaHead title={t('tab_methods')} desc={t('area_methods_d')} isMobile={isMobile} />
      <Rows>
        {helloRow && (
          <VaultRow data="hello" isMobile={isMobile} title={vt('presenceName_hello', lang)} desc={t('m_hello_d')}
            status={<Pill tone={hasHello ? 'ok' : 'off'} text={hasHello ? t('st_active') : t('st_off')} />}>
            {presenceAction('hello', hasHello)}
          </VaultRow>
        )}
        {keyRow && (
          <VaultRow data="fido2" isMobile={isMobile} title={t('m_key')}
            desc={!hasKey && soon.includes('fido2') ? vt('pres_soon_fido2', lang) : t('m_key_d')}
            status={<Pill tone={hasKey ? 'ok' : 'off'} text={hasKey ? t('st_active') : soon.includes('fido2') && !view.presenceAvailable.includes('fido2') ? t('st_soon') : t('st_off')} />}>
            {presenceAction('fido2', hasKey)}
          </VaultRow>
        )}
        {!helloRow && !keyRow && (
          <VaultRow data="presence-none" isMobile={isMobile} title={vt('sec_presence', lang)} desc={vt('pres_unavailable', lang)}
            status={<Pill tone="off" text={vt('badge_na', lang)} />} />
        )}
        <VaultRow data="passkey" isMobile={isMobile} title={t('m_passkey')}
          desc={isPhone ? (here ? t('phoneReady') : t('m_passkey_none')) : passkeys > 0 ? t('m_passkey_d', { n: passkeys }) : t('m_passkey_none')}
          status={<Pill tone={passkeys > 0 || here ? 'ok' : 'off'} text={passkeys > 0 || here ? t('st_active') : t('st_off')} />}>
          <button type="button" style={btn} onClick={onGoDevices}>{t('manage')}</button>
        </VaultRow>
        <VaultRow data="authenticator" isMobile={isMobile} title={t('m_code')}
          desc={auth
            ? (auth.pausedUntil ? vtf('auth_paused', lang, { date: fmtFull(auth.pausedUntil, lang) }) : t('m_code_d', { date: auth.lastUsedAt ? fmtDate(auth.lastUsedAt, lang) : vt('auth_never', lang) }))
            : t('m_code_none')}
          status={<Pill tone={authTone} text={authStatus} />}
          extra={auth?.frozen ? <div style={{ marginTop: 8 }}><Note tone="bad">{vt('auth_frozen', lang)}</Note></div> : undefined}>
          {auth ? (
            <button type="button" style={btn} onClick={() => c.setWizard(['authenticator'])} title={c.tip('enroll-authenticator')} aria-label={`${vt('auth_replace', lang)}. ${c.tip('enroll-authenticator')}`}>
              {vt('auth_replace', lang)} <Gate code={c.g('enroll-authenticator').code} gesture={c.g('enroll-authenticator').gesture} lang={lang} />
            </button>
          ) : (
            <button type="button" style={styleFor('authenticator')} onClick={() => c.startSetup('authenticator')} title={vt('ultraBody', lang)}>{t('setupNow')}</button>
          )}
        </VaultRow>
      </Rows>
      <AfterRows><LearnMore label={t('learnUnlock')} onClick={() => setLearn(true)} /></AfterRows>

      {manage && (
        <Sheet closeLabel={t('close')} isMobile={isMobile} title={vt('sec_presence', lang)} onClose={() => setManage(false)}
          footer={<DialogActions><button type="button" onClick={() => setManage(false)} style={dialogButtonStyle('secondary', isMobile)}>{t('close')}</button></DialogActions>}>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 10 }}>{vt('sec_presence_d', lang)}</div>
          {(c.creds?.credentials ?? []).map(cr => (
            <div key={`${cr.type}-${cr.createdAt}`} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '8px 0', borderTop: '1px solid var(--border)' }}>
              {cr.type === 'hello' ? <FingerprintPattern size={14} /> : <Usb size={14} />}
              <span style={{ fontSize: 13, flex: 1, minWidth: 0 }}>{cr.label}</span>
              <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{vtf('pres_since', lang, { date: fmtDate(cr.createdAt, lang) })}</span>
            </div>
          ))}
          {!c.creds && <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{c.presWord}</div>}
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12, marginTop: 4 }}>
            {view.requirePresence
              ? <Note>{vt('pres_mainMachine', lang)}</Note>
              : (
                <>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 10 }}>{vt('pres_offConsequence', lang)}</div>
                  <button type="button" style={dangerOutline(isMobile)} onClick={() => { setManage(false); c.ask('presence-off') }}
                    title={c.tip('disable-presence')} aria-label={`${vt('pres_turnOff', lang)}. ${c.tip('disable-presence')}`}>
                    {vt('pres_turnOff', lang)} <Gate code={c.g('disable-presence').code} gesture={c.g('disable-presence').gesture} lang={lang} />
                  </button>
                </>
              )}
          </div>
        </Sheet>
      )}
      {learn && (
        <Sheet closeLabel={t('close')} isMobile={isMobile} title={vt('how_title', lang)} onClose={() => setLearn(false)} wide
          footer={<DialogActions><button type="button" onClick={() => setLearn(false)} style={dialogButtonStyle('secondary', isMobile)}>{t('close')}</button></DialogActions>}>
          <HowStrip view={view} lang={lang} isMobile={isMobile} minutes={view.autoLockMinutes} presWord={c.presWord} />
          <InfoBlocks blocks={[
            { h: t('m_code'), body: vt('auth_explain', lang) },
            { h: vt('sec_presence', lang), body: view.presence ? vt('sec_presence_d', lang) : vt('pres_off', lang) },
          ]} />
        </Sheet>
      )}
    </section>
  )
}

// ── Dispositivos ───────────────────────────────────────────────────────────────────────────────

export function DevicesArea({ lang, isMobile, mobile, isPhone, host, gated, onChanged }: {
  lang: Lang; isMobile: boolean; mobile: MobileState | null; isPhone: boolean; host: string; gated: Gated; onChanged: () => void
}) {
  const t = (k: PKey, v?: Record<string, string | number>) => pt_(k, lang, v)
  const [error, setError] = useState<string | null>(null)
  const [stale, setStale] = useState(0)
  const [howAdd, setHowAdd] = useState(false)
  const [learnCode, setLearnCode] = useState(false)
  const [remove, setRemove] = useState<null | { id: string; label: string; kind: 'passkey' | 'device' }>(null)
  useEffect(() => { if (!isPhone) void phoneFacts().then(f => { if (f.ok) setStale(f.stale) }) }, [isPhone, mobile])
  const btn = pageBtn(isMobile)
  const run = (p: Promise<Reply<unknown>>) => { setError(null); void p.then(r => { if (r.ok) onChanged(); else setError(r.sentence || t('network')) }) }
  const support = typeof window !== 'undefined' ? passkeySupport(window) : 'unsupported'
  const here = mobile ? hasPasskeyHere(mobile, host) : false
  const device = readDeviceKey()
  const deviceHere = Boolean(device && mobile?.codeReveal && mobile.devices?.some(d => d.id === device.deviceId))

  if (isPhone) {
    // §10: register through the request the computer approves; once this phone works, say so.
    return (
      <section data-vault-area="devices">
        <AreaHead title={t('tab_devices')} desc={t('area_devices_d')} isMobile={isMobile} />
        <Rows>
          {(here || deviceHere)
            ? <VaultRow data="this-phone" isMobile={isMobile} icon={<Smartphone size={16} />} title={t('dev_thisPhone')} desc={here ? t('phoneReady') : t('phoneCodeOn')} status={<Pill tone="ok" text={t('st_trusted')} />} />
            : <PhoneEnrol lang={lang} isMobile={isMobile} onDone={onChanged} />}
        </Rows>
        {support === 'unsupported' && <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 10 }}>{t('phoneUnsupported')}</div>}
      </section>
    )
  }

  const passkeys = mobile?.passkeys ?? []
  const devices = mobile?.devices ?? []
  return (
    <section data-vault-area="devices">
      <AreaHead title={t('tab_devices')} desc={t('area_devices_d')} isMobile={isMobile}
        actions={<button type="button" style={{ ...hotBtn(isMobile), flex: isMobile ? 1 : undefined }} onClick={() => setHowAdd(true)}><Smartphone size={14} /> {t('addPhone')}</button>} />
      <Rows>
        <VaultRow data="this-pc" isMobile={isMobile} icon={<Laptop size={16} />} title={t('dev_thisPc')} desc={t('dev_thisPc_d')} status={<Pill tone="ok" text={t('st_trusted')} />} />
        {passkeys.map(p => (
          <VaultRow key={p.id} data="passkey" isMobile={isMobile} icon={<Smartphone size={16} />} title={p.label} desc={t('dev_passkey_d', { rp: p.rpId })}>
            <button type="button" style={dangerOutline(isMobile)} onClick={() => setRemove({ id: p.id, label: p.label, kind: 'passkey' })}>{t('phoneRemove')}</button>
          </VaultRow>
        ))}
        {devices.map(d => (
          <VaultRow key={d.id} data="device" isMobile={isMobile} icon={<Smartphone size={16} />} title={d.label} desc={t('dev_device_d')}>
            <button type="button" style={dangerOutline(isMobile)} onClick={() => setRemove({ id: d.id, label: d.label, kind: 'device' })}>{t('phoneRemove')}</button>
          </VaultRow>
        ))}
        {passkeys.length === 0 && devices.length === 0 && <div style={{ fontSize: 12, color: 'var(--text-tertiary)', padding: '4px 2px' }}>{t('phoneNone')}</div>}
        {stale > 0 && (
          <VaultRow data="stale" isMobile={isMobile} title={t('phoneStale', { n: stale })} status={<Pill tone="warn" text={String(stale)} />}>
            <button type="button" style={btn} onClick={() => run(gated(cd => clearStalePhones(cd), { action: 'mobile-passkey-remove', target: '' }))}>{t('phoneStaleClear')}</button>
          </VaultRow>
        )}
      </Rows>
      {error && <div style={{ marginTop: 8 }}><Err text={error} /></div>}
      {mobile && (
        <AfterRows>
          <VaultRow data="code-reveal" isMobile={isMobile} title={t('codeOnPhone')}
            desc={<>{t('codeOnPhone_d')} <LearnMore label={t('learnMore')} onClick={() => setLearnCode(true)} /></>}>
            <Toggle on={mobile.codeReveal} label={t('codeOnPhone')}
              onToggle={() => run(gated(cd => setCodeReveal(!mobile.codeReveal, cd), { action: 'mobile-code-reveal', target: '' }))} />
          </VaultRow>
        </AfterRows>
      )}

      <ConfirmModal open={remove !== null} title={t('removeTitle', { name: remove?.label ?? '' })} message={t('removePhoneMsg')} confirmLabel={t('phoneRemove')} cancelLabel={t('cancel')}
        onCancel={() => setRemove(null)} onConfirm={() => {
          const r = remove; setRemove(null)
          if (!r) return
          run(gated(cd => (r.kind === 'passkey' ? removePasskey(r.id, cd) : removeDevice(r.id, cd)), { action: 'mobile-passkey-remove', target: r.id }))
        }} />
      {howAdd && (
        <Sheet closeLabel={t('close')} isMobile={isMobile} title={t('addPhone')} onClose={() => setHowAdd(false)}
          footer={<DialogActions><button type="button" onClick={() => setHowAdd(false)} style={dialogButtonStyle('secondary', isMobile)}>{t('close')}</button></DialogActions>}>
          <InfoBlocks blocks={[{ body: t('phoneDesktopIntro') }, { body: t('phoneLockedRegister') }, { body: t('phoneInsecure') }]} />
        </Sheet>
      )}
      {learnCode && (
        <Sheet closeLabel={t('close')} isMobile={isMobile} title={t('codeOnPhone')} onClose={() => setLearnCode(false)}
          footer={<DialogActions><button type="button" onClick={() => setLearnCode(false)} style={dialogButtonStyle('secondary', isMobile)}>{t('close')}</button></DialogActions>}>
          <InfoBlocks blocks={[{ body: t('phoneCodeToggle') }, { body: t('phoneCodeCost') }]} />
        </Sheet>
      )}
    </section>
  )
}

// ── Configurações ──────────────────────────────────────────────────────────────────────────────

export function SettingsArea({ lang, isMobile, c, isPhone, gated, onFlash }: {
  lang: Lang; isMobile: boolean; c: VaultControls; isPhone: boolean; gated: Gated; onFlash: (s: string) => void
}) {
  const t = (k: PKey, v?: Record<string, string | number>) => pt_(k, lang, v)
  const navigate = useNavigate()
  const [edit, setEdit] = useState<null | 'autolock' | 'policy'>(null)
  const [learn, setLearn] = useState(false)
  const [wipeAsk, setWipeAsk] = useState(false)
  const view = c.view
  if (!view) return null
  const btn = pageBtn(isMobile)
  const left = remainingMs(view.autoLockInMs, c.reportedAt, c.now)
  const pres = presWordOf(view, lang)
  const policy = view.unlockPolicy ?? { mode: 'daily' as const, hours: 24, chosen: false, codeNextUnlock: true, windowEndsAt: null }
  const close = () => setEdit(null)
  const recoveryDesc = view.recoveryCreatedAt ? vtf('rec_created', lang, { date: fmtDate(view.recoveryCreatedAt, lang) }) : vt('rec_none', lang)
  return (
    <section data-vault-area="settings">
      <AreaHead title={t('tab_settings')} desc={t('area_settings_d')} isMobile={isMobile} />
      <Rows>
        <VaultRow data="state" isMobile={isMobile} title={t('set_state')}
          desc={left !== null ? t('set_state_d', { n: minutesLeft(left) }) : vt('state_open', lang)} status={<Pill tone="ok" text={t('st_open')} />}>
          <button type="button" style={btn} onClick={() => c.ask('lock')} disabled={!view.canLock} title={c.tip('lock')} aria-label={`${vt('lockNow', lang)}. ${c.tip('lock')}`}>
            {vt('lockNow', lang)} <Gate code={c.g('lock').code} gesture={c.g('lock').gesture} lang={lang} />
          </button>
        </VaultRow>
        <VaultRow data="autolock" isMobile={isMobile} title={vt('sec_autolock', lang)} desc={t('set_autolock_d', { n: view.autoLockMinutes })}>
          <button type="button" style={btn} onClick={() => setEdit('autolock')} title={c.tip('set-auto-lock')}>{t('change')}</button>
        </VaultRow>
        {view.presence && view.authenticator && (
          <VaultRow data="policy" isMobile={isMobile} title={vt('sec_unlock', lang)}
            desc={[vt(unlockModeKey(policy.mode), lang).replace('{presence}', pres), policy.windowEndsAt && !policy.codeNextUnlock ? vtf('unlock_now_window', lang, { time: fmtTime(policy.windowEndsAt, lang), presence: pres }) : policy.codeNextUnlock && policy.mode !== 'hello-only' ? vt('unlock_now_code', lang) : ''].filter(Boolean).join(' · ')}>
            <button type="button" style={btn} onClick={() => setEdit('policy')} title={c.tip('set-unlock-policy')}>{t('change')}</button>
          </VaultRow>
        )}
        <VaultRow data="recovery" isMobile={isMobile} title={vt('sec_recovery', lang)} desc={view.recoveryCreatedAt ? `${recoveryDesc} · ${t('rec_new_d')}` : recoveryDesc}
          status={view.recoveryCreatedAt ? undefined : <Pill tone="warn" text={t('st_missing')} />}>
          <button type="button" style={view.recoveryCreatedAt ? btn : c.primary === 'recovery' ? hotBtn(isMobile) : btn}
            title={view.recoveryCreatedAt ? c.tip('rotate-recovery') : vt('ultraBody', lang)}
            onClick={() => (view.recoveryCreatedAt ? c.setWizard(['recovery']) : c.startSetup('recovery'))}>
            {view.recoveryCreatedAt ? t('rec_new_short') : vt('rec_create', lang)}
            <Gate code={c.g('rotate-recovery').code && Boolean(view.recoveryCreatedAt)} gesture={c.g('rotate-recovery').gesture && Boolean(view.recoveryCreatedAt)} lang={lang} />
          </button>
        </VaultRow>
        {c.canRecover && (
          <VaultRow data="recover" isMobile={isMobile} title={vt('rec_recover', lang)} desc={t('rec_recover_d')}>
            <button type="button" style={btn} onClick={() => c.setRecoverOpen(true)}>{t('rec_recover_short')}</button>
          </VaultRow>
        )}
        {!isPhone && (
          <VaultRow data="backup" isMobile={isMobile} title={t('set_backup')} desc={t('set_backup_d')}>
            <button type="button" style={btn} onClick={() => navigate('/settings/backup')}>{t('openBackup')}</button>
          </VaultRow>
        )}
      </Rows>

      {!isPhone && (
        <div data-vault-danger style={{
          marginTop: 18, borderTop: '1px solid color-mix(in srgb, var(--accent-red, #ef4444) 30%, transparent)', padding: '15px 0 12px',
          background: 'color-mix(in srgb, var(--accent-red, #ef4444) 4%, transparent)',
        }}>
          <h3 style={{ fontSize: 13, fontWeight: 650, margin: '0 0 4px', color: 'var(--accent-red, #ef4444)' }}>{t('danger')}</h3>
          <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '0 0 12px' }}>{t('danger_d')}</p>
          <button type="button" style={{ ...dangerOutline(isMobile), width: isMobile ? '100%' : undefined }} onClick={() => setWipeAsk(true)}>{t('dangerBtn')}</button>
        </div>
      )}
      <AfterRows><LearnMore label={t('learnProtect')} onClick={() => setLearn(true)} /></AfterRows>

      {edit === 'autolock' && (
        <Sheet closeLabel={t('close')} isMobile={isMobile} title={vt('sec_autolock', lang)} onClose={close}
          footer={<DialogActions><button type="button" onClick={close} style={dialogButtonStyle('secondary', isMobile)}>{t('cancel')}</button></DialogActions>}>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 12 }}>{vt('sec_autolock_d', lang)}</div>
          <AutoLockRow view={view} lang={lang} isMobile={isMobile} gate={c.g('set-auto-lock')} tipText={c.tip('set-auto-lock')} btn={hotBtn(isMobile)}
            onSave={m => { close(); c.ask('autolock', m) }} />
        </Sheet>
      )}
      {edit === 'policy' && (
        <Sheet closeLabel={t('close')} isMobile={isMobile} title={vt('sec_unlock', lang)} onClose={close}
          footer={<DialogActions><button type="button" onClick={close} style={dialogButtonStyle('secondary', isMobile)}>{t('cancel')}</button></DialogActions>}>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 12 }}>{vtf('sec_unlock_d', lang, { presence: pres })}</div>
          <UnlockPolicyRow view={view} lang={lang} isMobile={isMobile} gate={c.g('set-unlock-policy')} btn={hotBtn(isMobile)}
            onSave={p => { close(); c.ask('unlock-policy', undefined, p) }} />
        </Sheet>
      )}
      {learn && (
        <Sheet closeLabel={t('close')} isMobile={isMobile} title={t('learnProtect')} onClose={() => setLearn(false)} wide
          footer={<DialogActions><button type="button" onClick={() => setLearn(false)} style={dialogButtonStyle('secondary', isMobile)}>{t('close')}</button></DialogActions>}>
          <InfoBlocks blocks={[
            { h: vt('sec_status', lang), body: (
              <>
                {vt('protector', lang)}: {view.protectorLabel ?? vt('none', lang)}<br />
                {vt('keyId', lang)}: <span style={{ fontFamily: 'var(--font-mono, ui-monospace, monospace)', wordBreak: 'break-all' }}>{view.kid ?? vt('none', lang)}</span><br />
                {vt('created', lang)}: {view.createdAt ? fmtFull(view.createdAt, lang) : vt('none', lang)}
              </>
            ) },
            { h: vt('sec_recovery', lang), body: <>{vt('sec_recovery_d', lang)} {vt('rec_offline', lang)} {vt('rec_lost', lang)}</> },
            { h: vt('sec_hardening', lang), body: <><span style={{ display: 'block', marginBottom: 6 }}>{vt('sec_memory_d', lang)}</span><HardeningBlock view={view} lang={lang} /></> },
            ...([['how_envelope_h', 'how_envelope'], ['how_holder_h', 'how_holder'], ['how_protects_h', 'how_protects'], ['how_not_h', 'how_not'], ['how_backup_h', 'how_backup']] as const)
              .map(([h, b]) => ({ h: vt(h, lang), body: vt(b, lang) })),
            { h: t('set_backup'), body: <>{t('backupNote')} {t('neverPaste')}</> },
          ]} />
        </Sheet>
      )}
      <ConfirmModal open={wipeAsk} title={t('backupWipe')} message={t('backupWipeConfirm')} confirmLabel={t('dangerBtn')} cancelLabel={t('cancel')}
        onCancel={() => setWipeAsk(false)} onConfirm={() => {
          setWipeAsk(false)
          void gated(cd => wipeBackupHistory(cd), { action: 'personal-backup-wipe', target: '' }).then(r => onFlash(r.ok ? t('backupWiped', { n: r.deleted }) : (r.sentence || t('network'))))
        }} />
    </section>
  )
}
