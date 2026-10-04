import { Check } from 'lucide-react'
import { t } from '@agentistics/core'
import type { SurfaceHarnessId, HarnessCapabilities, Lang } from '@agentistics/core'
import { HARNESS_INFO, HARNESS_LABELS, HARNESS_COLORS, HARNESS_PROVIDERS, capable } from '../lib/harness'
import { useChatHarnesses } from '../hooks/useChatHarnesses'
import { useIsMobile } from '../hooks/useIsMobile'

/** Polished mono font stack — used only for paths and shell commands. */
const MONO = `ui-monospace, 'SF Mono', 'JetBrains Mono', Menlo, Consolas, monospace`

const CAPABILITY_ROW_KEYS: { tKey: string; key: keyof HarnessCapabilities }[] = [
  { tKey: 'harness.panel.cap.tokens',   key: 'tokens'   },
  { tKey: 'harness.panel.cap.cost',     key: 'cost'     },
  { tKey: 'harness.panel.cap.model',    key: 'model'    },
  { tKey: 'harness.panel.cap.tools',    key: 'tools'    },
  { tKey: 'harness.panel.cap.agents',   key: 'agents'   },
  { tKey: 'harness.panel.cap.gitLines', key: 'gitLines' },
]

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: 10, fontWeight: 700, color: 'var(--text-tertiary)',
      letterSpacing: '0.07em', textTransform: 'uppercase', marginBottom: 8,
    }}>
      {children}
    </div>
  )
}

interface Props {
  harness: SurfaceHarnessId
  lang: Lang
}

/** Inline panel (no overlay) explaining a harness's data: where it comes from,
 *  what is captured, what is not, and any caveats. Rendered inside the Settings
 *  "Data & sources" tab. `lang` is passed in (this can render outside the router
 *  Outlet, so it cannot use useOutletContext). */
export function HarnessInfoPanel({ harness, lang }: Props) {
  const isMobile = useIsMobile()
  const info = HARNESS_INFO[harness]
  const label = HARNESS_LABELS[harness]
  const color = HARNESS_COLORS[harness]
  const provider = HARNESS_PROVIDERS[harness]
  const { harnesses: chatHarnesses, loading: chatLoading } = useChatHarnesses()
  const chatStatus = chatHarnesses.find(h => h.id === harness)

  return (
    <div style={{
      background: 'var(--bg-surface)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius-lg)',
      padding: isMobile ? '14px 12px' : '20px 22px',
      display: 'flex',
      flexDirection: 'column',
      gap: 20,
    }}>

      {/*  Header  */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{
            display: 'inline-block', width: 10, height: 10, borderRadius: '50%',
            background: color, flexShrink: 0,
          }} />
          <span style={{ fontSize: 15, fontWeight: 700, color }}>{label}</span>
          <span style={{ fontSize: 15, fontWeight: 500, color: 'var(--text-secondary)' }}>
            {t('harness.panel.data_label', lang)}
          </span>
        </div>
        {info.blurb && (
          <p style={{ margin: 0, fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.55, paddingLeft: 18 }}>
            {info.blurb[lang]}
          </p>
        )}
      </div>

      {/*  Two-column body  */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
        gap: 20,
        alignItems: 'start',
      }}>

        {/* Left column: data sources + on-disk format + retention */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

          {/* Source */}
          <section>
            <SectionLabel>{t('harness.panel.source_section', lang)}</SectionLabel>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {info.source.map((s, i) => (
                <div key={i} style={{
                  fontFamily: MONO, fontSize: 11, color: 'var(--text-secondary)',
                  background: 'var(--bg-elevated)', border: '1px solid var(--border)',
                  borderRadius: 5, padding: '5px 9px', wordBreak: 'break-all',
                }}>
                  {s}
                </div>
              ))}
            </div>
          </section>

          {/* On-disk format */}
          {info.format && (
            <section>
              <SectionLabel>{t('harness.panel.format_section', lang)}</SectionLabel>
              <p style={{ margin: 0, fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.55 }}>
                {info.format[lang]}
              </p>
            </section>
          )}

          {/* Retention */}
          {info.retention && (
            <section>
              <SectionLabel>{t('harness.panel.retention_section', lang)}</SectionLabel>
              <p style={{ margin: 0, fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.55 }}>
                {info.retention[lang]}
              </p>
            </section>
          )}
        </div>

        {/* Right column: capability matrix + captured + missing + note */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

          {/* Capability matrix */}
          <section>
            <SectionLabel>{t('harness.panel.capabilities_section', lang)}</SectionLabel>
            <div style={{
              display: 'grid', gridTemplateColumns: '1fr auto',
              rowGap: 5, columnGap: 12,
              alignItems: 'center',
            }}>
              {CAPABILITY_ROW_KEYS.map(({ tKey, key }) => {
                const yes = capable(harness, key)
                return [
                  <span key={`${key}-label`} style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                    {t(tKey, lang)}
                  </span>,
                  yes
                    ? <span key={`${key}-val`} style={{ display: 'flex', alignItems: 'center', gap: 4, justifyContent: 'flex-end' }}>
                        <Check size={11} style={{ color: 'var(--accent-green)' }} />
                        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--accent-green)' }}>
                          {t('harness.panel.cap.available', lang)}
                        </span>
                      </span>
                    : <span key={`${key}-val`} style={{
                        fontSize: 11, fontWeight: 600, color: 'var(--text-tertiary)',
                        textAlign: 'right',
                      }}>N/A</span>,
                ]
              })}
            </div>
          </section>

          {/* Captured */}
          <section>
            <SectionLabel>{t('harness.panel.captured_section', lang)}</SectionLabel>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              {info.contains.map((item, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 7 }}>
                  <Check size={12} style={{ color: 'var(--accent-green)', marginTop: 1, flexShrink: 0 }} />
                  <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{item[lang]}</span>
                </div>
              ))}
            </div>
          </section>

          {/* Not available */}
          <section>
            <SectionLabel>{t('harness.panel.not_available_section', lang)}</SectionLabel>
            {info.missing.length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', fontStyle: 'italic' }}>
                {t('harness.panel.all_tracked', lang)}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {info.missing.map((m, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 7 }}>
                    <span style={{
                      display: 'inline-block', width: 4, height: 4, borderRadius: '50%',
                      background: 'var(--text-tertiary)', marginTop: 5, flexShrink: 0,
                    }} />
                    <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                      <strong style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>{m.item[lang]}</strong>
                      {' — '}
                      {m.why[lang]}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Note */}
          {info.note && (
            <section style={{
              background: 'var(--bg-elevated)', border: '1px solid var(--border)',
              borderRadius: 7, padding: '10px 12px',
            }}>
              <SectionLabel>{t('harness.panel.note_section', lang)}</SectionLabel>
              <p style={{
                fontSize: 11, color: 'var(--text-tertiary)', fontStyle: 'italic',
                lineHeight: 1.5, margin: 0,
              }}>
                {info.note[lang]}
              </p>
            </section>
          )}
        </div>
      </div>

      {/*  Cost basis (full-width)  */}
      <section style={{
        background: 'var(--bg-elevated)', border: '1px solid var(--border)',
        borderRadius: 7, padding: '10px 12px',
      }}>
        <SectionLabel>{t('harness.panel.cost_basis_section', lang)}</SectionLabel>
        {capable(harness, 'cost') ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <p style={{ margin: 0, fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.55 }}>
              {t('harness.panel.cost_basis_text', lang)}
            </p>
            {info.pricingUrl && (
              <a
                href={info.pricingUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  fontSize: 11, color: 'var(--accent-blue)',
                  textDecoration: 'none',
                  display: 'inline-block',
                }}
              >
                {t('harness.panel.view_pricing', lang).replace('{provider}', provider)}
              </a>
            )}
          </div>
        ) : (
          <p style={{ margin: 0, fontSize: 12, color: 'var(--text-tertiary)', fontStyle: 'italic', lineHeight: 1.55 }}>
            {t('harness.panel.cost_na', lang)}
          </p>
        )}
      </section>

      {/*  Nay backend status (full-width)  */}
      {!chatLoading && chatStatus && (
        <section style={{
          background: 'var(--bg-elevated)', border: '1px solid var(--border)',
          borderRadius: 7, padding: '10px 12px',
        }}>
          <SectionLabel>{t('harness.panel.nay_backend_section', lang)}</SectionLabel>

          {chatStatus.ready ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Check size={12} style={{ color: 'var(--accent-green)', flexShrink: 0 }} />
              <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                {t('harness.panel.nay_ready', lang)}
              </span>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {/* Status badges */}
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <span style={{
                  fontSize: 10, fontWeight: 600,
                  color: chatStatus.installed ? 'var(--accent-green)' : 'var(--text-tertiary)',
                  background: chatStatus.installed ? 'color-mix(in srgb, var(--accent-green) 12%, transparent)' : 'var(--bg-surface)',
                  border: `1px solid ${chatStatus.installed ? 'color-mix(in srgb, var(--accent-green) 30%, transparent)' : 'var(--border)'}`,
                  borderRadius: 4, padding: '2px 7px',
                }}>
                  {chatStatus.installed ? t('harness.panel.installed', lang) : t('harness.panel.not_installed', lang)}
                </span>
                <span style={{
                  fontSize: 10, fontWeight: 600,
                  color: chatStatus.authReady ? 'var(--accent-green)' : 'var(--text-tertiary)',
                  background: chatStatus.authReady ? 'color-mix(in srgb, var(--accent-green) 12%, transparent)' : 'var(--bg-surface)',
                  border: `1px solid ${chatStatus.authReady ? 'color-mix(in srgb, var(--accent-green) 30%, transparent)' : 'var(--border)'}`,
                  borderRadius: 4, padding: '2px 7px',
                }}>
                  {chatStatus.authReady ? t('harness.panel.authenticated', lang) : t('harness.panel.not_authenticated', lang)}
                </span>
              </div>

              {/* Setup guidance */}
              {chatStatus.setup.installCmd && !chatStatus.installed && (
                <div>
                  <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginBottom: 3 }}>
                    {t('harness.panel.install_label', lang)}
                  </div>
                  <div style={{
                    fontFamily: MONO, fontSize: 11, color: 'var(--text-secondary)',
                    background: 'var(--bg-surface)', border: '1px solid var(--border)',
                    borderRadius: 5, padding: '4px 8px', wordBreak: 'break-all',
                  }}>
                    {chatStatus.setup.installCmd}
                  </div>
                </div>
              )}

              {chatStatus.setup.loginCmd && chatStatus.installed && !chatStatus.authReady && (
                <div>
                  <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginBottom: 3 }}>
                    {t('harness.panel.login_label', lang)}
                  </div>
                  <div style={{
                    fontFamily: MONO, fontSize: 11, color: 'var(--text-secondary)',
                    background: 'var(--bg-surface)', border: '1px solid var(--border)',
                    borderRadius: 5, padding: '4px 8px', wordBreak: 'break-all',
                  }}>
                    {chatStatus.setup.loginCmd}
                  </div>
                </div>
              )}

              {chatStatus.setup.note && (
                <p style={{
                  fontSize: 11, color: 'var(--text-tertiary)', fontStyle: 'italic',
                  lineHeight: 1.5, margin: 0,
                }}>
                  {chatStatus.setup.note}
                </p>
              )}

              {chatStatus.setup.docUrl && (
                <a
                  href={chatStatus.setup.docUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    fontSize: 11, color: 'var(--accent-blue)',
                    textDecoration: 'none',
                    display: 'inline-block',
                  }}
                >
                  {t('harness.panel.setup_guide', lang)}
                </a>
              )}
            </div>
          )}
        </section>
      )}
    </div>
  )
}
