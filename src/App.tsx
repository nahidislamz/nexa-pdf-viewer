import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import { Document, Page, Thumbnail, pdfjs } from 'react-pdf'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import {
  AddRegular,
  ArrowExportRegular,
  ArrowLeftRegular,
  ArrowRightRegular,
  ArrowRotateClockwiseRegular,
  ArrowRotateCounterclockwiseRegular,
  BookOpenRegular,
  BookmarkRegular,
  CalendarRegular,
  CheckboxCheckedRegular,
  ChevronDownRegular,
  ChevronLeftRegular,
  ChevronRightRegular,
  CollectionsRegular,
  DarkThemeRegular,
  DismissRegular,
  DocumentBulletListRegular,
  DocumentOnePageRegular,
  DocumentPdfRegular,
  FullScreenMaximizeRegular,
  FullScreenMinimizeRegular,
  HighlightRegular,
  HistoryRegular,
  InfoRegular,
  LibraryRegular,
  MoreHorizontalRegular,
  OpenFolderRegular,
  PanelLeftRegular,
  PenRegular,
  PrintRegular,
  QuestionCircleRegular,
  SaveRegular,
  SearchRegular,
  SignatureRegular,
  SplitHorizontalRegular,
  TextAddTRegular,
  TextBulletListSquareRegular,
  ZoomFitRegular,
  ZoomInRegular,
  ZoomOutRegular,
} from '@fluentui/react-icons'
import { HighlightOverlay } from './components/Viewer/HighlightOverlay'
import { HighlightSelectionToolbar } from './components/Viewer/HighlightSelectionToolbar'
import { FillSignOverlay } from './components/Viewer/FillSignOverlay'
import { SignaturePlacementOverlay } from './components/Viewer/SignaturePlacementOverlay'
import { GlobalHighlightsDashboard } from './components/Highlights/GlobalHighlightsDashboard'
import { GlobalSearchPanel } from './components/Search/GlobalSearchPanel'
import { WorkspaceManager } from './components/Workspaces/WorkspaceManager'
import { ReferenceDashboard } from './components/References/ReferenceDashboard'
import { MergePdfsPanel } from './components/PdfTools/MergePdfsPanel'
import { ImagesToPdfPanel } from './components/PdfTools/ImagesToPdfPanel'
import { SignatureManagerPanel } from './components/PdfTools/SignatureManagerPanel'
import {
  SplitDocumentPane,
  type SplitDocumentPaneHandle,
  type SplitPaneDocument,
  type SplitPaneState,
  type SplitScrollPosition,
} from './components/SplitView/SplitDocumentPane'
import { PdfPaneHeader, PdfPaneToolbar } from './components/SplitView/PdfPaneChrome'
import type {
  HighlightColor,
  HighlightCategory,
  HighlightRectangle,
  PdfHighlight,
  PendingHighlightSelection,
} from './types/highlights'
import { transformHighlightRectangle } from './utils/highlights'
import type { HighlightLibrary, HighlightLibraryEntry } from './types/highlightLibrary'
import { indexPdfForGlobalSearch } from './services/globalSearchIndexer'
import { extractAndStoreReference } from './services/referenceExtractor'
import type { GlobalSearchResponse, GlobalSearchResult } from './types/globalSearch'
import { EMPTY_GLOBAL_SEARCH_RESPONSE } from './types/globalSearch'
import type { WorkspaceDetails, WorkspaceSummary } from './types/workspaces'
import type { ReferenceQueryResponse } from './types/references'
import type {
  FillSignDateFormat,
  FillSignField,
  FillSignTool,
  SavedSignature,
  SignaturePlacement,
} from './types/signatures'
import 'react-pdf/dist/Page/TextLayer.css'
import 'react-pdf/dist/Page/AnnotationLayer.css'

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString()

type PdfFile = {
  id: string
  name: string
  filePath: string
  fileSize: number
  modifiedAt: number
  dataUrl: string
}

type OpenedPdf = PdfFile & {
  readingState: {
    page: number
    zoom: number
    fitMode: boolean
    rotation: number
  }
  highlights: PdfHighlight[]
  signaturePlacements: SignaturePlacement[]
  fillSignFields: FillSignField[]
  ocrDetection: OcrDetectionResult
}

type SystemPdfOpenMessage =
  | { status: 'loading' }
  | { status: 'success'; pdf: OpenedPdf }
  | { status: 'error'; error: string }

type RecentFile = {
  id: string
  name: string
}

type CachedPageText = {
  text: string
  itemStarts: number[]
}

type SearchMatch = {
  index: number
  pageNumber: number
  start: number
  end: number
  source?: 'pdf' | 'ocr'
  language?: OcrLanguage
}

type SidebarTab = 'thumbnails' | 'bookmarks' | 'highlights' | 'info'
type ViewMode = 'continuous' | 'single'
type ViewerBackground = 'dark-gray' | 'black' | 'light-gray' | 'white'
type PaneSide = 'left' | 'right'
type ToolbarMenu =
  | 'open'
  | 'zoom'
  | 'annotate'
  | 'fill-sign'
  | 'research'
  | 'pdf-tools'
  | 'theme'
  | 'view'
  | 'more'
type PdfOpenDestinationPreference = 'ask' | 'individual' | 'current-workspace' | 'choose-workspace'
type PdfOpenDestinationChoice = 'individual' | 'current-workspace' | 'another-workspace' | 'new-workspace'
type PdfOpenDestinationDecision = {
  choice: PdfOpenDestinationChoice
  workspaceId?: string
  workspaceName?: string
}
type PdfOpenDestinationPrompt = {
  document: { id: string; name: string }
  initialChoice: PdfOpenDestinationChoice
  remember: boolean
  workspaceId: string
  workspaceName: string
  resolve: (decision: PdfOpenDestinationDecision | null) => void
}
type WorkspaceSession = Awaited<ReturnType<Window['electronAPI']['getWorkspace']>>
type WorkspaceNavigationOptions = { highlight?: HighlightLibraryEntry; workspaceId?: string }

type PdfTabState = {
  page: number
  pageOffset: number
  zoom: number
  fitMode: boolean
  rotation: number
  searchOpen: boolean
  searchQuery: string
  selectedMatchIndex: number
  sidebarOpen: boolean
  sidebarTab: SidebarTab
  sidebarWidth: number
}

type PdfTab = {
  tabId: string
  documentId: string
  name: string
  state: PdfTabState
}

type PaneAssignment = {
  id: PaneSide
  tabId: string | null
  documentId: string | null
  fileName: string | null
  state: PdfTabState | null
}

type PdfOutlineItem = {
  title: string
  dest: string | unknown[] | null
  count?: number
  items: PdfOutlineItem[]
}

type DocumentMetadata = {
  title: string
  author: string
  subject: string
  creator: string
  producer: string
  creationDate: string
  modificationDate: string
}

type OcrDetectionStatus = 'unknown' | 'detecting' | 'searchable' | 'ocr-recommended' | 'error'

type OcrDetectionResult = {
  status: OcrDetectionStatus
  sampledPages: number
  textCharacters: number
  detectedAt: string | null
  error?: string
}

type OcrLanguage = 'eng' | 'ben' | 'ara' | 'hin' | 'urd' | 'fra' | 'deu' | 'spa'

type PageOcrResult = {
  pageNumber: number
  text: string
  confidence: number
  words: Array<{ text: string; confidence: number; x0: number; y0: number; x1: number; y1: number }>
  lines: Array<{ text: string; confidence: number; x0: number; y0: number; x1: number; y1: number }>
  language: OcrLanguage
  createdAt: string
  updatedAt: string
  status: 'complete' | 'failed'
  lowConfidence: boolean
  error?: string
}

type OcrJobState = {
  operationId: string
  pageNumber: number
  status: string
  progress: number
  totalPages: number
  completedPages: number
  failedPages: number
  failedPageNumbers: number[]
  startedAt: number
  estimatedRemainingMs: number | null
  paused: boolean
}

type SearchProgress = {
  processed: number
  total: number
}

const MIN_SCALE = 0.25
const MAX_SCALE = 4
const ZOOM_RENDER_DEBOUNCE_MS = 120
const PAGE_RENDER_OVERSCAN = 1
const DEFAULT_PAGE_WIDTH = 612
const DEFAULT_PAGE_HEIGHT = 792
const OCR_SAMPLE_PAGES = 3
const OCR_SEARCHABLE_CHARACTER_THRESHOLD = 80
const EMPTY_OCR_DETECTION: OcrDetectionResult = {
  status: 'unknown',
  sampledPages: 0,
  textCharacters: 0,
  detectedAt: null,
}
const OCR_LANGUAGES: Array<{ code: OcrLanguage; label: string }> = [
  { code: 'eng', label: 'English' },
  { code: 'ben', label: 'Bangla' },
  { code: 'ara', label: 'Arabic' },
  { code: 'hin', label: 'Hindi' },
  { code: 'urd', label: 'Urdu' },
  { code: 'fra', label: 'French' },
  { code: 'deu', label: 'German' },
  { code: 'spa', label: 'Spanish' },
]
const VIEWER_BACKGROUNDS: Record<ViewerBackground, string> = {
  'dark-gray': '#1f2937',
  black: '#000000',
  'light-gray': '#cbd0d6',
  white: '#ffffff',
}
const VIEWER_BACKGROUND_LABELS: Record<ViewerBackground, string> = {
  'dark-gray': 'Dark Gray',
  black: 'Black',
  'light-gray': 'Light Gray',
  white: 'White',
}
const HIGHLIGHT_CATEGORY_ORDER: HighlightCategory[] = [
  'important',
  'research',
  'reference',
  'question',
]
const HIGHLIGHT_CATEGORY_LABELS: Record<HighlightCategory, string> = {
  important: 'Important',
  research: 'Research',
  reference: 'Reference',
  question: 'Question',
}
const DEFAULT_CATEGORY_BY_COLOR: Record<HighlightColor, HighlightCategory> = {
  yellow: 'important',
  green: 'research',
  blue: 'reference',
  purple: 'question',
}
const HIGHLIGHT_COLOR_ORDER: HighlightColor[] = ['yellow', 'green', 'blue', 'purple']
const HIGHLIGHT_COLOR_LABELS: Record<HighlightColor, string> = {
  yellow: 'Amber',
  green: 'Mint',
  blue: 'Sky Blue',
  purple: 'Purple',
}
const EMPTY_HIGHLIGHTS: PdfHighlight[] = []
const EMPTY_HIGHLIGHT_IDS = new Set<string>()
const KEYBOARD_SHORTCUTS = [
  ['Ctrl + O', 'Open PDF'],
  ['Ctrl + P', 'Print PDF'],
  ['Ctrl + F', 'Search'],
  ['Ctrl + Shift + F', 'Search all PDFs'],
  ['Ctrl + H', 'Highlight selected text'],
  ['Ctrl + Mouse Wheel', 'Zoom'],
  ['Ctrl + +', 'Zoom In'],
  ['Ctrl + -', 'Zoom Out'],
  ['Ctrl + 0', 'Reset Zoom'],
  ['Ctrl + Tab', 'Next Tab'],
  ['Ctrl + Shift + Tab', 'Previous Tab'],
  ['Ctrl + W', 'Close Tab'],
  ['Ctrl + Shift + T', 'Restore Closed Tab'],
  ['Ctrl + 1-9', 'Jump to Tab'],
  ['Ctrl + \\', 'Toggle Split View'],
  ['Ctrl + Shift + Left/Right', 'Focus Split Pane'],
  ['PageUp', 'Previous Page'],
  ['PageDown', 'Next Page'],
  ['F11', 'Toggle Fullscreen'],
  ['Esc', 'Exit Fullscreen'],
]

function App() {
  const [referencesOpen, setReferencesOpen] = useState(false)
  const [mergePdfsOpen, setMergePdfsOpen] = useState(false)
  const [imagesToPdfOpen, setImagesToPdfOpen] = useState(false)
  const [signatureManagerOpen, setSignatureManagerOpen] = useState(false)
  const [referenceStatus, setReferenceStatus] = useState<ReferenceQueryResponse['stats']>({ references: 0, authors: 0, publishers: 0, recent: 0, missingMetadata: 0, filtered: 0 })
  const [workspaceManagerOpen, setWorkspaceManagerOpen] = useState(false)
  const [workspaceList, setWorkspaceList] = useState<WorkspaceSummary[]>([])
  const [activeWorkspaceId, setActiveWorkspaceId] = useState('')
  const [workspaceDetails, setWorkspaceDetails] = useState<WorkspaceDetails | null>(null)
  const [workspaceLoading, setWorkspaceLoading] = useState(false)
  const [workspaceError, setWorkspaceError] = useState<string | null>(null)
  const [globalDashboardOpen, setGlobalDashboardOpen] = useState(false)
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false)
  const [globalSearchReturnToDashboard, setGlobalSearchReturnToDashboard] = useState(false)
  const [globalSearchStatus, setGlobalSearchStatus] = useState<GlobalSearchResponse>(EMPTY_GLOBAL_SEARCH_RESPONSE)
  const [pendingGlobalSearchNavigation, setPendingGlobalSearchNavigation] = useState<{
    result: GlobalSearchResult
    query: string
  } | null>(null)
  const [highlightLibrary, setHighlightLibrary] = useState<HighlightLibrary>({
    entries: [],
    stats: {
      totalDocuments: 0,
      totalHighlights: 0,
      categories: { important: 0, research: 0, reference: 0, question: 0 },
    },
  })
  const [highlightLibraryLoading, setHighlightLibraryLoading] = useState(false)
  const [highlightLibraryError, setHighlightLibraryError] = useState<string | null>(null)
  const [highlightLibraryFilteredCount, setHighlightLibraryFilteredCount] = useState(0)
  const [searchIndexProgress, setSearchIndexProgress] = useState<{ indexed: number; total: number } | null>(null)
  const [pendingLibraryNavigation, setPendingLibraryNavigation] =
    useState<HighlightLibraryEntry | null>(null)
  const [pdfFile, setPdfFile] = useState<PdfFile | null>(null)
  const [activeDocumentId, setActiveDocumentId] = useState<string | null>(null)
  const [recentFiles, setRecentFiles] = useState<RecentFile[]>([])
  const [tabs, setTabs] = useState<PdfTab[]>([])
  const [activeTabId, setActiveTabId] = useState<string | null>(null)
  const [closedTabs, setClosedTabs] = useState<PdfTab[]>([])
  const [tabContextMenu, setTabContextMenu] = useState<{
    tabId: string
    x: number
    y: number
  } | null>(null)
  const [draggedTabId, setDraggedTabId] = useState<string | null>(null)
  const [tabDropTargetId, setTabDropTargetId] = useState<string | null>(null)
  const [splitEnabled, setSplitEnabled] = useState(false)
  const [splitRatio, setSplitRatio] = useState(0.5)
  const [activePane, setActivePane] = useState<PaneSide>('left')
  const [leftPane, setLeftPane] = useState<PaneAssignment>(() => emptyPane('left'))
  const [rightPane, setRightPane] = useState<PaneAssignment>(() => emptyPane('right'))
  const [rightDocument, setRightDocument] = useState<SplitPaneDocument | null>(null)
  const [splitMenuOpen, setSplitMenuOpen] = useState(false)
  const [splitResizing, setSplitResizing] = useState(false)
  const syncScrolling = false
  const [searchBothPanes, setSearchBothPanes] = useState(false)
  const [rightSearchStatus, setRightSearchStatus] = useState({ current: 0, total: 0, query: '' })
  const [rightViewStatus, setRightViewStatus] = useState({ page: 1, totalPages: 0, zoom: 1, fitMode: false })
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy | null>(null)
  const [numPages, setNumPages] = useState(0)
  const [displayZoom, setDisplayZoom] = useState(1)
  const [renderZoom, setRenderZoom] = useState(1)
  const [isZooming, setIsZooming] = useState(false)
  const [zoomMode, setZoomMode] = useState<'manual' | 'fit-width'>('manual')
  const [viewerWidth, setViewerWidth] = useState(0)
  const [firstPageWidth, setFirstPageWidth] = useState(0)
  const [firstPageHeight, setFirstPageHeight] = useState(0)
  const [currentPage, setCurrentPage] = useState(1)
  const [pageInput, setPageInput] = useState('1')
  const [isLoading, setIsLoading] = useState(false)
  const [loadingProgress, setLoadingProgress] = useState<string | null>(null)
  const [isRestoring, setIsRestoring] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchMatches, setSearchMatches] = useState<SearchMatch[]>([])
  const [selectedMatchIndex, setSelectedMatchIndex] = useState(-1)
  const [isSearching, setIsSearching] = useState(false)
  const [searchProgress, setSearchProgress] = useState<SearchProgress | null>(null)
  const [thumbnailSidebarOpen, setThumbnailSidebarOpen] = useState(true)
  const [sidebarWidth, setSidebarWidth] = useState(280)
  const [sidebarResizing, setSidebarResizing] = useState(false)
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('thumbnails')
  const [visibleThumbnailPages, setVisibleThumbnailPages] = useState<Set<number>>(
    () => new Set(),
  )
  const [renderedPageNumbers, setRenderedPageNumbers] = useState<Set<number>>(
    () => new Set([1]),
  )
  const [outline, setOutline] = useState<PdfOutlineItem[]>([])
  const [outlineLoading, setOutlineLoading] = useState(false)
  const [documentMetadata, setDocumentMetadata] = useState<DocumentMetadata | null>(null)
  const [metadataLoading, setMetadataLoading] = useState(false)
  const [ocrDetection, setOcrDetection] = useState<OcrDetectionResult>(EMPTY_OCR_DETECTION)
  const [ocrLanguage, setOcrLanguage] = useState<OcrLanguage>(() =>
    sanitizeOcrLanguage(window.localStorage.getItem('next-pdf-viewer:ocr-language')),
  )
  const [ocrPageRangeInput, setOcrPageRangeInput] = useState('')
  const [pageOcrResults, setPageOcrResults] = useState<PageOcrResult[]>([])
  const [currentPageTextStatus, setCurrentPageTextStatus] =
    useState<'unknown' | 'searchable' | 'empty'>('unknown')
  const [ocrJob, setOcrJob] = useState<OcrJobState | null>(null)
  const [highlights, setHighlights] = useState<PdfHighlight[]>([])
  const [signaturePlacements, setSignaturePlacements] = useState<SignaturePlacement[]>([])
  const [fillSignFields, setFillSignFields] = useState<FillSignField[]>([])
  const [activeFillSignTool, setActiveFillSignTool] = useState<FillSignTool | null>(null)
  const [selectedFillSignFieldId, setSelectedFillSignFieldId] = useState<string | null>(null)
  const [fillSignDateFormat, setFillSignDateFormat] =
    useState<FillSignDateFormat>('DD/MM/YYYY')
  const [fillSignDateMenuOpen, setFillSignDateMenuOpen] = useState(false)
  const [savedSignatures, setSavedSignatures] = useState<SavedSignature[]>([])
  const [signPickerOpen, setSignPickerOpen] = useState(false)
  const [signaturesLoading, setSignaturesLoading] = useState(false)
  const [signingSignature, setSigningSignature] = useState<SavedSignature | null>(null)
  const [selectedSignaturePlacementId, setSelectedSignaturePlacementId] = useState<string | null>(null)
  const [pendingHighlightSelection, setPendingHighlightSelection] =
    useState<PendingHighlightSelection | null>(null)
  const [highlightContextMenu, setHighlightContextMenu] = useState<{
    highlightId: string
    x: number
    y: number
  } | null>(null)
  const [focusedHighlightId, setFocusedHighlightId] = useState<string | null>(null)
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null)
  const [selectedHighlightIdsByDocument, setSelectedHighlightIdsByDocument] =
    useState<Map<string, Set<string>>>(() => new Map())
  const [exportHighlightsOpen, setExportHighlightsOpen] = useState(false)
  const [exportFormat, setExportFormat] = useState<'markdown' | 'text' | 'docx'>('markdown')
  const [exportScope, setExportScope] = useState<'all' | 'category' | 'selected'>('all')
  const [exportCategory, setExportCategory] = useState<HighlightCategory>('important')
  const [exportCategories, setExportCategories] = useState<Set<HighlightCategory>>(
    () => new Set(HIGHLIGHT_CATEGORY_ORDER),
  )
  const [isExportingHighlights, setIsExportingHighlights] = useState(false)
  const [rotation, setRotation] = useState(0)
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false)
  const [dragActive, setDragActive] = useState(false)
  const [dropTargetPane, setDropTargetPane] = useState<PaneSide | null>(null)
  const [isPrinting, setIsPrinting] = useState(false)
  const [isExporting, setIsExporting] = useState(false)
  const [isSavingSignedCopy, setIsSavingSignedCopy] = useState(false)
  const [exportMenuOpen, setExportMenuOpen] = useState(false)
  const [pdfToolsMenuOpen, setPdfToolsMenuOpen] = useState(false)
  const [toolbarMenuOpen, setToolbarMenuOpen] = useState<ToolbarMenu | null>(null)
  const [pdfOpenDestination, setPdfOpenDestination] =
    useState<PdfOpenDestinationPreference>('ask')
  const [pdfOpenDestinationPrompt, setPdfOpenDestinationPrompt] =
    useState<PdfOpenDestinationPrompt | null>(null)
  const [openingSettingsOpen, setOpeningSettingsOpen] = useState(false)
  const [clearRecentConfirmOpen, setClearRecentConfirmOpen] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [viewMode, setViewMode] = useState<ViewMode>('continuous')
  const [viewerBackground, setViewerBackground] = useState<ViewerBackground>('dark-gray')
  const [headerHeight, setHeaderHeight] = useState(0)
  const headerRef = useRef<HTMLElement>(null)
  const viewerRef = useRef<HTMLDivElement>(null)
  const activeDocumentIdRef = useRef<string | null>(null)
  const pageInputFocusedRef = useRef(false)
  const currentPageRef = useRef(1)
  const zoomAnchorRef = useRef<{
    pageNumber: number
    relativeOffset: number
    topMargin: number
  } | null>(null)
  const zoomDebounceRef = useRef(0)
  const zoomSnapshotTimeoutRef = useRef(0)
  const isRestoringZoomPositionRef = useRef(false)
  const pendingRestorePageRef = useRef<number | null>(null)
  const pendingRestoreOffsetRef = useRef(0)
  const restoringReadingStateRef = useRef(false)
  const recentFilesRef = useRef<HTMLDetailsElement>(null)
  const pdfToolsMenuRef = useRef<HTMLDivElement>(null)
  const fillSignDateMenuRef = useRef<HTMLDivElement>(null)
  const signPickerRef = useRef<HTMLDivElement>(null)
  const displayZoomRef = useRef(1)
  const renderZoomRef = useRef(1)
  const wheelDeltaRef = useRef(0)
  const wheelZoomFrameRef = useRef(0)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const searchGenerationRef = useRef(0)
  const pageTextCacheRef = useRef(new Map<number, CachedPageText>())
  const nearbyPageNumbersRef = useRef(new Set<number>())
  const thumbnailListRef = useRef<HTMLDivElement>(null)
  const outlineGenerationRef = useRef(0)
  const metadataGenerationRef = useRef(0)
  const ocrDetectionGenerationRef = useRef(0)
  const cancelledOcrOperationsRef = useRef(new Set<string>())
  const ocrBatchCancelRef = useRef(false)
  const ocrBatchPausedRef = useRef(false)
  const activeOcrOperationRef = useRef<string | null>(null)
  const firstPageProxyRef = useRef<PDFPageProxy | null>(null)
  const pdfDocumentRef = useRef<PDFDocumentProxy | null>(null)
  const navigationTargetRef = useRef<number | null>(null)
  const navigationTimeoutRef = useRef(0)
  const dragDepthRef = useRef(0)
  const viewModeRef = useRef<ViewMode>('continuous')
  const pageRefs = useRef(new Map<number, HTMLDivElement>())
  const pageNavigationGenerationRef = useRef(0)
  const pageScrollFrameRef = useRef(0)
  const documentLoadStartedRef = useRef(0)
  const initialPageRenderedRef = useRef(false)
  const backgroundDocumentTaskRef = useRef(0)
  const searchIndexAbortRef = useRef<AbortController | null>(null)
  const highlightSaveGenerationRef = useRef(0)
  const signaturePlacementSaveGenerationRef = useRef(0)
  const signaturePlacementSaveTimeoutRef = useRef(0)
  const fillSignSaveGenerationRef = useRef(0)
  const fillSignSaveTimeoutRef = useRef(0)
  const highlightFocusTimeoutRef = useRef(0)
  const highlightPageMapRef = useRef(new Map<number, PdfHighlight[]>())
  const tabsRef = useRef<PdfTab[]>([])
  const activeTabIdRef = useRef<string | null>(null)
  const closedTabsRef = useRef<PdfTab[]>([])
  const workspaceReadyRef = useRef(false)
  const workspaceSaveTimeoutRef = useRef(0)
  const workspaceSwitchingRef = useRef(false)
  const documentLoadPromisesRef = useRef(new Map<string, Promise<OpenedPdf>>())
  const openWorkspaceDocumentRef = useRef<(
    documentId: string,
    options?: WorkspaceNavigationOptions,
  ) => Promise<void>>(async () => undefined)
  const tabSwitchGenerationRef = useRef(0)
  const pendingSearchMatchIndexRef = useRef(-1)
  const draggedTabIdRef = useRef<string | null>(null)
  const splitContainerRef = useRef<HTMLDivElement>(null)
  const leftPaneContainerRef = useRef<HTMLDivElement>(null)
  const rightPaneRef = useRef<SplitDocumentPaneHandle>(null)
  const syncScrollTokenRef = useRef(0)
  const lastLeftScrollPositionRef = useRef({ page: 1, offset: 0 })
  const rightPaneLoadGenerationRef = useRef(0)
  const rightSidebarHighlightSaveGenerationRef = useRef(0)
  const suppressLeftSyncRef = useRef(false)
  const leftPaneAssignmentRef = useRef(leftPane)
  const rightPaneAssignmentRef = useRef(rightPane)

  const leftTabId = leftPane.tabId
  const rightTabId = rightPane.tabId
  const rightPaneState = rightPane.state ? toSplitPaneState(rightPane.state) : null
  leftPaneAssignmentRef.current = leftPane
  rightPaneAssignmentRef.current = rightPane
  openWorkspaceDocumentRef.current = openWorkspaceDocument

  tabsRef.current = tabs
  activeTabIdRef.current = activeTabId
  closedTabsRef.current = closedTabs

  const sidebarContext = getSidebarDocumentContext({
    splitEnabled,
    activePane,
    leftDocument: pdfFile,
    leftHighlights: highlights,
    leftPane,
    rightPane,
    rightDocument,
  })
  const sidebarPaneId = sidebarContext.paneId
  const sidebarDocument = sidebarContext.document
  const sidebarDocumentId = sidebarContext.documentId
  const sidebarHighlights = sidebarContext.highlights
  const selectedHighlightIds = sidebarDocumentId
    ? selectedHighlightIdsByDocument.get(sidebarDocumentId) ?? EMPTY_HIGHLIGHT_IDS
    : EMPTY_HIGHLIGHT_IDS
  const activeSignatureDocument = splitEnabled && activePane === 'right' ? rightDocument : pdfFile
  const activeSignaturePlacements = splitEnabled && activePane === 'right'
    ? rightDocument?.signaturePlacements ?? []
    : signaturePlacements
  const activeFillSignFields = splitEnabled && activePane === 'right'
    ? rightDocument?.fillSignFields ?? []
    : fillSignFields
  const defaultInitials = useMemo(
    () => initialsFromSignatures(savedSignatures),
    [savedSignatures],
  )

  const fitWidthZoom = clampScale(
    viewerWidth > 0 && firstPageWidth > 0 ? viewerWidth / firstPageWidth : displayZoom,
  )
  const observedSinglePage = viewMode === 'single' ? currentPage : 0
  const estimatedPageWidth = firstPageWidth || DEFAULT_PAGE_WIDTH
  const estimatedPageHeight = firstPageHeight || DEFAULT_PAGE_HEIGHT
  const zoomPreviewScale = renderZoom > 0 ? displayZoom / renderZoom : 1
  displayZoomRef.current = displayZoom
  renderZoomRef.current = renderZoom
  viewModeRef.current = viewMode
  const matchesByPage = useMemo(() => {
    const groupedMatches = new Map<number, SearchMatch[]>()
    for (const match of searchMatches) {
      const pageMatches = groupedMatches.get(match.pageNumber) ?? []
      pageMatches.push(match)
      groupedMatches.set(match.pageNumber, pageMatches)
    }
    return groupedMatches
  }, [searchMatches])
  const highlightsByPage = useMemo(() => {
    const groupedHighlights = new Map<number, PdfHighlight[]>()
    for (const highlight of highlights) {
      const pageHighlights = groupedHighlights.get(highlight.pageNumber) ?? []
      pageHighlights.push(highlight)
      groupedHighlights.set(highlight.pageNumber, pageHighlights)
    }
    for (const [pageNumber, pageHighlights] of groupedHighlights) {
      const previousHighlights = highlightPageMapRef.current.get(pageNumber)
      if (
        previousHighlights?.length === pageHighlights.length &&
        previousHighlights.every((highlight, index) => highlight === pageHighlights[index])
      ) {
        groupedHighlights.set(pageNumber, previousHighlights)
      }
    }
    highlightPageMapRef.current = groupedHighlights
    return groupedHighlights
  }, [highlights])
  const signaturePlacementsByPage = useMemo(() => {
    const groupedPlacements = new Map<number, SignaturePlacement[]>()
    for (const placement of signaturePlacements) {
      const pagePlacements = groupedPlacements.get(placement.pageNumber) ?? []
      pagePlacements.push(placement)
      groupedPlacements.set(placement.pageNumber, pagePlacements)
    }
    return groupedPlacements
  }, [signaturePlacements])
  const fillSignFieldsByPage = useMemo(() => {
    const groupedFields = new Map<number, FillSignField[]>()
    for (const field of fillSignFields) {
      const pageFields = groupedFields.get(field.pageNumber) ?? []
      pageFields.push(field)
      groupedFields.set(field.pageNumber, pageFields)
    }
    return groupedFields
  }, [fillSignFields])
  const pageOcrResultsByPage = useMemo(() => {
    const groupedResults = new Map<number, PageOcrResult[]>()
    for (const result of pageOcrResults) {
      if (result.status !== 'complete' || !result.text.trim()) continue
      const results = groupedResults.get(result.pageNumber) ?? []
      results.push(result)
      groupedResults.set(result.pageNumber, results)
    }
    return groupedResults
  }, [pageOcrResults])
  const currentPageOcrResult = useMemo(
    () =>
      pageOcrResults.find(
        (result) =>
          result.pageNumber === currentPage &&
          result.language === ocrLanguage &&
          result.status === 'complete',
      ) ?? null,
    [currentPage, ocrLanguage, pageOcrResults],
  )
  const pageOcrResultKeys = useMemo(
    () =>
      new Set(
        pageOcrResults
          .filter((result) => result.status === 'complete' && result.text.trim())
          .map((result) => `${result.pageNumber}:${result.language}`),
      ),
    [pageOcrResults],
  )
  const ocrTextPageCount = useMemo(
    () => new Set(pageOcrResults.filter((result) => result.status === 'complete' && result.text.trim()).map((result) => result.pageNumber)).size,
    [pageOcrResults],
  )
  const lowConfidenceOcrPageCount = useMemo(
    () => new Set(pageOcrResults.filter((result) => result.status === 'complete' && result.lowConfidence).map((result) => result.pageNumber)).size,
    [pageOcrResults],
  )

  const renderSearchText = useCallback(
    ({ pageNumber, itemIndex, str }: { pageNumber: number; itemIndex: number; str: string }) => {
      const pageText = pageTextCacheRef.current.get(pageNumber)
      const pageMatches = matchesByPage.get(pageNumber)
      const itemStart = pageText?.itemStarts[itemIndex]

      if (!pageText || !pageMatches || itemStart === undefined || str.length === 0) {
        return escapeHtml(str)
      }

      const itemEnd = itemStart + str.length
      const overlappingMatches = pageMatches.filter(
        (match) => (match.source ?? 'pdf') === 'pdf' && match.start < itemEnd && match.end > itemStart,
      )
      if (overlappingMatches.length === 0) {
        return escapeHtml(str)
      }

      let cursor = 0
      let renderedText = ''
      for (const match of overlappingMatches) {
        const matchStart = Math.max(0, match.start - itemStart)
        const matchEnd = Math.min(str.length, match.end - itemStart)
        renderedText += escapeHtml(str.slice(cursor, matchStart))
        renderedText += `<mark class="pdf-search-match" data-search-match="${match.index}">${escapeHtml(str.slice(matchStart, matchEnd))}</mark>`
        cursor = matchEnd
      }

      return renderedText + escapeHtml(str.slice(cursor))
    },
    [matchesByPage],
  )

  const handleSystemPdfOpen = useEffectEvent((message: SystemPdfOpenMessage) => {
    if (message.status === 'loading') {
      setErrorMessage(null)
      setIsLoading(true)
      setLoadingProgress('Reading PDF file...')
      return
    }

    if (message.status === 'error') {
      setIsLoading(false)
      setLoadingProgress(null)
      setErrorMessage(`Failed to open PDF: ${message.error}`)
      return
    }

    void openPreparedPdf(message.pdf)
  })
  const restoreWorkspaceEvent = useEffectEvent(restoreWorkspace)
  const getCurrentTabStateEvent = useEffectEvent(getCurrentTabState)
  const navigateToHighlightEvent = useEffectEvent(navigateToHighlight)
  const goToPageEvent = useEffectEvent(goToPage)

  const handleLibraryFilteredCountChange = useCallback((count: number) => {
    setHighlightLibraryFilteredCount(count)
  }, [])
  const handleGlobalSearchStatusChange = useCallback((response: GlobalSearchResponse) => {
    setGlobalSearchStatus(response)
  }, [])

  useEffect(() => {
    if (zoomMode !== 'fit-width' || Math.abs(fitWidthZoom - displayZoom) < 0.001) {
      return
    }

    const animationFrame = window.requestAnimationFrame(() => {
      captureZoomAnchor()
      isRestoringZoomPositionRef.current = true
      setIsZooming(true)
      displayZoomRef.current = fitWidthZoom
      setDisplayZoom(fitWidthZoom)
    })
    return () => window.cancelAnimationFrame(animationFrame)
  }, [displayZoom, fitWidthZoom, zoomMode])

  useEffect(() => {
    window.clearTimeout(zoomDebounceRef.current)
    if (Math.abs(displayZoom - renderZoom) < 0.001) {
      return
    }

    zoomDebounceRef.current = window.setTimeout(() => {
      preserveRenderedPagesForZoom()
      setIsZooming(false)
      renderZoomRef.current = displayZoom
      setRenderZoom(displayZoom)
      window.clearTimeout(zoomSnapshotTimeoutRef.current)
      zoomSnapshotTimeoutRef.current = window.setTimeout(clearZoomSnapshots, 3000)
    }, ZOOM_RENDER_DEBOUNCE_MS)

    return () => window.clearTimeout(zoomDebounceRef.current)
  }, [displayZoom, renderZoom])

  useEffect(() => {
    if (Math.abs(displayZoom - renderZoom) < 0.001) {
      return
    }

    const anchor = zoomAnchorRef.current
    const page = anchor ? pageRefs.current.get(anchor.pageNumber) : null
    if (!anchor || !page) {
      return
    }

    const animationFrame = window.requestAnimationFrame(() => {
      const bounds = page.getBoundingClientRect()
      const viewportTop = headerRef.current?.offsetHeight ?? 0
      const desiredPageTop =
        viewportTop + anchor.topMargin - anchor.relativeOffset * bounds.height
      window.scrollBy({ top: bounds.top - desiredPageTop, behavior: 'auto' })
    })

    return () => window.cancelAnimationFrame(animationFrame)
  }, [displayZoom, renderZoom])

  useEffect(() => {
    void refreshRecentFiles()
    void window.electronAPI
      .getViewMode()
      .then(setViewMode)
      .catch((error) => setErrorMessage(getErrorMessage(error)))
    void window.electronAPI
      .getViewerBackground()
      .then(setViewerBackground)
      .catch((error) => setErrorMessage(getErrorMessage(error)))
    void window.electronAPI
      .getPdfOpenDestination()
      .then(setPdfOpenDestination)
      .catch((error) => setErrorMessage(getErrorMessage(error)))
  }, [])

  useEffect(() => {
    if (!pendingLibraryNavigation || pdfFile?.id !== pendingLibraryNavigation.documentId || numPages === 0) {
      return
    }
    const highlight = highlights.find(
      (candidate) => candidate.id === pendingLibraryNavigation.highlightId,
    )
    if (!highlight) return
    const timeout = window.setTimeout(() => {
      navigateToHighlightEvent(highlight)
      setPendingLibraryNavigation(null)
    }, 0)
    return () => window.clearTimeout(timeout)
  }, [highlights, numPages, pdfFile, pendingLibraryNavigation])

  useEffect(() => {
    const navigation = pendingGlobalSearchNavigation
    if (!navigation || pdfFile?.id !== navigation.result.documentId || numPages === 0) return
    const timeout = window.setTimeout(() => {
      const { result, query } = navigation
      if (result.highlightId) {
        const highlight = highlights.find((candidate) => candidate.id === result.highlightId)
        if (!highlight) return
        navigateToHighlightEvent(highlight)
        setPendingGlobalSearchNavigation(null)
        return
      }

      goToPageEvent(result.pageNumber, 'auto')
      if (!['pdf-text', 'ocr-text'].includes(result.type) || !query) {
        setPendingGlobalSearchNavigation(null)
        return
      }
      if (!searchOpen || searchQuery !== query) {
        setSearchOpen(true)
        setSearchQuery(query)
        setIsSearching(true)
        return
      }
      const matchIndex = searchMatches.findIndex((match) => match.pageNumber === result.pageNumber)
      if (matchIndex >= 0) {
        setSelectedMatchIndex(matchIndex)
        setPendingGlobalSearchNavigation(null)
      } else if (!isSearching && searchProgress === null) {
        setPendingGlobalSearchNavigation(null)
      }
    }, 0)
    return () => window.clearTimeout(timeout)
  }, [highlights, isSearching, numPages, pdfFile, pendingGlobalSearchNavigation, searchMatches, searchOpen, searchProgress, searchQuery])

  useEffect(() => {
    const removeSystemOpenListener = window.electronAPI.onOpenPdfFromSystem(
      handleSystemPdfOpen,
    )

    void restoreWorkspaceEvent().finally(() => window.electronAPI.notifyRendererReady())
    return removeSystemOpenListener
  }, [])

  useEffect(() => {
    const leftPaneTabId = leftPaneAssignmentRef.current.tabId
    if (!workspaceReadyRef.current || !leftPaneTabId || !pdfFile) {
      return
    }

    const timeout = window.setTimeout(() => {
      const state = getCurrentTabStateEvent()
      updatePaneAssignmentState('left', state)
      updateTabCollections(
        tabsRef.current.map((tab) =>
          tab.tabId === leftPaneTabId ? { ...tab, state } : tab,
        ),
        closedTabsRef.current,
      )
    }, 160)

    return () => window.clearTimeout(timeout)
  }, [
    leftPane.tabId,
    currentPage,
    displayZoom,
    pdfFile,
    rotation,
    searchOpen,
    searchQuery,
    selectedMatchIndex,
    sidebarTab,
    sidebarWidth,
    thumbnailSidebarOpen,
    zoomMode,
  ])

  useEffect(() => {
    if (!workspaceReadyRef.current || workspaceSwitchingRef.current) {
      return
    }

    window.clearTimeout(workspaceSaveTimeoutRef.current)
    workspaceSaveTimeoutRef.current = window.setTimeout(() => {
      void window.electronAPI
        .saveWorkspace({
          tabs,
          activeTabId,
          closedTabs,
          split: {
            enabled: splitEnabled,
            dividerRatio: splitRatio,
            activePane,
            leftPane,
            rightPane,
            syncScrolling,
          },
        })
        .catch((error) => setErrorMessage(`Workspace save failed: ${getErrorMessage(error)}`))
    }, 250)

    return () => window.clearTimeout(workspaceSaveTimeoutRef.current)
  }, [
    activePane,
    activeTabId,
    closedTabs,
    leftPane,
    rightPane,
    splitEnabled,
    splitRatio,
    syncScrolling,
    tabs,
  ])

  useEffect(() => {
    const activeFileName = splitEnabled && activePane === 'right'
      ? rightDocument?.name
      : pdfFile?.name
    document.title = activeFileName ? `${activeFileName} — Next PDF Viewer` : 'Next PDF Viewer'
  }, [activePane, pdfFile, rightDocument, splitEnabled])

  useEffect(() => {
    void window.electronAPI
      .getFullscreen()
      .then(setIsFullscreen)
      .catch((error) => setErrorMessage(getErrorMessage(error)))
    window.electronAPI.onFullscreenChange(setIsFullscreen)
    return () => window.electronAPI.removeFullscreenListener()
  }, [])

  useEffect(() => {
    function closePdfToolsOnOutsideInteraction(event: PointerEvent | FocusEvent) {
      const target = event.target as Node | null
      if (target && pdfToolsMenuRef.current?.contains(target)) {
        return
      }
      setPdfToolsMenuOpen(false)
    }

    document.addEventListener('pointerdown', closePdfToolsOnOutsideInteraction, true)
    document.addEventListener('focusin', closePdfToolsOnOutsideInteraction, true)
    return () => {
      document.removeEventListener('pointerdown', closePdfToolsOnOutsideInteraction, true)
      document.removeEventListener('focusin', closePdfToolsOnOutsideInteraction, true)
    }
  }, [])

  useEffect(() => {
    function closeToolbarMenuOnOutsideInteraction(event: PointerEvent | FocusEvent) {
      const target = event.target as HTMLElement | null
      if (target?.closest('[data-toolbar-menu-scope]')) {
        return
      }
      setToolbarMenuOpen(null)
    }

    document.addEventListener('pointerdown', closeToolbarMenuOnOutsideInteraction, true)
    document.addEventListener('focusin', closeToolbarMenuOnOutsideInteraction, true)
    return () => {
      document.removeEventListener('pointerdown', closeToolbarMenuOnOutsideInteraction, true)
      document.removeEventListener('focusin', closeToolbarMenuOnOutsideInteraction, true)
    }
  }, [])

  useEffect(() => {
    function closeShortcutHelpOnOutsideInteraction(event: PointerEvent | FocusEvent) {
      const target = event.target as HTMLElement | null
      if (target?.closest('[data-shortcut-help-panel]')) {
        return
      }
      setShortcutHelpOpen(false)
    }

    document.addEventListener('pointerdown', closeShortcutHelpOnOutsideInteraction, true)
    document.addEventListener('focusin', closeShortcutHelpOnOutsideInteraction, true)
    return () => {
      document.removeEventListener('pointerdown', closeShortcutHelpOnOutsideInteraction, true)
      document.removeEventListener('focusin', closeShortcutHelpOnOutsideInteraction, true)
    }
  }, [])

  useEffect(() => {
    function closeSignPickerOnOutsideInteraction(event: PointerEvent | FocusEvent) {
      const target = event.target as Node | null
      if (target && signPickerRef.current?.contains(target)) {
        return
      }
      setSignPickerOpen(false)
    }

    document.addEventListener('pointerdown', closeSignPickerOnOutsideInteraction, true)
    document.addEventListener('focusin', closeSignPickerOnOutsideInteraction, true)
    return () => {
      document.removeEventListener('pointerdown', closeSignPickerOnOutsideInteraction, true)
      document.removeEventListener('focusin', closeSignPickerOnOutsideInteraction, true)
    }
  }, [])

  useEffect(() => {
    function closeFillSignDateMenuOnOutsideInteraction(event: PointerEvent | FocusEvent) {
      const target = event.target as Node | null
      if (target && fillSignDateMenuRef.current?.contains(target)) {
        return
      }
      setFillSignDateMenuOpen(false)
    }

    document.addEventListener('pointerdown', closeFillSignDateMenuOnOutsideInteraction, true)
    document.addEventListener('focusin', closeFillSignDateMenuOnOutsideInteraction, true)
    return () => {
      document.removeEventListener('pointerdown', closeFillSignDateMenuOnOutsideInteraction, true)
      document.removeEventListener('focusin', closeFillSignDateMenuOnOutsideInteraction, true)
    }
  }, [])

  useEffect(() => {
    function deselectSignatureOnOutsidePointer(event: PointerEvent) {
      if (!selectedSignaturePlacementId && !selectedFillSignFieldId) return
      const target = event.target instanceof Element ? event.target : null
      if (
        target?.closest('[data-signature-placement-id]') ||
        target?.closest('[data-signature-toolbar]') ||
        target?.closest('[data-signature-picker]') ||
        target?.closest('[data-fill-sign-field-id]') ||
        target?.closest('[data-fill-sign-toolbar]') ||
        target?.closest('[data-fill-sign-tools]')
      ) {
        return
      }
      setSelectedSignaturePlacementId(null)
      setSelectedFillSignFieldId(null)
    }

    document.addEventListener('pointerdown', deselectSignatureOnOutsidePointer, true)
    return () => document.removeEventListener('pointerdown', deselectSignatureOnOutsidePointer, true)
  }, [selectedFillSignFieldId, selectedSignaturePlacementId])

  useEffect(() => {
    void refreshSavedSignatures()
  }, [])

  useEffect(() => {
    function isInternalDrag(event: DragEvent) {
      return Array.from(event.dataTransfer?.types ?? []).includes('application/x-nextpdf-signature')
    }

    function hasFiles(event: DragEvent) {
      return Array.from(event.dataTransfer?.types ?? []).includes('Files')
    }

    function handleDragEnter(event: DragEvent) {
      if (isInternalDrag(event) || !hasFiles(event)) {
        return
      }

      event.preventDefault()
      dragDepthRef.current += 1
      setDragActive(true)
      const pane = (event.target as Element | null)?.closest<HTMLElement>('[data-pane]')?.dataset.pane
      setDropTargetPane(pane === 'left' || pane === 'right' ? pane : null)
    }

    function handleDragOver(event: DragEvent) {
      if (isInternalDrag(event) || !hasFiles(event)) {
        return
      }

      event.preventDefault()
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'copy'
      }
      const pane = (event.target as Element | null)?.closest<HTMLElement>('[data-pane]')?.dataset.pane
      setDropTargetPane(pane === 'left' || pane === 'right' ? pane : null)
    }

    function handleDragLeave(event: DragEvent) {
      if (isInternalDrag(event) || !hasFiles(event)) {
        return
      }

      event.preventDefault()
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
      if (dragDepthRef.current === 0) {
        setDragActive(false)
        setDropTargetPane(null)
      }
    }

    function handleDrop(event: DragEvent) {
      if (isInternalDrag(event)) {
        return
      }

      const files = Array.from(event.dataTransfer?.files ?? [])
      if (files.length === 0) {
        return
      }

      event.preventDefault()
      dragDepthRef.current = 0
      setDragActive(false)
      const pane = (event.target as Element | null)?.closest<HTMLElement>('[data-pane]')?.dataset.pane
      const targetPane = pane === 'left' || pane === 'right' ? pane : activePane
      setDropTargetPane(null)

      const firstPdf = files.find((file) => file.name.toLowerCase().endsWith('.pdf'))
      if (!firstPdf) {
        setErrorMessage('Only PDF files can be opened. Drop a file ending in .pdf.')
        return
      }

      void openDroppedPdf(firstPdf, targetPane)
    }

    window.addEventListener('dragenter', handleDragEnter)
    window.addEventListener('dragover', handleDragOver)
    window.addEventListener('dragleave', handleDragLeave)
    window.addEventListener('drop', handleDrop)
    return () => {
      window.removeEventListener('dragenter', handleDragEnter)
      window.removeEventListener('dragover', handleDragOver)
      window.removeEventListener('dragleave', handleDragLeave)
      window.removeEventListener('drop', handleDrop)
    }
  })

  useEffect(
    () => () => {
      window.clearTimeout(navigationTimeoutRef.current)
      window.clearTimeout(zoomDebounceRef.current)
      window.clearTimeout(zoomSnapshotTimeoutRef.current)
      window.clearTimeout(backgroundDocumentTaskRef.current)
      searchIndexAbortRef.current?.abort()
      window.clearTimeout(highlightFocusTimeoutRef.current)
      window.clearTimeout(workspaceSaveTimeoutRef.current)
      window.cancelAnimationFrame(pageScrollFrameRef.current)
      window.cancelAnimationFrame(wheelZoomFrameRef.current)
    },
    [],
  )

  useEffect(() => {
    const header = headerRef.current
    if (!header) {
      return
    }

    const resizeObserver = new ResizeObserver(([entry]) => {
      setHeaderHeight(entry.borderBoxSize[0]?.blockSize ?? entry.contentRect.height)
    })
    resizeObserver.observe(header)
    return () => resizeObserver.disconnect()
  }, [])

  useEffect(() => {
    const thumbnailList = thumbnailListRef.current
    if (!thumbnailSidebarOpen || sidebarTab !== 'thumbnails' || !thumbnailList) {
      return
    }

    const activeThumbnail = thumbnailList.querySelector<HTMLElement>(
      `[data-thumbnail-page="${currentPage}"]`,
    )
    if (!activeThumbnail) {
      return
    }

    const itemTop = activeThumbnail.offsetTop
    const itemBottom = itemTop + activeThumbnail.offsetHeight
    if (itemTop < thumbnailList.scrollTop) {
      thumbnailList.scrollTo({ top: itemTop - 8, behavior: 'smooth' })
    } else if (itemBottom > thumbnailList.scrollTop + thumbnailList.clientHeight) {
      thumbnailList.scrollTo({
        top: itemBottom - thumbnailList.clientHeight + 8,
        behavior: 'smooth',
      })
    }
  }, [currentPage, sidebarTab, thumbnailSidebarOpen])

  useEffect(() => {
    const thumbnailList = thumbnailListRef.current
    if (
      !thumbnailSidebarOpen ||
      sidebarTab !== 'thumbnails' ||
      !thumbnailList ||
      !pdfDocument
    ) {
      return
    }

    const observer = new IntersectionObserver(
      (entries) => {
        setVisibleThumbnailPages((currentPages) => {
          const nextPages = new Set(currentPages)
          let changed = false

          for (const entry of entries) {
            const pageNumber = Number((entry.target as HTMLElement).dataset.thumbnailPage)
            if (entry.isIntersecting && !nextPages.has(pageNumber)) {
              nextPages.add(pageNumber)
              changed = true
            } else if (!entry.isIntersecting && nextPages.delete(pageNumber)) {
              changed = true
            }
          }

          return changed ? nextPages : currentPages
        })
      },
      { root: thumbnailList, rootMargin: '400px 0px' },
    )

    thumbnailList
      .querySelectorAll<HTMLElement>('[data-thumbnail-page]')
      .forEach((item) => observer.observe(item))
    return () => observer.disconnect()
  }, [numPages, pdfDocument, sidebarTab, thumbnailSidebarOpen])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer || numPages === 0 || viewMode === 'single') {
      return
    }

    const nearbyPages = nearbyPageNumbersRef.current
    nearbyPages.clear()
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const pageNumber = Number((entry.target as HTMLElement).dataset.pageNumber)
          if (entry.isIntersecting) {
            nearbyPages.add(pageNumber)
          } else {
            nearbyPages.delete(pageNumber)
          }
        }

        setRenderedPageNumbers(
          createPageRenderSet(
            nearbyPages,
            currentPageRef.current,
            numPages,
            PAGE_RENDER_OVERSCAN,
          ),
        )
      },
      { rootMargin: '500px 0px', threshold: 0 },
    )

    viewer
      .querySelectorAll<HTMLElement>('[data-viewer-page]')
      .forEach((page) => observer.observe(page))
    return () => {
      observer.disconnect()
      nearbyPages.clear()
    }
  }, [numPages, viewMode])

  useEffect(() => {
    if (!searchOpen) {
      return
    }

    const animationFrame = window.requestAnimationFrame(() => {
      searchInputRef.current?.focus()
      searchInputRef.current?.select()
    })
    return () => window.cancelAnimationFrame(animationFrame)
  }, [searchOpen])

  useEffect(() => {
    const query = searchQuery.trim()
    const generation = ++searchGenerationRef.current

    if (!searchOpen || !pdfDocument || query.length === 0) {
      return
    }

    const timeout = window.setTimeout(() => {
      void (async () => {
        try {
          const searchStarted = performance.now()
          const matches: SearchMatch[] = []
          const normalizedQuery = query.toLowerCase()
          setSearchProgress({ processed: 0, total: pdfDocument.numPages })

          for (let batchStart = 1; batchStart <= pdfDocument.numPages; batchStart += 8) {
            const batchEnd = Math.min(pdfDocument.numPages, batchStart + 7)
            const pageNumbers = Array.from(
              { length: batchEnd - batchStart + 1 },
              (_, index) => batchStart + index,
            )
            const pages = await Promise.all(
              pageNumbers.map(async (pageNumber) => ({
                pageNumber,
                pageText: await getPageText(pdfDocument, pageNumber, pageTextCacheRef.current),
              })),
            )

            if (searchGenerationRef.current !== generation) {
              return
            }

            for (const { pageNumber, pageText } of pages) {
              const normalizedText = pageText.text.toLowerCase()
              let matchStart = normalizedText.indexOf(normalizedQuery)
              while (matchStart !== -1) {
                matches.push({
                  index: matches.length,
                  pageNumber,
                  start: matchStart,
                  end: matchStart + normalizedQuery.length,
                  source: 'pdf',
                })
                matchStart = normalizedText.indexOf(
                  normalizedQuery,
                  matchStart + normalizedQuery.length,
                )
              }

              const ocrResults = pageOcrResultsByPage.get(pageNumber) ?? []
              for (const ocrResult of ocrResults) {
                const normalizedOcrText = ocrResult.text.toLowerCase()
                let ocrMatchStart = normalizedOcrText.indexOf(normalizedQuery)
                while (ocrMatchStart !== -1) {
                  matches.push({
                    index: matches.length,
                    pageNumber,
                    start: ocrMatchStart,
                    end: ocrMatchStart + normalizedQuery.length,
                    source: 'ocr',
                    language: ocrResult.language,
                  })
                  ocrMatchStart = normalizedOcrText.indexOf(
                    normalizedQuery,
                    ocrMatchStart + normalizedQuery.length,
                  )
                }
              }
            }

            setSearchProgress({ processed: batchEnd, total: pdfDocument.numPages })
            await yieldToMainThread()
          }

          if (searchGenerationRef.current === generation) {
            console.info(
              `Text extraction/search time: ${formatDuration(performance.now() - searchStarted)} (${pdfDocument.numPages} pages)`,
            )
            setSearchMatches(matches)
            const restoredMatchIndex = Math.min(
              matches.length - 1,
              Math.max(0, pendingSearchMatchIndexRef.current),
            )
            setSelectedMatchIndex(matches.length > 0 ? restoredMatchIndex : -1)
            pendingSearchMatchIndexRef.current = -1
            if (matches.length > 0 && viewModeRef.current === 'single') {
              const firstMatchPage = matches[0].pageNumber
              currentPageRef.current = firstMatchPage
              setCurrentPage(firstMatchPage)
              setPageInput(String(firstMatchPage))
            }
            setIsSearching(false)
            setSearchProgress(null)
          }
        } catch (error) {
          if (searchGenerationRef.current === generation) {
            setIsSearching(false)
            setSearchProgress(null)
            setErrorMessage(`Search failed: ${getErrorMessage(error)}`)
          }
        }
      })()
    }, 180)

    return () => window.clearTimeout(timeout)
  }, [pageOcrResultsByPage, pdfDocument, searchOpen, searchQuery])

  useEffect(() => {
    document
      .querySelectorAll('.pdf-search-selected')
      .forEach((element) => element.classList.remove('pdf-search-selected'))

    if (selectedMatchIndex < 0 || selectedMatchIndex >= searchMatches.length) {
      return
    }

    let animationFrame = 0
    let mutationObserver: MutationObserver | null = null
    function revealSelectedMatch() {
      const marks = document.querySelectorAll<HTMLElement>(
        `[data-search-match="${selectedMatchIndex}"]`,
      )

      if (marks.length === 0) {
        return
      }

      mutationObserver?.disconnect()
      marks.forEach((mark) => mark.classList.add('pdf-search-selected'))
      marks[0]?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' })
    }

    mutationObserver = new MutationObserver(revealSelectedMatch)
    if (viewerRef.current) {
      mutationObserver.observe(viewerRef.current, { childList: true, subtree: true })
    }
    animationFrame = window.requestAnimationFrame(revealSelectedMatch)
    return () => {
      mutationObserver?.disconnect()
      window.cancelAnimationFrame(animationFrame)
    }
  }, [searchMatches, selectedMatchIndex])

  useEffect(() => {
    return window.electronAPI.onPageOcrProgress((progress) => {
      setOcrJob((current) => {
        if (!current) return current
        const batchOperationId = progress.operationId.split(':page:')[0]
        if (
          current.operationId !== progress.operationId &&
          current.operationId !== batchOperationId
        ) {
          return current
        }
        return {
          ...current,
          status: progress.status,
          progress: progress.progress,
        }
      })
    })
  }, [])

  useEffect(() => {
    window.localStorage.setItem('next-pdf-viewer:ocr-language', ocrLanguage)
  }, [ocrLanguage])

  useEffect(() => {
    if (!pdfDocument || !pdfFile) {
      return
    }
    let cancelled = false
    void getPageText(pdfDocument, currentPage, pageTextCacheRef.current)
      .then((pageText) => {
        if (!cancelled) {
          setCurrentPageTextStatus(
            countMeaningfulTextCharacters(pageText.text) >= 20 ? 'searchable' : 'empty',
          )
        }
      })
      .catch(() => {
        if (!cancelled) setCurrentPageTextStatus('unknown')
      })
    return () => {
      cancelled = true
    }
  }, [currentPage, pdfDocument, pdfFile])

  useEffect(() => {
    const viewer = viewerRef.current

    if (!viewer) {
      return
    }

    const resizeObserver = new ResizeObserver(([entry]) => {
      captureZoomAnchor()
      setViewerWidth(entry.contentRect.width)
    })

    resizeObserver.observe(viewer)
    return () => resizeObserver.disconnect()
  }, [pdfFile])

  useEffect(() => {
    const anchor = zoomAnchorRef.current
    const page = viewerRef.current?.querySelector<HTMLElement>(
      `[data-page-number="${anchor?.pageNumber}"]`,
    )

    if (!anchor || !page) {
      isRestoringZoomPositionRef.current = false
      return
    }

    const zoomAnchor = anchor
    const anchoredPage = page

    let restoreFrame = 0
    let finishFrame = 0
    function restorePosition(finish = false) {
      window.cancelAnimationFrame(restoreFrame)
      restoreFrame = window.requestAnimationFrame(() => {
        const bounds = anchoredPage.getBoundingClientRect()
        const viewportTop = headerRef.current?.offsetHeight ?? 0
        const desiredPageTop =
          viewportTop + zoomAnchor.topMargin - zoomAnchor.relativeOffset * bounds.height
        window.scrollBy({ top: bounds.top - desiredPageTop, behavior: 'auto' })

        if (finish) {
          finishFrame = window.requestAnimationFrame(() => {
            zoomAnchorRef.current = null
            isRestoringZoomPositionRef.current = false
          })
        }
      })
    }

    const resizeObserver = new ResizeObserver(() => restorePosition())
    restorePosition()
    const timeout = window.setTimeout(() => {
      restorePosition(true)
      resizeObserver.disconnect()
    }, 300)

    resizeObserver.observe(anchoredPage)
    return () => {
      resizeObserver.disconnect()
      window.cancelAnimationFrame(restoreFrame)
      window.cancelAnimationFrame(finishFrame)
      window.clearTimeout(timeout)
    }
  }, [isFullscreen, renderZoom, rotation, viewMode])

  useEffect(() => {
    const requestedPage = pendingRestorePageRef.current
    const viewer = viewerRef.current

    if (
      !isRestoring ||
      requestedPage === null ||
      !viewer ||
      numPages === 0 ||
      (zoomMode === 'fit-width' && firstPageWidth === 0)
    ) {
      return
    }

    const pageNumber = Math.min(numPages, Math.max(1, requestedPage))
    const targetPage = pageRefs.current.get(pageNumber)
    const pageList = targetPage?.parentElement
    if (!targetPage || !pageList) {
      return
    }
    const restoredPage = targetPage
    const restoredPageList = pageList

    let animationFrame = 0
    let settleTimeout = 0
    let restoredLogged = false
    let finishing = false
    let finished = false

    function targetPageIsRendered() {
      return restoredPage.querySelector('.react-pdf__Page__canvas') !== null
    }

    function scrollToRestoredPage() {
      const headerHeight = headerRef.current?.offsetHeight ?? 0
      const pageOffset = pendingRestoreOffsetRef.current
      const restoredBounds = restoredPage.getBoundingClientRect()
      const targetTop =
        window.scrollY +
        restoredBounds.top -
        headerHeight +
        (pageOffset > 0 ? restoredBounds.height * pageOffset : -16)
      window.scrollTo({
        top: targetTop,
        behavior: 'auto',
      })
      currentPageRef.current = pageNumber
      setCurrentPage(pageNumber)
      setPageInput(String(pageNumber))
      if (!restoredLogged) {
        console.debug('Restored page:', pageNumber)
        restoredLogged = true
      }
    }

    function getActualVisiblePage() {
      const viewportTop = headerRef.current?.offsetHeight ?? 0
      let actualPage = pageNumber
      let largestVisibleHeight = -1

      for (const [candidatePage, page] of pageRefs.current) {
        const bounds = page.getBoundingClientRect()
        const visibleHeight = Math.max(
          0,
          Math.min(bounds.bottom, window.innerHeight) - Math.max(bounds.top, viewportTop),
        )
        if (visibleHeight > largestVisibleHeight) {
          largestVisibleHeight = visibleHeight
          actualPage = candidatePage
        }
      }

      return actualPage
    }

    function finishRestoration() {
      if (finished || finishing) {
        return
      }

      finishing = true
      scrollToRestoredPage()
      animationFrame = window.requestAnimationFrame(() => {
        scrollToRestoredPage()
        animationFrame = window.requestAnimationFrame(() => {
          const actualPage = getActualVisiblePage()
          console.debug('Actual page after restore:', actualPage)
          currentPageRef.current = pageNumber
          setCurrentPage(pageNumber)
          setPageInput(String(pageNumber))
          pendingRestorePageRef.current = null
          pendingRestoreOffsetRef.current = 0
          restoringReadingStateRef.current = false
          finished = true
          setIsRestoring(false)
        })
      })
    }

    function scheduleRestoration() {
      if (finished || finishing) {
        return
      }

      window.cancelAnimationFrame(animationFrame)
      window.clearTimeout(settleTimeout)
      if (!targetPageIsRendered()) {
        return
      }

      animationFrame = window.requestAnimationFrame(() => {
        scrollToRestoredPage()
        settleTimeout = window.setTimeout(finishRestoration, 300)
      })
    }

    const resizeObserver = new ResizeObserver(scheduleRestoration)
    const mutationObserver = new MutationObserver(scheduleRestoration)
    const fallbackTimeout = window.setTimeout(finishRestoration, 30000)
    resizeObserver.observe(restoredPageList)
    mutationObserver.observe(restoredPageList, {
      attributes: true,
      childList: true,
      subtree: true,
    })
    scheduleRestoration()

    return () => {
      resizeObserver.disconnect()
      mutationObserver.disconnect()
      window.cancelAnimationFrame(animationFrame)
      window.clearTimeout(settleTimeout)
      window.clearTimeout(fallbackTimeout)
    }
  }, [firstPageWidth, isRestoring, numPages, renderZoom, rotation, zoomMode])

  useEffect(() => {
    if (
      !activeDocumentId ||
      numPages === 0 ||
      isRestoring ||
      restoringReadingStateRef.current
    ) {
      return
    }

    const timeout = window.setTimeout(() => {
      if (restoringReadingStateRef.current) {
        return
      }

      console.debug('Saved page:', currentPage)
      void window.electronAPI
        .savePdfState(activeDocumentId, {
          page: currentPage,
          zoom: displayZoom,
          fitMode: zoomMode === 'fit-width',
          rotation,
        })
        .catch((error) => setErrorMessage(getErrorMessage(error)))
    }, 250)

    return () => window.clearTimeout(timeout)
  }, [activeDocumentId, currentPage, displayZoom, isRestoring, numPages, rotation, zoomMode])

  useEffect(() => {
    const viewer = viewerRef.current

    if (!viewer || numPages === 0 || isRestoring) {
      return
    }

    const visiblePages = new Set<HTMLElement>()
    let animationFrame = 0

    function updateCurrentPage() {
      animationFrame = 0
      if (restoringReadingStateRef.current || isRestoringZoomPositionRef.current) {
        return
      }

      const viewportTop = headerRef.current?.offsetHeight ?? 0
      let mostVisiblePage = 0
      let largestVisibleHeight = 0

      for (const page of visiblePages) {
        const bounds = page.getBoundingClientRect()
        const visibleHeight = Math.max(
          0,
          Math.min(bounds.bottom, window.innerHeight) - Math.max(bounds.top, viewportTop),
        )

        if (visibleHeight > largestVisibleHeight) {
          largestVisibleHeight = visibleHeight
          mostVisiblePage = Number(page.dataset.pageNumber)
        }
      }

      if (mostVisiblePage > 0) {
        const navigationTarget = navigationTargetRef.current
        if (navigationTarget !== null && mostVisiblePage !== navigationTarget) {
          return
        }

        if (navigationTarget === mostVisiblePage) {
          navigationTargetRef.current = null
          window.clearTimeout(navigationTimeoutRef.current)
        }

        currentPageRef.current = mostVisiblePage
        setCurrentPage((previousPage) => {
          if (mostVisiblePage !== previousPage && !pageInputFocusedRef.current) {
            setPageInput(String(mostVisiblePage))
          }
          return mostVisiblePage
        })
      }
    }

    function scheduleCurrentPageUpdate() {
      if (animationFrame === 0) {
        animationFrame = window.requestAnimationFrame(updateCurrentPage)
      }
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const page = entry.target as HTMLElement
          if (entry.isIntersecting) {
            visiblePages.add(page)
          } else {
            visiblePages.delete(page)
          }
        }
        scheduleCurrentPageUpdate()
      },
      { threshold: 0 },
    )

    const pages = viewer.querySelectorAll<HTMLElement>('[data-page-number]')
    pages.forEach((page) => observer.observe(page))
    window.addEventListener('scroll', scheduleCurrentPageUpdate, { passive: true })
    window.addEventListener('resize', scheduleCurrentPageUpdate)

    return () => {
      observer.disconnect()
      window.removeEventListener('scroll', scheduleCurrentPageUpdate)
      window.removeEventListener('resize', scheduleCurrentPageUpdate)
      window.cancelAnimationFrame(animationFrame)
    }
  }, [isRestoring, numPages, observedSinglePage, viewMode])

  useEffect(() => {
    if (!splitEnabled || !syncScrolling || !rightDocument) {
      return
    }
    let frame = 0
    function syncRightPane() {
      frame = 0
      if (suppressLeftSyncRef.current) {
        return
      }
      const pageNumber = currentPageRef.current
      const page = pageRefs.current.get(pageNumber)
      if (!page) {
        return
      }
      const bounds = page.getBoundingClientRect()
      const viewportTop = headerRef.current?.offsetHeight ?? 0
      const offset = Math.min(1, Math.max(0, (viewportTop - bounds.top) / bounds.height))
      const previous = lastLeftScrollPositionRef.current
      if (previous.page === pageNumber && Math.abs(previous.offset - offset) < 0.005) {
        return
      }
      lastLeftScrollPositionRef.current = { page: pageNumber, offset }
      rightPaneRef.current?.applyScrollPosition({
        page: pageNumber,
        offset,
        token: ++syncScrollTokenRef.current,
      })
    }
    function scheduleSync() {
      if (!frame) frame = window.requestAnimationFrame(syncRightPane)
    }
    window.addEventListener('scroll', scheduleSync, { passive: true })
    return () => {
      window.removeEventListener('scroll', scheduleSync)
      window.cancelAnimationFrame(frame)
    }
  }, [rightDocument, splitEnabled, syncScrolling])

  useEffect(() => {
    function handleSelectionPointerUp(event: PointerEvent) {
      const target = event.target instanceof Element ? event.target : null
      if (
        event.button !== 0 ||
        !pdfFile ||
        !target?.closest('[data-pane="left"]') ||
        !target?.closest('.react-pdf__Page__textContent') ||
        target.closest('[data-highlight-toolbar]')
      ) {
        return
      }

      window.requestAnimationFrame(() => {
        const selection = readPdfTextSelection()
        setPendingHighlightSelection(selection)
        setHighlightContextMenu(null)
      })
    }

    function handleOutsidePointerDown(event: PointerEvent) {
      const target = event.target instanceof Element ? event.target : null
      if (
        target?.closest('[data-highlight-toolbar]') ||
        target?.closest('[data-highlight-context-menu]')
      ) {
        return
      }

      setTabContextMenu(null)
      setHighlightContextMenu(null)
      if (!target?.closest('.react-pdf__Page__textContent')) {
        setPendingHighlightSelection(null)
      }
    }

    function handleViewerScroll() {
      setPendingHighlightSelection(null)
      setHighlightContextMenu(null)
    }

    window.addEventListener('pointerup', handleSelectionPointerUp)
    window.addEventListener('pointerdown', handleOutsidePointerDown)
    window.addEventListener('scroll', handleViewerScroll, true)
    return () => {
      window.removeEventListener('pointerup', handleSelectionPointerUp)
      window.removeEventListener('pointerdown', handleOutsidePointerDown)
      window.removeEventListener('scroll', handleViewerScroll, true)
    }
  })

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null
      const activePaneHasDocument = splitEnabled && activePane === 'right'
        ? Boolean(rightDocument)
        : numPages > 0

      if (event.key === 'F11') {
        event.preventDefault()
        if (!event.repeat) {
          void toggleFullscreen()
        }
        return
      }

      if (event.key === 'Escape' && isFullscreen) {
        event.preventDefault()
        void exitFullscreen()
        return
      }

      if (event.key === 'Escape' && tabContextMenu) {
        event.preventDefault()
        setTabContextMenu(null)
        return
      }

      if (event.key === 'Escape' && splitMenuOpen) {
        event.preventDefault()
        setSplitMenuOpen(false)
        return
      }

      if (event.key === 'Escape' && pdfToolsMenuOpen) {
        event.preventDefault()
        setPdfToolsMenuOpen(false)
        return
      }

      if (event.key === 'Escape' && toolbarMenuOpen) {
        event.preventDefault()
        setToolbarMenuOpen(null)
        return
      }

      if (event.key === 'Escape' && (signPickerOpen || signingSignature)) {
        event.preventDefault()
        setSignPickerOpen(false)
        setSigningSignature(null)
        setSelectedSignaturePlacementId(null)
        return
      }

      if (event.key === 'Escape' && selectedSignaturePlacementId) {
        event.preventDefault()
        setSelectedSignaturePlacementId(null)
        return
      }

      if (event.key === 'Escape' && (activeFillSignTool || selectedFillSignFieldId)) {
        event.preventDefault()
        setActiveFillSignTool(null)
        setSelectedFillSignFieldId(null)
        return
      }

      if (selectedFillSignFieldId && activePane !== 'right') {
        if (isEditableKeyboardTarget(target)) {
          return
        }
        if (event.key === 'Delete' || event.key === 'Backspace') {
          event.preventDefault()
          deleteLeftFillSignField(selectedFillSignFieldId)
          return
        }
        if (event.ctrlKey && !event.shiftKey && event.key.toLowerCase() === 'd') {
          event.preventDefault()
          duplicateLeftFillSignField(selectedFillSignFieldId)
          return
        }
      }

      if (selectedSignaturePlacementId && activePane !== 'right') {
        if (event.key === 'Delete' || event.key === 'Backspace') {
          event.preventDefault()
          deleteLeftSignaturePlacement(selectedSignaturePlacementId)
          return
        }
        if (event.ctrlKey && !event.shiftKey && event.key.toLowerCase() === 'd') {
          event.preventDefault()
          duplicateLeftSignaturePlacement(selectedSignaturePlacementId)
          return
        }
      }

      if (event.key === 'Escape' && globalSearchOpen) {
        event.preventDefault()
        closeGlobalSearch()
        return
      }

      if (event.ctrlKey && event.key === 'Tab') {
        event.preventDefault()
        cycleTabs(event.shiftKey ? -1 : 1)
        return
      }

      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 't') {
        event.preventDefault()
        void restoreClosedTab()
        return
      }

      if (event.ctrlKey && !event.shiftKey && event.key.toLowerCase() === 'w') {
        event.preventDefault()
        const tabId = splitEnabled && activePane === 'right' ? rightTabId : activeTabIdRef.current
        if (tabId) {
          void closeTab(tabId)
        }
        return
      }

      if (event.ctrlKey && !event.shiftKey && (event.key === '\\' || event.code === 'Backslash')) {
        event.preventDefault()
        if (splitEnabled) closeSplitView()
        else void splitCurrentTab()
        return
      }

      if (event.ctrlKey && event.shiftKey && event.key === 'ArrowLeft') {
        event.preventDefault()
        focusPane('left')
        viewerRef.current?.focus()
        return
      }

      if (event.ctrlKey && event.shiftKey && event.key === 'ArrowRight' && splitEnabled) {
        event.preventDefault()
        focusPane('right')
        rightPaneRef.current?.focus()
        return
      }

      if (event.ctrlKey && !event.shiftKey && /^[1-9]$/.test(event.key)) {
        const tabIndex = Number(event.key) - 1
        const tab = tabsRef.current[tabIndex]
        if (tab) {
          event.preventDefault()
          activateTabForPane(tab.tabId)
        }
        return
      }

      if (event.ctrlKey && event.key.toLowerCase() === 'o') {
        event.preventDefault()
        void openPdf()
        return
      }

      if (event.ctrlKey && event.key.toLowerCase() === 'p') {
        event.preventDefault()
        if (splitEnabled && activePane === 'right' ? rightDocument : activeDocumentId) {
          void printCurrentPdf()
        }
        return
      }

      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        setGlobalDashboardOpen(false)
        setGlobalSearchReturnToDashboard(false)
        setGlobalSearchOpen(true)
        return
      }

      if (event.ctrlKey && !event.shiftKey && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        openActivePaneSearch()
        return
      }

      if (event.ctrlKey && event.key.toLowerCase() === 'h') {
        event.preventDefault()
        if (splitEnabled && activePane === 'right') {
          rightPaneRef.current?.highlightSelection('yellow')
          return
        }
        const selection = pendingHighlightSelection ?? readPdfTextSelection()
        if (selection) {
          addHighlight(selection, 'yellow')
        }
        return
      }

      if (event.key === 'Escape' && shortcutHelpOpen) {
        setShortcutHelpOpen(false)
        return
      }

      if (event.key === 'Escape' && exportMenuOpen) {
        setExportMenuOpen(false)
        return
      }

      if (event.key === 'Escape' && exportHighlightsOpen) {
        setExportHighlightsOpen(false)
        return
      }

      if (event.ctrlKey && activePaneHasDocument) {
        if (event.key === '+' || event.key === '=' || event.code === 'NumpadAdd') {
          event.preventDefault()
          changeActiveZoom(0.25)
          return
        }

        if (event.key === '-' || event.code === 'NumpadSubtract') {
          event.preventDefault()
          changeActiveZoom(-0.25)
          return
        }

        if (event.key === '0' || event.code === 'Numpad0') {
          event.preventDefault()
          changeActiveZoom('reset')
          return
        }
      }

      if (
        target?.matches('input, textarea, select') ||
        target?.isContentEditable ||
        !activePaneHasDocument
      ) {
        return
      }

      const navigationActions: Partial<Record<KeyboardEvent['key'], 'next' | 'previous' | 'first' | 'last'>> = {
        PageDown: 'next',
        PageUp: 'previous',
        Home: 'first',
        End: 'last',
      }
      const navigationAction = navigationActions[event.key]

      if (navigationAction) {
        event.preventDefault()
        goToActivePage(navigationAction)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  })

  useEffect(() => {
    function handleWheel(event: WheelEvent) {
      const activePaneHasDocument = splitEnabled && activePane === 'right'
        ? Boolean(rightDocument)
        : numPages > 0
      if (!event.ctrlKey || !activePaneHasDocument) {
        wheelDeltaRef.current = 0
        return
      }

      event.preventDefault()

      const normalizedDelta =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? event.deltaY * 40
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? event.deltaY * window.innerHeight
            : event.deltaY

      if (
        wheelDeltaRef.current !== 0 &&
        Math.sign(wheelDeltaRef.current) !== Math.sign(normalizedDelta)
      ) {
        wheelDeltaRef.current = 0
      }

      wheelDeltaRef.current += normalizedDelta
      if (Math.abs(wheelDeltaRef.current) < 50) {
        return
      }

      if (wheelZoomFrameRef.current !== 0) {
        return
      }

      wheelZoomFrameRef.current = window.requestAnimationFrame(() => {
        wheelZoomFrameRef.current = 0
        const zoomStep = wheelDeltaRef.current < 0 ? 0.1 : -0.1
        wheelDeltaRef.current = 0
        if (splitEnabled && activePane === 'right') {
          rightPaneRef.current?.zoomBy(zoomStep)
        } else {
          changeZoom(displayZoomRef.current + zoomStep)
        }
      })
    }

    window.addEventListener('wheel', handleWheel, { passive: false })
    return () => {
      window.removeEventListener('wheel', handleWheel)
      window.cancelAnimationFrame(wheelZoomFrameRef.current)
      wheelZoomFrameRef.current = 0
    }
  })

  function captureZoomAnchor() {
    if (restoringReadingStateRef.current) {
      return
    }

    const pageNumber = currentPageRef.current
    const page = viewerRef.current?.querySelector<HTMLElement>(
      `[data-page-number="${pageNumber}"]`,
    )

    if (!page) {
      return
    }

    const bounds = page.getBoundingClientRect()
    const viewportTop = headerRef.current?.offsetHeight ?? 0
    const offsetInsidePage = viewportTop - bounds.top
    zoomAnchorRef.current = {
      pageNumber,
      relativeOffset: Math.min(1, Math.max(0, offsetInsidePage / bounds.height)),
      topMargin: Math.max(0, -offsetInsidePage),
    }
  }

  function preserveRenderedPagesForZoom() {
    for (const page of pageRefs.current.values()) {
      const source = page.querySelector<HTMLCanvasElement>('.react-pdf__Page__canvas')
      const snapshotHost = page.querySelector<HTMLElement>('[data-zoom-snapshot]')
      if (!source || !snapshotHost || source.style.visibility === 'hidden') {
        continue
      }

      const snapshot = document.createElement('canvas')
      snapshot.width = source.width
      snapshot.height = source.height
      snapshot.style.width = '100%'
      snapshot.style.height = '100%'
      snapshot.style.display = 'block'
      snapshot.setAttribute('aria-hidden', 'true')
      snapshot.getContext('2d')?.drawImage(source, 0, 0)
      snapshotHost.replaceChildren(snapshot)
    }
  }

  function clearZoomSnapshot(pageNumber: number) {
    pageRefs.current
      .get(pageNumber)
      ?.querySelector<HTMLElement>('[data-zoom-snapshot]')
      ?.replaceChildren()
  }

  function clearZoomSnapshots() {
    for (const page of pageRefs.current.values()) {
      page.querySelector<HTMLElement>('[data-zoom-snapshot]')?.replaceChildren()
    }
  }

  function changeZoom(nextScale: number) {
    const normalizedScale = clampScale(nextScale)
    if (normalizedScale === displayZoomRef.current && zoomMode === 'manual') {
      return
    }

    captureZoomAnchor()
    isRestoringZoomPositionRef.current = true
    setIsZooming(true)
    displayZoomRef.current = normalizedScale
    setDisplayZoom(normalizedScale)
    setZoomMode('manual')
  }

  function fitWidth() {
    if (zoomMode === 'fit-width') {
      return
    }

    if (
      Math.abs(fitWidthZoom - displayZoomRef.current) < 0.001 &&
      Math.abs(fitWidthZoom - renderZoom) < 0.001
    ) {
      setZoomMode('fit-width')
      return
    }

    captureZoomAnchor()
    isRestoringZoomPositionRef.current = true
    setZoomMode('fit-width')
  }

  async function toggleFullscreen() {
    captureZoomAnchor()
    isRestoringZoomPositionRef.current = true
    try {
      setIsFullscreen(await window.electronAPI.toggleFullscreen())
    } catch (error) {
      zoomAnchorRef.current = null
      isRestoringZoomPositionRef.current = false
      setErrorMessage(`Fullscreen failed: ${getErrorMessage(error)}`)
    }
  }

  async function exitFullscreen() {
    captureZoomAnchor()
    isRestoringZoomPositionRef.current = true
    try {
      await window.electronAPI.exitFullscreen()
      setIsFullscreen(false)
    } catch (error) {
      zoomAnchorRef.current = null
      isRestoringZoomPositionRef.current = false
      setErrorMessage(`Could not exit fullscreen: ${getErrorMessage(error)}`)
    }
  }

  function goToPage(requestedPage: number, behavior: ScrollBehavior = 'smooth') {
    if (numPages === 0) {
      return
    }

    if (restoringReadingStateRef.current) {
      pendingRestorePageRef.current = null
      restoringReadingStateRef.current = false
      setIsRestoring(false)
    }

    const pageNumber = Math.min(numPages, Math.max(1, requestedPage))
    ensurePageRenderWindow(pageNumber)
    beginProgrammaticNavigation(pageNumber, behavior)
    currentPageRef.current = pageNumber
    setCurrentPage(pageNumber)
    setPageInput(String(pageNumber))
    const generation = ++pageNavigationGenerationRef.current
    scrollToPageWhenReady(pageNumber, behavior, generation)
  }

  function ensurePageRenderWindow(pageNumber: number) {
    setRenderedPageNumbers((currentPages) => {
      const nextPages = new Set(currentPages)
      addPageWindow(nextPages, pageNumber, numPages, PAGE_RENDER_OVERSCAN)
      return setsAreEqual(currentPages, nextPages) ? currentPages : nextPages
    })
  }

  function scrollToPageWhenReady(
    pageNumber: number,
    behavior: ScrollBehavior,
    generation: number,
    attempt = 0,
  ) {
    window.cancelAnimationFrame(pageScrollFrameRef.current)
    pageScrollFrameRef.current = window.requestAnimationFrame(() => {
      if (pageNavigationGenerationRef.current !== generation) {
        return
      }

      const page = pageRefs.current.get(pageNumber)
      if (!page) {
        if (attempt < 60) {
          scrollToPageWhenReady(pageNumber, behavior, generation, attempt + 1)
        }
        return
      }

      const headerHeight = headerRef.current?.offsetHeight ?? 0
      const targetTop = window.scrollY + page.getBoundingClientRect().top - headerHeight - 16
      window.scrollTo({ top: targetTop, behavior })
    })
  }

  function beginProgrammaticNavigation(pageNumber: number, behavior: ScrollBehavior) {
    window.clearTimeout(navigationTimeoutRef.current)

    if (behavior !== 'smooth') {
      navigationTargetRef.current = null
      return
    }

    navigationTargetRef.current = pageNumber
    navigationTimeoutRef.current = window.setTimeout(() => {
      navigationTargetRef.current = null
    }, 1200)
  }

  function toggleViewMode() {
    captureZoomAnchor()
    isRestoringZoomPositionRef.current = true
    const nextViewMode: ViewMode = viewMode === 'continuous' ? 'single' : 'continuous'
    setViewMode(nextViewMode)
    void window.electronAPI
      .setViewMode(nextViewMode)
      .catch((error) => setErrorMessage(getErrorMessage(error)))
  }

  function changeViewerBackground(background: ViewerBackground) {
    setViewerBackground(background)
    void window.electronAPI
      .setViewerBackground(background)
      .catch((error) => setErrorMessage(getErrorMessage(error)))
  }

  function toggleSidebar() {
    const expanded = !thumbnailSidebarOpen
    setThumbnailSidebarOpen(expanded)
    void window.electronAPI
      .setSidebarLayout({ width: sidebarWidth, collapsed: !expanded })
      .catch((error) => setErrorMessage(getErrorMessage(error)))
  }

  function startSidebarResize(event: React.PointerEvent<HTMLDivElement>) {
    if (!thumbnailSidebarOpen) {
      return
    }

    event.preventDefault()
    const resizeHandle = event.currentTarget
    const pointerId = event.pointerId
    resizeHandle.setPointerCapture(pointerId)
    const startX = event.clientX
    const startWidth = sidebarWidth
    let resizedWidth = sidebarWidth
    setSidebarResizing(true)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    function handlePointerMove(pointerEvent: PointerEvent) {
      resizedWidth = Math.min(400, Math.max(220, startWidth + pointerEvent.clientX - startX))
      setSidebarWidth(resizedWidth)
    }

    function finishResize() {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', finishResize)
      window.removeEventListener('pointercancel', finishResize)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      if (resizeHandle.hasPointerCapture(pointerId)) {
        resizeHandle.releasePointerCapture(pointerId)
      }
      setSidebarResizing(false)
      void window.electronAPI
        .setSidebarLayout({ width: resizedWidth, collapsed: false })
        .catch((error) => setErrorMessage(getErrorMessage(error)))
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', finishResize)
    window.addEventListener('pointercancel', finishResize)
  }

  function submitPageInput() {
    const requestedPage = Number.parseInt(pageInput, 10)

    if (Number.isNaN(requestedPage)) {
      setPageInput(String(currentPage))
      return
    }

    goToPage(requestedPage)
  }

  function readPdfTextSelection(): PendingHighlightSelection | null {
    if (!pdfFile || isZooming) {
      return null
    }

    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      return null
    }

    const range = selection.getRangeAt(0)
    const startPage = getPdfPageElement(range.startContainer)
    const endPage = getPdfPageElement(range.endContainer)
    const selectionBelongsToLeftPane = Boolean(startPage?.closest('[data-pane="left"]'))
    if (!startPage || startPage !== endPage || !selectionBelongsToLeftPane) {
      if (!selectionBelongsToLeftPane) return null
      setErrorMessage('Highlights must be created within a single PDF page.')
      return null
    }

    const pageNumber = Number(startPage.dataset.pageNumber)
    const pageBounds = startPage.getBoundingClientRect()
    const text = selection.toString().replace(/\s+/g, ' ').trim()
    if (!Number.isFinite(pageNumber) || !text || pageBounds.width <= 0 || pageBounds.height <= 0) {
      return null
    }

    const clientRectangles = Array.from(range.getClientRects()).filter(
      (rectangle) =>
        rectangle.width > 0.5 &&
        rectangle.height > 0.5 &&
        rectangle.right > pageBounds.left &&
        rectangle.left < pageBounds.right &&
        rectangle.bottom > pageBounds.top &&
        rectangle.top < pageBounds.bottom,
    )
    const rectangles = clientRectangles.map((rectangle) => ({
      x: clampUnit((Math.max(rectangle.left, pageBounds.left) - pageBounds.left) / pageBounds.width),
      y: clampUnit((Math.max(rectangle.top, pageBounds.top) - pageBounds.top) / pageBounds.height),
      width: clampUnit(
        (Math.min(rectangle.right, pageBounds.right) - Math.max(rectangle.left, pageBounds.left)) /
          pageBounds.width,
      ),
      height: clampUnit(
        (Math.min(rectangle.bottom, pageBounds.bottom) - Math.max(rectangle.top, pageBounds.top)) /
          pageBounds.height,
      ),
    }))
    if (rectangles.length === 0) {
      return null
    }

    const selectionBounds = clientRectangles.reduce(
      (bounds, rectangle) => ({
        left: Math.min(bounds.left, rectangle.left),
        top: Math.min(bounds.top, rectangle.top),
        right: Math.max(bounds.right, rectangle.right),
        bottom: Math.max(bounds.bottom, rectangle.bottom),
      }),
      {
        left: clientRectangles[0].left,
        top: clientRectangles[0].top,
        right: clientRectangles[0].right,
        bottom: clientRectangles[0].bottom,
      },
    )

    return {
      pageNumber,
      text,
      rectangles,
      rotation,
      toolbarX: Math.min(window.innerWidth - 150, Math.max(150, (selectionBounds.left + selectionBounds.right) / 2)),
      toolbarY:
        selectionBounds.top > 64 ? selectionBounds.top - 52 : selectionBounds.bottom + 10,
    }
  }

  function addHighlight(selection: PendingHighlightSelection, color: HighlightColor) {
    const duplicate = highlights.find(
      (highlight) =>
        highlight.pageNumber === selection.pageNumber &&
        normalizeHighlightText(highlight.text) === normalizeHighlightText(selection.text) &&
        highlight.rectangles.some((rectangle) =>
          selection.rectangles.some((selectedRectangle) =>
            rectanglesOverlap(
              transformHighlightRectangle(
                rectangle,
                normalizeRotation(selection.rotation - highlight.rotation),
              ),
              selectedRectangle,
            ),
          ),
        ),
    )
    if (duplicate) {
      updateHighlights(
        highlights.map((highlight) =>
          highlight.id === duplicate.id
            ? {
                ...highlight,
                color,
                rectangles: selection.rectangles,
                rotation: selection.rotation,
              }
            : highlight,
        ),
      )
      clearHighlightSelection()
      return
    }

    const highlight: PdfHighlight = {
      id: crypto.randomUUID(),
      pageNumber: selection.pageNumber,
      text: selection.text,
      color,
      category: DEFAULT_CATEGORY_BY_COLOR[color],
      note: '',
      rectangles: selection.rectangles,
      rotation: selection.rotation,
      createdDate: new Date().toISOString(),
    }
    updateHighlights([...highlights, highlight])
    clearHighlightSelection()
  }

  function removeSelectedHighlights(selection: PendingHighlightSelection) {
    const idsToRemove = new Set(
      highlights
        .filter((highlight) => highlight.pageNumber === selection.pageNumber)
        .filter((highlight) =>
          highlight.rectangles.some((rectangle) => {
            const transformed = transformHighlightRectangle(
              rectangle,
              normalizeRotation(selection.rotation - highlight.rotation),
            )
            return selection.rectangles.some((selectedRectangle) =>
              rectanglesOverlap(transformed, selectedRectangle),
            )
          }),
        )
        .map((highlight) => highlight.id),
    )

    if (idsToRemove.size > 0) {
      updateHighlights(highlights.filter((highlight) => !idsToRemove.has(highlight.id)))
    }
    clearHighlightSelection()
  }

  function removeHighlight(highlightId: string) {
    if (!sidebarHighlights.some((highlight) => highlight.id === highlightId)) {
      return
    }

    updateSidebarHighlights(sidebarHighlights.filter((highlight) => highlight.id !== highlightId))
    updateSidebarHighlightSelection((current) => {
      const next = new Set(current)
      next.delete(highlightId)
      return next
    })
    setHighlightContextMenu(null)
    if (focusedHighlightId === highlightId) {
      setFocusedHighlightId(null)
    }
  }

  function changeHighlightColor(highlightId: string, color: HighlightColor) {
    updateSidebarHighlights(
      sidebarHighlights.map((highlight) =>
        highlight.id === highlightId ? { ...highlight, color } : highlight,
      ),
    )
    setHighlightContextMenu(null)
  }

  function changeHighlightCategory(highlightId: string, category: HighlightCategory) {
    updateSidebarHighlights(
      sidebarHighlights.map((highlight) =>
        highlight.id === highlightId ? { ...highlight, category } : highlight,
      ),
    )
    setHighlightContextMenu(null)
  }

  async function copyHighlightText(highlightId: string) {
    const highlight = sidebarHighlights.find((candidate) => candidate.id === highlightId)
    if (!highlight) {
      return
    }

    try {
      await navigator.clipboard.writeText(highlight.text)
      setHighlightContextMenu(null)
    } catch (error) {
      setErrorMessage(`Could not copy highlighted text: ${getErrorMessage(error)}`)
    }
  }

  async function copyHighlightWithNote(highlightId: string) {
    const highlight = sidebarHighlights.find((candidate) => candidate.id === highlightId)
    if (!highlight) {
      return
    }

    try {
      await navigator.clipboard.writeText(
        highlight.note ? `${highlight.text}\n\n${highlight.note}` : highlight.text,
      )
      setHighlightContextMenu(null)
    } catch (error) {
      setErrorMessage(`Could not copy highlight and note: ${getErrorMessage(error)}`)
    }
  }

  function startEditingNote(highlightId: string) {
    setEditingNoteId(highlightId)
    setHighlightContextMenu(null)
    setSidebarTab('highlights')
    if (!thumbnailSidebarOpen) {
      setThumbnailSidebarOpen(true)
    }
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLTextAreaElement>(`[data-note-editor="${highlightId}"]`)?.focus()
    })
  }

  function saveHighlightNote(highlightId: string, note: string) {
    const normalizedNote = note.trimEnd()
    const highlight = sidebarHighlights.find((candidate) => candidate.id === highlightId)
    if (!highlight || highlight.note === normalizedNote) {
      return
    }
    updateSidebarHighlights(
      sidebarHighlights.map((candidate) =>
        candidate.id === highlightId ? { ...candidate, note: normalizedNote } : candidate,
      ),
    )
  }

  function toggleHighlightSelected(highlightId: string) {
    updateSidebarHighlightSelection((current) => toggleSetValue(current, highlightId))
  }

  async function exportHighlightCollection() {
    if (!sidebarDocument) {
      return
    }

    let candidates = sidebarHighlights
    if (exportScope === 'category') {
      candidates = candidates.filter((highlight) => highlight.category === exportCategory)
    } else if (exportScope === 'selected') {
      candidates = candidates.filter((highlight) => selectedHighlightIds.has(highlight.id))
    }
    candidates = candidates.filter((highlight) => exportCategories.has(highlight.category))
    if (candidates.length === 0) {
      setErrorMessage('Select at least one highlight and category to export.')
      return
    }

    setIsExportingHighlights(true)
    try {
      const exportedPath = await window.electronAPI.exportHighlights({
        id: sidebarDocument.id,
        format: exportFormat,
        highlights: candidates,
      })
      if (exportedPath) {
        setExportHighlightsOpen(false)
      }
    } catch (error) {
      setErrorMessage(`Highlight export failed: ${getErrorMessage(error)}`)
    } finally {
      setIsExportingHighlights(false)
    }
  }

  function updateSidebarHighlightSelection(updater: (current: Set<string>) => Set<string>) {
    if (!sidebarDocumentId) return
    setSelectedHighlightIdsByDocument((current) => {
      const next = new Map(current)
      next.set(sidebarDocumentId, updater(next.get(sidebarDocumentId) ?? new Set()))
      return next
    })
  }

  function updateSidebarHighlights(nextHighlights: PdfHighlight[]) {
    if (sidebarPaneId === 'left') {
      updateHighlights(nextHighlights)
      return
    }

    const document = rightDocument
    if (!document) return
    const previousHighlights = document.highlights
    const generation = ++rightSidebarHighlightSaveGenerationRef.current
    handleSplitHighlightsChange(document.id, nextHighlights)
    void window.electronAPI
      .savePdfHighlights(
        {
          id: document.id,
          fileSize: document.fileSize,
          modifiedAt: document.modifiedAt,
        },
        nextHighlights,
      )
      .then((savedHighlights) => {
        if (rightSidebarHighlightSaveGenerationRef.current === generation) {
          handleSplitHighlightsChange(document.id, savedHighlights)
        }
      })
      .catch((error) => {
        if (rightSidebarHighlightSaveGenerationRef.current === generation) {
          handleSplitHighlightsChange(document.id, previousHighlights)
          setErrorMessage(`Failed to save highlight: ${getErrorMessage(error)}`)
        }
      })
  }

  function updateHighlights(nextHighlights: PdfHighlight[]) {
    const document = pdfFile
    if (!document) {
      return
    }

    const previousHighlights = highlights
    const generation = ++highlightSaveGenerationRef.current
    setHighlights(nextHighlights)
    setRightDocument((current) =>
      current?.id === document.id ? { ...current, highlights: nextHighlights } : current,
    )
    void window.electronAPI
      .savePdfHighlights(
        {
          id: document.id,
          fileSize: document.fileSize,
          modifiedAt: document.modifiedAt,
        },
        nextHighlights,
      )
      .then((savedHighlights) => {
        if (highlightSaveGenerationRef.current === generation) {
          setHighlights(savedHighlights)
          setRightDocument((current) =>
            current?.id === document.id ? { ...current, highlights: savedHighlights } : current,
          )
        }
      })
      .catch((error) => {
        if (highlightSaveGenerationRef.current === generation) {
          setHighlights(previousHighlights)
          setRightDocument((current) =>
            current?.id === document.id ? { ...current, highlights: previousHighlights } : current,
          )
          setErrorMessage(`Failed to save highlight: ${getErrorMessage(error)}`)
        }
      })
  }

  async function refreshSavedSignatures() {
    setSignaturesLoading(true)
    try {
      setSavedSignatures(await window.electronAPI.listSignatures())
    } catch (error) {
      setErrorMessage(`Failed to load signatures: ${getErrorMessage(error)}`)
    } finally {
      setSignaturesLoading(false)
    }
  }

  function updateSignaturePlacementsForDocument(
    document: (PdfFile & { signaturePlacements?: SignaturePlacement[] }) | SplitPaneDocument | null,
    nextPlacements: SignaturePlacement[],
  ) {
    if (!document) return
    const previousPlacements =
      document.id === pdfFile?.id ? signaturePlacements : document.signaturePlacements ?? []
    const sanitizedPlacements = nextPlacements.map((placement) => ({
      ...placement,
      documentId: document.id,
    }))
    const generation = ++signaturePlacementSaveGenerationRef.current

    if (document.id === pdfFile?.id) {
      setSignaturePlacements(sanitizedPlacements)
    }
    setRightDocument((current) =>
      current?.id === document.id
        ? { ...current, signaturePlacements: sanitizedPlacements }
        : current,
    )

    window.clearTimeout(signaturePlacementSaveTimeoutRef.current)
    signaturePlacementSaveTimeoutRef.current = window.setTimeout(() => {
      void window.electronAPI
        .savePdfSignaturePlacements(
          {
            id: document.id,
            fileSize: document.fileSize,
            modifiedAt: document.modifiedAt,
          },
          sanitizedPlacements,
        )
        .then((savedPlacements) => {
          if (signaturePlacementSaveGenerationRef.current !== generation) return
          if (document.id === pdfFile?.id) {
            setSignaturePlacements(savedPlacements)
          }
          setRightDocument((current) =>
            current?.id === document.id
              ? { ...current, signaturePlacements: savedPlacements }
              : current,
          )
        })
        .catch((error) => {
          if (signaturePlacementSaveGenerationRef.current !== generation) return
          if (document.id === pdfFile?.id) {
            setSignaturePlacements(previousPlacements)
          }
          setRightDocument((current) =>
            current?.id === document.id
              ? { ...current, signaturePlacements: previousPlacements }
              : current,
          )
          setErrorMessage(`Failed to save signature placement: ${getErrorMessage(error)}`)
        })
    }, 180)
  }

  function updateLeftSignaturePlacements(nextPlacements: SignaturePlacement[]) {
    updateSignaturePlacementsForDocument(pdfFile, nextPlacements)
  }

  function updateRightSignaturePlacements(documentId: string, nextPlacements: SignaturePlacement[]) {
    const document = rightDocument?.id === documentId ? rightDocument : null
    updateSignaturePlacementsForDocument(document, nextPlacements)
  }

  function chooseSignatureForPlacement(signature: SavedSignature) {
    setSigningSignature(signature)
    setSelectedSignaturePlacementId(null)
    setSelectedFillSignFieldId(null)
    setActiveFillSignTool(null)
    setSignPickerOpen(false)
    setErrorMessage(null)
  }

  function activateFillSignTool(tool: FillSignTool) {
    setActiveFillSignTool((current) => current === tool ? null : tool)
    setSigningSignature(null)
    setSignPickerOpen(false)
    setSelectedSignaturePlacementId(null)
    setSelectedFillSignFieldId(null)
    setErrorMessage(null)
  }

  function addLeftSignaturePlacement(placement: SignaturePlacement) {
    updateLeftSignaturePlacements([...signaturePlacements, placement])
    setSelectedSignaturePlacementId(placement.id)
  }

  function updateLeftSignaturePlacement(placementId: string, patch: Partial<SignaturePlacement>) {
    updateLeftSignaturePlacements(
      signaturePlacements.map((placement) =>
        placement.id === placementId ? { ...placement, ...patch } : placement,
      ),
    )
  }

  function deleteLeftSignaturePlacement(placementId: string) {
    if (!window.confirm('Delete this placed signature?')) return
    updateLeftSignaturePlacements(signaturePlacements.filter((placement) => placement.id !== placementId))
    setSelectedSignaturePlacementId(null)
  }

  function duplicateLeftSignaturePlacement(placementId: string) {
    const placement = signaturePlacements.find((candidate) => candidate.id === placementId)
    if (!placement) return
    const duplicate = {
      ...placement,
      id: window.crypto.randomUUID(),
      x: Math.min(1 - placement.width, placement.x + 0.03),
      y: Math.min(1 - placement.height, placement.y + 0.03),
      xRatio: Math.min(1 - (placement.widthRatio ?? placement.width), (placement.xRatio ?? placement.x) + 0.03),
      yRatio: Math.min(1 - (placement.heightRatio ?? placement.height), (placement.yRatio ?? placement.y) + 0.03),
      createdAt: new Date().toISOString(),
    }
    updateLeftSignaturePlacements([...signaturePlacements, duplicate])
    setSelectedSignaturePlacementId(duplicate.id)
  }

  function bringLeftSignatureForward(placementId: string) {
    const index = signaturePlacements.findIndex((placement) => placement.id === placementId)
    if (index < 0 || index === signaturePlacements.length - 1) return
    const next = [...signaturePlacements]
    ;[next[index], next[index + 1]] = [next[index + 1], next[index]]
    updateLeftSignaturePlacements(next)
  }

  function sendLeftSignatureBackward(placementId: string) {
    const index = signaturePlacements.findIndex((placement) => placement.id === placementId)
    if (index <= 0) return
    const next = [...signaturePlacements]
    ;[next[index], next[index - 1]] = [next[index - 1], next[index]]
    updateLeftSignaturePlacements(next)
  }

  function updateFillSignFieldsForDocument(
    document: (PdfFile & { fillSignFields?: FillSignField[] }) | SplitPaneDocument | null,
    nextFields: FillSignField[],
  ) {
    if (!document) return
    const previousFields =
      document.id === pdfFile?.id ? fillSignFields : document.fillSignFields ?? []
    const generation = ++fillSignSaveGenerationRef.current
    const documentFields = nextFields.map((field) => ({ ...field, documentId: document.id }))

    if (document.id === pdfFile?.id) {
      setFillSignFields(documentFields)
    }
    setRightDocument((current) =>
      current?.id === document.id ? { ...current, fillSignFields: documentFields } : current,
    )

    window.clearTimeout(fillSignSaveTimeoutRef.current)
    fillSignSaveTimeoutRef.current = window.setTimeout(() => {
      window.electronAPI
        .savePdfFillSignFields(
          {
            id: document.id,
            fileSize: document.fileSize,
            modifiedAt: document.modifiedAt,
          },
          documentFields,
        )
        .then((savedFields) => {
          if (fillSignSaveGenerationRef.current !== generation) return
          if (document.id === pdfFile?.id) {
            setFillSignFields(savedFields)
          }
          setRightDocument((current) =>
            current?.id === document.id ? { ...current, fillSignFields: savedFields } : current,
          )
        })
        .catch((error) => {
          if (fillSignSaveGenerationRef.current !== generation) return
          if (document.id === pdfFile?.id) {
            setFillSignFields(previousFields)
          }
          setRightDocument((current) =>
            current?.id === document.id ? { ...current, fillSignFields: previousFields } : current,
          )
          setErrorMessage(`Fill & Sign save failed: ${getErrorMessage(error)}`)
        })
    }, 250)
  }

  function updateLeftFillSignFields(nextFields: FillSignField[]) {
    updateFillSignFieldsForDocument(pdfFile, nextFields)
  }

  function updateRightFillSignFields(documentId: string, nextFields: FillSignField[]) {
    const document = rightDocument?.id === documentId ? rightDocument : null
    updateFillSignFieldsForDocument(document, nextFields)
  }

  function addLeftFillSignField(field: FillSignField) {
    updateLeftFillSignFields([...fillSignFields, field])
    setSelectedFillSignFieldId(field.id)
  }

  function updateLeftFillSignField(fieldId: string, patch: Partial<FillSignField>) {
    updateLeftFillSignFields(
      fillSignFields.map((field) =>
        field.id === fieldId ? { ...field, ...patch } : field,
      ),
    )
  }

  function deleteLeftFillSignField(fieldId: string) {
    if (!window.confirm('Delete this Fill & Sign field?')) return
    updateLeftFillSignFields(fillSignFields.filter((field) => field.id !== fieldId))
    setSelectedFillSignFieldId(null)
  }

  function duplicateLeftFillSignField(fieldId: string) {
    const field = fillSignFields.find((candidate) => candidate.id === fieldId)
    if (!field) return
    const duplicate = duplicateFillSignField(field)
    updateLeftFillSignFields([...fillSignFields, duplicate])
    setSelectedFillSignFieldId(duplicate.id)
  }

  function clearHighlightSelection() {
    window.getSelection()?.removeAllRanges()
    setPendingHighlightSelection(null)
  }

  function openHighlightContextMenu(
    event: React.MouseEvent<HTMLDivElement>,
    pageNumber: number,
  ) {
    const page = event.currentTarget.querySelector<HTMLElement>('.react-pdf__Page')
    if (!page) {
      return
    }

    const bounds = page.getBoundingClientRect()
    const point = {
      x: (event.clientX - bounds.left) / bounds.width,
      y: (event.clientY - bounds.top) / bounds.height,
    }
    const highlight = [...(highlightsByPage.get(pageNumber) ?? [])]
      .reverse()
      .find((candidate) =>
        candidate.rectangles.some((rectangle) => {
          const transformed = transformHighlightRectangle(
            rectangle,
            normalizeRotation(rotation - candidate.rotation),
          )
          return pointInsideRectangle(point, transformed)
        }),
      )
    if (!highlight) {
      return
    }

    showHighlightContextMenu(event, highlight.id)
  }

  function showHighlightContextMenu(event: React.MouseEvent, highlightId: string) {
    event.preventDefault()
    event.stopPropagation()
    setPendingHighlightSelection(null)
    setHighlightContextMenu({
      highlightId,
      x: Math.min(window.innerWidth - 230, Math.max(8, event.clientX)),
      y: Math.min(window.innerHeight - 390, Math.max(8, event.clientY)),
    })
  }

  function navigateToHighlight(highlight: PdfHighlight) {
    setHighlightContextMenu(null)
    goToPage(highlight.pageNumber, 'auto')
    scrollToHighlightWhenReady(highlight.id, highlight.pageNumber)
  }

  function navigateSidebarHighlight(highlight: PdfHighlight) {
    if (splitEnabled && sidebarPaneId === 'right') {
      rightPaneRef.current?.navigateToHighlight(highlight.id, highlight.pageNumber)
      return
    }
    navigateToHighlight(highlight)
  }

  function scrollToHighlightWhenReady(highlightId: string, pageNumber: number, attempt = 0) {
    window.requestAnimationFrame(() => {
      const page = pageRefs.current.get(pageNumber)
      const target = Array.from(
        page?.querySelectorAll<HTMLElement>('[data-highlight-id]') ?? [],
      ).find((element) => element.dataset.highlightId === highlightId)
      const bounds = target?.getBoundingClientRect()
      if (
        !target ||
        !page?.querySelector('.react-pdf__Page') ||
        !bounds ||
        bounds.width <= 0 ||
        bounds.height <= 0
      ) {
        if (attempt < 90) {
          window.setTimeout(
            () => scrollToHighlightWhenReady(highlightId, pageNumber, attempt + 1),
            16,
          )
        }
        return
      }

      const headerHeight = headerRef.current?.offsetHeight ?? 0
      const targetTop =
        window.scrollY + bounds.top - Math.max(headerHeight + 16, (window.innerHeight - bounds.height) / 2)
      window.scrollTo({ top: targetTop, behavior: 'smooth' })
      window.clearTimeout(highlightFocusTimeoutRef.current)
      highlightFocusTimeoutRef.current = window.setTimeout(
        () => {
          setFocusedHighlightId(highlightId)
          highlightFocusTimeoutRef.current = window.setTimeout(
            () => setFocusedHighlightId(null),
            1100,
          )
        },
        300,
      )
    })
  }

  function selectSearchMatch(direction: 1 | -1) {
    if (searchMatches.length === 0) {
      return
    }

    const startingIndex = selectedMatchIndex >= 0 ? selectedMatchIndex : direction === 1 ? -1 : 0
    const nextIndex = (startingIndex + direction + searchMatches.length) % searchMatches.length
    setSelectedMatchIndex(nextIndex)

    const nextMatch = searchMatches[nextIndex]
    if (nextMatch.pageNumber !== currentPageRef.current) {
      goToPage(nextMatch.pageNumber, 'auto')
    }
  }

  function highlightSelectedSearchMatch(color: HighlightColor, attempt = 0) {
    const match = searchMatches[selectedMatchIndex]
    if (!match) {
      return
    }
    if (match.source === 'ocr') {
      setErrorMessage('OCR text matches can be searched, but cannot be highlighted until OCR text positioning is implemented.')
      return
    }

    if (currentPageRef.current !== match.pageNumber) {
      goToPage(match.pageNumber, 'auto')
    }

    window.requestAnimationFrame(() => {
      const marks = Array.from(
        document.querySelectorAll<HTMLElement>(`[data-search-match="${match.index}"]`),
      )
      const page = marks[0]?.closest<HTMLElement>('.react-pdf__Page')
      if (!page || marks.length === 0) {
        if (attempt < 90) {
          window.setTimeout(() => highlightSelectedSearchMatch(color, attempt + 1), 16)
        }
        return
      }

      const pageBounds = page.getBoundingClientRect()
      const rectangles = marks.flatMap((mark) =>
        Array.from(mark.getClientRects()).map((rectangle) => ({
          x: clampUnit((rectangle.left - pageBounds.left) / pageBounds.width),
          y: clampUnit((rectangle.top - pageBounds.top) / pageBounds.height),
          width: clampUnit(rectangle.width / pageBounds.width),
          height: clampUnit(rectangle.height / pageBounds.height),
        })),
      )
      const pageText = pageTextCacheRef.current.get(match.pageNumber)
      const text = pageText?.text.slice(match.start, match.end).trim() || searchQuery.trim()
      if (!text || rectangles.length === 0) {
        return
      }

      addHighlight(
        {
          pageNumber: match.pageNumber,
          text,
          rectangles,
          rotation,
          toolbarX: 0,
          toolbarY: 0,
        },
        color,
      )
    })
  }

  function closeSearch() {
    searchGenerationRef.current += 1
    setSearchOpen(false)
    setSearchQuery('')
    setSearchMatches([])
    setSelectedMatchIndex(-1)
    setIsSearching(false)
    setSearchProgress(null)
  }

  function selectSidebarTab(tab: SidebarTab) {
    setSidebarTab(tab)
    void window.electronAPI
      .setSidebarTab(tab)
      .catch((error) => setErrorMessage(getErrorMessage(error)))
  }

  async function loadPdfOutline(document: PDFDocumentProxy) {
    const generation = ++outlineGenerationRef.current
    setOutlineLoading(true)
    const started = performance.now()

    try {
      const loadedOutline = (await document.getOutline()) as PdfOutlineItem[]
      console.info(`Bookmarks load time: ${formatDuration(performance.now() - started)}`)
      if (outlineGenerationRef.current === generation) {
        setOutline(loadedOutline ?? [])
        setOutlineLoading(false)
      }
    } catch (error) {
      if (outlineGenerationRef.current === generation) {
        setOutline([])
        setOutlineLoading(false)
        setErrorMessage(`Failed to load bookmarks: ${getErrorMessage(error)}`)
      }
    }
  }

  async function loadDocumentMetadata(document: PDFDocumentProxy) {
    const generation = ++metadataGenerationRef.current
    setMetadataLoading(true)
    const started = performance.now()

    try {
      const { info, metadata } = await document.getMetadata()
      console.info(`Metadata load time: ${formatDuration(performance.now() - started)}`)
      const pdfInfo = info as Record<string, unknown>
      const loadedMetadata: DocumentMetadata = {
        title: getMetadataValue(pdfInfo.Title, metadata?.get('dc:title')),
        author: getMetadataValue(pdfInfo.Author, metadata?.get('dc:creator')),
        subject: getMetadataValue(pdfInfo.Subject, metadata?.get('dc:description')),
        creator: getMetadataValue(pdfInfo.Creator, metadata?.get('xmp:creatortool')),
        producer: getMetadataValue(pdfInfo.Producer, metadata?.get('pdf:producer')),
        creationDate: formatPdfDate(
          getMetadataValue(pdfInfo.CreationDate, metadata?.get('xmp:createdate')),
        ),
        modificationDate: formatPdfDate(
          getMetadataValue(pdfInfo.ModDate, metadata?.get('xmp:modifydate')),
        ),
      }

      if (metadataGenerationRef.current === generation) {
        setDocumentMetadata(loadedMetadata)
        setMetadataLoading(false)
      }
    } catch (error) {
      if (metadataGenerationRef.current === generation) {
        setDocumentMetadata(null)
        setMetadataLoading(false)
        setErrorMessage(`Failed to load document info: ${getErrorMessage(error)}`)
      }
    }
  }

  async function detectOcrStatus(document: PDFDocumentProxy, file: PdfFile) {
    const currentDetection = normalizeOcrDetection(ocrDetection)
    if (
      pdfFile?.id === file.id &&
      (currentDetection.status === 'searchable' || currentDetection.status === 'ocr-recommended')
    ) {
      return
    }

    const generation = ++ocrDetectionGenerationRef.current
    const started = performance.now()
    const detecting: OcrDetectionResult = {
      ...EMPTY_OCR_DETECTION,
      status: 'detecting',
    }
    setOcrDetection(detecting)

    try {
      const sampledPages = Math.min(OCR_SAMPLE_PAGES, document.numPages)
      let textCharacters = 0

      for (let pageNumber = 1; pageNumber <= sampledPages; pageNumber += 1) {
        const pageText = await getPageText(document, pageNumber, pageTextCacheRef.current)
        textCharacters += countMeaningfulTextCharacters(pageText.text)
        await yieldToMainThread()
      }

      const detection: OcrDetectionResult = {
        status:
          textCharacters >= OCR_SEARCHABLE_CHARACTER_THRESHOLD
            ? 'searchable'
            : 'ocr-recommended',
        sampledPages,
        textCharacters,
        detectedAt: new Date().toISOString(),
      }
      console.info(
        `OCR detection time: ${formatDuration(performance.now() - started)} (${ocrDetectionLabel(detection)})`,
      )
      if (ocrDetectionGenerationRef.current === generation && pdfFile?.id === file.id) {
        setOcrDetection(detection)
      }
      const savedDetection = await window.electronAPI.saveOcrDetection(file.id, detection)
      if (ocrDetectionGenerationRef.current === generation && pdfFile?.id === file.id) {
        setOcrDetection(normalizeOcrDetection(savedDetection))
      }
    } catch (error) {
      const detection: OcrDetectionResult = {
        status: 'error',
        sampledPages: 0,
        textCharacters: 0,
        detectedAt: new Date().toISOString(),
        error: getErrorMessage(error),
      }
      if (ocrDetectionGenerationRef.current === generation && pdfFile?.id === file.id) {
        setOcrDetection(detection)
      }
      try {
        await window.electronAPI.saveOcrDetection(file.id, detection)
      } catch (saveError) {
        console.warn('OCR detection save failed:', getErrorMessage(saveError))
      }
    }
  }

  function scheduleBackgroundDocumentWork(document: PDFDocumentProxy) {
    window.clearTimeout(backgroundDocumentTaskRef.current)
    const sourceFile = pdfFile
    backgroundDocumentTaskRef.current = window.setTimeout(() => {
      void loadPdfOutline(document)
      void loadDocumentMetadata(document)
      if (sourceFile) {
        void detectOcrStatus(document, sourceFile)
        void extractAndStoreReference(document, sourceFile).catch((error) => console.warn('Reference extraction failed:', getErrorMessage(error)))
      }
      void startGlobalSearchIndexing(document)
    }, 250)
  }

  async function startGlobalSearchIndexing(document: PDFDocumentProxy) {
    const source = pdfFile
    if (!source) return
    searchIndexAbortRef.current?.abort()
    const controller = new AbortController()
    searchIndexAbortRef.current = controller
    setSearchIndexProgress({ indexed: 0, total: document.numPages })
    try {
      const result = await indexPdfForGlobalSearch(
        document,
        source,
        controller.signal,
        (indexed, total) => setSearchIndexProgress({ indexed, total }),
      )
      if (!controller.signal.aborted && result.indexed) {
        setSearchIndexProgress({ indexed: document.numPages, total: document.numPages })
        window.setTimeout(() => {
          if (searchIndexAbortRef.current === controller) setSearchIndexProgress(null)
        }, 1500)
      } else if (!controller.signal.aborted) {
        setSearchIndexProgress(null)
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        setSearchIndexProgress(null)
        console.warn('Global search indexing failed:', getErrorMessage(error))
      }
    }
  }

  async function loadReferencePageDimensions(
    document: PDFDocumentProxy,
    documentRotation: number,
  ) {
    try {
      const page = await document.getPage(1)
      firstPageProxyRef.current = page
      const viewport = page.getViewport({
        scale: 1,
        rotation: normalizeRotation(page.rotate + documentRotation),
      })
      setFirstPageWidth(viewport.width)
      setFirstPageHeight(viewport.height)
    } catch (error) {
      console.warn('Could not measure the first PDF page:', getErrorMessage(error))
    }
  }

  function handlePageRendered(pageNumber: number, renderDuration: number) {
    console.debug(`Page render time: page ${pageNumber} ${formatDuration(renderDuration)}`)
    clearZoomSnapshot(pageNumber)
    if (
      pageNumber === currentPageRef.current &&
      Math.abs(displayZoomRef.current - renderZoomRef.current) < 0.001
    ) {
      setIsZooming(false)
    }
    if (initialPageRenderedRef.current) {
      return
    }

    const expectedPage = pendingRestorePageRef.current ?? currentPageRef.current
    if (pageNumber !== expectedPage) {
      return
    }

    initialPageRenderedRef.current = true
    setIsLoading(false)
    setLoadingProgress(null)
    console.info(
      `PDF first viewable time: ${formatDuration(performance.now() - documentLoadStartedRef.current)}`,
    )
    if (pdfDocumentRef.current) {
      scheduleBackgroundDocumentWork(pdfDocumentRef.current)
    }
    void logMemoryUsage('First visible page rendered')
  }

  async function logMemoryUsage(label: string) {
    try {
      const memory = await window.electronAPI.getMemoryUsage()
      console.info(`Memory usage - ${label}:`, memory)
    } catch (error) {
      console.warn('Memory measurement failed:', getErrorMessage(error))
    }
  }

  function rotatePages(delta: -90 | 90) {
    captureZoomAnchor()
    isRestoringZoomPositionRef.current = true
    const nextRotation = normalizeRotation(rotation + delta)
    const firstPage = firstPageProxyRef.current
    if (firstPage) {
      const viewport = firstPage.getViewport({
        scale: 1,
        rotation: normalizeRotation(firstPage.rotate + nextRotation),
      })
      setFirstPageWidth(viewport.width)
      setFirstPageHeight(viewport.height)
    }
    setRotation(nextRotation)
  }

  async function navigateToBookmark(bookmark: PdfOutlineItem) {
    if (!pdfDocument || !bookmark.dest) {
      return
    }

    try {
      const destination =
        typeof bookmark.dest === 'string'
          ? await pdfDocument.getDestination(bookmark.dest)
          : bookmark.dest
      if (!destination || destination.length === 0 || destination[0] == null) {
        return
      }

      const pageReference = destination[0]
      const pageIndex =
        typeof pageReference === 'number'
          ? pageReference
          : await pdfDocument.getPageIndex(pageReference as { num: number; gen: number })
      const pageNumber = pageIndex + 1
      const destinationType = (destination[1] as { name?: string } | undefined)?.name
      const destinationTop =
        destinationType === 'XYZ'
          ? destination[3]
          : destinationType === 'FitH' || destinationType === 'FitBH'
            ? destination[2]
            : destinationType === 'FitR'
              ? destination[5]
              : null

      if (typeof destinationTop !== 'number') {
        goToPage(pageNumber)
        return
      }

      const pageElement = viewerRef.current?.querySelector<HTMLElement>(
        `[data-page-number="${pageNumber}"]`,
      )
      if (!pageElement) {
        goToPage(pageNumber)
        return
      }

      const page = await pdfDocument.getPage(pageNumber)
      const viewport = page.getViewport({
        scale: renderZoom,
        rotation: normalizeRotation(page.rotate + rotation),
      })
      const [, destinationY] = viewport.convertToViewportPoint(0, destinationTop)
      const headerHeight = headerRef.current?.offsetHeight ?? 0
      beginProgrammaticNavigation(pageNumber, 'smooth')
      currentPageRef.current = pageNumber
      setCurrentPage(pageNumber)
      setPageInput(String(pageNumber))
      window.scrollTo({
        top:
          window.scrollY +
          pageElement.getBoundingClientRect().top +
          destinationY -
          headerHeight -
          16,
        behavior: 'smooth',
      })
    } catch (error) {
      setErrorMessage(`Failed to open bookmark: ${getErrorMessage(error)}`)
    }
  }

  function getCurrentTabState(): PdfTabState {
    const currentPageElement = pageRefs.current.get(currentPageRef.current)
    const pageBounds = currentPageElement?.getBoundingClientRect()
    const viewportTop = headerRef.current?.offsetHeight ?? 0
    const pageOffset = pageBounds
      ? Math.min(1, Math.max(0, (viewportTop - pageBounds.top) / pageBounds.height))
      : 0
    return {
      page: Math.max(1, currentPageRef.current),
      pageOffset,
      zoom: clampScale(displayZoomRef.current),
      fitMode: zoomMode === 'fit-width',
      rotation: normalizeRotation(rotation),
      searchOpen,
      searchQuery,
      selectedMatchIndex,
      sidebarOpen: thumbnailSidebarOpen,
      sidebarTab,
      sidebarWidth,
    }
  }

  function updateTabCollections(nextTabs: PdfTab[], nextClosedTabs: PdfTab[]) {
    tabsRef.current = nextTabs
    closedTabsRef.current = nextClosedTabs
    setTabs(nextTabs)
    setClosedTabs(nextClosedTabs)
  }

  function assignPane(side: PaneSide, tab: PdfTab | null, state?: PdfTabState | null) {
    const assignment: PaneAssignment = tab
      ? {
          id: side,
          tabId: tab.tabId,
          documentId: tab.documentId,
          fileName: tab.name,
          state: { ...(state ?? tab.state) },
        }
      : emptyPane(side)
    if (side === 'left') {
      leftPaneAssignmentRef.current = assignment
      setLeftPane(assignment)
    } else {
      rightPaneAssignmentRef.current = assignment
      setRightPane(assignment)
    }
    return assignment
  }

  function updatePaneAssignmentState(side: PaneSide, state: PdfTabState) {
    const current = side === 'left'
      ? leftPaneAssignmentRef.current
      : rightPaneAssignmentRef.current
    if (!current.tabId || tabStatesEqual(current.state ?? state, state)) {
      return
    }
    const next = { ...current, state }
    if (side === 'left') {
      leftPaneAssignmentRef.current = next
      setLeftPane(next)
    } else {
      rightPaneAssignmentRef.current = next
      setRightPane(next)
    }
  }

  function snapshotActiveTab() {
    const tabId = leftPaneAssignmentRef.current.tabId
    if (!tabId || !pdfFile) {
      return tabsRef.current
    }

    const state = getCurrentTabState()
    updatePaneAssignmentState('left', state)
    const nextTabs = tabsRef.current.map((tab) =>
      tab.tabId === tabId ? { ...tab, state } : tab,
    )
    updateTabCollections(nextTabs, closedTabsRef.current)
    return nextTabs
  }

  function getWorkspaceSnapshot(): WorkspaceSession {
    const currentTabs = snapshotActiveTab()
    const left = leftPaneAssignmentRef.current
    const currentLeftState = left.tabId && pdfFile ? getCurrentTabState() : left.state
    return {
      tabs: currentTabs.map((tab) => tab.tabId === left.tabId && currentLeftState ? { ...tab, state: currentLeftState } : tab),
      activeTabId: activeTabIdRef.current,
      closedTabs: closedTabsRef.current,
      split: {
        enabled: splitEnabled,
        dividerRatio: splitRatio,
        activePane,
        leftPane: { ...left, state: currentLeftState },
        rightPane: rightPaneAssignmentRef.current,
        syncScrolling,
      },
    }
  }

  async function applyWorkspaceSession(workspace: WorkspaceSession) {
    workspaceReadyRef.current = false
    window.clearTimeout(workspaceSaveTimeoutRef.current)
    rightPaneLoadGenerationRef.current += 1
    clearViewer()
    setRightDocument(null)
    assignPane('left', null)
    assignPane('right', null)
    updateTabCollections(workspace.tabs, workspace.closedTabs)
    setSplitRatio(workspace.split.dividerRatio)

    const targetTab =
      workspace.tabs.find((tab) => tab.tabId === workspace.split.leftPane.tabId) ??
      workspace.tabs.find((tab) => tab.tabId === workspace.activeTabId) ??
      workspace.tabs[0]
    if (!targetTab) {
      setSplitEnabled(false)
      activeTabIdRef.current = null
      setActiveTabId(null)
      workspaceReadyRef.current = true
      return
    }

    const restoreCandidates = [targetTab, ...workspace.tabs.filter((tab) => tab.tabId !== targetTab.tabId)]
    for (const candidate of restoreCandidates) {
      if (!tabsRef.current.some((tab) => tab.tabId === candidate.tabId)) continue
      await activateTab(
        candidate.tabId,
        undefined,
        workspace.split.leftPane.tabId === candidate.tabId
          ? workspace.split.leftPane.state ?? candidate.state
          : candidate.state,
        true,
      )
      if (leftPaneAssignmentRef.current.tabId === candidate.tabId) break
    }

    const leftRestored = Boolean(leftPaneAssignmentRef.current.tabId)
    if (leftRestored && workspace.split.enabled && workspace.split.rightPane.tabId) {
      await openTabInRightPane(workspace.split.rightPane.tabId, {
        preserveSidebar: true,
        activate: false,
        state: workspace.split.rightPane.state,
      })
    }
    const splitRestored = leftRestored && workspace.split.enabled
    setSplitEnabled(splitRestored)
    const restoredActivePane: PaneSide = splitRestored && workspace.split.activePane === 'right' && rightPaneAssignmentRef.current.tabId ? 'right' : 'left'
    setActivePane(restoredActivePane)
    const restoredActiveTabId = restoredActivePane === 'right'
      ? rightPaneAssignmentRef.current.tabId ?? leftPaneAssignmentRef.current.tabId
      : leftPaneAssignmentRef.current.tabId ?? rightPaneAssignmentRef.current.tabId
    activeTabIdRef.current = restoredActiveTabId
    setActiveTabId(restoredActiveTabId)
    workspaceReadyRef.current = true
  }

  async function refreshWorkspaceManager(selectedId?: string) {
    setWorkspaceLoading(true)
    setWorkspaceError(null)
    try {
      const list = await window.electronAPI.listWorkspaces()
      setWorkspaceList(list.workspaces)
      setActiveWorkspaceId(list.activeWorkspaceId)
      const targetId = selectedId && list.workspaces.some((workspace) => workspace.id === selectedId)
        ? selectedId
        : workspaceDetails?.id && list.workspaces.some((workspace) => workspace.id === workspaceDetails.id)
          ? workspaceDetails.id
          : list.activeWorkspaceId
      setWorkspaceDetails(await window.electronAPI.getWorkspaceDetails(targetId))
    } catch (error) {
      setWorkspaceError(getErrorMessage(error))
    } finally {
      setWorkspaceLoading(false)
    }
  }

  async function switchToWorkspace(id: string) {
    if (id === activeWorkspaceId) {
      setWorkspaceManagerOpen(false)
      return
    }
    workspaceSwitchingRef.current = true
    setWorkspaceLoading(true)
    setWorkspaceError(null)
    try {
      const result = await window.electronAPI.switchWorkspace(id, getWorkspaceSnapshot())
      setActiveWorkspaceId(result.workspace.id)
      await applyWorkspaceSession(result.session)
      await refreshWorkspaceManager(result.workspace.id)
      setWorkspaceManagerOpen(false)
    } catch (error) {
      setWorkspaceError(getErrorMessage(error))
    } finally {
      workspaceSwitchingRef.current = false
      workspaceReadyRef.current = true
      setWorkspaceLoading(false)
    }
  }

  async function importWorkspace() {
    workspaceSwitchingRef.current = true
    try {
      await window.electronAPI.saveWorkspace(getWorkspaceSnapshot())
      const imported = await window.electronAPI.importWorkspace()
      if (!imported) return
      setActiveWorkspaceId(imported.workspace.id)
      await applyWorkspaceSession(imported.session)
      await refreshWorkspaceManager(imported.workspace.id)
      if (imported.missingFiles.length) {
        setWorkspaceError(`Imported with ${imported.missingFiles.length} missing file reference${imported.missingFiles.length === 1 ? '' : 's'}.`)
      }
    } catch (error) {
      setWorkspaceError(getErrorMessage(error))
    } finally {
      workspaceSwitchingRef.current = false
    }
  }

  async function deleteWorkspace(id: string) {
    workspaceSwitchingRef.current = true
    try {
      const result = await window.electronAPI.deleteWorkspace(id)
      setActiveWorkspaceId(result.activeWorkspaceId)
      if (result.deletedActive) await applyWorkspaceSession(result.session)
      await refreshWorkspaceManager(result.activeWorkspaceId)
    } finally {
      workspaceSwitchingRef.current = false
      workspaceReadyRef.current = true
    }
  }

  async function openWorkspaceManager() {
    setGlobalDashboardOpen(false)
    setGlobalSearchOpen(false)
    setReferencesOpen(false)
    setMergePdfsOpen(false)
    setImagesToPdfOpen(false)
    setSignatureManagerOpen(false)
    setWorkspaceManagerOpen(true)
    await refreshWorkspaceManager(activeWorkspaceId || undefined)
  }

  function loadDocumentOnce(documentId: string) {
    const existing = documentLoadPromisesRef.current.get(documentId)
    if (existing) return existing
    const pending = window.electronAPI.openRecentPdf(documentId)
      .finally(() => documentLoadPromisesRef.current.delete(documentId))
    documentLoadPromisesRef.current.set(documentId, pending)
    return pending
  }

  function navigateWorkspaceHighlight(entry: HighlightLibraryEntry, pane: PaneSide, attempt = 0) {
    console.info('Navigation target page:', entry.pageNumber)
    if (pane === 'right') {
      if (rightPaneRef.current && rightPaneAssignmentRef.current.documentId === entry.documentId) {
        rightPaneRef.current.navigateToHighlight(entry.highlightId, entry.pageNumber)
      } else if (attempt < 90 && rightPaneAssignmentRef.current.documentId === entry.documentId) {
        window.setTimeout(() => navigateWorkspaceHighlight(entry, pane, attempt + 1), 16)
      }
      return
    }
    const highlight = highlights.find((candidate) => candidate.id === entry.highlightId)
    if (highlight) navigateToHighlight(highlight)
    else goToPage(entry.pageNumber, 'auto')
  }

  async function openWorkspaceDocument(
    documentId: string,
    options: WorkspaceNavigationOptions = {},
  ) {
    const existingTab = tabsRef.current.find((tab) => tab.documentId === documentId)
    const rightIsLoaded = rightPaneAssignmentRef.current.documentId === documentId && rightDocument?.id === documentId
    const leftIsLoaded = leftPaneAssignmentRef.current.documentId === documentId && pdfFile?.id === documentId
    console.info('Workspace click documentId:', documentId)
    console.info('Document already open:', Boolean(existingTab))
    console.info('Existing tabId:', existingTab?.tabId ?? 'none')
    console.info('Load state:', documentLoadPromisesRef.current.has(documentId) ? 'loading' : rightIsLoaded || leftIsLoaded ? 'loaded' : 'idle')
    console.info('Navigation target page:', options.highlight?.pageNumber ?? 'none')
    console.info('Indexing triggered:', false)

    try {
      if (options.workspaceId && options.workspaceId !== activeWorkspaceId) {
        await switchToWorkspace(options.workspaceId)
        window.requestAnimationFrame(() => void openWorkspaceDocumentRef.current(documentId, options))
        return
      }

      setWorkspaceManagerOpen(false)
      setWorkspaceError(null)
      setErrorMessage(null)
      if (rightIsLoaded) {
        focusPane('right')
        if (options.highlight) navigateWorkspaceHighlight(options.highlight, 'right')
        return
      }
      if (leftIsLoaded) {
        focusPane('left')
        if (options.highlight) navigateWorkspaceHighlight(options.highlight, 'left')
        return
      }
      if (existingTab) {
        if (rightPaneAssignmentRef.current.tabId === existingTab.tabId) {
          await openTabInRightPane(existingTab.tabId)
          if (options.highlight) navigateWorkspaceHighlight(options.highlight, 'right')
        } else {
          if (options.highlight) setPendingLibraryNavigation(options.highlight)
          await activateTab(existingTab.tabId)
        }
        return
      }

      setIsLoading(true)
      setLoadingProgress('Reading PDF file...')
      let handedToViewer = false
      try {
        const result = await loadDocumentOnce(documentId)
        const racedTab = tabsRef.current.find((tab) => tab.documentId === documentId)
        if (options.highlight) setPendingLibraryNavigation(options.highlight)
        if (racedTab) await activateTab(racedTab.tabId, result)
        else openResultInTab(result)
        handedToViewer = true
        void refreshRecentFiles()
      } finally {
        if (!handedToViewer) {
          setIsLoading(false)
          setLoadingProgress(null)
        }
      }
    } catch (error) {
      setPendingLibraryNavigation(null)
      setIsLoading(false)
      setLoadingProgress(null)
      const message = getErrorMessage(error)
      setWorkspaceError(message)
      setErrorMessage(`Could not open workspace document: ${message}`)
      if (/no longer|does not exist|not available|missing/i.test(message)) {
        void refreshWorkspaceManager(workspaceDetails?.id)
      }
    }
  }

  async function restoreWorkspace() {
    try {
      const [workspace, defaultSidebarTab, defaultSidebarLayout, workspaceCollection] = await Promise.all([
        window.electronAPI.getWorkspace(),
        window.electronAPI.getSidebarTab(),
        window.electronAPI.getSidebarLayout(),
        window.electronAPI.listWorkspaces(),
      ])
      setSidebarTab(defaultSidebarTab)
      setSidebarWidth(defaultSidebarLayout.width)
      setThumbnailSidebarOpen(!defaultSidebarLayout.collapsed)
      setWorkspaceList(workspaceCollection.workspaces)
      setActiveWorkspaceId(workspaceCollection.activeWorkspaceId)
      await applyWorkspaceSession(workspace)
      setWorkspaceDetails(await window.electronAPI.getWorkspaceDetails(workspaceCollection.activeWorkspaceId))
    } catch (error) {
      workspaceReadyRef.current = true
      setErrorMessage(`Workspace restore failed: ${getErrorMessage(error)}`)
    }
  }

  function openResultInTab(
    result: OpenedPdf,
    options: { duplicate?: boolean; state?: PdfTabState; targetPane?: PaneSide } = {},
  ) {
    const targetPane = splitEnabled ? options.targetPane ?? activePane : 'left'
    const existingTab = !options.duplicate
      ? tabsRef.current.find((tab) => tab.documentId === result.id)
      : undefined
    if (existingTab) {
      if (targetPane === 'right') {
        void openTabInRightPane(existingTab.tabId, { loadedResult: result })
      } else if (existingTab.tabId !== leftPaneAssignmentRef.current.tabId) {
        void activateTab(existingTab.tabId, result)
      } else {
        activeTabIdRef.current = existingTab.tabId
        setActiveTabId(existingTab.tabId)
        setActivePane('left')
      }
      return
    }

    tabSwitchGenerationRef.current += 1
    const currentTabs = snapshotActiveTab()
    const tab: PdfTab = {
      tabId: createTabId(),
      documentId: result.id,
      name: result.name,
      state: options.state ?? createTabState(result.readingState, {
        sidebarOpen: thumbnailSidebarOpen,
        sidebarTab,
        sidebarWidth,
      }),
    }
    const nextTabs = [...currentTabs, tab]
    updateTabCollections(nextTabs, closedTabsRef.current)
    if (targetPane === 'right') {
      void openTabInRightPane(tab.tabId, { loadedResult: result, state: tab.state })
      return
    }
    assignPane('left', tab, tab.state)
    activeTabIdRef.current = tab.tabId
    setActiveTabId(tab.tabId)
    setActivePane('left')
    loadOpenedPdf(result, tab.state)
  }

  async function activateTab(
    tabId: string,
    loadedResult?: OpenedPdf,
    stateOverride?: PdfTabState | null,
    leavePaneEmptyOnError = false,
  ) {
    if (tabId === leftPaneAssignmentRef.current.tabId && pdfFile) {
      activeTabIdRef.current = tabId
      setActiveTabId(tabId)
      setActivePane('left')
      return
    }

    const currentTabs = snapshotActiveTab()
    const tab = currentTabs.find((candidate) => candidate.tabId === tabId)
    if (!tab) {
      return
    }

    clearViewer()
    const generation = ++tabSwitchGenerationRef.current
    const paneState = { ...(stateOverride ?? tab.state) }
    assignPane('left', tab, paneState)
    activeTabIdRef.current = tabId
    setActiveTabId(tabId)
    setActivePane('left')
    setTabContextMenu(null)
    setErrorMessage(null)
    setIsLoading(true)
    setLoadingProgress(`Opening ${tab.name}...`)

    try {
      const result = loadedResult ?? (await loadDocumentOnce(tab.documentId))
      if (tabSwitchGenerationRef.current !== generation) {
        return
      }
      if (result.id !== tab.documentId) {
        throw new Error(`Document routing mismatch for ${tab.name}.`)
      }
      loadOpenedPdf(result, paneState)
      void refreshRecentFiles()
    } catch (error) {
      if (tabSwitchGenerationRef.current !== generation) {
        return
      }
      setErrorMessage(`Could not restore ${tab.name}: ${getErrorMessage(error)}`)
      if (leavePaneEmptyOnError) {
        updateTabCollections(
          tabsRef.current.filter((candidate) => candidate.tabId !== tabId),
          closedTabsRef.current,
        )
        assignPane('left', null)
        activeTabIdRef.current = null
        setActiveTabId(null)
        clearViewer()
      } else {
        removeUnavailableTab(tabId)
      }
      void refreshRecentFiles()
    }
  }

  function removeUnavailableTab(tabId: string) {
    const currentTabs = tabsRef.current
    const index = currentTabs.findIndex((tab) => tab.tabId === tabId)
    const nextTabs = currentTabs.filter((tab) => tab.tabId !== tabId)
    updateTabCollections(nextTabs, closedTabsRef.current)
    const wasLeft = leftPaneAssignmentRef.current.tabId === tabId
    const wasRight = rightPaneAssignmentRef.current.tabId === tabId
    if (wasRight) {
      rightPaneLoadGenerationRef.current += 1
      assignPane('right', null)
      setRightDocument(null)
      setSplitEnabled(Boolean(leftPaneAssignmentRef.current.tabId))
    }
    if (wasLeft) {
      assignPane('left', null)
      clearViewer()
    }
    const nextTab = nextTabs[Math.min(Math.max(0, index), nextTabs.length - 1)]
    if (wasLeft && nextTab) {
      void activateTab(nextTab.tabId)
    } else if (activeTabIdRef.current === tabId) {
      const fallbackTabId = leftPaneAssignmentRef.current.tabId ?? rightPaneAssignmentRef.current.tabId
      activeTabIdRef.current = fallbackTabId
      setActiveTabId(fallbackTabId)
      setActivePane(leftPaneAssignmentRef.current.tabId ? 'left' : 'right')
    }
  }

  async function closeTab(tabId: string) {
    const closingLeft = leftPaneAssignmentRef.current.tabId === tabId
    const closingRight = rightPaneAssignmentRef.current.tabId === tabId
    if (closingRight && rightPaneRef.current) {
      updateRightTabState(rightPaneRef.current.getState())
    }
    if (closingLeft) {
      snapshotActiveTab()
    }
    const currentTabs = tabsRef.current
    const index = currentTabs.findIndex((tab) => tab.tabId === tabId)
    if (index < 0) {
      return
    }

    const sourceState = closingRight
      ? rightPaneAssignmentRef.current.state
      : closingLeft
        ? leftPaneAssignmentRef.current.state
        : null
    const closedTab = sourceState ? { ...currentTabs[index], state: sourceState } : currentTabs[index]
    const nextTabs = currentTabs.filter((tab) => tab.tabId !== tabId)
    const nextClosedTabs = [closedTab, ...closedTabsRef.current.filter((tab) => tab.tabId !== tabId)]
      .slice(0, 20)
    updateTabCollections(nextTabs, nextClosedTabs)
    setTabContextMenu(null)

    if (closingRight) {
      rightPaneLoadGenerationRef.current += 1
      assignPane('right', null)
      setRightDocument(null)
      setSplitEnabled(Boolean(leftPaneAssignmentRef.current.tabId))
    }

    if (closingLeft) {
      const keepRightActive = activePane === 'right' && !closingRight
      assignPane('left', null)
      clearViewer()
      const nextTab = nextTabs[Math.min(index, nextTabs.length - 1)]
      if (nextTab) {
        await activateTab(nextTab.tabId)
        if (keepRightActive && rightPaneAssignmentRef.current.tabId) {
          activeTabIdRef.current = rightPaneAssignmentRef.current.tabId
          setActiveTabId(rightPaneAssignmentRef.current.tabId)
          setActivePane('right')
        }
      }
    } else if (activeTabIdRef.current === tabId) {
      const fallbackTabId = leftPaneAssignmentRef.current.tabId ?? rightPaneAssignmentRef.current.tabId
      activeTabIdRef.current = fallbackTabId
      setActiveTabId(fallbackTabId)
      setActivePane(leftPaneAssignmentRef.current.tabId ? 'left' : 'right')
    } else if (closingRight) {
      const fallbackTabId = leftPaneAssignmentRef.current.tabId
      activeTabIdRef.current = fallbackTabId
      setActiveTabId(fallbackTabId)
      setActivePane('left')
    }
  }

  function cycleTabs(direction: -1 | 1) {
    const currentTabs = tabsRef.current
    if (currentTabs.length < 2) {
      return
    }
    const currentIndex = currentTabs.findIndex((tab) => tab.tabId === activeTabIdRef.current)
    const nextIndex = (currentIndex + direction + currentTabs.length) % currentTabs.length
    activateTabForPane(currentTabs[nextIndex].tabId)
  }

  async function restoreClosedTab() {
    const [closedTab, ...remainingClosedTabs] = closedTabsRef.current
    if (!closedTab) {
      return
    }

    setErrorMessage(null)
    setIsLoading(true)
    setLoadingProgress(`Restoring ${closedTab.name}...`)
    try {
      const result = await window.electronAPI.openRecentPdf(closedTab.documentId)
      updateTabCollections(tabsRef.current, remainingClosedTabs)
      openResultInTab(result, {
        duplicate: true,
        state: closedTab.state,
      })
    } catch (error) {
      updateTabCollections(tabsRef.current, remainingClosedTabs)
      setIsLoading(false)
      setLoadingProgress(null)
      setErrorMessage(`Could not restore ${closedTab.name}: ${getErrorMessage(error)}`)
    }
  }

  async function duplicateTab(tabId: string) {
    if (tabId === leftPaneAssignmentRef.current.tabId) {
      snapshotActiveTab()
    }
    if (tabId === rightPaneAssignmentRef.current.tabId && rightPaneRef.current) {
      updateRightTabState(rightPaneRef.current.getState())
    }
    const sourceTabRecord = tabsRef.current.find((tab) => tab.tabId === tabId)
    const paneState = tabId === rightPaneAssignmentRef.current.tabId
      ? rightPaneAssignmentRef.current.state
      : tabId === leftPaneAssignmentRef.current.tabId
        ? leftPaneAssignmentRef.current.state
        : null
    const sourceTab = sourceTabRecord && paneState
      ? { ...sourceTabRecord, state: paneState }
      : sourceTabRecord
    if (!sourceTab) {
      return
    }

    setTabContextMenu(null)
    setIsLoading(true)
    setLoadingProgress(`Duplicating ${sourceTab.name}...`)
    try {
      const result = await window.electronAPI.openRecentPdf(sourceTab.documentId)
      openResultInTab(result, { duplicate: true, state: sourceTab.state })
    } catch (error) {
      setIsLoading(false)
      setLoadingProgress(null)
      setErrorMessage(`Could not duplicate ${sourceTab.name}: ${getErrorMessage(error)}`)
    }
  }

  function closeOtherTabs(tabId: string) {
    if (rightPaneAssignmentRef.current.tabId && rightPaneRef.current) {
      updateRightTabState(rightPaneRef.current.getState())
    }
    const currentTabs = snapshotActiveTab()
    const keptTab = currentTabs.find((tab) => tab.tabId === tabId)
    if (!keptTab) {
      return
    }
    const removedTabs = currentTabs.filter((tab) => tab.tabId !== tabId)
    updateTabCollections(
      [keptTab],
      [...removedTabs.reverse(), ...closedTabsRef.current].slice(0, 20),
    )
    rightPaneLoadGenerationRef.current += 1
    assignPane('right', null)
    setRightDocument(null)
    setSplitEnabled(false)
    setTabContextMenu(null)
    if (leftPaneAssignmentRef.current.tabId !== tabId) {
      void activateTab(tabId)
    } else {
      activeTabIdRef.current = tabId
      setActiveTabId(tabId)
      setActivePane('left')
    }
  }

  function closeTabsToRight(tabId: string) {
    const currentTabs = snapshotActiveTab()
    const index = currentTabs.findIndex((tab) => tab.tabId === tabId)
    if (index < 0 || index === currentTabs.length - 1) {
      setTabContextMenu(null)
      return
    }
    const nextTabs = currentTabs.slice(0, index + 1)
    const removedTabs = currentTabs.slice(index + 1)
    updateTabCollections(
      nextTabs,
      [...removedTabs.reverse(), ...closedTabsRef.current].slice(0, 20),
    )
    const removedTabIds = new Set(removedTabs.map((tab) => tab.tabId))
    if (rightPaneAssignmentRef.current.tabId && removedTabIds.has(rightPaneAssignmentRef.current.tabId)) {
      rightPaneLoadGenerationRef.current += 1
      assignPane('right', null)
      setRightDocument(null)
      setSplitEnabled(false)
    }
    setTabContextMenu(null)
    if (leftPaneAssignmentRef.current.tabId && removedTabIds.has(leftPaneAssignmentRef.current.tabId)) {
      void activateTab(tabId)
    } else if (!nextTabs.some((tab) => tab.tabId === activeTabIdRef.current)) {
      focusPane('left')
    }
  }

  function reorderTab(draggedTabId: string, targetTabId: string) {
    if (draggedTabId === targetTabId) {
      return
    }
    const currentTabs = tabsRef.current
    const fromIndex = currentTabs.findIndex((tab) => tab.tabId === draggedTabId)
    const toIndex = currentTabs.findIndex((tab) => tab.tabId === targetTabId)
    if (fromIndex < 0 || toIndex < 0) {
      return
    }
    const nextTabs = [...currentTabs]
    const [movedTab] = nextTabs.splice(fromIndex, 1)
    nextTabs.splice(toIndex, 0, movedTab)
    updateTabCollections(nextTabs, closedTabsRef.current)
  }

  async function revealTabFile(tabId: string) {
    const tab = tabsRef.current.find((candidate) => candidate.tabId === tabId)
    setTabContextMenu(null)
    if (!tab) {
      return
    }
    try {
      await window.electronAPI.revealPdf(tab.documentId)
    } catch (error) {
      setErrorMessage(`Could not reveal ${tab.name}: ${getErrorMessage(error)}`)
    }
  }

  async function openTabInRightPane(
    requestedTabId: string,
    options: {
      activate?: boolean
      preserveSidebar?: boolean
      state?: PdfTabState | null
      loadedResult?: OpenedPdf
    } = {},
  ) {
    const currentRightPane = rightPaneAssignmentRef.current
    const existingTab = tabsRef.current.find((tab) => tab.tabId === requestedTabId)
    if (!existingTab) {
      return
    }
    if (
      requestedTabId === currentRightPane.tabId &&
      rightDocument?.id === existingTab.documentId
    ) {
      setSplitEnabled(true)
      if (options.activate !== false) {
        activeTabIdRef.current = requestedTabId
        setActiveTabId(requestedTabId)
        setActivePane('right')
      }
      return
    }
    if (currentRightPane.tabId && rightPaneRef.current) {
      updateRightTabState(rightPaneRef.current.getState())
    }
    snapshotActiveTab()
    const tab = tabsRef.current.find((candidate) => candidate.tabId === requestedTabId)
    if (!tab) {
      return
    }

    const generation = ++rightPaneLoadGenerationRef.current
    const sourceState = options.state ?? (
      tab.tabId === leftPaneAssignmentRef.current.tabId
        ? leftPaneAssignmentRef.current.state ?? tab.state
        : tab.state
    )
    const paneState = options.preserveSidebar
      ? { ...sourceState }
      : { ...sourceState, sidebarOpen: false }
    setErrorMessage(null)
    setLoadingProgress(`Opening ${tab.name} in right pane...`)
    if (options.activate !== false) {
      activeTabIdRef.current = tab.tabId
      setActiveTabId(tab.tabId)
      setActivePane('right')
    }
    try {
      const result = options.loadedResult ?? (await loadDocumentOnce(tab.documentId))
      if (generation !== rightPaneLoadGenerationRef.current) {
        return
      }
      if (result.id !== tab.documentId) {
        throw new Error(`Document routing mismatch for ${tab.name}.`)
      }
      assignPane('right', tab, paneState)
      setRightDocument({
        id: result.id,
        name: result.name,
        filePath: result.filePath,
        fileSize: result.fileSize,
        modifiedAt: result.modifiedAt,
        dataUrl: result.dataUrl,
        highlights: result.highlights ?? [],
        signaturePlacements: result.signaturePlacements ?? [],
        fillSignFields: result.fillSignFields ?? [],
      })
      setSplitEnabled(true)
      if (options.activate !== false) {
        activeTabIdRef.current = tab.tabId
        setActiveTabId(tab.tabId)
        setActivePane('right')
      }
      setLoadingProgress(null)
      void refreshRecentFiles()
    } catch (error) {
      if (generation === rightPaneLoadGenerationRef.current) {
        setLoadingProgress(null)
        setErrorMessage(`Could not open ${tab.name} in split view: ${getErrorMessage(error)}`)
        const missingDocument = /no longer|does not exist|not available/i.test(getErrorMessage(error))
        if (missingDocument) {
          removeUnavailableTab(requestedTabId)
          return
        } else {
          assignPane('right', null)
          setRightDocument(null)
          setSplitEnabled(Boolean(leftPaneAssignmentRef.current.tabId))
        }
        if (options.activate !== false) {
          const fallbackTabId = currentRightPane.tabId ?? leftPaneAssignmentRef.current.tabId
          activeTabIdRef.current = fallbackTabId
          setActiveTabId(fallbackTabId)
          setActivePane(currentRightPane.tabId ? 'right' : 'left')
        }
      }
    }
  }

  async function splitCurrentTab() {
    const currentTabId = activeTabIdRef.current ?? leftPaneAssignmentRef.current.tabId
    if (!currentTabId) {
      await openPdf()
      return
    }
    const currentTab = tabsRef.current.find((tab) => tab.tabId === currentTabId)
    if (!currentTab) {
      return
    }
    const currentState = currentTabId === leftPaneAssignmentRef.current.tabId
      ? getCurrentTabState()
      : currentTab.state
    await openTabInRightPane(currentTabId, { state: currentState })
    setSplitMenuOpen(false)
  }

  function closeSplitView() {
    if (rightTabId && rightPaneRef.current) {
      updateRightTabState(rightPaneRef.current.getState())
    }
    rightPaneLoadGenerationRef.current += 1
    setSplitEnabled(false)
    setRightDocument(null)
    focusPane('left')
    setSplitMenuOpen(false)
  }

  function updateRightTabState(state: SplitPaneState) {
    const assignment = rightPaneAssignmentRef.current
    if (!assignment.tabId) {
      return
    }
    const tab = tabsRef.current.find((candidate) => candidate.tabId === assignment.tabId)
    if (!tab) return
    const nextState = fromSplitPaneState(state, assignment.state ?? tab.state)
    updatePaneAssignmentState('right', nextState)
    let changed = false
    const nextTabs = tabsRef.current.map((tab) => {
      if (tab.tabId !== assignment.tabId) return tab
      if (tabStatesEqual(tab.state, nextState)) return tab
      changed = true
      return { ...tab, state: nextState }
    })
    if (changed) {
      updateTabCollections(nextTabs, closedTabsRef.current)
    }
  }

  function handleSplitHighlightsChange(documentId: string, nextHighlights: PdfHighlight[]) {
    setRightDocument((current) =>
      current?.id === documentId ? { ...current, highlights: nextHighlights } : current,
    )
    if (pdfFile?.id === documentId) {
      highlightSaveGenerationRef.current += 1
      setHighlights(nextHighlights)
    }
  }

  function openTabInLeftPane(tabId: string) {
    setActivePane('left')
    setSplitMenuOpen(false)
    void activateTab(tabId)
  }

  function moveTabToLeftPane(tabId: string) {
    if (tabId === rightTabId) {
      if (rightPaneRef.current) updateRightTabState(rightPaneRef.current.getState())
      rightPaneLoadGenerationRef.current += 1
      setRightDocument(null)
      assignPane('right', null)
      setSplitEnabled(false)
    }
    setActivePane('left')
    void activateTab(tabId)
  }

  function activateTabForPane(tabId: string) {
    if (splitEnabled && activePane === 'right') {
      void openTabInRightPane(tabId)
    } else {
      openTabInLeftPane(tabId)
    }
  }

  function focusPane(side: PaneSide) {
    const assignment = side === 'left'
      ? leftPaneAssignmentRef.current
      : rightPaneAssignmentRef.current
    if (!assignment.tabId) {
      setActivePane(side)
      return
    }
    activeTabIdRef.current = assignment.tabId
    setActiveTabId(assignment.tabId)
    setActivePane(side)
  }

  function startSplitResize(event: React.PointerEvent<HTMLDivElement>) {
    const container = splitContainerRef.current
    if (!container) {
      return
    }
    const splitContainer = container
    const leftPane = leftPaneContainerRef.current
    if (!leftPane) {
      return
    }
    const splitLeftPane = leftPane
    event.preventDefault()
    const handle = event.currentTarget
    const pointerId = event.pointerId
    handle.setPointerCapture(pointerId)
    setSplitResizing(true)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    function resize(pointerEvent: PointerEvent) {
      const bounds = splitContainer.getBoundingClientRect()
      const leftBounds = splitLeftPane.getBoundingClientRect()
      const availableWidth = Math.max(1, bounds.right - leftBounds.left)
      setSplitRatio(
        Math.min(0.75, Math.max(0.25, (pointerEvent.clientX - leftBounds.left) / availableWidth)),
      )
    }

    function finish() {
      window.removeEventListener('pointermove', resize)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      if (handle.hasPointerCapture(pointerId)) {
        handle.releasePointerCapture(pointerId)
      }
      setSplitResizing(false)
    }

    window.addEventListener('pointermove', resize)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
  }

  function applyRightScrollToLeft(position: Omit<SplitScrollPosition, 'token'>) {
    if (!syncScrolling || suppressLeftSyncRef.current || !splitEnabled) {
      return
    }
    const pageNumber = Math.min(numPages, Math.max(1, position.page))
    ensurePageRenderWindow(pageNumber)
    suppressLeftSyncRef.current = true
    currentPageRef.current = pageNumber
    setCurrentPage(pageNumber)
    setPageInput(String(pageNumber))
    window.requestAnimationFrame(() => {
      const page = pageRefs.current.get(pageNumber)
      if (page) {
        const headerHeight = headerRef.current?.offsetHeight ?? 0
        const bounds = page.getBoundingClientRect()
        window.scrollTo({
          top: window.scrollY + bounds.top - headerHeight + bounds.height * position.offset,
          behavior: 'auto',
        })
      }
      window.setTimeout(() => {
        suppressLeftSyncRef.current = false
      }, 100)
    })
  }

  function goToActivePage(action: 'next' | 'previous' | 'first' | 'last') {
    if (splitEnabled && activePane === 'right') {
      const handle = rightPaneRef.current
      if (action === 'next') handle?.nextPage()
      else if (action === 'previous') handle?.previousPage()
      else if (action === 'first') handle?.firstPage()
      else handle?.lastPage()
      return
    }
    const destination = action === 'next'
      ? currentPageRef.current + 1
      : action === 'previous'
        ? currentPageRef.current - 1
        : action === 'first'
          ? 1
          : numPages
    goToPage(destination)
  }

  function changeActiveZoom(amount: number | 'reset') {
    if (splitEnabled && activePane === 'right') {
      if (amount === 'reset') rightPaneRef.current?.resetZoom()
      else rightPaneRef.current?.zoomBy(amount)
      return
    }
    changeZoom(amount === 'reset' ? 1 : displayZoomRef.current + amount)
  }

  function fitActivePane() {
    if (splitEnabled && activePane === 'right') {
      rightPaneRef.current?.fitWidth()
    } else {
      fitWidth()
    }
  }

  function rotateActivePane(amount: -90 | 90) {
    if (splitEnabled && activePane === 'right') {
      rightPaneRef.current?.rotateBy(amount)
    } else {
      rotatePages(amount)
    }
  }

  function openActivePaneSearch() {
    if (splitEnabled && activePane === 'right') {
      rightPaneRef.current?.openSearch()
    } else {
      setSearchOpen(true)
      window.requestAnimationFrame(() => searchInputRef.current?.focus())
    }
  }

  function destinationPreferenceToChoice(
    preference: PdfOpenDestinationPreference,
  ): PdfOpenDestinationChoice | null {
    if (preference === 'individual') return 'individual'
    if (preference === 'current-workspace') return 'current-workspace'
    if (preference === 'choose-workspace') return 'another-workspace'
    return null
  }

  function choiceToDestinationPreference(
    choice: PdfOpenDestinationChoice,
  ): PdfOpenDestinationPreference {
    if (choice === 'individual') return 'individual'
    if (choice === 'current-workspace') return 'current-workspace'
    return 'choose-workspace'
  }

  function requestPdfOpenDestination(
    document: { id: string; name: string },
  ): Promise<PdfOpenDestinationDecision | null> {
    const silentChoice = destinationPreferenceToChoice(pdfOpenDestination)
    if (silentChoice && silentChoice !== 'another-workspace') {
      return Promise.resolve({ choice: silentChoice })
    }

    const initialChoice = silentChoice ?? 'individual'
    return new Promise((resolve) => {
      setPdfOpenDestinationPrompt({
        document,
        initialChoice,
        remember: false,
        workspaceId: activeWorkspaceId || workspaceList[0]?.id || '',
        workspaceName: '',
        resolve,
      })
    })
  }

  async function setDefaultPdfDestination(destination: PdfOpenDestinationPreference) {
    const saved = await window.electronAPI.setPdfOpenDestination(destination)
    setPdfOpenDestination(saved)
  }

  async function applyPdfOpenDestination(
    decision: PdfOpenDestinationDecision,
    document: { id: string; name: string },
  ) {
    if (decision.choice === 'individual') {
      return
    }

    if (decision.choice === 'current-workspace') {
      if (!activeWorkspaceId) throw new Error('No workspace active.')
      await window.electronAPI.addWorkspaceDocument(activeWorkspaceId, document.id)
      await refreshWorkspaceManager(activeWorkspaceId)
      return
    }

    if (decision.choice === 'another-workspace') {
      if (!decision.workspaceId) throw new Error('Choose a workspace.')
      await window.electronAPI.addWorkspaceDocument(decision.workspaceId, document.id)
      await refreshWorkspaceManager(decision.workspaceId)
      return
    }

    const name = decision.workspaceName?.trim()
    if (!name) throw new Error('Workspace name is required.')
    const workspace = await window.electronAPI.createWorkspace({
      name,
      description: '',
      color: '#3b82f6',
      icon: 'folder',
      template: 'blank',
    })
    const switched = await window.electronAPI.switchWorkspace(workspace.id, getWorkspaceSnapshot())
    setActiveWorkspaceId(switched.workspace.id)
    await applyWorkspaceSession(switched.session)
    await window.electronAPI.addWorkspaceDocument(workspace.id, document.id)
    await refreshWorkspaceManager(workspace.id)
  }

  async function openPreparedPdf(
    result: OpenedPdf,
    targetPane: PaneSide = splitEnabled ? activePane : 'left',
  ) {
    const decision = await requestPdfOpenDestination({ id: result.id, name: result.name })
    if (!decision) {
      setIsLoading(false)
      setLoadingProgress(null)
      return
    }

    if (decision.choice === 'new-workspace') {
      await applyPdfOpenDestination(decision, result)
      openResultInTab(result, { targetPane: 'left' })
    } else {
      openResultInTab(result, { targetPane })
      await applyPdfOpenDestination(decision, result)
    }
    await refreshRecentFiles()
  }

  function clearViewer() {
    tabSwitchGenerationRef.current += 1
    pdfDocumentRef.current = null
    firstPageProxyRef.current = null
    pageRefs.current.clear()
    pageTextCacheRef.current.clear()
    closeSearch()
    setPdfFile(null)
    setPdfDocument(null)
    setActiveDocumentId(null)
    activeDocumentIdRef.current = null
    setNumPages(0)
    setCurrentPage(1)
    currentPageRef.current = 1
    setPageInput('1')
    setHighlights([])
    setSignaturePlacements([])
    setFillSignFields([])
    setActiveFillSignTool(null)
    setSelectedFillSignFieldId(null)
    setSigningSignature(null)
    setSelectedSignaturePlacementId(null)
    setSignPickerOpen(false)
    setOutline([])
    setDocumentMetadata(null)
    ocrDetectionGenerationRef.current += 1
    setOcrDetection(EMPTY_OCR_DETECTION)
    setPageOcrResults([])
    setCurrentPageTextStatus('unknown')
    setOcrJob(null)
    setIsLoading(false)
    setLoadingProgress(null)
    setIsRestoring(false)
    restoringReadingStateRef.current = false
    pendingRestorePageRef.current = null
    pendingRestoreOffsetRef.current = 0
  }

  async function openPdf(targetPane: PaneSide = splitEnabled ? activePane : 'left') {
    setErrorMessage(null)
    setIsLoading(true)
    setLoadingProgress('Reading PDF file...')

    try {
      const result = await window.electronAPI.openPdf()

      if (!result) {
        setIsLoading(false)
        setLoadingProgress(null)
        return
      }

      await openPreparedPdf(result, targetPane)
    } catch (error) {
      setIsLoading(false)
      setLoadingProgress(null)
      setErrorMessage(getErrorMessage(error))
    }
  }

  async function openDroppedPdf(
    file: File,
    targetPane: PaneSide = splitEnabled ? activePane : 'left',
  ) {
    setErrorMessage(null)
    setIsLoading(true)
    setLoadingProgress('Reading PDF file...')

    try {
      const result = await window.electronAPI.openDroppedPdf(file)
      await openPreparedPdf(result, targetPane)
    } catch (error) {
      setIsLoading(false)
      setLoadingProgress(null)
      setErrorMessage(getErrorMessage(error))
    }
  }

  async function printCurrentPdf() {
    const documentId = splitEnabled && activePane === 'right'
      ? rightDocument?.id ?? null
      : activeDocumentId
    if (!documentId || isPrinting) {
      return
    }

    setErrorMessage(null)
    setIsPrinting(true)
    try {
      await window.electronAPI.printPdf(documentId)
    } catch (error) {
      setErrorMessage(`Printing failed: ${getErrorMessage(error)}`)
    } finally {
      setIsPrinting(false)
    }
  }

  async function saveSignedCopy() {
    const document = activeSignatureDocument
    const placements = activeSignaturePlacements
    const fields = activeFillSignFields
    if (!document || isSavingSignedCopy) return
    if (placements.length === 0 && fields.length === 0) {
      setErrorMessage('No signatures or Fill & Sign fields have been added.')
      return
    }
    const activeRotation = splitEnabled && activePane === 'right'
      ? rightPaneRef.current?.getState().rotation ?? rightPaneState?.rotation ?? 0
      : rotation
    if (normalizeRotation(activeRotation) !== 0) {
      setErrorMessage('Please reset page rotation before signing.')
      return
    }
    if (
      placements.some((placement) => normalizeRotation(placement.pageRotation ?? 0) !== 0) ||
      fields.some((field) => normalizeRotation(field.pageRotation ?? 0) !== 0)
    ) {
      setErrorMessage('Some Fill & Sign items were placed while the page was rotated. Reset rotation, remove those items, and place them again before exporting.')
      return
    }

    setIsSavingSignedCopy(true)
    setErrorMessage(null)
    setLoadingProgress('Preparing signed PDF copy...')
    try {
      const result = await window.electronAPI.saveSignedPdf({
        identity: {
          id: document.id,
          fileSize: document.fileSize,
          modifiedAt: document.modifiedAt,
        },
        placements,
        fillSignFields: fields,
      })
      if (result?.openedPdf) {
        openResultInTab(result.openedPdf, { targetPane: splitEnabled ? activePane : 'left' })
      }
      if (result?.outputPath) {
        setErrorMessage(null)
        setLoadingProgress('Signed PDF copy saved successfully.')
        window.setTimeout(() => setLoadingProgress(null), 2200)
      } else {
        setLoadingProgress(null)
      }
      await refreshRecentFiles()
    } catch (error) {
      setErrorMessage(`Signed PDF export failed: ${getErrorMessage(error)}`)
      setLoadingProgress(null)
    } finally {
      setIsSavingSignedCopy(false)
    }
  }

  async function exportCurrentPage(format: 'png' | 'jpeg') {
    if (splitEnabled && activePane === 'right') {
      setExportMenuOpen(false)
      setIsExporting(true)
      try {
        await rightPaneRef.current?.exportPage(format)
      } finally {
        setIsExporting(false)
      }
      return
    }
    if (!pdfDocument || !pdfFile || isExporting) {
      return
    }

    setExportMenuOpen(false)
    setErrorMessage(null)
    setIsExporting(true)

    try {
      const page = await pdfDocument.getPage(currentPageRef.current)
      const viewport = page.getViewport({
        scale: 2,
        rotation: normalizeRotation(page.rotate + rotation),
      })
      const canvas = document.createElement('canvas')
      canvas.width = Math.ceil(viewport.width)
      canvas.height = Math.ceil(viewport.height)
      const canvasContext = canvas.getContext('2d')
      if (!canvasContext) {
        throw new Error('Canvas rendering is unavailable.')
      }

      await page.render({
        canvas,
        canvasContext,
        viewport,
        background: '#ffffff',
      }).promise

      const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png'
      const blob = await canvasToBlob(canvas, mimeType, format === 'jpeg' ? 0.92 : undefined)
      const extension = format === 'jpeg' ? 'jpg' : 'png'
      const baseName = pdfFile.name.replace(/\.pdf$/i, '')
      await window.electronAPI.exportPage({
        data: new Uint8Array(await blob.arrayBuffer()),
        format,
        defaultName: `${baseName}-page-${currentPageRef.current}.${extension}`,
      })
    } catch (error) {
      setErrorMessage(`Page export failed: ${getErrorMessage(error)}`)
    } finally {
      setIsExporting(false)
    }
  }

  async function openRecentPdf(
    id: string,
    targetPane: PaneSide = splitEnabled ? activePane : 'left',
  ) {
    const existingTab = tabsRef.current.find((tab) => tab.documentId === id)
    const knownDocument = existingTab
      ? { id: existingTab.documentId, name: existingTab.name }
      : recentFiles.find((item) => item.id === id)
    const decision = knownDocument ? await requestPdfOpenDestination(knownDocument) : null
    if (knownDocument && !decision) return
    if (knownDocument && decision?.choice === 'new-workspace') {
      setErrorMessage(null)
      setIsLoading(true)
      setLoadingProgress('Reading PDF file...')
      try {
        await applyPdfOpenDestination(decision, knownDocument)
        const result = await loadDocumentOnce(id)
        openResultInTab(result, { targetPane: 'left' })
        await refreshRecentFiles()
      } catch (error) {
        setIsLoading(false)
        setLoadingProgress(null)
        setErrorMessage(getErrorMessage(error))
      }
      return
    }

    if (rightPaneAssignmentRef.current.documentId === id && rightDocument?.id === id) {
      setWorkspaceManagerOpen(false)
      if (decision && knownDocument) await applyPdfOpenDestination(decision, knownDocument)
      focusPane('right')
      return
    }
    if (leftPaneAssignmentRef.current.documentId === id && pdfFile?.id === id) {
      setWorkspaceManagerOpen(false)
      if (decision && knownDocument) await applyPdfOpenDestination(decision, knownDocument)
      focusPane('left')
      return
    }
    if (existingTab) {
      setWorkspaceManagerOpen(false)
      if (rightPaneAssignmentRef.current.tabId === existingTab.tabId) {
        await openTabInRightPane(existingTab.tabId)
      } else {
        await activateTab(existingTab.tabId)
      }
      if (decision && knownDocument) await applyPdfOpenDestination(decision, knownDocument)
      return
    }

    setErrorMessage(null)
    setIsLoading(true)
    setLoadingProgress('Reading PDF file...')
    recentFilesRef.current?.removeAttribute('open')

    let handedToViewer = false
    try {
      const result = await loadDocumentOnce(id)
      if (decision) {
        if (decision.choice === 'new-workspace') {
          await applyPdfOpenDestination(decision, result)
          openResultInTab(result, { targetPane: 'left' })
        } else {
          openResultInTab(result, { targetPane })
          await applyPdfOpenDestination(decision, result)
        }
      } else {
        await openPreparedPdf(result, targetPane)
      }
      handedToViewer = true
      await refreshRecentFiles()
    } catch (error) {
      setErrorMessage(getErrorMessage(error))
      await refreshRecentFiles()
    } finally {
      if (!handedToViewer) {
        setIsLoading(false)
        setLoadingProgress(null)
      }
    }
  }

  function loadOpenedPdf(result: OpenedPdf, tabState?: PdfTabState) {
    const readingState = tabState ?? result.readingState
    const restoredZoom = clampScale(readingState.zoom)
    documentLoadStartedRef.current = performance.now()
    initialPageRenderedRef.current = false
    restoringReadingStateRef.current = true
    setIsRestoring(true)
    setLoadingProgress('Parsing PDF...')
    isRestoringZoomPositionRef.current = false
    navigationTargetRef.current = null
    window.clearTimeout(navigationTimeoutRef.current)
    window.clearTimeout(zoomDebounceRef.current)
    window.clearTimeout(zoomSnapshotTimeoutRef.current)
    window.clearTimeout(backgroundDocumentTaskRef.current)
    searchIndexAbortRef.current?.abort()
    searchIndexAbortRef.current = null
    setSearchIndexProgress(null)
    pendingRestorePageRef.current = readingState.page
    pendingRestoreOffsetRef.current = tabState?.pageOffset ?? 0
    zoomAnchorRef.current = null
    pageTextCacheRef.current.clear()
    outlineGenerationRef.current += 1
    metadataGenerationRef.current += 1
    ocrDetectionGenerationRef.current += 1
    setOutline([])
    setOutlineLoading(false)
    setDocumentMetadata(null)
    setMetadataLoading(false)
    setOcrDetection(normalizeOcrDetection(result.ocrDetection))
    setPageOcrResults([])
    setCurrentPageTextStatus('unknown')
    setOcrJob(null)
    highlightSaveGenerationRef.current += 1
    signaturePlacementSaveGenerationRef.current += 1
    fillSignSaveGenerationRef.current += 1
    setHighlights(result.highlights ?? [])
    setSignaturePlacements(result.signaturePlacements ?? [])
    setFillSignFields(result.fillSignFields ?? [])
    setActiveFillSignTool(null)
    setSelectedFillSignFieldId(null)
    setSigningSignature(null)
    setSelectedSignaturePlacementId(null)
    setSignPickerOpen(false)
    setPendingHighlightSelection(null)
    setHighlightContextMenu(null)
    setFocusedHighlightId(null)
    setEditingNoteId(null)
    setExportHighlightsOpen(false)
    firstPageProxyRef.current = null
    pdfDocumentRef.current = null
    setVisibleThumbnailPages(new Set())
    nearbyPageNumbersRef.current.clear()
    setRenderedPageNumbers(new Set([1]))
    setPdfDocument(null)
    searchGenerationRef.current += 1
    pageTextCacheRef.current.clear()
    pendingSearchMatchIndexRef.current = tabState?.selectedMatchIndex ?? -1
    setSearchOpen(tabState?.searchOpen ?? false)
    setSearchQuery(tabState?.searchQuery ?? '')
    setSearchMatches([])
    setSelectedMatchIndex(-1)
    setIsSearching(false)
    setSearchProgress(null)
    if (tabState) {
      setThumbnailSidebarOpen(tabState.sidebarOpen)
      setSidebarTab(tabState.sidebarTab)
      setSidebarWidth(tabState.sidebarWidth)
    }
    setActiveDocumentId(result.id)
    activeDocumentIdRef.current = result.id
    displayZoomRef.current = restoredZoom
    renderZoomRef.current = restoredZoom
    setDisplayZoom(restoredZoom)
    setRenderZoom(restoredZoom)
    setIsZooming(false)
    setZoomMode(readingState.fitMode ? 'fit-width' : 'manual')
    setRotation(normalizeRotation(readingState.rotation))
    setPdfFile({
      id: result.id,
      name: result.name,
      filePath: result.filePath,
      fileSize: result.fileSize,
      modifiedAt: result.modifiedAt,
      dataUrl: result.dataUrl,
    })
    setNumPages(0)
    setFirstPageWidth(0)
    setFirstPageHeight(0)
    currentPageRef.current = 1
    setCurrentPage(1)
    setPageInput('1')
    void refreshPageOcrResults(result.id)
    void logMemoryUsage('PDF open started')
  }

  async function refreshPageOcrResults(documentId: string) {
    try {
      const results = await window.electronAPI.listPageOcrResults(documentId)
      if (activeDocumentIdRef.current === documentId) {
        setPageOcrResults(results)
      }
      const completedResults = results.filter((result) => result.status === 'complete' && result.text.trim())
      if (completedResults.length > 0) {
        await window.electronAPI.appendOcrSearchIndexPages(
          documentId,
          completedResults.map((result) => ({
            pageNumber: result.pageNumber,
            text: result.text,
            language: result.language,
            confidence: result.confidence,
            lowConfidence: result.lowConfidence,
            createdAt: result.createdAt,
            updatedAt: result.updatedAt,
          })),
        ).catch((error) => console.warn('Cached OCR search index update failed:', getErrorMessage(error)))
      }
    } catch (error) {
      console.warn('Could not load OCR page results:', getErrorMessage(error))
    }
  }

  async function refreshRecentFiles() {
    try {
      setRecentFiles(await window.electronAPI.getRecentPdfs())
    } catch (error) {
      setErrorMessage(getErrorMessage(error))
    }
  }

  async function clearRecentFiles() {
    try {
      await window.electronAPI.clearRecentPdfs()
      setRecentFiles([])
      setClearRecentConfirmOpen(false)
    } catch (error) {
      setErrorMessage(`Could not clear recent files: ${getErrorMessage(error)}`)
    }
  }

  async function removeRecentFile(id: string) {
    try {
      setRecentFiles(await window.electronAPI.removeRecentPdf(id))
    } catch (error) {
      setErrorMessage(`Could not remove recent file: ${getErrorMessage(error)}`)
    }
  }

  async function openHighlightLibrary() {
    setWorkspaceManagerOpen(false)
    setReferencesOpen(false)
    setGlobalSearchOpen(false)
    setGlobalSearchReturnToDashboard(false)
    setGlobalDashboardOpen(true)
    await refreshHighlightLibrary()
  }

  function openGlobalSearch() {
    setWorkspaceManagerOpen(false)
    setReferencesOpen(false)
    setGlobalSearchReturnToDashboard(globalDashboardOpen)
    setGlobalDashboardOpen(false)
    setGlobalSearchOpen(true)
  }

  function closeGlobalSearch() {
    setGlobalSearchOpen(false)
    if (globalSearchReturnToDashboard) setGlobalDashboardOpen(true)
    setGlobalSearchReturnToDashboard(false)
  }

  function openReferences() {
    setGlobalDashboardOpen(false)
    setGlobalSearchOpen(false)
    setWorkspaceManagerOpen(false)
    setMergePdfsOpen(false)
    setImagesToPdfOpen(false)
    setSignatureManagerOpen(false)
    setReferencesOpen(true)
  }

  async function openGlobalSearchResult(result: GlobalSearchResult, query: string) {
    setGlobalSearchOpen(false)
    setGlobalSearchReturnToDashboard(false)
    setErrorMessage(null)
    const navigation = { result, query: result.matchText || globalSearchNavigationTerm(query) }
    const existingTab = tabsRef.current.find((tab) => tab.documentId === result.documentId)
    if (
      existingTab?.tabId === rightPaneAssignmentRef.current.tabId &&
      rightDocument?.id === result.documentId
    ) {
      focusPane('right')
      if (result.highlightId) {
        rightPaneRef.current?.navigateToHighlight(result.highlightId, result.pageNumber)
      } else if (result.type === 'pdf-text' || result.type === 'ocr-text') {
        rightPaneRef.current?.navigateToSearchResult(result.pageNumber, navigation.query)
      } else {
        rightPaneRef.current?.goToPage(result.pageNumber)
      }
      return
    }

    setPendingGlobalSearchNavigation(navigation)
    if (existingTab) {
      await activateTab(existingTab.tabId)
      return
    }

    setIsLoading(true)
    setLoadingProgress(`Opening ${result.documentName}...`)
    try {
      const opened = await window.electronAPI.openRecentPdf(result.documentId)
      openResultInTab(opened)
      void refreshRecentFiles()
    } catch (error) {
      setPendingGlobalSearchNavigation(null)
      setIsLoading(false)
      setLoadingProgress(null)
      setErrorMessage(`Could not open search result: ${getErrorMessage(error)}`)
    }
  }

  async function refreshHighlightLibrary() {
    setHighlightLibraryLoading(true)
    setHighlightLibraryError(null)
    try {
      setHighlightLibrary(await window.electronAPI.getHighlightLibrary())
    } catch (error) {
      setHighlightLibraryError(getErrorMessage(error))
    } finally {
      setHighlightLibraryLoading(false)
    }
  }

  async function openLibraryHighlight(entry: HighlightLibraryEntry) {
    setHighlightLibraryError(null)
    setGlobalDashboardOpen(false)
    const existingTab = tabsRef.current.find((tab) => tab.documentId === entry.documentId)
    if (existingTab?.tabId === rightPaneAssignmentRef.current.tabId && rightDocument?.id === entry.documentId) {
      focusPane('right')
      rightPaneRef.current?.navigateToHighlight(entry.highlightId, entry.pageNumber)
      return
    }

    setPendingLibraryNavigation(entry)
    if (existingTab) {
      await activateTab(existingTab.tabId)
      return
    }

    setIsLoading(true)
    setLoadingProgress(`Opening ${entry.documentName}...`)
    try {
      const result = await window.electronAPI.openHighlightDocument(entry.documentKey)
      openResultInTab(result)
      void refreshRecentFiles()
    } catch (error) {
      setPendingLibraryNavigation(null)
      setIsLoading(false)
      setLoadingProgress(null)
      const message = `Could not open highlight source: ${getErrorMessage(error)}`
      try {
        setHighlightLibrary(await window.electronAPI.getHighlightLibrary())
      } catch {
        // Preserve the source-open error; refresh can be retried from the dashboard.
      }
      setErrorMessage(message)
    }
  }

  function synchronizeLibraryPatch(
    entries: HighlightLibraryEntry[],
    patch: Partial<Pick<PdfHighlight, 'note' | 'category' | 'color'>>,
    library: HighlightLibrary,
  ) {
    const targets = new Set(entries.map((entry) => `${entry.documentId}:${entry.highlightId}`))
    const applyPatch = (documentId: string, source: PdfHighlight[]) =>
      source.map((highlight) => {
        if (!targets.has(`${documentId}:${highlight.id}`)) return highlight
        const indexed = library.entries.find(
          (entry) => entry.documentId === documentId && entry.highlightId === highlight.id,
        )
        return {
          ...highlight,
          ...patch,
          modifiedDate: indexed?.modifiedDate ?? new Date().toISOString(),
        }
      })
    if (pdfFile) setHighlights((current) => applyPatch(pdfFile.id, current))
    setRightDocument((current) => current
      ? { ...current, highlights: applyPatch(current.id, current.highlights) }
      : current)
  }

  async function updateLibraryHighlights(
    entries: HighlightLibraryEntry[],
    patch: Partial<Pick<PdfHighlight, 'note' | 'category' | 'color'>>,
  ) {
    if (!entries.length) return
    try {
      const library = await window.electronAPI.updateHighlightLibrary(
        entries.map((entry) => ({
          documentKey: entry.documentKey,
          highlightId: entry.highlightId,
          patch,
        })),
      )
      setHighlightLibrary(library)
      synchronizeLibraryPatch(entries, patch, library)
    } catch (error) {
      setHighlightLibraryError(`Could not update highlights: ${getErrorMessage(error)}`)
    }
  }

  async function deleteLibraryHighlights(entries: HighlightLibraryEntry[]) {
    if (!entries.length) return
    try {
      const deletedKeys = new Set(entries.map((entry) => entry.key))
      const deletedByDocument = new Set(entries.map((entry) => `${entry.documentId}:${entry.highlightId}`))
      const library = await window.electronAPI.deleteHighlightLibraryEntries([...deletedKeys])
      setHighlightLibrary(library)
      if (pdfFile) {
        setHighlights((current) => current.filter(
          (highlight) => !deletedByDocument.has(`${pdfFile.id}:${highlight.id}`),
        ))
      }
      setRightDocument((current) => current
        ? {
            ...current,
            highlights: current.highlights.filter(
              (highlight) => !deletedByDocument.has(`${current.id}:${highlight.id}`),
            ),
          }
        : current)
    } catch (error) {
      setHighlightLibraryError(`Could not delete highlights: ${getErrorMessage(error)}`)
    }
  }

  async function exportLibraryHighlights(
    entries: HighlightLibraryEntry[],
    format: 'markdown' | 'text' | 'docx',
  ) {
    try {
      await window.electronAPI.exportHighlightLibrary({
        format,
        keys: entries.map((entry) => entry.key),
      })
    } catch (error) {
      setHighlightLibraryError(`Could not export highlights: ${getErrorMessage(error)}`)
    }
  }

  function toggleToolbarMenu(menu: ToolbarMenu) {
    setToolbarMenuOpen((current) => current === menu ? null : menu)
    setPdfToolsMenuOpen(false)
    setSignPickerOpen(false)
  }

  function closeToolbarMenu() {
    setToolbarMenuOpen(null)
  }

  function setActiveZoomPreset(nextZoom: number) {
    if (splitEnabled && activePane === 'right') {
      const currentZoom = rightPaneState?.zoom ?? 1
      rightPaneRef.current?.zoomBy(nextZoom - currentZoom)
    } else {
      changeZoom(nextZoom)
    }
    closeToolbarMenu()
  }

  function openPdfToolPanel(tool: 'merge' | 'images' | 'signatures') {
    setWorkspaceManagerOpen(false)
    setReferencesOpen(false)
    setGlobalDashboardOpen(false)
    setGlobalSearchOpen(false)
    setMergePdfsOpen(tool === 'merge')
    setImagesToPdfOpen(tool === 'images')
    setSignatureManagerOpen(tool === 'signatures')
    closeToolbarMenu()
  }

  async function renderPageForOcr(pageNumber: number) {
    if (!pdfDocument) throw new Error('No PDF is open.')
    const page = await pdfDocument.getPage(pageNumber)
    const viewport = page.getViewport({
      scale: 2.5,
      rotation: normalizeRotation(page.rotate + rotation),
    })
    const canvas = document.createElement('canvas')
    canvas.width = Math.ceil(viewport.width)
    canvas.height = Math.ceil(viewport.height)
    const canvasContext = canvas.getContext('2d')
    if (!canvasContext) throw new Error('Canvas rendering is unavailable.')
    await page.render({
      canvas,
      canvasContext,
      viewport,
      background: '#ffffff',
    }).promise
    return {
      pageNumber,
      imageDataUrl: canvas.toDataURL('image/png'),
    }
  }

  async function runOcrPages(requestedPages: number[], force = false) {
    closeToolbarMenu()
    if (!pdfDocument || !pdfFile) {
      setErrorMessage('Open a PDF before running OCR.')
      return
    }
    if (splitEnabled && activePane === 'right') {
      setErrorMessage('OCR Current Page is available from the left pane in this pass.')
      return
    }
    const pages = normalizeOcrPageList(requestedPages, numPages).filter((pageNumber) =>
      force ? true : !pageOcrResultKeys.has(`${pageNumber}:${ocrLanguage}`),
    )
    if (pages.length === 0) {
      setLoadingProgress('OCR already completed for the selected pages. Choose Run OCR Again to replace cached OCR text.')
      window.setTimeout(() => setLoadingProgress(null), 2600)
      return
    }

    setErrorMessage(null)
    const operationId = crypto.randomUUID()
    const startedAt = performance.now()
    const failedPageNumbers: number[] = []
    let completedPages = 0
    ocrBatchCancelRef.current = false
    ocrBatchPausedRef.current = false
    setOcrJob({
      operationId,
      pageNumber: pages[0],
      status: `OCR page ${pages[0]} of ${numPages}`,
      progress: 0,
      totalPages: pages.length,
      completedPages: 0,
      failedPages: 0,
      failedPageNumbers,
      startedAt,
      estimatedRemainingMs: null,
      paused: false,
    })
    setLoadingProgress(`OCR running on ${pages.length === 1 ? `page ${pages[0]}` : `${pages.length} pages`}`)

    for (const [pageIndex, pageNumber] of pages.entries()) {
      if (ocrBatchCancelRef.current) break
      while (ocrBatchPausedRef.current && !ocrBatchCancelRef.current) {
        await delay(250)
      }
      if (ocrBatchCancelRef.current) break

      const pageOperationId = `${operationId}:page:${pageNumber}`
      activeOcrOperationRef.current = pageOperationId
      setOcrJob((current) => current
        ? {
            ...current,
            pageNumber,
            status: `OCR page ${pageNumber} of ${numPages}`,
            progress: pageIndex / pages.length,
            completedPages,
            failedPages: failedPageNumbers.length,
            failedPageNumbers: [...failedPageNumbers],
            estimatedRemainingMs: estimateRemainingMs(startedAt, completedPages, pages.length),
          }
        : current)

      try {
        const renderedPage = await renderPageForOcr(pageNumber)
        const result = await window.electronAPI.runPageOcr({
          operationId: pageOperationId,
          documentId: pdfFile.id,
          pageNumber: renderedPage.pageNumber,
          language: ocrLanguage,
          imageDataUrl: renderedPage.imageDataUrl,
          force,
        })
        completedPages += 1
        setPageOcrResults((current) => [
          ...current.filter(
            (candidate) =>
              !(
                candidate.pageNumber === result.pageNumber &&
                candidate.language === result.language
              ),
          ),
          result,
        ])
        if (result.text.trim()) {
          await window.electronAPI.appendOcrSearchIndexPages(pdfFile.id, [
            {
              pageNumber: result.pageNumber,
              text: result.text,
              language: result.language,
              confidence: result.confidence,
              lowConfidence: result.lowConfidence,
              createdAt: result.createdAt,
              updatedAt: result.updatedAt,
            },
          ]).catch((error) => console.warn('OCR search index update failed:', getErrorMessage(error)))
        }
      } catch (error) {
        if (!ocrBatchCancelRef.current && !cancelledOcrOperationsRef.current.has(pageOperationId)) {
          failedPageNumbers.push(pageNumber)
          console.warn(`OCR failed on page ${pageNumber}:`, getErrorMessage(error))
        }
        cancelledOcrOperationsRef.current.delete(pageOperationId)
      }
      setOcrJob((current) => current
        ? {
            ...current,
            progress: (pageIndex + 1) / pages.length,
            completedPages,
            failedPages: failedPageNumbers.length,
            failedPageNumbers: [...failedPageNumbers],
            estimatedRemainingMs: estimateRemainingMs(startedAt, completedPages + failedPageNumbers.length, pages.length),
          }
        : current)
      await yieldToMainThread()
    }

    activeOcrOperationRef.current = null
    setOcrDetection((current) => ({
      ...current,
      status: current.status === 'searchable' ? current.status : 'ocr-recommended',
      detectedAt: new Date().toISOString(),
    }))
    setOcrJob(null)
    if (ocrBatchCancelRef.current) {
      setLoadingProgress('OCR cancelled')
      window.setTimeout(() => setLoadingProgress(null), 1500)
    } else if (failedPageNumbers.length > 0) {
      setErrorMessage(`OCR finished with failed pages: ${formatPageList(failedPageNumbers)}`)
      setLoadingProgress(null)
    } else {
      setLoadingProgress('OCR complete')
      window.setTimeout(() => setLoadingProgress(null), 2200)
    }
    ocrBatchCancelRef.current = false
    ocrBatchPausedRef.current = false
  }

  async function runCurrentPageOcr(force = false) {
    await runOcrPages([currentPageRef.current], force)
  }

  async function runSelectedPagesOcr(force = false) {
    try {
      const pages = parsePageRanges(ocrPageRangeInput, numPages)
      await runOcrPages(pages, force)
    } catch (error) {
      setErrorMessage(getErrorMessage(error))
    }
  }

  async function runEntireDocumentOcr(force = false) {
    await runOcrPages(Array.from({ length: numPages }, (_, index) => index + 1), force)
  }

  async function cancelCurrentPageOcr() {
    if (!ocrJob) return
    try {
      ocrBatchCancelRef.current = true
      const activeOperationId = activeOcrOperationRef.current ?? ocrJob.operationId
      cancelledOcrOperationsRef.current.add(activeOperationId)
      await window.electronAPI.cancelPageOcr(activeOperationId)
      setLoadingProgress(null)
      setOcrJob(null)
    } catch (error) {
      setErrorMessage(`Could not cancel OCR: ${getErrorMessage(error)}`)
    }
  }

  function toggleOcrPause() {
    ocrBatchPausedRef.current = !ocrBatchPausedRef.current
    setOcrJob((current) => current ? { ...current, paused: ocrBatchPausedRef.current } : current)
  }

  function startFillSignTool(tool: FillSignTool) {
    activateFillSignTool(tool)
    closeToolbarMenu()
  }

  async function prepareSignatureMenu() {
    await refreshSavedSignatures()
  }

  return (
    <main className="min-h-screen bg-[#0f172a] text-slate-100">
      {dragActive ? (
        <div className="pointer-events-none fixed inset-0 z-50 grid place-items-center bg-slate-950/75 p-8 backdrop-blur-sm">
          <div className="flex min-h-64 w-full max-w-xl flex-col items-center justify-center gap-4 rounded-3xl border-2 border-dashed border-blue-400 bg-slate-900/95 px-8 text-center shadow-2xl shadow-black/60">
            <span className="grid size-16 place-items-center rounded-2xl bg-blue-500/15 text-blue-300">
              <DropPdfIcon />
            </span>
            <div>
              <p className="text-xl font-semibold text-white">
                Drop PDF into {dropTargetPane ? `${dropTargetPane === 'left' ? 'Left' : 'Right'} Pane` : `${activePane === 'left' ? 'Left' : 'Right'} Pane`}
              </p>
              <p className="mt-1 text-sm text-slate-400">The first PDF in the drop will open only in that pane.</p>
            </div>
          </div>
        </div>
      ) : null}

      {pendingHighlightSelection ? (
        <HighlightSelectionToolbar
          x={pendingHighlightSelection.toolbarX}
          y={pendingHighlightSelection.toolbarY}
          onHighlight={(color) => addHighlight(pendingHighlightSelection, color)}
          onRemove={() => removeSelectedHighlights(pendingHighlightSelection)}
          onClose={clearHighlightSelection}
        />
      ) : null}

      {highlightContextMenu ? (
        <div
          data-highlight-context-menu=""
          role="menu"
          className="fixed z-50 w-56 rounded-xl border border-slate-600 bg-slate-900 p-2 shadow-2xl shadow-black/50"
          style={{ left: highlightContextMenu.x, top: highlightContextMenu.y }}
        >
          <p className="px-2 pb-1 text-[10px] font-bold uppercase tracking-wider text-slate-500">
            Change Color
          </p>
          <div className="mb-2 flex gap-1 px-1">
            {HIGHLIGHT_COLOR_ORDER.map((color) => (
              <button
                key={color}
                type="button"
                role="menuitem"
                aria-label={`Change highlight to ${HIGHLIGHT_COLOR_LABELS[color]}`}
                onClick={() => changeHighlightColor(highlightContextMenu.highlightId, color)}
                className="grid size-9 place-items-center rounded-lg hover:bg-slate-700"
              >
                <span className={`size-5 rounded-full ${highlightColorClass(color)}`} />
              </button>
            ))}
          </div>
          <label className="mb-2 block border-y border-slate-700 py-2">
            <span className="mb-1 block px-2 text-[10px] font-bold uppercase tracking-wider text-slate-500">
              Category
            </span>
            <select
              value={
                sidebarHighlights.find((highlight) => highlight.id === highlightContextMenu.highlightId)
                  ?.category ?? 'important'
              }
              onChange={(event) =>
                changeHighlightCategory(
                  highlightContextMenu.highlightId,
                  event.target.value as HighlightCategory,
                )
              }
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-200"
            >
              {HIGHLIGHT_CATEGORY_ORDER.map((category) => (
                <option key={category} value={category}>
                  {HIGHLIGHT_CATEGORY_LABELS[category]}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            role="menuitem"
            onClick={() => startEditingNote(highlightContextMenu.highlightId)}
            className="w-full rounded-lg px-3 py-2 text-left text-sm text-slate-200 hover:bg-slate-800"
          >
            {sidebarHighlights.find((highlight) => highlight.id === highlightContextMenu.highlightId)?.note
              ? 'Edit Note'
              : 'Add Note'}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => void copyHighlightText(highlightContextMenu.highlightId)}
            className="w-full rounded-lg px-3 py-2 text-left text-sm text-slate-200 hover:bg-slate-800"
          >
            Copy Highlighted Text
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => void copyHighlightWithNote(highlightContextMenu.highlightId)}
            className="w-full rounded-lg px-3 py-2 text-left text-sm text-slate-200 hover:bg-slate-800"
          >
            Copy Highlight + Note
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => removeHighlight(highlightContextMenu.highlightId)}
            className="w-full rounded-lg px-3 py-2 text-left text-sm text-red-200 hover:bg-red-500/20"
          >
            Delete Highlight
          </button>
        </div>
      ) : null}

      {tabContextMenu ? (
        <div
          role="menu"
          aria-label="Tab actions"
          className="fixed z-[70] w-52 rounded-xl border border-slate-600 bg-slate-900 p-1.5 shadow-2xl shadow-black/60"
          style={{
            left: Math.min(tabContextMenu.x, window.innerWidth - 220),
            top: Math.min(tabContextMenu.y, window.innerHeight - 240),
          }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <TabMenuButton onClick={() => void closeTab(tabContextMenu.tabId)}>Close</TabMenuButton>
          <TabMenuButton onClick={() => closeOtherTabs(tabContextMenu.tabId)}>Close Others</TabMenuButton>
          <TabMenuButton onClick={() => closeTabsToRight(tabContextMenu.tabId)}>Close Tabs to Right</TabMenuButton>
          <div className="my-1 border-t border-slate-700" />
          <TabMenuButton onClick={() => {
            void openTabInRightPane(tabContextMenu.tabId)
            setTabContextMenu(null)
          }}>Open in Split View</TabMenuButton>
          <TabMenuButton onClick={() => {
            moveTabToLeftPane(tabContextMenu.tabId)
            setTabContextMenu(null)
          }}>Move to Left Pane</TabMenuButton>
          <TabMenuButton onClick={() => {
            void openTabInRightPane(tabContextMenu.tabId)
            setTabContextMenu(null)
          }}>Move to Right Pane</TabMenuButton>
          <div className="my-1 border-t border-slate-700" />
          <TabMenuButton onClick={() => void revealTabFile(tabContextMenu.tabId)}>Reveal File</TabMenuButton>
          <TabMenuButton onClick={() => void duplicateTab(tabContextMenu.tabId)}>Duplicate Tab</TabMenuButton>
        </div>
      ) : null}

      {exportHighlightsOpen ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/70 p-4 backdrop-blur-sm">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="export-highlights-title"
            className="w-full max-w-lg rounded-2xl border border-slate-600 bg-slate-900 p-5 shadow-2xl shadow-black/60"
          >
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 id="export-highlights-title" className="text-lg font-semibold text-white">
                  Export Highlights
                </h2>
                <p className="mt-1 text-xs text-slate-400">
                  Include highlighted text, notes, page numbers, colors, and categories.
                </p>
              </div>
              <button
                type="button"
                aria-label="Close export dialog"
                onClick={() => setExportHighlightsOpen(false)}
                className="grid size-9 place-items-center rounded-lg text-xl text-slate-400 hover:bg-slate-800 hover:text-white"
              >
                &times;
              </button>
            </div>

            <label className="mb-4 block text-sm text-slate-300">
              <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500">Format</span>
              <select
                value={exportFormat}
                onChange={(event) => setExportFormat(event.target.value as typeof exportFormat)}
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2"
              >
                <option value="markdown">Markdown (.md)</option>
                <option value="text">Plain Text (.txt)</option>
                <option value="docx">Word (.docx)</option>
              </select>
            </label>

            <fieldset className="mb-4">
              <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Export Scope</legend>
              <div className="grid gap-2 sm:grid-cols-3">
                {([
                  ['all', `All (${sidebarHighlights.length})`],
                  ['category', 'Current Category'],
                  ['selected', `Selected (${selectedHighlightIds.size})`],
                ] as const).map(([scope, label]) => (
                  <label key={scope} className={`cursor-pointer rounded-lg border px-3 py-2 text-sm ${exportScope === scope ? 'border-blue-400 bg-blue-500/15 text-blue-100' : 'border-slate-700 text-slate-400'}`}>
                    <input
                      type="radio"
                      name="export-scope"
                      value={scope}
                      checked={exportScope === scope}
                      onChange={() => setExportScope(scope)}
                      className="mr-2"
                    />
                    {label}
                  </label>
                ))}
              </div>
            </fieldset>

            {exportScope === 'category' ? (
              <label className="mb-4 block text-sm text-slate-300">
                <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500">Current Category</span>
                <select
                  value={exportCategory}
                  onChange={(event) => setExportCategory(event.target.value as HighlightCategory)}
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2"
                >
                  {HIGHLIGHT_CATEGORY_ORDER.map((category) => (
                    <option key={category} value={category}>{HIGHLIGHT_CATEGORY_LABELS[category]}</option>
                  ))}
                </select>
              </label>
            ) : null}

            <fieldset className="mb-5">
              <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Categories to Include</legend>
              <div className="grid grid-cols-2 gap-2">
                {HIGHLIGHT_CATEGORY_ORDER.map((category) => (
                  <label key={category} className="flex cursor-pointer items-center gap-2 rounded-lg bg-slate-800/60 px-3 py-2 text-sm text-slate-300">
                    <input
                      type="checkbox"
                      checked={exportCategories.has(category)}
                      onChange={() => setExportCategories((current) => toggleSetValue(current, category))}
                    />
                    <span className={`size-2.5 rounded-full ${highlightCategoryColorClass(category)}`} />
                    {HIGHLIGHT_CATEGORY_LABELS[category]}
                  </label>
                ))}
              </div>
            </fieldset>

            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setExportHighlightsOpen(false)} className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:bg-slate-800">
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void exportHighlightCollection()}
                disabled={isExportingHighlights || sidebarHighlights.length === 0}
                className="rounded-lg bg-blue-500 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-400 disabled:opacity-40"
              >
                {isExportingHighlights ? 'Exporting...' : 'Choose Save Location'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {pdfOpenDestinationPrompt ? (
        <div className="fixed inset-0 z-[90] grid place-items-center bg-slate-950/75 p-4 backdrop-blur-sm">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="pdf-open-destination-title"
            className="w-full max-w-xl rounded-2xl border border-slate-600 bg-slate-900 p-5 shadow-2xl shadow-black/70"
          >
            <div className="mb-4">
              <h2 id="pdf-open-destination-title" className="text-lg font-semibold text-white">
                Open PDF
              </h2>
              <p className="mt-1 truncate text-sm text-slate-400" title={pdfOpenDestinationPrompt.document.name}>
                {pdfOpenDestinationPrompt.document.name}
              </p>
            </div>

            <div className="space-y-2">
              {([
                ['individual', 'Open individually', 'Do not add this PDF to any workspace.'],
                ['current-workspace', 'Open in current workspace', activeWorkspaceId ? `Add to ${workspaceList.find((workspace) => workspace.id === activeWorkspaceId)?.name ?? 'current workspace'}.` : 'No workspace active.'],
                ['another-workspace', 'Open in another workspace', 'Choose an existing workspace.'],
                ['new-workspace', 'Create new workspace and open', 'Create a workspace, make it active, and add this PDF.'],
              ] as Array<[PdfOpenDestinationChoice, string, string]>).map(([choice, label, description]) => (
                <label
                  key={choice}
                  className={`flex cursor-pointer gap-3 rounded-xl border px-3 py-3 transition-colors duration-150 ${
                    pdfOpenDestinationPrompt.initialChoice === choice
                      ? 'border-blue-400 bg-blue-500/15 text-blue-100'
                      : 'border-slate-700 bg-slate-950/40 text-slate-300 hover:border-slate-600 hover:bg-slate-800/70'
                  } ${choice === 'current-workspace' && !activeWorkspaceId ? 'cursor-not-allowed opacity-50' : ''}`}
                >
                  <input
                    type="radio"
                    name="pdf-open-destination"
                    value={choice}
                    checked={pdfOpenDestinationPrompt.initialChoice === choice}
                    disabled={choice === 'current-workspace' && !activeWorkspaceId}
                    onChange={() => setPdfOpenDestinationPrompt((current) => current ? { ...current, initialChoice: choice } : current)}
                    className="mt-1"
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold">{label}</span>
                    <span className="mt-0.5 block text-xs text-slate-400">{description}</span>
                  </span>
                </label>
              ))}
            </div>

            {pdfOpenDestinationPrompt.initialChoice === 'another-workspace' ? (
              <label className="mt-4 block text-sm text-slate-300">
                <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500">Workspace</span>
                <select
                  value={pdfOpenDestinationPrompt.workspaceId}
                  onChange={(event) => setPdfOpenDestinationPrompt((current) => current ? { ...current, workspaceId: event.target.value } : current)}
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-blue-400"
                >
                  {workspaceList.map((workspace) => (
                    <option key={workspace.id} value={workspace.id}>{workspace.name}</option>
                  ))}
                </select>
              </label>
            ) : null}

            {pdfOpenDestinationPrompt.initialChoice === 'new-workspace' ? (
              <label className="mt-4 block text-sm text-slate-300">
                <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500">Workspace name</span>
                <input
                  value={pdfOpenDestinationPrompt.workspaceName}
                  onChange={(event) => setPdfOpenDestinationPrompt((current) => current ? { ...current, workspaceName: event.target.value } : current)}
                  placeholder="New workspace name"
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none placeholder:text-slate-500 focus:border-blue-400"
                />
              </label>
            ) : null}

            <label className="mt-4 flex items-center gap-2 text-sm text-slate-300">
              <input
                type="checkbox"
                checked={pdfOpenDestinationPrompt.remember}
                onChange={(event) => setPdfOpenDestinationPrompt((current) => current ? { ...current, remember: event.target.checked } : current)}
              />
              Remember this choice
            </label>

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  pdfOpenDestinationPrompt.resolve(null)
                  setPdfOpenDestinationPrompt(null)
                }}
                className="rounded-lg border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-300 hover:bg-slate-800"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  const prompt = pdfOpenDestinationPrompt
                  const decision: PdfOpenDestinationDecision = {
                    choice: prompt.initialChoice,
                    workspaceId: prompt.workspaceId,
                    workspaceName: prompt.workspaceName,
                  }
                  if (prompt.remember) {
                    void setDefaultPdfDestination(choiceToDestinationPreference(prompt.initialChoice))
                  }
                  prompt.resolve(decision)
                  setPdfOpenDestinationPrompt(null)
                }}
                disabled={
                  (pdfOpenDestinationPrompt.initialChoice === 'another-workspace' && !pdfOpenDestinationPrompt.workspaceId) ||
                  (pdfOpenDestinationPrompt.initialChoice === 'new-workspace' && !pdfOpenDestinationPrompt.workspaceName.trim())
                }
                className="rounded-lg bg-blue-500 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-400 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Open
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {openingSettingsOpen ? (
        <div className="fixed inset-0 z-[90] grid place-items-center bg-slate-950/70 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-2xl border border-slate-600 bg-slate-900 p-5 shadow-2xl shadow-black/70">
            <h2 className="text-lg font-semibold text-white">Opening Settings</h2>
            <label className="mt-4 block text-sm text-slate-300">
              <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500">Default PDF opening destination</span>
              <select
                value={pdfOpenDestination}
                onChange={(event) => void setDefaultPdfDestination(event.target.value as PdfOpenDestinationPreference)}
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-blue-400"
              >
                <option value="ask">Ask every time</option>
                <option value="individual">Open individually</option>
                <option value="current-workspace">Open in current workspace</option>
                <option value="choose-workspace">Choose workspace</option>
              </select>
            </label>
            <div className="mt-5 flex justify-end">
              <button type="button" onClick={() => setOpeningSettingsOpen(false)} className="rounded-lg bg-blue-500 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-400">
                Done
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {clearRecentConfirmOpen ? (
        <div className="fixed inset-0 z-[90] grid place-items-center bg-slate-950/70 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-2xl border border-slate-600 bg-slate-900 p-5 shadow-2xl shadow-black/70">
            <h2 className="text-lg font-semibold text-white">Clear recent files?</h2>
            <p className="mt-2 text-sm leading-6 text-slate-400">
              This will only remove the recent files list. Your PDFs and workspace documents will not be deleted.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => setClearRecentConfirmOpen(false)} className="rounded-lg border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-300 hover:bg-slate-800">
                Cancel
              </button>
              <button type="button" onClick={() => void clearRecentFiles()} className="rounded-lg bg-red-500 px-4 py-2 text-sm font-semibold text-white hover:bg-red-400">
                Clear
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <header
        ref={headerRef}
        className="sticky top-0 z-50 border-b border-slate-600/90 bg-[#111827] px-3 py-2.5 shadow-lg shadow-slate-950/40 backdrop-blur-2xl sm:px-4"
      >
        <div className="flex w-full flex-wrap items-center gap-1.5 overflow-visible pb-0.5">
          <div data-toolbar-menu-scope="" className="relative shrink-0">
            <ToolbarCommandButton
              active={toolbarMenuOpen === 'open'}
              onClick={() => toggleToolbarMenu('open')}
              title="Open and recent files"
            >
              <OpenFolderRegular className="size-5" />
              <span>Open</span>
              <ChevronDownRegular className="size-3.5" />
            </ToolbarCommandButton>
            {toolbarMenuOpen === 'open' ? (
              <ToolbarMenuPanel align="left">
                <ToolbarMenuItem onClick={() => {
                  closeToolbarMenu()
                  void openPdf()
                }} icon={<OpenFolderRegular className="size-4" />}>Open PDF</ToolbarMenuItem>
                <div className="my-1 border-t border-slate-700" />
                <p className="px-3 py-1 text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">Recent Files</p>
                {recentFiles.length > 0 ? recentFiles.slice(0, 8).map((recentFile) => (
                  <div key={recentFile.id} className="rounded-lg px-1 py-1 hover:bg-slate-800/60">
                    <button
                      type="button"
                      onClick={() => {
                        closeToolbarMenu()
                        void openRecentPdf(recentFile.id)
                      }}
                      title={recentFile.name}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm font-medium text-slate-200 hover:bg-slate-800"
                    >
                      <HistoryRegular className="size-4 shrink-0 text-slate-400" />
                      <span className="block max-w-44 truncate">{recentFile.name}</span>
                    </button>
                    <div className="ml-6 flex flex-wrap gap-1 pb-1">
                      <button type="button" onClick={() => void openRecentPdf(recentFile.id)} className="rounded px-2 py-1 text-[11px] text-slate-400 hover:bg-slate-700 hover:text-white">Open</button>
                      <button type="button" onClick={() => void removeRecentFile(recentFile.id)} className="rounded px-2 py-1 text-[11px] text-slate-400 hover:bg-slate-700 hover:text-white">Remove</button>
                      <button type="button" onClick={() => void window.electronAPI.revealPdf(recentFile.id)} className="rounded px-2 py-1 text-[11px] text-slate-400 hover:bg-slate-700 hover:text-white">Reveal</button>
                    </div>
                  </div>
                )) : (
                  <p className="px-3 py-2 text-sm text-slate-500">No recent PDFs</p>
                )}
                {recentFiles.length > 0 ? (
                  <>
                    <div className="my-1 border-t border-slate-700" />
                    <ToolbarMenuItem onClick={() => {
                      closeToolbarMenu()
                      setClearRecentConfirmOpen(true)
                    }} icon={<DismissRegular className="size-4" />}>Clear Recent Files</ToolbarMenuItem>
                  </>
                ) : null}
              </ToolbarMenuPanel>
            ) : null}
          </div>

          <FluentToolbarDivider />

          <div className="flex h-10 shrink-0 items-center gap-1 rounded-lg border border-slate-700/80 bg-slate-900/55 px-1">
            <ToolbarIconButton
              label="Previous page"
              title="Previous page (PageUp)"
              onClick={() => goToActivePage('previous')}
              disabled={splitEnabled && activePane === 'right' ? (rightPaneState?.page ?? 1) === 1 : numPages === 0 || currentPage === 1}
            >
              <ArrowLeftRegular className="size-5" />
            </ToolbarIconButton>
            <label className="flex h-8 items-center gap-1.5 rounded-md bg-slate-950/70 px-2 text-sm text-slate-300">
              <span className="sr-only">Current page</span>
              <input
                type="number"
                min="1"
                max={Math.max(1, numPages)}
                value={splitEnabled && activePane === 'right' ? String(rightPaneState?.page ?? 1) : pageInput}
                disabled={numPages === 0 || (splitEnabled && activePane === 'right')}
                onFocus={() => {
                  pageInputFocusedRef.current = true
                }}
                onChange={(event) => setPageInput(event.target.value)}
                onBlur={() => {
                  pageInputFocusedRef.current = false
                  submitPageInput()
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur()
                }}
                className="w-11 bg-transparent text-center text-slate-100 outline-none disabled:opacity-40"
              />
              <span className="whitespace-nowrap text-xs text-slate-500">/ {splitEnabled && activePane === 'right' ? rightViewStatus.totalPages || 0 : numPages || 0}</span>
            </label>
            <ToolbarIconButton
              label="Next page"
              title="Next page (PageDown)"
              onClick={() => goToActivePage('next')}
              disabled={splitEnabled && activePane === 'right' ? false : numPages === 0 || currentPage === numPages}
            >
              <ArrowRightRegular className="size-5" />
            </ToolbarIconButton>
          </div>

          <FluentToolbarDivider />

          <div data-toolbar-menu-scope="" className="relative shrink-0">
            <div className="flex h-10 items-center gap-1 rounded-lg border border-slate-700/80 bg-slate-900/55 px-1">
              <ToolbarIconButton
                label="Zoom out"
                title="Zoom out"
                onClick={() => changeActiveZoom(-0.25)}
                disabled={(splitEnabled && activePane === 'right' ? rightPaneState?.zoom ?? 1 : displayZoom) <= MIN_SCALE}
              >
                <ZoomOutRegular className="size-5" />
              </ToolbarIconButton>
              <button
                type="button"
                onClick={() => toggleToolbarMenu('zoom')}
                className={`flex h-8 min-w-20 items-center justify-center gap-1 rounded-md px-2 text-sm font-semibold transition-colors duration-150 ${
                  toolbarMenuOpen === 'zoom' ? 'bg-blue-500/15 text-blue-100' : 'text-slate-200 hover:bg-slate-800'
                }`}
                title="Zoom options"
              >
                {Math.round((splitEnabled && activePane === 'right' ? rightPaneState?.zoom ?? 1 : displayZoom) * 100)}%
                <ChevronDownRegular className="size-3.5" />
              </button>
              <ToolbarIconButton
                label="Zoom in"
                title="Zoom in"
                onClick={() => changeActiveZoom(0.25)}
                disabled={(splitEnabled && activePane === 'right' ? rightPaneState?.zoom ?? 1 : displayZoom) >= MAX_SCALE}
              >
                <ZoomInRegular className="size-5" />
              </ToolbarIconButton>
            </div>
            {toolbarMenuOpen === 'zoom' ? (
              <ToolbarMenuPanel align="left">
                {[0.5, 0.75, 1, 1.25, 1.5, 2].map((zoom) => (
                  <ToolbarMenuItem key={zoom} onClick={() => setActiveZoomPreset(zoom)} icon={<ZoomInRegular className="size-4" />}>
                    {Math.round(zoom * 100)}%
                  </ToolbarMenuItem>
                ))}
                <div className="my-1 border-t border-slate-700" />
                <ToolbarMenuItem onClick={() => {
                  fitActivePane()
                  closeToolbarMenu()
                }} icon={<ZoomFitRegular className="size-4" />}>Fit Width</ToolbarMenuItem>
                <ToolbarMenuItem onClick={() => setActiveZoomPreset(1)} icon={<DocumentPdfRegular className="size-4" />}>Actual Size</ToolbarMenuItem>
              </ToolbarMenuPanel>
            ) : null}
          </div>

          <FluentToolbarDivider />

          <div data-toolbar-menu-scope="" className="relative shrink-0">
            <ToolbarMenuButton
              active={toolbarMenuOpen === 'annotate'}
              onClick={() => toggleToolbarMenu('annotate')}
              icon={<HighlightRegular className="size-5" />}
            >
              Annotate
            </ToolbarMenuButton>
            {toolbarMenuOpen === 'annotate' ? (
              <ToolbarMenuPanel align="left">
                <ToolbarMenuItem onClick={() => {
                  if (!thumbnailSidebarOpen) void toggleSidebar()
                  setSidebarTab('highlights')
                  closeToolbarMenu()
                }} icon={<HighlightRegular className="size-4" />}>Highlights Panel</ToolbarMenuItem>
                <ToolbarMenuItem onClick={() => {
                  setExportHighlightsOpen(true)
                  closeToolbarMenu()
                }} icon={<SaveRegular className="size-4" />}>Export Highlights</ToolbarMenuItem>
                <ToolbarMenuItem disabled icon={<PenRegular className="size-4" />}>Add Note from selected highlight</ToolbarMenuItem>
              </ToolbarMenuPanel>
            ) : null}
          </div>

          <div data-toolbar-menu-scope="" className="relative shrink-0">
            <ToolbarMenuButton
              active={toolbarMenuOpen === 'fill-sign'}
              onClick={() => {
                void prepareSignatureMenu()
                toggleToolbarMenu('fill-sign')
              }}
              icon={<SignatureRegular className="size-5" />}
            >
              Fill & Sign
            </ToolbarMenuButton>
            {toolbarMenuOpen === 'fill-sign' ? (
              <ToolbarMenuPanel align="left">
                <ToolbarMenuItem disabled={!activeSignatureDocument} onClick={() => startFillSignTool('text')} icon={<TextAddTRegular className="size-4" />}>Add Text</ToolbarMenuItem>
                <ToolbarMenuItem disabled={!activeSignatureDocument} onClick={() => startFillSignTool('date')} icon={<CalendarRegular className="size-4" />}>Add Date</ToolbarMenuItem>
                <ToolbarMenuItem disabled={!activeSignatureDocument} onClick={() => startFillSignTool('initials')} icon={<TextBulletListSquareRegular className="size-4" />}>Add Initials</ToolbarMenuItem>
                <ToolbarMenuItem disabled={!activeSignatureDocument} onClick={() => startFillSignTool('checkbox')} icon={<CheckboxCheckedRegular className="size-4" />}>Add Checkbox</ToolbarMenuItem>
                <div className="my-1 border-t border-slate-700" />
                {savedSignatures.length ? savedSignatures.slice(0, 5).map((signature) => (
                  <ToolbarMenuItem key={signature.id} disabled={!activeSignatureDocument} onClick={() => {
                    chooseSignatureForPlacement(signature)
                    closeToolbarMenu()
                  }} icon={<SignatureRegular className="size-4" />} title={signature.name}>
                    <span className="block max-w-44 truncate">{signature.name}</span>
                  </ToolbarMenuItem>
                )) : (
                  <p className="px-3 py-2 text-xs text-slate-500">No saved signatures</p>
                )}
                <ToolbarMenuItem onClick={() => openPdfToolPanel('signatures')} icon={<PenRegular className="size-4" />}>Manage Signatures</ToolbarMenuItem>
                <div className="my-1 border-t border-slate-700" />
                <ToolbarMenuItem disabled={!activeSignatureDocument || (activeSignaturePlacements.length === 0 && activeFillSignFields.length === 0) || isSavingSignedCopy} onClick={() => {
                  closeToolbarMenu()
                  void saveSignedCopy()
                }} icon={<SaveRegular className="size-4" />}>Save Signed Copy</ToolbarMenuItem>
              </ToolbarMenuPanel>
            ) : null}
          </div>

          <div data-toolbar-menu-scope="" className="relative shrink-0">
            <ToolbarMenuButton
              active={toolbarMenuOpen === 'research'}
              onClick={() => toggleToolbarMenu('research')}
              icon={<BookOpenRegular className="size-5" />}
            >
              Research
            </ToolbarMenuButton>
            {toolbarMenuOpen === 'research' ? (
              <ToolbarMenuPanel align="left">
                <p className="px-3 py-1 text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">
                  {workspaceList.find((workspace) => workspace.id === activeWorkspaceId)?.name ?? 'Current Workspace'}
                </p>
                <ToolbarMenuItem onClick={() => {
                  closeToolbarMenu()
                  void openWorkspaceManager()
                }} icon={<BookOpenRegular className="size-4" />}>Workspace</ToolbarMenuItem>
                <ToolbarMenuItem onClick={() => {
                  closeToolbarMenu()
                  openReferences()
                }} icon={<TextBulletListSquareRegular className="size-4" />}>References</ToolbarMenuItem>
                <ToolbarMenuItem onClick={() => {
                  closeToolbarMenu()
                  if (globalDashboardOpen) setGlobalDashboardOpen(false)
                  else void openHighlightLibrary()
                }} icon={<HighlightRegular className="size-4" />}>Knowledge Base</ToolbarMenuItem>
                <ToolbarMenuItem onClick={() => {
                  closeToolbarMenu()
                  openGlobalSearch()
                }} icon={<SearchRegular className="size-4" />}>Global Search</ToolbarMenuItem>
              </ToolbarMenuPanel>
            ) : null}
          </div>

          <div data-toolbar-menu-scope="" className="relative shrink-0">
            <ToolbarMenuButton
              active={toolbarMenuOpen === 'pdf-tools'}
              onClick={() => toggleToolbarMenu('pdf-tools')}
              icon={<DocumentPdfRegular className="size-5" />}
            >
              PDF Tools
            </ToolbarMenuButton>
            {toolbarMenuOpen === 'pdf-tools' ? (
              <ToolbarMenuPanel align="left">
                <ToolbarMenuItem onClick={() => openPdfToolPanel('merge')} icon={<DocumentPdfRegular className="size-4" />}>Merge PDFs</ToolbarMenuItem>
                <ToolbarMenuItem onClick={() => openPdfToolPanel('images')} icon={<AddRegular className="size-4" />}>Images to PDF</ToolbarMenuItem>
                <ToolbarMenuItem onClick={() => openPdfToolPanel('signatures')} icon={<SignatureRegular className="size-4" />}>Signature Manager</ToolbarMenuItem>
                <div className="my-1 border-t border-slate-700" />
                <p className="px-3 py-1 text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">
                  OCR
                </p>
                {currentPageOcrResult ? (
                  <>
                    <p className="px-3 py-1 text-xs text-slate-400">
                      OCR already completed for this page.
                    </p>
                    <ToolbarMenuItem
                      disabled={!pdfDocument || (splitEnabled && activePane === 'right') || Boolean(ocrJob)}
                      onClick={() => void runCurrentPageOcr(true)}
                      icon={<DocumentBulletListRegular className="size-4" />}
                    >
                      Run OCR Again
                    </ToolbarMenuItem>
                  </>
                ) : currentPageTextStatus === 'searchable' ? (
                  <>
                    <p className="px-3 py-1 text-xs text-slate-400">
                      Current page already has searchable text.
                    </p>
                    <ToolbarMenuItem
                      disabled={!pdfDocument || (splitEnabled && activePane === 'right') || Boolean(ocrJob)}
                      onClick={() => void runCurrentPageOcr(true)}
                      icon={<DocumentBulletListRegular className="size-4" />}
                    >
                      Run OCR Anyway
                    </ToolbarMenuItem>
                  </>
                ) : (
                  <ToolbarMenuItem
                    disabled={!pdfDocument || (splitEnabled && activePane === 'right') || Boolean(ocrJob)}
                    onClick={() => void runCurrentPageOcr(false)}
                    icon={<DocumentBulletListRegular className="size-4" />}
                  >
                    OCR Current Page
                  </ToolbarMenuItem>
                )}
                <div className="mx-2 my-1 rounded-lg border border-slate-700 bg-slate-900 p-2">
                  <label className="block text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">
                    Selected Pages
                  </label>
                  <input
                    type="text"
                    value={ocrPageRangeInput}
                    onChange={(event) => setOcrPageRangeInput(event.target.value)}
                    placeholder="1-5,10,20-30"
                    disabled={Boolean(ocrJob)}
                    className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-slate-100 outline-none placeholder:text-slate-600 focus:border-blue-400 disabled:opacity-50"
                  />
                  <div className="mt-2 grid grid-cols-2 gap-1">
                    <button
                      type="button"
                      disabled={!pdfDocument || !ocrPageRangeInput.trim() || (splitEnabled && activePane === 'right') || Boolean(ocrJob)}
                      onClick={() => void runSelectedPagesOcr(false)}
                      className="rounded-md border border-slate-700 px-2 py-1.5 text-xs font-semibold text-slate-200 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      OCR Selected
                    </button>
                    <button
                      type="button"
                      disabled={!pdfDocument || !ocrPageRangeInput.trim() || (splitEnabled && activePane === 'right') || Boolean(ocrJob)}
                      onClick={() => void runSelectedPagesOcr(true)}
                      className="rounded-md border border-slate-700 px-2 py-1.5 text-xs font-semibold text-slate-200 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Run Again
                    </button>
                  </div>
                </div>
                <ToolbarMenuItem
                  disabled={!pdfDocument || (splitEnabled && activePane === 'right') || Boolean(ocrJob)}
                  onClick={() => void runEntireDocumentOcr(false)}
                  icon={<DocumentBulletListRegular className="size-4" />}
                >
                  OCR Entire Document
                </ToolbarMenuItem>
                <ToolbarMenuItem
                  disabled={!pdfDocument || (splitEnabled && activePane === 'right') || Boolean(ocrJob)}
                  onClick={() => void runEntireDocumentOcr(true)}
                  icon={<DocumentBulletListRegular className="size-4" />}
                >
                  Run Entire Document Again
                </ToolbarMenuItem>
                <label className="mx-2 my-1 flex items-center justify-between gap-3 rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-slate-300">
                  <span>OCR Language</span>
                  <select
                    value={ocrLanguage}
                    onChange={(event) => setOcrLanguage(event.target.value as OcrLanguage)}
                    className="max-w-28 rounded bg-slate-950 px-2 py-1 text-slate-100 outline-none"
                  >
                    {OCR_LANGUAGES.map((language) => (
                      <option key={language.code} value={language.code}>
                        {language.label}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="my-1 border-t border-slate-700" />
                <ToolbarMenuItem disabled icon={<MoreHorizontalRegular className="size-4" />}>Document Properties</ToolbarMenuItem>
                <ToolbarMenuItem disabled icon={<MoreHorizontalRegular className="size-4" />}>Repair Missing Files</ToolbarMenuItem>
              </ToolbarMenuPanel>
            ) : null}
          </div>

          <div data-toolbar-menu-scope="" className="relative shrink-0">
            <ToolbarMenuButton
              active={toolbarMenuOpen === 'view'}
              onClick={() => toggleToolbarMenu('view')}
              icon={<PanelLeftRegular className="size-5" />}
            >
              View
            </ToolbarMenuButton>
            {toolbarMenuOpen === 'view' ? (
              <ToolbarMenuPanel align="left">
                <ToolbarMenuItem disabled={!pdfDocument} onClick={() => {
                  toggleViewMode()
                  closeToolbarMenu()
                }} icon={<DocumentPdfRegular className="size-4" />}>
                  {viewMode === 'continuous' ? 'Single Page View' : 'Continuous Scroll'}
                </ToolbarMenuItem>
                <ToolbarMenuItem disabled={!pdfDocument} onClick={() => {
                  rotateActivePane(-90)
                  closeToolbarMenu()
                }} icon={<ArrowLeftRegular className="size-4" />}>Rotate Left</ToolbarMenuItem>
                <ToolbarMenuItem disabled={!pdfDocument} onClick={() => {
                  rotateActivePane(90)
                  closeToolbarMenu()
                }} icon={<ArrowRightRegular className="size-4" />}>Rotate Right</ToolbarMenuItem>
                <ToolbarMenuItem disabled={!pdfFile} onClick={() => {
                  void splitCurrentTab()
                  closeToolbarMenu()
                }} icon={<SplitHorizontalRegular className="size-4" />}>Split Current Tab</ToolbarMenuItem>
                <ToolbarMenuItem disabled={!pdfDocument} onClick={() => {
                  toggleSidebar()
                  closeToolbarMenu()
                }} icon={<PanelLeftRegular className="size-4" />}>Toggle Sidebar</ToolbarMenuItem>
              </ToolbarMenuPanel>
            ) : null}
          </div>

          <FluentToolbarDivider />

          <ToolbarIconButton
            label="Search PDF"
            title="Search PDF (Ctrl+F)"
            onClick={openActivePaneSearch}
            disabled={!activeSignatureDocument}
            active={(splitEnabled && activePane === 'right' ? rightPaneState?.searchOpen : searchOpen) === true}
          >
            <SearchRegular className="size-5" />
          </ToolbarIconButton>
          <ToolbarIconButton
            label="Toggle sidebar"
            title={thumbnailSidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
            onClick={toggleSidebar}
            disabled={!pdfDocument || splitEnabled}
            active={thumbnailSidebarOpen && Boolean(pdfDocument) && !splitEnabled}
          >
            <PanelLeftRegular className="size-5" />
          </ToolbarIconButton>

          <div data-toolbar-menu-scope="" className="relative shrink-0">
            <ToolbarIconButton
              label="Theme"
              title={`Reading background: ${VIEWER_BACKGROUND_LABELS[viewerBackground]}`}
              onClick={() => toggleToolbarMenu('theme')}
              active={toolbarMenuOpen === 'theme'}
            >
              <DarkThemeRegular className="size-5" />
            </ToolbarIconButton>
            {toolbarMenuOpen === 'theme' ? (
              <ToolbarMenuPanel align="right">
                {([
                  ['dark-gray', 'Dark Gray'],
                  ['black', 'Black'],
                  ['light-gray', 'Light Gray'],
                  ['white', 'White'],
                ] as Array<[ViewerBackground, string]>).map(([background, label]) => (
                  <ToolbarMenuItem key={background} onClick={() => {
                    changeViewerBackground(background)
                    closeToolbarMenu()
                  }} icon={<DarkThemeRegular className="size-4" />}>
                    <span className={viewerBackground === background ? 'font-bold text-blue-100' : ''}>{label}</span>
                  </ToolbarMenuItem>
                ))}
              </ToolbarMenuPanel>
            ) : null}
          </div>

          <div data-toolbar-menu-scope="" className="relative shrink-0">
            <ToolbarIconButton
              label="More"
              title="More commands"
              onClick={() => toggleToolbarMenu('more')}
              active={toolbarMenuOpen === 'more'}
            >
              <MoreHorizontalRegular className="size-5" />
            </ToolbarIconButton>
            {toolbarMenuOpen === 'more' ? (
              <ToolbarMenuPanel align="right">
                <ToolbarMenuItem disabled={!(splitEnabled && activePane === 'right' ? rightDocument?.id : activeDocumentId) || isPrinting} onClick={() => {
                  closeToolbarMenu()
                  void printCurrentPdf()
                }} icon={<PrintRegular className="size-4" />}>Print</ToolbarMenuItem>
                <ToolbarMenuItem disabled={!(splitEnabled && activePane === 'right' ? rightDocument : pdfDocument) || isExporting} onClick={() => {
                  closeToolbarMenu()
                  void exportCurrentPage('png')
                }} icon={<SaveRegular className="size-4" />}>Export Page as PNG</ToolbarMenuItem>
                <ToolbarMenuItem disabled={!(splitEnabled && activePane === 'right' ? rightDocument : pdfDocument) || isExporting} onClick={() => {
                  closeToolbarMenu()
                  void exportCurrentPage('jpeg')
                }} icon={<SaveRegular className="size-4" />}>Export Page as JPEG</ToolbarMenuItem>
                <ToolbarMenuItem onClick={() => {
                  setShortcutHelpOpen((isOpen) => !isOpen)
                  closeToolbarMenu()
                }} icon={<MoreHorizontalRegular className="size-4" />}>Keyboard Shortcuts</ToolbarMenuItem>
                <ToolbarMenuItem onClick={() => {
                  setOpeningSettingsOpen(true)
                  closeToolbarMenu()
                }} icon={<OpenFolderRegular className="size-4" />}>Opening Settings</ToolbarMenuItem>
              </ToolbarMenuPanel>
            ) : null}
          </div>

          <ToolbarIconButton
            label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
            title={isFullscreen ? 'Exit fullscreen (Esc)' : 'Fullscreen (F11)'}
            onClick={() => void (isFullscreen ? exitFullscreen() : toggleFullscreen())}
            active={isFullscreen}
          >
            {isFullscreen ? <FullScreenMinimizeRegular className="size-5" /> : <FullScreenMaximizeRegular className="size-5" />}
          </ToolbarIconButton>

          <div className="ml-auto flex h-10 min-w-0 max-w-72 shrink items-center gap-2 rounded-lg border border-transparent px-2 text-xs text-slate-400 transition-colors duration-200 hover:border-slate-700 hover:bg-slate-800/60">
            {(splitEnabled && activePane === 'right' ? rightDocument : pdfFile) ? (
              <>
                <DocumentPdfRegular className="size-4 shrink-0 text-blue-300" />
                <span title={splitEnabled && activePane === 'right' ? rightDocument?.name : pdfFile?.name} className="min-w-0 truncate font-medium text-slate-200">
                  {splitEnabled && activePane === 'right' ? rightDocument?.name : pdfFile?.name}
                </span>
                <span aria-hidden="true" className="text-slate-600">•</span>
                <span className="shrink-0">
                  {splitEnabled && activePane === 'right'
                    ? rightViewStatus.totalPages > 0 ? `${rightViewStatus.totalPages} pages` : isLoading ? 'Loading...' : ''
                    : numPages > 0 ? `${numPages} pages` : isLoading ? 'Loading...' : ''}
                </span>
              </>
            ) : (
              <span className="shrink-0">No PDF selected</span>
            )}
          </div>
        </div>

        <div className="hidden">
          <button
            type="button"
            onClick={() => void openPdf()}
            className="h-10 rounded-lg bg-blue-500 px-4 text-sm font-semibold text-white hover:bg-blue-400"
          >
            Open PDF
          </button>

          <details ref={recentFilesRef} className="relative">
            <summary className="flex h-10 cursor-pointer list-none items-center rounded-lg border border-slate-700 px-3 text-sm hover:bg-slate-800 [&::-webkit-details-marker]:hidden">
              Recent Files
            </summary>
            <div className="absolute left-0 top-12 z-20 max-h-72 w-72 overflow-auto rounded-xl border border-slate-700 bg-slate-900 p-2 shadow-2xl shadow-black/40">
              {recentFiles.length > 0 ? (
                recentFiles.map((recentFile) => (
                  <button
                    key={recentFile.id}
                    type="button"
                    title={recentFile.name}
                    onClick={() => void openRecentPdf(recentFile.id)}
                    className="block w-full truncate rounded-lg px-3 py-2 text-left text-sm text-slate-200 hover:bg-slate-800"
                  >
                    {recentFile.name}
                  </button>
                ))
              ) : (
                <p className="px-3 py-2 text-sm text-slate-400">No recent PDFs</p>
              )}
            </div>
          </details>

          <div ref={pdfToolsMenuRef} className="relative">
            <button
              type="button"
              aria-haspopup="menu"
              aria-expanded={pdfToolsMenuOpen}
              onClick={() => setPdfToolsMenuOpen((isOpen) => !isOpen)}
              className={`flex h-10 items-center gap-2 rounded-lg border px-3 text-sm font-semibold transition-colors duration-150 ${mergePdfsOpen || imagesToPdfOpen || signatureManagerOpen || pdfToolsMenuOpen ? 'border-blue-400 bg-blue-500/15 text-blue-200' : 'border-slate-700 text-slate-300 hover:bg-slate-800'}`}
            >
              <PdfToolsIcon />
              PDF Tools
              <ChevronDownIcon open={pdfToolsMenuOpen} />
            </button>
            {pdfToolsMenuOpen ? (
              <div role="menu" className="absolute left-0 top-12 z-20 w-60 rounded-xl border border-slate-700 bg-slate-900 p-2 shadow-2xl shadow-black/40">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setWorkspaceManagerOpen(false)
                    setReferencesOpen(false)
                    setGlobalDashboardOpen(false)
                    setGlobalSearchOpen(false)
                    setImagesToPdfOpen(false)
                    setSignatureManagerOpen(false)
                    setMergePdfsOpen(true)
                    setPdfToolsMenuOpen(false)
                  }}
                  className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm font-semibold text-slate-200 transition-colors duration-150 hover:bg-slate-800"
                >
                  <MergePdfIcon />
                  <span>Merge PDFs</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setWorkspaceManagerOpen(false)
                    setReferencesOpen(false)
                    setGlobalDashboardOpen(false)
                    setGlobalSearchOpen(false)
                    setMergePdfsOpen(false)
                    setSignatureManagerOpen(false)
                    setImagesToPdfOpen(true)
                    setPdfToolsMenuOpen(false)
                  }}
                  className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm font-semibold text-slate-200 transition-colors duration-150 hover:bg-slate-800"
                >
                  <ImagesToPdfIcon />
                  <span>Images to PDF</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setWorkspaceManagerOpen(false)
                    setReferencesOpen(false)
                    setGlobalDashboardOpen(false)
                    setGlobalSearchOpen(false)
                    setMergePdfsOpen(false)
                    setImagesToPdfOpen(false)
                    setSignatureManagerOpen(true)
                    setPdfToolsMenuOpen(false)
                  }}
                  className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm font-semibold text-slate-200 transition-colors duration-150 hover:bg-slate-800"
                >
                  <SignatureToolIcon />
                  <span>Signature Manager</span>
                </button>
              </div>
            ) : null}
          </div>

          <div ref={signPickerRef} data-signature-picker="" className="relative">
            <button
              type="button"
              aria-haspopup="menu"
              aria-expanded={signPickerOpen}
              title="Place saved signature"
              disabled={!(splitEnabled && activePane === 'right' ? rightDocument : pdfFile)}
              onClick={() => {
                setActiveFillSignTool(null)
                setSelectedFillSignFieldId(null)
                setSignPickerOpen((isOpen) => !isOpen)
                void refreshSavedSignatures()
              }}
              className={`flex h-10 items-center gap-2 rounded-lg border px-3 text-sm font-semibold transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40 ${
                signingSignature || signPickerOpen
                  ? 'border-blue-400 bg-blue-500/15 text-blue-200'
                  : 'border-slate-700 text-slate-300 hover:bg-slate-800'
              }`}
            >
              <SignatureToolIcon />
              Sign
            </button>
            {signPickerOpen ? (
              <div role="menu" className="absolute left-0 top-12 z-30 w-72 rounded-xl border border-slate-700 bg-slate-900 p-2 shadow-2xl shadow-black/45">
                <div className="flex items-start justify-between gap-2 px-2 py-1.5">
                  <div>
                    <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">Choose Signature</p>
                    <p className="mt-1 text-[11px] text-slate-500">Stored locally on this device.</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setSignatureManagerOpen(true)
                      setSignPickerOpen(false)
                    }}
                    className="rounded-md border border-slate-700 px-2 py-1 text-[11px] font-semibold text-slate-300 hover:bg-slate-800"
                  >
                    Manage
                  </button>
                </div>
                {signaturesLoading ? (
                  <p className="px-3 py-4 text-sm text-slate-400">Loading signatures...</p>
                ) : savedSignatures.length ? (
                  <div className="max-h-72 space-y-1 overflow-auto">
                    {savedSignatures.map((signature) => (
                      <button
                        key={signature.id}
                        type="button"
                        role="menuitem"
                        onClick={() => chooseSignatureForPlacement(signature)}
                        className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left text-sm text-slate-200 transition-colors duration-150 hover:bg-slate-800"
                      >
                        <span className="grid h-10 w-20 shrink-0 place-items-center rounded border border-slate-700 bg-white p-1">
                          <img src={signature.imageDataUrl} alt="" draggable={false} className="max-h-full max-w-full object-contain" />
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate font-semibold">{signature.name}</span>
                          <span className="text-[10px] uppercase text-slate-500">{signature.type}{signature.isDefault ? ' | Default' : ''}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="px-3 py-4 text-sm text-slate-400">
                    <p>No saved signatures.</p>
                    <button
                      type="button"
                      onClick={() => {
                        setSignatureManagerOpen(true)
                        setSignPickerOpen(false)
                      }}
                      className="mt-3 rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-semibold text-slate-200 hover:bg-slate-800"
                    >
                      Open Signature Manager
                    </button>
                  </div>
                )}
              </div>
            ) : null}
          </div>

          <div data-fill-sign-tools="" className="flex h-10 items-center gap-1 rounded-lg border border-slate-700 bg-slate-900/60 px-1">
            <button
              type="button"
              onClick={() => activateFillSignTool('text')}
              disabled={!activeSignatureDocument}
              title="Add text"
              className={fillSignToolButtonClass(activeFillSignTool === 'text')}
            >
              T
            </button>
            <button
              type="button"
              onClick={() => activateFillSignTool('date')}
              disabled={!activeSignatureDocument}
              title="Add date"
              className={fillSignToolButtonClass(activeFillSignTool === 'date')}
            >
              <CalendarIcon />
            </button>
            <button
              type="button"
              onClick={() => activateFillSignTool('initials')}
              disabled={!activeSignatureDocument}
              title="Add initials"
              className={fillSignToolButtonClass(activeFillSignTool === 'initials')}
            >
              In
            </button>
            <button
              type="button"
              onClick={() => activateFillSignTool('checkbox')}
              disabled={!activeSignatureDocument}
              title="Add checkbox"
              className={fillSignToolButtonClass(activeFillSignTool === 'checkbox')}
            >
              <CheckBoxIcon />
            </button>
            <div ref={fillSignDateMenuRef} className="relative">
              <button
                type="button"
                onClick={() => setFillSignDateMenuOpen((isOpen) => !isOpen)}
                disabled={!activeSignatureDocument}
                title={`Date format: ${fillSignDateFormat}`}
                aria-label={`Date format: ${fillSignDateFormat}`}
                className={`grid h-8 min-w-8 place-items-center rounded-md px-2 text-xs font-bold transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40 ${
                  fillSignDateMenuOpen
                    ? 'bg-cyan-500/20 text-cyan-100 ring-1 ring-cyan-400/70'
                    : 'text-slate-300 hover:bg-slate-800'
                }`}
              >
                <DateFormatIcon />
              </button>
              {fillSignDateMenuOpen ? (
                <div className="absolute right-0 top-10 z-30 w-44 rounded-xl border border-slate-700 bg-slate-900 p-1.5 shadow-2xl shadow-black/40">
                  {(['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD'] as FillSignDateFormat[]).map((format) => (
                    <button
                      key={format}
                      type="button"
                      onClick={() => {
                        setFillSignDateFormat(format)
                        setFillSignDateMenuOpen(false)
                      }}
                      className={`block w-full rounded-lg px-3 py-2 text-left text-xs font-semibold transition-colors duration-150 ${
                        fillSignDateFormat === format
                          ? 'bg-cyan-500/15 text-cyan-100'
                          : 'text-slate-300 hover:bg-slate-800'
                      }`}
                    >
                      {format}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          </div>

          <button
            type="button"
            onClick={() => void saveSignedCopy()}
            disabled={!activeSignatureDocument || (activeSignaturePlacements.length === 0 && activeFillSignFields.length === 0) || isSavingSignedCopy}
            title={
              activeSignaturePlacements.length === 0 && activeFillSignFields.length === 0
                ? 'Place a signature or Fill & Sign field before saving'
                : 'Save signed PDF copy'
            }
            className="flex h-10 items-center gap-2 rounded-lg border border-slate-700 px-3 text-sm font-semibold text-slate-300 transition-colors duration-150 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <SignedCopyIcon />
            {isSavingSignedCopy ? 'Saving...' : 'Save Signed Copy'}
          </button>

          <button
            type="button"
            onClick={() => void openWorkspaceManager()}
            className={`flex h-10 items-center gap-2 rounded-lg border px-3 text-sm font-semibold ${
              workspaceManagerOpen
                ? 'border-blue-400 bg-blue-500/15 text-blue-200'
                : 'border-slate-700 text-slate-300 hover:bg-slate-800'
            }`}
            title="Open workspace manager"
          >
            <WorkspaceIcon />
            <span className="max-w-40 truncate">{workspaceList.find((workspace) => workspace.id === activeWorkspaceId)?.name ?? 'Workspaces'}</span>
          </button>

          <button
            type="button"
            onClick={openReferences}
            className={`flex h-10 items-center gap-2 rounded-lg border px-3 text-sm font-semibold ${referencesOpen ? 'border-cyan-400 bg-cyan-500/15 text-cyan-200' : 'border-slate-700 text-slate-300 hover:bg-slate-800'}`}
            title="Open citation and reference manager"
          >
            <ReferencesIcon />
            References
          </button>

          <button
            type="button"
            onClick={() => {
              setWorkspaceManagerOpen(false)
              setReferencesOpen(false)
              setMergePdfsOpen(false)
              setImagesToPdfOpen(false)
              setSignatureManagerOpen(false)
              if (globalDashboardOpen) setGlobalDashboardOpen(false)
              else void openHighlightLibrary()
            }}
            className={`flex h-10 items-center gap-2 rounded-lg border px-3 text-sm font-semibold ${
              globalDashboardOpen
                ? 'border-blue-400 bg-blue-500/15 text-blue-200'
                : 'border-slate-700 text-slate-300 hover:bg-slate-800'
            }`}
            title="Open the global highlights knowledge base"
          >
            <HighlightsIcon />
            Knowledge Base
          </button>

          <button
            type="button"
            onClick={() => {
              setWorkspaceManagerOpen(false)
              setReferencesOpen(false)
              setGlobalDashboardOpen(false)
              setMergePdfsOpen(false)
              setImagesToPdfOpen(false)
              setSignatureManagerOpen(false)
              setGlobalSearchReturnToDashboard(false)
              setGlobalSearchOpen((open) => !open)
            }}
            className={`grid size-10 place-items-center rounded-lg border ${
              globalSearchOpen
                ? 'border-blue-400 bg-blue-500/15 text-blue-200'
                : 'border-slate-700 text-slate-300 hover:bg-slate-800'
            }`}
            aria-label="Search all PDFs"
            title="Search all PDFs (Ctrl+Shift+F)"
          >
            <GlobalSearchIcon />
          </button>

          <button
            type="button"
            aria-label="Print PDF"
            title={`Print ${splitEnabled ? `${activePane === 'right' ? 'Right' : 'Left'} Pane` : 'PDF'} (Ctrl+P)`}
            onClick={() => void printCurrentPdf()}
            disabled={!(splitEnabled && activePane === 'right' ? rightDocument?.id : activeDocumentId) || isPrinting}
            className="grid size-10 place-items-center rounded-lg border border-slate-700 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <PrintIcon />
          </button>

          <div className="relative">
            <button
              type="button"
              aria-label="Export current page"
              title={`Export current page from ${splitEnabled ? `${activePane === 'right' ? 'Right' : 'Left'} Pane` : 'PDF'}`}
              aria-expanded={exportMenuOpen}
              onClick={() => setExportMenuOpen((isOpen) => !isOpen)}
              disabled={!(splitEnabled && activePane === 'right' ? rightDocument : pdfDocument) || isExporting}
              className={`grid size-10 place-items-center rounded-lg border disabled:cursor-not-allowed disabled:opacity-40 ${
                exportMenuOpen
                  ? 'border-blue-400 bg-blue-500/15 text-blue-200'
                  : 'border-slate-700 hover:bg-slate-800'
              }`}
            >
              <ExportIcon />
            </button>

            {exportMenuOpen ? (
              <div className="absolute left-0 top-12 z-30 w-44 rounded-xl border border-slate-700 bg-slate-900 p-2 shadow-2xl shadow-black/50">
                <button
                  type="button"
                  onClick={() => void exportCurrentPage('png')}
                  className="block w-full rounded-lg px-3 py-2 text-left text-sm text-slate-200 hover:bg-slate-800"
                >
                  Export as PNG
                </button>
                <button
                  type="button"
                  onClick={openReferences}
                  className={`group/sidebar-tab relative mb-1 flex w-full items-center justify-center rounded-xl border border-transparent font-semibold text-slate-400 transition-all duration-200 hover:border-cyan-400/50 hover:bg-cyan-500/15 hover:text-cyan-100 ${thumbnailSidebarOpen ? 'gap-2 px-3 py-2.5 text-xs' : 'size-10'}`}
                  title="References"
                >
                  <ReferencesIcon />
                  {thumbnailSidebarOpen ? <span>References</span> : <span className="sr-only">References</span>}
                </button>
                <button
                  type="button"
                  onClick={() => void exportCurrentPage('jpeg')}
                  className="block w-full rounded-lg px-3 py-2 text-left text-sm text-slate-200 hover:bg-slate-800"
                >
                  Export as JPEG
                </button>
              </div>
            ) : null}
          </div>

          <ToolbarDivider />

          <div className="relative">
            <button
              type="button"
              aria-label="Split view"
              title="Split View (Ctrl+\\)"
              aria-expanded={splitMenuOpen}
              onClick={() => setSplitMenuOpen((open) => !open)}
              disabled={!pdfFile}
              className={`grid size-10 place-items-center rounded-lg border disabled:cursor-not-allowed disabled:opacity-40 ${
                splitEnabled
                  ? 'border-blue-400 bg-blue-500/15 text-blue-200'
                  : 'border-slate-700 hover:bg-slate-800'
              }`}
            >
              <SplitViewIcon />
            </button>
            {splitMenuOpen ? (
              <div className="absolute right-0 top-12 z-40 w-56 rounded-xl border border-slate-700 bg-slate-900 p-2 shadow-2xl shadow-black/50">
                <TabMenuButton onClick={() => void splitCurrentTab()}>Split Current Tab</TabMenuButton>
                <TabMenuButton onClick={() => {
                  const tabId = activePane === 'right' ? rightTabId : leftTabId
                  if (tabId) void openTabInRightPane(tabId)
                  setSplitMenuOpen(false)
                }}>Open Tab In Right Pane</TabMenuButton>
                <TabMenuButton onClick={() => {
                  const tabId = activePane === 'right' ? rightTabId : leftTabId
                  if (tabId) openTabInLeftPane(tabId)
                }}>Open Tab In Left Pane</TabMenuButton>
                <div className="my-1 border-t border-slate-700" />
                <TabMenuButton onClick={closeSplitView}>Close Split View</TabMenuButton>
              </div>
            ) : null}
          </div>

          {splitEnabled ? (
            <span className="flex h-10 items-center rounded-lg border border-blue-400/40 bg-blue-500/10 px-3 text-xs font-semibold text-blue-200">
              Target: {activePane === 'right' ? 'Right Pane' : 'Left Pane'}
            </span>
          ) : null}

          {!splitEnabled ? <>
          <button
            type="button"
            aria-label="Previous page"
            title="Previous page (PageUp)"
            onClick={() => goToActivePage('previous')}
            disabled={splitEnabled && activePane === 'right' ? (rightPaneState?.page ?? 1) === 1 : numPages === 0 || currentPage === 1}
            className="grid size-10 place-items-center rounded-lg border border-slate-700 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <PreviousPageIcon />
          </button>

          <label className="flex h-10 items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900/70 px-2 text-sm text-slate-300">
            <span className="sr-only">Current page</span>
            <span className="text-xs text-slate-400">Page</span>
            <input
              type="number"
              min="1"
              max={Math.max(1, numPages)}
              value={splitEnabled && activePane === 'right' ? String(rightPaneState?.page ?? 1) : pageInput}
              disabled={numPages === 0 || (splitEnabled && activePane === 'right')}
              onFocus={() => {
                pageInputFocusedRef.current = true
              }}
              onChange={(event) => setPageInput(event.target.value)}
              onBlur={() => {
                pageInputFocusedRef.current = false
                submitPageInput()
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.currentTarget.blur()
                }
              }}
              className="w-12 rounded border border-slate-600 bg-slate-950 px-1.5 py-1 text-center text-slate-100 outline-none focus:border-blue-400 disabled:opacity-40"
            />
            <span className="whitespace-nowrap text-xs text-slate-400">of {splitEnabled && activePane === 'right' ? '—' : numPages || 0}</span>
          </label>

          <button
            type="button"
            aria-label="Next page"
            title="Next page (PageDown)"
            onClick={() => goToActivePage('next')}
            disabled={splitEnabled && activePane === 'right' ? false : numPages === 0 || currentPage === numPages}
            className="grid size-10 place-items-center rounded-lg border border-slate-700 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <NextPageIcon />
          </button>

          <ToolbarDivider />

          <button
            type="button"
            aria-label="Zoom out"
            title="Zoom out"
            onClick={() => changeActiveZoom(-0.25)}
            disabled={(splitEnabled && activePane === 'right' ? rightPaneState?.zoom ?? 1 : displayZoom) <= MIN_SCALE}
            className="grid size-10 place-items-center rounded-lg border border-slate-700 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ZoomOutIcon />
          </button>

          <span className="flex h-10 min-w-16 items-center justify-center text-center text-sm">
            {Math.round((splitEnabled && activePane === 'right' ? rightPaneState?.zoom ?? 1 : displayZoom) * 100)}%
          </span>

          <button
            type="button"
            aria-label="Zoom in"
            title="Zoom in"
            onClick={() => changeActiveZoom(0.25)}
            disabled={(splitEnabled && activePane === 'right' ? rightPaneState?.zoom ?? 1 : displayZoom) >= MAX_SCALE}
            className="grid size-10 place-items-center rounded-lg border border-slate-700 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ZoomInIcon />
          </button>

          <ToolbarDivider />

          <button
            type="button"
            aria-label="Fit width"
            title="Fit width"
            onClick={fitActivePane}
            disabled={!pdfFile}
            className={`grid size-10 place-items-center rounded-lg border disabled:cursor-not-allowed disabled:opacity-40 ${
              (splitEnabled && activePane === 'right' ? rightPaneState?.fitMode : zoomMode === 'fit-width')
                ? 'border-blue-400 bg-blue-500/15 text-blue-200'
                : 'border-slate-700 hover:bg-slate-800'
            }`}
          >
            <FitWidthIcon />
          </button>

          <button
            type="button"
            aria-label={
              viewMode === 'continuous' ? 'Switch to single page view' : 'Switch to continuous scroll'
            }
            title={
              viewMode === 'continuous' ? 'Single Page View' : 'Continuous Scroll'
            }
            onClick={toggleViewMode}
            disabled={!pdfDocument}
            className="grid size-10 place-items-center rounded-lg border border-slate-700 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {viewMode === 'continuous' ? <SinglePageIcon /> : <ContinuousScrollIcon />}
          </button>
          </> : null}

          <ToolbarDivider />

          <label
            title="Reading background"
            className="flex h-10 items-center gap-2 rounded-lg border border-slate-700 bg-slate-900 px-2 text-slate-300 focus-within:border-blue-400"
          >
            <BackgroundIcon />
            <span className="sr-only">Reading background</span>
            <select
              value={viewerBackground}
              onChange={(event) => changeViewerBackground(event.target.value as ViewerBackground)}
              className="viewer-background-select max-w-24 rounded bg-slate-950 px-2 py-1 text-xs text-slate-100 outline-none"
            >
              <option value="dark-gray">Dark Gray</option>
              <option value="black">Black</option>
              <option value="light-gray">Light Gray</option>
              <option value="white">White</option>
            </select>
          </label>

          {!splitEnabled ? <>
          <ToolbarDivider />

          <button
            type="button"
            aria-label="Rotate left"
            title="Rotate left"
            onClick={() => rotateActivePane(-90)}
            disabled={!pdfDocument}
            className="grid size-10 place-items-center rounded-lg border border-slate-700 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <RotateLeftIcon />
          </button>

          <button
            type="button"
            aria-label="Rotate right"
            title="Rotate right"
            onClick={() => rotateActivePane(90)}
            disabled={!pdfDocument}
            className="grid size-10 place-items-center rounded-lg border border-slate-700 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <RotateRightIcon />
          </button>

          <ToolbarDivider />

          <button
            type="button"
            aria-label="Search PDF"
            title="Search PDF (Ctrl+F)"
            onClick={openActivePaneSearch}
            disabled={!pdfDocument}
            className={`grid size-10 place-items-center rounded-lg border disabled:cursor-not-allowed disabled:opacity-40 ${
              (splitEnabled && activePane === 'right' ? rightPaneState?.searchOpen : searchOpen)
                ? 'border-blue-400 bg-blue-500/15 text-blue-200'
                : 'border-slate-700 hover:bg-slate-800'
            }`}
          >
            <SearchIcon />
          </button>

          <ToolbarDivider />
          </> : null}

          {!splitEnabled ? <button
            type="button"
            aria-label="Toggle sidebar"
            title={thumbnailSidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
            onClick={toggleSidebar}
            disabled={!pdfDocument}
            className={`grid size-10 place-items-center rounded-lg border disabled:cursor-not-allowed disabled:opacity-40 ${
              thumbnailSidebarOpen && pdfDocument
                ? 'border-blue-400 bg-blue-500/15 text-blue-200'
                : 'border-slate-700 hover:bg-slate-800'
            }`}
          >
            <ThumbnailsIcon />
          </button> : null}

          <button
            type="button"
            aria-label="Keyboard shortcuts"
            title="Keyboard shortcuts"
            aria-expanded={shortcutHelpOpen}
            onClick={() => setShortcutHelpOpen((isOpen) => !isOpen)}
            className={`grid size-10 place-items-center rounded-lg border ${
              shortcutHelpOpen
                ? 'border-blue-400 bg-blue-500/15 text-blue-200'
                : 'border-slate-700 hover:bg-slate-800'
            }`}
          >
            <HelpIcon />
          </button>

          <button
            type="button"
            aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
            title={isFullscreen ? 'Exit fullscreen (Esc)' : 'Fullscreen (F11)'}
            onClick={() => void (isFullscreen ? exitFullscreen() : toggleFullscreen())}
            className={`grid size-10 place-items-center rounded-lg border ${
              isFullscreen
                ? 'border-blue-400 bg-blue-500/15 text-blue-200'
                : 'border-slate-700 hover:bg-slate-800'
            }`}
          >
            {isFullscreen ? <ExitFullscreenIcon /> : <FullscreenIcon />}
          </button>

          <div className="ml-auto flex h-10 min-w-0 max-w-80 items-center gap-2 rounded-lg border border-transparent px-2 text-xs text-slate-400 transition-colors duration-200 hover:border-slate-700 hover:bg-slate-800/60">
            {(splitEnabled && activePane === 'right' ? rightDocument : pdfFile) ? (
              <>
                <FileIcon />
                <span title={splitEnabled && activePane === 'right' ? rightDocument?.name : pdfFile?.name} className="min-w-0 truncate font-medium text-slate-200">
                  {splitEnabled && activePane === 'right' ? rightDocument?.name : pdfFile?.name}
                </span>
                <span aria-hidden="true" className="text-slate-600">•</span>
                <span className="shrink-0">
                  {splitEnabled && activePane === 'right'
                    ? rightViewStatus.totalPages > 0 ? `${rightViewStatus.totalPages} pages` : isLoading ? 'Loading...' : ''
                    : numPages > 0 ? `${numPages} pages` : isLoading ? 'Loading...' : ''}
                </span>
              </>
            ) : (
              'No PDF selected'
            )}
          </div>
        </div>

        <div className="mt-2 flex min-w-0 items-end border-t border-slate-700/70 pt-2">
          <div
            role="tablist"
            aria-label="Open PDF documents"
            className="flex min-w-0 flex-1 items-end gap-1 overflow-x-auto [scrollbar-width:thin]"
          >
            {tabs.map((tab) => {
              const assignedLeft = tab.tabId === leftTabId
              const assignedRight = splitEnabled && tab.tabId === rightTabId
              const active = activePane === 'right' ? assignedRight : assignedLeft
              return (
                <div
                  key={tab.tabId}
                  role="tab"
                  aria-selected={active}
                  draggable
                  onDragStart={(event) => {
                    draggedTabIdRef.current = tab.tabId
                    setDraggedTabId(tab.tabId)
                    event.dataTransfer.effectAllowed = 'move'
                    event.dataTransfer.setData('application/x-next-pdf-tab', tab.tabId)
                  }}
                  onDragEnd={() => {
                    draggedTabIdRef.current = null
                    setDraggedTabId(null)
                    setTabDropTargetId(null)
                  }}
                  onDragEnter={() => {
                    if (draggedTabIdRef.current && draggedTabIdRef.current !== tab.tabId) {
                      setTabDropTargetId(tab.tabId)
                    }
                  }}
                  onDragOver={(event) => {
                    if (draggedTabIdRef.current) {
                      event.preventDefault()
                      event.dataTransfer.dropEffect = 'move'
                    }
                  }}
                  onDrop={(event) => {
                    const draggedTabId = event.dataTransfer.getData('application/x-next-pdf-tab')
                    if (draggedTabId) {
                      event.preventDefault()
                      reorderTab(draggedTabId, tab.tabId)
                      setDraggedTabId(null)
                      setTabDropTargetId(null)
                    }
                  }}
                  onAuxClick={(event) => {
                    if (event.button === 1) {
                      event.preventDefault()
                      void closeTab(tab.tabId)
                    }
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault()
                    setTabContextMenu({ tabId: tab.tabId, x: event.clientX, y: event.clientY })
                  }}
                  className={`group relative flex h-9 min-w-36 max-w-60 shrink-0 items-center overflow-hidden rounded-t-lg border border-b-0 transition-all duration-150 ${
                    draggedTabId === tab.tabId ? 'scale-[0.98] opacity-55' : ''
                  } ${
                    tabDropTargetId === tab.tabId ? 'ring-1 ring-inset ring-blue-400/80' : ''
                  } ${
                    active
                      ? 'border-slate-600 bg-slate-800 text-slate-50 shadow-[inset_0_2px_0_#3b82f6]'
                      : 'border-transparent bg-slate-900/45 text-slate-400 hover:bg-slate-800/70 hover:text-slate-200'
                  }`}
                >
                  <button
                    type="button"
                    title={tab.name}
                    onClick={() => activateTabForPane(tab.tabId)}
                    className="flex h-full min-w-0 flex-1 items-center gap-2 px-3 text-left text-xs font-medium"
                  >
                    <FileIcon />
                    <span className="truncate">{tab.name}</span>
                    {assignedLeft ? <span className="rounded bg-slate-700 px-1 text-[9px] text-slate-300">L</span> : null}
                    {assignedRight ? <span className="rounded bg-blue-500/25 px-1 text-[9px] text-blue-200">R</span> : null}
                  </button>
                  <button
                    type="button"
                    aria-label={`Close ${tab.name}`}
                    title={`Close ${tab.name}`}
                    onClick={() => void closeTab(tab.tabId)}
                    className="mr-1 grid size-7 shrink-0 place-items-center rounded-md text-base text-slate-500 opacity-60 transition hover:bg-slate-700 hover:text-white group-hover:opacity-100"
                  >
                    &times;
                  </button>
                </div>
              )
            })}
          </div>
          <button
            type="button"
            aria-label="Open PDF in new tab"
            title="Open PDF in new tab (Ctrl+O)"
            onClick={() => void openPdf()}
            className="ml-1 grid size-9 shrink-0 place-items-center rounded-lg text-xl text-slate-400 transition-colors duration-150 hover:bg-slate-800 hover:text-white"
          >
            +
          </button>
        </div>

        {shortcutHelpOpen ? (
          <div data-shortcut-help-panel="" className="absolute right-5 top-full z-30 mt-2 w-80 rounded-xl border border-slate-700 bg-slate-900 p-4 shadow-2xl shadow-black/50">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-100">Keyboard Shortcuts</h2>
              <button
                type="button"
                aria-label="Close keyboard shortcuts"
                onClick={() => setShortcutHelpOpen(false)}
                className="grid size-7 place-items-center rounded text-lg text-slate-400 hover:bg-slate-800 hover:text-white"
              >
                &times;
              </button>
            </div>
            <dl className="space-y-2">
              {KEYBOARD_SHORTCUTS.map(([shortcut, action]) => (
                <div key={shortcut} className="flex items-center justify-between gap-4 text-sm">
                  <dt>
                    <kbd className="rounded border border-slate-700 bg-slate-950 px-2 py-1 font-mono text-xs text-slate-200">
                      {shortcut}
                    </kbd>
                  </dt>
                  <dd className="text-right text-slate-400">{action}</dd>
                </div>
              ))}
            </dl>
          </div>
        ) : null}

        {searchOpen ? (
          <div className="mt-2 flex w-full flex-wrap items-center gap-2 border-t border-slate-700/70 pt-2">
            <label className="min-w-60 flex-1">
              <span className="sr-only">Search PDF text</span>
              <input
                ref={searchInputRef}
                type="search"
                value={searchQuery}
                placeholder="Search in document"
                onChange={(event) => {
                  const query = event.target.value
                  setSearchQuery(query)
                  if (splitEnabled && searchBothPanes) {
                    rightPaneRef.current?.search(query)
                  }
                  setSearchMatches([])
                  setSelectedMatchIndex(-1)
                  setIsSearching(query.trim().length > 0)
                  setSearchProgress(null)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    selectSearchMatch(event.shiftKey ? -1 : 1)
                  } else if (event.key === 'Escape') {
                    closeSearch()
                  }
                }}
                className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none placeholder:text-slate-500 focus:border-blue-400"
              />
            </label>

            {splitEnabled ? (
              <label className="flex h-9 items-center gap-2 rounded-lg border border-slate-700 bg-slate-900 px-2 text-xs text-slate-300">
                <span>Search</span>
                <select
                  value={searchBothPanes ? 'both' : 'current'}
                  onChange={(event) => {
                    const searchBoth = event.target.value === 'both'
                    setSearchBothPanes(searchBoth)
                    if (searchBoth) rightPaneRef.current?.search(searchQuery)
                  }}
                  className="rounded bg-slate-950 px-2 py-1 outline-none"
                >
                  <option value="current">Left Pane</option>
                  <option value="both">Both Panes</option>
                </select>
              </label>
            ) : null}

            <span className="min-w-24 text-center text-sm text-slate-300" aria-live="polite">
              {isSearching
                ? searchProgress
                  ? `Searching page ${searchProgress.processed} of ${searchProgress.total}...`
                  : 'Searching...'
                : searchQuery.trim() && searchMatches.length === 0
                  ? 'No results'
                  : searchMatches.length > 0
                    ? `Match ${selectedMatchIndex + 1} of ${searchMatches.length}${searchMatchSourceLabel(searchMatches[selectedMatchIndex])}`
                    : ''}
            </span>
            {splitEnabled && searchBothPanes ? (
              <span className="rounded-lg bg-slate-900 px-2 py-2 text-xs text-slate-400">
                Right Pane: {rightSearchStatus.total > 0 ? `Match ${rightSearchStatus.current} of ${rightSearchStatus.total}` : rightSearchStatus.query ? 'No results' : 'Ready'}
              </span>
            ) : null}

            <div className="flex h-10 items-center gap-1 rounded-lg border border-slate-700 px-2">
              <span className="mr-1 text-xs text-slate-400">Highlight</span>
              {HIGHLIGHT_COLOR_ORDER.map((color) => (
                <button
                  key={color}
                  type="button"
                  aria-label={`Highlight selected search match ${HIGHLIGHT_COLOR_LABELS[color]}`}
                  title={`Highlight match ${HIGHLIGHT_COLOR_LABELS[color]}`}
                  disabled={selectedMatchIndex < 0 || isSearching}
                  onClick={() => highlightSelectedSearchMatch(color)}
                  className="grid size-7 place-items-center rounded hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-35"
                >
                  <span className={`size-4 rounded-full ${highlightColorClass(color)}`} />
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={() => selectSearchMatch(-1)}
              disabled={searchMatches.length === 0 || isSearching}
              className="rounded-lg border border-slate-700 px-3 py-2 text-sm hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Previous Match
            </button>
            <button
              type="button"
              onClick={() => selectSearchMatch(1)}
              disabled={searchMatches.length === 0 || isSearching}
              className="rounded-lg border border-slate-700 px-3 py-2 text-sm hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Next Match
            </button>
            <button
              type="button"
              aria-label="Close search"
              title="Close search"
              onClick={closeSearch}
              className="grid size-10 shrink-0 place-items-center rounded-lg border border-slate-700 text-xl hover:bg-slate-800"
            >
              &times;
            </button>
          </div>
        ) : null}
      </header>

      <section className="w-full px-3 pb-12 pt-4 sm:px-4">
        {errorMessage ? (
          <div className="mb-3 rounded-xl border border-red-500/40 bg-red-950/60 px-4 py-3 text-red-100 shadow-lg shadow-red-950/20">
            {errorMessage}
          </div>
        ) : null}
        {signingSignature ? (
          <div className="mb-3 flex items-center justify-between gap-3 rounded-xl border border-amber-400/40 bg-amber-950/35 px-4 py-3 text-sm font-semibold text-amber-100 shadow-lg shadow-amber-950/15">
            <span>Click anywhere on the PDF to place your signature</span>
            <button type="button" onClick={() => setSigningSignature(null)} className="rounded-lg border border-amber-300/40 px-3 py-1 text-xs hover:bg-amber-500/15">
              Cancel
            </button>
          </div>
        ) : null}
        {activeFillSignTool ? (
          <div className="mb-3 flex items-center justify-between gap-3 rounded-xl border border-cyan-400/40 bg-cyan-950/35 px-4 py-3 text-sm font-semibold text-cyan-100 shadow-lg shadow-cyan-950/15">
            <span>Click anywhere on the PDF to place {fillSignToolLabel(activeFillSignTool)}</span>
            <button type="button" onClick={() => setActiveFillSignTool(null)} className="rounded-lg border border-cyan-300/40 px-3 py-1 text-xs hover:bg-cyan-500/15">
              Cancel
            </button>
          </div>
        ) : null}
        {loadingProgress ? (
          <div
            role="status"
            className="mb-3 flex items-center justify-between gap-3 rounded-xl border border-blue-500/30 bg-blue-950/35 px-4 py-3 text-sm text-blue-100"
          >
            <div className="flex min-w-0 items-center gap-3">
              <span className="size-4 shrink-0 animate-spin rounded-full border-2 border-blue-300/30 border-t-blue-300" />
              <div className="min-w-0">
                <p className="font-medium">
                  {ocrJob
                    ? `${ocrJob.status} (${Math.round(ocrJob.progress * 100)}%)`
                    : loadingProgress}
                </p>
                {ocrJob ? (
                  <p className="mt-0.5 text-xs text-blue-200/75">
                    {ocrJob.completedPages} / {ocrJob.totalPages} completed
                    {ocrJob.failedPages > 0 ? ` | ${ocrJob.failedPages} failed` : ''}
                    {ocrJob.estimatedRemainingMs ? ` | ETA ${formatDurationLong(ocrJob.estimatedRemainingMs)}` : ''}
                    {ocrJob.paused ? ' | Paused' : ''}
                  </p>
                ) : null}
                {numPages >= 200 && !ocrJob ? (
                  <p className="mt-0.5 text-xs text-blue-200/70">
                    Large document mode is rendering only pages near the viewport.
                  </p>
                ) : null}
              </div>
            </div>
            {ocrJob ? (
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={toggleOcrPause}
                  className="rounded-lg border border-blue-300/40 px-3 py-1 text-xs font-semibold text-blue-100 hover:bg-blue-500/15"
                >
                  {ocrJob.paused ? 'Resume' : 'Pause'}
                </button>
                <button
                  type="button"
                  onClick={() => void cancelCurrentPageOcr()}
                  className="rounded-lg border border-blue-300/40 px-3 py-1 text-xs font-semibold text-blue-100 hover:bg-blue-500/15"
                >
                  Cancel
                </button>
              </div>
            ) : null}
          </div>
        ) : null}

        {globalDashboardOpen ? (
          <GlobalHighlightsDashboard
            library={highlightLibrary}
            loading={highlightLibraryLoading}
            error={highlightLibraryError}
            onClose={() => setGlobalDashboardOpen(false)}
            onOpenSearch={openGlobalSearch}
            onRefresh={() => void refreshHighlightLibrary()}
            onOpen={(entry) => void openLibraryHighlight(entry)}
            onUpdate={updateLibraryHighlights}
            onDelete={deleteLibraryHighlights}
            onExport={exportLibraryHighlights}
            onFilteredCountChange={handleLibraryFilteredCountChange}
          />
        ) : null}

        {globalSearchOpen ? (
          <GlobalSearchPanel
            onClose={closeGlobalSearch}
            onOpenResult={(result, query) => void openGlobalSearchResult(result, query)}
            onStatusChange={handleGlobalSearchStatusChange}
          />
        ) : null}

        {referencesOpen ? (
          <ReferenceDashboard
            onClose={() => setReferencesOpen(false)}
            onOpenDocument={(documentId) => {
              setReferencesOpen(false)
              void openWorkspaceDocument(documentId)
            }}
            onOpenHighlight={(highlight) => {
              setReferencesOpen(false)
              void openWorkspaceDocument(highlight.documentId, { highlight })
            }}
            onStatusChange={setReferenceStatus}
          />
        ) : null}

        {mergePdfsOpen ? (
          <MergePdfsPanel
            onClose={() => setMergePdfsOpen(false)}
            onOpenPdf={(opened) => {
              setMergePdfsOpen(false)
              openResultInTab(opened)
            }}
            onRefreshRecent={refreshRecentFiles}
          />
        ) : null}

        {imagesToPdfOpen ? (
          <ImagesToPdfPanel
            onClose={() => setImagesToPdfOpen(false)}
            onOpenPdf={(opened) => {
              setImagesToPdfOpen(false)
              openResultInTab(opened)
            }}
            onRefreshRecent={refreshRecentFiles}
          />
        ) : null}

        {signatureManagerOpen ? (
          <SignatureManagerPanel onClose={() => setSignatureManagerOpen(false)} />
        ) : null}

        {workspaceManagerOpen ? (
          <WorkspaceManager
            workspaces={workspaceList}
            activeWorkspaceId={activeWorkspaceId}
            details={workspaceDetails}
            loading={workspaceLoading}
            error={workspaceError}
            onClose={() => setWorkspaceManagerOpen(false)}
            onSelect={(id) => void refreshWorkspaceManager(id)}
            onActivate={switchToWorkspace}
            onRefresh={refreshWorkspaceManager}
            onDelete={deleteWorkspace}
            onOpenDocument={(id, options) => void openWorkspaceDocument(id, { ...options, workspaceId: workspaceDetails?.id })}
            onAddDocument={() => {
              setWorkspaceManagerOpen(false)
              void openPdf()
            }}
            onImport={importWorkspace}
          />
        ) : null}

        <div ref={splitContainerRef} className={`${globalDashboardOpen || globalSearchOpen || workspaceManagerOpen || referencesOpen || mergePdfsOpen || imagesToPdfOpen || signatureManagerOpen ? 'hidden' : 'flex'} min-w-0 items-start gap-2`}>
          {pdfDocument && pdfFile ? (
            <aside
              className={`relative sticky flex shrink-0 flex-col rounded-2xl border border-slate-700 bg-[#111827] shadow-xl shadow-slate-950/20 ${
                sidebarResizing ? '' : 'transition-[width] duration-200 ease-out'
              }`}
              style={{
                top: headerHeight + 16,
                height: `calc(100vh - ${headerHeight + 60}px)`,
                width: thumbnailSidebarOpen ? sidebarWidth : 56,
              }}
            >
              <button
                type="button"
                aria-label={thumbnailSidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
                title={thumbnailSidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
                onClick={toggleSidebar}
                className="absolute -right-3 top-4 z-20 grid size-7 place-items-center rounded-full border border-slate-600 bg-slate-800 text-slate-300 shadow-lg transition-colors duration-200 hover:border-blue-400 hover:bg-slate-700 hover:text-white"
              >
                <SidebarToggleIcon expanded={thumbnailSidebarOpen} />
              </button>

              <div className="border-b border-slate-700/80 p-2">
                <button
                  type="button"
                  onClick={() => void openWorkspaceManager()}
                  className={`group/sidebar-tab relative mb-1 flex w-full items-center justify-center rounded-xl border border-transparent font-semibold text-slate-400 transition-all duration-200 hover:border-blue-400/50 hover:bg-blue-500/15 hover:text-blue-100 ${
                    thumbnailSidebarOpen ? 'gap-2 px-3 py-2.5 text-xs' : 'size-10'
                  }`}
                  title="Workspaces"
                >
                  <WorkspaceIcon />
                  {thumbnailSidebarOpen ? <span>Workspaces</span> : <span className="sr-only">Workspaces</span>}
                </button>
                <button
                  type="button"
                  onClick={() => void openHighlightLibrary()}
                  className={`group/sidebar-tab relative flex w-full items-center justify-center rounded-xl border border-transparent font-semibold text-slate-400 transition-all duration-200 hover:border-blue-400/50 hover:bg-blue-500/15 hover:text-blue-100 ${
                    thumbnailSidebarOpen ? 'gap-2 px-3 py-2.5 text-xs' : 'size-10'
                  }`}
                  title="All Highlights"
                >
                  <HighlightsIcon />
                  {thumbnailSidebarOpen ? <span>All Highlights</span> : <span className="sr-only">All Highlights</span>}
                </button>
              </div>

              <div
                role="tablist"
                aria-label="Sidebar sections"
                className={`border-b border-slate-700/80 bg-slate-950/20 ${
                  thumbnailSidebarOpen ? 'grid grid-cols-2 gap-2 p-3' : 'flex flex-col gap-2 p-2 pt-12'
                }`}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={sidebarTab === 'thumbnails'}
                  onClick={() => selectSidebarTab('thumbnails')}
                  className={`group/sidebar-tab relative flex min-w-0 items-center justify-center rounded-xl border font-semibold transition-all duration-200 ${
                    thumbnailSidebarOpen ? 'flex-col gap-1.5 px-2 py-3 text-[11px]' : 'size-10 self-center'
                  } ${
                    sidebarTab === 'thumbnails'
                      ? 'border-blue-300 bg-blue-500/30 text-white ring-1 ring-blue-400/50 shadow-[0_0_20px_rgba(59,130,246,0.28)]'
                      : 'border-transparent text-slate-400 hover:border-slate-600 hover:bg-slate-800 hover:text-slate-100'
                  }`}
                >
                  <ThumbnailsIcon />
                  {thumbnailSidebarOpen ? <span>Thumbnails</span> : <span className="sr-only">Thumbnails</span>}
                  {!thumbnailSidebarOpen ? (
                    <span aria-hidden="true" className="pointer-events-none absolute left-full z-40 ml-3 whitespace-nowrap rounded-lg border border-slate-600 bg-slate-800 px-2.5 py-1.5 text-xs font-medium text-slate-100 opacity-0 shadow-xl transition-opacity duration-150 group-hover/sidebar-tab:opacity-100">
                      Thumbnails
                    </span>
                  ) : null}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={sidebarTab === 'highlights'}
                  onClick={() => selectSidebarTab('highlights')}
                  className={`group/sidebar-tab relative flex min-w-0 items-center justify-center rounded-xl border font-semibold transition-all duration-200 ${
                    thumbnailSidebarOpen ? 'flex-col gap-1.5 px-2 py-3 text-[11px]' : 'size-10 self-center'
                  } ${
                    sidebarTab === 'highlights'
                      ? 'border-blue-300 bg-blue-500/30 text-white ring-1 ring-blue-400/50 shadow-[0_0_20px_rgba(59,130,246,0.28)]'
                      : 'border-transparent text-slate-400 hover:border-slate-600 hover:bg-slate-800 hover:text-slate-100'
                  }`}
                >
                  <HighlightsIcon />
                  {thumbnailSidebarOpen ? <span>Highlights</span> : <span className="sr-only">Highlights</span>}
                  {!thumbnailSidebarOpen ? (
                    <span aria-hidden="true" className="pointer-events-none absolute left-full z-40 ml-3 whitespace-nowrap rounded-lg border border-slate-600 bg-slate-800 px-2.5 py-1.5 text-xs font-medium text-slate-100 opacity-0 shadow-xl transition-opacity duration-150 group-hover/sidebar-tab:opacity-100">
                      Highlights
                    </span>
                  ) : null}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={sidebarTab === 'bookmarks'}
                  onClick={() => selectSidebarTab('bookmarks')}
                  className={`group/sidebar-tab relative flex min-w-0 items-center justify-center rounded-xl border font-semibold transition-all duration-200 ${
                    thumbnailSidebarOpen ? 'flex-col gap-1.5 px-2 py-3 text-[11px]' : 'size-10 self-center'
                  } ${
                    sidebarTab === 'bookmarks'
                      ? 'border-blue-300 bg-blue-500/30 text-white ring-1 ring-blue-400/50 shadow-[0_0_20px_rgba(59,130,246,0.28)]'
                      : 'border-transparent text-slate-400 hover:border-slate-600 hover:bg-slate-800 hover:text-slate-100'
                  }`}
                >
                  <BookmarkIcon />
                  {thumbnailSidebarOpen ? <span>Bookmarks</span> : <span className="sr-only">Bookmarks</span>}
                  {!thumbnailSidebarOpen ? (
                    <span aria-hidden="true" className="pointer-events-none absolute left-full z-40 ml-3 whitespace-nowrap rounded-lg border border-slate-600 bg-slate-800 px-2.5 py-1.5 text-xs font-medium text-slate-100 opacity-0 shadow-xl transition-opacity duration-150 group-hover/sidebar-tab:opacity-100">
                      Bookmarks
                    </span>
                  ) : null}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={sidebarTab === 'info'}
                  onClick={() => selectSidebarTab('info')}
                  className={`group/sidebar-tab relative flex min-w-0 items-center justify-center rounded-xl border font-semibold transition-all duration-200 ${
                    thumbnailSidebarOpen ? 'flex-col gap-1.5 px-2 py-3 text-[11px]' : 'size-10 self-center'
                  } ${
                    sidebarTab === 'info'
                      ? 'border-blue-300 bg-blue-500/30 text-white ring-1 ring-blue-400/50 shadow-[0_0_20px_rgba(59,130,246,0.28)]'
                      : 'border-transparent text-slate-400 hover:border-slate-600 hover:bg-slate-800 hover:text-slate-100'
                  }`}
                >
                  <InfoIcon />
                  {thumbnailSidebarOpen ? <span>Document Info</span> : <span className="sr-only">Document Info</span>}
                  {!thumbnailSidebarOpen ? (
                    <span aria-hidden="true" className="pointer-events-none absolute left-full z-40 ml-3 whitespace-nowrap rounded-lg border border-slate-600 bg-slate-800 px-2.5 py-1.5 text-xs font-medium text-slate-100 opacity-0 shadow-xl transition-opacity duration-150 group-hover/sidebar-tab:opacity-100">
                      Document Info
                    </span>
                  ) : null}
                </button>
              </div>
              {thumbnailSidebarOpen && sidebarTab === 'thumbnails' ? (
                <div ref={thumbnailListRef} className="min-h-0 flex-1 overflow-y-auto p-3">
                  {Array.from({ length: numPages }, (_, index) => (
                    <LazyThumbnail
                      key={`thumbnail-${index + 1}`}
                      pdf={pdfDocument}
                      pageNumber={index + 1}
                      active={currentPage === index + 1}
                      visible={visibleThumbnailPages.has(index + 1)}
                      rotation={rotation}
                      width={Math.min(240, sidebarWidth - 48)}
                      onNavigate={goToPage}
                    />
                  ))}
                </div>
              ) : thumbnailSidebarOpen && sidebarTab === 'bookmarks' ? (
                <div className="min-h-0 flex-1 overflow-y-auto p-3">
                  {outlineLoading ? (
                    <p className="px-3 py-6 text-center text-sm text-slate-400">
                      Loading bookmarks...
                    </p>
                  ) : outline.length > 0 ? (
                    <BookmarkTree items={outline} onNavigate={navigateToBookmark} />
                  ) : (
                    <p className="px-3 py-6 text-center text-sm text-slate-400">
                      No bookmarks available
                    </p>
                  )}
                </div>
              ) : thumbnailSidebarOpen && sidebarTab === 'highlights' ? (
                <HighlightsPanel
                  highlights={sidebarHighlights}
                  documentSelected={Boolean(sidebarDocument)}
                  onNavigate={navigateSidebarHighlight}
                  onRemove={removeHighlight}
                  onContextMenu={showHighlightContextMenu}
                  editingNoteId={editingNoteId}
                  selectedHighlightIds={selectedHighlightIds}
                  onEditNote={startEditingNote}
                  onSaveNote={saveHighlightNote}
                  onFinishNote={() => setEditingNoteId(null)}
                  onToggleSelected={toggleHighlightSelected}
                  onExport={() => setExportHighlightsOpen(true)}
                />
              ) : thumbnailSidebarOpen ? (
                <DocumentInfoPanel
                  file={pdfFile}
                  totalPages={numPages}
                  metadata={documentMetadata}
                  loading={metadataLoading}
                  ocrDetection={ocrDetection}
                  ocrTextPages={ocrTextPageCount}
                  lowConfidenceOcrPages={lowConfidenceOcrPageCount}
                />
              ) : null}

              {thumbnailSidebarOpen ? (
                <div
                  role="separator"
                  aria-label="Resize sidebar"
                  aria-orientation="vertical"
                  onPointerDown={startSidebarResize}
                  className="group absolute inset-y-0 -right-1.5 z-10 w-3 cursor-col-resize"
                >
                  <span className="absolute inset-y-20 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors duration-200 group-hover:bg-blue-400/70" />
                </div>
              ) : null}
            </aside>
          ) : null}

          <div
            ref={leftPaneContainerRef}
            data-pane="left"
            data-pane-tab-id={leftPane.tabId ?? ''}
            data-pane-document-id={leftPane.documentId ?? ''}
            onPointerDown={() => focusPane('left')}
            onDragOver={(event) => {
              if (event.dataTransfer.types.includes('application/x-next-pdf-tab')) {
                event.preventDefault()
                event.dataTransfer.dropEffect = 'move'
              }
            }}
            onDrop={(event) => {
              const tabId = event.dataTransfer.getData('application/x-next-pdf-tab')
              if (tabId) {
                event.preventDefault()
                openTabInLeftPane(tabId)
              }
            }}
            className={`min-w-0 ${splitEnabled ? 'shrink basis-0 rounded-xl border' : 'flex-1'} ${
              splitEnabled && activePane === 'left'
                ? 'border-blue-400/90 ring-2 ring-blue-400/25'
                : splitEnabled
                  ? 'border-slate-700/90'
                  : ''
            } ${splitResizing ? '' : 'transition-[flex-grow] duration-200'}`}
            style={splitEnabled ? { flexGrow: splitRatio } : undefined}
          >
            {splitEnabled ? (
              <PdfPaneHeader
                active={activePane === 'left'}
                paneLabel="Left Pane"
                fileName={pdfFile?.name}
                currentPage={currentPage}
                totalPages={numPages || 0}
                zoomPercent={Math.round(displayZoom * 100)}
              />
            ) : null}
            {splitEnabled && pdfFile ? (
              <PdfPaneToolbar
                active={activePane === 'left'}
                currentPage={currentPage}
                totalPages={numPages}
                pageInput={pageInput}
                zoomPercent={Math.round(displayZoom * 100)}
                fitActive={zoomMode === 'fit-width'}
                searchActive={searchOpen}
                panelsActive={thumbnailSidebarOpen}
                onPageInputChange={setPageInput}
                onPageSubmit={submitPageInput}
                onPreviousPage={() => goToPage(currentPage - 1)}
                onNextPage={() => goToPage(currentPage + 1)}
                onZoomOut={() => changeZoom(displayZoomRef.current - 0.1)}
                onResetZoom={() => changeZoom(1)}
                onZoomIn={() => changeZoom(displayZoomRef.current + 0.1)}
                onFitWidth={fitWidth}
                onRotateLeft={() => rotatePages(-90)}
                onRotateRight={() => rotatePages(90)}
                onSearch={() => setSearchOpen((open) => !open)}
                onTogglePanels={toggleSidebar}
              />
            ) : null}
            {!pdfFile ? (
              <div className="mx-auto mt-8 w-full max-w-3xl rounded-3xl border border-slate-700 bg-gradient-to-br from-slate-900 to-slate-950 px-6 py-12 text-center shadow-2xl shadow-slate-950/30 sm:px-12">
                <div className="mx-auto grid size-16 place-items-center rounded-2xl bg-blue-500/15 text-blue-300">
                  <FileIcon />
                </div>
                <h1 className="mt-5 text-2xl font-semibold tracking-tight text-white">Open a PDF workspace</h1>
                <p className="mx-auto mt-2 max-w-lg text-sm leading-6 text-slate-400">
                  Open a document, choose a recent file, or drag and drop a PDF anywhere in this window.
                </p>
                <button
                  type="button"
                  onClick={() => void openPdf()}
                  className="mt-6 h-11 rounded-xl bg-blue-500 px-6 text-sm font-semibold text-white shadow-lg shadow-blue-950/30 transition hover:bg-blue-400"
                >
                  Open PDF
                </button>
                <button
                  type="button"
                  onClick={() => void openWorkspaceManager()}
                  className="ml-2 mt-6 h-11 rounded-xl border border-slate-700 px-5 text-sm font-semibold text-slate-200 transition hover:bg-slate-800"
                >
                  Create or Open Workspace
                </button>
                <button type="button" onClick={openReferences} className="ml-2 mt-6 h-11 rounded-xl border border-cyan-700/70 px-5 text-sm font-semibold text-cyan-200 transition hover:bg-cyan-950/40">Reference Library</button>
                {workspaceList.length > 0 ? (
                  <div className="mx-auto mt-8 max-w-xl border-t border-slate-800 pt-6 text-left">
                    <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Recent Workspaces</h2>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {workspaceList.slice(0, 4).map((workspace) => (
                        <button key={workspace.id} type="button" onClick={() => workspace.id === activeWorkspaceId ? void openWorkspaceManager() : void switchToWorkspace(workspace.id)} className="flex min-w-0 items-center gap-2 rounded-xl border border-slate-800 bg-slate-900/70 px-3 py-3 text-left text-sm text-slate-300 transition hover:border-slate-600 hover:bg-slate-800">
                          <span className="size-2.5 shrink-0 rounded-full" style={{ background: workspace.color }} /><span className="truncate">{workspace.name}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
                {recentFiles.length > 0 ? (
                  <div className="mx-auto mt-8 max-w-xl border-t border-slate-800 pt-6 text-left">
                    <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Recent Files</h2>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {recentFiles.slice(0, 6).map((recentFile) => (
                        <button
                          key={recentFile.id}
                          type="button"
                          title={recentFile.name}
                          onClick={() => void openRecentPdf(recentFile.id)}
                          className="flex min-w-0 items-center gap-2 rounded-xl border border-slate-800 bg-slate-900/70 px-3 py-3 text-left text-sm text-slate-300 transition hover:border-slate-600 hover:bg-slate-800"
                        >
                          <FileIcon />
                          <span className="truncate">{recentFile.name}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
                <p className="mt-7 text-xs text-slate-600">Drag &amp; Drop PDF Here</p>
              </div>
            ) : (
              <div
                className="overflow-auto rounded-xl p-3 shadow-inner shadow-black/20 transition-colors duration-200 sm:p-4"
                style={{ backgroundColor: VIEWER_BACKGROUNDS[viewerBackground] }}
              >
                <div ref={viewerRef} tabIndex={-1} className="min-w-0 outline-none">
                  <Document
                    key={`${leftPane.tabId ?? 'left'}:${leftPane.documentId ?? pdfFile.id}`}
                    file={pdfFile.dataUrl}
                    loading={<StatusMessage>Loading PDF...</StatusMessage>}
                    error={<StatusMessage>PDF failed to load.</StatusMessage>}
                    onLoadSuccess={(loadedDocument) => {
                      console.info(
                        `PDF load time: ${formatDuration(performance.now() - documentLoadStartedRef.current)} (${loadedDocument.numPages} pages)`,
                      )
                      const loadedPages = loadedDocument.numPages
                      const restoredPage = Math.min(
                        loadedPages,
                        Math.max(1, pendingRestorePageRef.current ?? 1),
                      )
                      pdfDocumentRef.current = loadedDocument
                      setPdfDocument(loadedDocument)
                      void loadReferencePageDimensions(loadedDocument, rotation)
                      pendingRestorePageRef.current = restoredPage
                      currentPageRef.current = restoredPage
                      setCurrentPage(restoredPage)
                      setPageInput(String(restoredPage))
                      setRenderedPageNumbers(
                        createPageRenderSet(
                          new Set([restoredPage]),
                          restoredPage,
                          loadedPages,
                          PAGE_RENDER_OVERSCAN,
                        ),
                      )
                      setNumPages(loadedPages)
                      setLoadingProgress(
                        `Rendering page ${restoredPage} of ${loadedPages}...`,
                      )
                      setErrorMessage(null)
                      void logMemoryUsage('PDF document parsed')
                    }}
                    onLoadError={(error) => {
                      pdfDocumentRef.current = null
                      pendingRestorePageRef.current = null
                      restoringReadingStateRef.current = false
                      setIsRestoring(false)
                      setIsLoading(false)
                      setLoadingProgress(null)
                      setErrorMessage(getErrorMessage(error))
                    }}
                    onSourceError={(error) => {
                      pdfDocumentRef.current = null
                      pendingRestorePageRef.current = null
                      restoringReadingStateRef.current = false
                      setIsRestoring(false)
                      setIsLoading(false)
                      setLoadingProgress(null)
                      setErrorMessage(getErrorMessage(error))
                    }}
                  >
                    <div className="flex min-w-full flex-col gap-3">
                      {(viewMode === 'single'
                        ? [currentPage]
                        : Array.from({ length: numPages }, (_, index) => index + 1)
                      ).map((pageNumber) => {
                        const shouldRender =
                          viewMode === 'single' || renderedPageNumbers.has(pageNumber)
                        const pageHighlights =
                          highlightsByPage.get(pageNumber) ?? EMPTY_HIGHLIGHTS
                        const pageSignaturePlacements =
                          signaturePlacementsByPage.get(pageNumber) ?? []
                        const pageFillSignFields =
                          fillSignFieldsByPage.get(pageNumber) ?? []
                        const pageFocusedHighlightId = pageHighlights.some(
                          (highlight) => highlight.id === focusedHighlightId,
                        )
                          ? focusedHighlightId
                          : null
                        return (
                          <div
                            key={`page-${pageNumber}`}
                            ref={(element) => {
                              if (element) {
                                pageRefs.current.set(pageNumber, element)
                              } else {
                                pageRefs.current.delete(pageNumber)
                              }
                            }}
                            data-page-number={pageNumber}
                            data-viewer-page=""
                            onContextMenu={(event) => openHighlightContextMenu(event, pageNumber)}
                            className="flex w-max min-w-full justify-center scroll-mt-24"
                            style={{ minHeight: estimatedPageHeight * displayZoom }}
                          >
                            <div
                              className={`relative ${isZooming ? 'transition-transform duration-100 ease-out' : ''}`}
                              style={{
                                minWidth: estimatedPageWidth * renderZoom,
                                minHeight: estimatedPageHeight * renderZoom,
                                transform: `scale(${zoomPreviewScale})`,
                                transformOrigin: 'top center',
                              }}
                            >
                              <div
                                data-zoom-snapshot=""
                                className="pointer-events-none absolute inset-0 z-20 overflow-hidden"
                              />
                              <HighlightOverlay
                                highlights={pageHighlights}
                                rotation={rotation}
                                focusedHighlightId={pageFocusedHighlightId}
                              />
                              <SignaturePlacementOverlay
                                pageNumber={pageNumber}
                                pageRotation={rotation}
                                placements={pageSignaturePlacements}
                                signatures={savedSignatures}
                                signingSignature={
                                  (!splitEnabled || activePane === 'left') ? signingSignature : null
                                }
                                selectedPlacementId={
                                  (!splitEnabled || activePane === 'left') ? selectedSignaturePlacementId : null
                                }
                                onPlace={addLeftSignaturePlacement}
                                onSelect={setSelectedSignaturePlacementId}
                                onUpdate={updateLeftSignaturePlacement}
                                onDelete={deleteLeftSignaturePlacement}
                                onDuplicate={duplicateLeftSignaturePlacement}
                                onBringForward={bringLeftSignatureForward}
                                onSendBackward={sendLeftSignatureBackward}
                                onFinishSigning={() => setSigningSignature(null)}
                              />
                              <FillSignOverlay
                                pageNumber={pageNumber}
                                pageRotation={rotation}
                                fields={pageFillSignFields}
                                activeTool={(!splitEnabled || activePane === 'left') ? activeFillSignTool : null}
                                selectedFieldId={(!splitEnabled || activePane === 'left') ? selectedFillSignFieldId : null}
                                dateFormat={fillSignDateFormat}
                                initials={defaultInitials}
                                onPlace={addLeftFillSignField}
                                onSelect={setSelectedFillSignFieldId}
                                onUpdate={updateLeftFillSignField}
                                onDelete={deleteLeftFillSignField}
                                onDuplicate={duplicateLeftFillSignField}
                                onFinishTool={() => setActiveFillSignTool(null)}
                              />
                              {shouldRender ? (
                                <RotatedPage
                                  pageNumber={pageNumber}
                                  scale={renderZoom}
                                  rotation={rotation}
                                  customTextRenderer={
                                    searchMatches.length > 0 ? renderSearchText : undefined
                                  }
                                  onPageLoad={
                                    viewMode === 'single' || pageNumber === 1
                                      ? (page: PDFPageProxy) => {
                                          firstPageProxyRef.current = page
                                          const viewport = page.getViewport({
                                            scale: 1,
                                            rotation: normalizeRotation(page.rotate + rotation),
                                          })
                                          setFirstPageWidth(viewport.width)
                                          setFirstPageHeight(viewport.height)
                                        }
                                      : undefined
                                  }
                                  onPageRender={handlePageRendered}
                                />
                              ) : (
                                <PagePlaceholder
                                  pageNumber={pageNumber}
                                  width={estimatedPageWidth * renderZoom}
                                  height={estimatedPageHeight * renderZoom}
                                />
                              )}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </Document>
                </div>
              </div>
            )}
          </div>

          {splitEnabled ? (
            <>
              <div
                role="separator"
                aria-label="Resize split panes"
                aria-orientation="vertical"
                aria-valuemin={25}
                aria-valuemax={75}
                aria-valuenow={Math.round(splitRatio * 100)}
                onPointerDown={startSplitResize}
                className={`group sticky z-20 h-[calc(100vh-5rem)] w-2 shrink-0 cursor-col-resize rounded-full transition-colors ${
                  splitResizing ? 'bg-blue-400/35' : 'bg-slate-800 hover:bg-blue-400/25'
                }`}
                style={{ top: headerHeight + 16 }}
              >
                <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-slate-600 group-hover:bg-blue-300" />
              </div>
              <div
                data-pane="right"
                data-pane-tab-id={rightPane.tabId ?? ''}
                data-pane-document-id={rightPane.documentId ?? ''}
                className={`sticky min-w-0 shrink basis-0 ${splitResizing ? '' : 'transition-[flex-grow] duration-200'}`}
                style={{
                  top: headerHeight + 16,
                  height: `calc(100vh - ${headerHeight + 60}px)`,
                  flexGrow: 1 - splitRatio,
                }}
              >
                {rightDocument && rightPaneState && rightDocument.id === rightPane.documentId ? (
                <SplitDocumentPane
                  key={`${rightPane.id}:${rightPane.tabId ?? 'empty'}:${rightPane.documentId ?? rightDocument.id}`}
                  ref={rightPaneRef}
                  paneLabel="Right Pane"
                  document={rightDocument}
                  initialState={rightPaneState}
                  active={activePane === 'right'}
                  viewerBackground={VIEWER_BACKGROUNDS[viewerBackground]}
                  onActivate={() => focusPane('right')}
                  onCloseSplit={closeSplitView}
                  onDropTab={(tabId) => void openTabInRightPane(tabId)}
                  onStateChange={updateRightTabState}
                  onHighlightsChange={handleSplitHighlightsChange}
                  signatures={savedSignatures}
                  signingSignature={activePane === 'right' ? signingSignature : null}
                  selectedSignaturePlacementId={activePane === 'right' ? selectedSignaturePlacementId : null}
                  onSignaturePlacementsChange={updateRightSignaturePlacements}
                  onSignaturePlacementSelect={setSelectedSignaturePlacementId}
                  activeFillSignTool={activePane === 'right' ? activeFillSignTool : null}
                  selectedFillSignFieldId={activePane === 'right' ? selectedFillSignFieldId : null}
                  fillSignDateFormat={fillSignDateFormat}
                  fillSignInitials={defaultInitials}
                  onFillSignFieldsChange={updateRightFillSignFields}
                  onFillSignFieldSelect={setSelectedFillSignFieldId}
                  onFinishFillSignTool={() => setActiveFillSignTool(null)}
                  onFinishSigning={() => setSigningSignature(null)}
                  onSearchStatus={setRightSearchStatus}
                  onViewStatus={setRightViewStatus}
                  onScrollPosition={applyRightScrollToLeft}
                />
                ) : (
                  <section
                    tabIndex={-1}
                    onPointerDown={() => focusPane('right')}
                    className={`flex h-full flex-col overflow-hidden rounded-xl border bg-slate-900 outline-none ${
                      activePane === 'right'
                        ? 'border-blue-400/90 ring-2 ring-blue-400/25'
                        : 'border-slate-700/90'
                    }`}
                  >
                    <PdfPaneHeader
                      active={activePane === 'right'}
                      paneLabel="Right Pane"
                      onClose={closeSplitView}
                    />
                    <div className="grid min-h-0 flex-1 place-items-center p-6 text-center" style={{ backgroundColor: VIEWER_BACKGROUNDS[viewerBackground] }}>
                      <div className="w-full max-w-sm rounded-2xl border border-dashed border-slate-600 bg-slate-900/80 p-6">
                        <FileIcon />
                        <h2 className="mt-3 font-semibold text-white">Open PDF in this pane</h2>
                        <p className="mt-1 text-xs text-slate-400">Drag a PDF here or choose a recent file.</p>
                        <button type="button" onClick={() => void openPdf('right')} className="mt-4 rounded-lg bg-blue-500 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-400">Open PDF</button>
                        {recentFiles.length ? (
                          <div className="mt-4 space-y-1 border-t border-slate-700 pt-3 text-left">
                            {recentFiles.slice(0, 4).map((recentFile) => (
                              <button key={recentFile.id} type="button" title={recentFile.name} onClick={() => void openRecentPdf(recentFile.id, 'right')} className="block w-full truncate rounded-lg px-2 py-1.5 text-xs text-slate-300 hover:bg-slate-800">
                                {recentFile.name}
                              </button>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </section>
                )}
              </div>
            </>
          ) : null}
        </div>
      </section>

      <footer
        role="status"
        aria-live="polite"
        className="fixed inset-x-0 bottom-0 z-40 flex h-8 items-center justify-end gap-1 border-t border-slate-700 bg-[#111827]/98 px-3 text-[11px] font-medium text-slate-300 shadow-[0_-4px_14px_rgba(2,6,23,0.18)] backdrop-blur sm:px-4"
      >
        {referencesOpen ? (
          <>
            <StatusItem>References: {referenceStatus.references}</StatusItem>
            <StatusDivider />
            <StatusItem>Filtered: {referenceStatus.filtered}</StatusItem>
            <StatusDivider />
            <StatusItem>Workspace: {workspaceList.find((workspace) => workspace.id === activeWorkspaceId)?.name ?? 'My Research'}</StatusItem>
          </>
        ) : workspaceManagerOpen && workspaceDetails ? (
          <>
            <StatusItem>Workspace: {workspaceDetails.name}</StatusItem>
            <StatusDivider />
            <StatusItem>Documents: {workspaceDetails.stats.documents}</StatusItem>
            <StatusDivider />
            <StatusItem>Highlights: {workspaceDetails.stats.highlights}</StatusItem>
          </>
        ) : globalSearchOpen ? (
          <>
            <StatusItem>Results: {globalSearchStatus.total}</StatusItem>
            <StatusDivider />
            <StatusItem>Highlights: {globalSearchStatus.counts.highlights}</StatusItem>
            <StatusDivider />
            <StatusItem>Notes: {globalSearchStatus.counts.notes}</StatusItem>
            <StatusDivider />
            <StatusItem>PDFs: {globalSearchStatus.counts.documents}</StatusItem>
          </>
        ) : globalDashboardOpen ? (
          <>
            <StatusItem>Highlights: {highlightLibrary.stats.totalHighlights}</StatusItem>
            <StatusDivider />
            <StatusItem>PDFs: {highlightLibrary.stats.totalDocuments}</StatusItem>
            <StatusDivider />
            <StatusItem>Filtered: {highlightLibraryFilteredCount}</StatusItem>
          </>
        ) : pdfFile || (splitEnabled && rightDocument) ? (
          <>
            <StatusItem>Workspace: {workspaceList.find((workspace) => workspace.id === activeWorkspaceId)?.name ?? 'My Research'}</StatusItem>
            <StatusDivider />
            {splitEnabled ? (
              <>
                <StatusItem>{activePane === 'right' ? 'Right Pane' : 'Left Pane'}</StatusItem>
                <StatusDivider />
              </>
            ) : null}
            {(activePane === 'left' && !pdfFile) || (splitEnabled && activePane === 'right' && !rightPaneState) ? (
              <StatusItem>No document</StatusItem>
            ) : (
              <>
                <StatusItem>Page {splitEnabled && activePane === 'right' ? rightViewStatus.page : currentPage} of {splitEnabled && activePane === 'right' ? rightViewStatus.totalPages : numPages || 0}</StatusItem>
                <StatusDivider />
                <StatusItem>{Math.round((splitEnabled && activePane === 'right' ? rightViewStatus.zoom : displayZoom) * 100)}%</StatusItem>
                <StatusDivider />
                <StatusItem>{splitEnabled && activePane === 'right' ? (rightViewStatus.fitMode ? 'Fit Width' : 'Manual Zoom') : zoomMode === 'fit-width' ? 'Fit Width' : 'Manual Zoom'}</StatusItem>
              </>
            )}
            <StatusDivider />
            <StatusItem>{VIEWER_BACKGROUND_LABELS[viewerBackground]}</StatusItem>
            {(!splitEnabled || activePane === 'left') && pdfFile ? (
              <>
                <StatusDivider />
                <StatusItem>{ocrTextPagesStatus(ocrDetection, ocrTextPageCount, lowConfidenceOcrPageCount)}</StatusItem>
              </>
            ) : null}
            {(splitEnabled && activePane === 'right' ? rightPaneState?.searchOpen : searchOpen) ? (
              <>
                <StatusDivider />
                <StatusItem>
                  {splitEnabled && activePane === 'right'
                    ? rightSearchStatus.total > 0
                      ? `Match ${rightSearchStatus.current} of ${rightSearchStatus.total}`
                      : rightSearchStatus.query
                        ? 'No results'
                        : 'Search active'
                    : isSearching
                      ? searchProgress
                        ? `Searching ${searchProgress.processed} of ${searchProgress.total}`
                        : 'Searching...'
                      : searchMatches.length > 0
                        ? `Match ${selectedMatchIndex + 1} of ${searchMatches.length}${searchMatchSourceLabel(searchMatches[selectedMatchIndex])}`
                        : searchQuery.trim()
                          ? 'No results'
                          : 'Search active'}
                </StatusItem>
              </>
            ) : null}
            {searchIndexProgress ? (
              <>
                <StatusDivider />
                <StatusItem>Indexing {searchIndexProgress.indexed} of {searchIndexProgress.total}</StatusItem>
              </>
            ) : null}
            {ocrJob ? (
              <>
                <StatusDivider />
                <StatusItem>OCR {ocrJob.completedPages}/{ocrJob.totalPages} | {ocrJob.failedPages} failed | {Math.round(ocrJob.progress * 100)}%</StatusItem>
              </>
            ) : null}
          </>
        ) : (
          <>
            <StatusItem>Workspace: {workspaceList.find((workspace) => workspace.id === activeWorkspaceId)?.name ?? 'My Research'}</StatusItem>
            <StatusDivider />
            <StatusItem>No PDF open</StatusItem>
          </>
        )}
      </footer>
    </main>
  )
}

function createTabState(
  readingState: OpenedPdf['readingState'],
  sidebar: { sidebarOpen: boolean; sidebarTab: SidebarTab; sidebarWidth: number },
): PdfTabState {
  return {
    page: Math.max(1, readingState.page),
    pageOffset: 0,
    zoom: clampScale(readingState.zoom),
    fitMode: readingState.fitMode,
    rotation: normalizeRotation(readingState.rotation),
    searchOpen: false,
    searchQuery: '',
    selectedMatchIndex: -1,
    ...sidebar,
  }
}

function getSidebarDocumentContext({
  splitEnabled,
  activePane,
  leftDocument,
  leftHighlights,
  leftPane,
  rightPane,
  rightDocument,
}: {
  splitEnabled: boolean
  activePane: PaneSide
  leftDocument: PdfFile | null
  leftHighlights: PdfHighlight[]
  leftPane: PaneAssignment
  rightPane: PaneAssignment
  rightDocument: SplitPaneDocument | null
}) {
  const paneId: PaneSide = splitEnabled ? activePane : 'left'
  const pane = paneId === 'right' ? rightPane : leftPane
  const document = paneId === 'right' ? rightDocument : leftDocument
  return {
    paneId,
    tabId: pane.tabId,
    document,
    documentId: document?.id ?? null,
    filePath: document?.filePath ?? null,
    fileName: document?.name ?? null,
    highlights: paneId === 'right'
      ? rightDocument?.highlights ?? EMPTY_HIGHLIGHTS
      : leftHighlights,
  }
}

function emptyPane(side: PaneSide): PaneAssignment {
  return {
    id: side,
    tabId: null,
    documentId: null,
    fileName: null,
    state: null,
  }
}

function toSplitPaneState(state: PdfTabState): SplitPaneState {
  return {
    page: state.page,
    pageOffset: state.pageOffset,
    zoom: state.zoom,
    fitMode: state.fitMode,
    rotation: state.rotation,
    searchOpen: state.searchOpen,
    searchQuery: state.searchQuery,
    selectedMatchIndex: state.selectedMatchIndex,
    sidebarOpen: state.sidebarOpen,
    sidebarTab:
      state.sidebarTab === 'bookmarks'
        ? 'bookmarks'
        : state.sidebarTab === 'highlights'
          ? 'highlights'
          : 'pages',
    sidebarWidth: Math.min(320, Math.max(180, state.sidebarWidth)),
  }
}

function fromSplitPaneState(state: SplitPaneState, previous: PdfTabState): PdfTabState {
  return {
    page: state.page,
    pageOffset: state.pageOffset,
    zoom: state.zoom,
    fitMode: state.fitMode,
    rotation: state.rotation,
    searchOpen: state.searchOpen,
    searchQuery: state.searchQuery,
    selectedMatchIndex: state.selectedMatchIndex,
    sidebarOpen: state.sidebarOpen,
    sidebarTab:
      state.sidebarTab === 'bookmarks'
        ? 'bookmarks'
        : state.sidebarTab === 'highlights'
          ? 'highlights'
          : previous.sidebarTab === 'info'
            ? 'info'
            : 'thumbnails',
    sidebarWidth: Math.min(400, Math.max(220, state.sidebarWidth)),
  }
}

function tabStatesEqual(left: PdfTabState, right: PdfTabState) {
  return (
    left.page === right.page &&
    Math.abs(left.pageOffset - right.pageOffset) < 0.001 &&
    Math.abs(left.zoom - right.zoom) < 0.001 &&
    left.fitMode === right.fitMode &&
    left.rotation === right.rotation &&
    left.searchOpen === right.searchOpen &&
    left.searchQuery === right.searchQuery &&
    left.selectedMatchIndex === right.selectedMatchIndex &&
    left.sidebarOpen === right.sidebarOpen &&
    left.sidebarTab === right.sidebarTab &&
    left.sidebarWidth === right.sidebarWidth
  )
}

function createTabId() {
  return window.crypto.randomUUID()
}

function duplicateFillSignField(field: FillSignField): FillSignField {
  const width = field.widthRatio ?? field.width
  const height = field.heightRatio ?? field.height
  const x = Math.min(1 - width, (field.xRatio ?? field.x) + 0.03)
  const y = Math.min(1 - height, (field.yRatio ?? field.y) + 0.03)
  return {
    ...field,
    id: window.crypto.randomUUID(),
    x,
    y,
    xRatio: x,
    yRatio: y,
    width,
    height,
    widthRatio: width,
    heightRatio: height,
    createdAt: new Date().toISOString(),
  }
}

function initialsFromSignatures(signatures: SavedSignature[]) {
  const preferred = signatures.find((signature) => signature.isDefault) ?? signatures[0]
  const name = preferred?.name?.replace(/\.(png|jpe?g|webp)$/i, '').trim() ?? ''
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3)
    .map((part) => part[0]?.toUpperCase())
    .join('')
  return initials || 'Initials'
}

function fillSignToolLabel(tool: FillSignTool) {
  if (tool === 'date') return 'a date'
  if (tool === 'initials') return 'initials'
  if (tool === 'checkbox') return 'a checkbox'
  return 'text'
}

function fillSignToolButtonClass(active: boolean) {
  return `grid h-8 min-w-8 place-items-center rounded-md px-2 text-xs font-bold transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40 ${
    active
      ? 'bg-cyan-500/20 text-cyan-100 ring-1 ring-cyan-400/70'
      : 'text-slate-300 hover:bg-slate-800'
  }`
}

function isEditableKeyboardTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}

function ToolbarCommandButton({
  children,
  active = false,
  disabled = false,
  title,
  onClick,
}: {
  children: React.ReactNode
  active?: boolean
  disabled?: boolean
  title?: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`flex h-10 items-center gap-2 rounded-lg border px-3 text-sm font-semibold transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40 ${
        active
          ? 'border-blue-400 bg-blue-500/15 text-blue-100 shadow-[inset_0_1px_0_rgba(96,165,250,0.35)]'
          : 'border-slate-700/90 bg-slate-900/35 text-slate-200 hover:border-slate-600 hover:bg-slate-800'
      }`}
    >
      {children}
    </button>
  )
}

function ToolbarMenuButton({
  children,
  icon,
  active = false,
  disabled = false,
  onClick,
}: {
  children: React.ReactNode
  icon: React.ReactNode
  active?: boolean
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-expanded={active}
      disabled={disabled}
      onClick={onClick}
      className={`flex h-10 items-center gap-2 rounded-lg border px-3 text-sm font-semibold transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40 ${
        active
          ? 'border-blue-400 bg-blue-500/15 text-blue-100'
          : 'border-slate-700/90 bg-slate-900/35 text-slate-300 hover:border-slate-600 hover:bg-slate-800 hover:text-white'
      }`}
    >
      {icon}
      <span className="hidden whitespace-nowrap xl:inline">{children}</span>
      <ChevronDownRegular className="size-3.5 shrink-0 opacity-75" />
    </button>
  )
}

function ToolbarIconButton({
  children,
  label,
  title,
  active = false,
  disabled = false,
  onClick,
}: {
  children: React.ReactNode
  label: string
  title?: string
  active?: boolean
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={title ?? label}
      disabled={disabled}
      onClick={onClick}
      className={`grid size-9 shrink-0 place-items-center rounded-md transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40 ${
        active
          ? 'bg-blue-500/15 text-blue-100 ring-1 ring-blue-400/50'
          : 'text-slate-300 hover:bg-slate-800 hover:text-white'
      }`}
    >
      {children}
    </button>
  )
}

function ToolbarMenuPanel({
  children,
  align = 'left',
  className = '',
}: {
  children: React.ReactNode
  align?: 'left' | 'right'
  className?: string
}) {
  return (
    <div
      role="menu"
      className={`absolute top-12 z-[80] max-h-[70vh] min-w-56 overflow-auto rounded-xl border border-slate-600/90 bg-slate-950/95 p-1.5 text-slate-100 shadow-2xl shadow-black/70 backdrop-blur-2xl ${align === 'right' ? 'right-0' : 'left-0'} ${className}`}
    >
      {children}
    </div>
  )
}

function ToolbarMenuItem({
  children,
  icon,
  title,
  disabled = false,
  onClick,
}: {
  children: React.ReactNode
  icon?: React.ReactNode
  title?: string
  disabled?: boolean
  onClick?: () => void
}) {
  return (
    <button
      type="button"
      role="menuitem"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium text-slate-200 transition-colors duration-150 hover:bg-slate-800 hover:text-white disabled:cursor-not-allowed disabled:text-slate-600 disabled:hover:bg-transparent"
    >
      {icon ? <span className="grid size-5 shrink-0 place-items-center text-slate-400">{icon}</span> : null}
      <span className="min-w-0 flex-1">{children}</span>
    </button>
  )
}

function FluentToolbarDivider() {
  return <span aria-hidden="true" className="mx-1 h-6 w-px shrink-0 bg-slate-700/80" />
}

function TabMenuButton({
  children,
  onClick,
}: {
  children: React.ReactNode
  onClick: () => void
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="block w-full rounded-lg px-3 py-2 text-left text-sm text-slate-200 transition-colors duration-150 hover:bg-slate-800"
    >
      {children}
    </button>
  )
}

function RotatedPage({
  pageNumber,
  scale,
  rotation,
  customTextRenderer,
  onPageLoad,
  onPageRender,
}: {
  pageNumber: number
  scale: number
  rotation: number
  customTextRenderer?: (props: { pageNumber: number; itemIndex: number; str: string }) => string
  onPageLoad?: (page: PDFPageProxy) => void
  onPageRender?: (pageNumber: number, duration: number) => void
}) {
  const [intrinsicRotation, setIntrinsicRotation] = useState<number | null>(null)
  const renderStartedRef = useRef(0)
  const renderedRotation =
    intrinsicRotation === null ? undefined : normalizeRotation(intrinsicRotation + rotation)

  useEffect(() => {
    renderStartedRef.current = performance.now()
  }, [customTextRenderer, pageNumber, renderedRotation, scale])

  return (
    <Page
      pageNumber={pageNumber}
      scale={scale}
      rotate={renderedRotation}
      customTextRenderer={customTextRenderer}
      onLoadSuccess={(page) => {
        setIntrinsicRotation(page.rotate)
        onPageLoad?.(page)
      }}
      onRenderSuccess={() => {
        onPageRender?.(pageNumber, performance.now() - renderStartedRef.current)
      }}
      loading={<StatusMessage>Loading page {pageNumber}...</StatusMessage>}
      error={<StatusMessage>Failed to render page {pageNumber}.</StatusMessage>}
    />
  )
}

function PagePlaceholder({
  pageNumber,
  width,
  height,
}: {
  pageNumber: number
  width: number
  height: number
}) {
  return (
    <div
      aria-label={`Page ${pageNumber} waiting to render`}
      style={{ width, height }}
      className="flex max-w-full items-center justify-center rounded bg-slate-800/45 text-xs text-slate-500"
    >
      Page {pageNumber}
    </div>
  )
}

function HighlightsPanel({
  highlights,
  documentSelected,
  onNavigate,
  onRemove,
  onContextMenu,
  editingNoteId,
  selectedHighlightIds,
  onEditNote,
  onSaveNote,
  onFinishNote,
  onToggleSelected,
  onExport,
}: {
  highlights: PdfHighlight[]
  documentSelected: boolean
  onNavigate: (highlight: PdfHighlight) => void
  onRemove: (highlightId: string) => void
  onContextMenu: (event: React.MouseEvent, highlightId: string) => void
  editingNoteId: string | null
  selectedHighlightIds: Set<string>
  onEditNote: (highlightId: string) => void
  onSaveNote: (highlightId: string, note: string) => void
  onFinishNote: () => void
  onToggleSelected: (highlightId: string) => void
  onExport: () => void
}) {
  const [categoryFilter, setCategoryFilter] = useState<HighlightCategory | 'all'>('all')
  const [collapsedCategories, setCollapsedCategories] = useState<Set<HighlightCategory>>(
    () => new Set(),
  )
  const [collapsedPages, setCollapsedPages] = useState<Set<string>>(() => new Set())
  const categoryCounts = Object.fromEntries(
    HIGHLIGHT_CATEGORY_ORDER.map((category) => [
      category,
      highlights.filter((highlight) => highlight.category === category).length,
    ]),
  ) as Record<HighlightCategory, number>
  const visibleCategories =
    categoryFilter === 'all' ? HIGHLIGHT_CATEGORY_ORDER : [categoryFilter]

  function toggleCategory(category: HighlightCategory) {
    setCollapsedCategories((current) => toggleSetValue(current, category))
  }

  function togglePage(pageKey: string) {
    setCollapsedPages((current) => toggleSetValue(current, pageKey))
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-3">
      <div className="mb-3 flex items-center justify-between gap-2 px-1">
        <h2 className="text-sm font-semibold text-slate-100">Highlights ({highlights.length})</h2>
        <button
          type="button"
          onClick={onExport}
          disabled={highlights.length === 0}
          className="rounded-lg border border-slate-600 px-2.5 py-1.5 text-xs font-medium text-slate-200 hover:border-blue-400 hover:bg-blue-500/10 disabled:opacity-35"
        >
          Export Highlights
        </button>
      </div>
      <div className="mb-3 rounded-xl border border-slate-700/80 bg-slate-950/35 p-3">
        <p className="mb-2 text-xs font-semibold text-slate-200">Summary</p>
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
          <div className="flex justify-between gap-2 text-slate-300">
            <dt>Highlights</dt><dd>{highlights.length}</dd>
          </div>
          {HIGHLIGHT_CATEGORY_ORDER.map((category) => (
            <div key={category} className="flex justify-between gap-2 text-slate-400">
              <dt>{HIGHLIGHT_CATEGORY_LABELS[category]}</dt><dd>{categoryCounts[category]}</dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="mb-3 flex flex-wrap gap-1.5" aria-label="Filter highlights by category">
        <button
          type="button"
          onClick={() => setCategoryFilter('all')}
          className={`rounded-lg px-2 py-1 text-xs ${
            categoryFilter === 'all' ? 'bg-blue-500/25 text-blue-100' : 'bg-slate-800 text-slate-400 hover:text-white'
          }`}
        >
          All ({highlights.length})
        </button>
        {HIGHLIGHT_CATEGORY_ORDER.map((category) => (
          <button
            key={category}
            type="button"
            onClick={() => setCategoryFilter(category)}
            className={`rounded-lg px-2 py-1 text-xs ${
              categoryFilter === category ? 'bg-blue-500/25 text-blue-100' : 'bg-slate-800 text-slate-400 hover:text-white'
            }`}
          >
            <span className="inline-flex items-center gap-1.5">
              <span className={`size-2 rounded-full ${highlightCategoryColorClass(category)}`} />
              {HIGHLIGHT_CATEGORY_LABELS[category]} ({categoryCounts[category]})
            </span>
          </button>
        ))}
      </div>

      {!documentSelected ? (
        <p className="rounded-xl border border-dashed border-slate-700 px-3 py-8 text-center text-sm leading-5 text-slate-400">
          No document selected
        </p>
      ) : highlights.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-700 px-3 py-8 text-center text-sm leading-5 text-slate-400">
          Select PDF text to create a highlight.
        </p>
      ) : (
        <div className="space-y-3">
          {visibleCategories.map((category) => {
            const categoryHighlights = highlights.filter(
              (highlight) => highlight.category === category,
            )
            const pageGroups = groupHighlightsByPage(categoryHighlights)
            const categoryCollapsed = collapsedCategories.has(category)
            return (
              <section key={category} className="rounded-xl border border-slate-700/70 bg-slate-950/20">
                <button
                  type="button"
                  onClick={() => toggleCategory(category)}
                  className="flex w-full items-center justify-between px-3 py-2.5 text-left text-sm font-semibold text-slate-200 hover:bg-slate-800/60"
                >
                  <span className="flex items-center gap-2">
                    <span className={`size-2.5 rounded-full ${highlightCategoryColorClass(category)}`} />
                    {HIGHLIGHT_CATEGORY_LABELS[category]} ({categoryHighlights.length})
                  </span>
                  <span className={`text-xs transition-transform ${categoryCollapsed ? '' : 'rotate-90'}`}>&#9654;</span>
                </button>
                {!categoryCollapsed ? (
                  <div className="space-y-2 border-t border-slate-700/60 p-2">
                    {pageGroups.length === 0 ? (
                      <p className="px-2 py-3 text-center text-xs text-slate-500">No highlights</p>
                    ) : pageGroups.map(([pageNumber, pageHighlights]) => {
                      const pageKey = `${category}:${pageNumber}`
                      const pageCollapsed = collapsedPages.has(pageKey)
                      return (
                        <div key={pageKey} className="rounded-lg bg-slate-900/55">
                          <button
                            type="button"
                            onClick={() => togglePage(pageKey)}
                            className="flex w-full items-center justify-between px-2.5 py-2 text-left text-xs font-semibold text-slate-300 hover:text-white"
                          >
                            <span>Page {pageNumber}</span>
                            <span>{pageHighlights.length}</span>
                          </button>
                          {!pageCollapsed ? (
                            <div className="space-y-1.5 px-1.5 pb-1.5">
                              {pageHighlights.map((highlight) => (
                                <div
                                  key={highlight.id}
                                  onContextMenu={(event) => onContextMenu(event, highlight.id)}
                                  className="group rounded-lg border border-slate-700/70 bg-slate-800/55 p-2.5 hover:border-slate-600 hover:bg-slate-800"
                                >
                                  <label className="mb-2 flex items-center gap-2 text-[10px] text-slate-500">
                                    <input
                                      type="checkbox"
                                      checked={selectedHighlightIds.has(highlight.id)}
                                      onChange={() => onToggleSelected(highlight.id)}
                                    />
                                    Select for export
                                  </label>
                                  <button
                                    type="button"
                                    title={highlight.text}
                                    onClick={() => onNavigate(highlight)}
                                    className="block w-full text-left"
                                  >
                                    <span className="flex items-center gap-2">
                                      <span className={`size-2.5 shrink-0 rounded-full ${highlightColorClass(highlight.color)}`} />
                                      <span className="line-clamp-3 text-sm leading-5 text-slate-100">{highlight.text}</span>
                                    </span>
                                    <span className="mt-1.5 block text-[10px] text-slate-500">
                                      {new Date(highlight.createdDate).toLocaleString()}
                                    </span>
                                  </button>
                                  {editingNoteId === highlight.id ? (
                                    <HighlightNoteEditor
                                      highlight={highlight}
                                      onSave={onSaveNote}
                                      onDone={onFinishNote}
                                    />
                                  ) : highlight.note ? (
                                    <button
                                      type="button"
                                      onClick={() => onEditNote(highlight.id)}
                                      className="mt-2 block w-full rounded-lg border border-slate-700/70 bg-slate-950/45 px-2.5 py-2 text-left text-xs leading-5 text-slate-300 hover:border-slate-600"
                                    >
                                      <span className="mr-1" aria-hidden="true">&#128221;</span>
                                      <span className="line-clamp-3">{highlight.note}</span>
                                    </button>
                                  ) : (
                                    <button
                                      type="button"
                                      onClick={() => onEditNote(highlight.id)}
                                      className="mt-2 rounded px-1.5 py-1 text-[10px] text-blue-300 hover:bg-blue-500/10"
                                    >
                                      Add Note
                                    </button>
                                  )}
                                  <button
                                    type="button"
                                    aria-label={`Delete highlight from page ${highlight.pageNumber}`}
                                    onClick={() => onRemove(highlight.id)}
                                    className="mt-1 rounded px-1.5 py-0.5 text-[10px] text-red-300 opacity-60 hover:bg-red-500/15 hover:opacity-100"
                                  >
                                    Delete
                                  </button>
                                </div>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      )
                    })}
                  </div>
                ) : null}
              </section>
            )
          })}
        </div>
      )}
    </div>
  )
}

function HighlightNoteEditor({
  highlight,
  onSave,
  onDone,
}: {
  highlight: PdfHighlight
  onSave: (highlightId: string, note: string) => void
  onDone: () => void
}) {
  const [note, setNote] = useState(highlight.note)
  const saveTimerRef = useRef(0)
  const lastSavedNoteRef = useRef(highlight.note)

  useEffect(() => () => window.clearTimeout(saveTimerRef.current), [])

  function scheduleSave(nextNote: string) {
    window.clearTimeout(saveTimerRef.current)
    saveTimerRef.current = window.setTimeout(() => persistNote(nextNote), 500)
  }

  function saveNow() {
    window.clearTimeout(saveTimerRef.current)
    persistNote(note)
  }

  function persistNote(nextNote: string) {
    const normalizedNote = nextNote.trimEnd()
    if (normalizedNote === lastSavedNoteRef.current) {
      return
    }
    lastSavedNoteRef.current = normalizedNote
    onSave(highlight.id, normalizedNote)
  }

  return (
    <div className="mt-2 rounded-lg border border-blue-400/40 bg-slate-950/70 p-2">
      <label className="text-[10px] font-semibold uppercase tracking-wide text-blue-300">
        Personal Note
        <textarea
          data-note-editor={highlight.id}
          value={note}
          rows={4}
          placeholder="Add a research note..."
          onChange={(event) => {
            setNote(event.target.value)
            scheduleSave(event.target.value)
          }}
          onBlur={saveNow}
          onKeyDown={(event) => {
            if (event.ctrlKey && event.key === 'Enter') {
              event.preventDefault()
              saveNow()
              event.currentTarget.blur()
            }
          }}
          className="mt-1.5 w-full resize-y rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs font-normal leading-5 text-slate-100 outline-none focus:border-blue-400"
        />
      </label>
      <div className="mt-1 flex items-center justify-between text-[10px] text-slate-500">
        <span>Autosaves while typing. Ctrl+Enter to save.</span>
        <button
          type="button"
          onClick={() => {
            saveNow()
            onDone()
          }}
          className="rounded px-2 py-1 text-blue-300 hover:bg-blue-500/10"
        >
          Done
        </button>
      </div>
    </div>
  )
}

function DocumentInfoPanel({
  file,
  totalPages,
  metadata,
  loading,
  ocrDetection,
  ocrTextPages,
  lowConfidenceOcrPages,
}: {
  file: PdfFile
  totalPages: number
  metadata: DocumentMetadata | null
  loading: boolean
  ocrDetection: OcrDetectionResult
  ocrTextPages: number
  lowConfidenceOcrPages: number
}) {
  const rows = [
    ['File name', file.name],
    ['File path', file.filePath],
    ['File size', formatFileSize(file.fileSize)],
    ['Total pages', String(totalPages)],
    ['OCR status', ocrTextPages > 0 ? 'Scanned PDF - OCR Text Available' : ocrDetectionLabel(ocrDetection)],
    ['OCR text pages', ocrTextPages > 0 ? String(ocrTextPages) : 'None'],
    ['Low-confidence OCR pages', lowConfidenceOcrPages > 0 ? String(lowConfidenceOcrPages) : 'None'],
    ['Title', metadata?.title],
    ['Author', metadata?.author],
    ['Subject', metadata?.subject],
    ['Creator', metadata?.creator],
    ['Producer', metadata?.producer],
    ['Creation date', metadata?.creationDate],
    ['Modification date', metadata?.modificationDate],
  ]

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      <div className="mb-4">
        <h2 className="text-sm font-semibold text-slate-100">Document Information</h2>
        <p className="mt-1 text-xs text-slate-500">
          {loading ? 'Loading metadata...' : 'File and PDF metadata'}
        </p>
      </div>
      <dl className="space-y-2.5">
        {rows.map(([label, value]) => (
          <div key={label} className="rounded-xl border border-slate-700/70 bg-slate-800/45 p-3">
            <dt className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">
              {label}
            </dt>
            <dd
              title={value || undefined}
              className="mt-1.5 break-words text-sm leading-5 text-slate-100"
            >
              {value || 'Not specified'}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

function BookmarkTree({
  items,
  depth = 0,
  onNavigate,
}: {
  items: PdfOutlineItem[]
  depth?: number
  onNavigate: (bookmark: PdfOutlineItem) => Promise<void>
}) {
  return (
    <div>
      {items.map((item, index) => (
        <BookmarkItem
          key={`${depth}-${index}-${item.title}`}
          item={item}
          depth={depth}
          onNavigate={onNavigate}
        />
      ))}
    </div>
  )
}

function BookmarkItem({
  item,
  depth,
  onNavigate,
}: {
  item: PdfOutlineItem
  depth: number
  onNavigate: (bookmark: PdfOutlineItem) => Promise<void>
}) {
  const hasChildren = item.items.length > 0
  const [expanded, setExpanded] = useState(item.count === undefined || item.count >= 0)

  return (
    <div>
      <div
        className="flex min-w-0 items-start rounded-lg hover:bg-slate-800"
        style={{ paddingLeft: depth * 12 }}
      >
        {hasChildren ? (
          <button
            type="button"
            aria-label={expanded ? `Collapse ${item.title}` : `Expand ${item.title}`}
            aria-expanded={expanded}
            onClick={() => setExpanded((isExpanded) => !isExpanded)}
            className="grid size-8 shrink-0 place-items-center text-slate-400 hover:text-slate-100"
          >
            <span className={`text-xs transition-transform ${expanded ? 'rotate-90' : ''}`}>
              &#9654;
            </span>
          </button>
        ) : (
          <span className="block size-8 shrink-0" />
        )}

        <button
          type="button"
          title={item.title}
          onClick={() => {
            if (item.dest) {
              void onNavigate(item)
            } else if (hasChildren) {
              setExpanded((isExpanded) => !isExpanded)
            }
          }}
          className="min-w-0 flex-1 break-words py-2 pr-2 text-left text-sm leading-5 text-slate-300 hover:text-white"
        >
          {item.title || 'Untitled bookmark'}
        </button>
      </div>

      {hasChildren && expanded ? (
        <BookmarkTree items={item.items} depth={depth + 1} onNavigate={onNavigate} />
      ) : null}
    </div>
  )
}

function LazyThumbnail({
  pdf,
  pageNumber,
  active,
  visible,
  rotation,
  width,
  onNavigate,
}: {
  pdf: PDFDocumentProxy
  pageNumber: number
  active: boolean
  visible: boolean
  rotation: number
  width: number
  onNavigate: (pageNumber: number) => void
}) {
  const [intrinsicRotation, setIntrinsicRotation] = useState<number | null>(null)
  const renderStartedRef = useRef(0)
  const renderedRotation =
    intrinsicRotation === null ? undefined : normalizeRotation(intrinsicRotation + rotation)

  useEffect(() => {
    if (visible) {
      renderStartedRef.current = performance.now()
    }
  }, [pageNumber, renderedRotation, visible, width])

  return (
    <div
      data-thumbnail-page={pageNumber}
      className={`mb-3 flex flex-col items-center justify-center rounded-2xl border p-3 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-xl hover:shadow-black/25 ${
        active
          ? 'border-blue-400 bg-blue-500/15 ring-2 ring-blue-400/30 shadow-[0_0_22px_rgba(59,130,246,0.18)]'
          : 'border-slate-700/70 bg-slate-800/45 hover:border-slate-600 hover:bg-slate-800/80'
      }`}
    >
      {visible ? (
        <Thumbnail
          pdf={pdf}
          pageNumber={pageNumber}
          width={width}
          rotate={renderedRotation}
          onLoadSuccess={(page) => setIntrinsicRotation(page.rotate)}
          onRenderSuccess={() => {
            console.debug(
              `Thumbnail generation time: page ${pageNumber} ${formatDuration(performance.now() - renderStartedRef.current)}`,
            )
          }}
          loading={<ThumbnailPlaceholder pageNumber={pageNumber} width={width} />}
          error={<ThumbnailPlaceholder pageNumber={pageNumber} width={width} failed />}
          onItemClick={({ pageNumber: selectedPage }) => onNavigate(selectedPage)}
          className="overflow-hidden rounded-lg bg-white shadow-lg shadow-black/35"
        />
      ) : (
        <button
          type="button"
          onClick={() => onNavigate(pageNumber)}
          style={{ width, height: Math.round(width * 1.28) }}
          className="flex items-center justify-center rounded-lg bg-slate-800 text-xs text-slate-500"
        >
          Loading thumbnail...
        </button>
      )}
      <span className={`mt-2 text-xs ${active ? 'font-semibold text-blue-200' : 'text-slate-400'}`}>
        Page {pageNumber}
      </span>
    </div>
  )
}

function ThumbnailPlaceholder({
  pageNumber,
  width,
  failed = false,
}: {
  pageNumber: number
  width: number
  failed?: boolean
}) {
  return (
    <div
      style={{ width, height: Math.round(width * 1.28) }}
      className="flex animate-pulse items-center justify-center rounded-lg bg-slate-800 px-3 text-center text-xs text-slate-500"
    >
      {failed ? `Page ${pageNumber} unavailable` : 'Loading thumbnail...'}
    </div>
  )
}

function StatusMessage(props: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-800 px-4 py-3 text-slate-300">
      {props.children}
    </div>
  )
}

function ToolbarDivider() {
  return <span aria-hidden="true" className="mx-1 hidden h-6 w-px shrink-0 bg-slate-700/80 sm:block" />
}

function StatusDivider() {
  return <span aria-hidden="true" className="h-3 w-px bg-slate-600" />
}

function StatusItem({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded px-2 py-1 transition-colors duration-150 hover:bg-slate-700/60 hover:text-white">
      {children}
    </span>
  )
}

function PdfToolsIcon() {
  return <DocumentPdfRegular className="size-4 shrink-0" />
}

function MergePdfIcon() {
  return <DocumentPdfRegular className="size-4 shrink-0 text-blue-300" />
}

function ImagesToPdfIcon() {
  return <DocumentOnePageRegular className="size-4 shrink-0 text-emerald-300" />
}

function SignatureToolIcon() {
  return <SignatureRegular className="size-4 shrink-0 text-amber-300" />
}

function SignedCopyIcon() {
  return <SaveRegular className="size-4 shrink-0 text-emerald-300" />
}

function CalendarIcon() {
  return <CalendarRegular className="size-4" />
}

function CheckBoxIcon() {
  return <CheckboxCheckedRegular className="size-4" />
}

function DateFormatIcon() {
  return <CalendarRegular className="size-4" />
}

function ChevronDownIcon({ open }: { open: boolean }) {
  return <ChevronDownRegular className={`size-3 shrink-0 text-slate-500 transition-transform duration-150 ${open ? 'rotate-180' : ''}`} />
}

function WorkspaceIcon() {
  return <CollectionsRegular className="size-5 shrink-0" />
}

function ReferencesIcon() {
  return <DocumentBulletListRegular className="size-5 shrink-0" />
}

function PreviousPageIcon() {
  return <ChevronLeftRegular className="size-5" />
}

function NextPageIcon() {
  return <ChevronRightRegular className="size-5" />
}

function SidebarToggleIcon({ expanded }: { expanded: boolean }) {
  return expanded ? <ChevronLeftRegular className="size-4" /> : <ChevronRightRegular className="size-4" />
}

function ZoomOutIcon() {
  return <ZoomOutRegular className="size-5" />
}

function ZoomInIcon() {
  return <ZoomInRegular className="size-5" />
}

function FitWidthIcon() {
  return <ZoomFitRegular className="size-5" />
}

function SinglePageIcon() {
  return <DocumentOnePageRegular className="size-5" />
}

function ContinuousScrollIcon() {
  return <DocumentBulletListRegular className="size-5" />
}

function BackgroundIcon() {
  return <DarkThemeRegular className="size-4 shrink-0" />
}

function RotateLeftIcon() {
  return <ArrowRotateCounterclockwiseRegular className="size-5" />
}

function RotateRightIcon() {
  return <ArrowRotateClockwiseRegular className="size-5" />
}

function SearchIcon() {
  return <SearchRegular className="size-5" />
}

function GlobalSearchIcon() {
  return <LibraryRegular className="size-4" />
}

function ThumbnailsIcon() {
  return <DocumentOnePageRegular className="size-5" />
}

function BookmarkIcon() {
  return <BookmarkRegular className="size-5" />
}

function HighlightsIcon() {
  return <HighlightRegular className="size-5" />
}

function InfoIcon() {
  return <InfoRegular className="size-5" />
}

function HelpIcon() {
  return <QuestionCircleRegular className="size-5" />
}

function PrintIcon() {
  return <PrintRegular className="size-5" />
}

function ExportIcon() {
  return <ArrowExportRegular className="size-5" />
}

function FileIcon() {
  return <DocumentPdfRegular className="size-4 shrink-0 text-blue-300" />
}

function FullscreenIcon() {
  return <FullScreenMaximizeRegular className="size-5" />
}

function SplitViewIcon() {
  return <SplitHorizontalRegular className="size-5" />
}

function ExitFullscreenIcon() {
  return <FullScreenMinimizeRegular className="size-5" />
}

function DropPdfIcon() {
  return <DocumentPdfRegular className="size-9" />
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}

function groupHighlightsByPage(highlights: PdfHighlight[]) {
  const groups = new Map<number, PdfHighlight[]>()
  for (const highlight of [...highlights].sort(
    (left, right) => Date.parse(right.createdDate) - Date.parse(left.createdDate),
  )) {
    const pageHighlights = groups.get(highlight.pageNumber) ?? []
    pageHighlights.push(highlight)
    groups.set(highlight.pageNumber, pageHighlights)
  }
  return [...groups.entries()].sort(([leftPage], [rightPage]) => leftPage - rightPage)
}

function toggleSetValue<T>(current: Set<T>, value: T) {
  const next = new Set(current)
  if (next.has(value)) {
    next.delete(value)
  } else {
    next.add(value)
  }
  return next
}

function highlightColorClass(color: HighlightColor) {
  return color === 'yellow'
    ? 'bg-amber-300'
    : color === 'green'
      ? 'bg-emerald-300'
      : color === 'blue'
        ? 'bg-sky-300'
        : 'bg-violet-300'
}

function highlightCategoryColorClass(category: HighlightCategory) {
  return category === 'important'
    ? 'bg-yellow-400'
    : category === 'research'
      ? 'bg-green-400'
      : category === 'reference'
        ? 'bg-blue-400'
        : 'bg-violet-400'
}

function getPdfPageElement(node: Node) {
  const element = node instanceof Element ? node : node.parentElement
  return element?.closest<HTMLElement>('.react-pdf__Page') ?? null
}

function clampUnit(value: number) {
  return Math.min(1, Math.max(0, value))
}

function rectanglesOverlap(left: HighlightRectangle, right: HighlightRectangle) {
  return (
    left.x < right.x + right.width &&
    left.x + left.width > right.x &&
    left.y < right.y + right.height &&
    left.y + left.height > right.y
  )
}

function normalizeHighlightText(text: string) {
  return text.replace(/\s+/g, ' ').trim().toLocaleLowerCase()
}

function globalSearchNavigationTerm(query: string) {
  const phrase = query.match(/"([^"]+)"/)?.[1]
  if (phrase?.trim()) return phrase.trim()
  return query.match(/[\p{L}\p{N}]+/u)?.[0] ?? query.trim()
}

function pointInsideRectangle(
  point: { x: number; y: number },
  rectangle: HighlightRectangle,
) {
  return (
    point.x >= rectangle.x &&
    point.x <= rectangle.x + rectangle.width &&
    point.y >= rectangle.y &&
    point.y <= rectangle.y + rectangle.height
  )
}

function getMetadataValue(...values: unknown[]) {
  for (const value of values) {
    if (Array.isArray(value)) {
      const text = value.filter((item) => typeof item === 'string').join(', ').trim()
      if (text) {
        return text
      }
    } else if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
  }
  return ''
}

function formatPdfDate(value: string) {
  if (!value) {
    return ''
  }

  let normalizedDate = value
  const pdfDate = value.match(
    /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Z+-])?(\d{2})?'?(\d{2})?/,
  )
  if (pdfDate) {
    const [, year, month = '01', day = '01', hour = '00', minute = '00', second = '00'] =
      pdfDate
    const zone = pdfDate[7]
    const offset = zone && zone !== 'Z' ? `${zone}${pdfDate[8] ?? '00'}:${pdfDate[9] ?? '00'}` : 'Z'
    normalizedDate = `${year}-${month}-${day}T${hour}:${minute}:${second}${offset}`
  }

  const date = new Date(normalizedDate)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function formatFileSize(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`
  }

  const units = ['KB', 'MB', 'GB']
  let size = bytes / 1024
  let unitIndex = 0
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex += 1
  }
  return `${size.toFixed(size >= 10 ? 1 : 2)} ${units[unitIndex]}`
}

function normalizeRotation(rotation: number) {
  return ((rotation % 360) + 360) % 360
}

function canvasToBlob(canvas: HTMLCanvasElement, mimeType: string, quality?: number) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob)
        } else {
          reject(new Error('The exported image could not be encoded.'))
        }
      },
      mimeType,
      quality,
    )
  })
}

function normalizeOcrDetection(detection: Partial<OcrDetectionResult> | null | undefined): OcrDetectionResult {
  const status: OcrDetectionStatus = [
    'unknown',
    'detecting',
    'searchable',
    'ocr-recommended',
    'error',
  ].includes(detection?.status ?? '')
    ? (detection?.status as OcrDetectionStatus)
    : 'unknown'
  return {
    status,
    sampledPages: Math.max(0, Math.trunc(Number(detection?.sampledPages) || 0)),
    textCharacters: Math.max(0, Math.trunc(Number(detection?.textCharacters) || 0)),
    detectedAt: detection?.detectedAt ?? null,
    error: detection?.error,
  }
}

function ocrDetectionLabel(detection: Partial<OcrDetectionResult> | null | undefined) {
  switch (detection?.status) {
    case 'searchable':
      return 'Searchable PDF'
    case 'ocr-recommended':
      return 'Scanned PDF - OCR Recommended'
    case 'detecting':
      return 'Detecting OCR status...'
    case 'error':
      return 'OCR detection unavailable'
    default:
      return 'OCR status unknown'
  }
}

function ocrTextPagesStatus(
  detection: Partial<OcrDetectionResult> | null | undefined,
  ocrTextPages: number,
  lowConfidencePages = 0,
) {
  if (ocrTextPages > 0) {
    return `OCR Text: ${ocrTextPages} page${ocrTextPages === 1 ? '' : 's'}${lowConfidencePages > 0 ? ` (${lowConfidencePages} low confidence)` : ''}`
  }
  return ocrDetectionLabel(detection)
}

function sanitizeOcrLanguage(language: unknown): OcrLanguage {
  return OCR_LANGUAGES.some((item) => item.code === language) ? language as OcrLanguage : 'eng'
}

function searchMatchSourceLabel(match: SearchMatch | undefined) {
  if (!match) return ''
  return match.source === 'ocr' ? ' - OCR Text' : ' - Embedded Text'
}

function countMeaningfulTextCharacters(text: string) {
  return Array.from(text.replace(/\s+/g, '')).filter((character) => /[\p{L}\p{N}]/u.test(character)).length
}

function parsePageRanges(value: string, totalPages: number) {
  const trimmed = value.trim()
  if (!trimmed) throw new Error('Enter page numbers or ranges before running OCR.')
  const pages = new Set<number>()
  const parts = trimmed.split(',').map((part) => part.trim()).filter(Boolean)
  if (parts.length === 0) throw new Error('Enter page numbers or ranges before running OCR.')

  for (const part of parts) {
    const rangeMatch = part.match(/^(\d+)\s*-\s*(\d+)$/)
    if (rangeMatch) {
      const start = Number(rangeMatch[1])
      const end = Number(rangeMatch[2])
      if (start > end) throw new Error(`Invalid page range: ${part}`)
      if (start < 1 || end > totalPages) {
        throw new Error(`Page range ${part} is outside this document. Use 1-${totalPages}.`)
      }
      for (let pageNumber = start; pageNumber <= end; pageNumber += 1) pages.add(pageNumber)
      continue
    }

    if (!/^\d+$/.test(part)) throw new Error(`Invalid page entry: ${part}`)
    const pageNumber = Number(part)
    if (pageNumber < 1 || pageNumber > totalPages) {
      throw new Error(`Page ${pageNumber} is outside this document. Use 1-${totalPages}.`)
    }
    pages.add(pageNumber)
  }

  return [...pages].sort((left, right) => left - right)
}

function normalizeOcrPageList(pages: number[], totalPages: number) {
  return [...new Set(
    pages
      .map((pageNumber) => Math.trunc(Number(pageNumber)))
      .filter((pageNumber) => pageNumber >= 1 && pageNumber <= totalPages),
  )].sort((left, right) => left - right)
}

function formatPageList(pages: number[]) {
  return pages.slice(0, 20).join(', ') + (pages.length > 20 ? `, +${pages.length - 20} more` : '')
}

function estimateRemainingMs(startedAt: number, processedPages: number, totalPages: number) {
  if (processedPages <= 0) return null
  const elapsed = performance.now() - startedAt
  const remainingPages = Math.max(0, totalPages - processedPages)
  return remainingPages * (elapsed / processedPages)
}

function formatDurationLong(duration: number) {
  const seconds = Math.max(1, Math.round(duration / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`
}

function delay(duration: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, duration))
}

async function getPageText(
  document: PDFDocumentProxy,
  pageNumber: number,
  cache: Map<number, CachedPageText>,
) {
  const cachedText = cache.get(pageNumber)
  if (cachedText) {
    return cachedText
  }

  const started = performance.now()
  const page = await document.getPage(pageNumber)
  const textContent = await page.getTextContent()
  const itemStarts: number[] = []
  let text = ''

  textContent.items.forEach((item, itemIndex) => {
    itemStarts[itemIndex] = text.length
    if ('str' in item) {
      text += item.str
      if (item.hasEOL) {
        text += '\n'
      }
    }
  })

  const pageText = { text, itemStarts }
  cache.set(pageNumber, pageText)
  console.debug(
    `Text extraction time: page ${pageNumber} ${formatDuration(performance.now() - started)}`,
  )
  return pageText
}

function addPageWindow(
  pages: Set<number>,
  centerPage: number,
  totalPages: number,
  radius: number,
) {
  for (
    let pageNumber = Math.max(1, centerPage - radius);
    pageNumber <= Math.min(totalPages, centerPage + radius);
    pageNumber += 1
  ) {
    pages.add(pageNumber)
  }
}

function createPageRenderSet(
  nearbyPages: Set<number>,
  currentPage: number,
  totalPages: number,
  radius: number,
) {
  const pages = new Set<number>()
  for (const pageNumber of nearbyPages) {
    addPageWindow(pages, pageNumber, totalPages, radius)
  }
  addPageWindow(pages, currentPage, totalPages, radius)
  return pages
}

function setsAreEqual(first: Set<number>, second: Set<number>) {
  return first.size === second.size && [...first].every((value) => second.has(value))
}

function yieldToMainThread() {
  return new Promise<void>((resolve) => window.setTimeout(resolve, 0))
}

function formatDuration(duration: number) {
  return `${Math.round(duration)}ms`
}

function escapeHtml(text: string) {
  return text.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[character] ??
      character,
  )
}

function clampScale(scale: number) {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale))
}

export default App
