/**
 * appAreas.ts — the ONE description of the app's navigation.
 *
 * The desktop tree, the Sessions icon rail, the mobile sheet, the page header crumb and the page
 * search all render from this list. A second list anywhere is a second answer to "where is this
 * page", which is how the old SideNav `items` and the mobile `navTiles` drifted apart.
 *
 * Matching is by SEGMENT boundary (same rule the old `modeOfPath` had): `/sessions-report` is not the
 * Sessions area.
 */
import { SETTINGS_SECTIONS } from './settingsSections'

export type AreaId = 'sessions' | 'tasks' | 'usage' | 'metrics' | 'repositories' | 'vault' | 'settings'

/** lucide-react icon names; the components map them, so this module stays React-free. */
export type AreaIcon = 'terminal' | 'clipboard' | 'gauge' | 'chart' | 'git' | 'lock' | 'settings'

export interface AreaPage {
  id: string
  /** The page's own route — what the tree links to. */
  path: string
  /** Extra route prefixes this page owns (`/repo` for the repository list). */
  also?: readonly string[]
  labelPt: string
  labelEn: string
  beta?: boolean
  /** Settings sections only: the heading the tree groups them under. */
  group?: 'personal' | 'governance'
}

export interface Area {
  id: AreaId
  icon: AreaIcon
  labelPt: string
  labelEn: string
  /** Empty for an area that is ONE page (Cofre). */
  pages: readonly AreaPage[]
  /** The area's own root when it has no pages. */
  root?: string
  beta?: boolean
}

export const APP_AREAS: readonly Area[] = [
  { id: 'metrics', icon: 'chart', labelPt: 'Métricas', labelEn: 'Metrics', pages: [
    { id: 'overview', path: '/', labelPt: 'Visão geral', labelEn: 'Overview' },
    { id: 'costs', path: '/costs', labelPt: 'Custos', labelEn: 'Costs' },
    { id: 'top', path: '/top', labelPt: 'Top de uso', labelEn: 'Top usage' },
    { id: 'compare', path: '/compare', labelPt: 'Comparar', labelEn: 'Compare' },
    { id: 'tools', path: '/tools', labelPt: 'Ferramentas', labelEn: 'Tools' },
    { id: 'custom', path: '/custom', labelPt: 'Personalizado', labelEn: 'Custom' },
    { id: 'tags', path: '/tags', labelPt: 'Tags', labelEn: 'Tags' },
  ] },
  { id: 'sessions', icon: 'terminal', labelPt: 'Sessões', labelEn: 'Sessions', pages: [
    { id: 'workspace', path: '/sessions', labelPt: 'Lista', labelEn: 'List' },
    { id: 'leaders', path: '/leadership', labelPt: 'Líderes', labelEn: 'Leaders' },
    { id: 'checkins', path: '/leadership/checkins', labelPt: 'Check-ins', labelEn: 'Check-ins' },
    { id: 'handoffs', path: '/leadership/handoffs', labelPt: 'Passagens', labelEn: 'Hand-offs' },
    { id: 'away', path: '/leadership/away', labelPt: 'Modo ausente', labelEn: 'Away mode' },
  ] },
  { id: 'tasks', icon: 'clipboard', labelPt: 'Agentask', labelEn: 'Agentask', beta: true, pages: [
    { id: 'board', path: '/tasks', labelPt: 'Quadro', labelEn: 'Board' },
    { id: 'activity', path: '/tasks/activity', labelPt: 'Atividade', labelEn: 'Activity' },
  ] },
  { id: 'usage', icon: 'gauge', beta: true, labelPt: 'Uso', labelEn: 'Usage', pages: [
    { id: 'now', path: '/usage', labelPt: 'Agora', labelEn: 'Now' },
  ] },
  { id: 'repositories', icon: 'git', labelPt: 'Repositórios', labelEn: 'Repositories', pages: [
    { id: 'list', path: '/repositories', also: ['/repo'], labelPt: 'Lista', labelEn: 'List' },
    { id: 'actions', path: '/repositories/actions', labelPt: 'Execuções de CI', labelEn: 'Actions' },
    { id: 'workflows', path: '/workflows', labelPt: 'Workflows', labelEn: 'Workflows' },
  ] },
  { id: 'vault', icon: 'lock', labelPt: 'Cofre', labelEn: 'Vault', pages: [], root: '/vault' },
  // Amendment A1: the settings sections ARE the tree's Ajustes subpages. Listed here unfiltered so
  // routing/search know every path; the tree hides the ones `visibleSettingsSections(viewer)` hides.
  { id: 'settings', icon: 'settings', labelPt: 'Ajustes', labelEn: 'Settings', root: '/settings',
    pages: SETTINGS_SECTIONS.map(x => ({ id: x.id, path: '/settings/' + x.id, labelPt: x.labelPt, labelEn: x.labelEn, group: x.group })) },
]

/** Routes that are deliberately in no area: redirects, the footer's settings, export. */
export const UNLISTED_ROUTES: readonly string[] = ['projects', 'hardware', 'export', 'x/:surfaceId']

function under(pathname: string, prefix: string): boolean {
  if (prefix === '/') return pathname === '/'
  return pathname === prefix || pathname.startsWith(prefix + '/')
}

/** The terminal/chat canvas has its own layout; other pages in Sessions remain scrollable documents. */
export function isSessionsWorkspace(pathname: string): boolean {
  return under(pathname, '/sessions')
}

/**
 * Which area and page a URL belongs to. The MOST SPECIFIC prefix wins, so `/tasks/activity` is the
 * activity page while `/tasks/t-123` is the board.
 */
export function areaOfPath(pathname: string): { area: Area; page: AreaPage | null } | null {
  let best: { area: Area; page: AreaPage | null; len: number } | null = null
  for (const area of APP_AREAS) {
    if (area.root && under(pathname, area.root)) {
      if (!best || area.root.length > best.len) best = { area, page: null, len: area.root.length }
    }
    for (const page of area.pages) {
      for (const prefix of [page.path, ...(page.also ?? [])]) {
        if (under(pathname, prefix) && (!best || prefix.length > best.len)) best = { area, page, len: prefix.length }
      }
    }
  }
  return best ? { area: best.area, page: best.page } : null
}

export function pageLabel(x: { labelPt: string; labelEn: string }, lang: 'pt' | 'en'): string {
  return lang === 'pt' ? x.labelPt : x.labelEn
}

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()

/** Pages whose label (either language) or area label contains the query. */
export function searchAreas(query: string, _lang: 'pt' | 'en'): { area: Area; page: AreaPage }[] {
  const q = fold(query)
  if (!q) return []
  const out: { area: Area; page: AreaPage }[] = []
  for (const area of APP_AREAS) {
    const pages: AreaPage[] = area.pages.length
      ? [...area.pages]
      : [{ id: area.id, path: area.root!, labelPt: area.labelPt, labelEn: area.labelEn }]
    for (const page of pages) {
      const hay = [page.labelPt, page.labelEn, area.labelPt, area.labelEn].map(fold)
      if (hay.some(h => h.includes(q))) out.push({ area, page })
    }
  }
  return out
}

/**
 * Areas whose HEADER always lands on one fixed page instead of the last page visited in them.
 * Sessões used to resume the last open conversation, which dropped people into a screen rather than a
 * listing; its header now opens the sessions list. It must NEVER land on another area's page (it briefly
 * pointed at /usage, which read as "Sessions throws me to Usage").
 */
export const AREA_HEADER_PATH: Partial<Record<AreaId, string>> = { sessions: '/sessions' }

/** Where clicking an area's header goes: its fixed landing page when it has one, else `firstPath`. */
export function areaHeaderPath(area: Area, remembered?: string | null): string {
  return AREA_HEADER_PATH[area.id] ?? firstPath(area, remembered)
}

/** Where clicking an area goes: the remembered page of THAT area, else its first page. */
export function firstPath(area: Area, remembered?: string | null): string {
  const r = (remembered ?? '').trim()
  if (r && areaOfPath(r)?.area.id === area.id) return r
  return area.pages[0]?.path ?? area.root ?? '/'
}
