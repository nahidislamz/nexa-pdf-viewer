import type { HighlightColor } from '../../types/highlights'

const COLORS: Array<{ color: HighlightColor; label: string; className: string }> = [
  { color: 'yellow', label: 'Amber', className: 'border-amber-200 bg-amber-300' },
  { color: 'green', label: 'Mint', className: 'border-emerald-200 bg-emerald-300' },
  { color: 'blue', label: 'Sky Blue', className: 'border-sky-200 bg-sky-300' },
  { color: 'purple', label: 'Purple', className: 'border-violet-200 bg-violet-300' },
]

export function HighlightSelectionToolbar({
  x,
  y,
  onHighlight,
  onRemove,
  onClose,
}: {
  x: number
  y: number
  onHighlight: (color: HighlightColor) => void
  onRemove: () => void
  onClose: () => void
}) {
  return (
    <div
      data-highlight-toolbar=""
      role="toolbar"
      aria-label="Text highlight colors"
      onPointerDown={(event) => event.preventDefault()}
      className="fixed z-[80] flex h-11 items-center gap-1 rounded-xl border border-slate-600 bg-slate-900/95 p-1.5 shadow-2xl shadow-black/50 backdrop-blur"
      style={{ left: x, top: y, transform: 'translateX(-50%)' }}
    >
      {COLORS.map(({ color, label, className }) => (
        <button
          key={color}
          type="button"
          aria-label={`Highlight ${label}`}
          title={`Highlight ${label}`}
          onClick={() => onHighlight(color)}
          className="grid size-8 place-items-center rounded-lg hover:bg-slate-700"
        >
          <span className={`size-5 rounded-full border-2 ${className}`} />
        </button>
      ))}
      <span aria-hidden="true" className="mx-1 h-6 w-px bg-slate-600" />
      <button
        type="button"
        title="Remove overlapping highlights"
        onClick={onRemove}
        className="h-8 rounded-lg px-2 text-xs font-medium text-red-200 hover:bg-red-500/20"
      >
        Remove
      </button>
      <button
        type="button"
        aria-label="Close highlight toolbar"
        title="Close"
        onClick={onClose}
        className="grid size-8 place-items-center rounded-lg text-lg leading-none text-slate-400 hover:bg-slate-700 hover:text-white"
      >
        &times;
      </button>
    </div>
  )
}
