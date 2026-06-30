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
  openPdfPath: (filePath) => ipcRenderer.invoke('pdf:open-path', filePath),
  pickMergePdfs: () => ipcRenderer.invoke('tools:merge-pick-pdfs'),
  inspectMergePdfs: (files) =>
    ipcRenderer.invoke(
      'tools:merge-inspect-pdfs',
      Array.from(files ?? []).map((file) =>
        typeof file === 'string' ? file : webUtils.getPathForFile(file),
      ),
    ),
  mergePdfs: (options) => ipcRenderer.invoke('tools:merge-pdfs', options),
  pickImagesForPdf: () => ipcRenderer.invoke('tools:images-pick'),
  inspectImagesForPdf: (files) =>
    ipcRenderer.invoke(
      'tools:images-inspect',
      Array.from(files ?? []).map((file) =>
        typeof file === 'string' ? file : webUtils.getPathForFile(file),
      ),
    ),
  imagesToPdf: (options) => ipcRenderer.invoke('tools:images-to-pdf', options),
  listSignatures: () => ipcRenderer.invoke('signatures:list'),
  pickSignatureImage: () => ipcRenderer.invoke('signatures:pick-image'),
  createSignature: (signature) => ipcRenderer.invoke('signatures:create', signature),
  updateSignature: (id, patch) => ipcRenderer.invoke('signatures:update', id, patch),
  deleteSignature: (id) => ipcRenderer.invoke('signatures:delete', id),
  duplicateSignature: (id) => ipcRenderer.invoke('signatures:duplicate', id),
  setDefaultSignature: (id) => ipcRenderer.invoke('signatures:set-default', id),
  getRecentPdfs: () => ipcRenderer.invoke('pdf:recent-list'),
  openRecentPdf: (id) => ipcRenderer.invoke('pdf:open-recent', id),
  clearRecentPdfs: () => ipcRenderer.invoke('pdf:recent-clear'),
  removeRecentPdf: (id) => ipcRenderer.invoke('pdf:recent-remove', id),
  getWorkspace: () => ipcRenderer.invoke('workspace:get'),
  saveWorkspace: (workspace) => ipcRenderer.invoke('workspace:save', workspace),
  listWorkspaces: () => ipcRenderer.invoke('workspaces:list'),
  getActiveWorkspace: () => ipcRenderer.invoke('workspaces:get-active'),
  getWorkspaceDetails: (id) => ipcRenderer.invoke('workspaces:get-details', id),
  createWorkspace: (workspace) => ipcRenderer.invoke('workspaces:create', workspace),
  updateWorkspace: (id, patch) => ipcRenderer.invoke('workspaces:update', id, patch),
  deleteWorkspace: (id) => ipcRenderer.invoke('workspaces:delete', id),
  switchWorkspace: (id, currentSession) =>
    ipcRenderer.invoke('workspaces:switch', id, currentSession),
  addWorkspaceDocument: (workspaceId, documentId) =>
    ipcRenderer.invoke('workspaces:add-document', workspaceId, documentId),
  removeWorkspaceDocument: (workspaceId, documentId) =>
    ipcRenderer.invoke('workspaces:remove-document', workspaceId, documentId),
  exportWorkspace: (id, format) => ipcRenderer.invoke('workspaces:export', id, format),
  importWorkspace: () => ipcRenderer.invoke('workspaces:import'),
  queryReferences: (request) => ipcRenderer.invoke('references:query', request),
  getReference: (id) => ipcRenderer.invoke('references:get', id),
  touchReference: (id) => ipcRenderer.invoke('references:touch', id),
  upsertExtractedReference: (payload) => ipcRenderer.invoke('references:upsert-extracted', payload),
  updateReference: (id, patch) => ipcRenderer.invoke('references:update', id, patch),
  lookupDoi: (doi) => ipcRenderer.invoke('references:lookup-doi', doi),
  removeReferenceSourceDocument: (documentId) => ipcRenderer.invoke('references:remove-source-document', documentId),
  createManualReference: (payload) => ipcRenderer.invoke('references:create-manual', payload),
  createReferenceCollection: (payload) => ipcRenderer.invoke('references:collection-create', payload),
  updateReferenceCollection: (id, patch) => ipcRenderer.invoke('references:collection-update', id, patch),
  deleteReferenceCollection: (id) => ipcRenderer.invoke('references:collection-delete', id),
  deleteReferences: (ids) => ipcRenderer.invoke('references:delete', ids),
  setReferenceCollections: (id, collectionIds) => ipcRenderer.invoke('references:set-collections', id, collectionIds),
  setWorkspaceReference: (workspaceId, referenceId, included) => ipcRenderer.invoke('references:set-workspace-membership', workspaceId, referenceId, included),
  getReferenceDuplicates: () => ipcRenderer.invoke('references:duplicates'),
  keepReferencesSeparate: (ids) => ipcRenderer.invoke('references:keep-separate', ids),
  mergeReferences: (primaryId, duplicateIds) => ipcRenderer.invoke('references:merge', primaryId, duplicateIds),
  exportReferences: (options) => ipcRenderer.invoke('references:export', options),
  revealPdf: (id) => ipcRenderer.invoke('pdf:reveal', id),
  savePdfState: (id, state) => ipcRenderer.invoke('pdf:save-state', id, state),
  saveOcrDetection: (id, detection) => ipcRenderer.invoke('pdf:save-ocr-detection', id, detection),
  listPageOcrResults: (documentId) => ipcRenderer.invoke('ocr:list-page-results', documentId),
  runPageOcr: (request) => ipcRenderer.invoke('ocr:run-page', request),
  cancelPageOcr: (operationId) => ipcRenderer.invoke('ocr:cancel-page', operationId),
  onPageOcrProgress: (callback) => {
    const listener = (_event, progress) => callback(progress)
    ipcRenderer.on('ocr:page-progress', listener)
    return () => ipcRenderer.removeListener('ocr:page-progress', listener)
  },
  savePdfHighlights: (identity, highlights) =>
    ipcRenderer.invoke('pdf:save-highlights', identity, highlights),
  savePdfSignaturePlacements: (identity, placements) =>
    ipcRenderer.invoke('pdf:save-signature-placements', identity, placements),
  savePdfFillSignFields: (identity, fields) =>
    ipcRenderer.invoke('pdf:save-fill-sign-fields', identity, fields),
  saveSignedPdf: (options) => ipcRenderer.invoke('pdf:save-signed-copy', options),
  exportHighlights: (options) => ipcRenderer.invoke('pdf:export-highlights', options),
  getHighlightLibrary: () => ipcRenderer.invoke('highlights:library-list'),
  openHighlightDocument: (documentKey) =>
    ipcRenderer.invoke('highlights:open-document', documentKey),
  updateHighlightLibrary: (updates) =>
    ipcRenderer.invoke('highlights:library-update', updates),
  deleteHighlightLibraryEntries: (keys) =>
    ipcRenderer.invoke('highlights:library-delete', keys),
  exportHighlightLibrary: (options) =>
    ipcRenderer.invoke('highlights:library-export', options),
  getSearchIndexStatus: (identity) => ipcRenderer.invoke('search:index-status', identity),
  startSearchIndex: (payload) => ipcRenderer.invoke('search:index-start', payload),
  appendSearchIndexPages: (documentId, pages) =>
    ipcRenderer.invoke('search:index-pages', documentId, pages),
  completeSearchIndex: (documentId) => ipcRenderer.invoke('search:index-complete', documentId),
  cancelSearchIndex: (documentId) => ipcRenderer.invoke('search:index-cancel', documentId),
  searchLibrary: (request) => ipcRenderer.invoke('search:query', request),
  getSearchLibraryInfo: () => ipcRenderer.invoke('search:library-info'),
  recordGlobalSearch: (query) => ipcRenderer.invoke('search:record-history', query),
  clearGlobalSearchHistory: () => ipcRenderer.invoke('search:clear-history'),
  saveGlobalSearch: (search) => ipcRenderer.invoke('search:save', search),
  deleteSavedGlobalSearch: (id) => ipcRenderer.invoke('search:delete-saved', id),
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
  getPdfOpenDestination: () => ipcRenderer.invoke('preferences:get-pdf-open-destination'),
  setPdfOpenDestination: (destination) =>
    ipcRenderer.invoke('preferences:set-pdf-open-destination', destination),
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
