type PdfReadingState = {
  page: number
  zoom: number
  fitMode: boolean
  rotation: number
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
}

type SystemPdfOpenMessage =
  | { status: 'loading' }
  | { status: 'success'; pdf: OpenedPdf }
  | { status: 'error'; error: string }

declare global {
  interface Window {
    electronAPI: {
      openPdf: () => Promise<OpenedPdf | null>
      openDroppedPdf: (file: File) => Promise<OpenedPdf>
      getRecentPdfs: () => Promise<Array<{ id: string; name: string }>>
      openRecentPdf: (id: string) => Promise<OpenedPdf>
      savePdfState: (id: string, state: PdfReadingState) => Promise<void>
      savePdfHighlights: (
        identity: { id: string; fileSize: number; modifiedAt: number },
        highlights: PdfHighlight[],
      ) => Promise<PdfHighlight[]>
      exportHighlights: (options: {
        id: string
        format: 'markdown' | 'text' | 'docx'
        highlights: PdfHighlight[]
      }) => Promise<string | null>
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
