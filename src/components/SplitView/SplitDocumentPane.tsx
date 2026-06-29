import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Document, Page, Thumbnail } from 'react-pdf'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import { FillSignOverlay } from '../Viewer/FillSignOverlay'
import { HighlightOverlay } from '../Viewer/HighlightOverlay'
import { HighlightSelectionToolbar } from '../Viewer/HighlightSelectionToolbar'
import { SignaturePlacementOverlay } from '../Viewer/SignaturePlacementOverlay'
import { PdfPaneHeader, PdfPaneToolbar } from './PdfPaneChrome'
import type { HighlightColor, PdfHighlight } from '../../types/highlights'
import type {
  FillSignDateFormat,
  FillSignField,
  FillSignTool,
  SavedSignature,
  SignaturePlacement,
} from '../../types/signatures'
import { indexPdfForGlobalSearch } from '../../services/globalSearchIndexer'
import { extractAndStoreReference } from '../../services/referenceExtractor'

export type SplitSidebarTab = 'pages' | 'bookmarks' | 'highlights'

export type SplitPaneState = {
  page: number
  pageOffset: number
  zoom: number
  fitMode: boolean
  rotation: number
  searchOpen: boolean
  searchQuery: string
  selectedMatchIndex: number
  sidebarOpen: boolean
  sidebarTab: SplitSidebarTab
  sidebarWidth: number
}

export type SplitPaneDocument = {
  id: string
  name: string
  filePath: string
  fileSize: number
  modifiedAt: number
  dataUrl: string
  highlights: PdfHighlight[]
  signaturePlacements: SignaturePlacement[]
  fillSignFields: FillSignField[]
}

export type SplitScrollPosition = {
  page: number
  offset: number
  token: number
}

export type SplitDocumentPaneHandle = {
  focus: () => void
  goToPage: (page: number) => void
  nextPage: () => void
  previousPage: () => void
  firstPage: () => void
  lastPage: () => void
  zoomBy: (amount: number) => void
  resetZoom: () => void
  fitWidth: () => void
  rotateBy: (amount: -90 | 90) => void
  openSearch: () => void
  search: (query: string) => void
  navigateToSearchResult: (pageNumber: number, query: string) => void
  exportPage: (format: 'png' | 'jpeg') => Promise<void>
  highlightSelection: (color: HighlightColor) => void
  navigateToHighlight: (highlightId: string, pageNumber: number) => void
  getState: () => SplitPaneState
  applyScrollPosition: (position: SplitScrollPosition) => void
}

type SearchMatch = {
  index: number
  pageNumber: number
  start: number
  end: number
}

type CachedPageText = {
  text: string
  starts: number[]
}

type OutlineItem = {
  title: string
  dest: string | unknown[] | null
  items: OutlineItem[]
}

type Props = {
  paneLabel: string
  document: SplitPaneDocument
  initialState: SplitPaneState
  active: boolean
  viewerBackground: string
  onActivate: () => void
  onCloseSplit: () => void
  onDropTab: (tabId: string) => void
  onStateChange: (state: SplitPaneState) => void
  onHighlightsChange: (documentId: string, highlights: PdfHighlight[]) => void
  signatures: SavedSignature[]
  signingSignature: SavedSignature | null
  selectedSignaturePlacementId: string | null
  onSignaturePlacementsChange: (documentId: string, placements: SignaturePlacement[]) => void
  onSignaturePlacementSelect: (placementId: string | null) => void
  activeFillSignTool: FillSignTool | null
  selectedFillSignFieldId: string | null
  fillSignDateFormat: FillSignDateFormat
  fillSignInitials: string
  onFillSignFieldsChange: (documentId: string, fields: FillSignField[]) => void
  onFillSignFieldSelect: (fieldId: string | null) => void
  onFinishFillSignTool: () => void
  onFinishSigning: () => void
  onSearchStatus: (status: { current: number; total: number; query: string }) => void
  onViewStatus: (status: { page: number; totalPages: number; zoom: number; fitMode: boolean }) => void
  onScrollPosition: (position: Omit<SplitScrollPosition, 'token'>) => void
}

const MIN_ZOOM = 0.25
const MAX_ZOOM = 4
const PAGE_OVERSCAN = 1
const DEFAULT_PAGE_WIDTH = 612
const DEFAULT_PAGE_HEIGHT = 792
const COLORS: Array<{ color: HighlightColor; label: string; className: string }> = [
  { color: 'yellow', label: 'Amber', className: 'bg-amber-300' },
  { color: 'green', label: 'Mint', className: 'bg-emerald-300' },
  { color: 'blue', label: 'Sky Blue', className: 'bg-sky-300' },
  { color: 'purple', label: 'Purple', className: 'bg-violet-300' },
]

export const SplitDocumentPane = forwardRef<SplitDocumentPaneHandle, Props>(
  function SplitDocumentPane(
    {
      paneLabel,
      document: pdfFile,
      initialState,
      active,
      viewerBackground,
      onActivate,
      onCloseSplit,
      onDropTab,
      onStateChange,
      onHighlightsChange,
      signatures,
      signingSignature,
      selectedSignaturePlacementId,
      onSignaturePlacementsChange,
      onSignaturePlacementSelect,
      activeFillSignTool,
      selectedFillSignFieldId,
      fillSignDateFormat,
      fillSignInitials,
      onFillSignFieldsChange,
      onFillSignFieldSelect,
      onFinishFillSignTool,
      onFinishSigning,
      onSearchStatus,
      onViewStatus,
      onScrollPosition,
    },
    ref,
  ) {
    const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
    const [numPages, setNumPages] = useState(0)
    const [currentPage, setCurrentPage] = useState(Math.max(1, initialState.page))
    const [pageInput, setPageInput] = useState(String(Math.max(1, initialState.page)))
    const [zoom, setZoom] = useState(clampZoom(initialState.zoom))
    const [fitMode, setFitMode] = useState(initialState.fitMode)
    const [rotation, setRotation] = useState(normalizeRotation(initialState.rotation))
    const [sidebarOpen, setSidebarOpen] = useState(initialState.sidebarOpen)
    const [sidebarTab, setSidebarTab] = useState<SplitSidebarTab>(initialState.sidebarTab)
    const [sidebarWidth] = useState(Math.min(320, Math.max(180, initialState.sidebarWidth || 220)))
    const [searchOpen, setSearchOpen] = useState(initialState.searchOpen)
    const [searchQuery, setSearchQuery] = useState(initialState.searchQuery)
    const [searchMatches, setSearchMatches] = useState<SearchMatch[]>([])
    const [selectedMatchIndex, setSelectedMatchIndex] = useState(-1)
    const [isSearching, setIsSearching] = useState(false)
    const [renderedPages, setRenderedPages] = useState<Set<number>>(
      () => new Set([Math.max(1, initialState.page)]),
    )
    const [pageWidth, setPageWidth] = useState(DEFAULT_PAGE_WIDTH)
    const [pageHeight, setPageHeight] = useState(DEFAULT_PAGE_HEIGHT)
    const [contentWidth, setContentWidth] = useState(0)
    const highlights = pdfFile.highlights
    const signaturePlacements = pdfFile.signaturePlacements
    const fillSignFields = pdfFile.fillSignFields
    const [outline, setOutline] = useState<OutlineItem[]>([])
    const [outlineLoading, setOutlineLoading] = useState(false)
    const [selectionToolbar, setSelectionToolbar] = useState<{
      pageNumber: number
      text: string
      rectangles: Array<{ x: number; y: number; width: number; height: number }>
      x: number
      y: number
    } | null>(null)
    const [focusedHighlightId, setFocusedHighlightId] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)
    const rootRef = useRef<HTMLDivElement>(null)
    const scrollRef = useRef<HTMLDivElement>(null)
    const contentRef = useRef<HTMLDivElement>(null)
    const searchInputRef = useRef<HTMLInputElement>(null)
    const pageRefs = useRef(new Map<number, HTMLDivElement>())
    const pageTextCache = useRef(new Map<number, CachedPageText>())
    const searchGeneration = useRef(0)
    const currentPageRef = useRef(currentPage)
    const scrollTokenRef = useRef(0)
    const suppressScrollSyncRef = useRef(false)
    const restoredRef = useRef(false)
    const initialSelectedMatchRef = useRef(initialState.selectedMatchIndex)
    const pendingSearchPageRef = useRef<number | null>(null)
    const signaturePlacementSaveTimeoutRef = useRef(0)
    const signaturePlacementSaveGenerationRef = useRef(0)
    const fillSignSaveTimeoutRef = useRef(0)
    const fillSignSaveGenerationRef = useRef(0)
    const fitZoom = clampZoom(
      contentWidth > 0 && pageWidth > 0 ? (contentWidth - 28) / pageWidth : zoom,
    )
    const renderZoom = fitMode ? fitZoom : zoom

    const matchesByPage = useMemo(() => {
      const grouped = new Map<number, SearchMatch[]>()
      for (const match of searchMatches) {
        const matches = grouped.get(match.pageNumber) ?? []
        matches.push(match)
        grouped.set(match.pageNumber, matches)
      }
      return grouped
    }, [searchMatches])

    const highlightsByPage = useMemo(() => {
      const grouped = new Map<number, PdfHighlight[]>()
      for (const highlight of highlights) {
        const pageHighlights = grouped.get(highlight.pageNumber) ?? []
        pageHighlights.push(highlight)
        grouped.set(highlight.pageNumber, pageHighlights)
      }
      return grouped
    }, [highlights])

    const signaturePlacementsByPage = useMemo(() => {
      const grouped = new Map<number, SignaturePlacement[]>()
      for (const placement of signaturePlacements) {
        const pagePlacements = grouped.get(placement.pageNumber) ?? []
        pagePlacements.push(placement)
        grouped.set(placement.pageNumber, pagePlacements)
      }
      return grouped
    }, [signaturePlacements])
    const fillSignFieldsByPage = useMemo(() => {
      const grouped = new Map<number, FillSignField[]>()
      for (const field of fillSignFields) {
        const pageFields = grouped.get(field.pageNumber) ?? []
        pageFields.push(field)
        grouped.set(field.pageNumber, pageFields)
      }
      return grouped
    }, [fillSignFields])

    const renderSearchText = useCallback(
      ({ pageNumber, itemIndex, str }: { pageNumber: number; itemIndex: number; str: string }) => {
        const pageText = pageTextCache.current.get(pageNumber)
        const itemStart = pageText?.starts[itemIndex]
        const pageMatches = matchesByPage.get(pageNumber)
        if (!pageText || itemStart === undefined || !pageMatches?.length) {
          return escapeHtml(str)
        }

        const itemEnd = itemStart + str.length
        const matches = pageMatches.filter((match) => match.start < itemEnd && match.end > itemStart)
        if (matches.length === 0) {
          return escapeHtml(str)
        }

        let cursor = 0
        let output = ''
        for (const match of matches) {
          const start = Math.max(0, match.start - itemStart)
          const end = Math.min(str.length, match.end - itemStart)
          output += escapeHtml(str.slice(cursor, start))
          output += `<mark class="pdf-search-match" data-split-search-match="${match.index}">${escapeHtml(str.slice(start, end))}</mark>`
          cursor = end
        }
        return output + escapeHtml(str.slice(cursor))
      },
      [matchesByPage],
    )

    function getState(): SplitPaneState {
      const pageElement = pageRefs.current.get(currentPageRef.current)
      const scrollBounds = scrollRef.current?.getBoundingClientRect()
      const pageBounds = pageElement?.getBoundingClientRect()
      const pageOffset = pageBounds && scrollBounds
        ? Math.min(1, Math.max(0, (scrollBounds.top - pageBounds.top) / pageBounds.height))
        : 0
      return {
        page: currentPageRef.current,
        pageOffset,
        zoom: renderZoom,
        fitMode,
        rotation,
        searchOpen,
        searchQuery,
        selectedMatchIndex,
        sidebarOpen,
        sidebarTab,
        sidebarWidth,
      }
    }

    function goToPage(requestedPage: number, behavior: ScrollBehavior = 'smooth') {
      if (numPages === 0) {
        return
      }
      const pageNumber = Math.min(numPages, Math.max(1, Math.trunc(requestedPage)))
      currentPageRef.current = pageNumber
      setCurrentPage(pageNumber)
      setPageInput(String(pageNumber))
      setRenderedPages((pages) => addPageWindow(pages, pageNumber, numPages))
      window.requestAnimationFrame(() => {
        const page = pageRefs.current.get(pageNumber)
        const scroller = scrollRef.current
        if (page && scroller) {
          scroller.scrollTo({
            top: scroller.scrollTop + page.getBoundingClientRect().top - scroller.getBoundingClientRect().top,
            behavior,
          })
        }
      })
    }

    function changeZoom(nextZoom: number) {
      setFitMode(false)
      setZoom(clampZoom(nextZoom))
    }

    function selectMatch(direction: -1 | 1) {
      if (searchMatches.length === 0) {
        return
      }
      const index = (selectedMatchIndex + direction + searchMatches.length) % searchMatches.length
      setSelectedMatchIndex(index)
      goToPage(searchMatches[index].pageNumber, 'auto')
    }

    function applyScrollPosition(position: SplitScrollPosition) {
      if (position.token === scrollTokenRef.current || numPages === 0) {
        return
      }
      scrollTokenRef.current = position.token
      suppressScrollSyncRef.current = true
      const pageNumber = Math.min(numPages, Math.max(1, position.page))
      setRenderedPages((pages) => addPageWindow(pages, pageNumber, numPages))
      currentPageRef.current = pageNumber
      setCurrentPage(pageNumber)
      setPageInput(String(pageNumber))
      window.requestAnimationFrame(() => {
        const page = pageRefs.current.get(pageNumber)
        const scroller = scrollRef.current
        if (page && scroller) {
          scroller.scrollTop +=
            page.getBoundingClientRect().top -
            scroller.getBoundingClientRect().top +
            page.getBoundingClientRect().height * position.offset
        }
        window.setTimeout(() => {
          suppressScrollSyncRef.current = false
        }, 80)
      })
    }

    function navigateToHighlight(highlightId: string, pageNumber: number, attempt = 0) {
      goToPage(pageNumber, 'auto')
      window.requestAnimationFrame(() => {
        const page = pageRefs.current.get(pageNumber)
        const target = page?.querySelector<HTMLElement>(`[data-highlight-id="${CSS.escape(highlightId)}"]`)
        const scroller = scrollRef.current
        if (!target || !scroller) {
          if (attempt < 90) window.setTimeout(() => navigateToHighlight(highlightId, pageNumber, attempt + 1), 16)
          return
        }
        const targetBounds = target.getBoundingClientRect()
        const scrollBounds = scroller.getBoundingClientRect()
        scroller.scrollTo({
          top: scroller.scrollTop + targetBounds.top - scrollBounds.top - Math.max(24, (scrollBounds.height - targetBounds.height) / 2),
          behavior: 'smooth',
        })
        window.setTimeout(() => {
          setFocusedHighlightId(highlightId)
          window.setTimeout(() => setFocusedHighlightId(null), 1100)
        }, 250)
      })
    }

    useImperativeHandle(ref, () => ({
      focus: () => rootRef.current?.focus(),
      goToPage,
      nextPage: () => goToPage(currentPageRef.current + 1),
      previousPage: () => goToPage(currentPageRef.current - 1),
      firstPage: () => goToPage(1),
      lastPage: () => goToPage(numPages),
      zoomBy: (amount) => changeZoom(zoom + amount),
      resetZoom: () => changeZoom(1),
      fitWidth: () => setFitMode(true),
      rotateBy: (amount) => setRotation((value) => normalizeRotation(value + amount)),
      openSearch: () => {
        setSearchOpen(true)
        window.requestAnimationFrame(() => searchInputRef.current?.focus())
      },
      search: (query) => {
        setSearchOpen(true)
        setSearchQuery(query)
      },
      navigateToSearchResult: (pageNumber, query) => {
        pendingSearchPageRef.current = pageNumber
        setSearchOpen(true)
        setSearchQuery(query)
        goToPage(pageNumber, 'auto')
      },
      exportPage: exportCurrentPage,
      highlightSelection: addHighlight,
      navigateToHighlight,
      getState,
      applyScrollPosition,
    }))

    useEffect(() => {
      currentPageRef.current = currentPage
    }, [currentPage])

    useEffect(() => {
      onViewStatus({ page: currentPage, totalPages: numPages, zoom: renderZoom, fitMode })
    }, [currentPage, fitMode, numPages, onViewStatus, renderZoom])

    useEffect(() => {
      const observer = new ResizeObserver(([entry]) => setContentWidth(entry.contentRect.width))
      if (contentRef.current) {
        observer.observe(contentRef.current)
      }
      return () => observer.disconnect()
    }, [])

    useEffect(() => {
      const timeout = window.setTimeout(() => onStateChange(getState()), 180)
      return () => window.clearTimeout(timeout)
    })

    useEffect(() => {
      if (!pdf) {
        return
      }
      const timeout = window.setTimeout(() => {
        setOutlineLoading(true)
        void pdf.getOutline()
          .then((items) => setOutline((items ?? []) as OutlineItem[]))
          .catch((reason) => setError(getErrorMessage(reason)))
          .finally(() => setOutlineLoading(false))
      }, 0)
      return () => window.clearTimeout(timeout)
    }, [pdf])

    useEffect(() => {
      if (!pdf) return
      let cancelled = false
      void pdf.getPage(1).then((page) => {
        if (cancelled) return
        const viewport = page.getViewport({
          scale: 1,
          rotation: normalizeRotation(page.rotate + rotation),
        })
        setPageWidth(viewport.width)
        setPageHeight(viewport.height)
      })
      return () => {
        cancelled = true
      }
    }, [pdf, rotation])

    useEffect(() => {
      if (!pdf) return
      const controller = new AbortController()
      const timeout = window.setTimeout(() => {
        void indexPdfForGlobalSearch(pdf, {
          id: pdfFile.id,
          name: pdfFile.name,
          filePath: pdfFile.filePath,
          fileSize: pdfFile.fileSize,
          modifiedAt: pdfFile.modifiedAt,
        }, controller.signal).catch((reason) => {
          if (!controller.signal.aborted) {
            console.warn('Split pane global indexing failed:', getErrorMessage(reason))
          }
        })
      }, 500)
      return () => {
        window.clearTimeout(timeout)
        controller.abort()
      }
    }, [pdf, pdfFile.filePath, pdfFile.fileSize, pdfFile.id, pdfFile.modifiedAt, pdfFile.name])

    useEffect(() => {
      const query = searchQuery.trim()
      const generation = ++searchGeneration.current
      if (!pdf || !searchOpen || !query) {
        const clearTimeoutId = window.setTimeout(() => {
          setSearchMatches([])
          setSelectedMatchIndex(-1)
          setIsSearching(false)
          onSearchStatus({ current: 0, total: 0, query })
        }, 0)
        return () => window.clearTimeout(clearTimeoutId)
      }

      const timeout = window.setTimeout(() => {
        setIsSearching(true)
        void (async () => {
          const matches: SearchMatch[] = []
          const normalizedQuery = query.toLocaleLowerCase()
          try {
            for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
              const pageText = await getPageText(pdf, pageNumber, pageTextCache.current)
              if (generation !== searchGeneration.current) {
                return
              }
              const normalizedText = pageText.text.toLocaleLowerCase()
              let start = normalizedText.indexOf(normalizedQuery)
              while (start >= 0) {
                matches.push({
                  index: matches.length,
                  pageNumber,
                  start,
                  end: start + normalizedQuery.length,
                })
                start = normalizedText.indexOf(normalizedQuery, start + normalizedQuery.length)
              }
              if (pageNumber % 8 === 0) {
                await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
              }
            }
            if (generation === searchGeneration.current) {
              setSearchMatches(matches)
              const requestedPage = pendingSearchPageRef.current
              const requestedIndex = requestedPage === null
                ? -1
                : matches.findIndex((match) => match.pageNumber === requestedPage)
              const restoredIndex = requestedIndex >= 0
                ? requestedIndex
                : Math.min(matches.length - 1, Math.max(0, initialSelectedMatchRef.current))
              pendingSearchPageRef.current = null
              setSelectedMatchIndex(matches.length ? restoredIndex : -1)
              setIsSearching(false)
              onSearchStatus({
                current: matches.length ? restoredIndex + 1 : 0,
                total: matches.length,
                query,
              })
            }
          } catch (reason) {
            if (generation === searchGeneration.current) {
              setIsSearching(false)
              setError(`Search failed: ${getErrorMessage(reason)}`)
            }
          }
        })()
      }, 180)
      return () => window.clearTimeout(timeout)
    }, [onSearchStatus, pdf, searchOpen, searchQuery])

    useEffect(() => {
      const root = rootRef.current
      root?.querySelectorAll('.pdf-search-selected').forEach((element) => {
        element.classList.remove('pdf-search-selected')
      })
      if (selectedMatchIndex < 0) {
        return
      }
      window.requestAnimationFrame(() => {
        root?.querySelectorAll(`[data-split-search-match="${selectedMatchIndex}"]`).forEach(
          (element) => element.classList.add('pdf-search-selected'),
        )
      })
      onSearchStatus({
        current: selectedMatchIndex + 1,
        total: searchMatches.length,
        query: searchQuery.trim(),
      })
    }, [onSearchStatus, searchMatches.length, searchQuery, selectedMatchIndex])

    useEffect(() => {
      if (!pdf || restoredRef.current || numPages === 0) {
        return
      }
      restoredRef.current = true
      const pageNumber = Math.min(numPages, Math.max(1, initialState.page))
      setRenderedPages((pages) => addPageWindow(pages, pageNumber, numPages))
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          const page = pageRefs.current.get(pageNumber)
          const scroller = scrollRef.current
          if (page && scroller) {
            scroller.scrollTop +=
              page.getBoundingClientRect().top -
              scroller.getBoundingClientRect().top +
              page.getBoundingClientRect().height * initialState.pageOffset
          }
        })
      })
    }, [initialState.page, initialState.pageOffset, numPages, pdf, renderZoom])

    useEffect(() => {
      function handlePointerUp(event: PointerEvent) {
        if (event.button !== 0 || !rootRef.current?.contains(event.target as Node)) {
          return
        }
        window.requestAnimationFrame(() => {
          const selection = window.getSelection()
          if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
            return
          }
          const range = selection.getRangeAt(0)
          const node = range.commonAncestorContainer instanceof Element
            ? range.commonAncestorContainer
            : range.commonAncestorContainer.parentElement
          const page = node?.closest<HTMLElement>('[data-split-page]')
          const surface = page?.querySelector<HTMLElement>('[data-split-page-surface]')
          if (!page || !surface) {
            return
          }
          const bounds = surface.getBoundingClientRect()
          const rectangles = Array.from(range.getClientRects()).flatMap((rectangle) => {
            const left = Math.max(bounds.left, rectangle.left)
            const top = Math.max(bounds.top, rectangle.top)
            const right = Math.min(bounds.right, rectangle.right)
            const bottom = Math.min(bounds.bottom, rectangle.bottom)
            return right > left && bottom > top
              ? [{
                  x: (left - bounds.left) / bounds.width,
                  y: (top - bounds.top) / bounds.height,
                  width: (right - left) / bounds.width,
                  height: (bottom - top) / bounds.height,
                }]
              : []
          })
          const text = selection.toString().trim()
          if (text && rectangles.length) {
            const lastRect = range.getBoundingClientRect()
            setSelectionToolbar({
              pageNumber: Number(page.dataset.splitPage),
              text,
              rectangles,
              x: Math.min(window.innerWidth - 170, Math.max(170, (lastRect.left + lastRect.right) / 2)),
              y: Math.max(12, lastRect.top - 48),
            })
          }
        })
      }
      window.addEventListener('pointerup', handlePointerUp)
      return () => window.removeEventListener('pointerup', handlePointerUp)
    }, [])

    useEffect(() => {
      if (!active || !selectedFillSignFieldId) return
      const activeFieldId = selectedFillSignFieldId
      function handleKeyDown(event: KeyboardEvent) {
        if (isEditableKeyboardTarget(event.target)) {
          return
        }
        if (event.key === 'Escape') {
          event.preventDefault()
          onFillSignFieldSelect(null)
          onFinishFillSignTool()
          return
        }
        if (event.key === 'Delete' || event.key === 'Backspace') {
          event.preventDefault()
          deleteFillSignField(activeFieldId)
          return
        }
        if (event.ctrlKey && !event.shiftKey && event.key.toLowerCase() === 'd') {
          event.preventDefault()
          duplicateFillSignField(activeFieldId)
        }
      }
      window.addEventListener('keydown', handleKeyDown)
      return () => window.removeEventListener('keydown', handleKeyDown)
    })

    useEffect(() => {
      if (!active || !selectedSignaturePlacementId) return
      const activePlacementId = selectedSignaturePlacementId
      function handleKeyDown(event: KeyboardEvent) {
        if (event.key === 'Escape') {
          event.preventDefault()
          onSignaturePlacementSelect(null)
          onFinishSigning()
          return
        }
        if (event.key === 'Delete' || event.key === 'Backspace') {
          event.preventDefault()
          deleteSignaturePlacement(activePlacementId)
          return
        }
        if (event.ctrlKey && !event.shiftKey && event.key.toLowerCase() === 'd') {
          event.preventDefault()
          duplicateSignaturePlacement(activePlacementId)
        }
      }
      window.addEventListener('keydown', handleKeyDown)
      return () => window.removeEventListener('keydown', handleKeyDown)
    })

    async function saveHighlights(nextHighlights: PdfHighlight[]) {
      onHighlightsChange(pdfFile.id, nextHighlights)
      try {
        const saved = await window.electronAPI.savePdfHighlights(
          { id: pdfFile.id, fileSize: pdfFile.fileSize, modifiedAt: pdfFile.modifiedAt },
          nextHighlights,
        )
        onHighlightsChange(pdfFile.id, saved)
      } catch (reason) {
        setError(`Highlight save failed: ${getErrorMessage(reason)}`)
      }
    }

    function saveSignaturePlacements(nextPlacements: SignaturePlacement[]) {
      const documentPlacements = nextPlacements.map((placement) => ({
        ...placement,
        documentId: pdfFile.id,
      }))
      const generation = ++signaturePlacementSaveGenerationRef.current
      onSignaturePlacementsChange(pdfFile.id, documentPlacements)
      window.clearTimeout(signaturePlacementSaveTimeoutRef.current)
      signaturePlacementSaveTimeoutRef.current = window.setTimeout(() => {
        void window.electronAPI
          .savePdfSignaturePlacements(
            { id: pdfFile.id, fileSize: pdfFile.fileSize, modifiedAt: pdfFile.modifiedAt },
            documentPlacements,
          )
          .then((saved) => {
            if (signaturePlacementSaveGenerationRef.current === generation) {
              onSignaturePlacementsChange(pdfFile.id, saved)
            }
          })
          .catch((reason) => {
            if (signaturePlacementSaveGenerationRef.current === generation) {
              setError(`Signature save failed: ${getErrorMessage(reason)}`)
              onSignaturePlacementsChange(pdfFile.id, signaturePlacements)
            }
          })
      }, 180)
    }

    function addSignaturePlacement(placement: SignaturePlacement) {
      saveSignaturePlacements([...signaturePlacements, placement])
      onSignaturePlacementSelect(placement.id)
    }

    function updateSignaturePlacement(placementId: string, patch: Partial<SignaturePlacement>) {
      saveSignaturePlacements(
        signaturePlacements.map((placement) =>
          placement.id === placementId ? { ...placement, ...patch } : placement,
        ),
      )
    }

    function deleteSignaturePlacement(placementId: string) {
      if (!window.confirm('Delete this placed signature?')) return
      saveSignaturePlacements(signaturePlacements.filter((placement) => placement.id !== placementId))
      onSignaturePlacementSelect(null)
    }

    function duplicateSignaturePlacement(placementId: string) {
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
      saveSignaturePlacements([...signaturePlacements, duplicate])
      onSignaturePlacementSelect(duplicate.id)
    }

    function bringSignatureForward(placementId: string) {
      const index = signaturePlacements.findIndex((placement) => placement.id === placementId)
      if (index < 0 || index === signaturePlacements.length - 1) return
      const next = [...signaturePlacements]
      ;[next[index], next[index + 1]] = [next[index + 1], next[index]]
      saveSignaturePlacements(next)
    }

    function sendSignatureBackward(placementId: string) {
      const index = signaturePlacements.findIndex((placement) => placement.id === placementId)
      if (index <= 0) return
      const next = [...signaturePlacements]
      ;[next[index], next[index - 1]] = [next[index - 1], next[index]]
      saveSignaturePlacements(next)
    }

    function saveFillSignFields(nextFields: FillSignField[]) {
      const documentFields = nextFields.map((field) => ({
        ...field,
        documentId: pdfFile.id,
      }))
      const generation = ++fillSignSaveGenerationRef.current
      onFillSignFieldsChange(pdfFile.id, documentFields)
      window.clearTimeout(fillSignSaveTimeoutRef.current)
      fillSignSaveTimeoutRef.current = window.setTimeout(() => {
        void window.electronAPI
          .savePdfFillSignFields(
            { id: pdfFile.id, fileSize: pdfFile.fileSize, modifiedAt: pdfFile.modifiedAt },
            documentFields,
          )
          .then((saved) => {
            if (fillSignSaveGenerationRef.current === generation) {
              onFillSignFieldsChange(pdfFile.id, saved)
            }
          })
          .catch((reason) => {
            if (fillSignSaveGenerationRef.current === generation) {
              setError(`Fill & Sign save failed: ${getErrorMessage(reason)}`)
              onFillSignFieldsChange(pdfFile.id, fillSignFields)
            }
          })
      }, 250)
    }

    function addFillSignField(field: FillSignField) {
      saveFillSignFields([...fillSignFields, field])
      onFillSignFieldSelect(field.id)
    }

    function updateFillSignField(fieldId: string, patch: Partial<FillSignField>) {
      saveFillSignFields(
        fillSignFields.map((field) =>
          field.id === fieldId ? { ...field, ...patch } : field,
        ),
      )
    }

    function deleteFillSignField(fieldId: string) {
      if (!window.confirm('Delete this Fill & Sign field?')) return
      saveFillSignFields(fillSignFields.filter((field) => field.id !== fieldId))
      onFillSignFieldSelect(null)
    }

    function duplicateFillSignField(fieldId: string) {
      const field = fillSignFields.find((candidate) => candidate.id === fieldId)
      if (!field) return
      const duplicate = duplicateFillSignFieldRecord(field)
      saveFillSignFields([...fillSignFields, duplicate])
      onFillSignFieldSelect(duplicate.id)
    }

    function addHighlight(color: HighlightColor) {
      if (!selectionToolbar) {
        return
      }
      const duplicate = highlights.find(
        (highlight) =>
          highlight.pageNumber === selectionToolbar.pageNumber &&
          highlight.text === selectionToolbar.text &&
          highlight.rectangles.length === selectionToolbar.rectangles.length,
      )
      const category = color === 'green' ? 'research' : color === 'blue' ? 'reference' : color === 'purple' ? 'question' : 'important'
      const nextHighlight: PdfHighlight = {
        id: duplicate?.id ?? window.crypto.randomUUID(),
        pageNumber: selectionToolbar.pageNumber,
        text: selectionToolbar.text,
        note: duplicate?.note ?? '',
        color,
        category,
        rectangles: selectionToolbar.rectangles,
        rotation,
        createdDate: duplicate?.createdDate ?? new Date().toISOString(),
      }
      const next = duplicate
        ? highlights.map((highlight) => highlight.id === duplicate.id ? nextHighlight : highlight)
        : [...highlights, nextHighlight]
      void saveHighlights(next)
      setSelectionToolbar(null)
      window.getSelection()?.removeAllRanges()
    }

    function updateNote(highlightId: string, note: string) {
      void saveHighlights(
        highlights.map((highlight) => highlight.id === highlightId ? { ...highlight, note } : highlight),
      )
    }

    function removeHighlight(highlightId: string) {
      void saveHighlights(highlights.filter((highlight) => highlight.id !== highlightId))
    }

    function removeSelectedHighlights() {
      if (!selectionToolbar) return
      const normalizedText = selectionToolbar.text.replace(/\s+/g, ' ').trim()
      void saveHighlights(
        highlights.filter((highlight) =>
          highlight.pageNumber !== selectionToolbar.pageNumber ||
          highlight.text.replace(/\s+/g, ' ').trim() !== normalizedText,
        ),
      )
      closeSelectionToolbar()
    }

    function closeSelectionToolbar() {
      setSelectionToolbar(null)
      window.getSelection()?.removeAllRanges()
    }

    function recolorHighlight(highlightId: string, color: HighlightColor) {
      void saveHighlights(
        highlights.map((highlight) => highlight.id === highlightId ? { ...highlight, color } : highlight),
      )
    }

    function recategorizeHighlight(highlightId: string, category: PdfHighlight['category']) {
      void saveHighlights(
        highlights.map((highlight) => highlight.id === highlightId ? { ...highlight, category } : highlight),
      )
    }

    async function exportHighlights() {
      try {
        await window.electronAPI.exportHighlights({
          id: pdfFile.id,
          format: 'markdown',
          highlights,
        })
      } catch (reason) {
        setError(`Highlight export failed: ${getErrorMessage(reason)}`)
      }
    }

    async function exportCurrentPage(format: 'png' | 'jpeg') {
      if (!pdf) return
      try {
        const page = await pdf.getPage(currentPageRef.current)
        const viewport = page.getViewport({
          scale: 2,
          rotation: normalizeRotation(page.rotate + rotation),
        })
        const canvas = document.createElement('canvas')
        canvas.width = Math.ceil(viewport.width)
        canvas.height = Math.ceil(viewport.height)
        const context = canvas.getContext('2d')
        if (!context) throw new Error('Canvas rendering is unavailable.')
        await page.render({ canvas, canvasContext: context, viewport, background: '#ffffff' }).promise
        const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png'
        const blob = await new Promise<Blob>((resolve, reject) => {
          canvas.toBlob((value) => value ? resolve(value) : reject(new Error('Page encoding failed.')), mimeType, format === 'jpeg' ? 0.92 : undefined)
        })
        const extension = format === 'jpeg' ? 'jpg' : 'png'
        await window.electronAPI.exportPage({
          data: new Uint8Array(await blob.arrayBuffer()),
          format,
          defaultName: `${pdfFile.name.replace(/\.pdf$/i, '')}-page-${currentPageRef.current}.${extension}`,
        })
      } catch (reason) {
        setError(`Page export failed: ${getErrorMessage(reason)}`)
      }
    }

    async function navigateOutline(item: OutlineItem) {
      if (!pdf || !item.dest) {
        return
      }
      try {
        const destination = typeof item.dest === 'string' ? await pdf.getDestination(item.dest) : item.dest
        const reference = destination?.[0]
        if (reference && typeof reference === 'object') {
          goToPage((await pdf.getPageIndex(reference as never)) + 1)
        } else if (typeof reference === 'number') {
          goToPage(reference + 1)
        }
      } catch (reason) {
        setError(`Bookmark failed: ${getErrorMessage(reason)}`)
      }
    }

    function handleScroll() {
      const scroller = scrollRef.current
      if (!scroller) {
        return
      }
      const scrollBounds = scroller.getBoundingClientRect()
      const estimatedPage = Math.min(
        numPages,
        Math.max(1, Math.floor(scroller.scrollTop / (pageHeight * renderZoom + 12)) + 1),
      )
      let visiblePage = estimatedPage
      let visibleArea = -1
      for (
        let pageNumber = Math.max(1, estimatedPage - 2);
        pageNumber <= Math.min(numPages, estimatedPage + 2);
        pageNumber += 1
      ) {
        const element = pageRefs.current.get(pageNumber)
        if (!element) continue
        const bounds = element.getBoundingClientRect()
        const overlap = Math.max(0, Math.min(bounds.bottom, scrollBounds.bottom) - Math.max(bounds.top, scrollBounds.top))
        if (overlap > visibleArea) {
          visibleArea = overlap
          visiblePage = pageNumber
        }
      }
      if (visiblePage !== currentPageRef.current) {
        currentPageRef.current = visiblePage
        setCurrentPage(visiblePage)
        setPageInput(String(visiblePage))
        setRenderedPages((pages) => addPageWindow(pages, visiblePage, numPages))
      }
      if (!suppressScrollSyncRef.current) {
        const page = pageRefs.current.get(visiblePage)
        const bounds = page?.getBoundingClientRect()
        const offset = bounds
          ? Math.min(1, Math.max(0, (scrollBounds.top - bounds.top) / bounds.height))
          : 0
        onScrollPosition({ page: visiblePage, offset })
      }
      setSelectionToolbar(null)
    }

    return (
      <section
        ref={rootRef}
        tabIndex={-1}
        aria-label={`${paneLabel} PDF pane`}
        onPointerDown={onActivate}
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
            onDropTab(tabId)
          }
        }}
        className={`relative flex h-full min-h-0 flex-col overflow-hidden rounded-xl border bg-slate-900 shadow-xl outline-none transition-colors ${
          active ? 'border-blue-400/90 ring-2 ring-blue-400/25' : 'border-slate-700/90'
        }`}
      >
        <PdfPaneHeader
          active={active}
          paneLabel={paneLabel}
          fileName={pdfFile.name}
          currentPage={currentPage}
          totalPages={numPages || 0}
          zoomPercent={Math.round(renderZoom * 100)}
          onClose={onCloseSplit}
        />

        <PdfPaneToolbar
          active={active}
          currentPage={currentPage}
          totalPages={numPages}
          pageInput={pageInput}
          zoomPercent={Math.round(renderZoom * 100)}
          fitActive={fitMode}
          searchActive={searchOpen}
          panelsActive={sidebarOpen}
          onPageInputChange={setPageInput}
          onPageSubmit={() => goToPage(Number(pageInput))}
          onPreviousPage={() => goToPage(currentPage - 1)}
          onNextPage={() => goToPage(currentPage + 1)}
          onZoomOut={() => changeZoom(zoom - 0.1)}
          onResetZoom={() => changeZoom(1)}
          onZoomIn={() => changeZoom(zoom + 0.1)}
          onFitWidth={() => setFitMode(true)}
          onRotateLeft={() => setRotation((value) => normalizeRotation(value - 90))}
          onRotateRight={() => setRotation((value) => normalizeRotation(value + 90))}
          onSearch={() => setSearchOpen((value) => !value)}
          onTogglePanels={() => setSidebarOpen((value) => !value)}
        />

        {searchOpen ? (
          <div className="flex shrink-0 items-center gap-1 border-b border-slate-700 bg-slate-950/50 p-2 text-xs">
            <span className="font-semibold text-blue-300">{paneLabel}</span>
            <input
              ref={searchInputRef}
              type="search"
              value={searchQuery}
              placeholder={`Search ${paneLabel.toLowerCase()} pane`}
              onChange={(event) => setSearchQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  selectMatch(event.shiftKey ? -1 : 1)
                }
              }}
              className="h-8 min-w-0 flex-1 rounded border border-slate-700 bg-slate-900 px-2 outline-none focus:border-blue-400"
            />
            <span className="min-w-16 text-center text-slate-400">
              {isSearching ? 'Searching...' : searchMatches.length ? `${selectedMatchIndex + 1} / ${searchMatches.length}` : searchQuery ? 'No results' : ''}
            </span>
            <button type="button" className="split-pane-button" onClick={() => selectMatch(-1)}>&uarr;</button>
            <button type="button" className="split-pane-button" onClick={() => selectMatch(1)}>&darr;</button>
          </div>
        ) : null}

        {error ? <div className="shrink-0 border-b border-red-500/30 bg-red-950/60 px-3 py-2 text-xs text-red-100">{error}</div> : null}

        <div className="flex min-h-0 flex-1">
          {sidebarOpen ? (
            <aside className="flex min-h-0 shrink-0 flex-col border-r border-slate-700 bg-slate-950/45" style={{ width: sidebarWidth }}>
              <div className="grid grid-cols-3 gap-1 border-b border-slate-700 p-1.5 text-[10px]">
                {(['pages', 'bookmarks', 'highlights'] as const).map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    onClick={() => setSidebarTab(tab)}
                    className={`rounded px-1 py-2 capitalize ${sidebarTab === tab ? 'bg-blue-500/20 text-blue-200' : 'text-slate-400 hover:bg-slate-800'}`}
                  >
                    {tab}
                  </button>
                ))}
              </div>
              <div className="min-h-0 flex-1 overflow-auto p-2">
                {sidebarTab === 'pages' ? (
                  Array.from({ length: numPages }, (_, index) => (
                    <LazyPaneThumbnail
                      key={index + 1}
                      pdf={pdf}
                      pageNumber={index + 1}
                      rotation={rotation}
                      active={currentPage === index + 1}
                      onNavigate={goToPage}
                    />
                  ))
                ) : sidebarTab === 'bookmarks' ? (
                  outlineLoading ? <PaneMessage>Loading bookmarks...</PaneMessage> : outline.length ? (
                    <PaneOutline items={outline} onNavigate={navigateOutline} />
                  ) : <PaneMessage>No bookmarks available</PaneMessage>
                ) : highlights.length ? (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-2 px-1">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Highlights ({highlights.length})</p>
                      <button type="button" onClick={() => void exportHighlights()} className="rounded border border-slate-700 px-2 py-1 text-[10px] text-slate-300 hover:bg-slate-800">Export</button>
                    </div>
                    {highlights.map((highlight) => (
                      <article key={highlight.id} className="rounded-lg border border-slate-700 bg-slate-900 p-2 text-xs">
                        <button type="button" onClick={() => goToPage(highlight.pageNumber)} className="block w-full text-left">
                          <span className="font-semibold text-blue-300">Page {highlight.pageNumber}</span>
                          <p className="mt-1 line-clamp-3 text-slate-300">{highlight.text}</p>
                        </button>
                        <textarea
                          defaultValue={highlight.note}
                          placeholder="Add note..."
                          onBlur={(event) => updateNote(highlight.id, event.target.value)}
                          className="mt-2 min-h-14 w-full resize-y rounded border border-slate-700 bg-slate-950 p-1.5 text-slate-300 outline-none focus:border-blue-400"
                        />
                        <div className="mt-1.5 flex items-center gap-1">
                          {COLORS.map(({ color, label, className }) => (
                            <button key={color} type="button" title={label} onClick={() => recolorHighlight(highlight.id, color)} className={`grid size-6 place-items-center rounded ${highlight.color === color ? 'bg-slate-700 ring-1 ring-blue-400' : 'hover:bg-slate-800'}`}>
                              <span className={`size-3 rounded-full ${className}`} />
                            </button>
                          ))}
                          <select
                            value={highlight.category}
                            onChange={(event) => recategorizeHighlight(highlight.id, event.target.value as PdfHighlight['category'])}
                            className="ml-auto min-w-0 rounded border border-slate-700 bg-slate-950 px-1 py-1 text-[10px]"
                          >
                            <option value="important">Important</option>
                            <option value="research">Research</option>
                            <option value="reference">Reference</option>
                            <option value="question">Question</option>
                          </select>
                        </div>
                        <button type="button" onClick={() => removeHighlight(highlight.id)} className="mt-1 text-[11px] text-red-300 hover:text-red-200">Delete</button>
                      </article>
                    ))}
                  </div>
                ) : <PaneMessage>No highlights</PaneMessage>}
              </div>
            </aside>
          ) : null}

          <div
            ref={scrollRef}
            onScroll={handleScroll}
            className="min-h-0 min-w-0 flex-1 overflow-auto bg-[#1f2937] p-3"
            style={{ backgroundColor: viewerBackground }}
          >
            <div ref={contentRef} className="min-w-0">
              <Document
                file={pdfFile.dataUrl}
                loading={<PaneMessage>Loading PDF...</PaneMessage>}
                onLoadSuccess={(loadedPdf) => {
                  setPdf(loadedPdf)
                  setNumPages(loadedPdf.numPages)
                  const restoredPage = Math.min(loadedPdf.numPages, Math.max(1, initialState.page))
                  currentPageRef.current = restoredPage
                  setCurrentPage(restoredPage)
                  setPageInput(String(restoredPage))
                  setRenderedPages(addPageWindow(new Set(), restoredPage, loadedPdf.numPages))
                  void extractAndStoreReference(loadedPdf, pdfFile).catch((reason) => console.warn('Reference extraction failed:', getErrorMessage(reason)))
                  void loadedPdf.getPage(1).then((page) => {
                    const viewport = page.getViewport({ scale: 1, rotation: normalizeRotation(page.rotate + rotation) })
                    setPageWidth(viewport.width)
                    setPageHeight(viewport.height)
                  })
                }}
                onLoadError={(reason) => setError(getErrorMessage(reason))}
              >
                <div className="flex min-w-full flex-col gap-3">
                  {Array.from({ length: numPages }, (_, index) => index + 1).map((pageNumber) => (
                    <div
                      key={pageNumber}
                      ref={(element) => {
                        if (element) pageRefs.current.set(pageNumber, element)
                        else pageRefs.current.delete(pageNumber)
                      }}
                      data-split-page={pageNumber}
                      className="flex min-w-full justify-center"
                      style={{ minHeight: pageHeight * renderZoom }}
                    >
                      <div data-split-page-surface="" className="relative" style={{ width: pageWidth * renderZoom, minHeight: pageHeight * renderZoom }}>
                        <HighlightOverlay
                          highlights={highlightsByPage.get(pageNumber) ?? []}
                          rotation={rotation}
                          focusedHighlightId={focusedHighlightId}
                        />
                        <SignaturePlacementOverlay
                          pageNumber={pageNumber}
                          pageRotation={rotation}
                          placements={signaturePlacementsByPage.get(pageNumber) ?? []}
                          signatures={signatures}
                          signingSignature={active ? signingSignature : null}
                          selectedPlacementId={active ? selectedSignaturePlacementId : null}
                          onPlace={addSignaturePlacement}
                          onSelect={onSignaturePlacementSelect}
                          onUpdate={updateSignaturePlacement}
                          onDelete={deleteSignaturePlacement}
                          onDuplicate={duplicateSignaturePlacement}
                          onBringForward={bringSignatureForward}
                          onSendBackward={sendSignatureBackward}
                          onFinishSigning={onFinishSigning}
                        />
                        <FillSignOverlay
                          pageNumber={pageNumber}
                          pageRotation={rotation}
                          fields={fillSignFieldsByPage.get(pageNumber) ?? []}
                          activeTool={active ? activeFillSignTool : null}
                          selectedFieldId={active ? selectedFillSignFieldId : null}
                          dateFormat={fillSignDateFormat}
                          initials={fillSignInitials}
                          onPlace={addFillSignField}
                          onSelect={onFillSignFieldSelect}
                          onUpdate={updateFillSignField}
                          onDelete={deleteFillSignField}
                          onDuplicate={duplicateFillSignField}
                          onFinishTool={onFinishFillSignTool}
                        />
                        {renderedPages.has(pageNumber) ? (
                          <PanePage
                            pageNumber={pageNumber}
                            scale={renderZoom}
                            rotation={rotation}
                            customTextRenderer={searchMatches.length ? renderSearchText : undefined}
                            onLoad={(page) => {
                              if (pageNumber === 1) {
                                const viewport = page.getViewport({ scale: 1, rotation: normalizeRotation(page.rotate + rotation) })
                                setPageWidth(viewport.width)
                                setPageHeight(viewport.height)
                              }
                            }}
                          />
                        ) : (
                          <div className="grid bg-slate-800 text-xs text-slate-500" style={{ width: pageWidth * renderZoom, height: pageHeight * renderZoom }}>
                            <span className="m-auto">Page {pageNumber}</span>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </Document>
            </div>
          </div>
        </div>

        {selectionToolbar ? (
          <HighlightSelectionToolbar
            x={selectionToolbar.x}
            y={selectionToolbar.y}
            onHighlight={addHighlight}
            onRemove={removeSelectedHighlights}
            onClose={closeSelectionToolbar}
          />
        ) : null}
      </section>
    )
  },
)

function PanePage({
  pageNumber,
  scale,
  rotation,
  customTextRenderer,
  onLoad,
}: {
  pageNumber: number
  scale: number
  rotation: number
  customTextRenderer?: (props: { pageNumber: number; itemIndex: number; str: string }) => string
  onLoad: (page: PDFPageProxy) => void
}) {
  const [intrinsicRotation, setIntrinsicRotation] = useState<number | null>(null)
  return (
    <Page
      pageNumber={pageNumber}
      scale={scale}
      rotate={intrinsicRotation === null ? undefined : normalizeRotation(intrinsicRotation + rotation)}
      renderTextLayer
      renderAnnotationLayer
      customTextRenderer={customTextRenderer}
      onLoadSuccess={(page) => {
        setIntrinsicRotation(page.rotate)
        onLoad(page)
      }}
      loading={null}
      className="overflow-hidden bg-white shadow-[0_10px_25px_rgba(0,0,0,0.3)]"
    />
  )
}

function LazyPaneThumbnail({
  pdf,
  pageNumber,
  rotation,
  active,
  onNavigate,
}: {
  pdf: PDFDocumentProxy | null
  pageNumber: number
  rotation: number
  active: boolean
  onNavigate: (page: number) => void
}) {
  const [visible, setVisible] = useState(false)
  const hostRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        setVisible(true)
        observer.disconnect()
      }
    }, { rootMargin: '160px' })
    observer.observe(host)
    return () => observer.disconnect()
  }, [])
  return (
    <button
      ref={hostRef}
      type="button"
      onClick={() => onNavigate(pageNumber)}
      className={`mb-2 block w-full rounded-lg border p-2 text-center text-[10px] ${active ? 'border-blue-400 bg-blue-500/15' : 'border-slate-700 hover:bg-slate-800'}`}
    >
      <div className="mx-auto min-h-28 overflow-hidden bg-slate-800">
        {visible && pdf ? <Thumbnail pdf={pdf} pageNumber={pageNumber} width={120} rotate={rotation} /> : null}
      </div>
      <span className="mt-1 block text-slate-400">Page {pageNumber}</span>
    </button>
  )
}

function PaneOutline({ items, onNavigate }: { items: OutlineItem[]; onNavigate: (item: OutlineItem) => void }) {
  return (
    <ul className="space-y-1 text-xs">
      {items.map((item, index) => (
        <li key={`${item.title}-${index}`}>
          <button type="button" onClick={() => void onNavigate(item)} className="block w-full rounded px-2 py-1.5 text-left text-slate-300 hover:bg-slate-800">
            {item.title || 'Untitled bookmark'}
          </button>
          {item.items?.length ? <div className="ml-3 border-l border-slate-700 pl-1"><PaneOutline items={item.items} onNavigate={onNavigate} /></div> : null}
        </li>
      ))}
    </ul>
  )
}

function PaneMessage({ children }: { children: React.ReactNode }) {
  return <div className="grid min-h-28 place-items-center px-3 text-center text-xs text-slate-500">{children}</div>
}

async function getPageText(
  pdf: PDFDocumentProxy,
  pageNumber: number,
  cache: Map<number, CachedPageText>,
) {
  const cached = cache.get(pageNumber)
  if (cached) return cached
  const page = await pdf.getPage(pageNumber)
  const content = await page.getTextContent()
  const starts: number[] = []
  let text = ''
  for (const item of content.items) {
    starts.push(text.length)
    text += 'str' in item ? item.str : ''
  }
  const value = { text, starts }
  cache.set(pageNumber, value)
  return value
}

function addPageWindow(current: Set<number>, page: number, total: number) {
  void current
  const next = new Set<number>()
  for (let candidate = Math.max(1, page - PAGE_OVERSCAN); candidate <= Math.min(total, page + PAGE_OVERSCAN); candidate += 1) {
    next.add(candidate)
  }
  return next
}

function clampZoom(zoom: number) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number(zoom) || 1))
}

function normalizeRotation(rotation: number) {
  return ((rotation % 360) + 360) % 360
}

function duplicateFillSignFieldRecord(field: FillSignField): FillSignField {
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

function isEditableKeyboardTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

function getErrorMessage(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason)
}
