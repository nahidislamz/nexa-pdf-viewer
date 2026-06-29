import { useState } from 'react'

type ImageItem = Awaited<ReturnType<Window['electronAPI']['pickImagesForPdf']>>[number]
type OpenedPdf = Awaited<ReturnType<Window['electronAPI']['openPdfPath']>>
type ExportResult = Awaited<ReturnType<Window['electronAPI']['imagesToPdf']>>

type PageSize = 'a4' | 'letter' | 'fit-image' | 'custom'
type Orientation = 'auto' | 'portrait' | 'landscape'
type ImageFit = 'fit-page' | 'fill-page' | 'original-size' | 'center'
type Margin = 'none' | 'small' | 'medium' | 'large'

export function ImagesToPdfPanel({
  onClose,
  onOpenPdf,
  onRefreshRecent,
}: {
  onClose: () => void
  onOpenPdf: (pdf: OpenedPdf) => void
  onRefreshRecent: () => Promise<void>
}) {
  const [items, setItems] = useState<ImageItem[]>([])
  const [outputName, setOutputName] = useState('images.pdf')
  const [pageSize, setPageSize] = useState<PageSize>('a4')
  const [orientation, setOrientation] = useState<Orientation>('auto')
  const [imageFit, setImageFit] = useState<ImageFit>('fit-page')
  const [margin, setMargin] = useState<Margin>('medium')
  const [customWidth, setCustomWidth] = useState(595)
  const [customHeight, setCustomHeight] = useState(842)
  const [openAfterExport, setOpenAfterExport] = useState(true)
  const [dragActive, setDragActive] = useState(false)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ExportResult>(null)

  const totalSize = items.reduce((sum, item) => sum + item.fileSize, 0)
  const largeWarning = items.length >= 100 || totalSize >= 500 * 1024 * 1024

  async function addPickedImages() {
    setError(null)
    setBusy(true)
    setStatus('Reading image information...')
    try {
      addItems(await window.electronAPI.pickImagesForPdf())
    } catch (reason) {
      setError(message(reason))
    } finally {
      setBusy(false)
      setStatus('')
    }
  }

  async function addDroppedImages(files: FileList | null) {
    const dropped = Array.from(files ?? [])
    if (!dropped.length) return
    if (dropped.some((file) => !isSupportedImage(file))) {
      setError('Only JPG, JPEG, PNG, and WEBP images can be added.')
      return
    }
    setError(null)
    setBusy(true)
    setStatus('Reading dropped images...')
    try {
      addItems(await window.electronAPI.inspectImagesForPdf(dropped))
    } catch (reason) {
      setError(message(reason))
    } finally {
      setBusy(false)
      setStatus('')
    }
  }

  function addItems(nextItems: ImageItem[]) {
    setItems((current) => {
      const byPath = new Map(current.map((item) => [item.filePath, item]))
      for (const item of nextItems) byPath.set(item.filePath, item)
      return [...byPath.values()]
    })
    if (!outputName.trim() || outputName === 'images.pdf') {
      const first = nextItems[0]?.name?.replace(/\.(jpe?g|png|webp)$/i, '')
      if (first) setOutputName(`${first}-images.pdf`)
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

  async function exportPdf() {
    if (!items.length) {
      setError('Add at least one image before exporting.')
      return
    }
    setBusy(true)
    setError(null)
    setResult(null)
    setStatus('Creating PDF from images...')
    try {
      const exported = await window.electronAPI.imagesToPdf({
        images: items.map((item) => ({ filePath: item.filePath })),
        outputName,
        openAfterExport,
        pageSize,
        orientation,
        imageFit,
        margin,
        customWidth,
        customHeight,
      })
      setResult(exported)
      if (exported?.openedPdf && openAfterExport) onOpenPdf(exported.openedPdf)
      await onRefreshRecent()
      setStatus(exported ? 'PDF created successfully.' : 'Export cancelled.')
    } catch (reason) {
      setError(message(reason))
      setStatus('')
    } finally {
      setBusy(false)
    }
  }

  async function openExportedPdf() {
    if (!result) return
    try {
      onOpenPdf(result.openedPdf ?? await window.electronAPI.openPdfPath(result.outputPath))
      await onRefreshRecent()
    } catch (reason) {
      setError(message(reason))
    }
  }

  async function revealExportedPdf() {
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
        void addDroppedImages(event.dataTransfer.files)
      }}
    >
      <header className="flex flex-wrap items-center gap-3 border-b border-slate-700 bg-gradient-to-r from-slate-950 to-slate-900 px-5 py-4">
        <div className="min-w-52">
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-blue-300">PDF Tools</p>
          <h1 className="mt-1 text-xl font-semibold text-white">Images to PDF</h1>
        </div>
        <button type="button" onClick={() => void addPickedImages()} disabled={busy} className="workspace-primary-button disabled:opacity-50">Add Images</button>
        <button type="button" onClick={() => setItems([])} disabled={!items.length || busy} className="workspace-secondary-button disabled:opacity-40">Clear All</button>
        <button type="button" onClick={onClose} className="workspace-secondary-button">Close</button>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(380px,1fr)_340px] max-lg:grid-cols-1">
        <div className="min-h-0 overflow-y-auto bg-[#0f172a] p-4">
          <div className={`mb-4 rounded-2xl border border-dashed p-6 text-center transition-colors ${dragActive ? 'border-blue-300 bg-blue-500/15 text-blue-100' : 'border-slate-700 bg-slate-950/60 text-slate-400'}`}>
            <p className="text-sm font-semibold">Drag JPG, PNG, or WEBP images here</p>
            <p className="mt-1 text-xs">Images are converted into a new PDF. Source files are never modified.</p>
          </div>

          {error ? <p className="mb-4 rounded-lg border border-red-500/40 bg-red-950/50 p-3 text-sm text-red-100">{error}</p> : null}
          {largeWarning ? <p className="mb-4 rounded-lg border border-amber-500/40 bg-amber-950/40 p-3 text-sm text-amber-100">Large export warning: {items.length.toLocaleString()} images and {formatFileSize(totalSize)} selected. This may take time.</p> : null}

          <div className="space-y-2">
            {items.length ? items.map((item, index) => (
              <article key={item.filePath} className="rounded-xl border border-slate-700 bg-slate-900 p-3 transition-colors hover:border-slate-500">
                <div className="flex min-w-0 items-center gap-3">
                  <img src={item.thumbnailDataUrl} alt="" className="size-16 shrink-0 rounded-lg border border-slate-700 bg-slate-950 object-contain" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-slate-100" title={item.name}>{index + 1}. {item.name}</p>
                    <p className="mt-1 truncate text-[11px] text-slate-500" title={item.filePath}>{item.filePath}</p>
                    <p className="mt-2 text-xs text-slate-400">{item.width} x {item.height}px | {formatFileSize(item.fileSize)}</p>
                  </div>
                  <div className="flex shrink-0 flex-wrap justify-end gap-1">
                    <button type="button" onClick={() => moveItem(index, -1)} disabled={index === 0 || busy} className="merge-tool-button">Up</button>
                    <button type="button" onClick={() => moveItem(index, 1)} disabled={index === items.length - 1 || busy} className="merge-tool-button">Down</button>
                    <button type="button" onClick={() => setItems((current) => current.filter((candidate) => candidate.filePath !== item.filePath))} disabled={busy} className="merge-tool-button text-red-200 hover:border-red-400">Remove</button>
                  </div>
                </div>
              </article>
            )) : <p className="rounded-xl border border-dashed border-slate-700 bg-slate-900/50 p-8 text-center text-sm text-slate-500">Add at least one image to create a PDF.</p>}
          </div>
        </div>

        <aside className="min-h-0 overflow-y-auto border-l border-slate-700 bg-slate-950/45 p-4 max-lg:border-l-0 max-lg:border-t">
          <h2 className="text-sm font-semibold text-white">Page Options</h2>
          <label className="mt-4 block text-[10px] font-bold uppercase tracking-wide text-slate-500">Output filename<input value={outputName} onChange={(event) => setOutputName(event.target.value)} className="dashboard-input mt-1" placeholder="images.pdf" /></label>
          <Select label="Page size" value={pageSize} onChange={(value) => setPageSize(value as PageSize)} options={[['a4', 'A4'], ['letter', 'Letter'], ['fit-image', 'Fit to image'], ['custom', 'Custom']]} />
          {pageSize === 'custom' ? (
            <div className="mt-3 grid grid-cols-2 gap-2">
              <label className="reference-label">Width (pt)<input type="number" min={72} max={4320} value={customWidth} onChange={(event) => setCustomWidth(Number(event.target.value))} className="dashboard-input mt-1" /></label>
              <label className="reference-label">Height (pt)<input type="number" min={72} max={4320} value={customHeight} onChange={(event) => setCustomHeight(Number(event.target.value))} className="dashboard-input mt-1" /></label>
            </div>
          ) : null}
          <Select label="Orientation" value={orientation} onChange={(value) => setOrientation(value as Orientation)} options={[['auto', 'Auto'], ['portrait', 'Portrait'], ['landscape', 'Landscape']]} />
          <Select label="Image fit" value={imageFit} onChange={(value) => setImageFit(value as ImageFit)} options={[['fit-page', 'Fit page'], ['fill-page', 'Fill page'], ['original-size', 'Original size'], ['center', 'Center']]} />
          <Select label="Margins" value={margin} onChange={(value) => setMargin(value as Margin)} options={[['none', 'None'], ['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']]} />
          <label className="mt-4 flex items-center gap-2 text-xs font-semibold text-slate-300"><input type="checkbox" checked={openAfterExport} onChange={(event) => setOpenAfterExport(event.target.checked)} />Open PDF after export</label>

          <div className="mt-5 grid grid-cols-2 gap-2">
            <Summary label="Images" value={items.length} />
            <Summary label="Size" value={formatFileSize(totalSize)} />
          </div>

          <button type="button" onClick={() => void exportPdf()} disabled={busy || items.length < 1} className="workspace-primary-button mt-5 w-full disabled:cursor-not-allowed disabled:opacity-50">{busy ? 'Working...' : 'Export as PDF'}</button>
          {status ? <p className="mt-3 rounded-lg border border-slate-700 bg-slate-900 p-3 text-xs text-slate-300">{status}</p> : null}
          {result ? (
            <div className="mt-4 rounded-xl border border-emerald-500/40 bg-emerald-950/30 p-3">
              <p className="text-sm font-semibold text-emerald-100">PDF ready</p>
              <p className="mt-1 truncate text-xs text-emerald-200/80" title={result.outputPath}>{result.name} | {result.pageCount.toLocaleString()} pages</p>
              <div className="mt-3 flex gap-2">
                <button type="button" onClick={() => void openExportedPdf()} className="workspace-secondary-button">Open</button>
                <button type="button" onClick={() => void revealExportedPdf()} className="workspace-secondary-button">Reveal</button>
              </div>
            </div>
          ) : null}
        </aside>
      </div>
    </section>
  )
}

function Select({ label, value, options, onChange }: { label: string; value: string; options: string[][]; onChange: (value: string) => void }) {
  return <label className="mt-3 block text-[10px] font-bold uppercase tracking-wide text-slate-500">{label}<select value={value} onChange={(event) => onChange(event.target.value)} className="dashboard-input mt-1">{options.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
}

function Summary({ label, value }: { label: string; value: number | string }) {
  return <div className="rounded-xl border border-slate-700 bg-slate-900 p-3"><strong className="block text-lg text-white">{typeof value === 'number' ? value.toLocaleString() : value}</strong><span className="text-[10px] font-bold uppercase tracking-wide text-slate-500">{label}</span></div>
}

function isSupportedImage(file: File) {
  return ['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || /\.(jpe?g|png|webp)$/i.test(file.name)
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
