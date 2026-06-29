import { memo, useEffect, useMemo, useRef } from 'react'
import type { SavedSignature, SignaturePlacement } from '../../types/signatures'

type ResizeCorner = 'nw' | 'ne' | 'sw' | 'se'
type PointerMode = 'move' | ResizeCorner

export const SignaturePlacementOverlay = memo(function SignaturePlacementOverlay({
  pageNumber,
  pageRotation,
  placements,
  signatures,
  signingSignature,
  selectedPlacementId,
  onPlace,
  onSelect,
  onUpdate,
  onDelete,
  onDuplicate,
  onBringForward,
  onSendBackward,
  onFinishSigning,
}: {
  pageNumber: number
  pageRotation: number
  placements: SignaturePlacement[]
  signatures: SavedSignature[]
  signingSignature: SavedSignature | null
  selectedPlacementId: string | null
  onPlace: (placement: SignaturePlacement) => void
  onSelect: (placementId: string | null) => void
  onUpdate: (placementId: string, patch: Partial<SignaturePlacement>) => void
  onDelete: (placementId: string) => void
  onDuplicate: (placementId: string) => void
  onBringForward: (placementId: string) => void
  onSendBackward: (placementId: string) => void
  onFinishSigning: () => void
}) {
  const overlayRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{
    pointerId: number
    mode: PointerMode
    placement: SignaturePlacement
    startX: number
    startY: number
    bounds: DOMRect
  } | null>(null)

  const signaturesById = useMemo(
    () => new Map(signatures.map((signature) => [signature.id, signature])),
    [signatures],
  )

  useEffect(() => {
    const overlay = overlayRef.current
    const container = overlay?.parentElement
    if (!overlay || !container) return
    const activeOverlay = overlay
    const activeContainer = container

    let page: HTMLElement | null = null
    let resizeObserver: ResizeObserver | null = null

    function syncToPage() {
      const nextPage = activeContainer.querySelector<HTMLElement>('.react-pdf__Page')
      if (!nextPage) return
      if (page !== nextPage) {
        resizeObserver?.disconnect()
        page = nextPage
        resizeObserver = new ResizeObserver(syncToPage)
        resizeObserver.observe(page)
      }
      activeOverlay.style.width = `${page.offsetWidth}px`
      activeOverlay.style.height = `${page.offsetHeight}px`
    }

    const mutationObserver = new MutationObserver(syncToPage)
    mutationObserver.observe(activeContainer, { childList: true, subtree: true })
    syncToPage()

    return () => {
      mutationObserver.disconnect()
      resizeObserver?.disconnect()
    }
  }, [])

  function pagePoint(event: React.PointerEvent) {
    const bounds = overlayRef.current?.getBoundingClientRect()
    if (!bounds) return null
    return {
      bounds,
      x: clamp((event.clientX - bounds.left) / bounds.width, 0, 1),
      y: clamp((event.clientY - bounds.top) / bounds.height, 0, 1),
    }
  }

  function placeSignature(event: React.PointerEvent<HTMLDivElement>) {
    if (!signingSignature) return
    const point = pagePoint(event)
    if (!point) return
    event.preventDefault()
    event.stopPropagation()

    const widthRatio = 0.28
    const heightRatio = signingSignature.width > 0
      ? widthRatio * (signingSignature.height / signingSignature.width) * (point.bounds.width / point.bounds.height)
      : 0.08
    const width = clamp(widthRatio, 0.08, 0.65)
    const height = clamp(heightRatio, 0.035, 0.35)
    const x = clamp(point.x - width / 2, 0, 1 - width)
    const y = clamp(point.y - height / 2, 0, 1 - height)
    const placement: SignaturePlacement = {
      id: window.crypto.randomUUID(),
      signatureId: signingSignature.id,
      documentId: '',
      pageNumber,
      x,
      y,
      width,
      height,
      xRatio: x,
      yRatio: y,
      widthRatio: width,
      heightRatio: height,
      pageRotation,
      rotation: 0,
      opacity: 1,
      createdAt: new Date().toISOString(),
    }
    onPlace(placement)
    onFinishSigning()
  }

  function startPointerAction(
    event: React.PointerEvent<HTMLElement>,
    placement: SignaturePlacement,
    mode: PointerMode,
  ) {
    const bounds = overlayRef.current?.getBoundingClientRect()
    if (!bounds) return
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    onSelect(placement.id)
    dragRef.current = {
      pointerId: event.pointerId,
      mode,
      placement,
      startX: event.clientX,
      startY: event.clientY,
      bounds,
    }
  }

  function movePointerAction(event: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current
    if (!drag) return
    event.preventDefault()
    event.stopPropagation()
    const deltaX = (event.clientX - drag.startX) / drag.bounds.width
    const deltaY = (event.clientY - drag.startY) / drag.bounds.height
    const box = placementBox(drag.placement)

    if (drag.mode === 'move') {
      const x = clamp(box.x + deltaX, 0, 1 - box.width)
      const y = clamp(box.y + deltaY, 0, 1 - box.height)
      onUpdate(drag.placement.id, ratioPatch({ x, y, width: box.width, height: box.height }))
      return
    }

    const resized = resizeBox(box, drag.mode, deltaX, deltaY, event.shiftKey)
    onUpdate(drag.placement.id, ratioPatch(resized))
  }

  function stopPointerAction(event: React.PointerEvent<HTMLDivElement>) {
    if (dragRef.current && event.currentTarget.hasPointerCapture(dragRef.current.pointerId)) {
      event.currentTarget.releasePointerCapture(dragRef.current.pointerId)
    }
    dragRef.current = null
  }

  return (
    <div
      ref={overlayRef}
      data-signature-placement-overlay=""
      onPointerDown={placeSignature}
      onPointerMove={movePointerAction}
      onPointerUp={stopPointerAction}
      onPointerCancel={stopPointerAction}
      className={`absolute left-1/2 top-0 z-30 -translate-x-1/2 overflow-visible ${
        signingSignature ? 'pointer-events-auto cursor-crosshair' : 'pointer-events-none'
      }`}
    >
      {placements.map((placement) => {
        const box = placementBox(placement)
        const signature = signaturesById.get(placement.signatureId)
        const selected = selectedPlacementId === placement.id
        const toolbarCenter = clamp(box.x + box.width / 2, 0.14, 0.86)
        const toolbarLeft = ((toolbarCenter - box.x) / Math.max(box.width, 0.001)) * 100
        const toolbarBelow = box.y < 0.12
        return (
          <div
            key={placement.id}
            data-signature-placement-id={placement.id}
            onPointerDown={(event) => startPointerAction(event, placement, 'move')}
            className={`group absolute pointer-events-auto touch-none rounded-[3px] transition-[border-color,box-shadow] duration-150 ${
              selected
                ? 'cursor-move border border-sky-400/80 shadow-[0_0_0_1px_rgba(14,165,233,0.18),0_6px_18px_rgba(15,23,42,0.16)]'
                : 'cursor-grab border border-transparent hover:border-sky-300/45'
            }`}
            style={{
              left: `${box.x * 100}%`,
              top: `${box.y * 100}%`,
              width: `${box.width * 100}%`,
              height: `${box.height * 100}%`,
              transform: `rotate(${placement.rotation}deg)`,
              transformOrigin: 'center',
            }}
          >
            {signature ? (
              <img
                src={signature.imageDataUrl}
                alt={signature.name}
                draggable={false}
                className="h-full w-full select-none object-contain"
                style={{ opacity: placement.opacity }}
              />
            ) : (
              <div className="grid h-full w-full place-items-center rounded bg-red-950/60 px-2 text-center text-[10px] text-red-100">Missing signature</div>
            )}

            {selected ? (
              <>
                <ResizeHandle corner="nw" onPointerDown={(event) => startPointerAction(event, placement, 'nw')} />
                <ResizeHandle corner="ne" onPointerDown={(event) => startPointerAction(event, placement, 'ne')} />
                <ResizeHandle corner="sw" onPointerDown={(event) => startPointerAction(event, placement, 'sw')} />
                <ResizeHandle corner="se" onPointerDown={(event) => startPointerAction(event, placement, 'se')} />
                <div
                  data-signature-toolbar=""
                  className={`absolute flex max-w-[min(460px,88vw)] -translate-x-1/2 items-center gap-1 rounded-full border border-slate-600/80 bg-slate-950/95 p-1.5 text-slate-100 shadow-xl shadow-black/30 backdrop-blur-md ${
                    toolbarBelow
                      ? 'top-full translate-y-2'
                      : 'top-0 -translate-y-[calc(100%+10px)]'
                  }`}
                  style={{ left: `${toolbarLeft}%` }}
                  onPointerDown={(event) => event.stopPropagation()}
                >
                  <SignatureToolButton label="Duplicate signature" onClick={() => onDuplicate(placement.id)}>
                    <DuplicateIcon />
                  </SignatureToolButton>
                  <SignatureToolButton label="Bring forward" onClick={() => onBringForward(placement.id)}>
                    <BringForwardIcon />
                  </SignatureToolButton>
                  <SignatureToolButton label="Send backward" onClick={() => onSendBackward(placement.id)}>
                    <SendBackwardIcon />
                  </SignatureToolButton>
                  <ToolbarDivider />
                  <SignatureToolButton label="Rotate left" onClick={() => onUpdate(placement.id, { rotation: placement.rotation - 15 })}>
                    <RotateLeftIcon />
                  </SignatureToolButton>
                  <SignatureToolButton label="Rotate right" onClick={() => onUpdate(placement.id, { rotation: placement.rotation + 15 })}>
                    <RotateRightIcon />
                  </SignatureToolButton>
                  <ToolbarDivider />
                  <label className="flex h-8 items-center gap-2 rounded-full px-2 text-slate-300" title={`Opacity ${Math.round(placement.opacity * 100)}%`}>
                    <OpacityIcon />
                    <input type="range" min="0.2" max="1" step="0.05" value={placement.opacity} onChange={(event) => onUpdate(placement.id, { opacity: Number(event.target.value) })} className="signature-opacity-slider w-16" aria-label="Signature opacity" />
                  </label>
                  <ToolbarDivider />
                  <SignatureToolButton label="Delete signature" onClick={() => onDelete(placement.id)} danger>
                    <TrashIcon />
                  </SignatureToolButton>
                </div>
              </>
            ) : null}
          </div>
        )
      })}
    </div>
  )
})

function ResizeHandle({
  corner,
  onPointerDown,
}: {
  corner: ResizeCorner
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void
}) {
  const position =
    corner === 'nw'
      ? '-left-1.5 -top-1.5 cursor-nwse-resize'
      : corner === 'ne'
        ? '-right-1.5 -top-1.5 cursor-nesw-resize'
        : corner === 'sw'
          ? '-left-1.5 -bottom-1.5 cursor-nesw-resize'
          : '-right-1.5 -bottom-1.5 cursor-nwse-resize'
  return (
    <div
      className={`absolute size-2.5 rounded-full border border-white bg-sky-400 shadow-[0_1px_4px_rgba(15,23,42,0.35)] ring-1 ring-sky-500/40 ${position}`}
      onPointerDown={onPointerDown}
      title="Resize signature"
    />
  )
}

function SignatureToolButton({
  children,
  label,
  onClick,
  danger = false,
}: {
  children: React.ReactNode
  label: string
  onClick: () => void
  danger?: boolean
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`grid size-8 place-items-center rounded-full transition-colors duration-150 ${
        danger
          ? 'text-red-200 hover:bg-red-500/15 hover:text-red-100'
          : 'text-slate-200 hover:bg-slate-700/80 hover:text-white'
      }`}
    >
      {children}
    </button>
  )
}

function ToolbarDivider() {
  return <span className="mx-0.5 h-5 w-px bg-slate-700/90" aria-hidden="true" />
}

function DuplicateIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" fill="none" aria-hidden="true">
      <path d="M8 8.5h8.5V17H8z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M5.5 14.5V5.5h9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function BringForwardIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" fill="none" aria-hidden="true">
      <path d="M8 7h8v8H8z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
      <path d="M5 10h3v5h5v3H5z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" opacity="0.55" />
      <path d="m15.5 4.5 2.5 2.5-2.5 2.5M18 7h-5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function SendBackwardIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" fill="none" aria-hidden="true">
      <path d="M8 7h8v8H8z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" opacity="0.55" />
      <path d="M5 10h8v8H5z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
      <path d="m8.5 4.5-2.5 2.5 2.5 2.5M6 7h5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function RotateLeftIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" fill="none" aria-hidden="true">
      <path d="M7 7h4V3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M7.6 7.6A7 7 0 1 1 5 13" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

function RotateRightIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" fill="none" aria-hidden="true">
      <path d="M17 7h-4V3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M16.4 7.6A7 7 0 1 0 19 13" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

function OpacityIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4 text-slate-300" fill="none" aria-hidden="true">
      <path d="M12 3.5s6 6.1 6 10.2a6 6 0 0 1-12 0C6 9.6 12 3.5 12 3.5Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
      <path d="M12 19.5v-16" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" opacity="0.55" />
    </svg>
  )
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" fill="none" aria-hidden="true">
      <path d="M7 8h10M10 8V6h4v2M9 11v6M12 11v6M15 11v6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8 8l.7 11h6.6L16 8" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
    </svg>
  )
}

function placementBox(placement: SignaturePlacement) {
  return {
    x: placement.xRatio ?? placement.x,
    y: placement.yRatio ?? placement.y,
    width: placement.widthRatio ?? placement.width,
    height: placement.heightRatio ?? placement.height,
  }
}

function ratioPatch(box: { x: number; y: number; width: number; height: number }) {
  return {
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    xRatio: box.x,
    yRatio: box.y,
    widthRatio: box.width,
    heightRatio: box.height,
  }
}

function resizeBox(
  box: { x: number; y: number; width: number; height: number },
  corner: ResizeCorner,
  deltaX: number,
  deltaY: number,
  keepAspect: boolean,
) {
  let x = box.x
  let y = box.y
  let width = box.width
  let height = box.height

  if (corner.includes('e')) width += deltaX
  if (corner.includes('s')) height += deltaY
  if (corner.includes('w')) {
    x += deltaX
    width -= deltaX
  }
  if (corner.includes('n')) {
    y += deltaY
    height -= deltaY
  }

  width = clamp(width, 0.04, 0.9)
  height = clamp(height, 0.02, 0.6)

  if (keepAspect) {
    const aspect = box.height / Math.max(box.width, 0.001)
    height = clamp(width * aspect, 0.02, 0.6)
    if (corner.includes('n')) y = box.y + box.height - height
  }

  x = clamp(x, 0, 1 - width)
  y = clamp(y, 0, 1 - height)
  return { x, y, width, height }
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}
