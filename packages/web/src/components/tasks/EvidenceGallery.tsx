/**
 * EvidenceGallery — the task-scoped variant of the session gallery: every file sessions left on tasks
 * (and the images the person sent), grouped BY TASK, each group naming the session that produced it.
 *
 * It reuses the session gallery's own Tile / RowItem / GroupHeading and the shared lightbox — a second
 * set of tiles would be a second idea of what "a picture in a gallery" looks like. What it adds is
 * only the two filters: ORIGIN (mine / sessions — drawn only when both sides have files, the session
 * gallery's own rule) and TASK (a ChipSelect, so it is the board's own select and not a new one).
 */
import { useMemo, useState } from 'react'
import { Grid2x2, Images, List } from 'lucide-react'
import { useIsMobile } from '../../hooks/useIsMobile'
import { galleryImageKey, galleryImages, type GalleryView } from '../../lib/gallery'
import {
  effectiveEvidenceScope, evidenceGroups, evidenceSides, filterEvidence, useEvidence, type EvidenceScope,
} from '../../lib/evidence'
import { GroupHeading, RowItem, Tile } from '../sessions/GalleryTab'
import { AttachmentLightbox } from '../sessions/AttachmentLightbox'
import { ChipSelect, type ChipOption } from './ChipSelect'
import { surface } from './board'
import type { Lang } from './copy'

const NEUTRAL = { color: 'var(--text-secondary)', dim: 'var(--border)' }

export function EvidenceGallery({ lang }: { lang: Lang }) {
  const pt = lang === 'pt'
  const isMobile = useIsMobile()
  const { items, error } = useEvidence()
  const [scope, setScope] = useState<EvidenceScope>('all')
  const [taskId, setTaskId] = useState<string>('')
  const [view, setView] = useState<GalleryView>('grid')
  const [lightbox, setLightbox] = useState<number | null>(null)
  const [broken, setBroken] = useState<Record<string, true>>({})

  const all = items ?? []
  const sides = useMemo(() => evidenceSides(all), [all])
  const shown = effectiveEvidenceScope(scope, sides)
  const taskOptions = useMemo<ChipOption[]>(() => {
    const seen = new Map<string, string>()
    for (const e of all) if (e.taskId && !seen.has(e.taskId)) seen.set(e.taskId, e.taskTitle ?? e.taskId)
    return [
      { value: '', label: pt ? 'Todas as tarefas' : 'All tasks', ...NEUTRAL },
      ...[...seen].map(([value, label]) => ({ value, label, ...NEUTRAL })),
    ]
  }, [all, pt])
  const visible = useMemo(() => filterEvidence(all, shown, taskId || null), [all, shown, taskId])
  const groups = useMemo(() => evidenceGroups(visible, pt), [visible, pt])
  const images = useMemo(() => galleryImages(groups), [groups])

  const seg = (on: boolean): React.CSSProperties => ({
    display: 'flex', alignItems: 'center', gap: 4, minHeight: isMobile ? 44 : 26, padding: '0 10px', borderRadius: 6,
    border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 11.5,
    background: on ? 'var(--bg-elevated)' : 'transparent',
    color: on ? 'var(--anthropic-orange)' : 'var(--text-tertiary)', fontWeight: on ? 650 : 400,
  })

  if (items === null) return <div style={{ ...surface, padding: 16, color: 'var(--text-tertiary)', fontSize: 12.5 }}>…</div>
  if (error) {
    return <div style={{ ...surface, padding: 16, color: 'var(--text-tertiary)', fontSize: 12.5 }}>
      {pt ? 'Não foi possível carregar as evidências agora.' : 'Evidence could not be loaded right now.'}
    </div>
  }
  if (all.length === 0) {
    return (
      <div style={{ ...surface, padding: 16, display: 'flex', gap: 10, alignItems: 'center', color: 'var(--text-tertiary)', fontSize: 12.5 }}>
        <Images size={16} />
        {pt
          ? 'Nenhuma evidência ainda. Capturas que uma sessão anexa à tarefa com agentistics_task_attach aparecem aqui, com a sessão que as produziu.'
          : 'No evidence yet. Screenshots a session attaches to a task with agentistics_task_attach appear here, with the session that produced them.'}
      </div>
    )
  }

  return (
    <div style={{ ...surface, padding: isMobile ? 10 : 14, display: 'grid', gap: 12, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {sides.mine > 0 && sides.sessions > 0 && (
          <div role="tablist" style={{ display: 'flex', gap: 2, padding: 2, borderRadius: 8, background: 'var(--bg-base)', border: '1px solid var(--border-subtle)' }}>
            {([
              ['all', pt ? 'Tudo' : 'All', sides.mine + sides.sessions],
              ['mine', pt ? 'Meus' : 'Mine', sides.mine],
              ['sessions', pt ? 'Sessões' : 'Sessions', sides.sessions],
            ] as const).map(([id, label, n]) => (
              <button key={id} role="tab" aria-selected={shown === id} style={seg(shown === id)} onClick={() => setScope(id)}>
                {label}<span style={{ opacity: 0.7 }}>{n}</span>
              </button>
            ))}
          </div>
        )}
        <div style={{ minWidth: 0, flex: isMobile ? '1 1 100%' : '0 1 280px' }}>
          <ChipSelect value={taskId} options={taskOptions} onPick={setTaskId} title={pt ? 'Filtrar por tarefa' : 'Filter by task'} />
        </div>
        <span style={{ flex: 1 }} />
        <button style={seg(view === 'list')} onClick={() => setView('list')} aria-label={pt ? 'Lista' : 'List'}><List size={13} />{!isMobile && (pt ? 'Lista' : 'List')}</button>
        <button style={seg(view === 'grid')} onClick={() => setView('grid')} aria-label={pt ? 'Grade' : 'Grid'}><Grid2x2 size={13} />{!isMobile && (pt ? 'Grade' : 'Grid')}</button>
      </div>

      {groups.length === 0 && (
        <p style={{ margin: 0, fontSize: 12.5, color: 'var(--text-tertiary)' }}>
          {pt ? 'Nenhuma evidência com esses filtros.' : 'No evidence matches these filters.'}
        </p>
      )}
      {groups.map(group => (
        <section key={group.index} style={{ minWidth: 0 }}>
          <GroupHeading group={group} pt={pt} now={Date.now()} />
          {view === 'grid' ? (
            <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fill, minmax(118px, 1fr))' }}>
              {group.files.map((file, i) => (
                <Tile
                  key={`${file.path}-${i}`} file={file} sessionId="" pt={pt} isMobile={isMobile} size={undefined}
                  broken={broken[file.path] === true}
                  onBroken={() => setBroken(p => ({ ...p, [file.path]: true }))}
                  onOpen={() => { const at = images.findIndex(im => im.key === galleryImageKey(group.index, i)); if (at >= 0) setLightbox(at) }}
                  onMenu={() => {}}
                />
              ))}
            </div>
          ) : group.files.map((file, i) => (
            <RowItem
              key={`${file.path}-${i}`} file={file} size={undefined} pt={pt} isMobile={isMobile}
              onOpen={() => { const at = images.findIndex(im => im.key === galleryImageKey(group.index, i)); if (at >= 0) setLightbox(at) }}
              onMenu={() => {}}
            />
          ))}
        </section>
      ))}

      {lightbox !== null && images[lightbox] !== undefined && (
        <AttachmentLightbox
          paths={images.map(im => im.path)} index={lightbox} onIndexChange={setLightbox}
          onClose={() => setLightbox(null)} lang={lang}
        />
      )}
    </div>
  )
}
