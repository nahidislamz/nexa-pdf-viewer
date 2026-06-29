import type { PropsWithChildren, ReactNode } from 'react'

type PdfPaneHeaderProps = {
  active: boolean
  paneLabel: string
  fileName?: string | null
  currentPage?: number
  totalPages?: number
  zoomPercent?: number
  onClose?: () => void
}

type PdfPaneToolbarProps = {
  active: boolean
  currentPage: number
  totalPages: number
  pageInput: string
  zoomPercent: number
  fitActive: boolean
  searchActive: boolean
  panelsActive: boolean
  onPageInputChange: (value: string) => void
  onPageSubmit: () => void
  onPreviousPage: () => void
  onNextPage: () => void
  onZoomOut: () => void
  onResetZoom: () => void
  onZoomIn: () => void
  onFitWidth: () => void
  onRotateLeft: () => void
  onRotateRight: () => void
  onSearch: () => void
  onTogglePanels: () => void
}

export function PdfPaneHeader({
  active,
  paneLabel,
  fileName,
  currentPage = 0,
  totalPages = 0,
  zoomPercent = 100,
  onClose,
}: PdfPaneHeaderProps) {
  return (
    <header
      className={`flex h-10 min-h-10 shrink-0 items-center gap-2 rounded-t-xl border-b px-2 text-xs transition-colors duration-200 ${
        active
          ? 'border-blue-400/50 bg-blue-950/35 text-slate-200'
          : 'border-slate-700 bg-slate-950/75 text-slate-400'
      }`}
    >
      <span
        className={`shrink-0 rounded-md px-2 py-1 font-semibold transition-colors duration-200 ${
          active ? 'bg-blue-500/25 text-blue-100' : 'bg-slate-800 text-slate-400'
        }`}
      >
        {paneLabel}
      </span>
      <FileIcon />
      <span
        title={fileName ?? 'No document assigned'}
        className={`min-w-0 flex-1 truncate font-medium ${fileName ? '' : 'italic text-slate-500'}`}
      >
        {fileName ?? 'No document assigned'}
      </span>
      {fileName ? (
        <>
          <span aria-hidden="true" className="text-slate-600">|</span>
          <span className="shrink-0">Page {currentPage} of {totalPages}</span>
          <span aria-hidden="true" className="text-slate-600">|</span>
          <span className="w-11 shrink-0 text-right tabular-nums">{zoomPercent}%</span>
        </>
      ) : null}
      {onClose ? (
        <button
          type="button"
          onClick={onClose}
          className="split-pane-button"
          title="Close split view"
          aria-label="Close split view"
        >
          <CloseIcon />
        </button>
      ) : null}
    </header>
  )
}

export function PdfPaneToolbar({
  active,
  currentPage,
  totalPages,
  pageInput,
  zoomPercent,
  fitActive,
  searchActive,
  panelsActive,
  onPageInputChange,
  onPageSubmit,
  onPreviousPage,
  onNextPage,
  onZoomOut,
  onResetZoom,
  onZoomIn,
  onFitWidth,
  onRotateLeft,
  onRotateRight,
  onSearch,
  onTogglePanels,
}: PdfPaneToolbarProps) {
  return (
    <div
      className={`flex min-h-11 shrink-0 flex-wrap items-center gap-1 border-b border-slate-700 bg-slate-900 px-2 py-1.5 text-xs transition-opacity duration-200 ${
        active ? 'opacity-100' : 'opacity-75'
      }`}
    >
      <IconButton title="Previous page" disabled={currentPage <= 1} onClick={onPreviousPage}>
        <PreviousIcon />
      </IconButton>
      <input
        value={pageInput}
        type="number"
        min="1"
        max={Math.max(1, totalPages)}
        aria-label="Current page"
        onChange={(event) => onPageInputChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') onPageSubmit()
        }}
        className="h-8 w-12 rounded-md border border-slate-700 bg-slate-950 px-1 text-center text-slate-200 tabular-nums outline-none hover:border-slate-600 focus:border-blue-400"
      />
      <IconButton title="Next page" disabled={currentPage >= totalPages} onClick={onNextPage}>
        <NextIcon />
      </IconButton>
      <ToolbarDivider />
      <IconButton title="Zoom out" onClick={onZoomOut}>
        <ZoomOutIcon />
      </IconButton>
      <button type="button" className="split-pane-button min-w-14 tabular-nums" onClick={onResetZoom} title="Reset zoom">
        {zoomPercent}%
      </button>
      <IconButton title="Zoom in" onClick={onZoomIn}>
        <ZoomInIcon />
      </IconButton>
      <IconButton title="Fit width" active={fitActive} onClick={onFitWidth}>
        <FitWidthIcon />
      </IconButton>
      <ToolbarDivider />
      <IconButton title="Rotate left" onClick={onRotateLeft}>
        <RotateLeftIcon />
      </IconButton>
      <IconButton title="Rotate right" onClick={onRotateRight}>
        <RotateRightIcon />
      </IconButton>
      <IconButton title="Search" active={searchActive} onClick={onSearch}>
        <SearchIcon />
      </IconButton>
      <IconButton title="Toggle panels" active={panelsActive} onClick={onTogglePanels}>
        <PanelsIcon />
      </IconButton>
    </div>
  )
}

function IconButton({
  title,
  active = false,
  disabled = false,
  onClick,
  children,
}: {
  title: string
  active?: boolean
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      className={`split-pane-button ${active ? 'split-pane-button-active' : ''}`}
      disabled={disabled}
      onClick={onClick}
      title={title}
      aria-label={title}
    >
      {children}
    </button>
  )
}

function ToolbarDivider() {
  return <span aria-hidden="true" className="mx-1 h-5 w-px shrink-0 bg-slate-700" />
}

type IconProps = { className?: string }

function Icon({ children, className = '' }: PropsWithChildren<IconProps>) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={`size-4 shrink-0 fill-none stroke-current stroke-2 ${className}`}>
      {children}
    </svg>
  )
}

function FileIcon() {
  return <Icon className="text-slate-500"><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v5h5" /></Icon>
}

function CloseIcon() {
  return <Icon><path d="m7 7 10 10M17 7 7 17" /></Icon>
}

function PreviousIcon() {
  return <Icon><path d="m15 18-6-6 6-6" /></Icon>
}

function NextIcon() {
  return <Icon><path d="m9 18 6-6-6-6" /></Icon>
}

function ZoomOutIcon() {
  return <Icon><circle cx="10.5" cy="10.5" r="6.5" /><path d="M15.5 15.5 21 21M7.5 10.5h6" /></Icon>
}

function ZoomInIcon() {
  return <Icon><circle cx="10.5" cy="10.5" r="6.5" /><path d="M15.5 15.5 21 21M7.5 10.5h6M10.5 7.5v6" /></Icon>
}

function FitWidthIcon() {
  return <Icon><path d="M4 6v12M20 6v12M8 12h8M8 12l3-3M8 12l3 3M16 12l-3-3M16 12l-3 3" /></Icon>
}

function RotateLeftIcon() {
  return <Icon><path d="M4 8V3m0 0h5M4 3l4 4a8 8 0 1 1-2 8" /></Icon>
}

function RotateRightIcon() {
  return <Icon><path d="M20 8V3m0 0h-5m5 0-4 4a8 8 0 1 0 2 8" /></Icon>
}

function SearchIcon() {
  return <Icon><circle cx="10.5" cy="10.5" r="6.5" /><path d="M15.5 15.5 21 21" /></Icon>
}

function PanelsIcon() {
  return <Icon><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16M12 8h6M12 12h6M12 16h4" /></Icon>
}
