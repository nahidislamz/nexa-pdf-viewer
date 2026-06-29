import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { HighlightLibraryEntry } from '../../types/highlightLibrary'
import type { CitationStyle, ReferenceDuplicateGroup, ReferenceFilters, ReferenceItem, ReferenceMetadata, ReferenceQueryResponse, ReferenceType } from '../../types/references'

const EMPTY_FILTERS: ReferenceFilters = { author: 'all', year: 'all', publisher: 'all', keyword: 'all', workspaceId: 'all', collectionId: 'all', missingMetadata: false, referenceType: 'all', hasDoi: false, duplicateCandidates: false }
const EMPTY_RESPONSE: ReferenceQueryResponse = { references: [], total: 0, offset: 0, facets: { authors: [], publishers: [], years: [], keywords: [] }, collections: [], workspaces: [], activeWorkspaceId: '', stats: { references: 0, authors: 0, publishers: 0, recent: 0, missingMetadata: 0, filtered: 0, journals: 0, conferences: 0, books: 0, reports: 0, withDoi: 0, duplicateCandidates: 0 }, sourceDocuments: [], mostUsed: [] }
const ROW_HEIGHT = 112
const STYLES: Array<{ id: CitationStyle; label: string }> = [{ id: 'apa', label: 'APA 7' }, { id: 'harvard', label: 'Harvard' }, { id: 'ieee', label: 'IEEE' }, { id: 'mla', label: 'MLA' }, { id: 'chicago', label: 'Chicago' }]
const REFERENCE_TYPES: ReferenceType[] = ['Journal', 'Conference', 'Book', 'Thesis', 'Report', 'Website', 'Unknown']

export function ReferenceDashboard({ onClose, onOpenDocument, onOpenHighlight, onStatusChange }: { onClose: () => void; onOpenDocument: (documentId: string) => void; onOpenHighlight: (entry: HighlightLibraryEntry) => void; onStatusChange: (status: ReferenceQueryResponse['stats']) => void }) {
  const [query, setQuery] = useState('')
  const [filters, setFilters] = useState<ReferenceFilters>(EMPTY_FILTERS)
  const [sort, setSort] = useState<'newest' | 'oldest' | 'title' | 'author'>('newest')
  const [response, setResponse] = useState(EMPTY_RESPONSE)
  const [selected, setSelected] = useState<ReferenceItem | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(600)
  const [revision, setRevision] = useState(0)
  const [duplicates, setDuplicates] = useState<ReferenceDuplicateGroup[] | null>(null)
  const [exportOpen, setExportOpen] = useState(false)
  const [exportStyle, setExportStyle] = useState<CitationStyle>('apa')
  const [exportFormat, setExportFormat] = useState<'text' | 'markdown' | 'docx' | 'bibtex' | 'ris'>('markdown')
  const [collectionName, setCollectionName] = useState('')
  const [manualOpen, setManualOpen] = useState(false)
  const [manualDraft, setManualDraft] = useState<{ title: string; authorsText: string; year: string; doi: string; url: string; journal: string; publisher: string; rawText: string; referenceType: ReferenceType }>({ title: '', authorsText: '', year: '', doi: '', url: '', journal: '', publisher: '', rawText: '', referenceType: 'Unknown' })
  const [rescanningIds, setRescanningIds] = useState<Set<string>>(() => new Set())
  const [bulkCitationStyle, setBulkCitationStyle] = useState<CitationStyle>('apa')
  const [bulkCollectionId, setBulkCollectionId] = useState('')
  const [bulkWorkspaceId, setBulkWorkspaceId] = useState('')
  const [bulkReferenceType, setBulkReferenceType] = useState<ReferenceType>('Journal')
  const viewportRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setLoading(true)
      void window.electronAPI.queryReferences({ query, filters, sort, offset: 0, limit: 250 })
        .then((result) => {
          setResponse(result)
          onStatusChange(result.stats)
          setSelected((current) => current && result.references.some((item) => item.id === current.id) ? result.references.find((item) => item.id === current.id) ?? null : result.references[0] ?? null)
          setError(null)
        })
        .catch((reason) => setError(message(reason)))
        .finally(() => setLoading(false))
    }, 180)
    return () => window.clearTimeout(timeout)
  }, [filters, onStatusChange, query, revision, sort])

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const observer = new ResizeObserver(([entry]) => setViewportHeight(entry.contentRect.height))
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [])

  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - 4)
  const last = Math.min(response.references.length, Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + 4)
  const visible = response.references.slice(first, last)

  async function updateReference(patch: Partial<ReferenceMetadata> & { doiLookupSource?: string; doiLookupAt?: string }) {
    if (!selected) return
    try {
      const next = await window.electronAPI.updateReference(selected.id, patch)
      setSelected(next)
      setRevision((value) => value + 1)
    } catch (reason) { setError(message(reason)) }
  }

  async function createCollection() {
    if (!collectionName.trim()) return
    try {
      await window.electronAPI.createReferenceCollection({ name: collectionName.trim(), color: '#3b82f6' })
      setCollectionName('')
      setRevision((value) => value + 1)
    } catch (reason) { setError(message(reason)) }
  }

  async function renameCollection(id: string, currentName: string) {
    const name = window.prompt('Rename collection', currentName)?.trim()
    if (!name || name === currentName) return
    try {
      await window.electronAPI.updateReferenceCollection(id, { name })
      setRevision((value) => value + 1)
    } catch (reason) { setError(message(reason)) }
  }

  async function deleteCollection(id: string, name: string) {
    if (!window.confirm(`Delete collection "${name}"?\n\nReferences will remain in your library.`)) return
    try {
      await window.electronAPI.deleteReferenceCollection(id)
      setFilters((current) => current.collectionId === id ? { ...current, collectionId: 'all' } : current)
      setRevision((value) => value + 1)
    } catch (reason) { setError(message(reason)) }
  }

  async function updateSelectedCollection(collectionId: string, action: 'add' | 'remove') {
    if (!selectedIds.size) return
    try {
      for (const referenceId of selectedIds) {
        const reference = response.references.find((item) => item.id === referenceId) ?? await window.electronAPI.getReference(referenceId)
        const nextCollectionIds = action === 'add'
          ? [...new Set([...reference.collectionIds, collectionId])]
          : reference.collectionIds.filter((id) => id !== collectionId)
        await window.electronAPI.setReferenceCollections(referenceId, nextCollectionIds)
      }
      setRevision((value) => value + 1)
    } catch (reason) { setError(message(reason)) }
  }

  async function showDuplicates() {
    try { setDuplicates(await window.electronAPI.getReferenceDuplicates()) } catch (reason) { setError(message(reason)) }
  }

  async function exportBibliography() {
    try {
      await window.electronAPI.exportReferences({
        referenceIds: selectedIds.size ? [...selectedIds] : undefined,
        workspaceId: filters.workspaceId === 'all' ? undefined : filters.workspaceId,
        request: selectedIds.size ? undefined : { query, filters, sort },
        style: exportStyle,
        format: exportFormat,
      })
      setExportOpen(false)
    } catch (reason) { setError(message(reason)) }
  }

  async function createManualReference() {
    try {
      await window.electronAPI.createManualReference({
        title: manualDraft.title,
        authors: split(manualDraft.authorsText),
        year: manualDraft.year,
        doi: manualDraft.doi,
        url: manualDraft.url,
        journal: manualDraft.journal,
        publisher: manualDraft.publisher,
        referenceType: manualDraft.referenceType,
        rawText: manualDraft.rawText,
      })
      setManualDraft({ title: '', authorsText: '', year: '', doi: '', url: '', journal: '', publisher: '', rawText: '', referenceType: 'Unknown' })
      setManualOpen(false)
      setRevision((value) => value + 1)
    } catch (reason) { setError(message(reason)) }
  }

  function rescanSourceDocument(documentId: string) {
    setRescanningIds((current) => new Set(current).add(documentId))
    onOpenDocument(documentId)
    window.setTimeout(() => {
      setRescanningIds((current) => {
        const next = new Set(current)
        next.delete(documentId)
        return next
      })
      setRevision((value) => value + 1)
    }, 8000)
  }

  async function removeSourceDocument(documentId: string) {
    try {
      await window.electronAPI.removeReferenceSourceDocument(documentId)
      setRevision((value) => value + 1)
    } catch (reason) { setError(message(reason)) }
  }

  async function selectedReferences() {
    return Promise.all([...selectedIds].map((id) => response.references.find((item) => item.id === id) ?? window.electronAPI.getReference(id)))
  }

  async function deleteSelectedReferences() {
    if (!selectedIds.size || !window.confirm(`Delete ${selectedIds.size} selected reference${selectedIds.size === 1 ? '' : 's'}?\n\nThis cannot be undone.`)) return
    try {
      await window.electronAPI.deleteReferences([...selectedIds])
      setSelectedIds(new Set())
      setSelected(null)
      setRevision((value) => value + 1)
    } catch (reason) { setError(message(reason)) }
  }

  async function copySelectedCitations() {
    if (!selectedIds.size) return
    try {
      const references = await selectedReferences()
      await navigator.clipboard.writeText(references.map((reference) => reference.citations[bulkCitationStyle]).join('\n\n'))
    } catch (reason) { setError(message(reason)) }
  }

  async function addSelectedToWorkspace() {
    if (!selectedIds.size || !bulkWorkspaceId) return
    try {
      for (const referenceId of selectedIds) await window.electronAPI.setWorkspaceReference(bulkWorkspaceId, referenceId, true)
      setRevision((value) => value + 1)
    } catch (reason) { setError(message(reason)) }
  }

  async function changeSelectedReferenceType() {
    if (!selectedIds.size) return
    try {
      for (const referenceId of selectedIds) await window.electronAPI.updateReference(referenceId, { referenceType: bulkReferenceType })
      setRevision((value) => value + 1)
    } catch (reason) { setError(message(reason)) }
  }

  function applySummaryFilter(kind: 'all' | 'authors' | 'journal' | 'conference' | 'book' | 'report' | 'doi' | 'missing' | 'duplicates') {
    setQuery('')
    setSelectedIds(new Set())
    setFilters((current) => ({
      ...current,
      author: 'all',
      year: 'all',
      publisher: 'all',
      keyword: 'all',
      collectionId: kind === 'all' ? 'all' : current.collectionId,
      missingMetadata: kind === 'missing',
      hasDoi: kind === 'doi',
      duplicateCandidates: kind === 'duplicates',
      referenceType:
        kind === 'journal'
          ? 'Journal'
          : kind === 'conference'
            ? 'Conference'
            : kind === 'book'
              ? 'Book'
              : kind === 'report'
                ? 'Report'
                : 'all',
    }))
    if (kind === 'authors') setSort('author')
  }

  return (
    <section className="flex h-[calc(100vh-10rem)] min-h-[580px] flex-col overflow-hidden rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl shadow-black/35">
      <header className="flex flex-wrap items-center gap-3 border-b border-slate-700 bg-gradient-to-r from-slate-950 to-slate-900 px-5 py-4">
        <div className="min-w-48"><p className="text-[10px] font-bold uppercase tracking-[0.2em] text-cyan-300">Academic library</p><h1 className="mt-1 text-xl font-semibold text-white">References</h1></div>
        <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search title, author, DOI, keyword, publisher…" className="h-11 min-w-64 flex-1 rounded-xl border border-slate-600 bg-slate-950 px-4 text-sm text-white outline-none focus:border-cyan-400" />
        <button type="button" onClick={() => setManualOpen(true)} className="workspace-secondary-button">Add Manual Reference</button>
        <button type="button" onClick={() => void showDuplicates()} className="workspace-secondary-button">Duplicates</button>
        <button type="button" onClick={() => setExportOpen(true)} className="workspace-primary-button">Export Bibliography</button>
        <button type="button" onClick={onClose} className="workspace-secondary-button">Close</button>
      </header>
      <ReferenceSummaryBar stats={response.stats} onFilter={applySummaryFilter} />

      <div className="grid min-h-0 flex-1 grid-cols-[230px_minmax(360px,1fr)_minmax(330px,0.9fr)] max-xl:grid-cols-[210px_minmax(340px,1fr)]">
        <aside className="min-h-0 overflow-y-auto border-r border-slate-700 bg-slate-950/45 p-3">
          <SourceDocumentStatus documents={response.sourceDocuments} rescanningIds={rescanningIds} onRescan={rescanSourceDocument} onRemove={(documentId) => void removeSourceDocument(documentId)} />
          {response.mostUsed.length ? <div className="mt-3 rounded-xl border border-slate-700 bg-slate-900/70 p-3"><p className="text-[10px] font-bold uppercase text-slate-500">Most Used Sources</p>{response.mostUsed.map((item) => <p key={item.id} className="mt-2 truncate text-[10px] text-slate-300" title={item.title}>{item.title} <span className="text-slate-600">×{item.usageCount}</span></p>)}</div> : null}
          <CollectionsPanel collections={response.collections} activeCollectionId={filters.collectionId} selectedCount={selectedIds.size} newName={collectionName} onNewName={setCollectionName} onCreate={() => void createCollection()} onSelect={(collectionId) => setFilters((current) => ({ ...current, collectionId }))} onRename={(id, name) => void renameCollection(id, name)} onDelete={(id, name) => void deleteCollection(id, name)} onAddSelected={(id) => void updateSelectedCollection(id, 'add')} onRemoveSelected={(id) => void updateSelectedCollection(id, 'remove')} />
          <Filter label="Workspace" value={filters.workspaceId} values={response.workspaces.map((item) => [item.id, `${item.name} (${item.count})`])} onChange={(value) => setFilters((current) => ({ ...current, workspaceId: value }))} />
          <Filter label="Collection" value={filters.collectionId} values={response.collections.map((item) => [item.id, `${item.name} (${item.count ?? 0})`])} onChange={(value) => setFilters((current) => ({ ...current, collectionId: value }))} />
          <Filter label="Author" value={filters.author} values={response.facets.authors.map((value) => [value, value])} onChange={(value) => setFilters((current) => ({ ...current, author: value }))} />
          <Filter label="Year" value={filters.year} values={response.facets.years.map((value) => [value, value])} onChange={(value) => setFilters((current) => ({ ...current, year: value }))} />
          <Filter label="Publisher" value={filters.publisher} values={response.facets.publishers.map((value) => [value, value])} onChange={(value) => setFilters((current) => ({ ...current, publisher: value }))} />
          <Filter label="Keyword" value={filters.keyword} values={response.facets.keywords.map((value) => [value, value])} onChange={(value) => setFilters((current) => ({ ...current, keyword: value }))} />
          <label className="mt-3 flex cursor-pointer items-center gap-2 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs font-semibold text-slate-300"><input type="checkbox" checked={filters.missingMetadata} onChange={(event) => setFilters((current) => ({ ...current, missingMetadata: event.target.checked }))} />Missing Metadata</label>
          <label className="mt-3 block text-[10px] font-bold uppercase tracking-wide text-slate-500">Sort<select value={sort} onChange={(event) => setSort(event.target.value as typeof sort)} className="dashboard-input mt-1"><option value="newest">Newest</option><option value="oldest">Oldest</option><option value="title">Title</option><option value="author">Author</option></select></label>
        </aside>

        <div className="flex min-h-0 flex-col border-r border-slate-700 bg-[#0f172a]">
          <div className="flex h-11 items-center gap-3 border-b border-slate-700 px-4 text-xs text-slate-400"><strong className="text-slate-200">{response.total.toLocaleString()} references</strong>{loading ? <span>Searching…</span> : null}<span className="ml-auto">Showing first {response.references.length}</span></div>
          {selectedIds.size ? <BulkActionBar selectedCount={selectedIds.size} citationStyle={bulkCitationStyle} onCitationStyle={setBulkCitationStyle} collections={response.collections} collectionId={bulkCollectionId} onCollectionId={setBulkCollectionId} workspaces={response.workspaces} workspaceId={bulkWorkspaceId} onWorkspaceId={setBulkWorkspaceId} referenceType={bulkReferenceType} onReferenceType={setBulkReferenceType} onExport={() => setExportOpen(true)} onDelete={() => void deleteSelectedReferences()} onMoveToCollection={() => bulkCollectionId ? void updateSelectedCollection(bulkCollectionId, 'add') : undefined} onAddToWorkspace={() => void addSelectedToWorkspace()} onCopyCitations={() => void copySelectedCitations()} onChangeType={() => void changeSelectedReferenceType()} onClear={() => setSelectedIds(new Set())} /> : null}
          {error ? <p className="m-3 rounded-lg border border-red-500/40 bg-red-950/50 p-3 text-xs text-red-100">{error}</p> : null}
          <div ref={viewportRef} onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)} className="min-h-0 flex-1 overflow-y-auto">
            {!loading && !response.references.length ? <div className="m-4 rounded-xl border border-slate-700 bg-slate-900 p-6 text-center text-sm text-slate-400"><strong className="block text-slate-200">No reference section found.</strong><span className="mt-2 block">You can add references manually.</span></div> : null}
            <div className="relative" style={{ height: response.references.length * ROW_HEIGHT }}>
              {visible.map((reference, offset) => <ReferenceCardRow key={reference.id} reference={reference} selected={selected?.id === reference.id} checked={selectedIds.has(reference.id)} top={(first + offset) * ROW_HEIGHT} onSelect={() => setSelected(reference)} onCheck={() => setSelectedIds((current) => toggle(current, reference.id))} />)}
            </div>
          </div>
        </div>

        <aside className="min-h-0 overflow-y-auto bg-slate-950/35 p-4 max-xl:hidden">
          {selected ? <ReferenceDetails key={`${selected.id}:${selected.updatedAt}`} reference={selected} workspaces={response.workspaces} collections={response.collections} onOpen={() => { if (selected.extractionSource === 'manual') return; void window.electronAPI.touchReference(selected.id); onOpenDocument(selected.documentId) }} onOpenHighlight={onOpenHighlight} onUpdate={updateReference} onRefresh={() => setRevision((value) => value + 1)} /> : <p className="p-8 text-center text-sm text-slate-500">Select a reference.</p>}
        </aside>
      </div>

      {exportOpen ? <Modal title="Export Bibliography" onClose={() => setExportOpen(false)}><label className="reference-label">Citation style<select value={exportStyle} onChange={(event) => setExportStyle(event.target.value as CitationStyle)} className="dashboard-input mt-1">{STYLES.map((style) => <option key={style.id} value={style.id}>{style.label}</option>)}</select></label><label className="reference-label mt-3">Format<select value={exportFormat} onChange={(event) => setExportFormat(event.target.value as typeof exportFormat)} className="dashboard-input mt-1"><option value="markdown">Markdown</option><option value="text">Plain Text</option><option value="docx">Word</option><option value="bibtex">BibTeX</option><option value="ris">RIS</option></select></label><p className="mt-3 text-xs text-slate-500">{selectedIds.size ? `${selectedIds.size} selected references` : filters.workspaceId !== 'all' ? 'All references in current workspace filter' : `${response.references.length} filtered references`}</p><button type="button" disabled={!selectedIds.size && !response.references.length} onClick={() => void exportBibliography()} className="workspace-primary-button mt-5 w-full disabled:cursor-not-allowed disabled:opacity-50">Choose Save Location</button></Modal> : null}
      {manualOpen ? <Modal title="Add Manual Reference" onClose={() => setManualOpen(false)}><div className="grid gap-2"><Edit label="Title" value={manualDraft.title} onChange={(title) => setManualDraft((current) => ({ ...current, title }))} /><Edit label="Authors" value={manualDraft.authorsText} onChange={(authorsText) => setManualDraft((current) => ({ ...current, authorsText }))} /><div className="grid grid-cols-2 gap-2"><Edit label="Year" value={manualDraft.year} onChange={(year) => setManualDraft((current) => ({ ...current, year }))} /><Edit label="DOI" value={manualDraft.doi} onChange={(doi) => setManualDraft((current) => ({ ...current, doi }))} /></div><Edit label="URL" value={manualDraft.url} onChange={(url) => setManualDraft((current) => ({ ...current, url }))} /><Edit label="Journal / Conference" value={manualDraft.journal} onChange={(journal) => setManualDraft((current) => ({ ...current, journal }))} /><Edit label="Publisher" value={manualDraft.publisher} onChange={(publisher) => setManualDraft((current) => ({ ...current, publisher }))} /><label className="reference-label">Raw text<textarea value={manualDraft.rawText} onChange={(event) => setManualDraft((current) => ({ ...current, rawText: event.target.value }))} className="dashboard-input mt-1 min-h-24 resize-y" /></label><button type="button" disabled={!manualDraft.title.trim() && !manualDraft.rawText.trim()} onClick={() => void createManualReference()} className="workspace-primary-button mt-3 disabled:cursor-not-allowed disabled:opacity-50">Save Manual Reference</button></div></Modal> : null}
      {duplicates ? <DuplicateModal groups={duplicates} onClose={() => setDuplicates(null)} onChanged={() => { setDuplicates(null); setRevision((value) => value + 1) }} /> : null}
    </section>
  )
}

function ReferenceRow({ reference, selected, checked, top, onSelect, onCheck }: { reference: ReferenceItem; selected: boolean; checked: boolean; top: number; onSelect: () => void; onCheck: () => void }) {
  return <article style={{ top, height: ROW_HEIGHT }} className={`absolute inset-x-2 rounded-xl border p-3 transition-colors ${selected ? 'border-cyan-400 bg-cyan-500/10' : 'border-transparent hover:border-slate-700 hover:bg-slate-900'}`}><div className="flex gap-3"><input type="checkbox" checked={checked} onChange={onCheck} aria-label={`Select ${reference.title}`} /><button type="button" onClick={onSelect} className="min-w-0 flex-1 text-left"><h3 className="truncate text-sm font-semibold text-slate-100">{reference.title || reference.documentName}</h3><p className="mt-1 truncate text-xs text-slate-400">{reference.authors.join(', ') || 'Unknown author'}{reference.year ? ` · ${reference.year}` : ''}</p><p className="mt-2 flex gap-2 truncate text-[10px] text-slate-500"><span>{reference.journal || reference.publisher || 'PDF reference'}</span>{reference.doi ? <span className="text-cyan-300">DOI {reference.doi}</span> : null}{reference.missing ? <span className="text-red-300">Missing file</span> : null}</p></button></div></article>
}

function ReferenceDetails({ reference, workspaces, collections, onOpen, onOpenHighlight, onUpdate, onRefresh }: { reference: ReferenceItem; workspaces: ReferenceQueryResponse['workspaces']; collections: ReferenceQueryResponse['collections']; onOpen: () => void; onOpenHighlight: (entry: HighlightLibraryEntry) => void; onUpdate: (patch: Partial<ReferenceMetadata> & { doiLookupSource?: string; doiLookupAt?: string }) => Promise<void>; onRefresh: () => void }) {
  const [draft, setDraft] = useState(() => toDraft(reference))
  const [lookupBusy, setLookupBusy] = useState(false)
  const [lookupMessage, setLookupMessage] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<'metadata' | 'citations' | 'highlights' | 'notes' | 'collections'>('metadata')
  const [relatedHighlights, setRelatedHighlights] = useState<HighlightLibraryEntry[]>([])
  const [highlightError, setHighlightError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.electronAPI.getHighlightLibrary()
      .then((library) => {
        if (cancelled) return
        const documentId = reference.sourceDocumentId || reference.documentId
        setHighlightError(null)
        setRelatedHighlights(library.entries.filter((entry) => entry.documentId === documentId))
      })
      .catch((reason) => {
        if (!cancelled) setHighlightError(message(reason))
      })
    return () => { cancelled = true }
  }, [reference.documentId, reference.sourceDocumentId])

  async function save() { await onUpdate({ ...draft, authors: split(draft.authorsText), keywords: split(draft.keywordsText) }); onRefresh() }
  async function updateHighlightNote(entry: HighlightLibraryEntry, note: string) {
    try {
      const library = await window.electronAPI.updateHighlightLibrary([{ documentKey: entry.documentKey, highlightId: entry.highlightId, patch: { note } }])
      const documentId = reference.sourceDocumentId || reference.documentId
      setRelatedHighlights(library.entries.filter((candidate) => candidate.documentId === documentId))
    } catch (reason) {
      setHighlightError(message(reason))
    }
  }
  async function lookupDoi() {
    const normalizedDoi = draft.doi.trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '')
    if (!/^10\.\d{4,9}\/[-._;()/:A-Z0-9]+$/i.test(normalizedDoi)) {
      setLookupMessage('Invalid DOI format.')
      return
    }
    setLookupBusy(true)
    setLookupMessage(null)
    try {
      const result = await window.electronAPI.lookupDoi(normalizedDoi)
      const incoming = result.metadata
      const next: Partial<ReferenceMetadata> & { doiLookupSource?: string; doiLookupAt?: string } = {}
      const conflicts: string[] = []
      for (const field of ['title', 'year', 'journal', 'publisher', 'volume', 'issue', 'pages', 'url', 'referenceType'] as const) {
        const value = incoming[field]
        if (!value) continue
        const currentValue = String(draft[field] ?? '').trim()
        if (!currentValue) next[field] = value as never
        else if (currentValue !== String(value).trim()) conflicts.push(field)
      }
      if (incoming.doi && !draft.doi.trim()) next.doi = incoming.doi
      if (incoming.authors?.length) {
        if (!draft.authorsText.trim()) next.authors = incoming.authors
        else if (draft.authorsText !== incoming.authors.join('; ')) conflicts.push('authors')
      }
      if (conflicts.length && window.confirm(`DOI metadata differs from existing fields: ${conflicts.join(', ')}.\n\nOverwrite these fields?`)) {
        for (const field of conflicts) {
          if (field === 'authors') next.authors = incoming.authors
          else next[field as keyof ReferenceMetadata] = incoming[field as keyof ReferenceMetadata] as never
        }
      }
      next.doiLookupSource = result.source
      next.doiLookupAt = result.lookedUpAt
      await onUpdate(next)
      setDraft((current) => ({
        ...current,
        title: String(next.title ?? current.title),
        authorsText: next.authors ? next.authors.join('; ') : current.authorsText,
        year: String(next.year ?? current.year),
        doi: String(next.doi ?? incoming.doi ?? current.doi),
        url: String(next.url ?? current.url),
        journal: String(next.journal ?? current.journal),
        publisher: String(next.publisher ?? current.publisher),
        referenceType: (next.referenceType as ReferenceType) ?? current.referenceType,
      }))
      setLookupMessage('Metadata updated from DOI.')
      onRefresh()
    } catch (reason) {
      setLookupMessage(message(reason))
    } finally {
      setLookupBusy(false)
    }
  }
  const noteEntries = relatedHighlights.filter((entry) => entry.note.trim())
  const tabs: Array<{ id: typeof activeTab; label: string }> = [
    { id: 'metadata', label: 'Metadata' },
    { id: 'citations', label: 'Citations' },
    { id: 'highlights', label: `Highlights (${relatedHighlights.length})` },
    { id: 'notes', label: `Notes (${noteEntries.length})` },
    { id: 'collections', label: 'Collections' },
  ]
  return <div><div className="flex items-start gap-3"><div className="grid size-11 shrink-0 place-items-center rounded-xl bg-cyan-500/15 text-cyan-300">Ref</div><div className="min-w-0 flex-1"><h2 className="text-lg font-semibold text-white">Reference Details</h2><p className="truncate text-[10px] text-slate-500" title={reference.filePath}>{reference.documentName}</p></div><button type="button" disabled={reference.missing} onClick={onOpen} className="workspace-primary-button">Open PDF</button></div>
    <div className="mt-4 flex gap-1 overflow-x-auto rounded-xl border border-slate-700 bg-slate-950/70 p-1">{tabs.map((tab) => <button key={tab.id} type="button" onClick={() => setActiveTab(tab.id)} className={`shrink-0 rounded-lg px-3 py-2 text-xs font-semibold transition-colors ${activeTab === tab.id ? 'bg-cyan-500/15 text-cyan-100 ring-1 ring-cyan-400/40' : 'text-slate-400 hover:bg-slate-800 hover:text-slate-100'}`}>{tab.label}</button>)}</div>
    {activeTab === 'metadata' ? <section className="mt-4"><section className="rounded-xl border border-slate-700 bg-slate-900 p-3"><div className="flex items-center justify-between"><span className="text-xs font-bold uppercase tracking-wide text-slate-500">Citation Quality</span><QualityBadge label={reference.qualityLabel} score={reference.qualityScore} /></div><p className="mt-2 text-xs text-slate-400">Score {reference.qualityScore} of 5</p>{reference.missingFields.length ? <div className="mt-3"><p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Missing</p><div className="mt-2 flex flex-wrap gap-2">{reference.missingFields.map((field) => <span key={field} className="rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-1 text-[10px] font-semibold text-amber-200">{field}</span>)}</div></div> : <p className="mt-2 text-xs text-emerald-300">No missing metadata.</p>}</section><div className="mt-4 grid gap-2"><Edit label="Title" value={draft.title} onChange={(title) => setDraft((current) => ({ ...current, title }))} /><Edit label="Authors" value={draft.authorsText} onChange={(authorsText) => setDraft((current) => ({ ...current, authorsText }))} /><div className="grid grid-cols-2 gap-2"><Edit label="Year" value={draft.year} onChange={(year) => setDraft((current) => ({ ...current, year }))} /><label className="reference-label">DOI<div className="mt-1 flex gap-2"><input value={draft.doi} onChange={(event) => setDraft((current) => ({ ...current, doi: event.target.value }))} className="dashboard-input min-w-0" /><button type="button" disabled={lookupBusy || !draft.doi.trim()} onClick={() => void lookupDoi()} className="workspace-secondary-button shrink-0 disabled:cursor-not-allowed disabled:opacity-50">{lookupBusy ? 'Looking...' : 'Lookup DOI'}</button></div></label></div>{lookupMessage ? <p className={`rounded-lg border px-3 py-2 text-xs ${lookupMessage === 'Metadata updated from DOI.' ? 'border-emerald-500/40 bg-emerald-950/40 text-emerald-200' : 'border-red-500/40 bg-red-950/40 text-red-200'}`}>{lookupMessage}</p> : null}{reference.doiLookupAt ? <p className="text-[10px] text-slate-500">Last DOI lookup: {new Date(reference.doiLookupAt).toLocaleString()} via {reference.doiLookupSource || 'DOI metadata service'}</p> : null}<Edit label="URL" value={draft.url} onChange={(url) => setDraft((current) => ({ ...current, url }))} /><ReferenceTypeSelect value={draft.referenceType} onChange={(referenceType) => setDraft((current) => ({ ...current, referenceType }))} /><Edit label="Journal / Conference" value={draft.journal} onChange={(journal) => setDraft((current) => ({ ...current, journal }))} /><Edit label="Publisher" value={draft.publisher} onChange={(publisher) => setDraft((current) => ({ ...current, publisher }))} /><Edit label="ISBN" value={draft.isbn} onChange={(isbn) => setDraft((current) => ({ ...current, isbn }))} /><Edit label="Keywords" value={draft.keywordsText} onChange={(keywordsText) => setDraft((current) => ({ ...current, keywordsText }))} /><button type="button" onClick={() => void save()} className="workspace-primary-button mt-1">Save Metadata Overrides</button></div><div className="mt-5 grid grid-cols-3 gap-2"><Mini label="Highlights" value={reference.highlightCount} /><Mini label="Notes" value={reference.noteCount} /><Mini label="Used" value={reference.usageCount} /></div></section> : null}
    {activeTab === 'citations' ? <section className="mt-4"><h3 className="text-xs font-bold uppercase tracking-wide text-slate-500">Citations</h3><div className="mt-2 space-y-2">{STYLES.map((style) => <div key={style.id} className="rounded-xl border border-slate-700 bg-slate-900 p-3"><div className="flex items-center justify-between"><strong className="text-[10px] text-cyan-300">{style.label}</strong><button type="button" onClick={() => void navigator.clipboard.writeText(reference.citations[style.id])} className="text-[10px] text-slate-400 hover:text-white">Copy</button></div><p className="mt-1 text-xs leading-5 text-slate-300">{reference.citations[style.id]}</p></div>)}</div></section> : null}
    {activeTab === 'highlights' ? <HighlightList entries={relatedHighlights} error={highlightError} empty="No highlights found for this source PDF." onOpen={onOpenHighlight} /> : null}
    {activeTab === 'notes' ? <NotesList entries={noteEntries} error={highlightError} onOpen={onOpenHighlight} onSaveNote={(entry, note) => void updateHighlightNote(entry, note)} /> : null}
    {activeTab === 'collections' ? <section className="mt-4 space-y-5"><section><h3 className="text-xs font-bold uppercase tracking-wide text-slate-500">Collections</h3><div className="mt-2 flex flex-wrap gap-2">{collections.length ? collections.map((collection) => <label key={collection.id} className="flex cursor-pointer items-center gap-1 rounded-lg border border-slate-700 px-2 py-1 text-[10px] text-slate-300 hover:border-cyan-400/50"><input type="checkbox" checked={reference.collectionIds.includes(collection.id)} onChange={(event) => void window.electronAPI.setReferenceCollections(reference.id, event.target.checked ? [...reference.collectionIds, collection.id] : reference.collectionIds.filter((id) => id !== collection.id)).then(onRefresh)} />{collection.name}</label>) : <p className="text-xs text-slate-500">No collections yet.</p>}</div></section><section className="border-t border-slate-700 pt-4"><h3 className="text-xs font-bold uppercase tracking-wide text-slate-500">Workspaces</h3><div className="mt-2 space-y-1">{workspaces.map((workspace) => <label key={workspace.id} className="flex cursor-pointer items-center gap-2 text-xs text-slate-300"><input type="checkbox" checked={reference.workspaceIds.includes(workspace.id)} onChange={(event) => void window.electronAPI.setWorkspaceReference(workspace.id, reference.id, event.target.checked).then(onRefresh)} />{workspace.name}</label>)}</div></section></section> : null}
  </div>
}

function HighlightList({ entries, error, empty, onOpen }: { entries: HighlightLibraryEntry[]; error: string | null; empty: string; onOpen: (entry: HighlightLibraryEntry) => void }) {
  if (error) return <p className="mt-4 rounded-lg border border-red-500/40 bg-red-950/40 p-3 text-xs text-red-100">{error}</p>
  if (!entries.length) return <p className="mt-4 rounded-xl border border-dashed border-slate-700 p-4 text-center text-xs text-slate-500">{empty}</p>
  return <div className="mt-4 space-y-2">{entries.map((entry) => <button key={entry.key} type="button" onClick={() => onOpen(entry)} className="w-full rounded-xl border border-slate-700 bg-slate-900 p-3 text-left transition-colors hover:border-cyan-400/70 hover:bg-slate-800/80"><div className="flex items-center justify-between gap-2"><span className="text-[10px] font-bold uppercase text-cyan-300">Page {entry.pageNumber}</span><span className="text-[10px] capitalize text-slate-500">{entry.category}</span></div><p className="mt-2 max-h-16 overflow-hidden text-xs leading-5 text-slate-300">{entry.text}</p>{entry.note ? <p className="mt-2 rounded-lg bg-slate-950/70 p-2 text-xs leading-5 text-amber-100">Note: {entry.note}</p> : null}</button>)}</div>
}

function NotesList({ entries, error, onOpen, onSaveNote }: { entries: HighlightLibraryEntry[]; error: string | null; onOpen: (entry: HighlightLibraryEntry) => void; onSaveNote: (entry: HighlightLibraryEntry, note: string) => void }) {
  if (error) return <p className="mt-4 rounded-lg border border-red-500/40 bg-red-950/40 p-3 text-xs text-red-100">{error}</p>
  if (!entries.length) return <p className="mt-4 rounded-xl border border-dashed border-slate-700 p-4 text-center text-xs text-slate-500">No notes found for this source PDF.</p>
  return <div className="mt-4 space-y-3">{entries.map((entry) => <NoteEditor key={`${entry.key}:${entry.modifiedDate}:${entry.note}`} entry={entry} onOpen={onOpen} onSaveNote={onSaveNote} />)}</div>
}

function NoteEditor({ entry, onOpen, onSaveNote }: { entry: HighlightLibraryEntry; onOpen: (entry: HighlightLibraryEntry) => void; onSaveNote: (entry: HighlightLibraryEntry, note: string) => void }) {
  const [note, setNote] = useState(entry.note)
  function saveNote() {
    if (note !== entry.note) onSaveNote(entry, note)
  }
  return <article className="rounded-xl border border-slate-700 bg-slate-900 p-3"><div className="flex items-center justify-between gap-2"><button type="button" onClick={() => onOpen(entry)} className="text-[10px] font-bold uppercase text-cyan-300 hover:text-cyan-100">Page {entry.pageNumber}</button><span className="text-[10px] text-slate-500">{new Date(entry.modifiedDate || entry.createdDate).toLocaleString()}</span></div><p className="mt-2 max-h-14 overflow-hidden text-xs leading-5 text-slate-400">{entry.text}</p><textarea value={note} onChange={(event) => setNote(event.target.value)} onBlur={saveNote} onKeyDown={(event) => { if (event.key === 'Enter' && event.ctrlKey) event.currentTarget.blur() }} className="dashboard-input mt-3 min-h-24 resize-y" placeholder="Add a note for this highlight" /></article>
}

function DuplicateModal({ groups, onClose, onChanged }: { groups: ReferenceDuplicateGroup[]; onClose: () => void; onChanged: () => void }) { return <Modal title={`Potential Duplicates (${groups.length})`} onClose={onClose}><div className="max-h-[60vh] space-y-3 overflow-y-auto">{groups.length ? groups.map((group) => <div key={group.key} className="rounded-xl border border-slate-700 p-3"><p className="text-[10px] text-slate-500">Matched by {group.key.split(':')[0].toUpperCase()}</p>{group.references.map((reference) => <p key={reference.id} className="mt-1 text-xs text-slate-200">{reference.title} · {reference.authors[0] || 'Unknown'}</p>)}<div className="mt-3 flex gap-2"><button type="button" onClick={() => void window.electronAPI.mergeReferences(group.referenceIds[0], group.referenceIds.slice(1)).then(onChanged)} className="workspace-primary-button">Merge</button><button type="button" onClick={() => void window.electronAPI.keepReferencesSeparate(group.referenceIds).then(onChanged)} className="workspace-secondary-button">Keep Separate</button></div></div>) : <p className="p-8 text-center text-sm text-slate-500">No duplicates detected.</p>}</div></Modal> }
function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) { return <div className="fixed inset-0 z-[100] grid place-items-center bg-slate-950/80 p-5 backdrop-blur-sm"><div className="w-full max-w-xl rounded-2xl border border-slate-600 bg-slate-900 p-5 shadow-2xl"><div className="mb-4 flex items-center justify-between"><h2 className="text-lg font-semibold text-white">{title}</h2><button type="button" onClick={onClose} className="grid size-8 place-items-center rounded-lg text-xl text-slate-400 hover:bg-slate-800">×</button></div>{children}</div></div> }
function Filter({ label, value, values, onChange }: { label: string; value: string; values: string[][]; onChange: (value: string) => void }) { return <label className="mt-3 block text-[10px] font-bold uppercase tracking-wide text-slate-500">{label}<select value={value} onChange={(event) => onChange(event.target.value)} className="dashboard-input mt-1"><option value="all">All</option>{values.slice(0, 1000).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label> }
function ReferenceSummaryBar({ stats, onFilter }: { stats: ReferenceQueryResponse['stats']; onFilter: (kind: 'all' | 'authors' | 'journal' | 'conference' | 'book' | 'report' | 'doi' | 'missing' | 'duplicates') => void }) {
  const items: Array<{ key: Parameters<typeof onFilter>[0]; label: string; value: number | undefined; tone?: string }> = [
    { key: 'all', label: 'Total references', value: stats.references },
    { key: 'authors', label: 'Authors', value: stats.authors },
    { key: 'journal', label: 'Journals', value: stats.journals },
    { key: 'conference', label: 'Conferences', value: stats.conferences },
    { key: 'book', label: 'Books', value: stats.books },
    { key: 'report', label: 'Reports', value: stats.reports },
    { key: 'doi', label: 'With DOI', value: stats.withDoi },
    { key: 'missing', label: 'Missing metadata', value: stats.missingMetadata, tone: 'text-amber-200' },
    { key: 'duplicates', label: 'Duplicate candidates', value: stats.duplicateCandidates, tone: 'text-red-200' },
  ]
  return <div className="border-b border-slate-700 bg-slate-950/55 px-4 py-2"><div className="grid grid-cols-3 gap-2 sm:grid-cols-5 xl:grid-cols-9">{items.map((item) => <button key={item.key} type="button" onClick={() => onFilter(item.key)} className="min-w-0 rounded-lg border border-slate-700 bg-slate-900/80 px-3 py-2 text-left transition-colors hover:border-cyan-400/60 hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-cyan-400/40"><strong className={`block text-sm leading-none text-white ${item.tone ?? ''}`}>{Number(item.value ?? 0).toLocaleString()}</strong><span className="mt-1 block truncate text-[10px] font-bold uppercase tracking-wide text-slate-500" title={item.label}>{item.label}</span></button>)}</div></div>
}
function SourceDocumentStatus({ documents, rescanningIds, onRescan, onRemove }: { documents: ReferenceQueryResponse['sourceDocuments']; rescanningIds: Set<string>; onRescan: (documentId: string) => void; onRemove: (documentId: string) => void }) {
  if (!documents.length) return null
  return <section className="mt-3 rounded-xl border border-slate-700 bg-slate-900/70 p-3"><p className="text-[10px] font-bold uppercase text-slate-500">Scanned Documents</p>{documents.slice(0, 8).map((document) => {
    const scanning = rescanningIds.has(document.documentId)
    const status = sourceDocumentStatus(document, scanning)
    return <div key={document.documentId} className="mt-2 rounded-lg border border-slate-800 bg-slate-950/50 p-2"><div className="flex min-w-0 items-start gap-2"><span className={`mt-1 size-2 shrink-0 rounded-full ${status.dot}`} /><div className="min-w-0 flex-1"><p className="truncate text-[11px] font-semibold text-slate-200" title={document.fileName}>{document.fileName}</p><p className={`mt-1 text-[10px] font-semibold ${status.textClass}`}>{status.label}</p><p className="mt-1 text-[10px] text-slate-500">{document.extractedReferenceIds.length} extracted reference{document.extractedReferenceIds.length === 1 ? '' : 's'}</p><p className="mt-1 text-[10px] text-slate-600">{document.checkedAt ? `Last scanned ${new Date(document.checkedAt).toLocaleString()}` : 'Not scanned yet'}</p></div></div><div className="mt-2 flex gap-2"><button type="button" disabled={scanning} onClick={() => onRescan(document.documentId)} className="rounded-md border border-slate-700 px-2 py-1 text-[10px] font-semibold text-slate-300 hover:border-cyan-400 hover:text-cyan-200 disabled:cursor-not-allowed disabled:opacity-50">{scanning ? 'Scanning...' : 'Rescan'}</button><button type="button" onClick={() => onRemove(document.documentId)} className="rounded-md border border-slate-700 px-2 py-1 text-[10px] font-semibold text-slate-400 hover:border-red-400 hover:text-red-200">Remove</button></div></div>
  })}</section>
}
function CollectionsPanel({ collections, activeCollectionId, selectedCount, newName, onNewName, onCreate, onSelect, onRename, onDelete, onAddSelected, onRemoveSelected }: { collections: ReferenceQueryResponse['collections']; activeCollectionId: string; selectedCount: number; newName: string; onNewName: (value: string) => void; onCreate: () => void; onSelect: (collectionId: string) => void; onRename: (id: string, name: string) => void; onDelete: (id: string, name: string) => void; onAddSelected: (id: string) => void; onRemoveSelected: (id: string) => void }) {
  return <section className="mt-3 rounded-xl border border-slate-700 bg-slate-900/70 p-3"><div className="flex items-center justify-between"><p className="text-[10px] font-bold uppercase text-slate-500">Collections</p><button type="button" onClick={() => onSelect('all')} className={`text-[10px] font-semibold ${activeCollectionId === 'all' ? 'text-cyan-300' : 'text-slate-500 hover:text-slate-200'}`}>All</button></div><div className="mt-2 flex gap-1"><input value={newName} onChange={(event) => onNewName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') onCreate() }} className="dashboard-input min-w-0" placeholder="New collection" /><button type="button" onClick={onCreate} className="workspace-primary-button">+</button></div><div className="mt-3 space-y-2">{collections.length ? collections.map((collection) => <div key={collection.id} className={`rounded-lg border p-2 transition-colors ${activeCollectionId === collection.id ? 'border-cyan-400 bg-cyan-500/10' : 'border-slate-800 bg-slate-950/50 hover:border-slate-700'}`}><button type="button" onClick={() => onSelect(collection.id)} className="flex w-full min-w-0 items-center justify-between gap-2 text-left"><span className="truncate text-xs font-semibold text-slate-200" title={collection.name}>{collection.name}</span><span className="rounded-full bg-slate-800 px-2 py-0.5 text-[10px] font-bold text-slate-300">{collection.count ?? 0}</span></button><div className="mt-2 flex flex-wrap gap-1"><button type="button" disabled={!selectedCount} onClick={() => onAddSelected(collection.id)} className="rounded-md border border-slate-700 px-2 py-1 text-[10px] font-semibold text-slate-300 hover:border-cyan-400 hover:text-cyan-200 disabled:cursor-not-allowed disabled:opacity-40">Add selected</button><button type="button" disabled={!selectedCount} onClick={() => onRemoveSelected(collection.id)} className="rounded-md border border-slate-700 px-2 py-1 text-[10px] font-semibold text-slate-400 hover:border-amber-400 hover:text-amber-200 disabled:cursor-not-allowed disabled:opacity-40">Remove</button><button type="button" onClick={() => onRename(collection.id, collection.name)} className="rounded-md border border-slate-700 px-2 py-1 text-[10px] font-semibold text-slate-400 hover:border-slate-500 hover:text-slate-100">Rename</button><button type="button" onClick={() => onDelete(collection.id, collection.name)} className="rounded-md border border-slate-700 px-2 py-1 text-[10px] font-semibold text-slate-400 hover:border-red-400 hover:text-red-200">Delete</button></div></div>) : <p className="rounded-lg border border-dashed border-slate-700 p-3 text-center text-[10px] text-slate-500">No collections yet.</p>}</div>{selectedCount ? <p className="mt-2 text-[10px] text-cyan-300">{selectedCount} selected reference{selectedCount === 1 ? '' : 's'}</p> : null}</section>
}
function BulkActionBar({ selectedCount, citationStyle, onCitationStyle, collections, collectionId, onCollectionId, workspaces, workspaceId, onWorkspaceId, referenceType, onReferenceType, onExport, onDelete, onMoveToCollection, onAddToWorkspace, onCopyCitations, onChangeType, onClear }: { selectedCount: number; citationStyle: CitationStyle; onCitationStyle: (value: CitationStyle) => void; collections: ReferenceQueryResponse['collections']; collectionId: string; onCollectionId: (value: string) => void; workspaces: ReferenceQueryResponse['workspaces']; workspaceId: string; onWorkspaceId: (value: string) => void; referenceType: ReferenceType; onReferenceType: (value: ReferenceType) => void; onExport: () => void; onDelete: () => void; onMoveToCollection: () => void; onAddToWorkspace: () => void; onCopyCitations: () => void; onChangeType: () => void; onClear: () => void }) {
  return <div className="border-b border-cyan-500/30 bg-cyan-950/25 px-4 py-3"><div className="flex flex-wrap items-center gap-2 text-xs"><strong className="mr-2 text-cyan-100">{selectedCount} selected</strong><button type="button" onClick={onExport} className="workspace-primary-button">Export</button><button type="button" onClick={onDelete} className="workspace-secondary-button border-red-500/40 text-red-200 hover:border-red-400">Delete</button><select value={collectionId} onChange={(event) => onCollectionId(event.target.value)} className="dashboard-input h-9 w-40"><option value="">Collection...</option>{collections.map((collection) => <option key={collection.id} value={collection.id}>{collection.name}</option>)}</select><button type="button" disabled={!collectionId} onClick={onMoveToCollection} className="workspace-secondary-button disabled:cursor-not-allowed disabled:opacity-40">Move to Collection</button><select value={workspaceId} onChange={(event) => onWorkspaceId(event.target.value)} className="dashboard-input h-9 w-40"><option value="">Workspace...</option>{workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</select><button type="button" disabled={!workspaceId} onClick={onAddToWorkspace} className="workspace-secondary-button disabled:cursor-not-allowed disabled:opacity-40">Add to Workspace</button><select value={citationStyle} onChange={(event) => onCitationStyle(event.target.value as CitationStyle)} className="dashboard-input h-9 w-28">{STYLES.map((style) => <option key={style.id} value={style.id}>{style.label}</option>)}</select><button type="button" onClick={onCopyCitations} className="workspace-secondary-button">Copy Citations</button><select value={referenceType} onChange={(event) => onReferenceType(event.target.value as ReferenceType)} className="dashboard-input h-9 w-32">{REFERENCE_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}</select><button type="button" onClick={onChangeType} className="workspace-secondary-button">Change Type</button><button type="button" onClick={onClear} className="ml-auto text-xs font-semibold text-slate-400 hover:text-white">Clear</button></div></div>
}
function sourceDocumentStatus(document: ReferenceQueryResponse['sourceDocuments'][number], scanning: boolean) {
  if (scanning) return { label: 'Scanning', dot: 'bg-blue-400', textClass: 'text-blue-300' }
  if (document.referenceSectionStatus === 'found') return { label: 'References found', dot: 'bg-emerald-400', textClass: 'text-emerald-300' }
  if (document.referenceSectionStatus === 'error') return { label: 'Scan failed', dot: 'bg-red-400', textClass: 'text-red-300' }
  if (document.referenceSectionStatus === 'not_checked') return { label: 'Not scanned', dot: 'bg-blue-400', textClass: 'text-blue-300' }
  return { label: 'No bibliography detected', dot: 'bg-slate-500', textClass: 'text-slate-400' }
}
function Edit({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) { return <label className="reference-label">{label}<input value={value} onChange={(event) => onChange(event.target.value)} className="dashboard-input mt-1" /></label> }
function ReferenceTypeSelect({ value, onChange }: { value: ReferenceType; onChange: (value: ReferenceType) => void }) { return <label className="reference-label">Reference Type<select value={value} onChange={(event) => onChange(event.target.value as ReferenceType)} className="dashboard-input mt-1">{REFERENCE_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}</select></label> }
function Mini({ label, value }: { label: string; value: number }) { return <div className="rounded-lg bg-slate-900 p-2 text-center"><strong className="block text-sm text-white">{value}</strong><span className="text-[9px] uppercase text-slate-500">{label}</span></div> }
function toDraft(reference: ReferenceItem) { return { title: reference.title, authorsText: reference.authors.join('; '), year: reference.year, doi: reference.doi, url: reference.url, journal: reference.journal || reference.conference, publisher: reference.publisher, volume: reference.volume, issue: reference.issue, pages: reference.pages, isbn: reference.isbn, keywordsText: reference.keywords.join('; '), referenceType: reference.referenceType } }
function split(value: string) { return [...new Set(value.split(/[;\n]/).map((item) => item.trim()).filter(Boolean))] }
function toggle(set: Set<string>, value: string) { const next = new Set(set); if (next.has(value)) next.delete(value); else next.add(value); return next }
function message(reason: unknown) { return reason instanceof Error ? reason.message : String(reason) }

function ReferenceRowWithType({ reference, selected, checked, top, onSelect, onCheck }: { reference: ReferenceItem; selected: boolean; checked: boolean; top: number; onSelect: () => void; onCheck: () => void }) {
  if (!reference.referenceType) return <ReferenceRow reference={reference} selected={selected} checked={checked} top={top} onSelect={onSelect} onCheck={onCheck} />
  return <article style={{ top, height: ROW_HEIGHT }} className={`absolute inset-x-2 rounded-xl border p-3 transition-colors ${selected ? 'border-cyan-400 bg-cyan-500/10' : 'border-transparent hover:border-slate-700 hover:bg-slate-900'}`}><div className="flex gap-3"><input type="checkbox" checked={checked} onChange={onCheck} aria-label={`Select ${reference.title}`} /><button type="button" onClick={onSelect} className="min-w-0 flex-1 text-left"><div className="flex min-w-0 items-center gap-2"><h3 className="truncate text-sm font-semibold text-slate-100">{reference.title || reference.documentName}</h3><ReferenceTypeBadge type={reference.referenceType} /><QualityBadge label={reference.qualityLabel} score={reference.qualityScore} /></div><p className="mt-1 truncate text-xs text-slate-400">{reference.authors.join(', ') || 'Unknown author'}{reference.year ? ` · ${reference.year}` : ''}</p><p className="mt-2 flex gap-2 truncate text-[10px] text-slate-500"><span>{reference.journal || reference.publisher || 'PDF reference'}</span>{reference.doi ? <span className="text-cyan-300">DOI {reference.doi}</span> : null}{reference.missing ? <span className="text-red-300">Missing file</span> : null}</p></button></div></article>
}

function ReferenceTypeBadge({ type }: { type: ReferenceType }) {
  return <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide ${typeBadgeClass(type)}`}>{type}</span>
}

function QualityBadge({ label, score }: { label: ReferenceItem['qualityLabel']; score: number }) {
  return <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide ${qualityBadgeClass(label)}`}>{label} {score}/5</span>
}

function qualityBadgeClass(label: ReferenceItem['qualityLabel']) {
  if (label === 'Complete') return 'border-emerald-400/40 bg-emerald-400/10 text-emerald-200'
  if (label === 'Good') return 'border-sky-400/40 bg-sky-400/10 text-sky-200'
  if (label === 'Incomplete') return 'border-amber-400/40 bg-amber-400/10 text-amber-200'
  return 'border-red-400/40 bg-red-400/10 text-red-200'
}

function typeBadgeClass(type: ReferenceType) {
  if (type === 'Journal') return 'border-emerald-400/40 bg-emerald-400/10 text-emerald-200'
  if (type === 'Conference') return 'border-sky-400/40 bg-sky-400/10 text-sky-200'
  if (type === 'Book') return 'border-amber-400/40 bg-amber-400/10 text-amber-200'
  if (type === 'Thesis') return 'border-purple-400/40 bg-purple-400/10 text-purple-200'
  if (type === 'Report') return 'border-orange-400/40 bg-orange-400/10 text-orange-200'
  if (type === 'Website') return 'border-cyan-400/40 bg-cyan-400/10 text-cyan-200'
  return 'border-slate-500/40 bg-slate-500/10 text-slate-300'
}

function ReferenceCardRow({ reference, selected, checked, top, onSelect, onCheck }: { reference: ReferenceItem; selected: boolean; checked: boolean; top: number; onSelect: () => void; onCheck: () => void }) {
  if (!reference.referenceType) return <ReferenceRowWithType reference={reference} selected={selected} checked={checked} top={top} onSelect={onSelect} onCheck={onCheck} />
  const title = reference.title || reference.documentName
  return <article style={{ top, height: ROW_HEIGHT }} className={`absolute inset-x-2 rounded-xl border p-3 transition-colors ${selected ? 'border-cyan-400 bg-cyan-500/15 shadow-lg shadow-cyan-950/40' : 'border-transparent hover:border-slate-700 hover:bg-slate-900'}`}><div className="flex gap-3"><input type="checkbox" checked={checked} onChange={onCheck} aria-label={`Select ${title}`} className="mt-1" /><button type="button" onClick={onSelect} className="min-w-0 flex-1 text-left"><div className="flex min-w-0 items-center gap-2"><h3 className="truncate text-sm font-semibold text-slate-100" title={title}>{title}</h3><ReferenceTypeBadge type={reference.referenceType} /></div><p className="mt-1 truncate text-xs text-slate-400">{reference.authors.join(', ') || 'Unknown author'}{reference.year ? ` · ${reference.year}` : ''}</p><div className="mt-2 flex flex-wrap items-center gap-2 text-[10px]"><DoiStatusBadge hasDoi={Boolean(reference.doi)} /><MetricBadge label="Highlights" value={reference.highlightCount} /><MetricBadge label="Notes" value={reference.noteCount} /><ContextBadge reference={reference} /></div></button></div></article>
}

function DoiStatusBadge({ hasDoi }: { hasDoi: boolean }) {
  return <span className={`rounded-full border px-2 py-0.5 font-semibold ${hasDoi ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200' : 'border-slate-500/30 bg-slate-500/10 text-slate-400'}`}>{hasDoi ? 'DOI available' : 'No DOI'}</span>
}

function MetricBadge({ label, value }: { label: string; value: number }) {
  return <span className="rounded-full border border-slate-600 bg-slate-950/60 px-2 py-0.5 font-semibold text-slate-300">{label}: {value}</span>
}

function ContextBadge({ reference }: { reference: ReferenceItem }) {
  const collection = reference.collections[0]?.name
  const workspaceCount = reference.workspaceIds.length
  const label = collection || (workspaceCount ? `${workspaceCount} workspace${workspaceCount === 1 ? '' : 's'}` : 'No workspace')
  return <span className="max-w-32 truncate rounded-full border border-cyan-400/25 bg-cyan-400/10 px-2 py-0.5 font-semibold text-cyan-200" title={label}>{label}</span>
}
