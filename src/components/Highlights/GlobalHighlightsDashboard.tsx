import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { HighlightCategory } from '../../types/highlights'
import type { HighlightLibrary, HighlightLibraryEntry } from '../../types/highlightLibrary'

type GroupMode = 'category' | 'document' | 'date'
type SortMode = 'newest' | 'oldest' | 'document' | 'category'
type DateFilter = 'all' | 'today' | '7days' | '30days' | 'custom'
type ExportFormat = 'markdown' | 'text' | 'docx'
type LibraryPatch = Partial<Pick<HighlightLibraryEntry, 'note' | 'category' | 'color'>>

type DashboardProps = {
  library: HighlightLibrary
  loading: boolean
  error: string | null
  onClose: () => void
  onOpenSearch: () => void
  onRefresh: () => void
  onOpen: (entry: HighlightLibraryEntry) => void
  onUpdate: (entries: HighlightLibraryEntry[], patch: LibraryPatch) => Promise<void>
  onDelete: (entries: HighlightLibraryEntry[]) => Promise<void>
  onExport: (entries: HighlightLibraryEntry[], format: ExportFormat) => Promise<void>
  onFilteredCountChange: (count: number) => void
}

type VirtualRow =
  | { id: string; type: 'group'; groupKey: string; label: string; count: number; top: number; height: number }
  | { id: string; type: 'entry'; entry: HighlightLibraryEntry; top: number; height: number }

const CATEGORY_ORDER: HighlightCategory[] = ['important', 'research', 'reference', 'question']
const CATEGORY_LABELS: Record<HighlightCategory, string> = {
  important: 'Important',
  research: 'Research',
  reference: 'Reference',
  question: 'Question',
}
const CATEGORY_COLORS: Record<HighlightCategory, string> = {
  important: 'bg-amber-300',
  research: 'bg-emerald-300',
  reference: 'bg-sky-300',
  question: 'bg-violet-300',
}
const GROUP_HEIGHT = 48
const ENTRY_HEIGHT = 174

export function GlobalHighlightsDashboard({
  library,
  loading,
  error,
  onClose,
  onOpenSearch,
  onRefresh,
  onOpen,
  onUpdate,
  onDelete,
  onExport,
  onFilteredCountChange,
}: DashboardProps) {
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query.trim().toLocaleLowerCase())
  const [groupMode, setGroupMode] = useState<GroupMode>('category')
  const [categoryFilter, setCategoryFilter] = useState<HighlightCategory | 'all'>('all')
  const [documentFilter, setDocumentFilter] = useState('all')
  const [dateFilter, setDateFilter] = useState<DateFilter>('all')
  const [customStart, setCustomStart] = useState('')
  const [customEnd, setCustomEnd] = useState('')
  const [notesOnly, setNotesOnly] = useState(false)
  const [sortMode, setSortMode] = useState<SortMode>('newest')
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set())
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set())
  const [previewKey, setPreviewKey] = useState<string | null>(null)
  const [exportFormat, setExportFormat] = useState<ExportFormat>('markdown')
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(600)
  const viewportRef = useRef<HTMLDivElement>(null)
  const scrollFrameRef = useRef(0)
  const pendingScrollTopRef = useRef(0)

  const documents = useMemo(
    () => [...new Map(library.entries.map((entry) => [entry.documentId, entry])).values()]
      .sort((left, right) => left.documentName.localeCompare(right.documentName)),
    [library.entries],
  )

  const filteredEntries = useMemo(() => {
    const now = new Date()
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    const start = customStart ? new Date(`${customStart}T00:00:00`).getTime() : Number.NEGATIVE_INFINITY
    const end = customEnd ? new Date(`${customEnd}T23:59:59.999`).getTime() : Number.POSITIVE_INFINITY
    const entries = library.entries.filter((entry) => {
      const searchable = entry.searchText ?? `${entry.text}\n${entry.note}\n${entry.documentName}\n${CATEGORY_LABELS[entry.category]}`.toLocaleLowerCase()
      const created = Date.parse(entry.createdDate)
      const dateMatches =
        dateFilter === 'all' ||
        (dateFilter === 'today' && created >= todayStart) ||
        (dateFilter === '7days' && created >= now.getTime() - 7 * 86_400_000) ||
        (dateFilter === '30days' && created >= now.getTime() - 30 * 86_400_000) ||
        (dateFilter === 'custom' && created >= start && created <= end)
      return (
        (!deferredQuery || searchable.includes(deferredQuery)) &&
        (categoryFilter === 'all' || entry.category === categoryFilter) &&
        (documentFilter === 'all' || entry.documentId === documentFilter) &&
        dateMatches &&
        (!notesOnly || Boolean(entry.note.trim()))
      )
    })
    entries.sort((left, right) => {
      if (sortMode === 'oldest') return Date.parse(left.createdDate) - Date.parse(right.createdDate)
      if (sortMode === 'document') return left.documentName.localeCompare(right.documentName) || left.pageNumber - right.pageNumber
      if (sortMode === 'category') return CATEGORY_ORDER.indexOf(left.category) - CATEGORY_ORDER.indexOf(right.category) || Date.parse(right.createdDate) - Date.parse(left.createdDate)
      return Date.parse(right.createdDate) - Date.parse(left.createdDate)
    })
    return entries
  }, [categoryFilter, customEnd, customStart, dateFilter, deferredQuery, documentFilter, library.entries, notesOnly, sortMode])

  useEffect(() => onFilteredCountChange(filteredEntries.length), [filteredEntries.length, onFilteredCountChange])

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const observer = new ResizeObserver(([entry]) => setViewportHeight(entry.contentRect.height))
    observer.observe(viewport)
    return () => {
      observer.disconnect()
      window.cancelAnimationFrame(scrollFrameRef.current)
    }
  }, [])

  const groups = useMemo(() => {
    const grouped = new Map<string, { label: string; entries: HighlightLibraryEntry[] }>()
    for (const entry of filteredEntries) {
      const key = groupMode === 'category'
        ? CATEGORY_LABELS[entry.category]
        : groupMode === 'document'
          ? `document:${entry.documentId}`
          : dateGroup(entry.createdDate)
      const group = grouped.get(key) ?? {
        label: groupMode === 'document' ? entry.documentName : key,
        entries: [],
      }
      group.entries.push(entry)
      grouped.set(key, group)
    }
    const preferredOrder = groupMode === 'category'
      ? CATEGORY_ORDER.map((category) => CATEGORY_LABELS[category])
      : groupMode === 'date'
        ? ['Today', 'Yesterday', 'Last 7 Days', 'Last 30 Days', 'Older']
        : [...grouped.entries()]
            .sort(([, left], [, right]) => left.label.localeCompare(right.label))
            .map(([key]) => key)
    return preferredOrder.flatMap((key) => {
      const group = grouped.get(key)
      return group?.entries.length ? [{ key, label: group.label, entries: group.entries }] : []
    })
  }, [filteredEntries, groupMode])

  const rows = useMemo(() => {
    const nextRows: VirtualRow[] = []
    let top = 0
    for (const group of groups) {
      nextRows.push({ id: `group:${group.key}`, type: 'group', groupKey: group.key, label: group.label, count: group.entries.length, top, height: GROUP_HEIGHT })
      top += GROUP_HEIGHT
      if (!collapsedGroups.has(group.key)) {
        for (const entry of group.entries) {
          nextRows.push({ id: entry.key, type: 'entry', entry, top, height: ENTRY_HEIGHT })
          top += ENTRY_HEIGHT
        }
      }
    }
    return { rows: nextRows, height: top }
  }, [collapsedGroups, groups])

  const visibleRows = useMemo(() => {
    const overscan = 400
    const start = Math.max(0, scrollTop - overscan)
    const end = scrollTop + viewportHeight + overscan
    const first = findFirstVisibleRow(rows.rows, start)
    let last = first
    while (last < rows.rows.length && rows.rows[last].top <= end) last += 1
    return rows.rows.slice(first, last)
  }, [rows.rows, scrollTop, viewportHeight])

  const previewEntry = library.entries.find((entry) => entry.key === previewKey) ?? null
  const selectedEntries = library.entries.filter((entry) => selectedKeys.has(entry.key))
  const actionEntries = selectedKeys.size > 0 ? selectedEntries : previewEntry ? [previewEntry] : []

  function toggleGroup(group: string) {
    setCollapsedGroups((current) => toggleSet(current, group))
  }

  function toggleSelected(entry: HighlightLibraryEntry) {
    setPreviewKey(entry.key)
    setSelectedKeys((current) => toggleSet(current, entry.key))
  }

  async function copyEntries(entries: HighlightLibraryEntry[]) {
    if (!entries.length) return
    await navigator.clipboard.writeText(
      entries.map((entry) => `${entry.text}${entry.note ? `\n\n${entry.note}` : ''}\n\n${entry.documentName}, page ${entry.pageNumber}`).join('\n\n---\n\n'),
    )
  }

  return (
    <section className="flex h-[calc(100vh-10rem)] min-h-[560px] flex-col overflow-hidden rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl shadow-black/25">
      <header className="flex flex-wrap items-center gap-3 border-b border-slate-700 bg-gradient-to-r from-slate-950 to-slate-900 px-5 py-4">
        <div className="min-w-52 flex-1">
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-blue-300">Knowledge Base</p>
          <h1 className="mt-1 text-xl font-semibold text-white">All Highlights</h1>
        </div>
        <Stat label="PDFs" value={library.stats.totalDocuments} />
        <Stat label="Highlights" value={library.stats.totalHighlights} />
        {CATEGORY_ORDER.map((category) => (
          <Stat key={category} label={CATEGORY_LABELS[category]} value={library.stats.categories[category]} color={CATEGORY_COLORS[category]} />
        ))}
        <button type="button" onClick={onOpenSearch} className="dashboard-button">Search Library</button>
        <button type="button" onClick={onRefresh} className="dashboard-button">Refresh</button>
        <button type="button" onClick={onClose} className="dashboard-button">Close</button>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[220px_minmax(360px,1fr)_300px] max-xl:grid-cols-[210px_minmax(340px,1fr)]">
        <aside className="min-h-0 overflow-y-auto border-r border-slate-700 bg-slate-950/45 p-3">
          <DashboardLabel>Search library</DashboardLabel>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Text, notes, PDF, category..." className="dashboard-input mb-4" />
          <DashboardLabel>Group by</DashboardLabel>
          <div className="mb-4 grid grid-cols-3 gap-1">
            {(['category', 'document', 'date'] as GroupMode[]).map((mode) => (
              <button key={mode} type="button" onClick={() => setGroupMode(mode)} className={`dashboard-segment ${groupMode === mode ? 'dashboard-segment-active' : ''}`}>
                {mode === 'category' ? 'Category' : mode === 'document' ? 'PDF' : 'Date'}
              </button>
            ))}
          </div>
          <DashboardLabel>Category</DashboardLabel>
          <select value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value as HighlightCategory | 'all')} className="dashboard-input mb-3">
            <option value="all">All categories</option>
            {CATEGORY_ORDER.map((category) => <option key={category} value={category}>{CATEGORY_LABELS[category]}</option>)}
          </select>
          <DashboardLabel>Document</DashboardLabel>
          <select value={documentFilter} onChange={(event) => setDocumentFilter(event.target.value)} className="dashboard-input mb-3">
            <option value="all">All documents</option>
            {documents.map((document) => <option key={document.documentId} value={document.documentId}>{document.documentName}</option>)}
          </select>
          <DashboardLabel>Date range</DashboardLabel>
          <select value={dateFilter} onChange={(event) => setDateFilter(event.target.value as DateFilter)} className="dashboard-input mb-2">
            <option value="all">Any date</option><option value="today">Today</option><option value="7days">Last 7 days</option><option value="30days">Last 30 days</option><option value="custom">Custom</option>
          </select>
          {dateFilter === 'custom' ? <div className="mb-3 grid gap-2"><input type="date" value={customStart} onChange={(event) => setCustomStart(event.target.value)} className="dashboard-input" /><input type="date" value={customEnd} onChange={(event) => setCustomEnd(event.target.value)} className="dashboard-input" /></div> : null}
          <label className="mb-4 flex cursor-pointer items-center gap-2 rounded-lg p-2 text-xs text-slate-300 hover:bg-slate-800"><input type="checkbox" checked={notesOnly} onChange={(event) => setNotesOnly(event.target.checked)} />Only highlights with notes</label>
          <DashboardLabel>Sort</DashboardLabel>
          <select value={sortMode} onChange={(event) => setSortMode(event.target.value as SortMode)} className="dashboard-input">
            <option value="newest">Newest first</option><option value="oldest">Oldest first</option><option value="document">PDF name</option><option value="category">Category</option>
          </select>
        </aside>

        <div className="flex min-h-0 flex-col bg-[#0f172a]">
          <div className="flex min-h-12 flex-wrap items-center gap-2 border-b border-slate-700 px-3 py-2 text-xs">
            <span className="font-semibold text-slate-200">{filteredEntries.length} results</span>
            <button type="button" onClick={() => setSelectedKeys(new Set(filteredEntries.map((entry) => entry.key)))} className="dashboard-button">Select all</button>
            <button type="button" onClick={() => setSelectedKeys(new Set())} disabled={!selectedKeys.size} className="dashboard-button">Clear</button>
            <select value={exportFormat} onChange={(event) => setExportFormat(event.target.value as ExportFormat)} className="dashboard-compact-select ml-auto"><option value="markdown">Markdown</option><option value="text">TXT</option><option value="docx">Word</option></select>
            <button type="button" disabled={!actionEntries.length} onClick={() => void onExport(actionEntries, exportFormat)} className="dashboard-button">Export</button>
            <button type="button" disabled={!actionEntries.length} onClick={() => void copyEntries(actionEntries)} className="dashboard-button">Copy</button>
            <select aria-label="Move selected highlights to category" defaultValue="" disabled={!actionEntries.length} onChange={(event) => { const category = event.target.value as HighlightCategory; if (category) void onUpdate(actionEntries, { category }); event.target.value = '' }} className="dashboard-compact-select"><option value="">Move category...</option>{CATEGORY_ORDER.map((category) => <option key={category} value={category}>{CATEGORY_LABELS[category]}</option>)}</select>
            <button type="button" disabled={!actionEntries.length} onClick={() => { if (window.confirm(`Delete ${actionEntries.length} selected highlight${actionEntries.length === 1 ? '' : 's'}?`)) void onDelete(actionEntries) }} className="dashboard-button dashboard-danger">Delete</button>
          </div>
          {loading ? <div className="grid flex-1 place-items-center text-sm text-slate-400">Loading highlight index...</div> : error ? <div className="m-4 rounded-xl border border-red-500/40 bg-red-950/50 p-4 text-sm text-red-100">{error}</div> : filteredEntries.length === 0 ? <div className="grid flex-1 place-items-center p-8 text-center"><div><p className="font-semibold text-slate-200">No highlights found</p><p className="mt-1 text-sm text-slate-500">Adjust the filters or add highlights to a PDF.</p></div></div> : (
            <div ref={viewportRef} onScroll={(event) => { pendingScrollTopRef.current = event.currentTarget.scrollTop; if (!scrollFrameRef.current) scrollFrameRef.current = window.requestAnimationFrame(() => { scrollFrameRef.current = 0; setScrollTop(pendingScrollTopRef.current) }) }} className="min-h-0 flex-1 overflow-y-auto">
              <div className="relative" style={{ height: rows.height }}>
                {visibleRows.map((row) => row.type === 'group' ? (
                  <button key={row.id} type="button" onClick={() => toggleGroup(row.groupKey)} className="absolute left-0 right-0 flex items-center gap-2 border-b border-slate-800 bg-slate-900/95 px-4 text-left text-xs font-bold uppercase tracking-wider text-slate-300 hover:bg-slate-800" style={{ top: row.top, height: row.height }}>
                    <span className={`transition-transform ${collapsedGroups.has(row.groupKey) ? '-rotate-90' : ''}`}>▾</span><span>{row.label}</span><span className="rounded-full bg-slate-700 px-2 py-0.5 text-[10px] text-slate-300">{row.count}</span>
                  </button>
                ) : (
                  <HighlightRow key={row.id} entry={row.entry} top={row.top} height={row.height} selected={selectedKeys.has(row.entry.key)} previewed={previewKey === row.entry.key} onSelect={() => toggleSelected(row.entry)} onPreview={() => setPreviewKey(row.entry.key)} onOpen={() => onOpen(row.entry)} />
                ))}
              </div>
            </div>
          )}
        </div>

        <aside className="min-h-0 overflow-y-auto border-l border-slate-700 bg-slate-950/45 p-4 max-xl:hidden">
          <h2 className="text-xs font-bold uppercase tracking-[0.16em] text-slate-400">Highlight Preview</h2>
          {previewEntry ? <HighlightPreview key={previewEntry.key} entry={previewEntry} onOpen={() => onOpen(previewEntry)} onSaveNote={(note) => onUpdate([previewEntry], { note })} /> : <p className="mt-6 text-sm leading-6 text-slate-500">Use Preview on a highlight to inspect its full text and edit its note.</p>}
        </aside>
      </div>
    </section>
  )
}

function HighlightRow({ entry, top, height, selected, previewed, onSelect, onPreview, onOpen }: { entry: HighlightLibraryEntry; top: number; height: number; selected: boolean; previewed: boolean; onSelect: () => void; onPreview: () => void; onOpen: () => void }) {
  return <article className={`absolute left-3 right-3 rounded-xl border bg-slate-900 p-3 shadow-sm transition-colors ${previewed ? 'border-blue-400/70' : 'border-slate-700 hover:border-slate-500'}`} style={{ top: top + 6, height: height - 12 }}>
    <div className="flex items-center gap-2"><input type="checkbox" checked={selected} onChange={onSelect} aria-label={`Select highlight from ${entry.documentName}`} /><span className={`size-2.5 rounded-full ${CATEGORY_COLORS[entry.category]}`} /><span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{CATEGORY_LABELS[entry.category]}</span><span className="ml-auto text-[10px] text-slate-500">{formatDate(entry.createdDate)}</span></div>
    <button type="button" onClick={onOpen} className="mt-2 line-clamp-2 w-full text-left text-sm leading-5 text-slate-100 hover:text-blue-200" title="Open source PDF">{entry.text}</button>
    {entry.note ? <p className="mt-2 line-clamp-1 border-l-2 border-blue-400/50 pl-2 text-xs italic text-slate-400">{entry.note}</p> : <p className="mt-2 text-xs text-slate-600">No note</p>}
    <div className="mt-2 flex items-center gap-2 text-[11px] text-slate-500"><span className="min-w-0 flex-1 truncate" title={entry.filePath}>{entry.documentName}</span><span>Page {entry.pageNumber}</span><button type="button" onClick={onPreview} className="rounded-md px-2 py-1 text-blue-300 hover:bg-blue-500/15">Preview</button><button type="button" onClick={onOpen} className="rounded-md px-2 py-1 text-slate-300 hover:bg-slate-700">Open</button></div>
  </article>
}

function HighlightPreview({ entry, onOpen, onSaveNote }: { entry: HighlightLibraryEntry; onOpen: () => void; onSaveNote: (note: string) => Promise<void> }) {
  const [note, setNote] = useState(entry.note)
  const save = () => note.trimEnd() !== entry.note && void onSaveNote(note.trimEnd())
  return <div className="mt-4 space-y-4"><div className="flex items-center gap-2"><span className={`size-3 rounded-full ${CATEGORY_COLORS[entry.category]}`} /><span className="text-sm font-semibold text-slate-200">{CATEGORY_LABELS[entry.category]}</span></div><p className="whitespace-pre-wrap text-sm leading-6 text-slate-200">{entry.text}</p><PreviewField label="Document" value={entry.documentName} /><PreviewField label="Page" value={String(entry.pageNumber)} /><PreviewField label="Created" value={formatDate(entry.createdDate)} /><PreviewField label="Modified" value={formatDate(entry.modifiedDate)} /><label className="block"><span className="mb-1.5 block text-[10px] font-bold uppercase tracking-wider text-slate-500">Note</span><textarea value={note} onChange={(event) => setNote(event.target.value)} onBlur={save} onKeyDown={(event) => { if (event.ctrlKey && event.key === 'Enter') { save(); event.currentTarget.blur() } }} rows={7} className="dashboard-input resize-y leading-5" placeholder="Add a note..." /></label><button type="button" onClick={onOpen} className="w-full rounded-lg bg-blue-500 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-400">Open source</button></div>
}

function PreviewField({ label, value }: { label: string; value: string }) { return <div><p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{label}</p><p className="mt-1 break-words text-xs text-slate-300">{value}</p></div> }
function DashboardLabel({ children }: { children: ReactNode }) { return <span className="mb-1.5 block text-[10px] font-bold uppercase tracking-wider text-slate-500">{children}</span> }
function Stat({ label, value, color }: { label: string; value: number; color?: string }) { return <div className="min-w-16 rounded-xl border border-slate-700 bg-slate-900/80 px-3 py-2"><div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-slate-500">{color ? <span className={`size-2 rounded-full ${color}`} /> : null}{label}</div><p className="mt-0.5 text-lg font-semibold tabular-nums text-slate-100">{value}</p></div> }

function toggleSet<T>(source: Set<T>, value: T) { const next = new Set(source); if (next.has(value)) next.delete(value); else next.add(value); return next }
function formatDate(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString() }
function dateGroup(value: string) { const timestamp = Date.parse(value); const now = new Date(); const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime(); const yesterday = today - 86_400_000; if (timestamp >= today) return 'Today'; if (timestamp >= yesterday) return 'Yesterday'; if (timestamp >= today - 7 * 86_400_000) return 'Last 7 Days'; if (timestamp >= today - 30 * 86_400_000) return 'Last 30 Days'; return 'Older' }
function findFirstVisibleRow(rows: VirtualRow[], target: number) { let low = 0; let high = rows.length; while (low < high) { const middle = Math.floor((low + high) / 2); const row = rows[middle]; if (row.top + row.height < target) low = middle + 1; else high = middle } return low }
