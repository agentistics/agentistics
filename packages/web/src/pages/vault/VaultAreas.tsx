/**
 * Three of the `/vault` page's four tabs (VAULT v4): Métodos de desbloqueio, Dispositivos and
 * Configurações. Every control the old Settings → Vault screen and the old page's phone panel offered
 * lives here as ONE row — title, one line, a status, one action — and anything longer than a line sits
 * behind a "Saiba mais". The calls, gates and flows are the old ones (`useVaultControls`, `VaultFlows`,
 * `lib/passkey`, `lib/phoneVault`): this file only lays them out.
 */
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { FingerprintPattern, KeyRound, Laptop, Smartphone, Usb } from 'lucide-react'
import { ConfirmModal, DialogActions, Toggle, dialogButtonStyle } from '../settings/primitives'
import { Err } from '../../components/MfaSetup'
import { PhoneEnrol } from '../../components/vault/VaultUnlock'
import { AutoLockRow, Gate, HardeningBlock, HowStrip, Note, presWordOf, soonKinds } from '../../components/vault/VaultFlows'
import { addableKinds, authPolicyChanged, minutesLeft, remainingMs, type Reply, type UnlockMethodId } from '../../lib/vaultApi'
import { AuthPolicyTable } from '../../components/vault/AuthPolicyTable'
import { methodNameKey, vt, vtf } from '../../lib/vaultText'
import { pt_, type PKey } from '../../lib/personalText'
import { wipeBackupHistory } from '../../lib/vaultPersonal'
import { hasPasskeyHere, passkeySupport, removePasskey, type MobileState } from '../../lib/passkey'
import { clearStalePhones, phoneFacts, removeDevice } from '../../lib/phoneVault'
import type { VaultControls } from './useVaultControls'
import { CustomTypesRow } from '../../components/vault/KindTypes'
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
  const addable = addableKinds(view)
  const soon = soonKinds(view)
  const turnOn = (k: UnlockMethodId) => {
    // The first way to confirm runs the whole missing flow on that kind; another beside one already on is "add another way".
    c.setWizardKind(k)
    if (view.presence) c.setWizard(['presence']); else c.startSetup('presence')
  }
  // COFRE.DESBLOQUEIO: one row per way this machine offers (or already holds), in the server's order —
  // the security key last and only when its tools are here (it is the advanced one).
  const offered: UnlockMethodId[] = (view.unlockMethods ?? []).map(m => m.id)
  const rows = (['touchid', 'hello', 'password', 'fido2'] as const).filter(k => view.wrappers.includes(k) || offered.includes(k) || (k === 'fido2' && soon.includes('fido2')))
  const methodDesc: Record<UnlockMethodId, string> = {
    touchid: vt('wiz_method_touchid_d', lang), hello: vt('wiz_method_hello_d', lang), password: vt('wiz_method_password_d', lang), fido2: vt('wiz_method_fido2_d', lang),
  }
  const presenceAction = (k: UnlockMethodId, on: boolean) => on
    ? <button type="button" style={btn} onClick={() => setManage(true)}>{t('manage')}</button>
    : addable.includes(k) || (!view.presence && offered.includes(k))
      ? (
        <button type="button" style={view.presence ? btn : c.primary === 'presence' ? hot : btn} onClick={() => turnOn(k)}
          title={c.tip('enroll-presence')} aria-label={`${vt(`pres_add_${k}`, lang)}. ${c.tip('enroll-presence')}`}>
          {view.presence ? vt(`pres_add_${k}`, lang) : t('activate')} {view.presence && <Gate gesture={c.g('enroll-presence').gesture} lang={lang} />}
        </button>
      )
      : null
  const passkeys = mobile?.passkeys.length ?? 0
  const here = isPhone && mobile ? hasPasskeyHere(mobile, typeof window !== 'undefined' ? window.location.hostname : '') : false
  return (
    <section data-vault-area="methods">
      <AreaHead title={t('tab_methods')} desc={t('area_methods_d')} isMobile={isMobile} />
      {view.legacyAppCode && <div style={{ marginBottom: 10 }}><Note>{vt('legacy_code_note', lang)}</Note></div>}
      <Rows>
        {rows.map(k => {
          const on = view.wrappers.includes(k)
          const soonOnly = !on && !offered.includes(k) && soon.includes(k)
          return (
            <VaultRow key={k} data={k} isMobile={isMobile} title={vt(methodNameKey(k), lang)}
              desc={soonOnly && k === 'fido2' ? vt('pres_soon_fido2', lang) : methodDesc[k]}
              status={<Pill tone={on ? 'ok' : 'off'} text={on ? t('st_active') : soonOnly ? t('st_soon') : t('st_off')} />}>
              {presenceAction(k, on)}
            </VaultRow>
          )
        })}
        {rows.length === 0 && (
          <VaultRow data="presence-none" isMobile={isMobile} title={vt('sec_presence', lang)} desc={vt('pres_unavailable', lang)}
            status={<Pill tone="off" text={vt('badge_na', lang)} />} />
        )}
        <VaultRow data="passkey" isMobile={isMobile} title={t('m_passkey')}
          desc={isPhone ? (here ? t('phoneReady') : t('m_passkey_none')) : passkeys > 0 ? t('m_passkey_d', { n: passkeys }) : t('m_passkey_none')}
          status={<Pill tone={passkeys > 0 || here ? 'ok' : 'off'} text={passkeys > 0 || here ? t('st_active') : t('st_off')} />}>
          <button type="button" style={btn} onClick={onGoDevices}>{t('manage')}</button>
        </VaultRow>
      </Rows>
      <AfterRows><LearnMore label={t('learnUnlock')} onClick={() => setLearn(true)} /></AfterRows>

      {manage && (
        <Sheet closeLabel={t('close')} isMobile={isMobile} title={vt('sec_presence', lang)} onClose={() => setManage(false)}
          footer={<DialogActions><button type="button" onClick={() => setManage(false)} style={dialogButtonStyle('secondary', isMobile)}>{t('close')}</button></DialogActions>}>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 10 }}>{vt('sec_presence_d', lang)}</div>
          {(c.creds?.credentials ?? []).map(cr => (
            <div key={`${cr.type}-${cr.createdAt}`} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '8px 0', borderTop: '1px solid var(--border)' }}>
              {cr.type === 'fido2' ? <Usb size={14} /> : cr.type === 'password' ? <KeyRound size={14} /> : <FingerprintPattern size={14} />}
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
                    {vt('pres_turnOff', lang)} <Gate gesture={c.g('disable-presence').gesture} lang={lang} />
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
  const [remove, setRemove] = useState<null | { id: string; label: string; kind: 'passkey' | 'device' }>(null)
  useEffect(() => { if (!isPhone) void phoneFacts().then(f => { if (f.ok) setStale(f.stale) }) }, [isPhone, mobile])
  const btn = pageBtn(isMobile)
  const run = (p: Promise<Reply<unknown>>) => { setError(null); void p.then(r => { if (r.ok) onChanged(); else setError(r.sentence || t('network')) }) }
  const support = typeof window !== 'undefined' ? passkeySupport(window) : 'unsupported'
  const here = mobile ? hasPasskeyHere(mobile, host) : false

  if (isPhone) {
    // §10: register through the request the computer approves; once this phone works, say so.
    return (
      <section data-vault-area="devices">
        <AreaHead title={t('tab_devices')} desc={t('area_devices_d')} isMobile={isMobile} />
        <Rows>
          {here
            ? <VaultRow data="this-phone" isMobile={isMobile} icon={<Smartphone size={16} />} title={t('dev_thisPhone')} desc={t('phoneReady')} status={<Pill tone="ok" text={t('st_trusted')} />} />
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
            <button type="button" style={btn} onClick={() => run(gated(() => clearStalePhones(), { action: 'mobile-passkey-remove', target: '' }))}>{t('phoneStaleClear')}</button>
          </VaultRow>
        )}
      </Rows>
      {error && <div style={{ marginTop: 8 }}><Err text={error} /></div>}

      <ConfirmModal open={remove !== null} title={t('removeTitle', { name: remove?.label ?? '' })} message={t('removePhoneMsg')} confirmLabel={t('phoneRemove')} cancelLabel={t('cancel')}
        onCancel={() => setRemove(null)} onConfirm={() => {
          const r = remove; setRemove(null)
          if (!r) return
          run(gated(cd => (r.kind === 'passkey' ? removePasskey(r.id, cd) : removeDevice(r.id)), { action: 'mobile-passkey-remove', target: r.id }))
        }} />
      {howAdd && (
        <Sheet closeLabel={t('close')} isMobile={isMobile} title={t('addPhone')} onClose={() => setHowAdd(false)}
          footer={<DialogActions><button type="button" onClick={() => setHowAdd(false)} style={dialogButtonStyle('secondary', isMobile)}>{t('close')}</button></DialogActions>}>
          <InfoBlocks blocks={[{ body: t('phoneDesktopIntro') }, { body: t('phoneLockedRegister') }, { body: t('phoneInsecure') }]} />
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
  const [edit, setEdit] = useState<null | 'autolock' | 'auth'>(null)
  const [learn, setLearn] = useState(false)
  const [wipeAsk, setWipeAsk] = useState(false)
  const view = c.view
  if (!view) return null
  const btn = pageBtn(isMobile)
  const left = remainingMs(view.autoLockInMs, c.reportedAt, c.now)
  const pres = presWordOf(view, lang)
  const close = () => setEdit(null)
  const recoveryDesc = view.recoveryCreatedAt ? vtf('rec_created', lang, { date: fmtDate(view.recoveryCreatedAt, lang) }) : vt('rec_none', lang)
  return (
    <section data-vault-area="settings">
      <AreaHead title={t('tab_settings')} desc={t('area_settings_d')} isMobile={isMobile} />
      <Rows>
        <VaultRow data="state" isMobile={isMobile} title={t('set_state')}
          desc={left !== null ? t('set_state_d', { n: minutesLeft(left) }) : vt('state_open', lang)} status={<Pill tone="ok" text={t('st_open')} />}>
          <button type="button" style={btn} onClick={() => c.ask('lock')} disabled={!view.canLock} title={c.tip('lock')} aria-label={`${vt('lockNow', lang)}. ${c.tip('lock')}`}>
            {vt('lockNow', lang)} <Gate gesture={c.g('lock').gesture} lang={lang} />
          </button>
        </VaultRow>
        <VaultRow data="autolock" isMobile={isMobile} title={vt('sec_autolock', lang)} desc={t('set_autolock_d', { n: view.autoLockMinutes })}>
          <button type="button" style={btn} onClick={() => setEdit('autolock')} title={c.tip('set-auto-lock')}>{t('change')}</button>
        </VaultRow>
        <VaultRow data="confirm-each-use" isMobile={isMobile} title={vt('cfu_title', lang)} desc={vt('cfu_d', lang)}>
          <Toggle on={view.confirmEachUse === true} label={vt('cfu_title', lang)} onToggle={() => c.ask('confirm-each-use', undefined, undefined, view.confirmEachUse !== true)} />
        </VaultRow>
        {view.authPolicy && view.authPolicy.rows.length > 0 && (
          <VaultRow data="authpolicy" isMobile={isMobile} title={vt('ap_title', lang)}
            desc={authPolicyChanged(view.authPolicy.rows) > 0
              ? vtf('ap_row_d', lang, { n: authPolicyChanged(view.authPolicy.rows), total: view.authPolicy.rows.length })
              : vtf('ap_row_default', lang, { presence: pres })}>
            <button type="button" style={btn} onClick={() => setEdit('auth')} title={c.tip('set-auth-policy')}>{t('change')}</button>
          </VaultRow>
        )}
        <CustomTypesRow lang={lang} isMobile={isMobile} />
        <VaultRow data="recovery" isMobile={isMobile} title={vt('sec_recovery', lang)} desc={view.recoveryCreatedAt ? `${recoveryDesc} · ${t('rec_new_d')}` : recoveryDesc}
          status={view.recoveryCreatedAt ? undefined : <Pill tone="warn" text={t('st_missing')} />}>
          <button type="button" style={view.recoveryCreatedAt ? btn : c.primary === 'recovery' ? hotBtn(isMobile) : btn}
            title={view.recoveryCreatedAt ? c.tip('rotate-recovery') : vt('ultraBody', lang)}
            onClick={() => (view.recoveryCreatedAt ? c.setWizard(['recovery']) : c.startSetup('recovery'))}>
            {view.recoveryCreatedAt ? t('rec_new_short') : vt('rec_create', lang)}
            <Gate gesture={c.g('rotate-recovery').gesture && Boolean(view.recoveryCreatedAt)} lang={lang} />
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
      {edit === 'auth' && (
        <Sheet closeLabel={t('close')} isMobile={isMobile} title={vt('ap_title', lang)} onClose={close} wide
          footer={<DialogActions><button type="button" onClick={close} style={dialogButtonStyle('secondary', isMobile)}>{t('cancel')}</button></DialogActions>}>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 12 }}>{vtf('ap_desc', lang, { presence: pres })}</div>
          <AuthPolicyTable view={view} lang={lang} isMobile={isMobile} gate={c.g('set-auth-policy')} btn={hotBtn(isMobile)}
            onSave={d => { close(); c.ask('auth-policy', undefined, d) }} />
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
