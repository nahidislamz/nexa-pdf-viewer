import type { ReactNode } from 'react'
import {
  ArrowRotateClockwiseRegular,
  ArrowRotateCounterclockwiseRegular,
  ChevronLeftRegular,
  ChevronRightRegular,
  DismissRegular,
  DocumentPdfRegular,
  PanelLeftRegular,
  SearchRegular,
  ZoomFitRegular,
  ZoomInRegular,
  ZoomOutRegular,
} from '@fluentui/react-icons'

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
      <DocumentPdfRegular className="size-4 shrink-0 text-slate-500" />
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
          <DismissRegular className="size-4" />
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
        <ChevronLeftRegular className="size-4" />
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
        <ChevronRightRegular className="size-4" />
      </IconButton>
      <ToolbarDivider />
      <IconButton title="Zoom out" onClick={onZoomOut}>
        <ZoomOutRegular className="size-4" />
      </IconButton>
      <button type="button" className="split-pane-button min-w-14 tabular-nums" onClick={onResetZoom} title="Reset zoom">
        {zoomPercent}%
      </button>
      <IconButton title="Zoom in" onClick={onZoomIn}>
        <ZoomInRegular className="size-4" />
      </IconButton>
      <IconButton title="Fit width" active={fitActive} onClick={onFitWidth}>
        <ZoomFitRegular className="size-4" />
      </IconButton>
      <ToolbarDivider />
      <IconButton title="Rotate left" onClick={onRotateLeft}>
        <ArrowRotateCounterclockwiseRegular className="size-4" />
      </IconButton>
      <IconButton title="Rotate right" onClick={onRotateRight}>
        <ArrowRotateClockwiseRegular className="size-4" />
      </IconButton>
      <IconButton title="Search" active={searchActive} onClick={onSearch}>
        <SearchRegular className="size-4" />
      </IconButton>
      <IconButton title="Toggle panels" active={panelsActive} onClick={onTogglePanels}>
        <PanelLeftRegular className="size-4" />
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
