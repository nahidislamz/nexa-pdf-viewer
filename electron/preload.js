import { contextBridge, ipcRenderer, webUtils } from 'electron'

let systemOpenCallback = null
const pendingSystemOpenMessages = []

ipcRenderer.on('pdf:open-from-system', (_event, message) => {
  if (systemOpenCallback) {
    systemOpenCallback(message)
  } else {
    pendingSystemOpenMessages.push(message)
  }
})

contextBridge.exposeInMainWorld('electronAPI', {
  openPdf: () => ipcRenderer.invoke('pdf:open'),
  openDroppedPdf: (file) => ipcRenderer.invoke('pdf:open-dropped', webUtils.getPathForFile(file)),
  getRecentPdfs: () => ipcRenderer.invoke('pdf:recent-list'),
  openRecentPdf: (id) => ipcRenderer.invoke('pdf:open-recent', id),
  savePdfState: (id, state) => ipcRenderer.invoke('pdf:save-state', id, state),
  printPdf: (id) => ipcRenderer.invoke('pdf:print', id),
  exportPage: (exportData) => ipcRenderer.invoke('pdf:export-page', exportData),
  getSidebarTab: () => ipcRenderer.invoke('preferences:get-sidebar-tab'),
  setSidebarTab: (tab) => ipcRenderer.invoke('preferences:set-sidebar-tab', tab),
  getViewMode: () => ipcRenderer.invoke('preferences:get-view-mode'),
  setViewMode: (viewMode) => ipcRenderer.invoke('preferences:set-view-mode', viewMode),
  getViewerBackground: () => ipcRenderer.invoke('preferences:get-viewer-background'),
  setViewerBackground: (viewerBackground) =>
    ipcRenderer.invoke('preferences:set-viewer-background', viewerBackground),
  getSidebarLayout: () => ipcRenderer.invoke('preferences:get-sidebar-layout'),
  setSidebarLayout: (sidebarLayout) =>
    ipcRenderer.invoke('preferences:set-sidebar-layout', sidebarLayout),
  getFullscreen: () => ipcRenderer.invoke('window:get-fullscreen'),
  toggleFullscreen: () => ipcRenderer.invoke('window:toggle-fullscreen'),
  exitFullscreen: () => ipcRenderer.invoke('window:exit-fullscreen'),
  onFullscreenChange: (callback) => {
    ipcRenderer.removeAllListeners('window:fullscreen-changed')
    ipcRenderer.on('window:fullscreen-changed', (_event, fullscreen) => callback(fullscreen))
  },
  removeFullscreenListener: () => ipcRenderer.removeAllListeners('window:fullscreen-changed'),
  onOpenPdfFromSystem: (callback) => {
    systemOpenCallback = callback
    for (const message of pendingSystemOpenMessages.splice(0)) {
      callback(message)
    }
    return () => {
      if (systemOpenCallback === callback) {
        systemOpenCallback = null
      }
    }
  },
  notifyRendererReady: () => ipcRenderer.send('pdf:renderer-ready'),
  getMemoryUsage: () => ipcRenderer.invoke('performance:get-memory'),
})
