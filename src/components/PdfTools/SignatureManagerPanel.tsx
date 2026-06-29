import { useEffect, useRef, useState } from 'react'

type SavedSignature = Awaited<ReturnType<Window['electronAPI']['listSignatures']>>[number]
type UploadedSignatureImage = Awaited<ReturnType<Window['electronAPI']['pickSignatureImage']>>
type StrokePoint = { x: number; y: number; time: number; width: number }
type SignatureStroke = { color: string; baseWidth: number; points: StrokePoint[] }
type PenSizeId = 'extra-fine' | 'fine' | 'medium' | 'bold'
type PenColorId = 'black' | 'dark-blue' | 'blue'
type GuideMode = 'none' | 'baseline' | 'grid'

const TYPE_FONTS = [
  { id: 'script', label: 'Script', css: '"Segoe Script", "Brush Script MT", cursive' },
  { id: 'classic', label: 'Classic', css: 'Georgia, "Times New Roman", serif' },
  { id: 'modern', label: 'Modern', css: '"Segoe UI", sans-serif' },
]
const COLORS = [
  { id: '#020617', label: 'Black' },
  { id: '#1d4ed8', label: 'Blue' },
  { id: '#374151', label: 'Dark Gray' },
]
const DRAW_CANVAS_WIDTH = 1800
const DRAW_CANVAS_HEIGHT = 600
const TRIM_PADDING = 28
const SIGNATURE_PEN_SETTINGS_KEY = 'nextpdf.signature.penSettings'
const PEN_SIZES: Array<{ id: PenSizeId; label: string; width: number }> = [
  { id: 'extra-fine', label: 'Extra Fine', width: 0.75 },
  { id: 'fine', label: 'Fine', width: 1.25 },
  { id: 'medium', label: 'Medium', width: 2 },
  { id: 'bold', label: 'Bold', width: 3 },
]
const PEN_COLORS: Array<{ id: PenColorId; label: string; value: string }> = [
  { id: 'black', label: 'Black', value: '#020617' },
  { id: 'dark-blue', label: 'Dark Blue', value: '#172554' },
  { id: 'blue', label: 'Blue', value: '#1d4ed8' },
]
const GUIDE_OPTIONS: Array<{ id: GuideMode; label: string }> = [
  { id: 'none', label: 'None' },
  { id: 'baseline', label: 'Baseline' },
  { id: 'grid', label: 'Light grid' },
]
const DEFAULT_PEN_SETTINGS = {
  penSize: 'fine' as PenSizeId,
  penColor: 'black' as PenColorId,
  guideMode: 'none' as GuideMode,
}

export function SignatureManagerPanel({ onClose }: { onClose: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const previewRefreshRef = useRef(0)
  const drawFrameRef = useRef(0)
  const drawingRef = useRef(false)
  const strokesRef = useRef<SignatureStroke[]>([])
  const activeStrokeRef = useRef<SignatureStroke | null>(null)
  const [signatures, setSignatures] = useState<SavedSignature[]>([])
  const [activeTab, setActiveTab] = useState<'draw' | 'upload' | 'type'>('draw')
  const [strokes, setStrokes] = useState<SignatureStroke[]>([])
  const [penSize, setPenSize] = useState<PenSizeId>(() => readSignaturePenSettings().penSize)
  const [penColor, setPenColor] = useState<PenColorId>(() => readSignaturePenSettings().penColor)
  const [guideMode, setGuideMode] = useState<GuideMode>(() => readSignaturePenSettings().guideMode)
  const [cursorPreview, setCursorPreview] = useState({ visible: false, x: 0, y: 0 })
  const [drawPreviewDataUrl, setDrawPreviewDataUrl] = useState('')
  const [upload, setUpload] = useState<UploadedSignatureImage>(null)
  const [typedName, setTypedName] = useState('')
  const [typedFont, setTypedFont] = useState(TYPE_FONTS[0].id)
  const [typedColor, setTypedColor] = useState(COLORS[0].id)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState('')

  useEffect(() => {
    let cancelled = false
    void window.electronAPI.listSignatures()
      .then((items) => {
        if (!cancelled) setSignatures(items)
      })
      .catch((reason) => {
        if (!cancelled) setError(message(reason))
    })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    localStorage.setItem(SIGNATURE_PEN_SETTINGS_KEY, JSON.stringify({ penSize, penColor, guideMode }))
  }, [guideMode, penColor, penSize])

  useEffect(() => {
    return () => {
      window.cancelAnimationFrame(drawFrameRef.current)
      window.clearTimeout(previewRefreshRef.current)
    }
  }, [])

  function canvasPoint(event: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = event.currentTarget
    const rect = canvas.getBoundingClientRect()
    return {
      x: ((event.clientX - rect.left) / rect.width) * DRAW_CANVAS_WIDTH,
      y: ((event.clientY - rect.top) / rect.height) * DRAW_CANVAS_HEIGHT,
      renderScale: DRAW_CANVAS_WIDTH / rect.width,
    }
  }

  function updateCursorPreview(event: React.PointerEvent<HTMLCanvasElement>) {
    const rect = event.currentTarget.getBoundingClientRect()
    setCursorPreview({
      visible: true,
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    })
  }

  function startDraw(event: React.PointerEvent<HTMLCanvasElement>) {
    event.preventDefault()
    updateCursorPreview(event)
    event.currentTarget.setPointerCapture(event.pointerId)
    drawingRef.current = true
    const selectedSize = PEN_SIZES.find((size) => size.id === penSize) ?? PEN_SIZES[1]
    const selectedColor = PEN_COLORS.find((color) => color.id === penColor) ?? PEN_COLORS[0]
    const point = canvasPoint(event)
    const baseWidth = selectedSize.width * point.renderScale
    const stroke: SignatureStroke = {
      color: selectedColor.value,
      baseWidth,
      points: [{ x: point.x, y: point.y, time: performance.now(), width: baseWidth }],
    }
    activeStrokeRef.current = stroke
    strokesRef.current = [...strokesRef.current, stroke]
    scheduleDraw()
  }

  function continueDraw(event: React.PointerEvent<HTMLCanvasElement>) {
    updateCursorPreview(event)
    if (!drawingRef.current) return
    event.preventDefault()
    const stroke = activeStrokeRef.current
    if (!stroke) return
    const rawPoint = canvasPoint(event)
    const previous = stroke.points.at(-1)
    if (!previous) return
    const now = performance.now()
    const smoothedX = previous.x * 0.35 + rawPoint.x * 0.65
    const smoothedY = previous.y * 0.35 + rawPoint.y * 0.65
    const distance = Math.hypot(smoothedX - previous.x, smoothedY - previous.y)
    if (distance < 1.25) return
    const velocity = distance / Math.max(now - previous.time, 1)
    const targetWidth = velocityAdjustedWidth(stroke.baseWidth, velocity)
    stroke.points.push({
      x: smoothedX,
      y: smoothedY,
      time: now,
      width: previous.width * 0.65 + targetWidth * 0.35,
    })
    scheduleDraw()
  }

  function stopDraw(event?: React.PointerEvent<HTMLCanvasElement>) {
    if (event?.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    drawingRef.current = false
    activeStrokeRef.current = null
    setStrokes([...strokesRef.current])
    refreshDrawPreview()
  }

  function drawStrokes(nextStrokes = strokes) {
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (!canvas || !context) return
    context.clearRect(0, 0, canvas.width, canvas.height)
    context.lineCap = 'round'
    context.lineJoin = 'round'
    for (const stroke of nextStrokes) {
      drawSignatureStroke(context, stroke)
    }
  }

  function scheduleDraw() {
    if (drawFrameRef.current) return
    drawFrameRef.current = window.requestAnimationFrame(() => {
      drawFrameRef.current = 0
      drawStrokes(strokesRef.current)
      schedulePreviewRefresh()
    })
  }

  function schedulePreviewRefresh() {
    window.clearTimeout(previewRefreshRef.current)
    previewRefreshRef.current = window.setTimeout(refreshDrawPreview, 140)
  }

  function refreshDrawPreview() {
    const canvas = canvasRef.current
    if (!canvas || strokesRef.current.length === 0) {
      setDrawPreviewDataUrl('')
      return
    }
    setDrawPreviewDataUrl(trimTransparentCanvas(canvas))
  }

  function clearDrawnSignature() {
    strokesRef.current = []
    activeStrokeRef.current = null
    setStrokes([])
    drawStrokes([])
    setDrawPreviewDataUrl('')
  }

  function undoStroke() {
    strokesRef.current = strokesRef.current.slice(0, -1)
    activeStrokeRef.current = null
    setStrokes([...strokesRef.current])
    drawStrokes(strokesRef.current)
    refreshDrawPreview()
  }

  async function saveDrawnSignature() {
    if (!strokes.length) {
      setError('Draw a signature before saving.')
      return
    }
    const canvas = canvasRef.current
    if (!canvas) return
    await createSignature({
      name: `Drawn Signature ${signatures.length + 1}`,
      type: 'drawn',
      imageDataUrl: trimTransparentCanvas(canvas),
    })
    clearDrawnSignature()
  }

  async function pickUpload() {
    setBusy(true)
    setError(null)
    try {
      setUpload(await window.electronAPI.pickSignatureImage())
    } catch (reason) {
      setError(message(reason))
    } finally {
      setBusy(false)
    }
  }

  async function saveUploadedSignature() {
    if (!upload) {
      setError('Upload a signature image before saving.')
      return
    }
    await createSignature({
      name: upload.name || `Uploaded Signature ${signatures.length + 1}`,
      type: 'uploaded',
      imageDataUrl: upload.imageDataUrl,
    })
    setUpload(null)
  }

  async function saveTypedSignature() {
    if (!typedName.trim()) {
      setError('Type a name before saving.')
      return
    }
    await createSignature({
      name: typedName.trim(),
      type: 'typed',
      imageDataUrl: renderTypedSignature(typedName.trim(), typedFont, typedColor),
    })
    setTypedName('')
  }

  async function createSignature(signature: { name: string; type: 'drawn' | 'uploaded' | 'typed'; imageDataUrl: string }) {
    setBusy(true)
    setError(null)
    setStatus('')
    try {
      setSignatures(await window.electronAPI.createSignature(signature))
      setStatus('Signature saved locally on this device.')
    } catch (reason) {
      setError(message(reason))
    } finally {
      setBusy(false)
    }
  }

  async function updateLibrary(action: () => Promise<SavedSignature[]>) {
    setBusy(true)
    setError(null)
    setStatus('')
    try {
      setSignatures(await action())
      setStatus('Signature library updated locally.')
    } catch (reason) {
      setError(message(reason))
    } finally {
      setBusy(false)
    }
  }

  function renameSignature(signature: SavedSignature) {
    const name = window.prompt('Rename signature', signature.name)?.trim()
    if (!name || name === signature.name) return
    void updateLibrary(() => window.electronAPI.updateSignature(signature.id, { name }))
  }

  function deleteSignature(signature: SavedSignature) {
    if (!window.confirm(`Delete signature "${signature.name}"?`)) return
    void updateLibrary(() => window.electronAPI.deleteSignature(signature.id))
  }

  function stopSignatureManagerDrag(event: React.DragEvent<HTMLElement>) {
    event.stopPropagation()
  }

  function blockSignaturePreviewDrag(event: React.DragEvent<HTMLElement>, signatureId: string) {
    event.stopPropagation()
    event.dataTransfer.setData('application/x-nextpdf-signature', signatureId)
    event.preventDefault()
  }

  const selectedPenSize = PEN_SIZES.find((size) => size.id === penSize) ?? PEN_SIZES[1]
  const selectedPenColor = PEN_COLORS.find((color) => color.id === penColor) ?? PEN_COLORS[0]
  const cursorSize = Math.max(7, selectedPenSize.width * 4)

  return (
    <section
      className="flex h-[calc(100vh-10rem)] min-h-[580px] flex-col overflow-hidden rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl shadow-black/35"
      onDragEnter={stopSignatureManagerDrag}
      onDragOver={stopSignatureManagerDrag}
      onDragLeave={stopSignatureManagerDrag}
      onDrop={stopSignatureManagerDrag}
    >
      <header className="flex flex-wrap items-center gap-3 border-b border-slate-700 bg-gradient-to-r from-slate-950 to-slate-900 px-5 py-4">
        <div className="min-w-56">
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-blue-300">PDF Tools</p>
          <h1 className="mt-1 text-xl font-semibold text-white">Signature Manager</h1>
        </div>
        <p className="rounded-full border border-emerald-500/30 bg-emerald-950/30 px-3 py-1 text-xs font-semibold text-emerald-200">Signatures are stored locally on this device.</p>
        <button type="button" onClick={onClose} className="workspace-secondary-button ml-auto">Close</button>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(420px,0.9fr)_minmax(420px,1.1fr)] max-xl:grid-cols-1">
        <div className="min-h-0 overflow-y-auto border-r border-slate-700 bg-[#0f172a] p-4 max-xl:border-r-0 max-xl:border-b">
          <div className="mb-4 flex gap-1 rounded-xl border border-slate-700 bg-slate-950/70 p-1">
            {[
              ['draw', 'Draw signature'],
              ['upload', 'Upload image'],
              ['type', 'Type signature'],
            ].map(([id, label]) => <button key={id} type="button" onClick={() => setActiveTab(id as typeof activeTab)} className={`flex-1 rounded-lg px-3 py-2 text-xs font-semibold ${activeTab === id ? 'bg-blue-500/15 text-blue-100 ring-1 ring-blue-400/40' : 'text-slate-400 hover:bg-slate-800 hover:text-slate-100'}`}>{label}</button>)}
          </div>

          {error ? <p className="mb-3 rounded-lg border border-red-500/40 bg-red-950/50 p-3 text-sm text-red-100">{error}</p> : null}
          {status ? <p className="mb-3 rounded-lg border border-emerald-500/40 bg-emerald-950/30 p-3 text-sm text-emerald-100">{status}</p> : null}

          {activeTab === 'draw' ? (
            <div>
              <div className="mb-3 rounded-2xl border border-slate-700 bg-slate-950/70 p-3">
                <div className="flex flex-wrap items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">Pen size</p>
                    <div className="flex flex-wrap gap-1.5">
                      {PEN_SIZES.map((size) => (
                        <button
                          key={size.id}
                          type="button"
                          onClick={() => setPenSize(size.id)}
                          className={`rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-colors duration-150 ${
                            penSize === size.id
                              ? 'border-blue-300 bg-blue-500/20 text-blue-100'
                              : 'border-slate-700 bg-slate-900 text-slate-300 hover:border-slate-500 hover:bg-slate-800'
                          }`}
                        >
                          <span className="flex items-center gap-2">
                            <PenSizeIcon width={size.width} />
                            <span>{size.label}</span>
                            <span className="font-normal text-slate-500">({size.width}px)</span>
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                  <label className="reference-label w-36">Color
                    <select value={penColor} onChange={(event) => setPenColor(event.target.value as PenColorId)} className="dashboard-input mt-1">
                      {PEN_COLORS.map((color) => <option key={color.id} value={color.id}>{color.label}</option>)}
                    </select>
                  </label>
                  <label className="reference-label w-36">Guide
                    <select value={guideMode} onChange={(event) => setGuideMode(event.target.value as GuideMode)} className="dashboard-input mt-1">
                      {GUIDE_OPTIONS.map((guide) => <option key={guide.id} value={guide.id}>{guide.label}</option>)}
                    </select>
                  </label>
                </div>
              </div>

              <div className="grid gap-3 2xl:grid-cols-[minmax(0,1fr)_220px]">
                <div className="relative h-60 overflow-hidden rounded-2xl border border-slate-700 bg-white shadow-inner" style={guideBackgroundStyle(guideMode)}>
                  <canvas
                    ref={canvasRef}
                    width={DRAW_CANVAS_WIDTH}
                    height={DRAW_CANVAS_HEIGHT}
                    onPointerDown={startDraw}
                    onPointerEnter={updateCursorPreview}
                    onPointerMove={continueDraw}
                    onPointerUp={stopDraw}
                    onPointerCancel={stopDraw}
                    onPointerLeave={() => setCursorPreview((current) => ({ ...current, visible: false }))}
                    className="h-full w-full touch-none bg-transparent"
                  />
                  {cursorPreview.visible ? (
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute rounded-full border opacity-80 shadow-sm"
                      style={{
                        borderColor: selectedPenColor.value,
                        height: cursorSize,
                        left: cursorPreview.x - cursorSize / 2,
                        top: cursorPreview.y - cursorSize / 2,
                        width: cursorSize,
                      }}
                    />
                  ) : null}
                </div>

                <div className="rounded-2xl border border-slate-700 bg-slate-950/60 p-3">
                  <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">Live preview</p>
                  <div className="mt-3 grid h-24 place-items-center rounded-xl border border-slate-700 bg-white/95 p-3">
                    {drawPreviewDataUrl ? (
                      <img src={drawPreviewDataUrl} alt="Drawn signature preview" draggable={false} className="max-h-full max-w-full object-contain" />
                    ) : (
                      <span className="text-xs text-slate-400">Draw to preview</span>
                    )}
                  </div>
                  <p className="mt-3 text-xs leading-5 text-slate-500">
                    Export uses a transparent high-resolution PNG with automatic trim and padding.
                  </p>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <button type="button" onClick={undoStroke} disabled={!strokes.length || busy} className="workspace-secondary-button">Undo last stroke</button>
                <button type="button" onClick={clearDrawnSignature} disabled={!strokes.length || busy} className="workspace-secondary-button">Clear</button>
                <button type="button" onClick={() => void saveDrawnSignature()} disabled={!strokes.length || busy} className="workspace-primary-button">Save Signature</button>
              </div>
            </div>
          ) : null}

          {activeTab === 'upload' ? (
            <div>
              <div className="grid min-h-56 place-items-center rounded-2xl border border-dashed border-slate-700 bg-slate-950/60 p-5">
                {upload ? <img src={upload.imageDataUrl} alt="Uploaded signature preview" draggable={false} onDragStart={(event) => blockSignaturePreviewDrag(event, 'upload-preview')} className="max-h-48 max-w-full rounded-lg bg-white/90 p-3" /> : <p className="text-center text-sm text-slate-400">Upload PNG, JPG, JPEG, or WEBP. Transparent PNG works best. Whitespace is trimmed when possible.</p>}
              </div>
              {upload ? <p className="mt-2 text-xs text-slate-500">{upload.width} x {upload.height}px</p> : null}
              <div className="mt-3 flex flex-wrap gap-2">
                <button type="button" onClick={() => void pickUpload()} disabled={busy} className="workspace-secondary-button">Choose Image</button>
                <button type="button" onClick={() => void saveUploadedSignature()} disabled={!upload || busy} className="workspace-primary-button">Save Signature</button>
              </div>
            </div>
          ) : null}

          {activeTab === 'type' ? (
            <div>
              <label className="reference-label">Name<input value={typedName} onChange={(event) => setTypedName(event.target.value)} className="dashboard-input mt-1" placeholder="Type your name" /></label>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <label className="reference-label">Font<select value={typedFont} onChange={(event) => setTypedFont(event.target.value)} className="dashboard-input mt-1">{TYPE_FONTS.map((font) => <option key={font.id} value={font.id}>{font.label}</option>)}</select></label>
                <label className="reference-label">Color<select value={typedColor} onChange={(event) => setTypedColor(event.target.value)} className="dashboard-input mt-1">{COLORS.map((color) => <option key={color.id} value={color.id}>{color.label}</option>)}</select></label>
              </div>
              <div className="mt-4 grid min-h-44 place-items-center rounded-2xl border border-slate-700 bg-white/95 p-5">
                <span style={{ fontFamily: TYPE_FONTS.find((font) => font.id === typedFont)?.css, color: typedColor }} className="text-5xl">{typedName || 'Signature'}</span>
              </div>
              <button type="button" onClick={() => void saveTypedSignature()} disabled={!typedName.trim() || busy} className="workspace-primary-button mt-3">Save Signature</button>
            </div>
          ) : null}
        </div>

        <aside className="min-h-0 overflow-y-auto bg-slate-950/45 p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-white">Signature Library</h2>
            <span className="text-xs text-slate-500">{signatures.length} saved</span>
          </div>
          {signatures.length ? (
            <div className="grid grid-cols-2 gap-3 2xl:grid-cols-3">
              {signatures.map((signature) => (
                <article key={signature.id} draggable={false} onDragStart={(event) => blockSignaturePreviewDrag(event, signature.id)} className={`rounded-2xl border bg-slate-900 p-3 ${signature.isDefault ? 'border-blue-400 shadow-lg shadow-blue-950/30' : 'border-slate-700'}`}>
                  <div className="grid h-32 place-items-center rounded-xl border border-slate-700 bg-white/95 p-3">
                    <img src={signature.imageDataUrl} alt={signature.name} draggable={false} onDragStart={(event) => blockSignaturePreviewDrag(event, signature.id)} className="max-h-full max-w-full object-contain" />
                  </div>
                  <div className="mt-3 flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-slate-100" title={signature.name}>{signature.name}</p>
                      <p className="mt-1 text-[10px] uppercase text-slate-500">{signature.type} | {new Date(signature.createdAt).toLocaleDateString()}</p>
                    </div>
                    {signature.isDefault ? <span className="rounded-full bg-blue-500/15 px-2 py-1 text-[10px] font-bold text-blue-200">Default</span> : null}
                  </div>
                  <div className="mt-3 flex flex-wrap gap-1">
                    <button type="button" disabled={busy} onClick={() => renameSignature(signature)} className="merge-tool-button">Rename</button>
                    <button type="button" disabled={busy} onClick={() => void updateLibrary(() => window.electronAPI.duplicateSignature(signature.id))} className="merge-tool-button">Duplicate</button>
                    <button type="button" disabled={busy || signature.isDefault} onClick={() => void updateLibrary(() => window.electronAPI.setDefaultSignature(signature.id))} className="merge-tool-button">Set Default</button>
                    <button type="button" disabled={busy} onClick={() => deleteSignature(signature)} className="merge-tool-button text-red-200 hover:border-red-400">Delete</button>
                  </div>
                </article>
              ))}
            </div>
          ) : <p className="rounded-xl border border-dashed border-slate-700 bg-slate-900/50 p-8 text-center text-sm text-slate-500">No saved signatures yet.</p>}
        </aside>
      </div>
    </section>
  )
}

function renderTypedSignature(name: string, fontId: string, color: string) {
  const font = TYPE_FONTS.find((item) => item.id === fontId)?.css ?? TYPE_FONTS[0].css
  const canvas = document.createElement('canvas')
  canvas.width = 900
  canvas.height = 260
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Could not create typed signature image.')
  context.clearRect(0, 0, canvas.width, canvas.height)
  context.fillStyle = color
  context.font = `96px ${font}`
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.fillText(name, canvas.width / 2, canvas.height / 2)
  return canvas.toDataURL('image/png')
}

function readSignaturePenSettings() {
  try {
    const settings = JSON.parse(localStorage.getItem(SIGNATURE_PEN_SETTINGS_KEY) ?? '{}') as Record<string, unknown>
    return {
      penSize: isPenSizeId(settings.penSize) ? settings.penSize : DEFAULT_PEN_SETTINGS.penSize,
      penColor: isPenColorId(settings.penColor) ? settings.penColor : DEFAULT_PEN_SETTINGS.penColor,
      guideMode: isGuideMode(settings.guideMode) ? settings.guideMode : DEFAULT_PEN_SETTINGS.guideMode,
    }
  } catch {
    localStorage.removeItem(SIGNATURE_PEN_SETTINGS_KEY)
    return DEFAULT_PEN_SETTINGS
  }
}

function PenSizeIcon({ width }: { width: number }) {
  return (
    <svg viewBox="0 0 34 14" className="h-4 w-8 shrink-0" fill="none" aria-hidden="true">
      <path
        d="M3 9.5c5-6 10 2 14-2s7-5 14-1"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={Math.max(1, width * 1.4)}
      />
    </svg>
  )
}

function isPenSizeId(value: unknown): value is PenSizeId {
  return PEN_SIZES.some((size) => size.id === value)
}

function isPenColorId(value: unknown): value is PenColorId {
  return PEN_COLORS.some((color) => color.id === value)
}

function isGuideMode(value: unknown): value is GuideMode {
  return GUIDE_OPTIONS.some((guide) => guide.id === value)
}

function drawSignatureStroke(context: CanvasRenderingContext2D, stroke: SignatureStroke) {
  const points = stroke.points
  if (points.length === 0) return

  context.strokeStyle = stroke.color
  context.fillStyle = stroke.color
  context.lineCap = 'round'
  context.lineJoin = 'round'

  if (points.length === 1) {
    const point = points[0]
    context.beginPath()
    context.arc(point.x, point.y, point.width / 2, 0, Math.PI * 2)
    context.fill()
    return
  }

  let previous = points[0]
  for (let index = 1; index < points.length; index += 1) {
    const current = points[index]
    const next = points[index + 1]
    const end = next ? midpoint(current, next) : current
    context.beginPath()
    context.lineWidth = Math.max(0.5, (previous.width + current.width) / 2)
    context.moveTo(previous.x, previous.y)
    context.quadraticCurveTo(current.x, current.y, end.x, end.y)
    context.stroke()
    previous = { ...end, time: current.time, width: current.width }
  }
}

function midpoint(left: StrokePoint, right: StrokePoint) {
  return {
    x: (left.x + right.x) / 2,
    y: (left.y + right.y) / 2,
  }
}

function velocityAdjustedWidth(baseWidth: number, velocity: number) {
  const velocityFactor = Math.min(1, velocity / 5)
  return clamp(baseWidth * (1.28 - velocityFactor * 0.48), baseWidth * 0.62, baseWidth * 1.38)
}

function trimTransparentCanvas(source: HTMLCanvasElement) {
  const context = source.getContext('2d', { willReadFrequently: true })
  if (!context) return source.toDataURL('image/png')

  const { width, height } = source
  const imageData = context.getImageData(0, 0, width, height)
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const alpha = imageData.data[(y * width + x) * 4 + 3]
      if (alpha > 8) {
        minX = Math.min(minX, x)
        minY = Math.min(minY, y)
        maxX = Math.max(maxX, x)
        maxY = Math.max(maxY, y)
      }
    }
  }

  if (maxX < minX || maxY < minY) {
    return source.toDataURL('image/png')
  }

  const cropX = Math.max(0, minX - TRIM_PADDING)
  const cropY = Math.max(0, minY - TRIM_PADDING)
  const cropWidth = Math.min(width - cropX, maxX - minX + TRIM_PADDING * 2)
  const cropHeight = Math.min(height - cropY, maxY - minY + TRIM_PADDING * 2)
  const output = document.createElement('canvas')
  output.width = cropWidth
  output.height = cropHeight
  output.getContext('2d')?.drawImage(source, cropX, cropY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight)
  return output.toDataURL('image/png')
}

function guideBackgroundStyle(mode: GuideMode) {
  if (mode === 'baseline') {
    return {
      backgroundImage: 'linear-gradient(to bottom, transparent 68%, rgba(59,130,246,0.18) 68.5%, transparent 69%)',
      backgroundSize: '100% 100%',
    }
  }

  if (mode === 'grid') {
    return {
      backgroundImage:
        'linear-gradient(rgba(15,23,42,0.08) 1px, transparent 1px), linear-gradient(90deg, rgba(15,23,42,0.08) 1px, transparent 1px), linear-gradient(to bottom, transparent 68%, rgba(59,130,246,0.18) 68.5%, transparent 69%)',
      backgroundSize: '28px 28px, 28px 28px, 100% 100%',
    }
  }

  return undefined
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function message(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason)
}
