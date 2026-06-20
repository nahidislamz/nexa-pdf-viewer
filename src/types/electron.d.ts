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
  dataUrl: string
  readingState: PdfReadingState
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
      printPdf: (id: string) => Promise<{ printed: boolean; cancelled: boolean }>
      exportPage: (exportData: {
        data: Uint8Array
        format: 'png' | 'jpeg'
        defaultName: string
      }) => Promise<string | null>
      getSidebarTab: () => Promise<'thumbnails' | 'bookmarks' | 'info'>
      setSidebarTab: (tab: 'thumbnails' | 'bookmarks' | 'info') => Promise<void>
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
    }
  }
}

export {}
