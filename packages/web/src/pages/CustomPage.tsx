import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useOutletContext } from 'react-router-dom'
import { GridLayout, useContainerWidth, type Layout, type LayoutItem } from 'react-grid-layout'
import 'react-grid-layout/css/styles.css'
import 'react-resizable/css/styles.css'
import {
  Layers, X, RotateCcw, Search, ChevronDown, ChevronRight,
  PanelLeftClose, PanelLeftOpen, Plus, Trash2, Pencil, Check,
  Lock, Unlock, FolderOpen, Download, Upload,
  MoreHorizontal, Undo2, Redo2, Dice5, Save, Copy, Settings2, SquarePen,
} from 'lucide-react'
import type { AppContext } from '../lib/app-context'
import { CATALOG, CATEGORY_LABELS, getCatalogItem, type CatalogItem, type CatalogCategory } from '../lib/componentCatalog'
import { useCustomLayout, type GridItem } from '../hooks/useCustomLayout'
import { formatProjectName } from '@agentistics/core'
import { FiltersBar } from '../components/FiltersBar'
import { useIsMobile } from '../hooks/useIsMobile'

const GRID_COLS = 12
const GRID_ROW_HEIGHT = 40
const ASIDE_WIDTH = 300
const ASIDE_GAP = 16

interface LayoutExport {
  version: 1
  layoutName: string
  items: Array<{
    componentId: string
    x: number; y: number; w: number; h: number
    minW?: number; minH?: number
  }>
  pinnedProjects: Array<{ path: string; displayName: string }>
}

interface ImportState {
  layoutName: string
  items: LayoutExport['items']
  originalProjects: Array<{ path: string; displayName: string }>
  mappings: Record<string, string>  // original path → local path (empty = skip)
}

function ProjectSelect({ value, options, pt, onChange }: {
  value: string
  options: string[]
  pt: boolean
  onChange: (val: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [dropPos, setDropPos] = useState({ top: 0, left: 0, width: 0 })
  const triggerRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return options
    return options.filter(p =>
      formatProjectName(p).toLowerCase().includes(q) || p.toLowerCase().includes(q)
    )
  }, [options, search])

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return
    const r = triggerRef.current.getBoundingClientRect()
    setDropPos({ top: r.bottom + 4, left: r.left, width: r.width })
    setTimeout(() => searchRef.current?.focus(), 20)
  }, [open])

  useEffect(() => {
    if (!open) { setSearch(''); return }
    function onDown(e: MouseEvent) {
      const drop = document.getElementById('project-select-drop')
      if (
        triggerRef.current && !triggerRef.current.contains(e.target as Node) &&
        drop && !drop.contains(e.target as Node)
      ) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  function select(val: string) { onChange(val); setOpen(false) }

  return (
    <div ref={triggerRef}>
      <div
        onClick={() => setOpen(v => !v)}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px',
          cursor: 'pointer', userSelect: 'none',
          background: 'var(--bg-elevated)',
          border: `1px solid ${open ? 'var(--anthropic-orange)' : value ? 'var(--anthropic-orange)60' : 'var(--border-subtle)'}`,
          borderRadius: 8, fontSize: 13,
          color: value ? 'var(--text-primary)' : 'var(--text-tertiary)',
          transition: 'border-color 0.12s',
          minHeight: 40,
        }}
      >
        {value
          ? (
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {formatProjectName(value)}
              </span>
              <span style={{ display: 'block', fontSize: 10, color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 1 }}>
                {value}
              </span>
            </span>
          )
          : <span style={{ flex: 1 }}>{pt ? '— Ignorar este projeto —' : '— Skip this project —'}</span>
        }
        <ChevronDown size={13} style={{ flexShrink: 0, color: 'var(--text-tertiary)', transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }} />
      </div>

      {open && createPortal(
        <div
          id="project-select-drop"
          style={{
            position: 'fixed', top: dropPos.top, left: dropPos.left, width: dropPos.width,
            zIndex: 9999, background: 'var(--bg-card)',
            border: '1px solid var(--anthropic-orange)80',
            borderRadius: 10, boxShadow: '0 12px 32px rgba(0,0,0,0.4)',
            overflow: 'hidden',
          }}
        >
          {/* Search input */}
          <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--border-subtle)', position: 'relative' }}>
            <Search size={13} style={{ position: 'absolute', left: 20, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-tertiary)', pointerEvents: 'none' }} />
            <input
              ref={searchRef}
              type="text"
              placeholder={pt ? 'Buscar projeto…' : 'Search project…'}
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={{
                width: '100%', boxSizing: 'border-box', padding: '8px 10px 8px 32px',
                background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)',
                borderRadius: 7, fontSize: 13, color: 'var(--text-primary)',
                fontFamily: 'inherit', outline: 'none',
              }}
              onFocus={e => e.currentTarget.style.borderColor = 'var(--anthropic-orange)60'}
              onBlur={e => e.currentTarget.style.borderColor = 'var(--border-subtle)'}
            />
          </div>

          {/* Results */}
          <div style={{ maxHeight: 260, overflow: 'auto' }}>
            {/* Skip option */}
            <div
              onClick={() => select('')}
              style={{
                padding: '10px 14px', fontSize: 13, cursor: 'pointer',
                color: !value ? 'var(--anthropic-orange)' : 'var(--text-tertiary)',
                background: !value ? 'var(--anthropic-orange-dim)' : 'transparent',
                fontWeight: !value ? 600 : 400,
                borderBottom: '1px solid var(--border-subtle)',
              }}
              onMouseEnter={e => { if (value) (e.currentTarget as HTMLElement).style.background = 'var(--bg-elevated)' }}
              onMouseLeave={e => { if (value) (e.currentTarget as HTMLElement).style.background = 'transparent' }}
            >
              {pt ? '— Ignorar este projeto —' : '— Skip this project —'}
            </div>

            {filtered.length === 0
              ? <div style={{ padding: '12px 14px', fontSize: 13, color: 'var(--text-tertiary)' }}>{pt ? 'Nenhum resultado' : 'No results'}</div>
              : filtered.map(p => (
                <div
                  key={p}
                  onClick={() => select(p)}
                  style={{
                    padding: '10px 14px', cursor: 'pointer',
                    background: p === value ? 'var(--anthropic-orange-dim)' : 'transparent',
                    borderLeft: p === value ? '3px solid var(--anthropic-orange)' : '3px solid transparent',
                  }}
                  onMouseEnter={e => { if (p !== value) (e.currentTarget as HTMLElement).style.background = 'var(--bg-elevated)' }}
                  onMouseLeave={e => { if (p !== value) (e.currentTarget as HTMLElement).style.background = p === value ? 'var(--anthropic-orange-dim)' : 'transparent' }}
                >
                  <div style={{ fontSize: 13, fontWeight: p === value ? 600 : 500, color: p === value ? 'var(--anthropic-orange)' : 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {formatProjectName(p)}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {p}
                  </div>
                </div>
              ))
            }
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}

export default function CustomPage() {
  const ctx = useOutletContext<AppContext>()
  const { lang, setFilters, data, filters } = ctx
  const {
    items, setItems, addItem, removeItem, reset, loaded,
    layoutNames, activeLayout,
    pinnedProjects, pinnedProjectsMap, setPinnedProjects,
    switchLayout, createLayout, renameLayout, deleteLayout, deleteLayouts, duplicateLayout,
  } = useCustomLayout()

  // All known project paths from data
  const allProjects: string[] = useMemo(
    () => data.projects.map(p => p.path).sort(),
    [data.projects]
  )

  // Layout options menu (rename / duplicate / delete)
  const [layoutMenuOpen, setLayoutMenuOpen] = useState(false)
  const layoutMenuBtnRef = useRef<HTMLButtonElement>(null)
  const [layoutMenuPos, setLayoutMenuPos] = useState({ top: 0, left: 0 })

  const [draggedCatalogItem, setDraggedCatalogItem] = useState<CatalogItem | null>(null)
  const draggedCatalogItemRef = useRef<CatalogItem | null>(null)
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Record<CatalogCategory, boolean>>({
    kpi: false, activity: false, costs: false, projects: false, tools: false, sessions: false,
  })
  const nextIdRef = useRef(Date.now())

  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [locked, setLocked] = useState(true)

  // Undo / redo stacks — each entry is a frozen snapshot of items[]
  const [undoStack, setUndoStack] = useState<GridItem[][]>([])
  const [redoStack, setRedoStack] = useState<GridItem[][]>([])
  // Snapshot captured when user unlocks — used by Cancel to revert
  const [editBaseline, setEditBaseline] = useState<GridItem[] | null>(null)
  // Snapshot captured on drag/resize start — pushed to undo on stop
  const preDragRef = useRef<GridItem[] | null>(null)
  // Per-card 3-dot menu state
  const [openMenuId, setOpenMenuId] = useState<string | null>(null)

  function pushUndo(snapshot: GridItem[]) {
    setUndoStack(prev => [...prev.slice(-40), snapshot])
    setRedoStack([])
  }

  function handleUndo() {
    if (undoStack.length === 0 || locked) return
    setRedoStack(prev => [...prev, items])
    const prev = undoStack[undoStack.length - 1]!
    setUndoStack(s => s.slice(0, -1))
    setItems(prev)
  }

  function handleRedo() {
    if (redoStack.length === 0 || locked) return
    setUndoStack(prev => [...prev, items])
    const next = redoStack[redoStack.length - 1]!
    setRedoStack(s => s.slice(0, -1))
    setItems(next)
  }

  function handleUnlock() {
    setEditBaseline(items.map(it => ({ ...it })))
    setLocked(false)
  }

  function handleSave() {
    setEditBaseline(null)
    setLocked(true)
  }

  function handleCancelEdit() {
    if (editBaseline !== null) {
      setItems(editBaseline)
      setUndoStack([])
      setRedoStack([])
    }
    setEditBaseline(null)
    setLocked(true)
  }

  function removeItemWithHistory(i: string) {
    pushUndo(items)
    removeItem(i)
  }

  function handleReset() {
    if (!confirm(pt ? 'Remover todos os componentes do canvas?' : 'Remove all components from the canvas?')) return
    pushUndo(items)
    reset()
  }

  function resizeItem(itemI: string, w: number, h: number) {
    const newItems = items.map(it =>
      it.i === itemI ? { ...it, w: Math.min(w, GRID_COLS - it.x), h: Math.max(h, it.minH ?? 1) } : it
    )
    pushUndo(items)
    setItems(newItems)
  }

  function generateRandomLayout() {
    const shuffled = [...CATALOG].sort(() => Math.random() - 0.5)
    const picked = shuffled.slice(0, Math.floor(Math.random() * 5) + 5)
    let curX = 0, curY = 0, rowH = 0
    const newItems: GridItem[] = []
    const nextId = nextIdRef.current
    picked.forEach((item, idx) => {
      if (curX + item.defaultW > GRID_COLS) { curX = 0; curY += rowH; rowH = 0 }
      newItems.push({
        i: `${item.id}__${nextId + idx}`,
        componentId: item.id,
        x: curX, y: curY, w: item.defaultW, h: item.defaultH,
        minW: item.minW, minH: item.minH,
      })
      curX += item.defaultW
      rowH = Math.max(rowH, item.defaultH)
    })
    nextIdRef.current = nextId + picked.length
    pushUndo(items)
    setItems(newItems)
  }

  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const renameInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { setRenameValue(activeLayout) }, [activeLayout])

  // Apply pinned projects whenever the active layout changes (after first load)
  const firstLoad = useRef(true)
  useEffect(() => {
    if (!loaded) return
    if (firstLoad.current) { firstLoad.current = false; return }
    setFilters(prev => ({ ...prev, projects: pinnedProjects }))
  }, [activeLayout]) // eslint-disable-line react-hooks/exhaustive-deps

  // Close layout options menu on outside click
  useEffect(() => {
    if (!layoutMenuOpen) return
    function onDown() { setLayoutMenuOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [layoutMenuOpen])

  // containerRef is on the outer flex row so totalWidth is stable.
  // gridWidth is computed synchronously — no ResizeObserver lag when aside toggles.
  const { width: totalWidth, containerRef: outerRowRef, mounted } = useContainerWidth()
  const MIN_GRID_WIDTH = 280  // below this, RGL column widths go negative
  const asideVisible = sidebarOpen && !locked
  const rawGridWidth = totalWidth > 0
    ? totalWidth - (asideVisible ? ASIDE_WIDTH + ASIDE_GAP : 0)
    : 0
  const gridWidth = rawGridWidth > 0 ? Math.max(rawGridWidth, MIN_GRID_WIDTH) : 0

  // Auto-close sidebar when viewport is too narrow to show both
  useEffect(() => {
    if (totalWidth > 0 && totalWidth < ASIDE_WIDTH + MIN_GRID_WIDTH + ASIDE_GAP + 20) {
      setSidebarOpen(false)
    }
  }, [totalWidth])

  const [importState, setImportState] = useState<ImportState | null>(null)
  const importFileRef = useRef<HTMLInputElement>(null)

  // Duplicate layout modal
  interface DupState { newName: string; pinned: string[] }
  const [dupModal, setDupModal] = useState<DupState | null>(null)
  const [confirmDeleteName, setConfirmDeleteName] = useState<string | null>(null)

  // Manage layouts modal (bulk delete)
  const [manageOpen, setManageOpen] = useState(false)
  const [manageSelected, setManageSelected] = useState<Set<string>>(new Set())

  const pt = lang === 'pt'
  const isMobile = useIsMobile()

  // Keyboard shortcuts for undo/redo
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (locked) return
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.ctrlKey && e.key === 'z' && !e.shiftKey) { e.preventDefault(); handleUndo() }
      if (e.ctrlKey && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) { e.preventDefault(); handleRedo() }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [locked, undoStack, redoStack, items]) // eslint-disable-line react-hooks/exhaustive-deps

  // Close card menu on outside click
  useEffect(() => {
    if (!openMenuId) return
    function onDown() { setOpenMenuId(null) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [openMenuId])

  const groupedCatalog = useMemo(() => {
    const q = query.trim().toLowerCase()
    const groups: Record<CatalogCategory, CatalogItem[]> = {
      kpi: [], activity: [], costs: [], projects: [], tools: [], sessions: [],
    }
    for (const item of CATALOG) {
      const label = (pt ? item.labelPt : item.labelEn).toLowerCase()
      if (q && !label.includes(q)) continue
      groups[item.category].push(item)
    }
    return groups
  }, [pt, query])

  const layout: Layout = useMemo(
    () => items.map(it => ({
      i: it.i, x: it.x, y: it.y, w: it.w, h: it.h,
      minW: it.minW, minH: it.minH,
      maxW: GRID_COLS - it.x,  // prevent resize past right edge
    })),
    [items]
  )

  function onLayoutChange(next: Layout) {
    const merged: GridItem[] = next.map(l => {
      const existing = items.find(it => it.i === l.i)
      const maxW = GRID_COLS - l.x
      return {
        i: l.i,
        x: l.x, y: l.y,
        w: Math.min(l.w, maxW),  // clamp to available columns
        h: l.h,
        minW: l.minW, minH: l.minH,
        componentId: existing?.componentId ?? '',
      }
    }).filter(it => it.componentId !== '')
    if (merged.length < items.length) return
    const changed = merged.length !== items.length
      || merged.some(m => {
        const prev = items.find(x => x.i === m.i)
        return !prev || prev.x !== m.x || prev.y !== m.y || prev.w !== m.w || prev.h !== m.h
      })
    if (changed) setItems(merged)
  }

  function onDrop(_layout: Layout, item: LayoutItem | undefined, _e: Event) {
    const catalog = draggedCatalogItemRef.current
    draggedCatalogItemRef.current = null
    setDraggedCatalogItem(null)
    if (!catalog || !item) return
    pushUndo(items)
    const instanceId = `${catalog.id}__${nextIdRef.current++}`
    addItem({
      i: instanceId,
      x: item.x,
      y: item.y,
      w: catalog.defaultW,
      h: catalog.defaultH,
      minW: catalog.minW,
      minH: catalog.minH,
      componentId: catalog.id,
    })
  }

  function handlePaletteDragStart(e: React.DragEvent, catalog: CatalogItem) {
    draggedCatalogItemRef.current = catalog
    setDraggedCatalogItem(catalog)
    e.dataTransfer.setData('text/plain', catalog.id)
    e.dataTransfer.effectAllowed = 'copy'
  }

  function handlePaletteDragEnd() {
    // Only clear visual state; ref is cleared by onDrop on a successful drop.
    // If the user dropped outside the canvas, ref stays until next dragstart — harmless.
    setDraggedCatalogItem(null)
  }

  function onGridDragStart() {
    preDragRef.current = items.map(it => ({ ...it }))
  }

  function onGridDragStop() {
    if (preDragRef.current) {
      setUndoStack(prev => [...prev.slice(-40), preDragRef.current!])
      setRedoStack([])
      preDragRef.current = null
    }
  }

  function onGridResizeStop() {
    if (preDragRef.current) {
      setUndoStack(prev => [...prev.slice(-40), preDragRef.current!])
      setRedoStack([])
      preDragRef.current = null
    } else {
      pushUndo(items)
    }
  }

  function onGridResizeStart() {
    preDragRef.current = items.map(it => ({ ...it }))
  }

  function handleNewLayout() {
    const base = 'Layout'
    let n = layoutNames.length + 1
    let name = `${base} ${n}`
    while (layoutNames.includes(name)) name = `${base} ${++n}`
    createLayout(name)
  }

  function handleStartRename() {
    setRenameValue(activeLayout)
    setRenaming(true)
    setTimeout(() => renameInputRef.current?.select(), 30)
  }

  function handleCommitRename() {
    renameLayout(activeLayout, renameValue)
    setRenaming(false)
  }

  function handleDeleteLayout() {
    setConfirmDeleteName(activeLayout)
  }

  function handleExport() {
    const exported: LayoutExport = {
      version: 1,
      layoutName: activeLayout,
      items: items.map(({ componentId, x, y, w, h, minW, minH }) => ({ componentId, x, y, w, h, minW, minH })),
      pinnedProjects: pinnedProjects.map(p => ({ path: p, displayName: formatProjectName(p) })),
    }
    const blob = new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${activeLayout.replace(/\s+/g, '-').toLowerCase()}-layout.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    const reader = new FileReader()
    reader.onload = ev => {
      try {
        const data = JSON.parse(ev.target?.result as string) as LayoutExport
        if (!data.version || !Array.isArray(data.items)) throw new Error('Invalid format')
        const initMappings: Record<string, string> = {}
        for (const proj of data.pinnedProjects ?? []) {
          // Auto-match if the exact path exists locally
          initMappings[proj.path] = allProjects.includes(proj.path) ? proj.path : ''
        }
        setImportState({
          layoutName: data.layoutName ?? 'Imported Layout',
          items: data.items,
          originalProjects: data.pinnedProjects ?? [],
          mappings: initMappings,
        })
      } catch {
        alert(pt ? 'Arquivo inválido — esperado JSON de layout.' : 'Invalid file — expected a layout JSON.')
      }
    }
    reader.readAsText(file)
  }

  function handleConfirmImport() {
    if (!importState) return
    const base = importState.layoutName.trim() || 'Imported Layout'
    let name = base
    let n = 2
    while (layoutNames.includes(name)) name = `${base} (${n++})`
    createLayout(name)
    const nextId = nextIdRef.current
    const newItems: GridItem[] = importState.items.map((it, idx) => ({
      i: `${it.componentId}__${nextId + idx}`,
      componentId: it.componentId,
      x: it.x, y: it.y, w: it.w, h: it.h,
      minW: it.minW, minH: it.minH,
    }))
    nextIdRef.current += importState.items.length
    // We need to setItems for the new layout after it's created.
    // switchLayout + setItems both go through the same update queue.
    setTimeout(() => {
      setItems(newItems)
      const mappedProjects = importState.originalProjects
        .map(p => importState.mappings[p.path])
        .filter(Boolean) as string[]
      if (mappedProjects.length > 0) {
        setPinnedProjects(mappedProjects)
        setFilters(prev => ({ ...prev, projects: mappedProjects }))
      }
    }, 50)
    setImportState(null)
  }

  if (!loaded) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 300, color: 'var(--text-tertiary)', fontSize: 13 }}>
        {pt ? 'Carregando layout personalizado…' : 'Loading custom layout…'}
      </div>
    )
  }

  if (layoutNames.length === 0) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 'calc(calc(100vh / var(--ag-zoom, 1)) - 200px)', flexDirection: 'column', gap: 20 }}>
        <div style={{ width: 64, height: 64, background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 16, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Layers size={28} color="var(--text-tertiary)" />
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 8 }}>
            {pt ? 'Nenhum layout' : 'No layouts'}
          </div>
          <div style={{ fontSize: 13, color: 'var(--text-tertiary)', marginBottom: 24 }}>
            {pt ? 'Crie um layout para começar.' : 'Create a layout to get started.'}
          </div>
          <button
            onClick={handleNewLayout}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 8,
              padding: '10px 24px', background: 'var(--anthropic-orange)',
              border: 'none', borderRadius: 8, cursor: 'pointer',
              fontFamily: 'inherit', fontSize: 14, fontWeight: 700, color: '#fff',
              boxShadow: '0 2px 8px rgba(217,119,6,0.3)',
            }}
          >
            <Plus size={16} />
            {pt ? 'Novo layout' : 'New layout'}
          </button>
        </div>
      </div>
    )
  }

  // Mobile view: render items as a vertical list, no drag/resize
  if (isMobile) {
    const sortedItems = [...items].sort((a, b) => a.y !== b.y ? a.y - b.y : a.x - b.x)
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {/* Mobile toolbar: layout name + edit-not-available notice */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          background: 'var(--bg-card)', border: '1px solid var(--border)',
          borderRadius: 10, padding: '8px 12px',
        }}>
          {layoutNames.length > 1 ? (
            <select
              value={activeLayout}
              onChange={e => switchLayout(e.target.value)}
              style={{
                background: 'var(--bg-elevated)', border: '1px solid var(--border)',
                borderRadius: 6, color: 'var(--text-primary)', fontFamily: 'inherit',
                fontSize: 12, fontWeight: 600, padding: '4px 8px', cursor: 'pointer',
                outline: 'none', flex: 1,
              }}
            >
              {layoutNames.map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          ) : (
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', flex: 1 }}>
              {activeLayout}
            </span>
          )}
          <span style={{
            fontSize: 10, color: 'var(--text-tertiary)', padding: '3px 7px',
            border: '1px solid var(--border)', borderRadius: 6,
            background: 'var(--bg-elevated)',
          }}>
            {pt ? 'Edição só no desktop' : 'Edit on desktop'}
          </span>
        </div>

        {/* Items stacked */}
        {sortedItems.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-tertiary)', fontSize: 13 }}>
            {pt ? 'Nenhum componente. Adicione no desktop.' : 'No components. Add them on desktop.'}
          </div>
        ) : (
          sortedItems.map(item => {
            const catalog = getCatalogItem(item.componentId)
            if (!catalog) return null
            return (
              <div key={item.i} style={{
                background: 'var(--bg-card)', border: '1px solid var(--border)',
                borderRadius: 'var(--radius-lg)', overflow: 'hidden',
              }}>
                {catalog.render(ctx)}
              </div>
            )
          })
        )}
      </div>
    )
  }

  const droppingItem: LayoutItem | undefined = draggedCatalogItem ? {
    i: '__dropping__', x: 0, y: 0,
    w: draggedCatalogItem.defaultW,
    h: draggedCatalogItem.defaultH,
  } : undefined

  const isDragging = draggedCatalogItem !== null

  return (
    <div>
      <style>{`
        .custom-grid .react-grid-item.react-grid-placeholder {
          background: var(--anthropic-orange) !important;
          opacity: 0.18;
          border-radius: var(--radius-lg);
          transition: all 120ms ease;
        }
        .custom-grid .react-grid-item > .react-resizable-handle {
          background-image: none;
          width: 18px; height: 18px;
          right: 2px; bottom: 2px;
          opacity: 0.3;
          transition: opacity 0.15s;
        }
        .custom-grid .react-grid-item > .react-resizable-handle::after {
          border-right: 2px solid var(--text-secondary);
          border-bottom: 2px solid var(--text-secondary);
          width: 8px; height: 8px;
          right: 4px; bottom: 4px;
          content: ''; position: absolute;
        }
        .custom-grid .react-grid-item:hover > .react-resizable-handle { opacity: 1; }
        .custom-grid.locked .react-grid-item > .react-resizable-handle { display: none; }
        .custom-grid .react-grid-item { transition: transform 180ms ease, box-shadow 120ms ease; }
        .custom-grid .react-grid-item.cssTransforms { transition-property: transform, width, height; }
        .custom-grid .react-grid-item.react-draggable-dragging {
          box-shadow: 0 12px 32px rgba(0,0,0,0.35); z-index: 10; cursor: grabbing !important;
        }
        .custom-grid .react-grid-item.resizing { opacity: 0.85; z-index: 10; }
        .palette-item { transition: transform 0.12s, background 0.12s, border-color 0.12s; user-select: none; }
        .palette-item:hover { transform: translateY(-1px); background: var(--bg-elevated); border-color: var(--anthropic-orange) !important; }
        .palette-item[data-dragging="true"] { opacity: 0.5; transform: scale(0.96); }
        .grid-item-remove { opacity: 0; transition: opacity 0.12s; }
        .grid-item-wrap:hover .grid-item-remove { opacity: 1; }
        .drag-handle-locked { cursor: default !important; }
        .layout-rename-input {
          background: var(--bg-elevated); border: 1px solid var(--anthropic-orange)60;
          border-radius: 6px; color: var(--text-primary); font-family: inherit;
          font-size: 12px; font-weight: 600; padding: 4px 8px; outline: none; width: 100%;
          box-sizing: border-box;
        }
        .icon-btn {
          display: flex; align-items: center; justify-content: center;
          width: 26px; height: 26px; border-radius: 6px; border: 1px solid var(--border);
          background: var(--bg-elevated); cursor: pointer; color: var(--text-secondary);
          transition: background 0.12s, color 0.12s, border-color 0.12s;
          flex-shrink: 0;
        }
        .icon-btn:hover { background: var(--bg-elevated); color: var(--text-primary); border-color: var(--border); }
        .icon-btn.danger:hover { color: #ef4444; border-color: #ef444440; }
        .icon-btn.accent { color: var(--anthropic-orange); border-color: var(--anthropic-orange)40; }
        .icon-btn.accent:hover { background: var(--anthropic-orange-dim); }
        .icon-btn.active { color: var(--anthropic-orange); background: var(--anthropic-orange-dim); border-color: var(--anthropic-orange)40; }
        .icon-btn:disabled { opacity: 0.35; cursor: not-allowed; }
        .custom-aside {
          overflow: hidden;
          flex-shrink: 0;
        }
        @keyframes liveFlash {
          0%   { box-shadow: 0 0 0 2px rgba(217,119,6,0.55), 0 0 14px rgba(217,119,6,0.12); }
          60%  { box-shadow: 0 0 0 2px rgba(217,119,6,0.18), 0 0 6px rgba(217,119,6,0.04); }
          100% { box-shadow: 0 0 0 0px rgba(217,119,6,0); }
        }
        .live-flash { animation: liveFlash 1.2s ease-out forwards; border-radius: var(--radius-lg); }
      `}</style>

      {/*  Toolbar  */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 4, marginBottom: 14,
        background: 'var(--bg-card)', border: '1px solid var(--border)',
        borderRadius: 10, padding: '5px 10px', flexWrap: 'wrap', minHeight: 42,
      }}>

        {/*  Layout selector  always visible */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {renaming ? (
            <>
              <input
                ref={renameInputRef}
                className="layout-rename-input"
                value={renameValue}
                onChange={e => setRenameValue(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleCommitRename(); if (e.key === 'Escape') setRenaming(false) }}
                onBlur={handleCommitRename}
                autoFocus
                style={{ width: 130 }}
              />
              <button className="icon-btn accent" onClick={handleCommitRename} title={pt ? 'Confirmar' : 'Confirm'} style={{ width: 26, height: 26 }}>
                <Check size={12} />
              </button>
            </>
          ) : layoutNames.length > 1 ? (
            <select
              value={activeLayout}
              onChange={e => switchLayout(e.target.value)}
              style={{
                background: 'var(--bg-elevated)', border: '1px solid var(--border)',
                borderRadius: 6, color: 'var(--text-primary)', fontFamily: 'inherit',
                fontSize: 12, fontWeight: 600, padding: '4px 8px', cursor: 'pointer',
                outline: 'none', height: 28,
              }}
            >
              {layoutNames.map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          ) : (
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', padding: '0 6px', userSelect: 'none' }}>
              {activeLayout}
            </span>
          )}
        </div>

        {/*  Layout management — edit mode only  */}
        {!locked && !renaming && (
          <>
            <div style={{ width: 1, height: 16, background: 'var(--border)', flexShrink: 0, margin: '0 2px' }} />
            {/* New layout */}
            <button className="icon-btn accent" onClick={handleNewLayout} title={pt ? 'Novo layout' : 'New layout'} style={{ width: 26, height: 26 }}>
              <Plus size={12} />
            </button>
            {/* Layout options: rename / duplicate / delete */}
            <div style={{ position: 'relative' }}>
              <button
                ref={layoutMenuBtnRef}
                className="icon-btn"
                onMouseDown={e => e.stopPropagation()}
                onClick={e => {
                  e.stopPropagation()
                  if (!layoutMenuOpen && layoutMenuBtnRef.current) {
                    const r = layoutMenuBtnRef.current.getBoundingClientRect()
                    setLayoutMenuPos({ top: r.bottom + 4, left: r.left })
                  }
                  setLayoutMenuOpen(v => !v)
                }}
                title={pt ? 'Opções do layout' : 'Layout options'}
                style={{ width: 26, height: 26 }}
              >
                <MoreHorizontal size={12} />
              </button>
              {layoutMenuOpen && createPortal(
                <div
                  onMouseDown={e => e.stopPropagation()}
                  style={{
                    position: 'fixed', top: layoutMenuPos.top, left: layoutMenuPos.left,
                    zIndex: 9999, minWidth: 180,
                    background: 'var(--bg-card)', border: '1px solid var(--border)',
                    borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
                    overflow: 'hidden', padding: '4px 0',
                  }}
                >
                  {/* Rename */}
                  <button
                    onClick={() => { setLayoutMenuOpen(false); handleStartRename() }}
                    style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 9, padding: '9px 14px', background: 'transparent', border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, color: 'var(--text-primary)', textAlign: 'left' }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-elevated)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  >
                    <SquarePen size={13} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
                    {pt ? 'Renomear' : 'Rename'}
                  </button>
                  {/* Duplicate */}
                  <button
                    onClick={() => { setLayoutMenuOpen(false); setDupModal({ newName: `${pt ? 'Cópia de' : 'Copy of'} ${activeLayout}`, pinned: [...pinnedProjects] }) }}
                    style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 9, padding: '9px 14px', background: 'transparent', border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, color: 'var(--text-primary)', textAlign: 'left' }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-elevated)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  >
                    <Copy size={13} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
                    {pt ? 'Duplicar' : 'Duplicate'}
                  </button>
                  <div style={{ height: 1, background: 'var(--border)', margin: '3px 0' }} />
                  {/* Manage / bulk — only when multiple layouts */}
                  {layoutNames.length > 1 && (
                    <button
                      onClick={() => { setLayoutMenuOpen(false); setManageSelected(new Set()); setManageOpen(true) }}
                      style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 9, padding: '9px 14px', background: 'transparent', border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, color: 'var(--text-primary)', textAlign: 'left' }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-elevated)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                    >
                      <Settings2 size={13} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
                      {pt ? 'Gerenciar layouts…' : 'Manage layouts…'}
                    </button>
                  )}
                  {/* Delete current */}
                  <button
                    onClick={() => { setLayoutMenuOpen(false); handleDeleteLayout() }}
                    style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 9, padding: '9px 14px', background: 'transparent', border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, color: '#ef4444', textAlign: 'left' }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'rgba(239,68,68,0.08)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  >
                    <Trash2 size={13} style={{ flexShrink: 0 }} />
                    {pt ? 'Deletar layout' : 'Delete layout'}
                  </button>
                </div>,
                document.body
              )}
            </div>
          </>
        )}

        {/* Edit mode left-side tools */}
        {!locked && (
          <>
            <div style={{ width: 1, height: 16, background: 'var(--border)', flexShrink: 0, margin: '0 2px' }} />
            {/* Palette toggle */}
            <button
              className="icon-btn"
              onClick={() => setSidebarOpen(v => !v)}
              title={sidebarOpen ? (pt ? 'Fechar paleta' : 'Close palette') : (pt ? 'Abrir paleta' : 'Open palette')}
              style={{ width: 28, height: 28 }}
            >
              {sidebarOpen ? <PanelLeftClose size={13} /> : <PanelLeftOpen size={13} />}
            </button>
            <div style={{ width: 1, height: 16, background: 'var(--border)', flexShrink: 0, margin: '0 2px' }} />
            {/* Undo / Redo */}
            <button className="icon-btn" onClick={handleUndo} disabled={undoStack.length === 0} title={pt ? 'Desfazer (Ctrl+Z)' : 'Undo (Ctrl+Z)'} style={{ width: 28, height: 28 }}>
              <Undo2 size={13} />
            </button>
            <button className="icon-btn" onClick={handleRedo} disabled={redoStack.length === 0} title={pt ? 'Refazer (Ctrl+Y)' : 'Redo (Ctrl+Y)'} style={{ width: 28, height: 28 }}>
              <Redo2 size={13} />
            </button>
            <div style={{ width: 1, height: 16, background: 'var(--border)', flexShrink: 0, margin: '0 2px' }} />
            {/* Random layout */}
            <button className="icon-btn" onClick={generateRandomLayout} title={pt ? 'Gerar layout aleatório' : 'Random layout'} style={{ width: 28, height: 28 }}>
              <Dice5 size={13} />
            </button>
          </>
        )}

        {/*  Spacer pushes everything right  */}
        <div style={{ flex: 1 }} />

        {/*  RIGHT GROUP: download | upload | [clear] | [cancel | save] | [edit]  */}


        {/* Export / Import */}
        <button className="icon-btn" onClick={handleExport} title={pt ? 'Exportar layout como JSON' : 'Export layout as JSON'} style={{ width: 26, height: 26 }}>
          <Download size={12} />
        </button>
        <button className="icon-btn" onClick={() => importFileRef.current?.click()} title={pt ? 'Importar layout de JSON' : 'Import layout from JSON'} style={{ width: 26, height: 26 }}>
          <Upload size={12} />
        </button>
        <input ref={importFileRef} type="file" accept=".json,application/json" style={{ display: 'none' }} onChange={handleImportFile} />

        {/* Clear — edit mode only, when canvas has items */}
        {!locked && items.length > 0 && (
          <>
            <div style={{ width: 1, height: 16, background: 'var(--border)', flexShrink: 0, margin: '0 2px' }} />
            <button
              className="icon-btn danger"
              onClick={handleReset}
              title={pt ? 'Limpar canvas' : 'Clear canvas'}
              style={{ width: 'auto', paddingLeft: 8, paddingRight: 8, gap: 5, height: 28, fontSize: 11, fontWeight: 500 }}
            >
              <RotateCcw size={11} />
              {pt ? 'Limpar' : 'Clear'}
            </button>
          </>
        )}

        {/* Cancel / Save — edit mode */}
        {!locked && (
          <>
            <div style={{ width: 1, height: 16, background: 'var(--border)', flexShrink: 0, margin: '0 2px' }} />
            <button
              className="icon-btn"
              onClick={handleCancelEdit}
              title={pt ? 'Cancelar (reverter alterações)' : 'Cancel (revert changes)'}
              style={{ width: 'auto', paddingLeft: 12, paddingRight: 12, height: 28, fontSize: 12, fontWeight: 500 }}
            >
              {pt ? 'Cancelar' : 'Cancel'}
            </button>
            <button
              onClick={handleSave}
              title={pt ? 'Salvar e sair do modo de edição' : 'Save & exit editing'}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '5px 14px', height: 28,
                background: 'var(--anthropic-orange)', border: 'none',
                borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit',
                fontSize: 12, fontWeight: 700, color: '#fff',
                boxShadow: '0 1px 4px rgba(217,119,6,0.3)',
              }}
            >
              <Save size={12} />
              {pt ? 'Salvar' : 'Save'}
            </button>
          </>
        )}

        {/* Edit button — view mode only */}
        {locked && (
          <button
            onClick={handleUnlock}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '5px 12px', height: 28,
              background: 'var(--bg-elevated)', border: '1px solid var(--border)',
              borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit',
              fontSize: 12, fontWeight: 600, color: 'var(--text-primary)',
              transition: 'all 0.15s',
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--anthropic-orange)'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--anthropic-orange)' }}
            onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border)'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-primary)' }}
            title={pt ? 'Entrar no modo de edição' : 'Enter edit mode'}
          >
            <Pencil size={13} />
            {pt ? 'Editar' : 'Edit'}
          </button>
        )}
      </div>

      {/*  Main row: aside + canvas  */}
      <div ref={outerRowRef} style={{ display: 'flex', gap: sidebarOpen ? ASIDE_GAP : 0, alignItems: 'flex-start', minHeight: 'calc(calc(100vh / var(--ag-zoom, 1)) - 300px)' }}>

        {/*  Aside / Palette  */}
        {sidebarOpen && !locked && (
        <aside
          className="custom-aside"
          style={{
            width: ASIDE_WIDTH,
            // Sticks inside the PAGE PANEL, which is what scrolls on the desktop board (App.tsx's
            // `<main>`), not the window — so it rests just under the panel's top edge, and is as
            // tall as the panel (window minus the strip, the board's gaps and the page padding).
            position: 'sticky',
            top: 16,
            maxHeight: 'calc(calc(100vh / var(--ag-zoom, 1)) - var(--ag-topbar-h) - 48px)',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}
        >
          {/*  Filters (date, projects, models) — replaces the global header filter bar  */}
          <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', flexShrink: 0, overflow: 'hidden' }}>
            <FiltersBar
              filters={filters}
              onChange={next => {
                setFilters(next)
                setPinnedProjects(next.projects)
              }}
              projects={data.projects}
              sessionCountByProject={ctx.sessionCountByProject}
              models={ctx.models}
              modelGroups={ctx.modelGroups}
              modelsInProject={ctx.modelsInProject}
              users={ctx.users}
              harnesses={ctx.harnesses}
              lang={lang}
              compact
              canFilterMembers={ctx.me?.role === 'owner' || (ctx.me?.memberships ?? []).some(m => m.role === 'manager')}
            />
          </div>

          {/*  Palette search  */}
          <div style={{
            background: 'var(--bg-card)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-lg)',
            padding: '12px 14px 10px',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <Layers size={13} style={{ color: 'var(--anthropic-orange)', flexShrink: 0 }} />
              <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--text-tertiary)' }}>
                {pt ? 'Componentes' : 'Components'}
              </div>
            </div>
            <div style={{ position: 'relative' }}>
              <Search size={12} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-tertiary)' }} />
              <input
                type="text"
                placeholder={pt ? 'Buscar…' : 'Search…'}
                value={query}
                onChange={e => setQuery(e.target.value)}
                style={{
                  width: '100%', boxSizing: 'border-box',
                  padding: '7px 10px 7px 30px',
                  background: 'var(--bg-elevated)',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 8, fontSize: 12,
                  color: 'var(--text-primary)', fontFamily: 'inherit', outline: 'none',
                }}
                onFocus={e => e.currentTarget.style.borderColor = 'var(--anthropic-orange)40'}
                onBlur={e => e.currentTarget.style.borderColor = 'var(--border-subtle)'}
              />
            </div>
          </div>

          {/*  Palette item list  */}
          <div style={{
            background: 'var(--bg-card)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-lg)',
            padding: '6px',
            overflow: 'auto',
            flex: 1,
          }}>
            {(Object.keys(groupedCatalog) as CatalogCategory[]).map(cat => {
              const catItems = groupedCatalog[cat]
              if (catItems.length === 0) return null
              const isCollapsed = collapsed[cat]
              return (
                <div key={cat} style={{ marginBottom: 4 }}>
                  <button
                    onClick={() => setCollapsed(prev => ({ ...prev, [cat]: !prev[cat] }))}
                    style={{
                      width: '100%', display: 'flex', alignItems: 'center', gap: 6,
                      padding: '8px 10px', background: 'transparent', border: 'none',
                      cursor: 'pointer', fontFamily: 'inherit', fontSize: 11,
                      fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase',
                      color: 'var(--text-tertiary)', borderRadius: 6,
                    }}
                  >
                    {isCollapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
                    {pt ? CATEGORY_LABELS[cat].pt : CATEGORY_LABELS[cat].en}
                    <span style={{ marginLeft: 'auto', fontSize: 10, opacity: 0.6 }}>{catItems.length}</span>
                  </button>
                  {!isCollapsed && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '2px 4px 6px' }}>
                      {catItems.map(item => {
                        const Icon = item.icon
                        const isVariant = !!item.parentId
                        return (
                          <div
                            key={item.id}
                            className="droppable-element palette-item"
                            draggable
                            data-dragging={draggedCatalogItem?.id === item.id ? 'true' : 'false'}
                            onDragStart={e => handlePaletteDragStart(e, item)}
                            onDragEnd={handlePaletteDragEnd}
                            title={pt
                              ? `Arraste para o canvas. Tamanho padrão: ${item.defaultW}×${item.defaultH}.`
                              : `Drag onto the canvas. Default size: ${item.defaultW}×${item.defaultH}.`}
                            style={{
                              display: 'flex', alignItems: 'center', gap: 8,
                              padding: '7px 10px',
                              marginLeft: isVariant ? 14 : 0,
                              background: 'transparent',
                              border: '1px dashed var(--border)',
                              borderRadius: 8, cursor: 'grab',
                              fontSize: 12, color: 'var(--text-secondary)',
                            }}
                          >
                            <Icon size={13} />
                            <span style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                              {pt ? item.labelPt : item.labelEn}
                            </span>
                            {isVariant && (
                              <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-tertiary)', padding: '1px 5px', background: 'var(--bg-elevated)', borderRadius: 4, letterSpacing: '0.05em' }}>
                                VAR
                              </span>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </aside>
        )}

        {/*  Main canvas  */}
        <div
          style={{
            flex: 1,
            minWidth: 0,
            overflowX: rawGridWidth < MIN_GRID_WIDTH ? 'auto' : 'hidden',
            overflowY: 'visible',
            position: 'relative',
            minHeight: isDragging ? 600 : 400,
          }}
        >
          {/* No overlay needed: dragConfig.enabled=false and resizeConfig.enabled=false handle lock.
              An overlay would block scroll inside card components. */}

          {items.length === 0 && (
            <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 0 }}>
              <EmptyState pt={pt} isDragging={isDragging} />
            </div>
          )}

          {mounted && gridWidth > 0 && (
            <GridLayout
              className={`custom-grid${locked ? ' locked' : ''}`}
              width={gridWidth}
              layout={layout}
              style={items.length === 0 ? { minHeight: isDragging ? 580 : 380 } : undefined}
              gridConfig={{
                cols: GRID_COLS,
                rowHeight: GRID_ROW_HEIGHT,
                margin: [12, 12],
                containerPadding: null,
                maxRows: Infinity,
              }}
              dragConfig={{
                enabled: !locked,
                bounded: false,
                handle: '.grid-drag-handle',
                threshold: 3,
              }}
              resizeConfig={{ enabled: !locked, handles: ['se'] }}
              dropConfig={{ enabled: !locked, defaultItem: { w: 4, h: 3 } }}
              droppingItem={droppingItem}
              onLayoutChange={onLayoutChange}
              onDrop={onDrop}
              onDragStart={onGridDragStart}
              onDragStop={onGridDragStop}
              onResizeStart={onGridResizeStart}
              onResizeStop={onGridResizeStop}
              autoSize
            >
                {items.map(item => {
                  const catalog = getCatalogItem(item.componentId)
                  if (!catalog) return <div key={item.i} />
                  return (
                    <div key={item.i} className="grid-item-wrap" data-flash-id={item.componentId} style={{ overflow: 'hidden', borderRadius: 'var(--radius-lg)' }}>
                      <div
                        className={`grid-drag-handle${locked ? ' drag-handle-locked' : ''}`}
                        title={locked ? (pt ? 'Bloqueado' : 'Locked') : (pt ? 'Arrastar' : 'Drag')}
                        style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 24, zIndex: 3, cursor: locked ? 'default' : 'grab' }}
                      />
                      {!locked && (
                        <CardMenu
                          itemI={item.i}
                          open={openMenuId === item.i}
                          onOpen={() => setOpenMenuId(item.i)}
                          onClose={() => setOpenMenuId(null)}
                          onRemove={() => removeItemWithHistory(item.i)}
                          onResize={(w, h) => resizeItem(item.i, w, h)}
                          pt={pt}
                        />
                      )}
                      <div style={{ width: '100%', height: '100%', overflow: 'auto' }}>
                        {catalog.render(ctx)}
                      </div>
                    </div>
                  )
                })}
              </GridLayout>
            )}
        </div>
      </div>

      {/*  Duplicate layout modal  */}
      {dupModal && (
        <div
          style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(4px)' }}
          onClick={e => { if (e.target === e.currentTarget) setDupModal(null) }}
        >
          <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-xl,16px)', padding: 24, width: 440, maxWidth: 'calc(90vw / var(--ag-zoom, 1))', maxHeight: 'calc(80vh / var(--ag-zoom, 1))', display: 'flex', flexDirection: 'column', gap: 16, boxShadow: '0 20px 60px rgba(0,0,0,0.4)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>
                {pt ? 'Duplicar layout' : 'Duplicate layout'}
              </div>
              <button className="icon-btn" onClick={() => setDupModal(null)} style={{ width: 26, height: 26 }}><X size={12} /></button>
            </div>

            <div>
              <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 6 }}>
                {pt ? 'Nome do novo layout' : 'New layout name'}
              </label>
              <input
                autoFocus
                value={dupModal.newName}
                onChange={e => setDupModal(s => s ? { ...s, newName: e.target.value } : s)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && dupModal.newName.trim()) {
                    duplicateLayout(activeLayout, dupModal.newName, dupModal.pinned)
                    setDupModal(null)
                  }
                  if (e.key === 'Escape') setDupModal(null)
                }}
                style={{ width: '100%', boxSizing: 'border-box', padding: '8px 12px', background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', borderRadius: 8, fontSize: 13, color: 'var(--text-primary)', fontFamily: 'inherit', outline: 'none' }}
                onFocus={e => e.currentTarget.style.borderColor = 'var(--anthropic-orange)60'}
                onBlur={e => e.currentTarget.style.borderColor = 'var(--border-subtle)'}
              />
            </div>

            {allProjects.length > 0 && (
              <div>
                <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 8 }}>
                  {pt ? 'Projetos fixados' : 'Pinned projects'}
                </label>
                <div style={{ maxHeight: 180, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {allProjects.map(path => {
                    const checked = dupModal.pinned.includes(path)
                    return (
                      <label key={path} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 6, cursor: 'pointer', background: checked ? 'var(--anthropic-orange-dim)' : 'transparent' }}>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => setDupModal(s => s ? { ...s, pinned: checked ? s.pinned.filter(p => p !== path) : [...s.pinned, path] } : s)}
                          style={{ accentColor: 'var(--anthropic-orange)', flexShrink: 0 }}
                        />
                        <span style={{ fontSize: 12, color: checked ? 'var(--anthropic-orange)' : 'var(--text-secondary)', fontWeight: checked ? 600 : 400, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {formatProjectName(path)}
                        </span>
                      </label>
                    )
                  })}
                </div>
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setDupModal(null)} style={{ padding: '8px 16px', background: 'transparent', border: '1px solid var(--border)', borderRadius: 8, cursor: 'pointer', fontSize: 12, color: 'var(--text-secondary)', fontFamily: 'inherit', fontWeight: 500 }}>
                {pt ? 'Cancelar' : 'Cancel'}
              </button>
              <button
                disabled={!dupModal.newName.trim()}
                onClick={() => { duplicateLayout(activeLayout, dupModal.newName, dupModal.pinned); setDupModal(null) }}
                style={{ padding: '8px 20px', background: dupModal.newName.trim() ? 'var(--anthropic-orange)' : 'var(--bg-elevated)', border: 'none', borderRadius: 8, cursor: dupModal.newName.trim() ? 'pointer' : 'not-allowed', fontSize: 12, color: dupModal.newName.trim() ? '#fff' : 'var(--text-tertiary)', fontFamily: 'inherit', fontWeight: 600, transition: 'background 0.15s' }}
              >
                {pt ? 'Duplicar' : 'Duplicate'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/*  Delete-layout confirmation modal  */}
      {confirmDeleteName !== null && (
        <div
          style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(4px)', padding: isMobile ? 16 : 0 }}
          onClick={e => { if (e.target === e.currentTarget) setConfirmDeleteName(null) }}
        >
          <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-xl,16px)', padding: 24, width: 420, maxWidth: '100%', display: 'flex', flexDirection: 'column', gap: 16, boxShadow: '0 20px 60px rgba(0,0,0,0.4)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>
                {pt ? 'Excluir layout' : 'Delete layout'}
              </div>
              <button className="icon-btn" onClick={() => setConfirmDeleteName(null)} style={{ width: 26, height: 26 }}><X size={12} /></button>
            </div>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
              {pt
                ? <>Tem certeza que deseja excluir o layout <strong style={{ color: 'var(--text-primary)' }}>“{confirmDeleteName}”</strong>?{items.length > 0 ? ' Todos os componentes serão removidos.' : ''} Esta ação não pode ser desfeita.</>
                : <>Are you sure you want to delete the layout <strong style={{ color: 'var(--text-primary)' }}>“{confirmDeleteName}”</strong>?{items.length > 0 ? ' All components will be removed.' : ''} This cannot be undone.</>}
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setConfirmDeleteName(null)} style={{ padding: '8px 16px', background: 'transparent', border: '1px solid var(--border)', borderRadius: 8, cursor: 'pointer', fontSize: 12, color: 'var(--text-secondary)', fontFamily: 'inherit', fontWeight: 500 }}>
                {pt ? 'Cancelar' : 'Cancel'}
              </button>
              <button
                onClick={() => { deleteLayout(confirmDeleteName); setConfirmDeleteName(null) }}
                style={{ padding: '8px 20px', background: '#ef4444', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 12, color: '#fff', fontFamily: 'inherit', fontWeight: 600, transition: 'background 0.15s' }}
                onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = '#dc2626' }}
                onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = '#ef4444' }}
              >
                {pt ? 'Excluir' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/*  Manage layouts modal (bulk delete)  */}
      {manageOpen && (
        <div
          style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(4px)' }}
          onClick={e => { if (e.target === e.currentTarget) setManageOpen(false) }}
        >
          <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-xl,16px)', padding: 24, width: 420, maxWidth: 'calc(90vw / var(--ag-zoom, 1))', maxHeight: 'calc(80vh / var(--ag-zoom, 1))', display: 'flex', flexDirection: 'column', gap: 16, boxShadow: '0 20px 60px rgba(0,0,0,0.4)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>
                {pt ? 'Gerenciar layouts' : 'Manage layouts'}
              </div>
              <button className="icon-btn" onClick={() => setManageOpen(false)} style={{ width: 26, height: 26 }}><X size={12} /></button>
            </div>

            {/* A <label>, not a <div>: the text has to toggle the box like any other checkbox. */}
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', userSelect: 'none' }}>
              <input
                type="checkbox"
                checked={manageSelected.size === layoutNames.length && layoutNames.length > 0}
                onChange={e => {
                  if (e.target.checked) setManageSelected(new Set(layoutNames))
                  else setManageSelected(new Set())
                }}
                style={{ accentColor: 'var(--anthropic-orange)', cursor: 'pointer' }}
              />
              <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                {pt ? 'Selecionar todos' : 'Select all'}
              </span>
            </label>

            <div style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 3 }}>
              {layoutNames.map(name => {
                const isActive = name === activeLayout
                const canSelect = true
                const selected = manageSelected.has(name)
                return (
                  <label key={name} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 10px', borderRadius: 8, cursor: canSelect ? 'pointer' : 'default', background: selected ? 'rgba(239,68,68,0.07)' : isActive ? 'var(--anthropic-orange-dim)' : 'transparent', border: `1px solid ${selected ? 'rgba(239,68,68,0.25)' : 'transparent'}`, transition: 'background 0.1s' }}>
                    <input
                      type="checkbox"
                      checked={selected}
                      disabled={!canSelect}
                      onChange={() => {
                        setManageSelected(prev => {
                          const next = new Set(prev)
                          if (next.has(name)) next.delete(name); else next.add(name)
                          return next
                        })
                      }}
                      style={{ accentColor: '#ef4444', flexShrink: 0 }}
                    />
                    <span style={{ flex: 1, fontSize: 13, fontWeight: isActive ? 600 : 400, color: isActive ? 'var(--anthropic-orange)' : 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {name}
                    </span>
                    {isActive && (
                      <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 6px', background: 'var(--anthropic-orange-dim)', color: 'var(--anthropic-orange)', borderRadius: 4 }}>
                        {pt ? 'ativo' : 'active'}
                      </span>
                    )}
                  </label>
                )
              })}
            </div>

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', borderTop: '1px solid var(--border)', paddingTop: 12 }}>
              <button onClick={() => setManageOpen(false)} style={{ padding: '8px 16px', background: 'transparent', border: '1px solid var(--border)', borderRadius: 8, cursor: 'pointer', fontSize: 12, color: 'var(--text-secondary)', fontFamily: 'inherit', fontWeight: 500 }}>
                {pt ? 'Fechar' : 'Close'}
              </button>
              <button
                disabled={manageSelected.size === 0}
                onClick={() => {
                  const names = [...manageSelected]
                  const msg = pt
                    ? `Deletar ${names.length} layout(s) selecionado(s)?`
                    : `Delete ${names.length} selected layout(s)?`
                  if (confirm(msg)) { deleteLayouts(names); setManageSelected(new Set()); setManageOpen(false) }
                }}
                style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', background: manageSelected.size > 0 ? '#ef4444' : 'var(--bg-elevated)', border: 'none', borderRadius: 8, cursor: manageSelected.size > 0 ? 'pointer' : 'not-allowed', fontSize: 12, color: manageSelected.size > 0 ? '#fff' : 'var(--text-tertiary)', fontFamily: 'inherit', fontWeight: 600, transition: 'background 0.15s' }}
              >
                <Trash2 size={12} />
                {pt ? `Deletar selecionados (${manageSelected.size})` : `Delete selected (${manageSelected.size})`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/*  Import modal  */}
      {importState && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 1000,
          background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center',
          backdropFilter: 'blur(4px)',
        }}
          onClick={e => { if (e.target === e.currentTarget) setImportState(null) }}
        >
          <div style={{
            background: 'var(--bg-card)', border: '1px solid var(--border)',
            borderRadius: 'var(--radius-xl, 16px)', padding: 24, width: 480, maxWidth: 'calc(90vw / var(--ag-zoom, 1))',
            maxHeight: 'calc(80vh / var(--ag-zoom, 1))', display: 'flex', flexDirection: 'column', gap: 16,
            boxShadow: '0 20px 60px rgba(0,0,0,0.4)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>
                {pt ? 'Importar layout' : 'Import layout'}
              </div>
              <button className="icon-btn" onClick={() => setImportState(null)} style={{ width: 26, height: 26 }}>
                <X size={12} />
              </button>
            </div>

            {/* Layout name */}
            <div>
              <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 6 }}>
                {pt ? 'Nome do layout' : 'Layout name'}
              </label>
              <input
                value={importState.layoutName}
                onChange={e => setImportState(s => s ? { ...s, layoutName: e.target.value } : s)}
                style={{
                  width: '100%', boxSizing: 'border-box', padding: '8px 12px',
                  background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)',
                  borderRadius: 8, fontSize: 13, color: 'var(--text-primary)',
                  fontFamily: 'inherit', outline: 'none',
                }}
                onFocus={e => e.currentTarget.style.borderColor = 'var(--anthropic-orange)60'}
                onBlur={e => e.currentTarget.style.borderColor = 'var(--border-subtle)'}
              />
            </div>

            {/* Project mappings */}
            {importState.originalProjects.length > 0 && (
              <div style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  {pt ? 'Mapeamento de projetos' : 'Project mapping'}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.5, marginBottom: 4 }}>
                  {pt
                    ? 'Selecione o projeto local correspondente a cada projeto do layout importado.'
                    : 'Select the local project that corresponds to each project in the imported layout.'}
                </div>
                {importState.originalProjects.map(proj => (
                  <div key={proj.path} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 6 }}>
                      <FolderOpen size={11} style={{ color: 'var(--anthropic-orange)', flexShrink: 0 }} />
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {proj.displayName} <span style={{ color: 'var(--text-tertiary)', fontWeight: 400 }}>({proj.path})</span>
                      </span>
                    </div>
                    <ProjectSelect
                      value={importState.mappings[proj.path] ?? ''}
                      options={allProjects}
                      pt={pt}
                      onChange={val => setImportState(s => s ? { ...s, mappings: { ...s.mappings, [proj.path]: val } } : s)}
                    />
                  </div>
                ))}
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
              <button
                onClick={() => setImportState(null)}
                style={{
                  padding: '8px 16px', background: 'transparent', border: '1px solid var(--border)',
                  borderRadius: 8, cursor: 'pointer', fontSize: 12, color: 'var(--text-secondary)',
                  fontFamily: 'inherit', fontWeight: 500,
                }}
              >
                {pt ? 'Cancelar' : 'Cancel'}
              </button>
              <button
                onClick={handleConfirmImport}
                style={{
                  padding: '8px 20px', background: 'var(--anthropic-orange)', border: 'none',
                  borderRadius: 8, cursor: 'pointer', fontSize: 12, color: '#fff',
                  fontFamily: 'inherit', fontWeight: 600,
                }}
              >
                {pt ? 'Importar' : 'Import'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

const SIZE_PRESETS = [
  { labelEn: 'Small (3×3)', labelPt: 'Pequeno (3×3)', w: 3, h: 3 },
  { labelEn: 'Medium (4×4)', labelPt: 'Médio (4×4)', w: 4, h: 4 },
  { labelEn: 'Large (6×5)', labelPt: 'Grande (6×5)', w: 6, h: 5 },
  { labelEn: 'Wide (8×4)', labelPt: 'Largo (8×4)', w: 8, h: 4 },
  { labelEn: 'Full (12×5)', labelPt: 'Completo (12×5)', w: 12, h: 5 },
]

function CardMenu({
  itemI, open, onOpen, onClose, onRemove, onResize, pt,
}: {
  itemI: string
  open: boolean
  onOpen: () => void
  onClose: () => void
  onRemove: () => void
  onResize: (w: number, h: number) => void
  pt: boolean
}) {
  const btnRef = useRef<HTMLButtonElement>(null)
  const [menuPos, setMenuPos] = useState({ top: 0, right: 0 })

  function handleOpen(e: React.MouseEvent) {
    e.stopPropagation()
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect()
      setMenuPos({ top: r.bottom + 4, right: window.innerWidth - r.right })
    }
    open ? onClose() : onOpen()
  }

  return (
    <>
      <button
        ref={btnRef}
        className="grid-item-remove"
        onMouseDown={e => e.stopPropagation()}
        onClick={handleOpen}
        title={pt ? 'Opções do card' : 'Card options'}
        style={{
          position: 'absolute', top: 6, right: 6, zIndex: 4,
          width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'var(--bg-elevated)', border: '1px solid var(--border)',
          borderRadius: 6, color: 'var(--text-tertiary)', cursor: 'pointer', padding: 0,
        }}
      >
        <MoreHorizontal size={12} />
      </button>

      {open && createPortal(
        <div
          onMouseDown={e => e.stopPropagation()}
          style={{
            position: 'fixed', top: menuPos.top, right: menuPos.right,
            zIndex: 9999, minWidth: 170,
            background: 'var(--bg-card)', border: '1px solid var(--border)',
            borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
            overflow: 'hidden', padding: '4px 0',
          }}
        >
          <button
            onClick={() => { onClose(); onRemove() }}
            style={{
              width: '100%', display: 'flex', alignItems: 'center', gap: 8,
              padding: '8px 14px', background: 'transparent', border: 'none',
              cursor: 'pointer', fontFamily: 'inherit', fontSize: 12,
              color: '#ef4444', textAlign: 'left',
            }}
            onMouseEnter={e => (e.currentTarget.style.background = 'rgba(239,68,68,0.08)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          >
            <X size={12} />
            {pt ? 'Remover' : 'Remove'}
          </button>

          <div style={{ height: 1, background: 'var(--border)', margin: '3px 0' }} />

          <div style={{ padding: '4px 14px 2px', fontSize: 10, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--text-tertiary)' }}>
            {pt ? 'Tamanho' : 'Size'}
          </div>

          {SIZE_PRESETS.map(p => (
            <button
              key={p.labelEn}
              onClick={() => { onClose(); onResize(p.w, p.h) }}
              style={{
                width: '100%', display: 'flex', alignItems: 'center',
                padding: '7px 14px', background: 'transparent', border: 'none',
                cursor: 'pointer', fontFamily: 'inherit', fontSize: 12,
                color: 'var(--text-secondary)', textAlign: 'left',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-elevated)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >
              {pt ? p.labelPt : p.labelEn}
            </button>
          ))}
        </div>,
        document.body
      )}
    </>
  )
}

function EmptyState({ pt, isDragging }: { pt: boolean; isDragging: boolean }) {
  return (
    <div style={{
      height: '100%', padding: '60px 40px', textAlign: 'center',
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16,
      transition: 'opacity 0.15s',
    }}>
      <div style={{
        width: 56, height: 56,
        background: isDragging ? 'var(--anthropic-orange-dim)' : 'var(--bg-elevated)',
        border: isDragging ? '1px solid var(--anthropic-orange)60' : '1px solid var(--border)',
        borderRadius: 14, display: 'flex', alignItems: 'center', justifyContent: 'center',
        transition: 'background 0.15s, border-color 0.15s',
      }}>
        <Layers size={24} color={isDragging ? 'var(--anthropic-orange)' : 'var(--text-tertiary)'} />
      </div>
      <div>
        <div style={{ fontSize: 16, fontWeight: 700, color: isDragging ? 'var(--anthropic-orange)' : 'var(--text-primary)', marginBottom: 6, transition: 'color 0.15s' }}>
          {isDragging
            ? (pt ? 'Solte aqui' : 'Drop here')
            : (pt ? 'Monte sua página' : 'Build your own page')}
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.6, maxWidth: 440 }}>
          {pt
            ? 'Arraste componentes da paleta para esta área. Redimensione pelo canto inferior direito de cada card.'
            : 'Drag components from the palette onto this area. Resize using the bottom-right corner of each card.'}
        </div>
      </div>
    </div>
  )
}

