import { useState } from 'react'

type MergePdfItem = Awaited<ReturnType<Window['electronAPI']['pickMergePdfs']>>[number]
type OpenedPdf = Awaited<ReturnType<Window['electronAPI']['openPdfPath']>>
type MergePdfResult = Awaited<ReturnType<Window['electronAPI']['mergePdfs']>>

export function MergePdfsPanel({
  onClose,
  onOpenPdf,
  onRefreshRecent,
}: {
  onClose: () => void
  onOpenPdf: (pdf: OpenedPdf) => void
  onRefreshRecent: () => Promise<void>
}) {
  const [items, setItems] = useState<MergePdfItem[]>([])
  const [outputName, setOutputName] = useState('merged.pdf')
  const [openAfterMerge, setOpenAfterMerge] = useState(true)
  const [dragActive, setDragActive] = useState(false)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<MergePdfResult>(null)

  const totalPages = items.reduce((sum, item) => sum + item.pageCount, 0)
  const totalSize = items.reduce((sum, item) => sum + item.fileSize, 0)
  const largeWarning = totalPages >= 1000 || totalSize >= 500 * 1024 * 1024

  async function addPickedPdfs() {
    setError(null)
    setBusy(true)
    setStatus('Reading PDF information...')
    try {
      addItems(await window.electronAPI.pickMergePdfs())
    } catch (reason) {
      setError(message(reason))
    } finally {
      setBusy(false)
      setStatus('')
    }
  }

  async function addDroppedFiles(files: FileList | null) {
    const dropped = Array.from(files ?? [])
    if (!dropped.length) return
    if (dropped.some((file) => file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf'))) {
      setError('Only PDF files can be added to Merge PDFs.')
      return
    }
    setError(null)
    setBusy(true)
    setStatus('Reading dropped PDFs...')
    try {
      addItems(await window.electronAPI.inspectMergePdfs(dropped))
    } catch (reason) {
      setError(message(reason))
    } finally {
      setBusy(false)
      setStatus('')
    }
  }

  function addItems(nextItems: MergePdfItem[]) {
    setItems((current) => {
      const byPath = new Map(current.map((item) => [item.filePath, item]))
      for (const item of nextItems) byPath.set(item.filePath, item)
      return [...byPath.values()]
    })
    if (!outputName.trim() || outputName === 'merged.pdf') {
      const first = nextItems[0]?.name?.replace(/\.pdf$/i, '')
      if (first) setOutputName(`${first}-merged.pdf`)
    }
  }

  function moveItem(index: number, direction: -1 | 1) {
    setItems((current) => {
      const target = index + direction
      if (target < 0 || target >= current.length) return current
      const next = [...current]
      const [item] = next.splice(index, 1)
      next.splice(target, 0, item)
      return next
    })
  }

  async function openSourcePdf(item: MergePdfItem) {
    setError(null)
    try {
      onOpenPdf(await window.electronAPI.openPdfPath(item.filePath))
      await onRefreshRecent()
    } catch (reason) {
      setError(message(reason))
    }
  }

  async function mergePdfs() {
    if (items.length < 2) {
      setError('Select at least two PDFs before merging.')
      return
    }
    setBusy(true)
    setError(null)
    setResult(null)
    setStatus('Merging PDFs. Large files may take a moment...')
    try {
      const merged = await window.electronAPI.mergePdfs({
        files: items.map((item) => ({ filePath: item.filePath })),
        outputName,
        openAfterMerge,
      })
      setResult(merged)
      if (merged?.openedPdf && openAfterMerge) onOpenPdf(merged.openedPdf)
      await onRefreshRecent()
      setStatus(merged ? 'Merged PDF created successfully.' : 'Merge cancelled.')
    } catch (reason) {
      setError(message(reason))
      setStatus('')
    } finally {
      setBusy(false)
    }
  }

  async function openMergedPdf() {
    if (!result) return
    try {
      onOpenPdf(result.openedPdf ?? await window.electronAPI.openPdfPath(result.outputPath))
      await onRefreshRecent()
    } catch (reason) {
      setError(message(reason))
    }
  }

  async function revealMergedPdf() {
    if (!result) return
    try {
      const id = result.openedPdf?.id ?? (await window.electronAPI.openPdfPath(result.outputPath)).id
      await window.electronAPI.revealPdf(id)
      await onRefreshRecent()
    } catch (reason) {
      setError(message(reason))
    }
  }

  return (
    <section
      className="flex h-[calc(100vh-10rem)] min-h-[580px] flex-col overflow-hidden rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl shadow-black/35"
      onDragEnter={(event) => {
        event.preventDefault()
        setDragActive(true)
      }}
      onDragOver={(event) => {
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
      }}
      onDragLeave={(event) => {
        event.preventDefault()
        if (event.currentTarget === event.target) setDragActive(false)
      }}
      onDrop={(event) => {
        event.preventDefault()
        setDragActive(false)
        void addDroppedFiles(event.dataTransfer.files)
      }}
    >
      <header className="flex flex-wrap items-center gap-3 border-b border-slate-700 bg-gradient-to-r from-slate-950 to-slate-900 px-5 py-4">
        <div className="min-w-52">
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-blue-300">PDF Tools</p>
          <h1 className="mt-1 text-xl font-semibold text-white">Merge PDFs</h1>
        </div>
        <button type="button" onClick={() => void addPickedPdfs()} disabled={busy} className="workspace-primary-button disabled:opacity-50">Add PDFs</button>
        <button type="button" onClick={() => setItems([])} disabled={!items.length || busy} className="workspace-secondary-button disabled:opacity-40">Clear All</button>
        <button type="button" onClick={onClose} className="workspace-secondary-button">Close</button>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(360px,1fr)_320px] max-lg:grid-cols-1">
        <div className="min-h-0 overflow-y-auto bg-[#0f172a] p-4">
          <div className={`mb-4 rounded-2xl border border-dashed p-6 text-center transition-colors ${dragActive ? 'border-blue-300 bg-blue-500/15 text-blue-100' : 'border-slate-700 bg-slate-950/60 text-slate-400'}`}>
            <p className="text-sm font-semibold">Drag PDF files here</p>
            <p className="mt-1 text-xs">Non-PDF files are rejected. Originals are never modified.</p>
          </div>

          {error ? <p className="mb-4 rounded-lg border border-red-500/40 bg-red-950/50 p-3 text-sm text-red-100">{error}</p> : null}
          {largeWarning ? <p className="mb-4 rounded-lg border border-amber-500/40 bg-amber-950/40 p-3 text-sm text-amber-100">Large merge warning: {totalPages.toLocaleString()} pages and {formatFileSize(totalSize)} selected. This may take time.</p> : null}

          <div className="space-y-2">
            {items.length ? items.map((item, index) => (
              <article key={item.filePath} className="rounded-xl border border-slate-700 bg-slate-900 p-3 transition-colors hover:border-slate-500">
                <div className="flex min-w-0 items-start gap-3">
                  <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-blue-500/15 text-xs font-bold text-blue-200">{index + 1}</span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-slate-100" title={item.name}>{item.name}</p>
                    <p className="mt-1 truncate text-[11px] text-slate-500" title={item.filePath}>{item.filePath}</p>
                    <p className="mt-2 text-xs text-slate-400">{item.pageCount.toLocaleString()} pages | {formatFileSize(item.fileSize)}</p>
                  </div>
                  <div className="flex shrink-0 flex-wrap justify-end gap-1">
                    <button type="button" onClick={() => moveItem(index, -1)} disabled={index === 0 || busy} className="merge-tool-button">Up</button>
                    <button type="button" onClick={() => moveItem(index, 1)} disabled={index === items.length - 1 || busy} className="merge-tool-button">Down</button>
                    <button type="button" onClick={() => void openSourcePdf(item)} disabled={busy} className="merge-tool-button">Open</button>
                    <button type="button" onClick={() => setItems((current) => current.filter((candidate) => candidate.filePath !== item.filePath))} disabled={busy} className="merge-tool-button text-red-200 hover:border-red-400">Remove</button>
                  </div>
                </div>
              </article>
            )) : <p className="rounded-xl border border-dashed border-slate-700 bg-slate-900/50 p-8 text-center text-sm text-slate-500">Add at least two PDFs to start a merge.</p>}
          </div>
        </div>

        <aside className="border-l border-slate-700 bg-slate-950/45 p-4 max-lg:border-l-0 max-lg:border-t">
          <h2 className="text-sm font-semibold text-white">Merge Options</h2>
          <label className="mt-4 block text-[10px] font-bold uppercase tracking-wide text-slate-500">Output filename<input value={outputName} onChange={(event) => setOutputName(event.target.value)} className="dashboard-input mt-1" placeholder="merged.pdf" /></label>
          <label className="mt-4 flex items-center gap-2 text-xs font-semibold text-slate-300"><input type="checkbox" checked readOnly />Preserve original page order</label>
          <label className="mt-3 flex items-center gap-2 text-xs font-semibold text-slate-500"><input type="checkbox" disabled />Preserve bookmarks if possible</label>
          <label className="mt-3 flex items-center gap-2 text-xs font-semibold text-slate-500"><input type="checkbox" checked readOnly />Preserve basic metadata where possible</label>
          <label className="mt-3 flex items-center gap-2 text-xs font-semibold text-slate-300"><input type="checkbox" checked={openAfterMerge} onChange={(event) => setOpenAfterMerge(event.target.checked)} />Open merged PDF after export</label>

          <div className="mt-5 grid grid-cols-2 gap-2">
            <Summary label="Files" value={items.length} />
            <Summary label="Pages" value={totalPages} />
          </div>
          <Summary label="Total Size" value={formatFileSize(totalSize)} wide />

          <button type="button" onClick={() => void mergePdfs()} disabled={busy || items.length < 2} className="workspace-primary-button mt-5 w-full disabled:cursor-not-allowed disabled:opacity-50">{busy ? 'Working...' : 'Merge and Save'}</button>
          {status ? <p className="mt-3 rounded-lg border border-slate-700 bg-slate-900 p-3 text-xs text-slate-300">{status}</p> : null}
          {result ? (
            <div className="mt-4 rounded-xl border border-emerald-500/40 bg-emerald-950/30 p-3">
              <p className="text-sm font-semibold text-emerald-100">Merged PDF ready</p>
              <p className="mt-1 truncate text-xs text-emerald-200/80" title={result.outputPath}>{result.name} | {result.pageCount.toLocaleString()} pages</p>
              <div className="mt-3 flex gap-2">
                <button type="button" onClick={() => void openMergedPdf()} className="workspace-secondary-button">Open</button>
                <button type="button" onClick={() => void revealMergedPdf()} className="workspace-secondary-button">Reveal</button>
              </div>
            </div>
          ) : null}
        </aside>
      </div>
    </section>
  )
}

function Summary({ label, value, wide = false }: { label: string; value: number | string; wide?: boolean }) {
  return <div className={`mt-2 rounded-xl border border-slate-700 bg-slate-900 p-3 ${wide ? 'col-span-2' : ''}`}><strong className="block text-lg text-white">{typeof value === 'number' ? value.toLocaleString() : value}</strong><span className="text-[10px] font-bold uppercase tracking-wide text-slate-500">{label}</span></div>
}

function formatFileSize(bytes: number) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

function message(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason)
}
