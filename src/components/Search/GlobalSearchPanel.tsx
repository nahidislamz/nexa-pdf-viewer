import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type {
  GlobalSearchFilters,
  GlobalSearchLibraryInfo,
  GlobalSearchResponse,
  GlobalSearchResult,
  GlobalSearchResultType,
  SavedGlobalSearch,
} from '../../types/globalSearch'
import { EMPTY_GLOBAL_SEARCH_RESPONSE } from '../../types/globalSearch'
import type { HighlightCategory } from '../../types/highlights'

type DatePreset = 'all' | 'today' | '7days' | '30days' | 'custom'

const RESULT_HEIGHT = 142
const TYPE_LABELS: Record<GlobalSearchResultType, string> = {
  'pdf-text': 'Embedded Text',
  'ocr-text': 'OCR Text',
  highlight: 'Highlight',
  note: 'Note',
  bookmark: 'Bookmark',
  file: 'File',
  metadata: 'Metadata',
  reference: 'Reference',
}
const TYPE_STYLES: Record<GlobalSearchResultType, string> = {
  'pdf-text': 'bg-slate-500/15 text-slate-300',
  'ocr-text': 'bg-fuchsia-400/15 text-fuchsia-200',
  highlight: 'bg-amber-400/15 text-amber-200',
  note: 'bg-emerald-400/15 text-emerald-200',
  bookmark: 'bg-sky-400/15 text-sky-200',
  file: 'bg-blue-400/15 text-blue-200',
  metadata: 'bg-violet-400/15 text-violet-200',
  reference: 'bg-cyan-400/15 text-cyan-200',
}

export function GlobalSearchPanel({
  onClose,
  onOpenResult,
  onStatusChange,
}: {
  onClose: () => void
  onOpenResult: (result: GlobalSearchResult, query: string) => void
  onStatusChange: (response: GlobalSearchResponse) => void
}) {
  const [query, setQuery] = useState('')
  const [resultType, setResultType] = useState<GlobalSearchResultType | 'all'>('all')
  const [category, setCategory] = useState<HighlightCategory | 'all'>('all')
  const [documentId, setDocumentId] = useState('all')
  const [datePreset, setDatePreset] = useState<DatePreset>('all')
  const [scope, setScope] = useState<'workspace' | 'all'>('workspace')
  const [customStart, setCustomStart] = useState('')
  const [customEnd, setCustomEnd] = useState('')
  const [response, setResponse] = useState<GlobalSearchResponse>(EMPTY_GLOBAL_SEARCH_RESPONSE)
  const [libraryInfo, setLibraryInfo] = useState<GlobalSearchLibraryInfo>({ documents: [], recentSearches: [], savedSearches: [] })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedSearchName, setSavedSearchName] = useState('')
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(600)
  const [indexRevision, setIndexRevision] = useState(0)
  const searchGenerationRef = useRef(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const scrollFrameRef = useRef(0)
  const pendingScrollTopRef = useRef(0)
  const indexSignatureRef = useRef('')

  const filters = useMemo<GlobalSearchFilters>(() => {
    const range = dateRange(datePreset, customStart, customEnd)
    return { type: resultType, category, documentId, scope, ...range }
  }, [category, customEnd, customStart, datePreset, documentId, resultType, scope])

  useEffect(() => {
    inputRef.current?.focus()
    let cancelled = false
    const refresh = async () => {
      try {
        const info = await window.electronAPI.getSearchLibraryInfo()
        if (cancelled) return
        const signature = info.documents.map((document) => `${document.documentId}:${document.status}:${document.indexedPages}:${document.indexedAt ?? ''}`).join('|')
        setLibraryInfo(info)
        if (indexSignatureRef.current && signature !== indexSignatureRef.current) {
          setIndexRevision((revision) => revision + 1)
        }
        indexSignatureRef.current = signature
      } catch (reason) {
        if (!cancelled) setError(errorMessage(reason))
      }
    }
    void refresh()
    const interval = window.setInterval(() => void refresh(), 2500)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [])

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

  useEffect(() => {
    const generation = ++searchGenerationRef.current
    const normalized = query.trim()
    if (!normalized) {
      const timeout = window.setTimeout(() => {
        setResponse(EMPTY_GLOBAL_SEARCH_RESPONSE)
        setLoading(false)
        setError(null)
        onStatusChange(EMPTY_GLOBAL_SEARCH_RESPONSE)
      }, 0)
      return () => window.clearTimeout(timeout)
    }
    const timeout = window.setTimeout(() => {
      setLoading(true)
      void window.electronAPI.searchLibrary({ query: normalized, filters })
        .then((nextResponse) => {
          if (searchGenerationRef.current !== generation) return
          setResponse(nextResponse)
          setLoading(false)
          setError(null)
          setScrollTop(0)
          viewportRef.current?.scrollTo({ top: 0 })
          onStatusChange(nextResponse)
        })
        .catch((reason) => {
          if (searchGenerationRef.current !== generation) return
          setLoading(false)
          setError(errorMessage(reason))
        })
    }, 250)
    return () => window.clearTimeout(timeout)
  }, [filters, indexRevision, onStatusChange, query])

  const firstVisible = Math.max(0, Math.floor(scrollTop / RESULT_HEIGHT) - 4)
  const lastVisible = Math.min(
    response.results.length,
    Math.ceil((scrollTop + viewportHeight) / RESULT_HEIGHT) + 4,
  )
  const visibleResults = response.results.slice(firstVisible, lastVisible)

  async function recordSearch() {
    if (!query.trim()) return
    const recentSearches = await window.electronAPI.recordGlobalSearch(query.trim())
    setLibraryInfo((current) => ({ ...current, recentSearches }))
  }

  async function saveSearch() {
    if (!query.trim()) return
    try {
      const savedSearches = await window.electronAPI.saveGlobalSearch({
        name: savedSearchName.trim() || query.trim(),
        query: query.trim(),
        filters,
      })
      setLibraryInfo((current) => ({ ...current, savedSearches }))
      setSavedSearchName('')
    } catch (reason) {
      setError(errorMessage(reason))
    }
  }

  function applySavedSearch(search: SavedGlobalSearch) {
    setQuery(search.query)
    setResultType(search.filters.type)
    setCategory(search.filters.category)
    setDocumentId(search.filters.documentId)
    setDatePreset(search.filters.dateStart || search.filters.dateEnd ? 'custom' : 'all')
    setCustomStart(search.filters.dateStart)
    setCustomEnd(search.filters.dateEnd)
    setScope(search.filters.scope ?? 'workspace')
  }

  return (
    <section className="flex h-[calc(100vh-10rem)] min-h-[560px] flex-col overflow-hidden rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl shadow-black/30">
      <header className="flex items-center gap-3 border-b border-slate-700 bg-gradient-to-r from-slate-950 to-slate-900 px-5 py-4">
        <div className="min-w-44">
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-blue-300">Library Search</p>
          <h1 className="mt-1 text-xl font-semibold text-white">Search Across PDFs</h1>
        </div>
        <label className="relative min-w-64 flex-1">
          <span className="sr-only">Global search query</span>
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void recordSearch()
              if (event.key === 'Escape') onClose()
            }}
            placeholder='Search PDFs, notes, highlights... Use "quotes" for exact phrases'
            className="h-11 w-full rounded-xl border border-slate-600 bg-slate-950 px-4 pr-24 text-sm text-white outline-none placeholder:text-slate-600 focus:border-blue-400 focus:ring-2 focus:ring-blue-400/15"
          />
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-slate-500">Ctrl+Shift+F</span>
        </label>
        <button type="button" onClick={onClose} className="dashboard-button">Close</button>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[230px_minmax(420px,1fr)_250px] max-xl:grid-cols-[220px_minmax(360px,1fr)]">
        <aside className="min-h-0 overflow-y-auto border-r border-slate-700 bg-slate-950/45 p-3">
          <FilterLabel>Search scope</FilterLabel>
          <div className="mb-4 grid grid-cols-2 rounded-lg border border-slate-700 bg-slate-950 p-1">
            <button type="button" onClick={() => setScope('workspace')} className={`rounded-md px-2 py-2 text-xs font-semibold ${scope === 'workspace' ? 'bg-blue-500 text-white' : 'text-slate-400 hover:text-white'}`}>Workspace</button>
            <button type="button" onClick={() => setScope('all')} className={`rounded-md px-2 py-2 text-xs font-semibold ${scope === 'all' ? 'bg-blue-500 text-white' : 'text-slate-400 hover:text-white'}`}>All PDFs</button>
          </div>
          <FilterLabel>Result type</FilterLabel>
          <select value={resultType} onChange={(event) => setResultType(event.target.value as typeof resultType)} className="dashboard-input mb-3">
            <option value="all">All results</option>
            {Object.entries(TYPE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <FilterLabel>Highlight category</FilterLabel>
          <select value={category} onChange={(event) => setCategory(event.target.value as typeof category)} className="dashboard-input mb-3">
            <option value="all">All categories</option><option value="important">Important</option><option value="research">Research</option><option value="reference">Reference</option><option value="question">Question</option>
          </select>
          <FilterLabel>Document</FilterLabel>
          <select value={documentId} onChange={(event) => setDocumentId(event.target.value)} className="dashboard-input mb-3">
            <option value="all">All indexed PDFs</option>
            {libraryInfo.documents.map((document) => <option key={document.documentId} value={document.documentId}>{document.name}</option>)}
          </select>
          <FilterLabel>Date</FilterLabel>
          <select value={datePreset} onChange={(event) => setDatePreset(event.target.value as DatePreset)} className="dashboard-input mb-2">
            <option value="all">Any date</option><option value="today">Today</option><option value="7days">Last 7 days</option><option value="30days">Last 30 days</option><option value="custom">Custom</option>
          </select>
          {datePreset === 'custom' ? <div className="grid gap-2"><input type="date" value={customStart} onChange={(event) => setCustomStart(event.target.value)} className="dashboard-input" /><input type="date" value={customEnd} onChange={(event) => setCustomEnd(event.target.value)} className="dashboard-input" /></div> : null}
          <div className="mt-5 rounded-xl border border-slate-700 bg-slate-900/70 p-3 text-xs text-slate-400">
            <p className="font-semibold text-slate-200">Index status</p>
            <p className="mt-2">{libraryInfo.documents.filter((document) => document.status === 'complete').length} of {libraryInfo.documents.length} PDFs indexed</p>
            <p className="mt-1 text-[10px] leading-4 text-slate-500">Documents become searchable in the background after opening.</p>
          </div>
        </aside>

        <div className="flex min-h-0 flex-col bg-[#0f172a]">
          <div className="flex min-h-12 items-center gap-3 border-b border-slate-700 px-4 text-xs text-slate-400">
            {loading ? <span>Searching...</span> : <><span className="font-semibold text-slate-200">{response.total} results</span><span>{response.counts.documents} PDFs</span><span>{response.counts.highlights} highlights</span><span>{response.counts.notes} notes</span><span className="ml-auto">{response.durationMs}ms</span></>}
          </div>
          {error ? <p className="m-4 rounded-xl border border-red-500/40 bg-red-950/50 p-3 text-sm text-red-100">{error}</p> : null}
          {!query.trim() ? (
            <div className="min-h-0 flex-1 overflow-y-auto p-6">
              <EmptySearchState recentSearches={libraryInfo.recentSearches} savedSearches={libraryInfo.savedSearches} onRecent={setQuery} onSaved={applySavedSearch} />
            </div>
          ) : !loading && response.results.length === 0 ? (
            <div className="grid flex-1 place-items-center p-8 text-center"><div><p className="font-semibold text-slate-200">No results</p><p className="mt-1 text-sm text-slate-500">Try fewer terms, a partial word, or a different filter.</p></div></div>
          ) : (
            <div
              ref={viewportRef}
              onScroll={(event) => {
                pendingScrollTopRef.current = event.currentTarget.scrollTop
                if (!scrollFrameRef.current) scrollFrameRef.current = window.requestAnimationFrame(() => {
                  scrollFrameRef.current = 0
                  setScrollTop(pendingScrollTopRef.current)
                })
              }}
              className="min-h-0 flex-1 overflow-y-auto"
            >
              <div className="relative" style={{ height: response.results.length * RESULT_HEIGHT }}>
                {visibleResults.map((result, offset) => (
                  <SearchResultCard
                    key={result.id}
                    result={result}
                    query={query}
                    top={(firstVisible + offset) * RESULT_HEIGHT}
                    onOpen={() => {
                      void recordSearch()
                      onOpenResult(result, query.trim())
                    }}
                  />
                ))}
              </div>
            </div>
          )}
        </div>

        <aside className="min-h-0 overflow-y-auto border-l border-slate-700 bg-slate-950/45 p-3 max-xl:hidden">
          <FilterLabel>Save this search</FilterLabel>
          <input value={savedSearchName} onChange={(event) => setSavedSearchName(event.target.value)} placeholder="Search name" className="dashboard-input" />
          <button type="button" onClick={() => void saveSearch()} disabled={!query.trim()} className="dashboard-button mt-2 w-full">Save Search</button>
          <div className="mt-5 flex items-center justify-between"><FilterLabel>Saved searches</FilterLabel></div>
          <div className="space-y-1.5">
            {libraryInfo.savedSearches.map((search) => (
              <div key={search.id} className="flex items-center rounded-lg border border-slate-800 bg-slate-900/60 p-1">
                <button type="button" onClick={() => applySavedSearch(search)} className="min-w-0 flex-1 truncate px-2 py-1.5 text-left text-xs text-slate-300 hover:text-white">{search.name}</button>
                <button type="button" aria-label={`Delete saved search ${search.name}`} onClick={() => void window.electronAPI.deleteSavedGlobalSearch(search.id).then((savedSearches) => setLibraryInfo((current) => ({ ...current, savedSearches })))} className="grid size-7 place-items-center rounded text-slate-600 hover:bg-red-500/10 hover:text-red-300">&times;</button>
              </div>
            ))}
          </div>
          <div className="mt-5 flex items-center justify-between"><FilterLabel>Recent searches</FilterLabel><button type="button" onClick={() => void window.electronAPI.clearGlobalSearchHistory().then((recentSearches) => setLibraryInfo((current) => ({ ...current, recentSearches })))} className="text-[10px] text-slate-500 hover:text-red-300">Clear</button></div>
          <div className="space-y-1">{libraryInfo.recentSearches.map((recent) => <button key={recent} type="button" onClick={() => setQuery(recent)} className="block w-full truncate rounded-lg px-2 py-1.5 text-left text-xs text-slate-400 hover:bg-slate-800 hover:text-white">{recent}</button>)}</div>
        </aside>
      </div>
    </section>
  )
}

function SearchResultCard({ result, query, top, onOpen }: { result: GlobalSearchResult; query: string; top: number; onOpen: () => void }) {
  return (
    <article className="absolute left-3 right-3 rounded-xl border border-slate-700 bg-slate-900 p-3 shadow-sm transition hover:border-blue-400/60 hover:bg-slate-800" style={{ top: top + 6, height: RESULT_HEIGHT - 12 }}>
      <button type="button" onClick={onOpen} className="block h-full w-full text-left">
        <div className="flex items-center gap-2"><span className={`rounded-md px-2 py-1 text-[10px] font-bold uppercase tracking-wider ${TYPE_STYLES[result.type]}`}>{TYPE_LABELS[result.type]}</span>{result.lowConfidence ? <span className="rounded bg-amber-400/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-200">Low confidence</span> : null}{result.category ? <span className="text-[10px] capitalize text-slate-500">{result.category}</span> : null}<span className="ml-auto text-[10px] text-slate-500">Page {result.pageNumber}</span></div>
        <p className="mt-2 line-clamp-3 text-sm leading-5 text-slate-200"><HighlightedPreview text={result.preview} query={result.matchText ? `${query} ${result.matchText}` : query} /></p>
        <div className="mt-2 flex items-center gap-2 text-[11px] text-slate-500"><span className="min-w-0 flex-1 truncate" title={result.filePath}>{result.documentName}</span><span>Open source</span></div>
      </button>
    </article>
  )
}

function HighlightedPreview({ text, query }: { text: string; query: string }) {
  const terms = [...query.matchAll(/"([^"]+)"|([\p{L}\p{N}]+)/gu)].map((match) => match[1] || match[2]).filter(Boolean)
  if (!terms.length) return text
  const expression = new RegExp(`(${terms.map(escapeRegExp).join('|')})`, 'giu')
  return text.split(expression).map((part, index) => terms.some((term) => part.toLocaleLowerCase() === term.toLocaleLowerCase()) ? <mark key={`${part}-${index}`} className="rounded bg-amber-300/25 px-0.5 text-amber-100">{part}</mark> : part)
}

function EmptySearchState({ recentSearches, savedSearches, onRecent, onSaved }: { recentSearches: string[]; savedSearches: SavedGlobalSearch[]; onRecent: (query: string) => void; onSaved: (search: SavedGlobalSearch) => void }) {
  return <div className="mx-auto max-w-2xl"><h2 className="text-lg font-semibold text-slate-200">Search your knowledge library</h2><p className="mt-2 text-sm leading-6 text-slate-500">Find PDF text, highlights, notes, bookmarks, filenames, and metadata. Partial words and minor spelling mistakes are supported.</p>{savedSearches.length ? <><h3 className="mt-6 text-xs font-bold uppercase tracking-wider text-slate-500">Saved</h3><div className="mt-2 flex flex-wrap gap-2">{savedSearches.slice(0, 12).map((search) => <button key={search.id} type="button" onClick={() => onSaved(search)} className="dashboard-button">{search.name}</button>)}</div></> : null}{recentSearches.length ? <><h3 className="mt-6 text-xs font-bold uppercase tracking-wider text-slate-500">Recent</h3><div className="mt-2 flex flex-wrap gap-2">{recentSearches.slice(0, 12).map((query) => <button key={query} type="button" onClick={() => onRecent(query)} className="dashboard-button">{query}</button>)}</div></> : null}</div>
}

function FilterLabel({ children }: { children: ReactNode }) { return <span className="mb-1.5 block text-[10px] font-bold uppercase tracking-wider text-slate-500">{children}</span> }
function dateRange(preset: DatePreset, customStart: string, customEnd: string) { const now = new Date(); const date = (days: number) => { const value = new Date(now); value.setDate(value.getDate() - days); return value.toISOString().slice(0, 10) }; if (preset === 'today') return { dateStart: date(0), dateEnd: date(0) }; if (preset === '7days') return { dateStart: date(7), dateEnd: '' }; if (preset === '30days') return { dateStart: date(30), dateEnd: '' }; if (preset === 'custom') return { dateStart: customStart, dateEnd: customEnd }; return { dateStart: '', dateEnd: '' } }
function escapeRegExp(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : String(error) }
