import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import { Document, Page, Thumbnail, pdfjs } from 'react-pdf'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import { HighlightOverlay } from './components/Viewer/HighlightOverlay'
import type {
  HighlightColor,
  HighlightCategory,
  HighlightRectangle,
  PdfHighlight,
  PendingHighlightSelection,
} from './types/highlights'
import { transformHighlightRectangle } from './utils/highlights'
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
}

type SidebarTab = 'thumbnails' | 'bookmarks' | 'highlights' | 'info'
type ViewMode = 'continuous' | 'single'
type ViewerBackground = 'dark-gray' | 'black' | 'light-gray' | 'white'

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
const KEYBOARD_SHORTCUTS = [
  ['Ctrl + O', 'Open PDF'],
  ['Ctrl + P', 'Print PDF'],
  ['Ctrl + F', 'Search'],
  ['Ctrl + H', 'Highlight selected text'],
  ['Ctrl + Mouse Wheel', 'Zoom'],
  ['Ctrl + +', 'Zoom In'],
  ['Ctrl + -', 'Zoom Out'],
  ['Ctrl + 0', 'Reset Zoom'],
  ['PageUp', 'Previous Page'],
  ['PageDown', 'Next Page'],
  ['F11', 'Toggle Fullscreen'],
  ['Esc', 'Exit Fullscreen'],
]

function App() {
  const [pdfFile, setPdfFile] = useState<PdfFile | null>(null)
  const [activeDocumentId, setActiveDocumentId] = useState<string | null>(null)
  const [recentFiles, setRecentFiles] = useState<RecentFile[]>([])
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
  const [highlights, setHighlights] = useState<PdfHighlight[]>([])
  const [pendingHighlightSelection, setPendingHighlightSelection] =
    useState<PendingHighlightSelection | null>(null)
  const [highlightContextMenu, setHighlightContextMenu] = useState<{
    highlightId: string
    x: number
    y: number
  } | null>(null)
  const [focusedHighlightId, setFocusedHighlightId] = useState<string | null>(null)
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null)
  const [selectedHighlightIds, setSelectedHighlightIds] = useState<Set<string>>(() => new Set())
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
  const [isPrinting, setIsPrinting] = useState(false)
  const [isExporting, setIsExporting] = useState(false)
  const [exportMenuOpen, setExportMenuOpen] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [viewMode, setViewMode] = useState<ViewMode>('continuous')
  const [viewerBackground, setViewerBackground] = useState<ViewerBackground>('dark-gray')
  const [headerHeight, setHeaderHeight] = useState(0)
  const headerRef = useRef<HTMLElement>(null)
  const viewerRef = useRef<HTMLDivElement>(null)
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
  const restoringReadingStateRef = useRef(false)
  const recentFilesRef = useRef<HTMLDetailsElement>(null)
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
  const highlightSaveGenerationRef = useRef(0)
  const highlightFocusTimeoutRef = useRef(0)
  const highlightPageMapRef = useRef(new Map<number, PdfHighlight[]>())

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
        (match) => match.start < itemEnd && match.end > itemStart,
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

    loadOpenedPdf(message.pdf)
    void refreshRecentFiles()
  })

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
      .getSidebarTab()
      .then(setSidebarTab)
      .catch((error) => setErrorMessage(getErrorMessage(error)))
    void window.electronAPI
      .getViewMode()
      .then(setViewMode)
      .catch((error) => setErrorMessage(getErrorMessage(error)))
    void window.electronAPI
      .getViewerBackground()
      .then(setViewerBackground)
      .catch((error) => setErrorMessage(getErrorMessage(error)))
    void window.electronAPI
      .getSidebarLayout()
      .then(({ width, collapsed }) => {
        setSidebarWidth(width)
        setThumbnailSidebarOpen(!collapsed)
      })
      .catch((error) => setErrorMessage(getErrorMessage(error)))
  }, [])

  useEffect(() => {
    const removeSystemOpenListener = window.electronAPI.onOpenPdfFromSystem(
      handleSystemPdfOpen,
    )

    window.electronAPI.notifyRendererReady()
    return removeSystemOpenListener
  }, [])

  useEffect(() => {
    document.title = pdfFile ? `${pdfFile.name} — Next PDF Viewer` : 'Next PDF Viewer'
  }, [pdfFile])

  useEffect(() => {
    void window.electronAPI
      .getFullscreen()
      .then(setIsFullscreen)
      .catch((error) => setErrorMessage(getErrorMessage(error)))
    window.electronAPI.onFullscreenChange(setIsFullscreen)
    return () => window.electronAPI.removeFullscreenListener()
  }, [])

  useEffect(() => {
    function hasFiles(event: DragEvent) {
      return Array.from(event.dataTransfer?.types ?? []).includes('Files')
    }

    function handleDragEnter(event: DragEvent) {
      event.preventDefault()
      if (!hasFiles(event)) {
        return
      }

      dragDepthRef.current += 1
      setDragActive(true)
    }

    function handleDragOver(event: DragEvent) {
      event.preventDefault()
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'copy'
      }
    }

    function handleDragLeave(event: DragEvent) {
      event.preventDefault()
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
      if (dragDepthRef.current === 0) {
        setDragActive(false)
      }
    }

    function handleDrop(event: DragEvent) {
      event.preventDefault()
      dragDepthRef.current = 0
      setDragActive(false)

      const files = Array.from(event.dataTransfer?.files ?? [])
      if (files.length === 0) {
        return
      }

      const firstPdf = files.find((file) => file.name.toLowerCase().endsWith('.pdf'))
      if (!firstPdf) {
        setErrorMessage('Only PDF files can be opened. Drop a file ending in .pdf.')
        return
      }

      void openDroppedPdf(firstPdf)
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
      window.clearTimeout(highlightFocusTimeoutRef.current)
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
                })
                matchStart = normalizedText.indexOf(
                  normalizedQuery,
                  matchStart + normalizedQuery.length,
                )
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
            setSelectedMatchIndex(matches.length > 0 ? 0 : -1)
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
  }, [pdfDocument, searchOpen, searchQuery])

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
      window.scrollTo({
        top: window.scrollY + restoredPage.getBoundingClientRect().top - headerHeight - 16,
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
    function handleSelectionPointerUp(event: PointerEvent) {
      const target = event.target instanceof Element ? event.target : null
      if (
        event.button !== 0 ||
        !pdfFile ||
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

      if (event.ctrlKey && event.key.toLowerCase() === 'o') {
        event.preventDefault()
        void openPdf()
        return
      }

      if (event.ctrlKey && event.key.toLowerCase() === 'p') {
        event.preventDefault()
        if (activeDocumentId) {
          void printCurrentPdf()
        }
        return
      }

      if (event.ctrlKey && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        if (pdfDocument) {
          setSearchOpen(true)
        }
        return
      }

      if (event.ctrlKey && event.key.toLowerCase() === 'h') {
        event.preventDefault()
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

      if (event.ctrlKey && numPages > 0) {
        if (event.key === '+' || event.key === '=' || event.code === 'NumpadAdd') {
          event.preventDefault()
          changeZoom(displayZoomRef.current + 0.25)
          return
        }

        if (event.key === '-' || event.code === 'NumpadSubtract') {
          event.preventDefault()
          changeZoom(displayZoomRef.current - 0.25)
          return
        }

        if (event.key === '0' || event.code === 'Numpad0') {
          event.preventDefault()
          changeZoom(1)
          return
        }
      }

      if (
        target?.matches('input, textarea, select') ||
        target?.isContentEditable ||
        numPages === 0
      ) {
        return
      }

      const destinations: Partial<Record<KeyboardEvent['key'], number>> = {
        PageDown: currentPageRef.current + 1,
        PageUp: currentPageRef.current - 1,
        Home: 1,
        End: numPages,
      }
      const destination = destinations[event.key]

      if (destination !== undefined) {
        event.preventDefault()
        goToPage(destination)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  })

  useEffect(() => {
    function handleWheel(event: WheelEvent) {
      if (!event.ctrlKey || numPages === 0) {
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
        changeZoom(displayZoomRef.current + zoomStep)
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
    if (!startPage || startPage !== endPage) {
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
    if (!highlights.some((highlight) => highlight.id === highlightId)) {
      return
    }

    updateHighlights(highlights.filter((highlight) => highlight.id !== highlightId))
    setSelectedHighlightIds((current) => {
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
    updateHighlights(
      highlights.map((highlight) =>
        highlight.id === highlightId ? { ...highlight, color } : highlight,
      ),
    )
    setHighlightContextMenu(null)
  }

  function changeHighlightCategory(highlightId: string, category: HighlightCategory) {
    updateHighlights(
      highlights.map((highlight) =>
        highlight.id === highlightId ? { ...highlight, category } : highlight,
      ),
    )
    setHighlightContextMenu(null)
  }

  async function copyHighlightText(highlightId: string) {
    const highlight = highlights.find((candidate) => candidate.id === highlightId)
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
    const highlight = highlights.find((candidate) => candidate.id === highlightId)
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
    const highlight = highlights.find((candidate) => candidate.id === highlightId)
    if (!highlight || highlight.note === normalizedNote) {
      return
    }
    updateHighlights(
      highlights.map((candidate) =>
        candidate.id === highlightId ? { ...candidate, note: normalizedNote } : candidate,
      ),
    )
  }

  function toggleHighlightSelected(highlightId: string) {
    setSelectedHighlightIds((current) => toggleSetValue(current, highlightId))
  }

  async function exportHighlightCollection() {
    if (!pdfFile) {
      return
    }

    let candidates = highlights
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
        id: pdfFile.id,
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

  function updateHighlights(nextHighlights: PdfHighlight[]) {
    const document = pdfFile
    if (!document) {
      return
    }

    const previousHighlights = highlights
    const generation = ++highlightSaveGenerationRef.current
    setHighlights(nextHighlights)
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
        }
      })
      .catch((error) => {
        if (highlightSaveGenerationRef.current === generation) {
          setHighlights(previousHighlights)
          setErrorMessage(`Failed to save highlight: ${getErrorMessage(error)}`)
        }
      })
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

  function scheduleBackgroundDocumentWork(document: PDFDocumentProxy) {
    window.clearTimeout(backgroundDocumentTaskRef.current)
    backgroundDocumentTaskRef.current = window.setTimeout(() => {
      void loadPdfOutline(document)
      void loadDocumentMetadata(document)
    }, 250)
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

  async function openPdf() {
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

      loadOpenedPdf(result)
      await refreshRecentFiles()
    } catch (error) {
      setIsLoading(false)
      setLoadingProgress(null)
      setErrorMessage(getErrorMessage(error))
    }
  }

  async function openDroppedPdf(file: File) {
    setErrorMessage(null)
    setIsLoading(true)
    setLoadingProgress('Reading PDF file...')

    try {
      const result = await window.electronAPI.openDroppedPdf(file)
      loadOpenedPdf(result)
      await refreshRecentFiles()
    } catch (error) {
      setIsLoading(false)
      setLoadingProgress(null)
      setErrorMessage(getErrorMessage(error))
    }
  }

  async function printCurrentPdf() {
    if (!activeDocumentId || isPrinting) {
      return
    }

    setErrorMessage(null)
    setIsPrinting(true)
    try {
      await window.electronAPI.printPdf(activeDocumentId)
    } catch (error) {
      setErrorMessage(`Printing failed: ${getErrorMessage(error)}`)
    } finally {
      setIsPrinting(false)
    }
  }

  async function exportCurrentPage(format: 'png' | 'jpeg') {
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

  async function openRecentPdf(id: string) {
    setErrorMessage(null)
    setIsLoading(true)
    setLoadingProgress('Reading PDF file...')
    recentFilesRef.current?.removeAttribute('open')

    try {
      const result = await window.electronAPI.openRecentPdf(id)
      loadOpenedPdf(result)
      await refreshRecentFiles()
    } catch (error) {
      setIsLoading(false)
      setLoadingProgress(null)
      setErrorMessage(getErrorMessage(error))
      await refreshRecentFiles()
    }
  }

  function loadOpenedPdf(result: OpenedPdf) {
    const readingState = result.readingState
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
    pendingRestorePageRef.current = readingState.page
    zoomAnchorRef.current = null
    pageTextCacheRef.current.clear()
    outlineGenerationRef.current += 1
    metadataGenerationRef.current += 1
    setOutline([])
    setOutlineLoading(false)
    setDocumentMetadata(null)
    setMetadataLoading(false)
    highlightSaveGenerationRef.current += 1
    setHighlights(result.highlights ?? [])
    setPendingHighlightSelection(null)
    setHighlightContextMenu(null)
    setFocusedHighlightId(null)
    setEditingNoteId(null)
    setSelectedHighlightIds(new Set())
    setExportHighlightsOpen(false)
    firstPageProxyRef.current = null
    pdfDocumentRef.current = null
    setVisibleThumbnailPages(new Set())
    nearbyPageNumbersRef.current.clear()
    setRenderedPageNumbers(new Set([1]))
    setPdfDocument(null)
    closeSearch()
    setActiveDocumentId(result.id)
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
    void logMemoryUsage('PDF open started')
  }

  async function refreshRecentFiles() {
    try {
      setRecentFiles(await window.electronAPI.getRecentPdfs())
    } catch (error) {
      setErrorMessage(getErrorMessage(error))
    }
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
              <p className="text-xl font-semibold text-white">Drop PDF to open</p>
              <p className="mt-1 text-sm text-slate-400">The first PDF in the drop will be opened.</p>
            </div>
          </div>
        </div>
      ) : null}

      {pendingHighlightSelection ? (
        <div
          data-highlight-toolbar=""
          role="toolbar"
          aria-label="Text highlight colors"
          onPointerDown={(event) => event.preventDefault()}
          className="fixed z-50 flex h-11 items-center gap-1 rounded-xl border border-slate-600 bg-slate-900/95 p-1.5 shadow-2xl shadow-black/50 backdrop-blur"
          style={{
            left: pendingHighlightSelection.toolbarX,
            top: pendingHighlightSelection.toolbarY,
            transform: 'translateX(-50%)',
          }}
        >
          {HIGHLIGHT_COLOR_ORDER.map((color) => (
            <button
              key={color}
              type="button"
              aria-label={`Highlight ${HIGHLIGHT_COLOR_LABELS[color]}`}
              title={`Highlight ${HIGHLIGHT_COLOR_LABELS[color]}`}
              onClick={() => addHighlight(pendingHighlightSelection, color)}
              className="grid size-8 place-items-center rounded-lg hover:bg-slate-700"
            >
              <span
                className={`size-5 rounded-full border-2 ${highlightColorSwatchClass(color)}`}
              />
            </button>
          ))}
          <span aria-hidden="true" className="mx-1 h-6 w-px bg-slate-600" />
          <button
            type="button"
            title="Remove overlapping highlights"
            onClick={() => removeSelectedHighlights(pendingHighlightSelection)}
            className="h-8 rounded-lg px-2 text-xs font-medium text-red-200 hover:bg-red-500/20"
          >
            Remove
          </button>
        </div>
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
                highlights.find((highlight) => highlight.id === highlightContextMenu.highlightId)
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
            {highlights.find((highlight) => highlight.id === highlightContextMenu.highlightId)?.note
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
                  ['all', `All (${highlights.length})`],
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
                disabled={isExportingHighlights || highlights.length === 0}
                className="rounded-lg bg-blue-500 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-400 disabled:opacity-40"
              >
                {isExportingHighlights ? 'Exporting...' : 'Choose Save Location'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <header
        ref={headerRef}
        className="sticky top-0 z-10 border-b border-slate-700 bg-[#111827]/95 px-3 py-2.5 shadow-lg shadow-slate-950/20 backdrop-blur sm:px-4"
      >
        <div className="flex w-full flex-wrap items-center gap-1.5">
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

          <button
            type="button"
            aria-label="Print PDF"
            title="Print PDF (Ctrl+P)"
            onClick={() => void printCurrentPdf()}
            disabled={!activeDocumentId || isPrinting}
            className="grid size-10 place-items-center rounded-lg border border-slate-700 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <PrintIcon />
          </button>

          <div className="relative">
            <button
              type="button"
              aria-label="Export current page"
              title="Export current page"
              aria-expanded={exportMenuOpen}
              onClick={() => setExportMenuOpen((isOpen) => !isOpen)}
              disabled={!pdfDocument || isExporting}
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
                  onClick={() => void exportCurrentPage('jpeg')}
                  className="block w-full rounded-lg px-3 py-2 text-left text-sm text-slate-200 hover:bg-slate-800"
                >
                  Export as JPEG
                </button>
              </div>
            ) : null}
          </div>

          <ToolbarDivider />

          <button
            type="button"
            aria-label="Previous page"
            title="Previous page (PageUp)"
            onClick={() => goToPage(currentPageRef.current - 1)}
            disabled={numPages === 0 || currentPage === 1}
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
              value={pageInput}
              disabled={numPages === 0}
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
            <span className="whitespace-nowrap text-xs text-slate-400">of {numPages || 0}</span>
          </label>

          <button
            type="button"
            aria-label="Next page"
            title="Next page (PageDown)"
            onClick={() => goToPage(currentPageRef.current + 1)}
            disabled={numPages === 0 || currentPage === numPages}
            className="grid size-10 place-items-center rounded-lg border border-slate-700 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <NextPageIcon />
          </button>

          <ToolbarDivider />

          <button
            type="button"
            aria-label="Zoom out"
            title="Zoom out"
            onClick={() => changeZoom(displayZoomRef.current - 0.25)}
            disabled={displayZoom <= MIN_SCALE}
            className="grid size-10 place-items-center rounded-lg border border-slate-700 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ZoomOutIcon />
          </button>

          <span className="flex h-10 min-w-16 items-center justify-center text-center text-sm">
            {Math.round(displayZoom * 100)}%
          </span>

          <button
            type="button"
            aria-label="Zoom in"
            title="Zoom in"
            onClick={() => changeZoom(displayZoomRef.current + 0.25)}
            disabled={displayZoom >= MAX_SCALE}
            className="grid size-10 place-items-center rounded-lg border border-slate-700 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ZoomInIcon />
          </button>

          <ToolbarDivider />

          <button
            type="button"
            aria-label="Fit width"
            title="Fit width"
            onClick={fitWidth}
            disabled={!pdfFile}
            className={`grid size-10 place-items-center rounded-lg border disabled:cursor-not-allowed disabled:opacity-40 ${
              zoomMode === 'fit-width'
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

          <ToolbarDivider />

          <button
            type="button"
            aria-label="Rotate left"
            title="Rotate left"
            onClick={() => rotatePages(-90)}
            disabled={!pdfDocument}
            className="grid size-10 place-items-center rounded-lg border border-slate-700 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <RotateLeftIcon />
          </button>

          <button
            type="button"
            aria-label="Rotate right"
            title="Rotate right"
            onClick={() => rotatePages(90)}
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
            onClick={() => {
              setSearchOpen(true)
              window.requestAnimationFrame(() => searchInputRef.current?.focus())
            }}
            disabled={!pdfDocument}
            className={`grid size-10 place-items-center rounded-lg border disabled:cursor-not-allowed disabled:opacity-40 ${
              searchOpen
                ? 'border-blue-400 bg-blue-500/15 text-blue-200'
                : 'border-slate-700 hover:bg-slate-800'
            }`}
          >
            <SearchIcon />
          </button>

          <ToolbarDivider />

          <button
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
          </button>

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
            {pdfFile ? (
              <>
                <FileIcon />
                <span title={pdfFile.name} className="min-w-0 truncate font-medium text-slate-200">
                  {pdfFile.name}
                </span>
                <span aria-hidden="true" className="text-slate-600">•</span>
                <span className="shrink-0">
                  {numPages > 0 ? `${numPages} pages` : isLoading ? 'Loading...' : ''}
                </span>
              </>
            ) : (
              'No PDF selected'
            )}
          </div>
        </div>

        {shortcutHelpOpen ? (
          <div className="absolute right-5 top-full z-30 mt-2 w-80 rounded-xl border border-slate-700 bg-slate-900 p-4 shadow-2xl shadow-black/50">
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

            <span className="min-w-24 text-center text-sm text-slate-300" aria-live="polite">
              {isSearching
                ? searchProgress
                  ? `Searching page ${searchProgress.processed} of ${searchProgress.total}...`
                  : 'Searching...'
                : searchQuery.trim() && searchMatches.length === 0
                  ? 'No results'
                  : searchMatches.length > 0
                    ? `Match ${selectedMatchIndex + 1} of ${searchMatches.length}`
                    : ''}
            </span>

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
        {loadingProgress ? (
          <div
            role="status"
            className="mb-3 flex items-center gap-3 rounded-xl border border-blue-500/30 bg-blue-950/35 px-4 py-3 text-sm text-blue-100"
          >
            <span className="size-4 animate-spin rounded-full border-2 border-blue-300/30 border-t-blue-300" />
            <div>
              <p className="font-medium">{loadingProgress}</p>
              {numPages >= 200 ? (
                <p className="mt-0.5 text-xs text-blue-200/70">
                  Large document mode is rendering only pages near the viewport.
                </p>
              ) : null}
            </div>
          </div>
        ) : null}

        <div className="flex items-start gap-3">
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
                  highlights={highlights}
                  onNavigate={navigateToHighlight}
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

          <div className="min-w-0 flex-1">
            {!pdfFile ? (
              <div className="rounded-2xl border border-dashed border-slate-600 bg-[#111827] px-8 py-16 text-center text-slate-300 shadow-xl shadow-slate-950/20">
                Click Open PDF and choose a local PDF file.
              </div>
            ) : (
              <div
                className="overflow-auto rounded-xl p-3 shadow-inner shadow-black/20 transition-colors duration-200 sm:p-4"
                style={{ backgroundColor: VIEWER_BACKGROUNDS[viewerBackground] }}
              >
                <div ref={viewerRef} className="min-w-0">
                  <Document
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
        </div>
      </section>

      <footer
        role="status"
        aria-live="polite"
        className="fixed inset-x-0 bottom-0 z-40 flex h-8 items-center justify-end gap-1 border-t border-slate-700 bg-[#111827]/98 px-3 text-[11px] font-medium text-slate-300 shadow-[0_-4px_14px_rgba(2,6,23,0.18)] backdrop-blur sm:px-4"
      >
        {pdfFile ? (
          <>
            <StatusItem>Page {currentPage} of {numPages || 0}</StatusItem>
            <StatusDivider />
            <StatusItem>{Math.round(displayZoom * 100)}%</StatusItem>
            <StatusDivider />
            <StatusItem>{zoomMode === 'fit-width' ? 'Fit Width' : 'Manual Zoom'}</StatusItem>
            <StatusDivider />
            <StatusItem>{VIEWER_BACKGROUND_LABELS[viewerBackground]}</StatusItem>
            {searchOpen ? (
              <>
                <StatusDivider />
                <StatusItem>
                  {isSearching
                    ? searchProgress
                      ? `Searching ${searchProgress.processed} of ${searchProgress.total}`
                      : 'Searching...'
                    : searchMatches.length > 0
                      ? `Match ${selectedMatchIndex + 1} of ${searchMatches.length}`
                      : searchQuery.trim()
                        ? 'No results'
                        : 'Search active'}
                </StatusItem>
              </>
            ) : null}
          </>
        ) : (
          <StatusItem>No PDF open</StatusItem>
        )}
      </footer>
    </main>
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

      {highlights.length === 0 ? (
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
}: {
  file: PdfFile
  totalPages: number
  metadata: DocumentMetadata | null
  loading: boolean
}) {
  const rows = [
    ['File name', file.name],
    ['File path', file.filePath],
    ['File size', formatFileSize(file.fileSize)],
    ['Total pages', String(totalPages)],
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

function PreviousPageIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-5" fill="none" aria-hidden="true">
      <path d="m15 5-7 7 7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function NextPageIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-5" fill="none" aria-hidden="true">
      <path d="m9 5 7 7-7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function SidebarToggleIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg viewBox="0 0 20 20" className="size-4" fill="none" aria-hidden="true">
      <path
        d={expanded ? 'm12.5 5-5 5 5 5' : 'm7.5 5 5 5-5 5'}
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function ZoomOutIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-5" fill="none" aria-hidden="true">
      <circle cx="10.5" cy="10.5" r="6.5" stroke="currentColor" strokeWidth="1.8" />
      <path d="M7.5 10.5h6M15.3 15.3 21 21" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

function ZoomInIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-5" fill="none" aria-hidden="true">
      <circle cx="10.5" cy="10.5" r="6.5" stroke="currentColor" strokeWidth="1.8" />
      <path d="M7.5 10.5h6M10.5 7.5v6M15.3 15.3 21 21" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

function FitWidthIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-5" fill="none" aria-hidden="true">
      <path d="M3 5v14M21 5v14M7 12h10M7 12l3-3M7 12l3 3M17 12l-3-3M17 12l-3 3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function SinglePageIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-5" fill="none" aria-hidden="true">
      <rect x="5" y="3" width="14" height="18" rx="1.5" stroke="currentColor" strokeWidth="1.8" />
      <path d="M8 7h8M8 10h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

function ContinuousScrollIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-5" fill="none" aria-hidden="true">
      <rect x="6" y="2.5" width="12" height="8" rx="1" stroke="currentColor" strokeWidth="1.6" />
      <rect x="6" y="13.5" width="12" height="8" rx="1" stroke="currentColor" strokeWidth="1.6" />
      <path d="M12 9v6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

function BackgroundIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4 shrink-0" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.8" />
      <path d="M12 3.5a8.5 8.5 0 0 0 0 17v-17Z" fill="currentColor" opacity=".65" />
    </svg>
  )
}

function RotateLeftIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-5" fill="none" aria-hidden="true">
      <path d="M5 8V3m0 0h5M5 3l3.2 3.2A8 8 0 1 1 4 13" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function RotateRightIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-5" fill="none" aria-hidden="true">
      <path d="M19 8V3m0 0h-5m5-0-3.2 3.2A8 8 0 1 0 20 13" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-5" fill="none" aria-hidden="true">
      <circle cx="10.5" cy="10.5" r="6.5" stroke="currentColor" strokeWidth="1.8" />
      <path d="m15.3 15.3 5.2 5.2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

function ThumbnailsIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-5" fill="none" aria-hidden="true">
      <rect x="3" y="4" width="5" height="16" rx="1" stroke="currentColor" strokeWidth="1.8" />
      <rect x="11" y="4" width="10" height="7" rx="1" stroke="currentColor" strokeWidth="1.8" />
      <rect x="11" y="14" width="10" height="6" rx="1" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  )
}

function BookmarkIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-5" fill="none" aria-hidden="true">
      <path d="M6 4.5A1.5 1.5 0 0 1 7.5 3h9A1.5 1.5 0 0 1 18 4.5V21l-6-3.8L6 21V4.5Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
    </svg>
  )
}

function HighlightsIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-5" fill="none" aria-hidden="true">
      <path
        d="m5 15 7.8-7.8 4 4L9 19H5v-4ZM14.5 5.5l1.8-1.8a1.4 1.4 0 0 1 2 0l2 2a1.4 1.4 0 0 1 0 2l-1.8 1.8-4-4Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path d="M4 21h16" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  )
}

function InfoIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-5" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8" />
      <path d="M12 10.5V17M12 7.2v.1" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

function HelpIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-5" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8" />
      <path d="M9.8 9a2.4 2.4 0 1 1 3.4 2.2c-.8.4-1.2.9-1.2 1.8v.2M12 17.2v.1" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

function PrintIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-5" fill="none" aria-hidden="true">
      <path d="M7 9V3h10v6M7 17H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M7 14h10v7H7v-7Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M17.5 12h.01" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  )
}

function ExportIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-5" fill="none" aria-hidden="true">
      <path d="M12 3v12M7.5 7.5 12 3l4.5 4.5M5 14v6h14v-6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function FileIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4 shrink-0 text-blue-300" fill="none" aria-hidden="true">
      <path d="M6 3h8l4 4v14H6V3Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
      <path d="M14 3v5h4M9 13h6M9 16h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

function FullscreenIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-5" fill="none" aria-hidden="true">
      <path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function ExitFullscreenIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-5" fill="none" aria-hidden="true">
      <path d="M4 9h5V4M20 9h-5V4M4 15h5v5M20 15h-5v5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function DropPdfIcon() {
  return (
    <svg viewBox="0 0 32 32" className="size-9" fill="none" aria-hidden="true">
      <path d="M8 3h11l6 6v20H8V3Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      <path d="M19 3v7h6M16 14v10M12 20l4 4 4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
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

function highlightColorSwatchClass(color: HighlightColor) {
  return color === 'yellow'
    ? 'border-amber-100 bg-amber-300'
    : color === 'green'
      ? 'border-emerald-100 bg-emerald-300'
      : color === 'blue'
        ? 'border-sky-100 bg-sky-300'
        : 'border-violet-100 bg-violet-300'
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
