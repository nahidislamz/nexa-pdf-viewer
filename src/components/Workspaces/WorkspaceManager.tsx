import { useMemo, useState } from 'react'
import type {
  WorkspaceCreateInput,
  WorkspaceDetails,
  WorkspaceSummary,
  WorkspaceTemplate,
} from '../../types/workspaces'
import type { HighlightLibraryEntry } from '../../types/highlightLibrary'

const TEMPLATES: Array<{ id: WorkspaceTemplate; name: string; description: string }> = [
  { id: 'research', name: 'Research Project', description: 'Documents, findings, notes, and saved searches.' },
  { id: 'dissertation', name: 'Dissertation', description: 'Literature review and evidence-first layout.' },
  { id: 'coursework', name: 'Coursework', description: 'Reading lists, notes, and study highlights.' },
  { id: 'legal', name: 'Legal Review', description: 'Reference-focused document comparison workflow.' },
  { id: 'blank', name: 'Blank Workspace', description: 'A clean project with the standard dashboard.' },
]
const COLORS = ['#3b82f6', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6']

export function WorkspaceManager({
  workspaces,
  activeWorkspaceId,
  details,
  loading,
  error,
  onClose,
  onSelect,
  onActivate,
  onRefresh,
  onDelete,
  onOpenDocument,
  onAddDocument,
  onImport,
}: {
  workspaces: WorkspaceSummary[]
  activeWorkspaceId: string
  details: WorkspaceDetails | null
  loading: boolean
  error: string | null
  onClose: () => void
  onSelect: (id: string) => void
  onActivate: (id: string) => Promise<void>
  onRefresh: (selectedId?: string) => Promise<void>
  onDelete: (id: string) => Promise<void>
  onOpenDocument: (documentId: string, options?: { highlight?: HighlightLibraryEntry }) => void
  onAddDocument: () => void
  onImport: () => Promise<void>
}) {
  const [creating, setCreating] = useState(false)
  const [draft, setDraft] = useState<WorkspaceCreateInput>({
    name: '', description: '', color: COLORS[0], icon: 'folder', template: 'research',
  })
  const [busy, setBusy] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const [findingQuery, setFindingQuery] = useState('')
  const [findingCategory, setFindingCategory] = useState('all')
  const filteredHighlights = useMemo(() => {
    const query = findingQuery.trim().toLocaleLowerCase()
    return (details?.highlights ?? []).filter((entry) =>
      (findingCategory === 'all' || entry.category === findingCategory) &&
      (!query || `${entry.text}\n${entry.note}\n${entry.documentName}`.toLocaleLowerCase().includes(query)),
    )
  }, [details, findingCategory, findingQuery])

  async function createWorkspace() {
    if (!draft.name.trim()) return setLocalError('Workspace name is required.')
    setBusy(true)
    setLocalError(null)
    try {
      const created = await window.electronAPI.createWorkspace(draft)
      setCreating(false)
      setDraft({ name: '', description: '', color: COLORS[0], icon: 'folder', template: 'research' })
      await onRefresh(created.id)
    } catch (reason) {
      setLocalError(message(reason))
    } finally {
      setBusy(false)
    }
  }

  async function removeDocument(documentId: string) {
    if (!details) return
    setBusy(true)
    try {
      await window.electronAPI.removeWorkspaceDocument(details.id, documentId)
      await onRefresh(details.id)
    } catch (reason) {
      setLocalError(message(reason))
    } finally {
      setBusy(false)
    }
  }

  async function deleteWorkspace() {
    if (!details || !window.confirm(`Delete workspace “${details.name}”? PDFs and highlights will not be deleted.`)) return
    setBusy(true)
    try {
      await onDelete(details.id)
    } catch (reason) {
      setLocalError(message(reason))
    } finally {
      setBusy(false)
    }
  }

  async function updateNote(documentKey: string, highlightId: string, note: string) {
    try {
      await window.electronAPI.updateHighlightLibrary([{ documentKey, highlightId, patch: { note } }])
      if (details) await onRefresh(details.id)
    } catch (reason) {
      setLocalError(message(reason))
    }
  }

  return (
    <section className="flex h-[calc(100vh-10rem)] min-h-[560px] overflow-hidden rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl shadow-black/35">
      <aside className="flex w-72 shrink-0 flex-col border-r border-slate-700 bg-slate-950/55">
        <div className="border-b border-slate-700 p-4">
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-blue-300">Research environments</p>
          <div className="mt-2 flex items-center justify-between">
            <h1 className="text-xl font-semibold text-white">Workspaces</h1>
            <button type="button" onClick={() => setCreating(true)} className="rounded-lg bg-blue-500 px-3 py-2 text-xs font-bold text-white hover:bg-blue-400">+ New</button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {workspaces.map((workspace) => (
            <button
              type="button"
              key={workspace.id}
              onClick={() => onSelect(workspace.id)}
              className={`mb-1 w-full rounded-xl border px-3 py-3 text-left transition-colors ${details?.id === workspace.id ? 'border-blue-400 bg-blue-500/15' : 'border-transparent hover:border-slate-700 hover:bg-slate-800/80'}`}
            >
              <span className="flex items-center gap-2">
                <span className="size-2.5 rounded-full" style={{ background: workspace.color }} />
                <span className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-100">{workspace.name}</span>
                {workspace.id === activeWorkspaceId ? <span className="rounded bg-blue-500/20 px-1.5 py-0.5 text-[9px] font-bold uppercase text-blue-200">Active</span> : null}
              </span>
              <span className="mt-1 block text-[10px] text-slate-500">{workspace.documentCount} PDFs · {workspace.highlightCount} highlights</span>
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2 border-t border-slate-700 p-3">
          <button type="button" onClick={() => void onImport()} className="workspace-secondary-button">Import</button>
          <button type="button" onClick={onClose} className="workspace-secondary-button">Close</button>
        </div>
      </aside>

      <div className="min-w-0 flex-1 overflow-y-auto bg-[#0f172a]">
        {loading ? <div className="grid h-full place-items-center text-sm text-slate-400">Loading workspace…</div> : null}
        {!loading && (error || localError) ? <p className="m-5 rounded-xl border border-red-500/40 bg-red-950/50 p-4 text-sm text-red-100">{localError || error}</p> : null}
        {!loading && details ? (
          <div className="mx-auto max-w-6xl p-5 lg:p-7">
            <header className="flex flex-wrap items-start gap-4 border-b border-slate-700 pb-5">
              <div className="grid size-12 place-items-center rounded-2xl text-xl font-bold text-white shadow-lg" style={{ background: details.color }}>{details.name.slice(0, 1).toUpperCase()}</div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2"><h2 className="truncate text-2xl font-semibold text-white">{details.name}</h2>{details.id === activeWorkspaceId ? <span className="rounded-full bg-emerald-400/15 px-2 py-1 text-[10px] font-bold uppercase text-emerald-300">Current workspace</span> : null}</div>
                <p className="mt-1 text-sm text-slate-400">{details.description || 'No description'}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                {details.id !== activeWorkspaceId ? <button type="button" onClick={() => void onActivate(details.id)} className="workspace-primary-button">Open Workspace</button> : <button type="button" onClick={onAddDocument} className="workspace-primary-button">Add PDF</button>}
                <button type="button" onClick={() => void window.electronAPI.exportWorkspace(details.id, 'json')} className="workspace-secondary-button">Export JSON</button>
                <button type="button" onClick={() => void window.electronAPI.exportWorkspace(details.id, 'zip')} className="workspace-secondary-button">Export ZIP</button>
                <button type="button" disabled={workspaces.length < 2 || busy} onClick={() => void deleteWorkspace()} className="workspace-danger-button">Delete</button>
              </div>
            </header>

            <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-6">
              <Stat label="Documents" value={details.stats.documents} />
              <Stat label="References" value={details.stats.references} />
              <Stat label="Highlights" value={details.stats.highlights} />
              <Stat label="Notes" value={details.stats.notes} />
              <Stat label="Bookmarks" value={details.stats.bookmarks} />
              <Stat label="Saved Searches" value={details.stats.savedSearches} />
            </div>

            <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1.6fr)_minmax(280px,0.8fr)]">
              <section className="workspace-card">
                <div className="workspace-card-header"><h3>Documents</h3><span>{details.documents.length}</span></div>
                <div className="max-h-80 overflow-y-auto p-2">
                  {details.documents.length ? details.documents.map((document) => (
                    <div key={document.documentId} className="group flex items-center gap-3 rounded-xl px-3 py-2.5 hover:bg-slate-800/80">
                      <span className="text-blue-300">▤</span>
                      <button type="button" disabled={document.missing} onClick={() => onOpenDocument(document.documentId)} title={document.filePath} className="min-w-0 flex-1 text-left">
                        <span className="block truncate text-sm font-medium text-slate-100">{document.name}</span>
                        <span className={`block truncate text-[10px] ${document.missing ? 'text-red-300' : 'text-slate-500'}`}>{document.missing ? 'File is missing' : document.filePath}</span>
                      </button>
                      <button type="button" onClick={() => void removeDocument(document.documentId)} className="opacity-0 text-xs text-slate-400 hover:text-red-300 group-hover:opacity-100">Remove</button>
                    </div>
                  )) : <Empty label="No PDFs in this workspace. Add a document to begin." />}
                </div>
              </section>

              <section className="workspace-card">
                <div className="workspace-card-header"><h3>Categories</h3><span>{details.stats.highlights}</span></div>
                <div className="space-y-3 p-4">
                  {Object.entries(details.stats.categories).map(([category, count]) => (
                    <div key={category} className="flex items-center gap-3 text-sm"><span className={`size-2.5 rounded-full ${categoryColor(category)}`} /><span className="flex-1 capitalize text-slate-300">{category}</span><strong className="text-slate-100">{count}</strong></div>
                  ))}
                </div>
              </section>

              <section className="workspace-card">
                <div className="workspace-card-header"><h3>References</h3><span>{details.stats.references}</span></div>
                <div className="flex gap-2 border-b border-slate-700 p-2"><button type="button" onClick={() => void window.electronAPI.exportReferences({ workspaceId: details.id, style: 'apa', format: 'markdown' })} className="workspace-secondary-button">APA Bibliography</button><button type="button" onClick={() => void window.electronAPI.exportReferences({ workspaceId: details.id, style: 'harvard', format: 'docx' })} className="workspace-secondary-button">Harvard DOCX</button></div>
                <div className="max-h-72 overflow-y-auto p-2">{details.references.length ? details.references.map((reference) => <button type="button" key={reference.id} onClick={() => onOpenDocument(reference.documentId)} className="block w-full rounded-xl px-3 py-2.5 text-left hover:bg-slate-800/80"><span className="block truncate text-xs font-semibold text-slate-200">{reference.title || reference.documentName}</span><span className="mt-1 block truncate text-[10px] text-slate-500">{reference.authors.join(', ') || 'Unknown author'}{reference.year ? ` · ${reference.year}` : ''}</span></button>) : <Empty label="References are created when workspace PDFs are opened." />}</div>
              </section>

              <section className="workspace-card">
                <div className="workspace-card-header"><h3>Workspace Highlights</h3><span>{filteredHighlights.length}</span></div>
                <div className="grid grid-cols-[1fr_140px] gap-2 border-b border-slate-700 p-2">
                  <input value={findingQuery} onChange={(event) => setFindingQuery(event.target.value)} placeholder="Search highlights or notes" className="dashboard-input" />
                  <select value={findingCategory} onChange={(event) => setFindingCategory(event.target.value)} className="dashboard-input"><option value="all">All categories</option><option value="important">Important</option><option value="research">Research</option><option value="reference">Reference</option><option value="question">Question</option></select>
                </div>
                <div className="max-h-72 overflow-y-auto p-2">
                  {filteredHighlights.length ? filteredHighlights.slice(0, 100).map((entry) => (
                    <button type="button" key={entry.key} onClick={() => onOpenDocument(entry.documentId, { highlight: entry })} className="block w-full rounded-xl px-3 py-2.5 text-left hover:bg-slate-800/80">
                      <span className="line-clamp-2 text-xs leading-5 text-slate-200">{entry.text}</span><span className="mt-1 block text-[10px] text-slate-500">{entry.documentName} · Page {entry.pageNumber}{entry.note ? ' · Note attached' : ''}</span>
                    </button>
                  )) : <Empty label="No matching highlights." />}
                </div>
              </section>

              <section className="workspace-card">
                <div className="workspace-card-header"><h3>Recent Activity</h3><span>{details.activities.length}</span></div>
                <div className="max-h-72 overflow-y-auto p-3">
                  {details.activities.length ? details.activities.slice(0, 30).map((activity) => <div key={activity.id} className="border-l border-slate-700 py-2 pl-3"><p className="text-xs text-slate-200">{activity.label}</p><p className="mt-0.5 text-[10px] text-slate-500">{new Date(activity.createdAt).toLocaleString()}</p></div>) : <Empty label="Activity will appear as you work." />}
                </div>
              </section>

              <section className="workspace-card">
                <div className="workspace-card-header"><h3>Notes</h3><span>{details.notes.length}</span></div>
                <div className="max-h-72 overflow-y-auto p-2">
                  {details.notes.length ? details.notes.slice(0, 100).map((entry) => (
                    <div key={entry.key} className="rounded-xl p-3 hover:bg-slate-800/70">
                      <p className="line-clamp-1 text-[10px] text-slate-500">{entry.documentName} · Page {entry.pageNumber}</p>
                      <textarea defaultValue={entry.note} aria-label={`Note for ${entry.text}`} onBlur={(event) => { if (event.currentTarget.value !== entry.note) void updateNote(entry.documentKey, entry.highlightId, event.currentTarget.value) }} onKeyDown={(event) => { if (event.ctrlKey && event.key === 'Enter') event.currentTarget.blur() }} className="mt-1 min-h-16 w-full resize-y rounded-lg border border-slate-700 bg-slate-950/60 p-2 text-xs leading-5 text-slate-200 outline-none focus:border-blue-400" />
                    </div>
                  )) : <Empty label="Notes attached to highlights appear here." />}
                </div>
              </section>

              <section className="workspace-card">
                <div className="workspace-card-header"><h3>Saved Searches</h3><span>{details.savedSearches.length}</span></div>
                <div className="max-h-72 overflow-y-auto p-2">
                  {details.savedSearches.length ? details.savedSearches.map((search) => <div key={search.id} className="rounded-xl px-3 py-2.5 hover:bg-slate-800/70"><p className="text-xs font-semibold text-slate-200">{search.name}</p><p className="mt-1 truncate text-[10px] text-slate-500">{search.query}</p></div>) : <Empty label="Save searches from Global Search to keep them in this workspace." />}
                </div>
              </section>
            </div>
          </div>
        ) : null}
      </div>

      {creating ? (
        <div className="fixed inset-0 z-[90] grid place-items-center bg-slate-950/80 p-5 backdrop-blur-sm" onMouseDown={(event) => { if (event.target === event.currentTarget) setCreating(false) }}>
          <div className="w-full max-w-2xl rounded-2xl border border-slate-600 bg-slate-900 p-5 shadow-2xl">
            <div className="flex items-center justify-between"><div><p className="text-[10px] font-bold uppercase tracking-widest text-blue-300">New research environment</p><h2 className="mt-1 text-xl font-semibold text-white">Create Workspace</h2></div><button type="button" onClick={() => setCreating(false)} className="grid size-9 place-items-center rounded-lg text-xl text-slate-400 hover:bg-slate-800">×</button></div>
            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              {TEMPLATES.map((template) => <button type="button" key={template.id} onClick={() => setDraft((current) => ({ ...current, template: template.id }))} className={`rounded-xl border p-3 text-left ${draft.template === template.id ? 'border-blue-400 bg-blue-500/15' : 'border-slate-700 hover:bg-slate-800'}`}><strong className="text-sm text-slate-100">{template.name}</strong><span className="mt-1 block text-xs leading-5 text-slate-500">{template.description}</span></button>)}
            </div>
            <label className="mt-4 block text-xs font-semibold text-slate-300">Name<input autoFocus value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} className="dashboard-input mt-1.5" placeholder="MSc Cyber Security" /></label>
            <label className="mt-3 block text-xs font-semibold text-slate-300">Description<textarea value={draft.description} onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))} className="dashboard-input mt-1.5 min-h-20 resize-y" placeholder="Research and coursework" /></label>
            <div className="mt-4 flex items-center gap-3"><span className="text-xs font-semibold text-slate-300">Color</span>{COLORS.map((color) => <button type="button" key={color} aria-label={`Use ${color}`} onClick={() => setDraft((current) => ({ ...current, color }))} className={`size-7 rounded-full border-2 ${draft.color === color ? 'border-white' : 'border-transparent'}`} style={{ background: color }} />)}</div>
            {localError ? <p className="mt-3 text-sm text-red-300">{localError}</p> : null}
            <div className="mt-5 flex justify-end gap-2"><button type="button" onClick={() => setCreating(false)} className="workspace-secondary-button">Cancel</button><button type="button" disabled={busy} onClick={() => void createWorkspace()} className="workspace-primary-button">{busy ? 'Creating…' : 'Create Workspace'}</button></div>
          </div>
        </div>
      ) : null}
    </section>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return <div className="rounded-xl border border-slate-700 bg-slate-900/80 p-4"><strong className="block text-xl text-white">{value.toLocaleString()}</strong><span className="mt-1 block text-[10px] font-bold uppercase tracking-wide text-slate-500">{label}</span></div>
}
function Empty({ label }: { label: string }) { return <p className="p-6 text-center text-xs text-slate-500">{label}</p> }
function categoryColor(category: string) { return category === 'important' ? 'bg-amber-300' : category === 'research' ? 'bg-emerald-300' : category === 'reference' ? 'bg-sky-300' : 'bg-violet-300' }
function message(reason: unknown) { return reason instanceof Error ? reason.message : String(reason) }
