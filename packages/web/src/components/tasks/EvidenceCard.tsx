/**
 * EvidenceCard — the screenshots sessions left on THIS task, on its Overview after the rollup card.
 *
 * Built from the chat's own `AttachmentThumb` and the shared lightbox; each thumb is captioned with the
 * session that produced it. Absent entirely when the task has none: an empty card on every task would
 * teach people to skip the place a verification shot appears.
 */
import { useMemo, useState } from 'react'
import { useEvidence, sessionHandle } from '../../lib/evidence'
import { attachmentKind } from '../../lib/messageAttachments'
import { AttachmentThumb } from '../sessions/ChatBubble'
import { AttachmentLightbox } from '../sessions/AttachmentLightbox'
import { microLabel, surface } from './board'
import type { Lang } from './copy'

export function EvidenceCard({ taskId, lang }: { taskId: string; lang: Lang }) {
  const pt = lang === 'pt'
  const { items } = useEvidence(taskId)
  const [open, setOpen] = useState<number | null>(null)
  const shots = useMemo(() => (items ?? []).filter(e => attachmentKind(e.name) !== 'other'), [items])
  if (shots.length === 0) return null
  return (
    <div style={{ ...surface, padding: 14 }}>
      <div style={{ ...microLabel, marginBottom: 9 }}>{pt ? 'Evidências' : 'Evidence'} · {shots.length}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
        {shots.map((e, i) => (
          <div key={`${e.path}-${i}`} style={{ width: 72, minWidth: 0 }}>
            <AttachmentThumb path={e.path} onOpen={() => setOpen(i)} />
            <div title={e.sessionId ?? ''} style={{
              marginTop: 3, fontSize: 9.5, color: 'var(--text-tertiary)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {e.origin === 'mine' ? (pt ? 'você' : 'you') : sessionHandle(e.sessionId)}
            </div>
          </div>
        ))}
      </div>
      {open !== null && (
        <AttachmentLightbox paths={shots.map(e => e.path)} index={open} onIndexChange={setOpen} onClose={() => setOpen(null)} lang={lang} />
      )}
    </div>
  )
}
