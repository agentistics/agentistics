/**
 * PROTOTYPE page (t-eab4751cb3): the REAL new-session wizard on its "Onde" step, with every /api
 * call answered in memory. `?v=A|B|C&theme=dark|light&lang=pt|en`. Never shipped.
 */
import React from 'react'
import ReactDOM from 'react-dom/client'
import '../index.css'
import { NewSessionModal } from '../components/sessions/NewSessionModal'
import { saveWizardSnapshot } from '../lib/newSessionWizardStore'
import { newProjectProto } from '../lib/newProjectProto'

const qs = new URLSearchParams(location.search)
const variant = (qs.get('v') ?? 'C').toUpperCase() as 'A' | 'B' | 'C'
const lang = (qs.get('lang') ?? 'pt') as 'pt' | 'en'
document.documentElement.setAttribute('data-theme', qs.get('theme') === 'light' ? 'light' : 'dark')
const HOME = '/home/ana'
newProjectProto.variant = variant
newProjectProto.home = HOME

// An in-memory disk: every folder that exists.
const dirs = new Set<string>([
  HOME, `${HOME}/dev`, `${HOME}/dev/loja-online`, `${HOME}/dev/site-pessoal`, `${HOME}/dev/api-pagamentos`,
  `${HOME}/dev/api-pagamentos/src`, `${HOME}/Documentos`, `${HOME}/Documentos/planilhas`, `${HOME}/Downloads`,
])
const projects = [
  { path: `${HOME}/dev/loja-online`, label: 'loja-online', repo: 'github.com/ana/loja-online', detail: 'há 2 horas', source: 'session' },
  { path: `${HOME}/dev/api-pagamentos`, label: 'api-pagamentos', repo: 'github.com/ana/api-pagamentos', detail: 'ontem', source: 'session' },
  { path: `${HOME}/dev/site-pessoal`, label: 'site-pessoal', detail: 'há 5 dias', source: 'session' },
  { path: `${HOME}/Documentos/planilhas`, label: 'planilhas', detail: 'pasta', source: 'disk' },
]
const harness = (id: string, label: string) => ({ id, label, modelSuggestions: [], supportsModel: true, efforts: [], installed: true, modes: ['default'] })

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}
const realFetch = window.fetch.bind(window)
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.origin)
  if (!url.pathname.startsWith('/api/')) return realFetch(input, init)
  const method = (init?.method ?? 'GET').toUpperCase()
  if (url.pathname === '/api/fleet/new') {
    const q = (url.searchParams.get('q') ?? '').toLowerCase()
    const rows = projects.filter(p => !q || p.label.includes(q) || p.path.toLowerCase().includes(q))
    return json({
      harnesses: [harness('claude', 'Claude Code'), harness('codex', 'Codex'), harness('gemini', 'Gemini CLI')],
      projects: rows, projectTotals: { repo: rows.filter(r => r.repo).length, worktree: 0, project: rows.filter(r => !r.repo && r.source === 'session').length, folder: rows.filter(r => r.source === 'disk').length },
      projectDisks: [],
    })
  }
  if (url.pathname === '/api/fs/folders' && method === 'GET') {
    const path = url.searchParams.get('path') ?? ''
    if (path === '') return json({ path: '', parent: null, folders: [{ name: 'ana', path: HOME, hasChildren: true }], partial: false })
    if (!dirs.has(path)) return json({ error: 'not-found' }, 404)
    const kids = [...dirs].filter(d => d.startsWith(`${path}/`) && !d.slice(path.length + 1).includes('/')).sort()
    return json({ path, parent: path === HOME ? null : path.replace(/\/[^/]+$/, ''), partial: false,
      folders: kids.map(k => ({ name: k.split('/').pop(), path: k, hasChildren: [...dirs].some(d => d.startsWith(`${k}/`)) })) })
  }
  if (url.pathname === '/api/fs/folders' && method === 'POST') {
    const body = JSON.parse(String(init?.body ?? '{}')) as { parent: string; name: string; createParent?: boolean }
    await new Promise(r => setTimeout(r, 400))
    const target = `${body.parent.replace(/\/+$/, '')}/${body.name}`
    if (!body.parent.startsWith(HOME)) return json({ error: 'forbidden' }, 403)
    if (!dirs.has(body.parent) && !body.createParent) return json({ error: 'parent-missing' }, 409)
    if (dirs.has(target)) return json({ error: 'exists', path: target }, 409)
    dirs.add(body.parent); dirs.add(target)
    projects.unshift({ path: target, label: body.name, detail: 'agora', source: 'session' })
    return json({ path: target }, 201)
  }
  return json({})
}) as typeof fetch

saveWizardSnapshot({
  harnessId: 'claude', nativeProvider: '', cwd: '', task: '', subtaskTarget: null, model: '', effort: '',
  prompt: '', label: '', attachments: [], step: 'where', dirty: false,
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <div style={{ minHeight: '100vh', background: 'var(--bg-base, var(--bg-primary))' }}>
      <div style={{ position: 'fixed', top: 6, left: 8, zIndex: 9999, fontSize: 11, fontWeight: 700, color: 'var(--anthropic-orange)' }}>
        PROTÓTIPO · opção {variant}
      </div>
      <NewSessionModal lang={lang} onClose={() => {}} onStarted={() => {}} />
    </div>
  </React.StrictMode>,
)
