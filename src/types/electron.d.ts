import type {
  WorkspaceCreateInput,
  WorkspaceDetails,
  WorkspaceList,
  WorkspaceSummary,
} from './workspaces'
import type {
  CitationStyle,
  ExtractedReferenceUpsertResult,
  ReferenceDuplicateGroup,
  ReferenceFilters,
  ReferenceItem,
  ReferenceMetadata,
  ReferenceQueryResponse,
} from './references'
import type { FillSignField, SavedSignature, SignaturePlacement } from './signatures'

type PdfReadingState = {
  page: number
  zoom: number
  fitMode: boolean
  rotation: number
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
  imageWidth: number
  imageHeight: number
  pageRotation: number
  words: Array<{ text: string; confidence: number; x0: number; y0: number; x1: number; y1: number }>
  lines: Array<{ text: string; confidence: number; x0: number; y0: number; x1: number; y1: number }>
  language: OcrLanguage
  createdAt: string
  updatedAt: string
  status: 'complete' | 'failed'
  lowConfidence: boolean
  error?: string
}

type OpenedPdf = {
  id: string
  name: string
  filePath: string
  fileSize: number
  modifiedAt: number
  dataUrl: string
  readingState: PdfReadingState
  highlights: PdfHighlight[]
  signaturePlacements: SignaturePlacement[]
  fillSignFields: FillSignField[]
  ocrDetection: OcrDetectionResult
}

type MergePdfItem = {
  id: string
  name: string
  filePath: string
  fileSize: number
  modifiedAt: number
  pageCount: number
}

type MergePdfResult = {
  outputPath: string
  name: string
  fileSize: number
  pageCount: number
  openedPdf: OpenedPdf | null
}

type ImageToPdfItem = {
  id: string
  name: string
  filePath: string
  fileSize: number
  modifiedAt: number
  width: number
  height: number
  thumbnailDataUrl: string
}

type PdfToolExportResult = MergePdfResult

type SignedPdfResult = {
  outputPath: string
  openedPdf: OpenedPdf | null
}

type UploadedSignatureImage = {
  name: string
  imageDataUrl: string
  width: number
  height: number
}

type PdfHighlight = {
  id: string
  pageNumber: number
  text: string
  color: 'yellow' | 'green' | 'blue' | 'purple'
  category: 'important' | 'research' | 'reference' | 'question'
  note: string
  rectangles: Array<{ x: number; y: number; width: number; height: number }>
  rotation: number
  createdDate: string
  modifiedDate?: string
}

type HighlightLibraryEntry = {
  key: string
  documentKey: string
  documentId: string
  documentName: string
  filePath: string
  fileSize: number
  fileModifiedAt: number
  highlightId: string
  pageNumber: number
  text: string
  note: string
  color: PdfHighlight['color']
  category: PdfHighlight['category']
  createdDate: string
  modifiedDate: string
  searchText?: string
}

type HighlightLibrary = {
  entries: HighlightLibraryEntry[]
  stats: {
    totalDocuments: number
    totalHighlights: number
    categories: Record<PdfHighlight['category'], number>
  }
}

type GlobalSearchResultType = 'pdf-text' | 'ocr-text' | 'highlight' | 'note' | 'bookmark' | 'file' | 'metadata' | 'reference'
type GlobalSearchFilters = {
  type: GlobalSearchResultType | 'all'
  category: PdfHighlight['category'] | 'all'
  documentId: string
  dateStart: string
  dateEnd: string
  scope: 'workspace' | 'all'
}
type GlobalSearchResult = {
  id: string
  type: GlobalSearchResultType
  documentId: string
  documentKey: string | null
  documentName: string
  filePath: string
  pageNumber: number
  text: string
  preview: string
  matchText?: string
  highlightId?: string
  category?: PdfHighlight['category']
  color?: PdfHighlight['color']
  language?: string
  confidence?: number
  lowConfidence?: boolean
  createdDate?: string | null
  modifiedDate?: string | null
  score: number
}
type GlobalSearchResponse = {
  query: string
  results: GlobalSearchResult[]
  total: number
  counts: { total: number; highlights: number; notes: number; documents: number; types: Partial<Record<GlobalSearchResultType, number>> }
  truncated: boolean
  durationMs: number
}
type SavedGlobalSearch = { id: string; name: string; query: string; filters: GlobalSearchFilters; createdAt: string; workspaceId?: string | null }
type GlobalSearchLibraryInfo = {
  documents: Array<{ documentId: string; name: string; filePath: string; status: 'pending' | 'complete'; indexedPages: number; totalPages: number; indexedAt: string | null }>
  recentSearches: string[]
  savedSearches: SavedGlobalSearch[]
  activeWorkspace?: { id: string; name: string; documentIds: string[] }
}

type SystemPdfOpenMessage =
  | { status: 'loading' }
  | { status: 'success'; pdf: OpenedPdf }
  | { status: 'error'; error: string }

type PdfTabState = PdfReadingState & {
  pageOffset: number
  searchOpen: boolean
  searchQuery: string
  selectedMatchIndex: number
  sidebarOpen: boolean
  sidebarTab: 'thumbnails' | 'bookmarks' | 'highlights' | 'info'
  sidebarWidth: number
}

type PdfTab = {
  tabId: string
  documentId: string
  name: string
  state: PdfTabState
}

type PdfWorkspace = {
  tabs: PdfTab[]
  activeTabId: string | null
  closedTabs: PdfTab[]
  split: {
    enabled: boolean
    dividerRatio: number
    activePane: 'left' | 'right'
    leftPane: PdfPaneAssignment
    rightPane: PdfPaneAssignment
    syncScrolling: boolean
  }
}

type PdfOpenDestinationPreference = 'ask' | 'individual' | 'current-workspace' | 'choose-workspace'

type PdfPaneAssignment = {
  id: 'left' | 'right'
  tabId: string | null
  documentId: string | null
  fileName: string | null
  state: PdfTabState | null
}

declare global {
  interface Window {
    electronAPI: {
      openPdf: () => Promise<OpenedPdf | null>
      openDroppedPdf: (file: File) => Promise<OpenedPdf>
      openPdfPath: (filePath: string) => Promise<OpenedPdf>
      pickMergePdfs: () => Promise<MergePdfItem[]>
      inspectMergePdfs: (files: File[] | string[]) => Promise<MergePdfItem[]>
      mergePdfs: (options: {
        files: Array<{ filePath: string }>
        outputName: string
        openAfterMerge: boolean
      }) => Promise<MergePdfResult | null>
      pickImagesForPdf: () => Promise<ImageToPdfItem[]>
      inspectImagesForPdf: (files: File[] | string[]) => Promise<ImageToPdfItem[]>
      imagesToPdf: (options: {
        images: Array<{ filePath: string }>
        outputName: string
        openAfterExport: boolean
        pageSize: 'a4' | 'letter' | 'fit-image' | 'custom'
        orientation: 'auto' | 'portrait' | 'landscape'
        imageFit: 'fit-page' | 'fill-page' | 'original-size' | 'center'
        margin: 'none' | 'small' | 'medium' | 'large'
        customWidth: number
        customHeight: number
      }) => Promise<PdfToolExportResult | null>
      listSignatures: () => Promise<SavedSignature[]>
      pickSignatureImage: () => Promise<UploadedSignatureImage | null>
      createSignature: (signature: {
        name: string
        type: 'drawn' | 'uploaded' | 'typed'
        imageDataUrl: string
      }) => Promise<SavedSignature[]>
      updateSignature: (id: string, patch: { name?: string }) => Promise<SavedSignature[]>
      deleteSignature: (id: string) => Promise<SavedSignature[]>
      duplicateSignature: (id: string) => Promise<SavedSignature[]>
      setDefaultSignature: (id: string) => Promise<SavedSignature[]>
      getRecentPdfs: () => Promise<Array<{ id: string; name: string }>>
      openRecentPdf: (id: string) => Promise<OpenedPdf>
      clearRecentPdfs: () => Promise<Array<{ id: string; name: string }>>
      removeRecentPdf: (id: string) => Promise<Array<{ id: string; name: string }>>
      getWorkspace: () => Promise<PdfWorkspace>
      saveWorkspace: (workspace: PdfWorkspace) => Promise<PdfWorkspace>
      listWorkspaces: () => Promise<WorkspaceList>
      getActiveWorkspace: () => Promise<WorkspaceDetails>
      getWorkspaceDetails: (id: string) => Promise<WorkspaceDetails>
      createWorkspace: (workspace: WorkspaceCreateInput) => Promise<WorkspaceSummary>
      updateWorkspace: (id: string, patch: Partial<WorkspaceCreateInput>) => Promise<WorkspaceSummary>
      deleteWorkspace: (id: string) => Promise<{ activeWorkspaceId: string; deletedActive: boolean; session: PdfWorkspace }>
      switchWorkspace: (id: string, currentSession: PdfWorkspace) => Promise<{ workspace: WorkspaceSummary; session: PdfWorkspace }>
      addWorkspaceDocument: (workspaceId: string, documentId: string) => Promise<WorkspaceDetails>
      removeWorkspaceDocument: (workspaceId: string, documentId: string) => Promise<WorkspaceDetails>
      exportWorkspace: (id: string, format: 'json' | 'zip') => Promise<string | null>
      importWorkspace: () => Promise<{
        workspace: WorkspaceSummary
        session: PdfWorkspace
        missingFiles: string[]
        duplicateDocuments: string[]
      } | null>
      queryReferences: (request: { query: string; filters: ReferenceFilters; sort: 'newest' | 'oldest' | 'title' | 'author'; offset: number; limit: number }) => Promise<ReferenceQueryResponse>
      getReference: (id: string) => Promise<ReferenceItem>
      touchReference: (id: string) => Promise<void>
      upsertExtractedReference: (payload: {
        documentId: string
        sourceMetadata: Partial<ReferenceMetadata>
        detectedMetadata: Partial<ReferenceMetadata>
        hasReferenceSection: boolean
        referenceSectionStatus: 'found' | 'not_found' | 'error'
        referenceHeadingPage: number
        references: Array<Partial<ReferenceMetadata> & { rawText: string; confidence: number }>
        candidateEntries: number
        rejectedEntries: number
      }) => Promise<ExtractedReferenceUpsertResult>
      updateReference: (id: string, patch: Partial<ReferenceMetadata> & { doiLookupSource?: string; doiLookupAt?: string }) => Promise<ReferenceItem>
      lookupDoi: (doi: string) => Promise<{ metadata: Partial<ReferenceMetadata>; source: string; lookedUpAt: string }>
      removeReferenceSourceDocument: (documentId: string) => Promise<void>
      createManualReference: (payload: Partial<ReferenceMetadata> & { rawText?: string }) => Promise<ReferenceItem>
      createReferenceCollection: (payload: { name: string; description?: string; color?: string }) => Promise<{ id: string; name: string; description: string; color: string; createdAt: string }>
      updateReferenceCollection: (id: string, patch: { name?: string; description?: string; color?: string }) => Promise<{ id: string; name: string; description: string; color: string; createdAt: string }>
      deleteReferenceCollection: (id: string) => Promise<void>
      deleteReferences: (ids: string[]) => Promise<number>
      setReferenceCollections: (id: string, collectionIds: string[]) => Promise<ReferenceItem>
      setWorkspaceReference: (workspaceId: string, referenceId: string, included: boolean) => Promise<string[]>
      getReferenceDuplicates: () => Promise<ReferenceDuplicateGroup[]>
      keepReferencesSeparate: (ids: string[]) => Promise<void>
      mergeReferences: (primaryId: string, duplicateIds: string[]) => Promise<ReferenceItem>
      exportReferences: (options: { referenceIds?: string[]; workspaceId?: string; request?: { query: string; filters: ReferenceFilters; sort: 'newest' | 'oldest' | 'title' | 'author' }; style: CitationStyle; format: 'text' | 'markdown' | 'docx' | 'bibtex' | 'ris' }) => Promise<string | null>
      revealPdf: (id: string) => Promise<void>
      savePdfState: (id: string, state: PdfReadingState) => Promise<void>
      saveOcrDetection: (id: string, detection: OcrDetectionResult) => Promise<OcrDetectionResult>
      listPageOcrResults: (documentId: string) => Promise<PageOcrResult[]>
      runPageOcr: (request: {
        operationId: string
        documentId: string
        pageNumber: number
        language: OcrLanguage
        imageDataUrl: string
        imageWidth?: number
        imageHeight?: number
        pageRotation?: number
        force?: boolean
      }) => Promise<PageOcrResult>
      cancelPageOcr: (operationId: string) => Promise<void>
      onPageOcrProgress: (callback: (progress: {
        operationId: string
        status: string
        progress: number
      }) => void) => () => void
      savePdfHighlights: (
        identity: { id: string; fileSize: number; modifiedAt: number },
        highlights: PdfHighlight[],
      ) => Promise<PdfHighlight[]>
      savePdfSignaturePlacements: (
        identity: { id: string; fileSize: number; modifiedAt: number },
        placements: SignaturePlacement[],
      ) => Promise<SignaturePlacement[]>
      savePdfFillSignFields: (
        identity: { id: string; fileSize: number; modifiedAt: number },
        fields: FillSignField[],
      ) => Promise<FillSignField[]>
      saveSignedPdf: (options: {
        identity: { id: string; fileSize: number; modifiedAt: number }
        placements: SignaturePlacement[]
        fillSignFields?: FillSignField[]
      }) => Promise<SignedPdfResult | null>
      exportHighlights: (options: {
        id: string
        format: 'markdown' | 'text' | 'docx'
        highlights: PdfHighlight[]
      }) => Promise<string | null>
      getHighlightLibrary: () => Promise<HighlightLibrary>
      openHighlightDocument: (documentKey: string) => Promise<OpenedPdf>
      updateHighlightLibrary: (updates: Array<{
        documentKey: string
        highlightId: string
        patch: Partial<Pick<PdfHighlight, 'note' | 'category' | 'color'>>
      }>) => Promise<HighlightLibrary>
      deleteHighlightLibraryEntries: (keys: string[]) => Promise<HighlightLibrary>
      exportHighlightLibrary: (options: {
        format: 'markdown' | 'text' | 'docx'
        keys: string[]
      }) => Promise<string | null>
      getSearchIndexStatus: (identity: { id: string; fileSize: number; modifiedAt: number }) => Promise<{ current: boolean; status: 'pending' | 'complete'; indexedPages: number; totalPages: number }>
      startSearchIndex: (payload: { id: string; name: string; filePath: string; fileSize: number; modifiedAt: number; totalPages: number; metadata: Record<string, string>; bookmarks: Array<{ title: string; pageNumber: number }> }) => Promise<{ accepted: boolean }>
      appendSearchIndexPages: (documentId: string, pages: Array<{ pageNumber: number; text: string }>) => Promise<{ accepted: boolean; indexedPages?: number }>
      appendOcrSearchIndexPages: (documentId: string, pages: Array<{
        pageNumber: number
        text: string
        language?: OcrLanguage
        confidence?: number
        lowConfidence?: boolean
        createdAt?: string
        updatedAt?: string
      }>) => Promise<{ accepted: boolean; indexedPages?: number }>
      completeSearchIndex: (documentId: string) => Promise<{ indexedPages: number; totalPages: number }>
      cancelSearchIndex: (documentId: string) => Promise<void>
      searchLibrary: (request: { query: string; filters: GlobalSearchFilters }) => Promise<GlobalSearchResponse>
      getSearchLibraryInfo: () => Promise<GlobalSearchLibraryInfo>
      recordGlobalSearch: (query: string) => Promise<string[]>
      clearGlobalSearchHistory: () => Promise<string[]>
      saveGlobalSearch: (search: { id?: string; name: string; query: string; filters: GlobalSearchFilters }) => Promise<SavedGlobalSearch[]>
      deleteSavedGlobalSearch: (id: string) => Promise<SavedGlobalSearch[]>
      printPdf: (id: string) => Promise<{ printed: boolean; cancelled: boolean }>
      exportPage: (exportData: {
        data: Uint8Array
        format: 'png' | 'jpeg'
        defaultName: string
      }) => Promise<string | null>
      getSidebarTab: () => Promise<'thumbnails' | 'bookmarks' | 'highlights' | 'info'>
      setSidebarTab: (tab: 'thumbnails' | 'bookmarks' | 'highlights' | 'info') => Promise<void>
      getViewMode: () => Promise<'continuous' | 'single'>
      setViewMode: (viewMode: 'continuous' | 'single') => Promise<void>
      getViewerBackground: () => Promise<'dark-gray' | 'black' | 'light-gray' | 'white'>
      setViewerBackground: (
        viewerBackground: 'dark-gray' | 'black' | 'light-gray' | 'white',
      ) => Promise<void>
      getSidebarLayout: () => Promise<{ width: number; collapsed: boolean }>
      setSidebarLayout: (sidebarLayout: {
        width: number
        collapsed: boolean
      }) => Promise<void>
      getPdfOpenDestination: () => Promise<PdfOpenDestinationPreference>
      setPdfOpenDestination: (
        destination: PdfOpenDestinationPreference,
      ) => Promise<PdfOpenDestinationPreference>
      getFullscreen: () => Promise<boolean>
      toggleFullscreen: () => Promise<boolean>
      exitFullscreen: () => Promise<boolean>
      onFullscreenChange: (callback: (fullscreen: boolean) => void) => void
      removeFullscreenListener: () => void
      onOpenPdfFromSystem: (
        callback: (message: SystemPdfOpenMessage) => void,
      ) => () => void
      notifyRendererReady: () => void
      getMemoryUsage: () => Promise<{
        mainWorkingSetMb: number
        totalWorkingSetMb: number
        totalPrivateMb: number
        processes: Array<{
          type: string
          workingSetMb: number
          peakWorkingSetMb: number
          privateMb: number
        }>
      }>
    }
  }
}

export {}
