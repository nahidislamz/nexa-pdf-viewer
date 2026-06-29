import { memo, useEffect, useRef } from 'react'
import type { FillSignColor, FillSignDateFormat, FillSignField, FillSignTool } from '../../types/signatures'

type ResizeCorner = 'nw' | 'ne' | 'sw' | 'se'
type PointerMode = 'move' | ResizeCorner

const DEFAULT_FIELD_COLOR: FillSignColor = 'black'

export const FillSignOverlay = memo(function FillSignOverlay({
  pageNumber,
  pageRotation,
  fields,
  activeTool,
  selectedFieldId,
  dateFormat,
  initials,
  onPlace,
  onSelect,
  onUpdate,
  onDelete,
  onDuplicate,
  onFinishTool,
}: {
  pageNumber: number
  pageRotation: number
  fields: FillSignField[]
  activeTool: FillSignTool | null
  selectedFieldId: string | null
  dateFormat: FillSignDateFormat
  initials: string
  onPlace: (field: FillSignField) => void
  onSelect: (fieldId: string | null) => void
  onUpdate: (fieldId: string, patch: Partial<FillSignField>) => void
  onDelete: (fieldId: string) => void
  onDuplicate: (fieldId: string) => void
  onFinishTool: () => void
}) {
  const overlayRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{
    pointerId: number
    mode: PointerMode
    field: FillSignField
    startX: number
    startY: number
    bounds: DOMRect
  } | null>(null)

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

  function placeField(event: React.PointerEvent<HTMLDivElement>) {
    if (!activeTool) return
    const point = pagePoint(event)
    if (!point) return
    event.preventDefault()
    event.stopPropagation()

    const fieldSize = defaultFieldSize(activeTool)
    const x = clamp(point.x - fieldSize.width / 2, 0, 1 - fieldSize.width)
    const y = clamp(point.y - fieldSize.height / 2, 0, 1 - fieldSize.height)
    const field: FillSignField = {
      id: window.crypto.randomUUID(),
      documentId: '',
      pageNumber,
      type: activeTool,
      text: defaultFieldText(activeTool, dateFormat, initials),
      checked: activeTool === 'checkbox',
      x,
      y,
      width: fieldSize.width,
      height: fieldSize.height,
      xRatio: x,
      yRatio: y,
      widthRatio: fieldSize.width,
      heightRatio: fieldSize.height,
      pageRotation,
      fontSize: activeTool === 'checkbox' ? 16 : 14,
      color: DEFAULT_FIELD_COLOR,
      dateFormat: activeTool === 'date' ? dateFormat : undefined,
      createdAt: new Date().toISOString(),
    }
    onPlace(field)
    onFinishTool()
  }

  function startPointerAction(
    event: React.PointerEvent<HTMLElement>,
    field: FillSignField,
    mode: PointerMode,
  ) {
    const bounds = overlayRef.current?.getBoundingClientRect()
    if (!bounds) return
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    onSelect(field.id)
    dragRef.current = {
      pointerId: event.pointerId,
      mode,
      field,
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
    const box = fieldBox(drag.field)

    if (drag.mode === 'move') {
      const x = clamp(box.x + deltaX, 0, 1 - box.width)
      const y = clamp(box.y + deltaY, 0, 1 - box.height)
      onUpdate(drag.field.id, ratioPatch({ x, y, width: box.width, height: box.height }))
      return
    }

    const resized = resizeBox(box, drag.mode, deltaX, deltaY, event.shiftKey || drag.field.type === 'checkbox')
    onUpdate(drag.field.id, ratioPatch(resized))
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
      data-fill-sign-overlay=""
      onPointerDown={placeField}
      onPointerMove={movePointerAction}
      onPointerUp={stopPointerAction}
      onPointerCancel={stopPointerAction}
      className={`absolute left-1/2 top-0 z-40 -translate-x-1/2 overflow-visible ${
        activeTool ? 'pointer-events-auto cursor-text' : 'pointer-events-none'
      }`}
    >
      {fields.map((field) => {
        const box = fieldBox(field)
        const selected = selectedFieldId === field.id
        const toolbarCenter = clamp(box.x + box.width / 2, 0.12, 0.88)
        const toolbarLeft = ((toolbarCenter - box.x) / Math.max(box.width, 0.001)) * 100
        const toolbarBelow = box.y < 0.1
        return (
          <div
            key={field.id}
            data-fill-sign-field-id={field.id}
            onPointerDown={(event) => startPointerAction(event, field, 'move')}
            className={`absolute pointer-events-auto touch-none rounded-[3px] transition-[border-color,box-shadow] duration-150 ${
              selected
                ? 'cursor-move border border-cyan-400/80 shadow-[0_0_0_1px_rgba(34,211,238,0.18),0_6px_18px_rgba(15,23,42,0.16)]'
                : 'cursor-grab border border-transparent hover:border-cyan-300/45'
            }`}
            style={{
              left: `${box.x * 100}%`,
              top: `${box.y * 100}%`,
              width: `${box.width * 100}%`,
              height: `${box.height * 100}%`,
            }}
          >
            <FieldContent field={field} selected={selected} onUpdate={onUpdate} />

            {selected ? (
              <>
                <ResizeHandle corner="nw" onPointerDown={(event) => startPointerAction(event, field, 'nw')} />
                <ResizeHandle corner="ne" onPointerDown={(event) => startPointerAction(event, field, 'ne')} />
                <ResizeHandle corner="sw" onPointerDown={(event) => startPointerAction(event, field, 'sw')} />
                <ResizeHandle corner="se" onPointerDown={(event) => startPointerAction(event, field, 'se')} />
                <div
                  data-fill-sign-toolbar=""
                  className={`absolute flex max-w-[min(520px,88vw)] -translate-x-1/2 items-center gap-1 rounded-full border border-slate-600/80 bg-slate-950/95 p-1.5 text-slate-100 shadow-xl shadow-black/30 backdrop-blur-md ${
                    toolbarBelow ? 'top-full translate-y-2' : 'top-0 -translate-y-[calc(100%+10px)]'
                  }`}
                  style={{ left: `${toolbarLeft}%` }}
                  onPointerDown={(event) => event.stopPropagation()}
                >
                  <FillToolButton label="Duplicate field" onClick={() => onDuplicate(field.id)}>
                    <DuplicateIcon />
                  </FillToolButton>
                  <FillToolButton label="Delete field" onClick={() => onDelete(field.id)} danger>
                    <TrashIcon />
                  </FillToolButton>
                  {field.type === 'checkbox' ? (
                    <button
                      type="button"
                      onClick={() => onUpdate(field.id, { checked: !field.checked })}
                      className="h-8 rounded-full px-3 text-xs font-semibold text-slate-200 hover:bg-slate-700/80"
                    >
                      {field.checked ? 'Checked' : 'Unchecked'}
                    </button>
                  ) : (
                    <>
                      <ToolbarDivider />
                      <select
                        value={field.fontSize}
                        onChange={(event) => onUpdate(field.id, { fontSize: Number(event.target.value) })}
                        className="h-8 rounded-full border border-slate-700 bg-slate-900 px-2 text-xs font-semibold text-slate-200 outline-none"
                        aria-label="Font size"
                      >
                        {[10, 12, 14, 16, 18, 20, 24, 28, 32].map((size) => (
                          <option key={size} value={size}>{size}px</option>
                        ))}
                      </select>
                      <ColorButton color="black" selected={field.color === 'black'} onClick={() => onUpdate(field.id, { color: 'black' })} />
                      <ColorButton color="blue" selected={field.color === 'blue'} onClick={() => onUpdate(field.id, { color: 'blue' })} />
                      <ColorButton color="dark-gray" selected={field.color === 'dark-gray'} onClick={() => onUpdate(field.id, { color: 'dark-gray' })} />
                    </>
                  )}
                </div>
              </>
            ) : null}
          </div>
        )
      })}
    </div>
  )
})

function FieldContent({
  field,
  selected,
  onUpdate,
}: {
  field: FillSignField
  selected: boolean
  onUpdate: (fieldId: string, patch: Partial<FillSignField>) => void
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (selected && field.type !== 'checkbox') {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [field.type, selected])
  const color = fillColor(field.color)
  if (field.type === 'checkbox') {
    return (
      <button
        type="button"
        title="Toggle checkbox"
        onPointerDown={(event) => {
          if (selected) event.stopPropagation()
        }}
        onClick={() => {
          if (selected) onUpdate(field.id, { checked: !field.checked })
        }}
        className="grid h-full w-full place-items-center rounded border-2 border-slate-900 bg-white/10 text-slate-950"
      >
        {field.checked ? (
          <svg viewBox="0 0 24 24" className="h-[85%] w-[85%]" fill="none" aria-hidden="true">
            <path d="m5 12 4 4 10-10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : null}
      </button>
    )
  }

  return (
    <textarea
      ref={inputRef}
      value={field.text}
      readOnly={!selected}
      onPointerDown={(event) => {
        if (selected) event.stopPropagation()
      }}
      onKeyDown={(event) => event.stopPropagation()}
      onChange={(event) => onUpdate(field.id, { text: event.target.value })}
      className="h-full w-full resize-none overflow-hidden rounded bg-transparent px-1 py-0.5 leading-tight outline-none read-only:cursor-grab read-write:cursor-text"
      style={{ color, fontSize: `${field.fontSize}px` }}
      spellCheck={false}
    />
  )
}

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
      className={`absolute size-2.5 rounded-full border border-white bg-cyan-400 shadow-[0_1px_4px_rgba(15,23,42,0.35)] ring-1 ring-cyan-500/40 ${position}`}
      onPointerDown={onPointerDown}
      title="Resize field"
    />
  )
}

function FillToolButton({
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

function ColorButton({
  color,
  selected,
  onClick,
}: {
  color: FillSignColor
  selected: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-label={`Set color ${color}`}
      title={`Set color ${color}`}
      onClick={onClick}
      className={`size-6 rounded-full border transition-transform duration-150 ${selected ? 'scale-110 border-white' : 'border-slate-600'}`}
      style={{ backgroundColor: fillColor(color) }}
    />
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

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" fill="none" aria-hidden="true">
      <path d="M7 8h10M10 8V6h4v2M9 11v6M12 11v6M15 11v6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8 8l.7 11h6.6L16 8" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
    </svg>
  )
}

function defaultFieldSize(tool: FillSignTool) {
  if (tool === 'checkbox') return { width: 0.035, height: 0.035 }
  if (tool === 'initials') return { width: 0.12, height: 0.04 }
  if (tool === 'date') return { width: 0.18, height: 0.04 }
  return { width: 0.26, height: 0.06 }
}

function defaultFieldText(tool: FillSignTool, dateFormat: FillSignDateFormat, initials: string) {
  if (tool === 'date') return formatDate(new Date(), dateFormat)
  if (tool === 'initials') return initials || 'Initials'
  if (tool === 'checkbox') return ''
  return 'Text'
}

function formatDate(date: Date, format: FillSignDateFormat) {
  const day = String(date.getDate()).padStart(2, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const year = String(date.getFullYear())
  if (format === 'MM/DD/YYYY') return `${month}/${day}/${year}`
  if (format === 'YYYY-MM-DD') return `${year}-${month}-${day}`
  return `${day}/${month}/${year}`
}

function fieldBox(field: FillSignField) {
  return {
    x: field.xRatio ?? field.x,
    y: field.yRatio ?? field.y,
    width: field.widthRatio ?? field.width,
    height: field.heightRatio ?? field.height,
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

  width = clamp(width, 0.015, 0.9)
  height = clamp(height, 0.015, 0.6)

  if (keepAspect) {
    const aspect = box.height / Math.max(box.width, 0.001)
    height = clamp(width * aspect, 0.015, 0.6)
    if (corner.includes('n')) y = box.y + box.height - height
  }

  x = clamp(x, 0, 1 - width)
  y = clamp(y, 0, 1 - height)
  return { x, y, width, height }
}

function fillColor(color: FillSignColor) {
  if (color === 'blue') return '#1d4ed8'
  if (color === 'dark-gray') return '#374151'
  return '#111827'
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}
