import { app, BrowserWindow, dialog, ipcMain, nativeImage, screen, shell } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { degrees, PDFDocument, rgb, StandardFonts } from 'pdf-lib'
import { GlobalSearchIndex } from './search-index.js'
import {
  buildBibliography,
  buildBibliographyDocx,
  citationQuality,
  citationStyles,
  citationsFor,
  effectiveReference,
  findDuplicateGroups,
  isExportableReference,
  referenceSearchText,
  sanitizeSourceDocument,
  sanitizeMetadata as sanitizeReferenceMetadata,
  sanitizeReference,
  validateReference,
} from './references.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const appDataRoot = process.env.NEXT_PDF_VIEWER_DATA_DIR
  ? path.resolve(process.env.NEXT_PDF_VIEWER_DATA_DIR)
  : app.isPackaged
    ? path.join(app.getPath('appData'), 'Next PDF Viewer')
    : path.join(process.cwd(), '.electron-data')

app.setPath('userData', path.join(appDataRoot, 'user-data'))
app.setPath('logs', path.join(appDataRoot, 'logs'))
app.setPath('crashDumps', path.join(appDataRoot, 'crash-dumps'))
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('disable-gpu-compositing')
app.commandLine.appendSwitch('disk-cache-dir', path.join(appDataRoot, 'cache'))
app.commandLine.appendSwitch('password-store', 'basic')

const globalSearchIndex = new GlobalSearchIndex(path.join(appDataRoot, 'search-index'))

let mainWindow = null
let storeCache = null
let storeOperation = Promise.resolve()
let rendererReady = false
let processingSystemPdf = false
const pendingSystemPdfPaths = []
const DEFAULT_WORKSPACE_ID = 'default-workspace'
const hasSingleInstanceLock = app.requestSingleInstanceLock()

if (!hasSingleInstanceLock) {
  app.quit()
}

function emptyStore() {
  return {
    recentFiles: [],
    documentRegistry: {},
    documentStates: {},
    highlightDocuments: {},
    signaturePlacementDocuments: {},
    fillSignDocuments: {},
    highlightLibraryIndex: {},
    highlightLibraryVersion: 2,
    workspace: {
      tabs: [],
      activeTabId: null,
      closedTabs: [],
      split: {
        enabled: false,
        dividerRatio: 0.5,
        activePane: 'left',
        leftPane: { id: 'left', tabId: null, documentId: null, fileName: null, state: null },
        rightPane: { id: 'right', tabId: null, documentId: null, fileName: null, state: null },
        syncScrolling: false,
      },
    },
    workspaceSystem: null,
    referenceLibrary: { version: 2, items: {}, sourceDocuments: {}, removedSourceDocumentIds: [], collections: [] },
    signatureLibrary: { version: 1, items: [] },
    preferences: {
      sidebarTab: 'thumbnails',
      viewMode: 'continuous',
      viewerBackground: 'dark-gray',
      sidebarWidth: 280,
      sidebarCollapsed: false,
      defaultPdfOpenDestination: 'ask',
    },
    windowState: null,
  }
}

function getDocumentId(filePath) {
  const normalizedPath = process.platform === 'win32' ? filePath.toLowerCase() : filePath
  return createHash('sha256').update(normalizedPath).digest('hex')
}

function getPdfPathFromArguments(argumentsList, workingDirectory = process.cwd()) {
  for (const argument of argumentsList) {
    if (typeof argument !== 'string' || argument.startsWith('-')) {
      continue
    }

    let candidate = argument.trim().replace(/^"|"$/g, '')
    if (candidate.startsWith('file://')) {
      try {
        candidate = fileURLToPath(candidate)
      } catch {
        continue
      }
    }

    if (path.extname(candidate).toLowerCase() !== '.pdf') {
      continue
    }

    return path.isAbsolute(candidate)
      ? path.normalize(candidate)
      : path.resolve(workingDirectory, candidate)
  }

  return null
}

function enqueueSystemPdf(filePath) {
  if (!filePath) {
    return
  }

  pendingSystemPdfPaths.push(filePath)
  void processPendingSystemPdfs()
}

async function processPendingSystemPdfs() {
  if (
    processingSystemPdf ||
    !rendererReady ||
    !mainWindow ||
    mainWindow.isDestroyed()
  ) {
    return
  }

  processingSystemPdf = true
  try {
    while (
      pendingSystemPdfPaths.length > 0 &&
      rendererReady &&
      mainWindow &&
      !mainWindow.isDestroyed()
    ) {
      const filePath = pendingSystemPdfPaths.shift()
      const targetWindow = mainWindow
      targetWindow.webContents.send('pdf:open-from-system', { status: 'loading' })

      try {
        const pdf = await loadPdf(filePath)
        if (!targetWindow.isDestroyed()) {
          targetWindow.webContents.send('pdf:open-from-system', { status: 'success', pdf })
        }
      } catch (error) {
        if (!targetWindow.isDestroyed()) {
          targetWindow.webContents.send('pdf:open-from-system', {
            status: 'error',
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
    }
  } finally {
    processingSystemPdf = false
  }
}

async function showAndFocusMainWindow() {
  if ((!mainWindow || mainWindow.isDestroyed()) && app.isReady()) {
    await createWindow()
  }

  if (!mainWindow || mainWindow.isDestroyed()) {
    return
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore()
  }
  if (!mainWindow.isVisible()) {
    mainWindow.show()
  }
  mainWindow.focus()
}

function getStorePath() {
  return path.join(app.getPath('userData'), 'viewer-state.json')
}

async function readStore() {
  if (storeCache) {
    return storeCache
  }

  try {
    const parsed = JSON.parse(await fs.readFile(getStorePath(), 'utf8'))
    storeCache = {
      recentFiles: Array.isArray(parsed.recentFiles) ? parsed.recentFiles : [],
      documentRegistry:
        parsed.documentRegistry && typeof parsed.documentRegistry === 'object'
          ? parsed.documentRegistry
          : Object.fromEntries(
              (Array.isArray(parsed.recentFiles) ? parsed.recentFiles : [])
                .filter((item) => item?.id)
                .map((item) => [item.id, item]),
            ),
      documentStates:
        parsed.documentStates && typeof parsed.documentStates === 'object'
          ? parsed.documentStates
          : {},
      highlightDocuments:
        parsed.highlightDocuments && typeof parsed.highlightDocuments === 'object'
          ? parsed.highlightDocuments
          : {},
      signaturePlacementDocuments:
        parsed.signaturePlacementDocuments && typeof parsed.signaturePlacementDocuments === 'object'
          ? sanitizeSignaturePlacementDocuments(parsed.signaturePlacementDocuments)
          : {},
      fillSignDocuments:
        parsed.fillSignDocuments && typeof parsed.fillSignDocuments === 'object'
          ? sanitizeFillSignDocuments(parsed.fillSignDocuments)
          : {},
      highlightLibraryIndex:
        parsed.highlightLibraryIndex && typeof parsed.highlightLibraryIndex === 'object'
          ? parsed.highlightLibraryIndex
          : {},
      highlightLibraryVersion: Number(parsed.highlightLibraryVersion) || 0,
      workspace: sanitizeWorkspace(parsed.workspace),
      workspaceSystem: parsed.workspaceSystem,
      referenceLibrary: sanitizeReferenceLibrary(parsed.referenceLibrary, parsed.documentRegistry),
      signatureLibrary: sanitizeSignatureLibrary(parsed.signatureLibrary),
      preferences: {
        sidebarTab: ['thumbnails', 'bookmarks', 'highlights', 'info'].includes(parsed.preferences?.sidebarTab)
          ? parsed.preferences.sidebarTab
          : 'thumbnails',
        viewMode: parsed.preferences?.viewMode === 'single' ? 'single' : 'continuous',
        viewerBackground: ['dark-gray', 'black', 'light-gray', 'white'].includes(
          parsed.preferences?.viewerBackground,
        )
          ? parsed.preferences.viewerBackground
          : 'dark-gray',
        sidebarWidth: Math.min(400, Math.max(220, Number(parsed.preferences?.sidebarWidth) || 280)),
        sidebarCollapsed: parsed.preferences?.sidebarCollapsed === true,
        defaultPdfOpenDestination: sanitizePdfOpenDestination(
          parsed.preferences?.defaultPdfOpenDestination,
        ),
      },
      windowState: sanitizeWindowState(parsed.windowState),
    }
    if (storeCache.highlightLibraryVersion !== 2) {
      rebuildHighlightLibraryIndex(storeCache)
    }
    for (const document of Object.values(storeCache.highlightDocuments)) {
      if (!document?.filePath) continue
      const id = getDocumentId(document.filePath)
      if (!storeCache.documentRegistry[id]) {
        storeCache.documentRegistry[id] = {
          id,
          name: path.basename(document.filePath),
          path: document.filePath,
          fileSize: Number(document.fileSize) || 0,
          modifiedAt: Number(document.modifiedAt) || 0,
          openedAt: 0,
        }
      }
    }
    storeCache.workspaceSystem = sanitizeWorkspaceSystem(
      storeCache.workspaceSystem,
      storeCache.workspace,
      storeCache.documentRegistry,
    )
    storeCache.workspace = getActiveWorkspaceProject(storeCache).session
    storeCache.referenceLibrary = sanitizeReferenceLibrary(
      storeCache.referenceLibrary,
      storeCache.documentRegistry,
    )
    storeCache.signatureLibrary = sanitizeSignatureLibrary(storeCache.signatureLibrary)
  } catch (error) {
    if (error.code !== 'ENOENT' && error.name !== 'SyntaxError') {
      throw error
    }
    storeCache = emptyStore()
    storeCache.workspaceSystem = sanitizeWorkspaceSystem(
      null,
      storeCache.workspace,
      storeCache.documentRegistry,
    )
    storeCache.workspace = getActiveWorkspaceProject(storeCache).session
    storeCache.referenceLibrary = sanitizeReferenceLibrary(null, storeCache.documentRegistry)
    storeCache.signatureLibrary = sanitizeSignatureLibrary(null)
  }

  return storeCache
}

function withStore(operation) {
  const result = storeOperation.then(async () => operation(await readStore()))
  storeOperation = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

async function saveStore(store) {
  await fs.mkdir(path.dirname(getStorePath()), { recursive: true })
  const storePath = getStorePath()
  const temporaryPath = `${storePath}.tmp`
  await fs.writeFile(temporaryPath, JSON.stringify(store, null, 2), 'utf8')
  await fs.rename(temporaryPath, storePath)
}

function sanitizeReadingState(state) {
  const rotation = ((Math.round((Number(state?.rotation) || 0) / 90) * 90) % 360 + 360) % 360
  return {
    page: Math.max(1, Math.trunc(Number(state?.page) || 1)),
    zoom: Math.min(4, Math.max(0.25, Number(state?.zoom) || 1)),
    fitMode: state?.fitMode === true,
    rotation,
  }
}

function sanitizeTabState(state) {
  const sidebarTab = ['thumbnails', 'bookmarks', 'highlights', 'info'].includes(state?.sidebarTab)
    ? state.sidebarTab
    : 'thumbnails'
  return {
    ...sanitizeReadingState(state),
    pageOffset: Math.min(1, Math.max(0, Number(state?.pageOffset) || 0)),
    searchOpen: state?.searchOpen === true,
    searchQuery: String(state?.searchQuery ?? '').slice(0, 500),
    selectedMatchIndex: Math.max(-1, Math.trunc(Number(state?.selectedMatchIndex) || 0)),
    sidebarOpen: state?.sidebarOpen !== false,
    sidebarTab,
    sidebarWidth: Math.min(400, Math.max(220, Number(state?.sidebarWidth) || 280)),
  }
}

function sanitizeWorkspaceTab(tab) {
  if (!tab || typeof tab !== 'object') {
    return null
  }

  const tabId = String(tab.tabId ?? '').slice(0, 100)
  const documentId = String(tab.documentId ?? '').slice(0, 128)
  const name = path.basename(String(tab.name ?? '')).slice(0, 260)
  if (!tabId || !documentId || !name) {
    return null
  }

  return {
    tabId,
    documentId,
    name,
    state: sanitizeTabState(tab.state),
  }
}

function sanitizeWorkspace(workspace) {
  const tabs = Array.isArray(workspace?.tabs)
    ? workspace.tabs.map(sanitizeWorkspaceTab).filter(Boolean).slice(0, 50)
    : []
  const tabIds = new Set(tabs.map((tab) => tab.tabId))
  const activeTabId = tabIds.has(workspace?.activeTabId) ? workspace.activeTabId : tabs[0]?.tabId ?? null
  const closedTabs = Array.isArray(workspace?.closedTabs)
    ? workspace.closedTabs.map(sanitizeWorkspaceTab).filter(Boolean).slice(0, 20)
    : []

  const sanitizePane = (side, pane, legacyTabId, fallbackTabId = null) => {
    const requestedTabId = String(pane?.tabId ?? legacyTabId ?? '')
    const tabId = tabIds.has(requestedTabId)
      ? requestedTabId
      : tabIds.has(fallbackTabId)
        ? fallbackTabId
        : null
    const tab = tabs.find((candidate) => candidate.tabId === tabId)
    return {
      id: side,
      tabId: tab?.tabId ?? null,
      documentId: tab?.documentId ?? null,
      fileName: tab?.name ?? null,
      state: tab ? sanitizeTabState(pane?.state ?? tab.state) : null,
    }
  }
  const leftPane = sanitizePane(
    'left',
    workspace?.split?.leftPane,
    workspace?.split?.leftTabId,
    activeTabId,
  )
  const rightPane = sanitizePane(
    'right',
    workspace?.split?.rightPane,
    workspace?.split?.rightTabId,
  )
  const dividerRatio = Math.min(
    0.75,
    Math.max(0.25, Number(workspace?.split?.dividerRatio ?? workspace?.split?.ratio) || 0.5),
  )
  const splitEnabled = workspace?.split?.enabled === true && Boolean(leftPane.tabId)
  const activePane = splitEnabled && workspace?.split?.activePane === 'right' ? 'right' : 'left'
  const split = {
    enabled: splitEnabled,
    dividerRatio,
    activePane,
    leftPane,
    rightPane,
    syncScrolling: workspace?.split?.syncScrolling === true,
  }

  return {
    tabs,
    activeTabId:
      activePane === 'right'
        ? rightPane.tabId ?? leftPane.tabId ?? activeTabId
        : leftPane.tabId ?? activeTabId,
    closedTabs,
    split,
  }
}

function removeDocumentFromWorkspace(workspace, documentId) {
  return sanitizeWorkspace({
    ...workspace,
    tabs: (workspace?.tabs ?? []).filter((tab) => tab.documentId !== documentId),
    closedTabs: (workspace?.closedTabs ?? []).filter((tab) => tab.documentId !== documentId),
  })
}

function sanitizeWorkspaceSystem(system, legacySession, documentRegistry) {
  const requestedItems = Array.isArray(system?.items)
    ? system.items.map((item) => sanitizeWorkspaceProject(item)).filter(Boolean)
    : []
  const items = requestedItems.length > 0
    ? requestedItems
    : [createDefaultWorkspace(legacySession, documentRegistry)]
  const activeWorkspaceId = items.some((item) => item.id === system?.activeWorkspaceId)
    ? system.activeWorkspaceId
    : items[0].id
  return { version: 1, activeWorkspaceId, items }
}

function sanitizeWorkspaceProject(project) {
  if (!project || typeof project !== 'object') return null
  const id = String(project.id ?? '').slice(0, 100)
  const name = String(project.name ?? '').trim().slice(0, 120)
  if (!id || !name) return null
  const createdAt = validIsoDate(project.createdAt) ?? new Date().toISOString()
  const updatedAt = validIsoDate(project.updatedAt) ?? createdAt
  const documentIds = [...new Set(
    (Array.isArray(project.documentIds) ? project.documentIds : project.documents ?? [])
      .map((value) => typeof value === 'string' ? value : value?.documentId)
      .filter((documentId) => typeof documentId === 'string' && documentId.length <= 128),
  )]
  const referenceIds = [...new Set(
    (Array.isArray(project.referenceIds) ? project.referenceIds : documentIds)
      .filter((referenceId) => typeof referenceId === 'string' && referenceId.length <= 128),
  )]
  return {
    id,
    name,
    description: String(project.description ?? '').trim().slice(0, 2000),
    color: sanitizeWorkspaceColor(project.color),
    icon: sanitizeWorkspaceIcon(project.icon),
    template: sanitizeWorkspaceTemplate(project.template),
    createdAt,
    updatedAt,
    documentIds,
    referenceIds,
    session: sanitizeWorkspace(project.session),
    dashboardLayout: sanitizeDashboardLayout(project.dashboardLayout),
    workspaceSettings: sanitizeWorkspaceSettings(project.workspaceSettings),
    activities: sanitizeWorkspaceActivities(project.activities),
  }
}

function createDefaultWorkspace(session, documentRegistry) {
  const now = new Date().toISOString()
  const sanitizedSession = sanitizeWorkspace(session)
  const sessionDocuments = sanitizedSession.tabs.map((tab) => tab.documentId)
  return {
    id: DEFAULT_WORKSPACE_ID,
    name: 'My Research',
    description: 'Default PDF research workspace',
    color: '#3b82f6',
    icon: 'library',
    template: 'blank',
    createdAt: now,
    updatedAt: now,
    documentIds: [...new Set([...Object.keys(documentRegistry ?? {}), ...sessionDocuments])],
    referenceIds: [...new Set([...Object.keys(documentRegistry ?? {}), ...sessionDocuments])],
    session: sanitizedSession,
    dashboardLayout: sanitizeDashboardLayout(null),
    workspaceSettings: sanitizeWorkspaceSettings(null),
    activities: [],
  }
}

function createWorkspaceProject(payload) {
  const now = new Date().toISOString()
  const template = sanitizeWorkspaceTemplate(payload?.template)
  return {
    id: randomUUID(),
    name: String(payload?.name ?? '').trim().slice(0, 120),
    description: String(payload?.description ?? '').trim().slice(0, 2000),
    color: sanitizeWorkspaceColor(payload?.color),
    icon: sanitizeWorkspaceIcon(payload?.icon),
    template,
    createdAt: now,
    updatedAt: now,
    documentIds: [],
    referenceIds: [],
    session: sanitizeWorkspace(null),
    dashboardLayout: templateDashboardLayout(template),
    workspaceSettings: templateWorkspaceSettings(template),
    activities: [{
      id: randomUUID(),
      type: 'workspace-created',
      label: 'Created workspace',
      createdAt: now,
    }],
  }
}

function getActiveWorkspaceProject(store) {
  return store.workspaceSystem.items.find(
    (workspace) => workspace.id === store.workspaceSystem.activeWorkspaceId,
  ) ?? store.workspaceSystem.items[0]
}

function addDocumentToActiveWorkspace(store, documentId, documentName) {
  const workspace = getActiveWorkspaceProject(store)
  if (workspace.documentIds.includes(documentId)) return false
  workspace.documentIds.push(documentId)
  workspace.updatedAt = new Date().toISOString()
  addWorkspaceActivity(workspace, 'document-added', `Added ${documentName}`, { documentId })
  return true
}

function ensureReferenceForDocument(store, record) {
  const existing = store.referenceLibrary.items[record.id]
  if (!existing) {
    store.referenceLibrary.items[record.id] = sanitizeReference({
      id: record.id,
      documentId: record.id,
      documentName: record.name,
      filePath: record.path,
      metadata: {},
    }, record)
  }
  const workspace = getActiveWorkspaceProject(store)
  if (!workspace.referenceIds.includes(record.id)) workspace.referenceIds.push(record.id)
  return store.referenceLibrary.items[record.id]
}

function addWorkspaceActivity(workspace, type, label, details = {}) {
  workspace.activities = [{
    id: randomUUID(),
    type: String(type).slice(0, 80),
    label: String(label).slice(0, 500),
    createdAt: new Date().toISOString(),
    ...details,
  }, ...(workspace.activities ?? [])].slice(0, 100)
  workspace.updatedAt = new Date().toISOString()
}

function addActivityForDocumentWorkspaces(store, documentId, type, label, details = {}) {
  for (const workspace of store.workspaceSystem.items) {
    if (workspace.documentIds.includes(documentId)) {
      addWorkspaceActivity(workspace, type, label, { documentId, ...details })
    }
  }
}

function sanitizeWorkspaceActivities(activities) {
  return Array.isArray(activities) ? activities.slice(0, 100).flatMap((activity) => {
    if (!activity || typeof activity !== 'object') return []
    const createdAt = validIsoDate(activity.createdAt)
    if (!createdAt) return []
    return [{
      id: String(activity.id ?? randomUUID()).slice(0, 100),
      type: String(activity.type ?? 'activity').slice(0, 80),
      label: String(activity.label ?? '').slice(0, 500),
      createdAt,
      documentId: typeof activity.documentId === 'string' ? activity.documentId : undefined,
      count: Number.isFinite(Number(activity.count)) ? Number(activity.count) : undefined,
    }]
  }) : []
}

function sanitizeDashboardLayout(layout) {
  const allowed = ['statistics', 'documents', 'highlights', 'notes', 'saved-searches', 'activity']
  const sections = Array.isArray(layout?.sections)
    ? layout.sections.filter((section) => allowed.includes(section))
    : allowed
  return { sections: [...new Set(sections.length ? sections : allowed)] }
}

function sanitizeWorkspaceSettings(settings) {
  return {
    defaultCategory: ['important', 'research', 'reference', 'question'].includes(settings?.defaultCategory)
      ? settings.defaultCategory
      : 'important',
    searchScope: settings?.searchScope === 'all' ? 'all' : 'workspace',
  }
}

function templateDashboardLayout(template) {
  const layouts = {
    research: ['statistics', 'documents', 'highlights', 'notes', 'saved-searches', 'activity'],
    dissertation: ['statistics', 'highlights', 'notes', 'documents', 'saved-searches', 'activity'],
    coursework: ['documents', 'notes', 'highlights', 'statistics', 'saved-searches', 'activity'],
    legal: ['documents', 'highlights', 'notes', 'activity', 'statistics', 'saved-searches'],
    blank: ['statistics', 'documents', 'highlights', 'notes', 'saved-searches', 'activity'],
  }
  return { sections: layouts[template] ?? layouts.blank }
}

function templateWorkspaceSettings(template) {
  return {
    defaultCategory: template === 'legal' ? 'reference' : template === 'dissertation' ? 'research' : 'important',
    searchScope: 'workspace',
  }
}

function sanitizeWorkspaceTemplate(template) {
  return ['research', 'dissertation', 'coursework', 'legal', 'blank'].includes(template)
    ? template
    : 'blank'
}

function sanitizeWorkspaceColor(color) {
  return /^#[0-9a-f]{6}$/i.test(String(color ?? '')) ? String(color) : '#3b82f6'
}

function sanitizeWorkspaceIcon(icon) {
  return ['library', 'research', 'graduation', 'legal', 'finance', 'folder'].includes(icon)
    ? icon
    : 'folder'
}

function sanitizePdfOpenDestination(destination) {
  return ['ask', 'individual', 'current-workspace', 'choose-workspace'].includes(destination)
    ? destination
    : 'ask'
}

function validIsoDate(value) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function uniqueStrings(values, limit, itemLimit) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value).trim().slice(0, itemLimit)).filter(Boolean))].slice(0, limit)
}

function sanitizeReferenceLibrary(library, documentRegistry) {
  const items = {}
  for (const [id, candidate] of Object.entries(library?.items ?? {})) {
    const reference = sanitizeReference(candidate, documentRegistry?.[id])
    if (reference.id && reference.documentId) items[reference.id] = reference
  }
  const removedSourceDocumentIds = uniqueStrings(library?.removedSourceDocumentIds, 10000, 128)
  const removedSourceDocuments = new Set(removedSourceDocumentIds)
  const sourceDocuments = {}
  for (const [id, candidate] of Object.entries(library?.sourceDocuments ?? {})) {
    const document = sanitizeSourceDocument(candidate, documentRegistry?.[id])
    if (document.documentId && !removedSourceDocuments.has(document.documentId)) sourceDocuments[document.documentId] = document
  }
  for (const record of Object.values(documentRegistry ?? {})) {
    if (!record?.id || sourceDocuments[record.id] || removedSourceDocuments.has(record.id)) continue
    sourceDocuments[record.id] = sanitizeSourceDocument({
      documentId: record.id,
      fileName: record.name,
      filePath: record.path,
      referenceSectionStatus: 'not_checked',
    }, record)
  }
  const collections = Array.isArray(library?.collections) ? library.collections.slice(0, 1000).flatMap((collection) => {
    const id = String(collection?.id ?? '').slice(0, 100)
    const name = String(collection?.name ?? '').trim().slice(0, 120)
    if (!id || !name) return []
    return [{ id, name, description: String(collection?.description ?? '').slice(0, 1000), color: sanitizeWorkspaceColor(collection?.color), createdAt: validIsoDate(collection?.createdAt) ?? new Date().toISOString() }]
  }) : []
  return { version: 2, items, sourceDocuments, removedSourceDocumentIds, collections }
}

function sanitizeSignatureLibrary(library) {
  const items = []
  for (const candidate of Array.isArray(library?.items) ? library.items : []) {
    const signature = sanitizeSignature(candidate)
    if (signature) items.push(signature)
  }
  const defaultIds = items.filter((item) => item.isDefault).map((item) => item.id)
  if (defaultIds.length > 1) {
    const defaultId = defaultIds[0]
    for (const item of items) item.isDefault = item.id === defaultId
  }
  return { version: 1, items }
}

function sanitizeSignature(candidate) {
  const id = String(candidate?.id ?? '').slice(0, 128) || randomUUID()
  const type = ['drawn', 'uploaded', 'typed'].includes(candidate?.type) ? candidate.type : 'drawn'
  const imageDataUrl = normalizeSignatureDataUrl(candidate?.imageDataUrl)
  if (!imageDataUrl) return null
  const createdAt = validIsoDate(candidate?.createdAt) ?? new Date().toISOString()
  return {
    id,
    name: String(candidate?.name ?? 'Signature').trim().slice(0, 120) || 'Signature',
    createdAt,
    updatedAt: validIsoDate(candidate?.updatedAt) ?? createdAt,
    type,
    isDefault: candidate?.isDefault === true,
    imageDataUrl,
    width: Math.max(1, Math.trunc(Number(candidate?.width) || 1)),
    height: Math.max(1, Math.trunc(Number(candidate?.height) || 1)),
  }
}

function normalizeSignatureDataUrl(value) {
  const dataUrl = String(value ?? '')
  if (!dataUrl.startsWith('data:image/png;base64,')) return ''
  if (dataUrl.length > 8_000_000) throw new Error('Signature image is too large.')
  const image = nativeImage.createFromDataURL(dataUrl)
  if (image.isEmpty()) return ''
  return image.toDataURL()
}

function sanitizeSignaturePlacementDocuments(documents) {
  const output = {}
  for (const [key, document] of Object.entries(documents ?? {})) {
    if (!document || typeof document !== 'object') continue
    const documentId = document.filePath ? getDocumentId(document.filePath) : ''
    output[key] = {
      filePath: String(document.filePath ?? ''),
      fileSize: Number(document.fileSize) || 0,
      modifiedAt: Number(document.modifiedAt) || 0,
      placements: Array.isArray(document.placements)
        ? document.placements.map((placement) => sanitizeSignaturePlacement(placement, documentId)).filter(Boolean)
        : [],
    }
  }
  return output
}

function sanitizeSignaturePlacement(candidate, documentId = '') {
  if (!candidate || typeof candidate !== 'object') return null
  const id = String(candidate.id ?? '').slice(0, 128) || randomUUID()
  const signatureId = String(candidate.signatureId ?? '').slice(0, 128)
  if (!signatureId) return null
  const pageNumber = Math.max(1, Math.trunc(Number(candidate.pageNumber) || 1))
  const requestedWidth = Number(candidate.widthRatio ?? candidate.width)
  const requestedHeight = Number(candidate.heightRatio ?? candidate.height)
  const width = Math.min(0.9, Math.max(0.03, requestedWidth || 0.25))
  const height = Math.min(0.6, Math.max(0.02, requestedHeight || 0.08))
  const x = Math.min(1 - width, Math.max(0, Number(candidate.xRatio ?? candidate.x) || 0))
  const y = Math.min(1 - height, Math.max(0, Number(candidate.yRatio ?? candidate.y) || 0))
  const createdAt = validIsoDate(candidate.createdAt) ?? new Date().toISOString()
  return {
    id,
    signatureId,
    documentId: String(candidate.documentId ?? documentId ?? '').slice(0, 128),
    pageNumber,
    x,
    y,
    width,
    height,
    xRatio: x,
    yRatio: y,
    widthRatio: width,
    heightRatio: height,
    pageRotation: ((Math.round((Number(candidate.pageRotation) || 0) / 90) * 90) % 360 + 360) % 360,
    rotation: Math.max(-3600, Math.min(3600, Number(candidate.rotation) || 0)),
    opacity: Math.min(1, Math.max(0.2, Number(candidate.opacity) || 1)),
    createdAt,
  }
}

function getStoredSignaturePlacements(store, filePath, fileSize, modifiedAt) {
  const document = store.signaturePlacementDocuments?.[
    getHighlightDocumentKey(filePath, fileSize, modifiedAt)
  ]
  const documentId = getDocumentId(filePath)
  return Array.isArray(document?.placements)
    ? document.placements.map((placement) => sanitizeSignaturePlacement(placement, documentId)).filter(Boolean)
    : []
}

function sanitizeFillSignDocuments(documents) {
  const output = {}
  for (const [key, document] of Object.entries(documents ?? {})) {
    if (!document || typeof document !== 'object') continue
    const documentId = document.filePath ? getDocumentId(document.filePath) : ''
    output[key] = {
      filePath: String(document.filePath ?? ''),
      fileSize: Number(document.fileSize) || 0,
      modifiedAt: Number(document.modifiedAt) || 0,
      fields: Array.isArray(document.fields)
        ? document.fields.map((field) => sanitizeFillSignField(field, documentId)).filter(Boolean)
        : [],
    }
  }
  return output
}

function sanitizeFillSignField(candidate, documentId = '') {
  if (!candidate || typeof candidate !== 'object') return null
  const type = ['text', 'date', 'initials', 'checkbox'].includes(candidate.type) ? candidate.type : 'text'
  const id = String(candidate.id ?? '').slice(0, 128) || randomUUID()
  const pageNumber = Math.max(1, Math.trunc(Number(candidate.pageNumber) || 1))
  const requestedWidth = Number(candidate.widthRatio ?? candidate.width)
  const requestedHeight = Number(candidate.heightRatio ?? candidate.height)
  const width = Math.min(0.9, Math.max(0.015, requestedWidth || (type === 'checkbox' ? 0.035 : 0.22)))
  const height = Math.min(0.6, Math.max(0.015, requestedHeight || (type === 'checkbox' ? 0.035 : 0.05)))
  const x = Math.min(1 - width, Math.max(0, Number(candidate.xRatio ?? candidate.x) || 0))
  const y = Math.min(1 - height, Math.max(0, Number(candidate.yRatio ?? candidate.y) || 0))
  const dateFormat = ['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD'].includes(candidate.dateFormat)
    ? candidate.dateFormat
    : undefined
  const color = ['black', 'blue', 'dark-gray'].includes(candidate.color) ? candidate.color : 'black'
  const createdAt = validIsoDate(candidate.createdAt) ?? new Date().toISOString()
  return {
    id,
    documentId: String(candidate.documentId ?? documentId ?? '').slice(0, 128),
    pageNumber,
    type,
    text: String(candidate.text ?? '').slice(0, 4000),
    checked: candidate.checked === true,
    x,
    y,
    width,
    height,
    xRatio: x,
    yRatio: y,
    widthRatio: width,
    heightRatio: height,
    pageRotation: normalizeDegrees(candidate.pageRotation),
    fontSize: Math.min(72, Math.max(6, Number(candidate.fontSize) || 14)),
    color,
    dateFormat,
    createdAt,
  }
}

function getStoredFillSignFields(store, filePath, fileSize, modifiedAt) {
  const document = store.fillSignDocuments?.[
    getHighlightDocumentKey(filePath, fileSize, modifiedAt)
  ]
  const documentId = getDocumentId(filePath)
  return Array.isArray(document?.fields)
    ? document.fields.map((field) => sanitizeFillSignField(field, documentId)).filter(Boolean)
    : []
}

function referenceEntryId(documentId, rawText) {
  return `ref_${createHash('sha256').update(`${documentId}\n${String(rawText ?? '').trim()}`).digest('hex').slice(0, 24)}`
}

function normalizeDoiInput(value) {
  return String(value ?? '')
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '')
    .replace(/[.,;)]*$/, '')
}

function isValidDoi(value) {
  return /^10\.\d{4,9}\/[-._;()/:A-Z0-9]+$/i.test(value)
}

function cslText(value) {
  return Array.isArray(value) ? String(value[0] ?? '').trim() : typeof value === 'string' ? value.trim() : ''
}

function cslYear(item) {
  for (const key of ['issued', 'published-print', 'published-online', 'created']) {
    const year = item?.[key]?.['date-parts']?.[0]?.[0]
    if (/^\d{4}$/.test(String(year))) return String(year)
  }
  return ''
}

function cslAuthors(authors) {
  return Array.isArray(authors)
    ? authors.flatMap((author) => {
        const family = String(author?.family ?? '').trim()
        const given = String(author?.given ?? '').trim()
        const literal = String(author?.literal ?? '').trim()
        const name = literal || [given, family].filter(Boolean).join(' ')
        return name ? [name] : []
      }).slice(0, 100)
    : []
}

function cslReferenceType(type) {
  if (['article-journal', 'journal-article'].includes(type)) return 'Journal'
  if (['paper-conference', 'proceedings-article'].includes(type)) return 'Conference'
  if (['book', 'chapter', 'book-section'].includes(type)) return 'Book'
  if (['thesis', 'dissertation'].includes(type)) return 'Thesis'
  if (['report', 'standard'].includes(type)) return 'Report'
  if (['webpage', 'post-weblog'].includes(type)) return 'Website'
  return ''
}

function metadataFromCsl(item, doi) {
  return {
    title: cslText(item?.title),
    authors: cslAuthors(item?.author),
    year: cslYear(item),
    journal: cslText(item?.['container-title']),
    publisher: String(item?.publisher ?? '').trim(),
    volume: String(item?.volume ?? '').trim(),
    issue: String(item?.issue ?? '').trim(),
    pages: String(item?.page ?? '').trim(),
    doi: normalizeDoiInput(item?.DOI || doi),
    url: String(item?.URL ?? `https://doi.org/${doi}`).trim(),
    referenceType: cslReferenceType(String(item?.type ?? '')),
  }
}

function referenceView(store, reference) {
  const effective = effectiveReference(reference)
  const highlightEntries = Object.values(store.highlightLibraryIndex ?? {}).filter(
    (entry) => entry.documentId === reference.documentId,
  )
  const collections = reference.collectionIds.flatMap((id) => {
    const collection = store.referenceLibrary.collections.find((candidate) => candidate.id === id)
    return collection ? [collection] : []
  })
  const quality = citationQuality(reference)
  return {
    ...effective,
    rawText: reference.rawText,
    confidence: reference.confidence,
    qualityScore: quality.score,
    qualityLabel: quality.label,
    missingFields: quality.missingFields,
    extractionSource: reference.extractionSource,
    sourceDocumentId: reference.sourceDocumentId,
    metadata: reference.metadata,
    overrides: reference.overrides,
    collections,
    citations: citationsFor(reference),
    highlightCount: highlightEntries.length,
    noteCount: highlightEntries.filter((entry) => entry.note).length,
    workspaceIds: store.workspaceSystem.items.filter((workspace) => workspace.referenceIds.includes(reference.id)).map((workspace) => workspace.id),
    missing: store.documentRegistry[reference.documentId]?.missing === true,
  }
}

function queryReferences(store, request) {
  const query = String(request?.query ?? '').trim().toLocaleLowerCase().slice(0, 500)
  const filters = request?.filters ?? {}
  const workspace = filters.workspaceId && filters.workspaceId !== 'all'
    ? store.workspaceSystem.items.find((candidate) => candidate.id === filters.workspaceId)
    : null
  const workspaceIds = workspace ? new Set(workspace.referenceIds) : null
  const collectionNames = new Map(store.referenceLibrary.collections.map((collection) => [collection.id, collection.name]))
  const exportableReferences = Object.values(store.referenceLibrary.items).filter((reference) => !reference.mergedInto && isExportableReference(reference))
  const scopedReferences = workspaceIds
    ? exportableReferences.filter((reference) => workspaceIds.has(reference.id))
    : exportableReferences
  const duplicateReferenceIds = new Set(
    findDuplicateGroups(scopedReferences).flatMap((group) => group.referenceIds),
  )
  let references = exportableReferences.filter((reference) => {
    const item = effectiveReference(reference)
    if (workspaceIds && !workspaceIds.has(reference.id)) return false
    if (filters.collectionId && filters.collectionId !== 'all' && !reference.collectionIds.includes(filters.collectionId)) return false
    if (filters.referenceType && filters.referenceType !== 'all' && item.referenceType !== filters.referenceType) return false
    if (filters.hasDoi === true && !item.doi) return false
    if (filters.duplicateCandidates === true && !duplicateReferenceIds.has(reference.id)) return false
    if (filters.year && filters.year !== 'all' && item.year !== filters.year) return false
    if (filters.publisher && filters.publisher !== 'all' && item.publisher !== filters.publisher) return false
    if (filters.author && filters.author !== 'all' && !item.authors.includes(filters.author)) return false
    if (filters.keyword && filters.keyword !== 'all' && !item.keywords.includes(filters.keyword)) return false
    if (filters.missingMetadata === true && citationQuality(reference).missingFields.length === 0) return false
    if (query && !referenceSearchText(reference, reference.collectionIds.map((id) => collectionNames.get(id) ?? '')).includes(query)) return false
    return true
  })
  references.sort((left, right) => {
    const a = effectiveReference(left)
    const b = effectiveReference(right)
    return request?.sort === 'oldest'
      ? Date.parse(left.createdAt) - Date.parse(right.createdAt)
      : request?.sort === 'title'
        ? a.title.localeCompare(b.title)
        : request?.sort === 'author'
          ? (a.authors[0] ?? '').localeCompare(b.authors[0] ?? '')
          : Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
  })
  const total = references.length
  const offset = Math.max(0, Math.trunc(Number(request?.offset) || 0))
  const limit = Math.min(request?.all === true ? 10000 : 250, Math.max(1, Math.trunc(Number(request?.limit) || 100)))
  const allReferences = scopedReferences
  const all = allReferences.map(effectiveReference)
  const authors = [...new Set(all.flatMap((reference) => reference.authors))].sort()
  const publishers = [...new Set(all.map((reference) => reference.publisher).filter(Boolean))].sort()
  const years = [...new Set(all.map((reference) => reference.year).filter(Boolean))].sort().reverse()
  const keywords = [...new Set(all.flatMap((reference) => reference.keywords))].sort()
  return {
    references: references.slice(offset, offset + limit).map((reference) => referenceView(store, reference)),
    total,
    offset,
    facets: { authors, publishers, years, keywords },
    collections: store.referenceLibrary.collections.map((collection) => ({ ...collection, count: allReferences.filter((reference) => reference.collectionIds.includes(collection.id)).length })),
    workspaces: store.workspaceSystem.items.map((item) => ({
      id: item.id,
      name: item.name,
      count: item.referenceIds.filter((id) => {
        const reference = store.referenceLibrary.items[id]
        return reference && !reference.mergedInto && isExportableReference(reference)
      }).length,
    })),
    activeWorkspaceId: store.workspaceSystem.activeWorkspaceId,
    stats: {
      references: all.length,
      authors: authors.length,
      publishers: publishers.length,
      recent: all.filter((reference) => Date.now() - Date.parse(reference.createdAt) <= 30 * 86400000).length,
      missingMetadata: allReferences.filter((reference) => citationQuality(reference).missingFields.length > 0).length,
      filtered: total,
      journals: all.filter((reference) => reference.referenceType === 'Journal').length,
      conferences: all.filter((reference) => reference.referenceType === 'Conference').length,
      books: all.filter((reference) => reference.referenceType === 'Book').length,
      reports: all.filter((reference) => reference.referenceType === 'Report').length,
      withDoi: all.filter((reference) => Boolean(reference.doi)).length,
      duplicateCandidates: duplicateReferenceIds.size,
    },
    sourceDocuments: Object.values(store.referenceLibrary.sourceDocuments ?? {})
      .sort((left, right) => Date.parse(right.checkedAt) - Date.parse(left.checkedAt))
      .slice(0, 50),
    mostUsed: allReferences
      .filter((reference) => reference.usageCount > 0)
      .sort((left, right) => right.usageCount - left.usageCount)
      .slice(0, 5)
      .map((reference) => ({ id: reference.id, title: effectiveReference(reference).title || reference.documentName, usageCount: reference.usageCount })),
  }
}

function workspaceSummary(workspace, store) {
  const documentIds = new Set(workspace.documentIds)
  const referenceCount = workspace.referenceIds.filter((id) => {
    const reference = store.referenceLibrary.items[id]
    return reference && !reference.mergedInto && isExportableReference(reference)
  }).length
  let highlights = 0
  let notes = 0
  for (const entry of Object.values(store.highlightLibraryIndex ?? {})) {
    if (!documentIds.has(entry.documentId)) continue
    highlights += 1
    if (entry.note) notes += 1
  }
  return {
    id: workspace.id,
    name: workspace.name,
    description: workspace.description,
    color: workspace.color,
    icon: workspace.icon,
    template: workspace.template,
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
    documentCount: workspace.documentIds.length,
    referenceCount,
    highlightCount: highlights,
    noteCount: notes,
  }
}

async function workspaceDetails(store, workspace) {
  if (store.highlightLibraryVersion !== 2) rebuildHighlightLibraryIndex(store)
  const documentIds = new Set(workspace.documentIds)
  const entries = Object.values(store.highlightLibraryIndex).filter((entry) =>
    documentIds.has(entry.documentId),
  )
  const categories = { important: 0, research: 0, reference: 0, question: 0 }
  let notes = 0
  for (const entry of entries) {
    categories[entry.category] += 1
    if (entry.note) notes += 1
  }
  const indexedStats = await globalSearchIndex.getWorkspaceStats(workspace.documentIds, workspace.id)
  const savedSearches = await globalSearchIndex.getWorkspaceSavedSearches(workspace.id)
  return {
    ...workspaceSummary(workspace, store),
    documents: workspace.documentIds.map((documentId) => {
      const record = store.documentRegistry[documentId]
      return record ? {
        documentId,
        name: record.name,
        filePath: record.path,
        fileSize: Number(record.fileSize) || 0,
        modifiedAt: Number(record.modifiedAt) || 0,
        missing: record.missing === true,
      } : { documentId, name: 'Missing PDF', filePath: '', fileSize: 0, modifiedAt: 0, missing: true }
    }),
    references: workspace.referenceIds.slice(0, 250).flatMap((referenceId) => {
      const reference = store.referenceLibrary.items[referenceId]
      return reference && !reference.mergedInto && isExportableReference(reference) ? [referenceView(store, reference)] : []
    }),
    highlights: entries.slice(0, 250),
    notes: entries.filter((entry) => entry.note).slice(0, 250),
    savedSearches,
    activities: workspace.activities,
    dashboardLayout: workspace.dashboardLayout,
    workspaceSettings: workspace.workspaceSettings,
    stats: {
      documents: workspace.documentIds.length,
      references: workspace.referenceIds.filter((id) => {
        const reference = store.referenceLibrary.items[id]
        return reference && !reference.mergedInto && isExportableReference(reference)
      }).length,
      highlights: entries.length,
      notes,
      bookmarks: indexedStats.bookmarks,
      savedSearches: indexedStats.savedSearches,
      categories,
    },
  }
}

function readStoredZipEntry(buffer, requestedName) {
  let offset = 0
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8)
    const compressedSize = buffer.readUInt32LE(offset + 18)
    const nameLength = buffer.readUInt16LE(offset + 26)
    const extraLength = buffer.readUInt16LE(offset + 28)
    const nameStart = offset + 30
    const contentStart = nameStart + nameLength + extraLength
    const name = buffer.subarray(nameStart, nameStart + nameLength).toString('utf8')
    if (name === requestedName) {
      if (method !== 0) throw new Error('Compressed workspace packages are not supported.')
      return buffer.subarray(contentStart, contentStart + compressedSize).toString('utf8')
    }
    offset = contentStart + compressedSize
  }
  throw new Error(`Workspace package is missing ${requestedName}.`)
}

function buildWorkspacePackage(store, workspace, savedSearches) {
  const documentIds = new Set(workspace.documentIds)
  const documents = workspace.documentIds.flatMap((documentId) => {
    const record = store.documentRegistry[documentId]
    return record ? [{
      documentId,
      name: record.name,
      filePath: record.path,
      fileSize: record.fileSize,
      modifiedAt: record.modifiedAt,
    }] : []
  })
  const highlightDocuments = Object.values(store.highlightDocuments).filter((document) =>
    documentIds.has(getDocumentId(document.filePath)),
  )
  return {
    format: 'next-pdf-viewer-workspace',
    version: 1,
    exportedAt: new Date().toISOString(),
    workspace: {
      name: workspace.name,
      description: workspace.description,
      color: workspace.color,
      icon: workspace.icon,
      template: workspace.template,
      dashboardLayout: workspace.dashboardLayout,
      workspaceSettings: workspace.workspaceSettings,
    },
    documents,
    highlightDocuments,
    references: workspace.referenceIds.flatMap((id) => {
      const reference = store.referenceLibrary.items[id]
      return reference && isExportableReference(reference) ? [reference] : []
    }),
    referenceCollections: store.referenceLibrary.collections.filter((collection) =>
      workspace.referenceIds.some((id) => store.referenceLibrary.items[id]?.collectionIds.includes(collection.id)),
    ),
    savedSearches,
  }
}

function getHighlightDocumentKey(filePath, fileSize, modifiedAt) {
  const normalizedPath = process.platform === 'win32' ? filePath.toLowerCase() : filePath
  return createHash('sha256')
    .update(`${normalizedPath}\0${fileSize}\0${modifiedAt}`)
    .digest('hex')
}

function sanitizeHighlight(highlight) {
  if (!highlight || typeof highlight !== 'object') {
    return null
  }

  const id = typeof highlight.id === 'string' ? highlight.id.slice(0, 128) : ''
  const text = typeof highlight.text === 'string' ? highlight.text.trim().slice(0, 10000) : ''
  const note = typeof highlight.note === 'string' ? highlight.note.trimEnd().slice(0, 50000) : ''
  const color = ['yellow', 'green', 'blue', 'purple'].includes(highlight.color)
    ? highlight.color
    : null
  const category = ['important', 'research', 'reference', 'question'].includes(
    highlight.category,
  )
    ? highlight.category
    : color === 'purple'
      ? 'question'
      : color === 'green'
      ? 'research'
      : color === 'blue'
        ? 'reference'
        : 'important'
  const pageNumber = Math.max(1, Math.trunc(Number(highlight.pageNumber) || 0))
  const rotation = ((Math.round((Number(highlight.rotation) || 0) / 90) * 90) % 360 + 360) % 360
  const createdDate = new Date(highlight.createdDate)
  const requestedModifiedDate = new Date(highlight.modifiedDate ?? highlight.createdDate)
  const modifiedDate = Number.isNaN(requestedModifiedDate.getTime())
    ? createdDate
    : requestedModifiedDate
  const rectangles = Array.isArray(highlight.rectangles)
    ? highlight.rectangles.slice(0, 200).flatMap((rectangle) => {
        const x = Number(rectangle?.x)
        const y = Number(rectangle?.y)
        const width = Number(rectangle?.width)
        const height = Number(rectangle?.height)
        if (
          ![x, y, width, height].every(Number.isFinite) ||
          width <= 0 ||
          height <= 0
        ) {
          return []
        }

        const safeX = Math.min(1, Math.max(0, x))
        const safeY = Math.min(1, Math.max(0, y))
        const safeWidth = Math.min(1 - safeX, Math.max(0, width))
        const safeHeight = Math.min(1 - safeY, Math.max(0, height))
        if (safeWidth <= 0 || safeHeight <= 0) {
          return []
        }
        return [{
          x: safeX,
          y: safeY,
          width: safeWidth,
          height: safeHeight,
        }]
      })
    : []

  if (!id || !text || !color || rectangles.length === 0 || Number.isNaN(createdDate.getTime())) {
    return null
  }

  return {
    id,
    pageNumber,
    text,
    note,
    color,
    category,
    rectangles,
    rotation,
    createdDate: createdDate.toISOString(),
    modifiedDate: modifiedDate.toISOString(),
  }
}

function createHighlightLibraryEntry(documentKey, document, highlight) {
  const filePath = String(document.filePath ?? '')
  const documentId = getDocumentId(filePath)
  return {
    key: `${documentKey}:${highlight.id}`,
    documentKey,
    documentId,
    documentName: path.basename(filePath),
    filePath,
    fileSize: Number(document.fileSize) || 0,
    fileModifiedAt: Number(document.modifiedAt) || 0,
    highlightId: highlight.id,
    pageNumber: highlight.pageNumber,
    text: highlight.text,
    note: highlight.note,
    color: highlight.color,
    category: highlight.category,
    createdDate: highlight.createdDate,
    modifiedDate: highlight.modifiedDate,
    searchText: `${highlight.text}\n${highlight.note}\n${path.basename(filePath)}\n${categorySearchLabel(highlight.category)}`.toLocaleLowerCase(),
  }
}

function categorySearchLabel(category) {
  return category === 'important'
    ? 'Important'
    : category === 'research'
      ? 'Research'
      : category === 'reference'
        ? 'Reference'
        : 'Question'
}

function rebuildHighlightLibraryIndex(store) {
  const index = {}
  for (const [documentKey, document] of Object.entries(store.highlightDocuments ?? {})) {
    if (!document || typeof document !== 'object' || !Array.isArray(document.highlights)) {
      continue
    }
    for (const candidate of document.highlights) {
      const highlight = sanitizeHighlight(candidate)
      if (!highlight) continue
      const entry = createHighlightLibraryEntry(documentKey, document, highlight)
      index[entry.key] = entry
    }
  }
  store.highlightLibraryIndex = index
  store.highlightLibraryVersion = 2
  return index
}

function updateHighlightDocumentIndex(store, documentKey, previousHighlights, document) {
  const index = store.highlightLibraryIndex ?? (store.highlightLibraryIndex = {})
  for (const candidate of previousHighlights ?? []) {
    if (candidate?.id) delete index[`${documentKey}:${candidate.id}`]
  }
  for (const candidate of document.highlights ?? []) {
    const highlight = sanitizeHighlight(candidate)
    if (!highlight) continue
    const entry = createHighlightLibraryEntry(documentKey, document, highlight)
    index[entry.key] = entry
  }
  store.highlightLibraryVersion = 2
}

function removeHighlightDocument(store, documentKey) {
  const document = store.highlightDocuments[documentKey]
  if (!document) return false
  for (const candidate of document.highlights ?? []) {
    if (candidate?.id) delete store.highlightLibraryIndex[`${documentKey}:${candidate.id}`]
  }
  delete store.highlightDocuments[documentKey]
  return true
}

function getHighlightLibrary(store) {
  const index = store.highlightLibraryVersion === 2
    ? store.highlightLibraryIndex
    : rebuildHighlightLibraryIndex(store)
  const entries = Object.values(index).sort(
    (left, right) => Date.parse(right.modifiedDate) - Date.parse(left.modifiedDate),
  )
  const documentIds = new Set(entries.map((entry) => entry.documentId))
  const categories = { important: 0, research: 0, reference: 0, question: 0 }
  for (const entry of entries) categories[entry.category] += 1
  return {
    entries,
    stats: {
      totalDocuments: documentIds.size,
      totalHighlights: entries.length,
      categories,
    },
  }
}

async function pruneMissingHighlightDocuments(store) {
  const documents = Object.entries(store.highlightDocuments ?? {})
  const missingKeys = []
  const batchSize = 16
  for (let index = 0; index < documents.length; index += batchSize) {
    const batch = documents.slice(index, index + batchSize)
    const results = await Promise.all(batch.map(async ([documentKey, document]) => {
      try {
        await fs.access(document.filePath)
        return null
      } catch (error) {
        return error.code === 'ENOENT' ? documentKey : null
      }
    }))
    missingKeys.push(...results.filter(Boolean))
  }

  for (const documentKey of missingKeys) {
    const document = store.highlightDocuments[documentKey]
    const documentId = document?.filePath ? getDocumentId(document.filePath) : null
    if (documentId) {
      store.recentFiles = store.recentFiles.filter((item) => item.id !== documentId)
      const record = store.documentRegistry[documentId]
      store.documentRegistry[documentId] = {
        ...(record ?? {}),
        id: documentId,
        name: record?.name ?? path.basename(document.filePath),
        path: document.filePath,
        fileSize: Number(record?.fileSize ?? document.fileSize) || 0,
        modifiedAt: Number(record?.modifiedAt ?? document.modifiedAt) || 0,
        openedAt: Number(record?.openedAt) || 0,
        missing: true,
      }
      await globalSearchIndex.removeDocument(documentId)
    }
  }
  return missingKeys.length
}

async function pruneMissingRegisteredDocuments(store) {
  const records = Object.values(store.documentRegistry ?? {})
  const missingIds = []
  for (let start = 0; start < records.length; start += 16) {
    const batch = records.slice(start, start + 16)
    const results = await Promise.all(batch.map(async (record) => {
      try {
        await fs.access(record.path)
        return null
      } catch (error) {
        return error.code === 'ENOENT' ? record.id : null
      }
    }))
    missingIds.push(...results.filter(Boolean))
  }
  if (!missingIds.length) return 0

  const missing = new Set(missingIds)
  store.recentFiles = store.recentFiles.filter((item) => !missing.has(item.id))
  for (const id of missing) {
    const record = store.documentRegistry[id]
    if (record) record.missing = true
    await globalSearchIndex.removeDocument(id)
  }
  return missing.size
}

function normalizeFilePath(filePath) {
  const value = String(filePath ?? '')
  return process.platform === 'win32' ? value.toLocaleLowerCase() : value
}

function getStoredHighlights(store, filePath, fileSize, modifiedAt) {
  const key = getHighlightDocumentKey(filePath, fileSize, modifiedAt)
  const document = store.highlightDocuments[key]
  if (!document || !Array.isArray(document.highlights)) {
    return []
  }

  return document.highlights.map(sanitizeHighlight).filter(Boolean)
}

function sanitizeWindowState(state) {
  if (!state || typeof state !== 'object') {
    return null
  }

  const width = Number(state.width)
  const height = Number(state.height)
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    return null
  }

  return {
    x: Number.isFinite(Number(state.x)) ? Math.round(Number(state.x)) : null,
    y: Number.isFinite(Number(state.y)) ? Math.round(Number(state.y)) : null,
    width: Math.max(900, Math.round(width)),
    height: Math.max(650, Math.round(height)),
    maximized: state.maximized === true,
  }
}

const exportCategoryOrder = ['important', 'research', 'reference', 'question']
const exportCategoryLabels = {
  important: 'Important',
  research: 'Research',
  reference: 'Reference',
  question: 'Question',
}
const exportColorLabels = {
  yellow: 'Amber',
  green: 'Mint',
  blue: 'Sky Blue',
  purple: 'Purple',
}

function groupHighlightsForExport(highlights) {
  return exportCategoryOrder.flatMap((category) => {
    const categoryHighlights = highlights.filter((highlight) => highlight.category === category)
    if (categoryHighlights.length === 0) {
      return []
    }

    const pages = new Map()
    for (const highlight of categoryHighlights.sort((left, right) => left.pageNumber - right.pageNumber)) {
      const pageHighlights = pages.get(highlight.pageNumber) ?? []
      pageHighlights.push(highlight)
      pages.set(highlight.pageNumber, pageHighlights)
    }
    return [{ category, pages: [...pages.entries()] }]
  })
}

function buildHighlightsMarkdown(documentName, highlights, exportedAt) {
  const lines = [
    `# Highlights - ${documentName}`,
    '',
    `Exported: ${exportedAt.toLocaleString()}`,
    '',
  ]
  for (const group of groupHighlightsForExport(highlights)) {
    lines.push(`# ${exportCategoryLabels[group.category]}`, '')
    for (const [pageNumber, pageHighlights] of group.pages) {
      lines.push(`## Page ${pageNumber}`, '')
      for (const highlight of pageHighlights) {
        lines.push(
          `**Category:** ${exportCategoryLabels[highlight.category]}`,
          `**Color:** ${exportColorLabels[highlight.color]}`,
          '',
          '**Highlighted Text**',
          '',
          highlight.text,
          '',
          '**Note**',
          '',
          highlight.note || '_No note_',
          '',
          '---',
          '',
        )
      }
    }
  }
  return lines.join('\n')
}

function buildHighlightsText(documentName, highlights, exportedAt) {
  const lines = [
    `HIGHLIGHTS - ${documentName}`,
    `Exported: ${exportedAt.toLocaleString()}`,
    '='.repeat(72),
    '',
  ]
  for (const group of groupHighlightsForExport(highlights)) {
    lines.push(exportCategoryLabels[group.category].toUpperCase(), '')
    for (const [pageNumber, pageHighlights] of group.pages) {
      lines.push(`Page ${pageNumber}`, '-'.repeat(24))
      for (const highlight of pageHighlights) {
        lines.push(
          `Category: ${exportCategoryLabels[highlight.category]}`,
          `Color: ${exportColorLabels[highlight.color]}`,
          'Highlighted Text:',
          highlight.text,
          'Note:',
          highlight.note || 'No note',
          '',
        )
      }
    }
  }
  return lines.join('\n')
}

function buildHighlightsDocx(documentName, highlights, exportedAt) {
  const paragraphs = [
    wordParagraph(`Highlights - ${documentName}`, 'Title'),
    wordParagraph(`Exported: ${exportedAt.toLocaleString()}`),
  ]
  for (const group of groupHighlightsForExport(highlights)) {
    paragraphs.push(wordParagraph(exportCategoryLabels[group.category], 'Heading1'))
    for (const [pageNumber, pageHighlights] of group.pages) {
      paragraphs.push(wordParagraph(`Page ${pageNumber}`, 'Heading2'))
      for (const highlight of pageHighlights) {
        paragraphs.push(
          wordParagraph(`Category: ${exportCategoryLabels[highlight.category]}`),
          wordParagraph(`Color: ${exportColorLabels[highlight.color]}`),
          wordParagraph('Highlighted Text', 'Heading3'),
          ...highlight.text.split(/\r?\n/).map((line) => wordParagraph(line)),
          wordParagraph('Note', 'Heading3'),
          ...(highlight.note || 'No note').split(/\r?\n/).map((line) => wordParagraph(line)),
        )
      }
    }
  }

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.join('')}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`
  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:sz w:val="22"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="30"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="22"/></w:rPr></w:style></w:styles>`
  return createStoredZip([
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`],
    ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`],
    ['word/document.xml', documentXml],
    ['word/styles.xml', stylesXml],
    ['word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
  ])
}

function groupLibraryEntries(entries) {
  const documents = new Map()
  for (const entry of entries) {
    const document = documents.get(entry.documentKey) ?? {
      documentKey: entry.documentKey,
      documentName: entry.documentName,
      filePath: entry.filePath,
      entries: [],
    }
    document.entries.push(entry)
    documents.set(entry.documentKey, document)
  }
  return [...documents.values()].sort((left, right) =>
    left.documentName.localeCompare(right.documentName) || left.filePath.localeCompare(right.filePath),
  )
}

function buildLibraryMarkdown(entries, exportedAt) {
  const lines = [
    '# Global Highlights',
    '',
    `Exported: ${exportedAt.toLocaleString()}`,
    `Highlights: ${entries.length}`,
    '',
  ]
  for (const document of groupLibraryEntries(entries)) {
    lines.push(`# ${document.documentName}`, '', `Source: ${document.filePath}`, '')
    for (const entry of document.entries) {
      lines.push(
        `## Page ${entry.pageNumber} - ${exportCategoryLabels[entry.category]}`,
        `**Color:** ${exportColorLabels[entry.color]}`,
        '',
        entry.text,
        '',
        '**Note**',
        '',
        entry.note || '_No note_',
        '',
        `Created: ${new Date(entry.createdDate).toLocaleString()}`,
        `Modified: ${new Date(entry.modifiedDate).toLocaleString()}`,
        '',
        '---',
        '',
      )
    }
  }
  return lines.join('\n')
}

function buildLibraryText(entries, exportedAt) {
  const lines = [
    'GLOBAL HIGHLIGHTS',
    `Exported: ${exportedAt.toLocaleString()}`,
    `Highlights: ${entries.length}`,
    '='.repeat(72),
    '',
  ]
  for (const document of groupLibraryEntries(entries)) {
    lines.push(document.documentName.toUpperCase(), `Source: ${document.filePath}`, '')
    for (const entry of document.entries) {
      lines.push(
        `Page ${entry.pageNumber} | ${exportCategoryLabels[entry.category]}`,
        `Color: ${exportColorLabels[entry.color]}`,
        entry.text,
        `Note: ${entry.note || 'No note'}`,
        `Created: ${new Date(entry.createdDate).toLocaleString()}`,
        `Modified: ${new Date(entry.modifiedDate).toLocaleString()}`,
        '',
      )
    }
  }
  return lines.join('\n')
}

function buildLibraryDocx(entries, exportedAt) {
  const paragraphs = [
    wordParagraph('Global Highlights', 'Title'),
    wordParagraph(`Exported: ${exportedAt.toLocaleString()}`),
    wordParagraph(`Highlights: ${entries.length}`),
  ]
  for (const document of groupLibraryEntries(entries)) {
    paragraphs.push(
      wordParagraph(document.documentName, 'Heading1'),
      wordParagraph(`Source: ${document.filePath}`),
    )
    for (const entry of document.entries) {
      paragraphs.push(
        wordParagraph(`Page ${entry.pageNumber} - ${exportCategoryLabels[entry.category]}`, 'Heading2'),
        wordParagraph(`Color: ${exportColorLabels[entry.color]}`),
        wordParagraph('Highlighted Text', 'Heading3'),
        ...entry.text.split(/\r?\n/).map((line) => wordParagraph(line)),
        wordParagraph('Note', 'Heading3'),
        ...(entry.note || 'No note').split(/\r?\n/).map((line) => wordParagraph(line)),
        wordParagraph(`Created: ${new Date(entry.createdDate).toLocaleString()}`),
        wordParagraph(`Modified: ${new Date(entry.modifiedDate).toLocaleString()}`),
      )
    }
  }
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.join('')}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`
  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:sz w:val="22"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="30"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="22"/></w:rPr></w:style></w:styles>`
  return createStoredZip([
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`],
    ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`],
    ['word/document.xml', documentXml],
    ['word/styles.xml', stylesXml],
    ['word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
  ])
}

function wordParagraph(text, style = null) {
  const styleXml = style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''
  return `<w:p>${styleXml}<w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function createStoredZip(files) {
  const localParts = []
  const centralParts = []
  let offset = 0
  for (const [name, content] of files) {
    const nameBuffer = Buffer.from(name)
    const contentBuffer = Buffer.from(content)
    const crc = crc32(contentBuffer)
    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x04034b50, 0)
    localHeader.writeUInt16LE(20, 4)
    localHeader.writeUInt16LE(0x0800, 6)
    localHeader.writeUInt16LE(0, 8)
    localHeader.writeUInt32LE(crc, 14)
    localHeader.writeUInt32LE(contentBuffer.length, 18)
    localHeader.writeUInt32LE(contentBuffer.length, 22)
    localHeader.writeUInt16LE(nameBuffer.length, 26)
    localParts.push(localHeader, nameBuffer, contentBuffer)

    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x02014b50, 0)
    centralHeader.writeUInt16LE(20, 4)
    centralHeader.writeUInt16LE(20, 6)
    centralHeader.writeUInt16LE(0x0800, 8)
    centralHeader.writeUInt16LE(0, 10)
    centralHeader.writeUInt32LE(crc, 16)
    centralHeader.writeUInt32LE(contentBuffer.length, 20)
    centralHeader.writeUInt32LE(contentBuffer.length, 24)
    centralHeader.writeUInt16LE(nameBuffer.length, 28)
    centralHeader.writeUInt32LE(offset, 42)
    centralParts.push(centralHeader, nameBuffer)
    offset += localHeader.length + nameBuffer.length + contentBuffer.length
  }

  const centralDirectory = Buffer.concat(centralParts)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(centralDirectory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...localParts, centralDirectory, end])
}

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

async function loadPdf(filePath) {
  const started = performance.now()
  const [buffer, fileStats] = await Promise.all([fs.readFile(filePath), fs.stat(filePath)])
  console.info(
    `PDF file read time: ${Math.round(performance.now() - started)}ms (${Math.round(buffer.byteLength / 1024 / 1024)}MB)`,
  )
  const id = getDocumentId(filePath)
  const name = path.basename(filePath)
  const modifiedAt = fileStats.mtimeMs

  return withStore(async (store) => {
    const documentRecord = {
      id,
      name,
      path: filePath,
      fileSize: buffer.byteLength,
      modifiedAt,
      openedAt: Date.now(),
      missing: false,
    }
    store.documentRegistry[id] = documentRecord
    ensureReferenceForDocument(store, documentRecord)
    store.recentFiles = [
      documentRecord,
      ...store.recentFiles.filter((item) => item.id !== id),
    ].slice(0, 20)
    await saveStore(store)
    await globalSearchIndex.upsertFile(documentRecord)

    return {
      id,
      name,
      filePath,
      fileSize: buffer.byteLength,
      modifiedAt,
      dataUrl: `data:application/pdf;base64,${buffer.toString('base64')}`,
      readingState: sanitizeReadingState(store.documentStates[id]),
      highlights: getStoredHighlights(store, filePath, buffer.byteLength, modifiedAt),
      signaturePlacements: getStoredSignaturePlacements(store, filePath, buffer.byteLength, modifiedAt),
      fillSignFields: getStoredFillSignFields(store, filePath, buffer.byteLength, modifiedAt),
    }
  })
}

async function inspectMergePdf(filePath) {
  if (typeof filePath !== 'string' || path.extname(filePath).toLowerCase() !== '.pdf') {
    throw new Error('Only PDF files can be added to Merge PDFs.')
  }
  const [buffer, fileStats] = await Promise.all([fs.readFile(filePath), fs.stat(filePath)])
  if (!fileStats.isFile()) throw new Error('Selected item is not a PDF file.')
  try {
    const document = await PDFDocument.load(buffer, { ignoreEncryption: false })
    return {
      id: getDocumentId(filePath),
      name: path.basename(filePath),
      filePath,
      fileSize: fileStats.size,
      modifiedAt: fileStats.mtimeMs,
      pageCount: document.getPageCount(),
    }
  } catch (error) {
    throw new Error(`Could not read ${path.basename(filePath)}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function inspectMergePdfs(filePaths) {
  const uniquePaths = [...new Set((Array.isArray(filePaths) ? filePaths : []).map((filePath) => String(filePath ?? '')))]
  const pdfPaths = uniquePaths.filter((filePath) => path.extname(filePath).toLowerCase() === '.pdf')
  if (pdfPaths.length !== uniquePaths.length) {
    throw new Error('Only PDF files can be added to Merge PDFs.')
  }
  const items = []
  for (const filePath of pdfPaths) {
    items.push(await inspectMergePdf(filePath))
  }
  return items
}

async function mergePdfFiles({ files, outputName, openAfterMerge }) {
  const filePaths = [...new Set((Array.isArray(files) ? files : []).map((file) => String(file?.filePath ?? file ?? '')))]
  if (filePaths.length < 2) throw new Error('Select at least two PDF files to merge.')
  if (filePaths.some((filePath) => path.extname(filePath).toLowerCase() !== '.pdf')) {
    throw new Error('Only PDF files can be merged.')
  }
  const defaultName = sanitizePdfOutputName(outputName || `Merged-${new Date().toISOString().slice(0, 10)}.pdf`)
  const result = await dialog.showSaveDialog(mainWindow ?? undefined, {
    title: 'Save Merged PDF',
    defaultPath: defaultName,
    filters: [{ name: 'PDF Document', extensions: ['pdf'] }],
  })
  if (result.canceled || !result.filePath) return null

  const outputPath = result.filePath.toLowerCase().endsWith('.pdf') ? result.filePath : `${result.filePath}.pdf`
  const merged = await PDFDocument.create()
  let totalPages = 0
  for (const filePath of filePaths) {
    let source
    try {
      source = await PDFDocument.load(await fs.readFile(filePath), { ignoreEncryption: false })
    } catch (error) {
      throw new Error(`Could not merge ${path.basename(filePath)}: ${error instanceof Error ? error.message : String(error)}`)
    }
    const pageIndexes = source.getPageIndices()
    const copiedPages = await merged.copyPages(source, pageIndexes)
    for (const page of copiedPages) merged.addPage(page)
    totalPages += copiedPages.length
  }
  merged.setTitle(path.basename(outputPath, '.pdf'))
  merged.setProducer('Next PDF Viewer')
  merged.setCreator('Next PDF Viewer')
  merged.setModificationDate(new Date())
  const bytes = await merged.save({ addDefaultPage: false })
  await fs.writeFile(outputPath, bytes)
  const openedPdf = await loadPdf(outputPath)
  return {
    outputPath,
    name: path.basename(outputPath),
    fileSize: bytes.length,
    pageCount: totalPages,
    openedPdf: openAfterMerge === false ? null : openedPdf,
  }
}

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp'])
const PAGE_SIZES = {
  a4: [595.28, 841.89],
  letter: [612, 792],
}
const MARGINS = {
  none: 0,
  small: 24,
  medium: 48,
  large: 72,
}

async function inspectImageFile(filePath) {
  if (typeof filePath !== 'string' || !IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
    throw new Error('Only JPG, JPEG, PNG, and WEBP images can be added.')
  }
  const fileStats = await fs.stat(filePath)
  if (!fileStats.isFile()) throw new Error('Selected item is not an image file.')
  const image = nativeImage.createFromPath(filePath)
  if (image.isEmpty()) throw new Error(`Could not read image: ${path.basename(filePath)}`)
  const size = image.getSize()
  const thumbnail = image.resize({ width: 160, height: 160, quality: 'good' })
  return {
    id: createHash('sha256').update(path.resolve(filePath).toLowerCase()).digest('hex'),
    name: path.basename(filePath),
    filePath,
    fileSize: fileStats.size,
    modifiedAt: fileStats.mtimeMs,
    width: size.width,
    height: size.height,
    thumbnailDataUrl: thumbnail.toDataURL(),
  }
}

async function inspectImageFiles(filePaths) {
  const uniquePaths = [...new Set((Array.isArray(filePaths) ? filePaths : []).map((filePath) => String(filePath ?? '')))]
  const imagePaths = uniquePaths.filter((filePath) => IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase()))
  if (imagePaths.length !== uniquePaths.length) throw new Error('Only JPG, JPEG, PNG, and WEBP images can be added.')
  const items = []
  for (const filePath of imagePaths) items.push(await inspectImageFile(filePath))
  return items
}

async function imagesToPdf({ images, outputName, openAfterExport, pageSize, orientation, imageFit, margin, customWidth, customHeight }) {
  const filePaths = [...new Set((Array.isArray(images) ? images : []).map((image) => String(image?.filePath ?? image ?? '')))]
  if (!filePaths.length) throw new Error('Add at least one image before exporting.')
  if (filePaths.some((filePath) => !IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase()))) {
    throw new Error('Only JPG, JPEG, PNG, and WEBP images can be converted.')
  }
  const defaultName = sanitizePdfOutputName(outputName || `Images-${new Date().toISOString().slice(0, 10)}.pdf`)
  const result = await dialog.showSaveDialog(mainWindow ?? undefined, {
    title: 'Save Images as PDF',
    defaultPath: defaultName,
    filters: [{ name: 'PDF Document', extensions: ['pdf'] }],
  })
  if (result.canceled || !result.filePath) return null

  const outputPath = result.filePath.toLowerCase().endsWith('.pdf') ? result.filePath : `${result.filePath}.pdf`
  const pdf = await PDFDocument.create()
  const marginSize = MARGINS[margin] ?? MARGINS.medium
  for (const filePath of filePaths) {
    const image = nativeImage.createFromPath(filePath)
    if (image.isEmpty()) throw new Error(`Could not read image: ${path.basename(filePath)}`)
    const imageSize = image.getSize()
    const embedded = await embedImage(pdf, filePath, image)
    const [pageWidth, pageHeight] = resolveImagePageSize({
      pageSize,
      orientation,
      customWidth,
      customHeight,
      imageWidth: imageSize.width,
      imageHeight: imageSize.height,
      margin: marginSize,
    })
    const page = pdf.addPage([pageWidth, pageHeight])
    const availableWidth = Math.max(1, pageWidth - marginSize * 2)
    const availableHeight = Math.max(1, pageHeight - marginSize * 2)
    const { width, height } = resolveImageDrawSize({
      imageWidth: embedded.width,
      imageHeight: embedded.height,
      availableWidth,
      availableHeight,
      fit: imageFit,
    })
    page.drawImage(embedded, {
      x: (pageWidth - width) / 2,
      y: (pageHeight - height) / 2,
      width,
      height,
    })
  }
  pdf.setTitle(path.basename(outputPath, '.pdf'))
  pdf.setProducer('Next PDF Viewer')
  pdf.setCreator('Next PDF Viewer')
  pdf.setModificationDate(new Date())
  const bytes = await pdf.save({ addDefaultPage: false })
  await fs.writeFile(outputPath, bytes)
  const openedPdf = await loadPdf(outputPath)
  return {
    outputPath,
    name: path.basename(outputPath),
    fileSize: bytes.length,
    pageCount: filePaths.length,
    openedPdf: openAfterExport === false ? null : openedPdf,
  }
}

async function saveSignedPdf(options) {
  const identity = options?.identity ?? {}
  const placements = Array.isArray(options?.placements) ? options.placements : []
  const fields = Array.isArray(options?.fillSignFields) ? options.fillSignFields : []
  if (placements.length === 0 && fields.length === 0) {
    throw new Error('No signatures or Fill & Sign fields have been added.')
  }

  const sourceRecord = await withStore((store) => {
    const record = store.documentRegistry[identity.id] ?? store.recentFiles.find((item) => item.id === identity.id)
    if (!record) return null
    if (
      record.fileSize !== Number(identity.fileSize) ||
      record.modifiedAt !== Number(identity.modifiedAt)
    ) {
      throw new Error('The PDF identity changed. Reopen the document before saving a signed copy.')
    }
    return { ...record }
  })
  if (!sourceRecord) throw new Error('The original PDF is no longer available.')

  let sourceBytes
  let sourceStats
  try {
    ;[sourceBytes, sourceStats] = await Promise.all([
      fs.readFile(sourceRecord.path),
      fs.stat(sourceRecord.path),
    ])
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`Original PDF not found: ${sourceRecord.name}`)
    }
    throw error
  }
  if (sourceStats.size !== sourceRecord.fileSize || sourceStats.mtimeMs !== sourceRecord.modifiedAt) {
    throw new Error('The original PDF changed on disk. Reopen it before saving a signed copy.')
  }

  const sanitizedPlacements = placements
    .map((placement) => sanitizeSignaturePlacement(placement, sourceRecord.id))
    .filter(Boolean)
  const sanitizedFields = fields
    .map((field) => sanitizeFillSignField(field, sourceRecord.id))
    .filter(Boolean)
  if (sanitizedPlacements.length === 0 && sanitizedFields.length === 0) {
    throw new Error('No valid signatures or Fill & Sign fields are available to save.')
  }

  const signaturesById = await withStore((store) => {
    store.signatureLibrary = sanitizeSignatureLibrary(store.signatureLibrary)
    return Object.fromEntries(store.signatureLibrary.items.map((signature) => [signature.id, signature]))
  })

  let pdf
  try {
    pdf = await PDFDocument.load(sourceBytes, { ignoreEncryption: false })
  } catch (error) {
    throw new Error(`Could not load original PDF: ${error instanceof Error ? error.message : String(error)}`)
  }

  const embeddedSignatures = new Map()
  for (const placement of sanitizedPlacements) {
    const page = pdf.getPage(placement.pageNumber - 1)
    if (!page) continue
    const signature = signaturesById[placement.signatureId]
    if (!signature) throw new Error('A placed signature no longer exists in Signature Manager.')
    let embedded = embeddedSignatures.get(signature.id)
    if (!embedded) {
      embedded = await embedSignatureImage(pdf, signature)
      embeddedSignatures.set(signature.id, embedded)
    }

    const pdfPageRotation = normalizeDegrees(typeof page.getRotation === 'function' ? page.getRotation().angle : 0)
    const viewerPageRotation = normalizeDegrees(placement.pageRotation)
    if (pdfPageRotation !== 0 || viewerPageRotation !== 0) {
      throw new Error('Please reset page rotation before signing.')
    }

    const { x, y, width, height } = visualPlacementToPdfBox(page, placement, embedded)
    page.drawImage(embedded, {
      x,
      y,
      width,
      height,
      rotate: degrees(Number(placement.rotation) || 0),
      opacity: placement.opacity,
    })
  }

  const textFont = await pdf.embedFont(StandardFonts.Helvetica)
  for (const field of sanitizedFields) {
    const page = pdf.getPage(field.pageNumber - 1)
    if (!page) continue
    const pdfPageRotation = normalizeDegrees(typeof page.getRotation === 'function' ? page.getRotation().angle : 0)
    const viewerPageRotation = normalizeDegrees(field.pageRotation)
    if (pdfPageRotation !== 0 || viewerPageRotation !== 0) {
      throw new Error('Please reset page rotation before signing.')
    }
    drawFillSignField(page, field, textFont)
  }

  const baseName = path.basename(sourceRecord.name, path.extname(sourceRecord.name))
  const defaultName = sanitizePdfOutputName(`${baseName}-signed.pdf`)
  const result = await dialog.showSaveDialog(mainWindow ?? undefined, {
    title: 'Save Signed Copy',
    defaultPath: defaultName,
    filters: [{ name: 'PDF Document', extensions: ['pdf'] }],
  })
  if (result.canceled || !result.filePath) return null

  const outputPath = result.filePath.toLowerCase().endsWith('.pdf') ? result.filePath : `${result.filePath}.pdf`
  if (path.resolve(outputPath).toLowerCase() === path.resolve(sourceRecord.path).toLowerCase()) {
    throw new Error('Choose a different filename. Next PDF Viewer will not overwrite the original PDF.')
  }
  const signedBytes = await pdf.save({ addDefaultPage: false })
  await fs.writeFile(outputPath, signedBytes)
  const openedPdf = await loadPdf(outputPath)

  const choice = await dialog.showMessageBox(mainWindow ?? undefined, {
    type: 'info',
    title: 'Signed PDF Saved',
    message: 'Signed PDF copy saved successfully.',
    detail: outputPath,
    buttons: ['Open Signed PDF', 'Reveal in Folder', 'Close'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  })
  if (choice.response === 1) {
    shell.showItemInFolder(outputPath)
    return { outputPath, openedPdf: null }
  }
  if (choice.response === 0) {
    return { outputPath, openedPdf }
  }
  return { outputPath, openedPdf: null }
}

function drawFillSignField(page, field, font) {
  const box = visualFieldToPdfBox(page, field)
  const color = fillSignPdfColor(field.color)
  if (field.type === 'checkbox') {
    const size = Math.min(box.width, box.height)
    const x = box.x
    const y = box.y + (box.height - size) / 2
    page.drawRectangle({
      x,
      y,
      width: size,
      height: size,
      borderColor: color,
      borderWidth: Math.max(0.75, size * 0.06),
    })
    if (field.checked) {
      page.drawLine({
        start: { x: x + size * 0.2, y: y + size * 0.52 },
        end: { x: x + size * 0.42, y: y + size * 0.28 },
        thickness: Math.max(1.2, size * 0.08),
        color,
      })
      page.drawLine({
        start: { x: x + size * 0.42, y: y + size * 0.28 },
        end: { x: x + size * 0.82, y: y + size * 0.78 },
        thickness: Math.max(1.2, size * 0.08),
        color,
      })
    }
    return
  }

  const text = String(field.text ?? '').trim()
  if (!text) return
  const fontSize = Math.min(box.height * 0.9, Math.max(6, Number(field.fontSize) || 14))
  const lineHeight = fontSize * 1.18
  const lines = wrapFillText(text, font, fontSize, Math.max(1, box.width))
  let cursorY = box.y + box.height - fontSize
  for (const line of lines) {
    if (cursorY < box.y - fontSize * 0.2) break
    page.drawText(line, {
      x: box.x,
      y: cursorY,
      size: fontSize,
      font,
      color,
      maxWidth: box.width,
    })
    cursorY -= lineHeight
  }
}

function wrapFillText(text, font, fontSize, maxWidth) {
  return text.split(/\r?\n/).flatMap((paragraph) => {
    const words = paragraph.split(/\s+/).filter(Boolean)
    if (words.length === 0) return ['']
    const lines = []
    let current = ''
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word
      if (font.widthOfTextAtSize(candidate, fontSize) <= maxWidth || !current) {
        current = candidate
      } else {
        lines.push(current)
        current = word
      }
    }
    if (current) lines.push(current)
    return lines
  })
}

function visualFieldToPdfBox(page, field) {
  const { width: pageWidth, height: pageHeight } = page.getSize()
  const xRatio = Number(field.xRatio ?? field.x) || 0
  const yRatio = Number(field.yRatio ?? field.y) || 0
  const widthRatio = Number(field.widthRatio ?? field.width) || 0
  const heightRatio = Number(field.heightRatio ?? field.height) || 0
  return {
    x: xRatio * pageWidth,
    y: pageHeight - ((yRatio + heightRatio) * pageHeight),
    width: widthRatio * pageWidth,
    height: heightRatio * pageHeight,
  }
}

function fillSignPdfColor(color) {
  if (color === 'blue') return rgb(0.11, 0.3, 0.85)
  if (color === 'dark-gray') return rgb(0.22, 0.25, 0.32)
  return rgb(0.07, 0.09, 0.15)
}

async function embedSignatureImage(pdf, signature) {
  const dataUrl = String(signature.imageDataUrl ?? '')
  const base64 = dataUrl.replace(/^data:image\/png;base64,/, '')
  if (!base64 || base64 === dataUrl) throw new Error(`Signature "${signature.name}" is not a PNG image.`)
  return pdf.embedPng(Buffer.from(base64, 'base64'))
}

function visualPlacementToPdfBox(page, placement, image) {
  const { width: pageWidth, height: pageHeight } = page.getSize()
  const xRatio = Number(placement.xRatio ?? placement.x) || 0
  const yRatio = Number(placement.yRatio ?? placement.y) || 0
  const widthRatio = Number(placement.widthRatio ?? placement.width) || 0
  const heightRatio = Number(placement.heightRatio ?? placement.height) || 0
  const container = {
    x: xRatio * pageWidth,
    y: pageHeight - ((yRatio + heightRatio) * pageHeight),
    width: widthRatio * pageWidth,
    height: heightRatio * pageHeight,
  }
  const imageWidth = Math.max(1, Number(image?.width) || 1)
  const imageHeight = Math.max(1, Number(image?.height) || 1)
  const imageAspect = imageWidth / imageHeight
  const containerAspect = container.width / Math.max(container.height, 1)

  if (containerAspect > imageAspect) {
    const height = container.height
    const width = height * imageAspect
    return {
      x: container.x + (container.width - width) / 2,
      y: container.y,
      width,
      height,
    }
  }

  const width = container.width
  const height = width / imageAspect
  return {
    x: container.x,
    y: container.y + (container.height - height) / 2,
    width,
    height,
  }
}

function normalizeDegrees(value) {
  return ((Math.round((Number(value) || 0) / 90) * 90) % 360 + 360) % 360
}

async function embedImage(pdf, filePath, image) {
  const extension = path.extname(filePath).toLowerCase()
  try {
    if (extension === '.jpg' || extension === '.jpeg') return await pdf.embedJpg(await fs.readFile(filePath))
    if (extension === '.png') return await pdf.embedPng(await fs.readFile(filePath))
  } catch {
    // Fall through to Electron's decoder for malformed or uncommon encodings.
  }
  return pdf.embedPng(image.toPNG())
}

function resolveImagePageSize({ pageSize, orientation, customWidth, customHeight, imageWidth, imageHeight, margin }) {
  let width
  let height
  if (pageSize === 'fit-image') {
    width = Math.max(1, imageWidth + margin * 2)
    height = Math.max(1, imageHeight + margin * 2)
  } else if (pageSize === 'custom') {
    width = clampPageSize(customWidth, 72, 4320, PAGE_SIZES.a4[0])
    height = clampPageSize(customHeight, 72, 4320, PAGE_SIZES.a4[1])
  } else {
    ;[width, height] = PAGE_SIZES[pageSize] ?? PAGE_SIZES.a4
  }
  const resolvedOrientation = orientation === 'auto'
    ? imageWidth > imageHeight ? 'landscape' : 'portrait'
    : orientation === 'landscape' ? 'landscape' : 'portrait'
  if (resolvedOrientation === 'landscape' && height > width) return [height, width]
  if (resolvedOrientation === 'portrait' && width > height) return [height, width]
  return [width, height]
}

function resolveImageDrawSize({ imageWidth, imageHeight, availableWidth, availableHeight, fit }) {
  const contain = Math.min(availableWidth / imageWidth, availableHeight / imageHeight)
  const cover = Math.max(availableWidth / imageWidth, availableHeight / imageHeight)
  const scale = fit === 'fill-page'
    ? cover
    : fit === 'original-size' || fit === 'center'
      ? Math.min(1, contain)
      : contain
  return {
    width: imageWidth * scale,
    height: imageHeight * scale,
  }
}

function clampPageSize(value, min, max, fallback) {
  const next = Number(value)
  return Number.isFinite(next) ? Math.min(max, Math.max(min, next)) : fallback
}

async function pickSignatureImage() {
  const result = await dialog.showOpenDialog(mainWindow ?? undefined, {
    title: 'Upload Signature Image',
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
    properties: ['openFile'],
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return loadSignatureImage(result.filePaths[0])
}

function loadSignatureImage(filePath) {
  if (typeof filePath !== 'string' || !IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
    throw new Error('Only PNG, JPG, JPEG, and WEBP images can be used for signatures.')
  }
  let image = nativeImage.createFromPath(filePath)
  if (image.isEmpty()) throw new Error(`Could not read signature image: ${path.basename(filePath)}`)
  image = trimSignatureImage(image)
  const size = image.getSize()
  return {
    name: path.basename(filePath).replace(/\.(png|jpe?g|webp)$/i, ''),
    imageDataUrl: image.toDataURL(),
    width: size.width,
    height: size.height,
  }
}

function trimSignatureImage(image) {
  const size = image.getSize()
  const bitmap = image.toBitmap()
  if (!size.width || !size.height || bitmap.length < size.width * size.height * 4) return image
  let left = size.width
  let top = size.height
  let right = -1
  let bottom = -1
  for (let y = 0; y < size.height; y += 1) {
    for (let x = 0; x < size.width; x += 1) {
      const index = (y * size.width + x) * 4
      const blue = bitmap[index]
      const green = bitmap[index + 1]
      const red = bitmap[index + 2]
      const alpha = bitmap[index + 3]
      const visible = alpha > 12 && (red < 245 || green < 245 || blue < 245)
      if (!visible) continue
      left = Math.min(left, x)
      top = Math.min(top, y)
      right = Math.max(right, x)
      bottom = Math.max(bottom, y)
    }
  }
  if (right < left || bottom < top) return image
  const padding = 8
  left = Math.max(0, left - padding)
  top = Math.max(0, top - padding)
  right = Math.min(size.width - 1, right + padding)
  bottom = Math.min(size.height - 1, bottom + padding)
  if (left === 0 && top === 0 && right === size.width - 1 && bottom === size.height - 1) return image
  return image.crop({ x: left, y: top, width: right - left + 1, height: bottom - top + 1 })
}

function createSignatureRecord(payload) {
  const image = nativeImage.createFromDataURL(String(payload?.imageDataUrl ?? ''))
  if (image.isEmpty()) throw new Error('Signature image is invalid.')
  const size = image.getSize()
  const now = new Date().toISOString()
  return sanitizeSignature({
    id: randomUUID(),
    name: payload?.name,
    type: payload?.type,
    imageDataUrl: image.toDataURL(),
    width: size.width,
    height: size.height,
    createdAt: now,
    updatedAt: now,
    isDefault: false,
  })
}

function listSignatures(store) {
  store.signatureLibrary = sanitizeSignatureLibrary(store.signatureLibrary)
  return structuredClone(store.signatureLibrary.items)
}

function sanitizePdfOutputName(value) {
  const name = String(value ?? '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').trim() || 'Merged.pdf'
  return name.toLowerCase().endsWith('.pdf') ? name : `${name}.pdf`
}

async function printPdf(filePath) {
  await fs.access(filePath)

  const printWindow = new BrowserWindow({
    show: false,
    parent: mainWindow ?? undefined,
    backgroundColor: '#ffffff',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      plugins: true,
    },
  })
  printWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  try {
    await printWindow.loadURL(pathToFileURL(filePath).href)
    await new Promise((resolve) => setTimeout(resolve, 300))

    return await new Promise((resolve, reject) => {
      printWindow.webContents.print(
        { silent: false, printBackground: true },
        (success, failureReason) => {
          if (success) {
            resolve({ printed: true, cancelled: false })
          } else if (failureReason?.toLowerCase().includes('cancel')) {
            resolve({ printed: false, cancelled: true })
          } else {
            reject(new Error(failureReason || 'The PDF could not be printed.'))
          }
        },
      )
    })
  } finally {
    if (!printWindow.isDestroyed()) {
      printWindow.destroy()
    }
  }
}

function isWindowPositionVisible(windowState) {
  if (!windowState || windowState.x === null || windowState.y === null) {
    return false
  }

  return screen.getAllDisplays().some(({ workArea }) => {
    const right = windowState.x + windowState.width
    const bottom = windowState.y + windowState.height
    return (
      right > workArea.x &&
      windowState.x < workArea.x + workArea.width &&
      bottom > workArea.y &&
      windowState.y < workArea.y + workArea.height
    )
  })
}

async function persistWindowState(window) {
  if (window.isDestroyed()) {
    return
  }

  const bounds = window.getNormalBounds()
  const windowState = {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    maximized: window.isMaximized(),
  }

  await withStore(async (store) => {
    store.windowState = windowState
    await saveStore(store)
  })
}

async function createWindow() {
  rendererReady = false
  const savedWindowState = await withStore((store) => store.windowState)
  const hasVisiblePosition = isWindowPositionVisible(savedWindowState)
  const window = new BrowserWindow({
    width: savedWindowState?.width ?? 1200,
    height: savedWindowState?.height ?? 850,
    ...(hasVisiblePosition ? { x: savedWindowState.x, y: savedWindowState.y } : {}),
    minWidth: 900,
    minHeight: 650,
    title: 'Next PDF Viewer',
    icon: app.isPackaged
      ? path.join(process.resourcesPath, 'icon.png')
      : path.join(__dirname, '../build/icon.png'),
    backgroundColor: '#111827',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  mainWindow = window
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  if (savedWindowState && !hasVisiblePosition) {
    window.center()
  }

  if (savedWindowState?.maximized) {
    window.maximize()
  }

  let saveTimeout = null
  let allowClose = false
  const scheduleWindowStateSave = () => {
    clearTimeout(saveTimeout)
    saveTimeout = setTimeout(() => {
      void persistWindowState(window)
    }, 250)
  }

  window.on('resize', scheduleWindowStateSave)
  window.on('move', scheduleWindowStateSave)
  window.on('maximize', scheduleWindowStateSave)
  window.on('unmaximize', scheduleWindowStateSave)
  window.on('enter-full-screen', () => window.webContents.send('window:fullscreen-changed', true))
  window.on('leave-full-screen', () => window.webContents.send('window:fullscreen-changed', false))
  window.on('close', (event) => {
    if (allowClose) {
      return
    }

    event.preventDefault()
    clearTimeout(saveTimeout)
    void persistWindowState(window).finally(() => {
      allowClose = true
      window.close()
    })
  })
  window.on('closed', () => {
    clearTimeout(saveTimeout)
    if (mainWindow === window) {
      mainWindow = null
      rendererReady = false
    }
  })

  if (app.isPackaged) {
    await window.loadFile(path.join(__dirname, '../dist/index.html'))
  } else {
    await window.loadURL('http://localhost:5173')
  }

  void withStore(async (store) => {
    const removed = await pruneMissingRegisteredDocuments(store)
    if (removed > 0) await saveStore(store)
    return {
      documentRegistry: structuredClone(store.documentRegistry),
      highlightDocuments: structuredClone(store.highlightDocuments),
    }
  })
    .then(({ documentRegistry, highlightDocuments }) =>
      globalSearchIndex.syncLibrarySources(documentRegistry, highlightDocuments),
    )
    .catch((error) => console.warn('Global search index sync failed:', error))
}

ipcMain.handle('pdf:open', async () => {
  const result = await dialog.showOpenDialog(mainWindow ?? undefined, {
    title: 'Open PDF',
    filters: [{ name: 'PDF Files', extensions: ['pdf'] }],
    properties: ['openFile'],
  })

  if (result.canceled || result.filePaths.length === 0) {
    return null
  }

  return loadPdf(result.filePaths[0])
})

ipcMain.on('pdf:renderer-ready', (event) => {
  if (mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents) {
    rendererReady = true
    void processPendingSystemPdfs()
  }
})

ipcMain.handle('pdf:open-dropped', (_event, filePath) => {
  if (typeof filePath !== 'string' || path.extname(filePath).toLowerCase() !== '.pdf') {
    throw new Error('Only PDF files can be opened.')
  }

  return loadPdf(filePath)
})

ipcMain.handle('pdf:open-path', (_event, filePath) => {
  if (typeof filePath !== 'string' || path.extname(filePath).toLowerCase() !== '.pdf') {
    throw new Error('Only PDF files can be opened.')
  }
  return loadPdf(filePath)
})

ipcMain.handle('tools:merge-pick-pdfs', async () => {
  const result = await dialog.showOpenDialog(mainWindow ?? undefined, {
    title: 'Add PDFs to Merge',
    filters: [{ name: 'PDF Files', extensions: ['pdf'] }],
    properties: ['openFile', 'multiSelections'],
  })
  if (result.canceled || result.filePaths.length === 0) return []
  return inspectMergePdfs(result.filePaths)
})

ipcMain.handle('tools:merge-inspect-pdfs', (_event, filePaths) =>
  inspectMergePdfs(filePaths),
)

ipcMain.handle('tools:merge-pdfs', (_event, options) =>
  mergePdfFiles(options ?? {}),
)

ipcMain.handle('tools:images-pick', async () => {
  const result = await dialog.showOpenDialog(mainWindow ?? undefined, {
    title: 'Add Images to PDF',
    filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp'] }],
    properties: ['openFile', 'multiSelections'],
  })
  if (result.canceled || result.filePaths.length === 0) return []
  return inspectImageFiles(result.filePaths)
})

ipcMain.handle('tools:images-inspect', (_event, filePaths) =>
  inspectImageFiles(filePaths),
)

ipcMain.handle('tools:images-to-pdf', (_event, options) =>
  imagesToPdf(options ?? {}),
)

ipcMain.handle('pdf:recent-list', () =>
  withStore(async (store) => {
    const checks = await Promise.all(store.recentFiles.map(async (item) => {
      try {
        await fs.access(item.path)
        return null
      } catch (error) {
        return error.code === 'ENOENT' ? item.id : null
      }
    }))
    const missingIds = new Set(checks.filter(Boolean))
    if (missingIds.size > 0) {
      store.recentFiles = store.recentFiles.filter((item) => !missingIds.has(item.id))
      for (const id of missingIds) {
        if (store.documentRegistry[id]) store.documentRegistry[id].missing = true
        await globalSearchIndex.removeDocument(id)
      }
      await saveStore(store)
    }
    return store.recentFiles.map(({ id, name }) => ({ id, name }))
  }),
)

ipcMain.handle('pdf:recent-clear', () =>
  withStore(async (store) => {
    store.recentFiles = []
    await saveStore(store)
    return []
  }),
)

ipcMain.handle('pdf:recent-remove', (_event, id) =>
  withStore(async (store) => {
    store.recentFiles = store.recentFiles.filter((item) => item.id !== id)
    await saveStore(store)
    return store.recentFiles.map(({ id: documentId, name }) => ({ id: documentId, name }))
  }),
)

ipcMain.handle('pdf:open-recent', (_event, id) =>
  withStore(async (store) => {
    const recentFile = store.documentRegistry[id] ?? store.recentFiles.find((item) => item.id === id)
    if (!recentFile) {
      throw new Error('This PDF is no longer available in the document registry.')
    }

    try {
      const [buffer, fileStats] = await Promise.all([
        fs.readFile(recentFile.path),
        fs.stat(recentFile.path),
      ])
      recentFile.fileSize = buffer.byteLength
      recentFile.modifiedAt = fileStats.mtimeMs
      recentFile.openedAt = Date.now()
      recentFile.missing = false
      store.documentRegistry[id] = recentFile
      ensureReferenceForDocument(store, recentFile)
      store.recentFiles = [
        recentFile,
        ...store.recentFiles.filter((item) => item.id !== id),
      ].slice(0, 20)
      await saveStore(store)
      await globalSearchIndex.upsertFile(recentFile)

      return {
        id: recentFile.id,
        name: recentFile.name,
        filePath: recentFile.path,
        fileSize: buffer.byteLength,
        modifiedAt: fileStats.mtimeMs,
        dataUrl: `data:application/pdf;base64,${buffer.toString('base64')}`,
        readingState: sanitizeReadingState(store.documentStates[id]),
        highlights: getStoredHighlights(
          store,
          recentFile.path,
          buffer.byteLength,
          fileStats.mtimeMs,
        ),
        signaturePlacements: getStoredSignaturePlacements(
          store,
          recentFile.path,
          buffer.byteLength,
          fileStats.mtimeMs,
        ),
        fillSignFields: getStoredFillSignFields(
          store,
          recentFile.path,
          buffer.byteLength,
          fileStats.mtimeMs,
        ),
      }
    } catch (error) {
      if (error.code === 'ENOENT') {
        store.recentFiles = store.recentFiles.filter((item) => item.id !== id)
        recentFile.missing = true
        store.documentRegistry[id] = recentFile
        await globalSearchIndex.removeDocument(id)
        await saveStore(store)
        throw new Error(`PDF no longer exists: ${recentFile.name}`)
      }
      throw error
    }
  }),
)

ipcMain.handle('workspace:get', () =>
  withStore((store) => sanitizeWorkspace(getActiveWorkspaceProject(store).session)),
)

ipcMain.handle('workspace:save', (_event, workspace) =>
  withStore(async (store) => {
    const activeWorkspace = getActiveWorkspaceProject(store)
    activeWorkspace.session = sanitizeWorkspace(workspace)
    activeWorkspace.updatedAt = new Date().toISOString()
    store.workspace = activeWorkspace.session
    await saveStore(store)
    return store.workspace
  }),
)

ipcMain.handle('workspaces:list', () =>
  withStore((store) => {
    if (store.highlightLibraryVersion !== 2) rebuildHighlightLibraryIndex(store)
    return {
      activeWorkspaceId: store.workspaceSystem.activeWorkspaceId,
      workspaces: store.workspaceSystem.items
        .map((workspace) => workspaceSummary(workspace, store))
        .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)),
    }
  }),
)

ipcMain.handle('workspaces:get-active', () =>
  withStore(async (store) => workspaceDetails(store, getActiveWorkspaceProject(store))),
)

ipcMain.handle('workspaces:get-details', (_event, id) =>
  withStore(async (store) => {
    const workspace = store.workspaceSystem.items.find((candidate) => candidate.id === id)
    if (!workspace) throw new Error('Workspace no longer exists.')
    return workspaceDetails(store, workspace)
  }),
)

ipcMain.handle('workspaces:create', (_event, payload) =>
  withStore(async (store) => {
    const workspace = createWorkspaceProject(payload)
    if (!workspace.name) throw new Error('Workspace name is required.')
    store.workspaceSystem.items.push(workspace)
    await saveStore(store)
    return workspaceSummary(workspace, store)
  }),
)

ipcMain.handle('workspaces:update', (_event, id, patch) =>
  withStore(async (store) => {
    const workspace = store.workspaceSystem.items.find((candidate) => candidate.id === id)
    if (!workspace) throw new Error('Workspace no longer exists.')
    if (typeof patch?.name === 'string') {
      const name = patch.name.trim().slice(0, 120)
      if (!name) throw new Error('Workspace name is required.')
      workspace.name = name
    }
    if (typeof patch?.description === 'string') workspace.description = patch.description.trim().slice(0, 2000)
    if (patch?.color) workspace.color = sanitizeWorkspaceColor(patch.color)
    if (patch?.icon) workspace.icon = sanitizeWorkspaceIcon(patch.icon)
    workspace.updatedAt = new Date().toISOString()
    await saveStore(store)
    return workspaceSummary(workspace, store)
  }),
)

ipcMain.handle('workspaces:delete', (_event, id) =>
  withStore(async (store) => {
    if (store.workspaceSystem.items.length === 1) {
      throw new Error('At least one workspace must remain.')
    }
    const index = store.workspaceSystem.items.findIndex((workspace) => workspace.id === id)
    if (index < 0) throw new Error('Workspace no longer exists.')
    const deletedActive = store.workspaceSystem.activeWorkspaceId === id
    store.workspaceSystem.items.splice(index, 1)
    if (deletedActive) {
      store.workspaceSystem.activeWorkspaceId = store.workspaceSystem.items[Math.min(index, store.workspaceSystem.items.length - 1)].id
      store.workspace = getActiveWorkspaceProject(store).session
    }
    await saveStore(store)
    return {
      activeWorkspaceId: store.workspaceSystem.activeWorkspaceId,
      deletedActive,
      session: getActiveWorkspaceProject(store).session,
    }
  }),
)

ipcMain.handle('workspaces:switch', (_event, id, currentSession) =>
  withStore(async (store) => {
    const target = store.workspaceSystem.items.find((workspace) => workspace.id === id)
    if (!target) throw new Error('Workspace no longer exists.')
    const current = getActiveWorkspaceProject(store)
    if (currentSession) {
      current.session = sanitizeWorkspace(currentSession)
      current.updatedAt = new Date().toISOString()
    }
    store.workspaceSystem.activeWorkspaceId = target.id
    store.workspace = target.session
    target.updatedAt = new Date().toISOString()
    await saveStore(store)
    return { workspace: workspaceSummary(target, store), session: target.session }
  }),
)

ipcMain.handle('workspaces:remove-document', (_event, workspaceId, documentId) =>
  withStore(async (store) => {
    const workspace = store.workspaceSystem.items.find((candidate) => candidate.id === workspaceId)
    if (!workspace) throw new Error('Workspace no longer exists.')
    workspace.documentIds = workspace.documentIds.filter((id) => id !== documentId)
    workspace.referenceIds = workspace.referenceIds.filter((id) => id !== documentId)
    workspace.session = removeDocumentFromWorkspace(workspace.session, documentId)
    addWorkspaceActivity(workspace, 'document-removed', 'Removed document from workspace', { documentId })
    if (workspace.id === store.workspaceSystem.activeWorkspaceId) store.workspace = workspace.session
    await saveStore(store)
    return workspaceDetails(store, workspace)
  }),
)

ipcMain.handle('workspaces:add-document', (_event, workspaceId, documentId) =>
  withStore(async (store) => {
    const workspace = store.workspaceSystem.items.find((candidate) => candidate.id === workspaceId)
    if (!workspace) throw new Error('Workspace no longer exists.')
    const document = store.documentRegistry[documentId] ?? store.recentFiles.find((item) => item.id === documentId)
    if (!document) throw new Error('The PDF is no longer available.')
    if (!workspace.documentIds.includes(documentId)) {
      workspace.documentIds.push(documentId)
      addWorkspaceActivity(workspace, 'document-added', `Added ${document.name}`, { documentId })
    }
    workspace.updatedAt = new Date().toISOString()
    await saveStore(store)
    return workspaceDetails(store, workspace)
  }),
)

ipcMain.handle('workspaces:export', async (_event, id, format) => {
  const payload = await withStore(async (store) => {
    const workspace = store.workspaceSystem.items.find((candidate) => candidate.id === id)
    if (!workspace) throw new Error('Workspace no longer exists.')
    return buildWorkspacePackage(
      store,
      workspace,
      await globalSearchIndex.getWorkspaceSavedSearches(workspace.id),
    )
  })
  const extension = format === 'zip' ? 'zip' : 'json'
  const result = await dialog.showSaveDialog(mainWindow ?? undefined, {
    title: 'Export Workspace',
    defaultPath: `${payload.workspace.name.replace(/[^a-z0-9-_ ]/gi, '').trim() || 'workspace'}.${extension}`,
    filters: [{ name: extension === 'zip' ? 'Workspace Package' : 'Workspace JSON', extensions: [extension] }],
  })
  if (result.canceled || !result.filePath) return null
  const json = JSON.stringify(payload, null, 2)
  await fs.writeFile(result.filePath, extension === 'zip' ? createStoredZip([['workspace.json', json]]) : json)
  await withStore(async (store) => {
    const workspace = store.workspaceSystem.items.find((candidate) => candidate.id === id)
    if (workspace) {
      addWorkspaceActivity(workspace, 'workspace-exported', `Exported workspace as ${extension.toUpperCase()}`)
      await saveStore(store)
    }
  })
  return result.filePath
})

ipcMain.handle('workspaces:import', async () => {
  const result = await dialog.showOpenDialog(mainWindow ?? undefined, {
    title: 'Import Workspace',
    filters: [{ name: 'Workspace Packages', extensions: ['json', 'zip'] }],
    properties: ['openFile'],
  })
  if (result.canceled || !result.filePaths[0]) return null
  const sourcePath = result.filePaths[0]
  const buffer = await fs.readFile(sourcePath)
  let payload
  try {
    const json = path.extname(sourcePath).toLowerCase() === '.zip'
      ? readStoredZipEntry(buffer, 'workspace.json')
      : buffer.toString('utf8')
    payload = JSON.parse(json)
  } catch (error) {
    throw new Error(`Invalid workspace package: ${error.message}`)
  }
  if (payload?.format !== 'next-pdf-viewer-workspace' || payload?.version !== 1) {
    throw new Error('This is not a supported Next PDF Viewer workspace package.')
  }

  const checkedDocuments = await Promise.all((Array.isArray(payload.documents) ? payload.documents : []).slice(0, 5000).map(async (document) => {
    try {
      const stats = await fs.stat(String(document?.filePath ?? ''))
      if (!stats.isFile() || path.extname(document.filePath).toLowerCase() !== '.pdf') return null
      return { document, stats }
    } catch {
      return null
    }
  }))
  const missingFiles = (payload.documents ?? []).filter((_document, index) => !checkedDocuments[index]).map((document) => String(document?.filePath ?? ''))

  const imported = await withStore(async (store) => {
    const workspace = createWorkspaceProject(payload.workspace)
    workspace.name = `${workspace.name || 'Imported Workspace'}`
    workspace.dashboardLayout = sanitizeDashboardLayout(payload.workspace?.dashboardLayout)
    workspace.workspaceSettings = sanitizeWorkspaceSettings(payload.workspace?.workspaceSettings)
    const duplicates = []
    for (const checked of checkedDocuments) {
      if (!checked) continue
      const documentId = getDocumentId(checked.document.filePath)
      if (store.documentRegistry[documentId]) duplicates.push(checked.document.filePath)
      store.documentRegistry[documentId] = {
        id: documentId,
        name: path.basename(checked.document.filePath),
        path: checked.document.filePath,
        fileSize: checked.stats.size,
        modifiedAt: checked.stats.mtimeMs,
        openedAt: Date.now(),
      }
      workspace.documentIds.push(documentId)
      workspace.referenceIds.push(documentId)
      if (!store.referenceLibrary.items[documentId]) {
        store.referenceLibrary.items[documentId] = sanitizeReference({}, store.documentRegistry[documentId])
      }
    }
    workspace.documentIds = [...new Set(workspace.documentIds)]
    workspace.referenceIds = [...new Set(workspace.referenceIds)]
    for (const collection of Array.isArray(payload.referenceCollections) ? payload.referenceCollections : []) {
      if (!store.referenceLibrary.collections.some((candidate) => candidate.id === collection.id)) {
        store.referenceLibrary.collections.push({
          id: String(collection.id ?? randomUUID()).slice(0, 100),
          name: String(collection.name ?? 'Imported Collection').slice(0, 120),
          description: String(collection.description ?? '').slice(0, 1000),
          color: sanitizeWorkspaceColor(collection.color),
          createdAt: validIsoDate(collection.createdAt) ?? new Date().toISOString(),
        })
      }
    }
    for (const source of Array.isArray(payload.references) ? payload.references : []) {
      const documentId = source?.filePath ? getDocumentId(source.filePath) : null
      const record = documentId ? store.documentRegistry[documentId] : null
      if (!record) continue
      store.referenceLibrary.items[documentId] = sanitizeReference({ ...source, id: documentId, documentId, documentName: record.name, filePath: record.path }, record)
    }
    for (const source of Array.isArray(payload.highlightDocuments) ? payload.highlightDocuments : []) {
      const documentId = source?.filePath ? getDocumentId(source.filePath) : null
      const record = documentId ? store.documentRegistry[documentId] : null
      if (!record) continue
      const key = getHighlightDocumentKey(record.path, record.fileSize, record.modifiedAt)
      const existing = store.highlightDocuments[key]?.highlights ?? []
      const byId = new Map(existing.map((highlight) => [highlight.id, highlight]))
      for (const highlight of source.highlights ?? []) {
        const sanitized = sanitizeHighlight(highlight)
        if (sanitized) byId.set(sanitized.id, sanitized)
      }
      store.highlightDocuments[key] = {
        filePath: record.path,
        fileSize: record.fileSize,
        modifiedAt: record.modifiedAt,
        highlights: [...byId.values()],
      }
    }
    rebuildHighlightLibraryIndex(store)
    store.workspaceSystem.items.push(workspace)
    store.workspaceSystem.activeWorkspaceId = workspace.id
    store.workspace = workspace.session
    await saveStore(store)
    for (const search of Array.isArray(payload.savedSearches) ? payload.savedSearches : []) {
      await globalSearchIndex.saveSearch({ ...search, id: undefined, workspaceId: workspace.id })
    }
    await globalSearchIndex.syncLibrarySources(store.documentRegistry, store.highlightDocuments)
    return { workspace: workspaceSummary(workspace, store), session: workspace.session, missingFiles, duplicateDocuments: duplicates }
  })
  return imported
})

ipcMain.handle('references:query', (_event, request) =>
  withStore((store) => queryReferences(store, request)),
)

ipcMain.handle('references:get', (_event, id) =>
  withStore((store) => {
    const reference = store.referenceLibrary.items[String(id ?? '')]
    if (!reference || reference.mergedInto) throw new Error('Reference no longer exists.')
    return referenceView(store, reference)
  }),
)

ipcMain.handle('references:touch', (_event, id) =>
  withStore(async (store) => {
    const reference = store.referenceLibrary.items[String(id ?? '')]
    if (!reference) return
    reference.usageCount += 1
    reference.lastUsedAt = new Date().toISOString()
    await saveStore(store)
  }),
)

ipcMain.handle('references:upsert-extracted', (_event, payload) =>
  withStore(async (store) => {
    const documentId = String(payload?.documentId ?? '')
    const record = store.documentRegistry[documentId]
    if (!record) throw new Error('Document is not registered.')
    const sourceMetadata = sanitizeReferenceMetadata(payload?.sourceMetadata ?? payload?.metadata)
    const acceptedEntries = Array.isArray(payload?.references) ? payload.references.slice(0, 2000) : []
    const extractedReferenceIds = []
    const now = new Date().toISOString()
    const sourceDocument = sanitizeSourceDocument({
      documentId,
      fileName: record.name,
      filePath: record.path,
      metadata: sourceMetadata,
      hasReferenceSection: payload?.hasReferenceSection === true && acceptedEntries.length >= 2,
      referenceSectionStatus: payload?.referenceSectionStatus,
      referenceHeadingPage: payload?.referenceHeadingPage,
      extractedReferenceIds,
      checkedAt: now,
      error: payload?.error,
    }, record)
    sourceDocument.referenceSectionStatus = sourceDocument.hasReferenceSection ? 'found' : sourceDocument.referenceSectionStatus === 'error' ? 'error' : 'not_found'
    sourceDocument.hasReferenceSection = sourceDocument.referenceSectionStatus === 'found'
    const previousExtracted = new Set(Object.values(store.referenceLibrary.items)
      .filter((reference) => reference.documentId === documentId && reference.extractionSource === 'reference_section')
      .map((reference) => reference.id))
    for (const entry of acceptedEntries) {
      const rawText = String(entry?.rawText ?? '').replace(/\s+/g, ' ').trim()
      if (!rawText) continue
      const id = referenceEntryId(documentId, rawText)
      previousExtracted.delete(id)
      const existing = store.referenceLibrary.items[id]
      const sourceIncoming = sanitizeReferenceMetadata(entry)
      const reference = sanitizeReference({
        ...existing,
        id,
        documentId,
        sourceDocumentId: documentId,
        documentName: record.name,
        filePath: record.path,
        sourceFileName: record.name,
        sourceFilePath: record.path,
        rawText,
        confidence: Number(entry?.confidence) || 0.5,
        extractionSource: 'reference_section',
        sourceMetadata: sourceIncoming,
        detectedMetadata: {},
        userOverrides: existing?.userOverrides ?? {},
        collectionIds: existing?.collectionIds ?? [],
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      }, record)
      store.referenceLibrary.items[id] = reference
      extractedReferenceIds.push(id)
    }
    for (const id of previousExtracted) {
      delete store.referenceLibrary.items[id]
      for (const workspace of store.workspaceSystem.items) {
        workspace.referenceIds = workspace.referenceIds.filter((referenceId) => referenceId !== id)
      }
    }
    sourceDocument.extractedReferenceIds = extractedReferenceIds
    store.referenceLibrary.sourceDocuments[documentId] = sourceDocument
    store.referenceLibrary.removedSourceDocumentIds = (store.referenceLibrary.removedSourceDocumentIds ?? []).filter((id) => id !== documentId)
    const workspace = getActiveWorkspaceProject(store)
    if (workspace.documentIds.includes(documentId) && extractedReferenceIds.length) {
      const before = workspace.referenceIds.length
      workspace.referenceIds = [...new Set([...workspace.referenceIds, ...extractedReferenceIds])]
      if (workspace.referenceIds.length !== before) {
        addWorkspaceActivity(workspace, 'reference-added', `Extracted ${extractedReferenceIds.length} reference${extractedReferenceIds.length === 1 ? '' : 's'} from ${record.name}`, { documentId })
      }
    }
    await saveStore(store)
    for (const id of extractedReferenceIds) {
      const reference = store.referenceLibrary.items[id]
      const collectionNames = reference.collectionIds.flatMap((collectionId) => {
        const collection = store.referenceLibrary.collections.find((candidate) => candidate.id === collectionId)
        return collection ? [collection.name] : []
      })
      await globalSearchIndex.updateReferenceMetadata(record, effectiveReference(reference), collectionNames)
    }
    return {
      sourceDocument,
      references: extractedReferenceIds.map((id) => referenceView(store, store.referenceLibrary.items[id])),
    }
  }),
)

ipcMain.handle('references:update', (_event, id, patch) =>
  withStore(async (store) => {
    const reference = store.referenceLibrary.items[String(id ?? '')]
    if (!reference || reference.mergedInto) throw new Error('Reference no longer exists.')
    const record = store.documentRegistry[reference.documentId]
    const updated = sanitizeReference({
      ...reference,
      userOverrides: sanitizeReferenceMetadata({ ...reference.userOverrides, ...patch }),
      doiLookupSource: typeof patch?.doiLookupSource === 'string' ? patch.doiLookupSource : reference.doiLookupSource,
      doiLookupAt: typeof patch?.doiLookupAt === 'string' ? patch.doiLookupAt : reference.doiLookupAt,
      updatedAt: new Date().toISOString(),
    }, record)
    store.referenceLibrary.items[updated.id] = updated
    await saveStore(store)
    if (record) {
      const collectionNames = updated.collectionIds.flatMap((collectionId) => {
        const collection = store.referenceLibrary.collections.find((candidate) => candidate.id === collectionId)
        return collection ? [collection.name] : []
      })
      await globalSearchIndex.updateReferenceMetadata(record, effectiveReference(updated), collectionNames)
    }
    return referenceView(store, updated)
  }),
)

ipcMain.handle('references:lookup-doi', async (_event, doiInput) => {
  const doi = normalizeDoiInput(doiInput)
  if (!isValidDoi(doi)) throw new Error('Invalid DOI format. Expected something like 10.xxxx/xxxxx.')
  const response = await fetch(`https://doi.org/${encodeURI(doi)}`, {
    headers: {
      Accept: 'application/vnd.citationstyles.csl+json',
      'User-Agent': 'Next PDF Viewer/2.8.0 (mailto:support@nexanest.com)',
    },
  })
  if (!response.ok) {
    throw new Error(response.status === 404 ? 'No metadata found for this DOI.' : `DOI lookup failed with HTTP ${response.status}.`)
  }
  const item = await response.json()
  const metadata = sanitizeReferenceMetadata(metadataFromCsl(item, doi))
  if (!metadata.title && !metadata.authors.length && !metadata.year) throw new Error('No usable metadata found for this DOI.')
  return {
    metadata,
    source: 'doi.org CSL JSON',
    lookedUpAt: new Date().toISOString(),
  }
})

ipcMain.handle('references:remove-source-document', (_event, documentIdInput) =>
  withStore(async (store) => {
    const documentId = String(documentIdInput ?? '').slice(0, 128)
    if (!documentId) throw new Error('Document id is required.')
    delete store.referenceLibrary.sourceDocuments[documentId]
    store.referenceLibrary.removedSourceDocumentIds = [...new Set([...(store.referenceLibrary.removedSourceDocumentIds ?? []), documentId])]
    await saveStore(store)
  }),
)

ipcMain.handle('references:create-manual', (_event, payload) =>
  withStore(async (store) => {
    const now = new Date().toISOString()
    const id = `manual_${randomUUID()}`
    const reference = sanitizeReference({
      id,
      documentId: `manual:${id}`,
      sourceDocumentId: '',
      documentName: 'Manual Reference',
      filePath: '',
      sourceFileName: 'Manual Reference',
      sourceFilePath: '',
      rawText: String(payload?.rawText ?? '').trim(),
      confidence: 1,
      extractionSource: 'manual',
      sourceMetadata: sanitizeReferenceMetadata(payload),
      detectedMetadata: {},
      userOverrides: {},
      createdAt: now,
      updatedAt: now,
      lastUsedAt: now,
    })
    store.referenceLibrary.items[id] = reference
    const workspace = getActiveWorkspaceProject(store)
    workspace.referenceIds = [...new Set([...workspace.referenceIds, id])]
    addWorkspaceActivity(workspace, 'reference-added', `Added manual reference: ${effectiveReference(reference).title || 'Untitled'}`, {})
    await saveStore(store)
    return referenceView(store, reference)
  }),
)

ipcMain.handle('references:collection-create', (_event, payload) =>
  withStore(async (store) => {
    const name = String(payload?.name ?? '').trim().slice(0, 120)
    if (!name) throw new Error('Collection name is required.')
    const collection = { id: randomUUID(), name, description: String(payload?.description ?? '').slice(0, 1000), color: sanitizeWorkspaceColor(payload?.color), createdAt: new Date().toISOString() }
    store.referenceLibrary.collections.push(collection)
    await saveStore(store)
    return collection
  }),
)

ipcMain.handle('references:collection-delete', (_event, id) =>
  withStore(async (store) => {
    store.referenceLibrary.collections = store.referenceLibrary.collections.filter((collection) => collection.id !== id)
    for (const reference of Object.values(store.referenceLibrary.items)) {
      reference.collectionIds = reference.collectionIds.filter((collectionId) => collectionId !== id)
    }
    await saveStore(store)
  }),
)

ipcMain.handle('references:collection-update', (_event, id, patch) =>
  withStore(async (store) => {
    const collection = store.referenceLibrary.collections.find((candidate) => candidate.id === id)
    if (!collection) throw new Error('Collection no longer exists.')
    const name = String(patch?.name ?? collection.name).trim().slice(0, 120)
    if (!name) throw new Error('Collection name is required.')
    collection.name = name
    collection.description = String(patch?.description ?? collection.description ?? '').slice(0, 1000)
    collection.color = patch?.color ? sanitizeWorkspaceColor(patch.color) : collection.color
    await saveStore(store)
    return collection
  }),
)

ipcMain.handle('references:delete', (_event, ids) =>
  withStore(async (store) => {
    const requested = new Set((Array.isArray(ids) ? ids : []).map((id) => String(id).slice(0, 128)).filter(Boolean))
    if (!requested.size) return 0
    let deleted = 0
    for (const id of requested) {
      if (!store.referenceLibrary.items[id]) continue
      delete store.referenceLibrary.items[id]
      deleted += 1
    }
    if (deleted) {
      for (const workspace of store.workspaceSystem.items) {
        workspace.referenceIds = workspace.referenceIds.filter((id) => !requested.has(id))
      }
      for (const document of Object.values(store.referenceLibrary.sourceDocuments ?? {})) {
        document.extractedReferenceIds = document.extractedReferenceIds.filter((id) => !requested.has(id))
      }
      await saveStore(store)
    }
    return deleted
  }),
)

ipcMain.handle('references:set-collections', (_event, id, collectionIds) =>
  withStore(async (store) => {
    const reference = store.referenceLibrary.items[String(id ?? '')]
    if (!reference || reference.mergedInto) throw new Error('Reference no longer exists.')
    const allowed = new Set(store.referenceLibrary.collections.map((collection) => collection.id))
    reference.collectionIds = [...new Set((Array.isArray(collectionIds) ? collectionIds : []).filter((value) => allowed.has(value)))].slice(0, 500)
    reference.updatedAt = new Date().toISOString()
    await saveStore(store)
    const record = store.documentRegistry[reference.documentId]
    if (record) await globalSearchIndex.updateReferenceMetadata(record, effectiveReference(reference), reference.collectionIds.map((collectionId) => store.referenceLibrary.collections.find((collection) => collection.id === collectionId)?.name).filter(Boolean))
    return referenceView(store, reference)
  }),
)

ipcMain.handle('references:set-workspace-membership', (_event, workspaceId, referenceId, included) =>
  withStore(async (store) => {
    const workspace = store.workspaceSystem.items.find((candidate) => candidate.id === workspaceId)
    const reference = store.referenceLibrary.items[referenceId]
    if (!workspace || !reference) throw new Error('Workspace or reference no longer exists.')
    if (!isExportableReference(reference)) throw new Error('This PDF document is not a bibliography reference.')
    workspace.referenceIds = included
      ? [...new Set([...workspace.referenceIds, referenceId])]
      : workspace.referenceIds.filter((id) => id !== referenceId)
    addWorkspaceActivity(workspace, included ? 'reference-added' : 'reference-removed', `${included ? 'Added' : 'Removed'} reference: ${effectiveReference(reference).title || reference.documentName}`, { documentId: reference.documentId })
    await saveStore(store)
    return workspace.referenceIds
  }),
)

ipcMain.handle('references:duplicates', () =>
  withStore((store) => {
    const groups = findDuplicateGroups(Object.values(store.referenceLibrary.items).filter(isExportableReference))
    return groups.map((group) => ({
      ...group,
      references: group.referenceIds.map((id) => referenceView(store, store.referenceLibrary.items[id])),
    }))
  }),
)

ipcMain.handle('references:keep-separate', (_event, ids) =>
  withStore(async (store) => {
    for (const id of Array.isArray(ids) ? ids : []) {
      if (store.referenceLibrary.items[id]) store.referenceLibrary.items[id].duplicateDecision = 'keep'
    }
    await saveStore(store)
  }),
)

ipcMain.handle('references:merge', (_event, primaryId, duplicateIds) =>
  withStore(async (store) => {
    const primary = store.referenceLibrary.items[primaryId]
    if (!primary) throw new Error('Primary reference no longer exists.')
    for (const duplicateId of Array.isArray(duplicateIds) ? duplicateIds : []) {
      if (duplicateId === primaryId) continue
      const duplicate = store.referenceLibrary.items[duplicateId]
      if (!duplicate) continue
      const source = effectiveReference(duplicate)
      const target = effectiveReference(primary)
      for (const field of ['title', 'year', 'publisher', 'journal', 'conference', 'volume', 'issue', 'pages', 'doi', 'url', 'isbn', 'referenceType']) {
        if (!target[field] && source[field]) primary.userOverrides[field] = source[field]
      }
      if (!target.authors.length && source.authors.length) primary.userOverrides.authors = source.authors
      primary.userOverrides.keywords = [...new Set([...target.keywords, ...source.keywords])]
      primary.overrides = primary.userOverrides
      primary.collectionIds = [...new Set([...primary.collectionIds, ...duplicate.collectionIds])]
      duplicate.mergedInto = primaryId
      for (const workspace of store.workspaceSystem.items) {
        if (workspace.referenceIds.includes(duplicateId)) workspace.referenceIds = [...new Set([...workspace.referenceIds.filter((id) => id !== duplicateId), primaryId])]
      }
    }
    primary.updatedAt = new Date().toISOString()
    const normalizedPrimary = sanitizeReference(primary, store.documentRegistry[primary.documentId])
    store.referenceLibrary.items[primaryId] = normalizedPrimary
    await saveStore(store)
    return referenceView(store, normalizedPrimary)
  }),
)

ipcMain.handle('references:export', async (_event, options) => {
  const payload = await withStore((store) => {
    const ids = new Set(Array.isArray(options?.referenceIds) ? options.referenceIds : [])
    const workspace = options?.workspaceId
      ? store.workspaceSystem.items.find((candidate) => candidate.id === options.workspaceId)
      : null
    const filteredIds = !ids.size && options?.request
      ? queryReferences(store, { ...options.request, offset: 0, limit: 10000, all: true }).references.map((reference) => reference.id)
      : null
    const selectedIds = ids.size ? ids : new Set(filteredIds ?? workspace?.referenceIds ?? Object.keys(store.referenceLibrary.items))
    const references = [...selectedIds].flatMap((id) => {
      const reference = store.referenceLibrary.items[id]
      return reference && !reference.mergedInto && isExportableReference(reference) ? [reference] : []
    })
    return { references, title: workspace ? `${workspace.name} Bibliography` : 'Reference Library Bibliography' }
  })
  if (!payload.references.length) throw new Error('No references are available to export.')
  const validation = payload.references.map(validateReference)
  const missingAuthors = validation.filter((item) => item.missingAuthors).length
  const missingTitles = validation.filter((item) => item.missingTitle).length
  const missingYears = validation.filter((item) => item.missingYear).length
  const missingDoiOrUrl = validation.filter((item) => item.missingDoiOrUrl).length
  const missingSource = validation.filter((item) => item.missingSource).length
  if (missingAuthors || missingTitles || missingYears || missingDoiOrUrl || missingSource) {
    const warning = await dialog.showMessageBox(mainWindow ?? undefined, {
      type: 'warning',
      title: 'Incomplete Citation Metadata',
      message: 'Some selected references have incomplete citation metadata.',
      detail: [
        missingAuthors && `${missingAuthors} missing author${missingAuthors === 1 ? '' : 's'}`,
        missingTitles && `${missingTitles} using filename title fallback`,
        missingYears && `${missingYears} missing publication year`,
        missingDoiOrUrl && `${missingDoiOrUrl} missing DOI or URL`,
        missingSource && `${missingSource} missing journal, publisher, or conference`,
      ].filter(Boolean).join('\n'),
      buttons: ['Continue Export', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    })
    if (warning.response !== 0) return null
  }
  const style = citationStyles.includes(options?.style) ? options.style : 'apa'
  const format = ['text', 'markdown', 'docx', 'bibtex', 'ris'].includes(options?.format) ? options.format : 'text'
  const extension = format === 'markdown' ? 'md' : format === 'docx' ? 'docx' : format === 'bibtex' ? 'bib' : format === 'ris' ? 'ris' : 'txt'
  const result = await dialog.showSaveDialog(mainWindow ?? undefined, {
    title: 'Export Bibliography',
    defaultPath: `${payload.title.replace(/[^a-z0-9-_ ]/gi, '').trim() || 'bibliography'}.${extension}`,
    filters: [{ name: format === 'docx' ? 'Word Document' : format === 'markdown' ? 'Markdown' : format === 'bibtex' ? 'BibTeX' : format === 'ris' ? 'RIS' : 'Plain Text', extensions: [extension] }],
  })
  if (result.canceled || !result.filePath) return null
  const content = format === 'docx'
    ? buildBibliographyDocx(payload.references, style, payload.title)
    : buildBibliography(payload.references, style, format, payload.title)
  await fs.writeFile(result.filePath, content)
  return result.filePath
})

ipcMain.handle('pdf:reveal', async (_event, id) => {
  const recentFile = await withStore((store) =>
    store.documentRegistry[id] ?? store.recentFiles.find((item) => item.id === id),
  )
  if (!recentFile) {
    throw new Error('The PDF is no longer available.')
  }

  await fs.access(recentFile.path)
  shell.showItemInFolder(recentFile.path)
})

ipcMain.handle('pdf:save-state', (_event, id, state) =>
  withStore(async (store) => {
    if (!store.documentRegistry[id] && !store.recentFiles.some((item) => item.id === id)) {
      return
    }

    const readingState = sanitizeReadingState(state)
    console.debug('Saved page:', readingState.page)
    store.documentStates[id] = readingState
    await saveStore(store)
  }),
)

ipcMain.handle('pdf:save-highlights', (_event, identity, highlights) =>
  withStore(async (store) => {
    const recentFile = store.documentRegistry[identity?.id] ?? store.recentFiles.find((item) => item.id === identity?.id)
    const fileSize = Number(identity?.fileSize)
    const modifiedAt = Number(identity?.modifiedAt)
    if (
      !recentFile ||
      !Number.isFinite(fileSize) ||
      !Number.isFinite(modifiedAt) ||
      recentFile.fileSize !== fileSize ||
      recentFile.modifiedAt !== modifiedAt
    ) {
      throw new Error('The PDF identity changed. Reopen the document before saving highlights.')
    }

    const previousDocument = store.highlightDocuments[
      getHighlightDocumentKey(recentFile.path, fileSize, modifiedAt)
    ]
    const previousHighlights = new Map(
      (previousDocument?.highlights ?? []).map((highlight) => [highlight.id, sanitizeHighlight(highlight)]),
    )
    const savedAt = new Date().toISOString()
    const sanitizedHighlights = Array.isArray(highlights)
      ? highlights.map(sanitizeHighlight).filter(Boolean).slice(0, 10000)
      : []
    for (const highlight of sanitizedHighlights) {
      const previous = previousHighlights.get(highlight.id)
      if (!previous) {
        highlight.modifiedDate = highlight.modifiedDate || highlight.createdDate
        continue
      }
      const changed =
        previous.text !== highlight.text ||
        previous.note !== highlight.note ||
        previous.color !== highlight.color ||
        previous.category !== highlight.category ||
        previous.pageNumber !== highlight.pageNumber ||
        previous.rotation !== highlight.rotation ||
        JSON.stringify(previous.rectangles) !== JSON.stringify(highlight.rectangles)
      highlight.modifiedDate = changed ? savedAt : previous.modifiedDate
    }
    const key = getHighlightDocumentKey(recentFile.path, fileSize, modifiedAt)
    const nextDocument = {
      filePath: recentFile.path,
      fileSize,
      modifiedAt,
      highlights: sanitizedHighlights,
    }
    store.highlightDocuments[key] = nextDocument
    updateHighlightDocumentIndex(store, key, previousDocument?.highlights, nextDocument)
    const workspace = getActiveWorkspaceProject(store)
    if (workspace.documentIds.includes(recentFile.id)) {
      const createdCount = sanitizedHighlights.filter((highlight) => !previousHighlights.has(highlight.id)).length
      const noteCount = sanitizedHighlights.filter((highlight) => {
        const previous = previousHighlights.get(highlight.id)
        return highlight.note && highlight.note !== previous?.note
      }).length
      if (createdCount) addWorkspaceActivity(workspace, 'highlight-created', `Created ${createdCount} highlight${createdCount === 1 ? '' : 's'}`, { documentId: recentFile.id, count: createdCount })
      if (noteCount) addWorkspaceActivity(workspace, 'note-added', `Added ${noteCount} note${noteCount === 1 ? '' : 's'}`, { documentId: recentFile.id, count: noteCount })
    }
    await saveStore(store)
    await globalSearchIndex.updateHighlights(recentFile, key, sanitizedHighlights)
    return sanitizedHighlights
  }),
)

ipcMain.handle('pdf:save-signature-placements', (_event, identity, placements) =>
  withStore(async (store) => {
    const recentFile = store.documentRegistry[identity?.id] ?? store.recentFiles.find((item) => item.id === identity?.id)
    const fileSize = Number(identity?.fileSize)
    const modifiedAt = Number(identity?.modifiedAt)
    if (
      !recentFile ||
      !Number.isFinite(fileSize) ||
      !Number.isFinite(modifiedAt) ||
      recentFile.fileSize !== fileSize ||
      recentFile.modifiedAt !== modifiedAt
    ) {
      throw new Error('The PDF identity changed. Reopen the document before saving signatures.')
    }

    const documentId = recentFile.id
    const sanitizedPlacements = Array.isArray(placements)
      ? placements
        .map((placement) => sanitizeSignaturePlacement({ ...placement, documentId }, documentId))
        .filter(Boolean)
        .slice(0, 2000)
      : []
    const key = getHighlightDocumentKey(recentFile.path, fileSize, modifiedAt)
    store.signaturePlacementDocuments = sanitizeSignaturePlacementDocuments(store.signaturePlacementDocuments)
    store.signaturePlacementDocuments[key] = {
      filePath: recentFile.path,
      fileSize,
      modifiedAt,
      placements: sanitizedPlacements,
    }
    await saveStore(store)
    return sanitizedPlacements
  }),
)

ipcMain.handle('pdf:save-signed-copy', (_event, options) =>
  saveSignedPdf(options ?? {}),
)

ipcMain.handle(
  'pdf:save-fill-sign-fields',
  (_event, identity, fields) =>
  withStore(async (store) => {
    const recentFile = store.documentRegistry[identity?.id] ?? store.recentFiles.find((item) => item.id === identity?.id)
    const fileSize = Number(identity?.fileSize)
    const modifiedAt = Number(identity?.modifiedAt)
    if (
      !recentFile ||
      !Number.isFinite(fileSize) ||
      !Number.isFinite(modifiedAt) ||
      recentFile.fileSize !== fileSize ||
      recentFile.modifiedAt !== modifiedAt
    ) {
      throw new Error('The PDF identity changed. Reopen the document before saving Fill & Sign fields.')
    }

    const documentId = recentFile.id
    const sanitizedFields = Array.isArray(fields)
      ? fields
        .map((field) => sanitizeFillSignField({ ...field, documentId }, documentId))
        .filter(Boolean)
        .slice(0, 2000)
      : []
    const key = getHighlightDocumentKey(recentFile.path, fileSize, modifiedAt)
    store.fillSignDocuments = sanitizeFillSignDocuments(store.fillSignDocuments)
    store.fillSignDocuments[key] = {
      filePath: recentFile.path,
      fileSize,
      modifiedAt,
      fields: sanitizedFields,
    }
    await saveStore(store)
    return sanitizedFields
  }),
)

ipcMain.handle('highlights:library-list', () =>
  withStore(async (store) => {
    const removed = await pruneMissingHighlightDocuments(store)
    if (removed > 0) await saveStore(store)
    return getHighlightLibrary(store)
  }),
)

ipcMain.handle('highlights:open-document', async (_event, documentKey) => {
  const document = await withStore((store) => {
    const source = store.highlightDocuments[String(documentKey ?? '')]
    return source ? { ...source } : null
  })
  if (!document) throw new Error('The highlight source document is no longer indexed.')
  let stats
  try {
    stats = await fs.stat(document.filePath)
  } catch (error) {
    if (error.code === 'ENOENT') {
      await withStore(async (store) => {
        const source = store.highlightDocuments[String(documentKey ?? '')]
        const documentId = source?.filePath ? getDocumentId(source.filePath) : null
        if (documentId) {
          store.recentFiles = store.recentFiles.filter((item) => item.id !== documentId)
          const record = store.documentRegistry[documentId]
          if (record) record.missing = true
          await globalSearchIndex.removeDocument(documentId)
        }
        await saveStore(store)
      })
      throw new Error(`PDF no longer exists: ${path.basename(document.filePath)}`)
    }
    throw error
  }
  if (stats.size !== document.fileSize || stats.mtimeMs !== document.modifiedAt) {
    throw new Error('The source PDF has changed since these highlights were created.')
  }
  return loadPdf(document.filePath)
})

ipcMain.handle('highlights:library-update', (_event, updates) =>
  withStore(async (store) => {
    const requested = Array.isArray(updates) ? updates.slice(0, 10000) : []
    const modifiedDate = new Date().toISOString()
    const updatesByDocument = new Map()
    for (const update of requested) {
      const documentKey = String(update?.documentKey ?? '')
      const highlightId = String(update?.highlightId ?? '')
      if (!documentKey || !highlightId) continue
      const documentUpdates = updatesByDocument.get(documentKey) ?? new Map()
      documentUpdates.set(highlightId, update.patch && typeof update.patch === 'object' ? update.patch : {})
      updatesByDocument.set(documentKey, documentUpdates)
    }
    for (const [documentKey, documentUpdates] of updatesByDocument) {
      const document = store.highlightDocuments[documentKey]
      if (!document || !Array.isArray(document.highlights)) continue
      const previousHighlights = document.highlights
      document.highlights = document.highlights.map((candidate) => {
        const highlight = sanitizeHighlight(candidate)
        const patch = highlight ? documentUpdates.get(highlight.id) : null
        if (!highlight || !patch) return candidate
        const next = {
          ...highlight,
          note: typeof patch.note === 'string' ? patch.note : highlight.note,
          category: ['important', 'research', 'reference', 'question'].includes(patch.category)
            ? patch.category
            : highlight.category,
          color: ['yellow', 'green', 'blue', 'purple'].includes(patch.color)
            ? patch.color
            : highlight.color,
          modifiedDate,
        }
        return sanitizeHighlight(next) ?? highlight
      })
      updateHighlightDocumentIndex(store, documentKey, previousHighlights, document)
      const noteUpdates = [...documentUpdates.values()].filter((patch) => typeof patch.note === 'string').length
      if (noteUpdates) {
        addActivityForDocumentWorkspaces(
          store,
          getDocumentId(document.filePath),
          'note-added',
          `Updated ${noteUpdates} note${noteUpdates === 1 ? '' : 's'}`,
          { count: noteUpdates },
        )
      }
    }
    const library = getHighlightLibrary(store)
    await saveStore(store)
    await Promise.all([...updatesByDocument.keys()].map((documentKey) => {
      const document = store.highlightDocuments[documentKey]
      if (!document) return Promise.resolve()
      const documentId = getDocumentId(document.filePath)
      const record = store.documentRegistry[documentId]
      return record
        ? globalSearchIndex.updateHighlights(record, documentKey, document.highlights)
        : Promise.resolve()
    }))
    return library
  }),
)

ipcMain.handle('highlights:library-delete', (_event, keys) =>
  withStore(async (store) => {
    const requested = new Set(Array.isArray(keys) ? keys.slice(0, 10000).map(String) : [])
    const documentKeys = new Set(
      [...requested].map((key) => store.highlightLibraryIndex[key]?.documentKey).filter(Boolean),
    )
    for (const documentKey of documentKeys) {
      const document = store.highlightDocuments[documentKey]
      if (!Array.isArray(document?.highlights)) continue
      const removedCount = document.highlights.filter(
        (highlight) => requested.has(`${documentKey}:${highlight.id}`),
      ).length
      document.highlights = document.highlights.filter(
        (highlight) => !requested.has(`${documentKey}:${highlight.id}`),
      )
      if (removedCount) addActivityForDocumentWorkspaces(store, getDocumentId(document.filePath), 'highlight-deleted', `Deleted ${removedCount} highlight${removedCount === 1 ? '' : 's'}`, { count: removedCount })
    }
    for (const key of requested) delete store.highlightLibraryIndex[key]
    const library = getHighlightLibrary(store)
    await saveStore(store)
    await Promise.all([...documentKeys].map((documentKey) => {
      const document = store.highlightDocuments[documentKey]
      if (!document) return Promise.resolve()
      const documentId = getDocumentId(document.filePath)
      const record = store.documentRegistry[documentId]
      return record
        ? globalSearchIndex.updateHighlights(record, documentKey, document.highlights)
        : Promise.resolve()
    }))
    return library
  }),
)

ipcMain.handle('highlights:library-export', async (_event, options) => {
  const format = ['markdown', 'text', 'docx'].includes(options?.format) ? options.format : null
  const keys = new Set(Array.isArray(options?.keys) ? options.keys.slice(0, 10000).map(String) : [])
  const entries = await withStore((store) =>
    getHighlightLibrary(store).entries.filter((entry) => keys.has(entry.key)),
  )
  if (!format || entries.length === 0) {
    throw new Error('Select at least one highlight to export.')
  }
  const extension = format === 'markdown' ? 'md' : format === 'text' ? 'txt' : 'docx'
  const result = await dialog.showSaveDialog(mainWindow ?? undefined, {
    title: 'Export Global Highlights',
    defaultPath: `next-pdf-viewer-highlights.${extension}`,
    filters: [{
      name: format === 'markdown' ? 'Markdown' : format === 'text' ? 'Plain Text' : 'Word Document',
      extensions: [extension],
    }],
  })
  if (result.canceled || !result.filePath) return null
  const exportedAt = new Date()
  const output = format === 'markdown'
    ? buildLibraryMarkdown(entries, exportedAt)
    : format === 'text'
      ? buildLibraryText(entries, exportedAt)
      : buildLibraryDocx(entries, exportedAt)
  await fs.writeFile(result.filePath, output)
  return result.filePath
})

ipcMain.handle('search:index-status', (_event, identity) =>
  globalSearchIndex.getDocumentStatus(identity),
)

ipcMain.handle('search:index-start', async (_event, payload) => {
  const record = await withStore((store) => store.documentRegistry[payload?.id] ?? null)
  if (
    !record ||
    record.fileSize !== Number(payload?.fileSize) ||
    record.modifiedAt !== Number(payload?.modifiedAt)
  ) {
    throw new Error('The PDF changed before search indexing could start.')
  }
  return globalSearchIndex.startDocument({
    ...payload,
    name: record.name,
    filePath: record.path,
  })
})

ipcMain.handle('search:index-pages', (_event, documentId, pages) =>
  globalSearchIndex.appendPages(documentId, pages),
)

ipcMain.handle('search:index-complete', (_event, documentId) =>
  globalSearchIndex.completeDocument(documentId),
)

ipcMain.handle('search:index-cancel', (_event, documentId) =>
  globalSearchIndex.cancelDocument(documentId),
)

ipcMain.handle('search:query', async (_event, request) => {
  const filters = { ...request?.filters }
  if (filters.scope !== 'all') {
    filters.documentIds = await withStore((store) => [...getActiveWorkspaceProject(store).documentIds])
  }
  return globalSearchIndex.search({ ...request, filters })
})
ipcMain.handle('search:library-info', async () => {
  const [info, workspace] = await Promise.all([
    globalSearchIndex.getLibraryInfo(),
    withStore((store) => {
      const active = getActiveWorkspaceProject(store)
      return { id: active.id, name: active.name, documentIds: active.documentIds }
    }),
  ])
  return {
    ...info,
    savedSearches: info.savedSearches.filter((search) => search.workspaceId === workspace.id),
    activeWorkspace: workspace,
  }
})
ipcMain.handle('search:record-history', (_event, query) => globalSearchIndex.recordSearch(query))
ipcMain.handle('search:clear-history', () => globalSearchIndex.clearHistory())
ipcMain.handle('search:save', async (_event, search) => {
  const workspace = await withStore((store) => ({
    id: getActiveWorkspaceProject(store).id,
    name: getActiveWorkspaceProject(store).name,
  }))
  const saved = await globalSearchIndex.saveSearch({ ...search, workspaceId: workspace.id })
  await withStore(async (store) => {
    const active = getActiveWorkspaceProject(store)
    addWorkspaceActivity(active, 'search-saved', `Saved search: ${String(search?.name ?? search?.query ?? '').slice(0, 120)}`)
    await saveStore(store)
  })
  return saved.filter((item) => item.workspaceId === workspace.id)
})
ipcMain.handle('search:delete-saved', (_event, id) => globalSearchIndex.deleteSavedSearch(id))

ipcMain.handle('pdf:export-highlights', async (_event, options) => {
  const format = ['markdown', 'text', 'docx'].includes(options?.format)
    ? options.format
    : null
  const requestedIds = new Set(
    Array.isArray(options?.highlights)
      ? options.highlights.slice(0, 10000).map((highlight) => String(highlight?.id ?? ''))
      : [],
  )
  const { document: recentFile, highlights } = await withStore((store) => {
    const document = store.documentRegistry[options?.id] ?? store.recentFiles.find((item) => item.id === options?.id)
    const storedHighlights = document
      ? getStoredHighlights(store, document.path, document.fileSize, document.modifiedAt)
      : []
    return {
      document,
      highlights: storedHighlights.filter((highlight) => requestedIds.has(highlight.id)),
    }
  })
  if (!format || !recentFile || highlights.length === 0) {
    throw new Error('Select at least one valid highlight to export.')
  }

  const extension = format === 'markdown' ? 'md' : format === 'text' ? 'txt' : 'docx'
  const baseName = path.basename(recentFile.name, path.extname(recentFile.name))
  const result = await dialog.showSaveDialog(mainWindow ?? undefined, {
    title: 'Export Highlights',
    defaultPath: `${baseName}-highlights.${extension}`,
    filters: [
      {
        name: format === 'markdown' ? 'Markdown' : format === 'text' ? 'Plain Text' : 'Word Document',
        extensions: [extension],
      },
    ],
  })
  if (result.canceled || !result.filePath) {
    return null
  }

  const exportedAt = new Date()
  const output =
    format === 'markdown'
      ? buildHighlightsMarkdown(recentFile.name, highlights, exportedAt)
      : format === 'text'
        ? buildHighlightsText(recentFile.name, highlights, exportedAt)
        : buildHighlightsDocx(recentFile.name, highlights, exportedAt)
  await fs.writeFile(result.filePath, output)
  return result.filePath
})

ipcMain.handle('pdf:print', async (_event, id) => {
  const recentFile = await withStore((store) =>
    store.documentRegistry[id] ?? store.recentFiles.find((item) => item.id === id),
  )
  if (!recentFile) {
    throw new Error('The current PDF is no longer available for printing.')
  }

  return printPdf(recentFile.path)
})

ipcMain.handle('pdf:export-page', async (_event, { data, format, defaultName }) => {
  if (!['png', 'jpeg'].includes(format) || !(data instanceof Uint8Array)) {
    throw new Error('Invalid page export data.')
  }

  const extension = format === 'jpeg' ? 'jpg' : 'png'
  const safeName = path.basename(String(defaultName || `page.${extension}`))
  const result = await dialog.showSaveDialog(mainWindow ?? undefined, {
    title: `Export Page as ${format === 'jpeg' ? 'JPEG' : 'PNG'}`,
    defaultPath: safeName.toLowerCase().endsWith(`.${extension}`)
      ? safeName
      : `${safeName}.${extension}`,
    filters: [
      {
        name: format === 'jpeg' ? 'JPEG Image' : 'PNG Image',
        extensions: [extension],
      },
    ],
  })

  if (result.canceled || !result.filePath) {
    return null
  }

  await fs.writeFile(result.filePath, data)
  return result.filePath
})

ipcMain.handle('signatures:list', () =>
  withStore((store) => listSignatures(store)),
)

ipcMain.handle('signatures:pick-image', () =>
  pickSignatureImage(),
)

ipcMain.handle('signatures:create', (_event, payload) =>
  withStore(async (store) => {
    const signature = createSignatureRecord(payload)
    store.signatureLibrary = sanitizeSignatureLibrary(store.signatureLibrary)
    if (!store.signatureLibrary.items.length) signature.isDefault = true
    store.signatureLibrary.items.unshift(signature)
    await saveStore(store)
    return listSignatures(store)
  }),
)

ipcMain.handle('signatures:update', (_event, id, patch) =>
  withStore(async (store) => {
    store.signatureLibrary = sanitizeSignatureLibrary(store.signatureLibrary)
    const signature = store.signatureLibrary.items.find((item) => item.id === String(id ?? ''))
    if (!signature) throw new Error('Signature no longer exists.')
    if (typeof patch?.name === 'string') signature.name = patch.name.trim().slice(0, 120) || signature.name
    signature.updatedAt = new Date().toISOString()
    await saveStore(store)
    return listSignatures(store)
  }),
)

ipcMain.handle('signatures:delete', (_event, id) =>
  withStore(async (store) => {
    store.signatureLibrary = sanitizeSignatureLibrary(store.signatureLibrary)
    const signatureId = String(id ?? '')
    const wasDefault = store.signatureLibrary.items.some((item) => item.id === signatureId && item.isDefault)
    store.signatureLibrary.items = store.signatureLibrary.items.filter((item) => item.id !== signatureId)
    if (wasDefault && store.signatureLibrary.items[0]) store.signatureLibrary.items[0].isDefault = true
    await saveStore(store)
    return listSignatures(store)
  }),
)

ipcMain.handle('signatures:duplicate', (_event, id) =>
  withStore(async (store) => {
    store.signatureLibrary = sanitizeSignatureLibrary(store.signatureLibrary)
    const source = store.signatureLibrary.items.find((item) => item.id === String(id ?? ''))
    if (!source) throw new Error('Signature no longer exists.')
    const now = new Date().toISOString()
    store.signatureLibrary.items.unshift({
      ...source,
      id: randomUUID(),
      name: `${source.name} Copy`.slice(0, 120),
      createdAt: now,
      updatedAt: now,
      isDefault: false,
    })
    await saveStore(store)
    return listSignatures(store)
  }),
)

ipcMain.handle('signatures:set-default', (_event, id) =>
  withStore(async (store) => {
    store.signatureLibrary = sanitizeSignatureLibrary(store.signatureLibrary)
    const signatureId = String(id ?? '')
    if (!store.signatureLibrary.items.some((item) => item.id === signatureId)) throw new Error('Signature no longer exists.')
    for (const item of store.signatureLibrary.items) {
      item.isDefault = item.id === signatureId
      if (item.isDefault) item.updatedAt = new Date().toISOString()
    }
    await saveStore(store)
    return listSignatures(store)
  }),
)

ipcMain.handle('preferences:get-sidebar-tab', () =>
  withStore((store) => store.preferences.sidebarTab),
)

ipcMain.handle('preferences:set-sidebar-tab', (_event, sidebarTab) =>
  withStore(async (store) => {
    store.preferences.sidebarTab = ['thumbnails', 'bookmarks', 'highlights', 'info'].includes(sidebarTab)
      ? sidebarTab
      : 'thumbnails'
    await saveStore(store)
  }),
)

ipcMain.handle('preferences:get-view-mode', () =>
  withStore((store) => store.preferences.viewMode),
)

ipcMain.handle('preferences:set-view-mode', (_event, viewMode) =>
  withStore(async (store) => {
    store.preferences.viewMode = viewMode === 'single' ? 'single' : 'continuous'
    await saveStore(store)
  }),
)

ipcMain.handle('preferences:get-viewer-background', () =>
  withStore((store) => store.preferences.viewerBackground),
)

ipcMain.handle('preferences:set-viewer-background', (_event, viewerBackground) =>
  withStore(async (store) => {
    store.preferences.viewerBackground = ['dark-gray', 'black', 'light-gray', 'white'].includes(
      viewerBackground,
    )
      ? viewerBackground
      : 'dark-gray'
    await saveStore(store)
  }),
)

ipcMain.handle('preferences:get-sidebar-layout', () =>
  withStore((store) => ({
    width: store.preferences.sidebarWidth,
    collapsed: store.preferences.sidebarCollapsed,
  })),
)

ipcMain.handle('preferences:set-sidebar-layout', (_event, sidebarLayout) =>
  withStore(async (store) => {
    store.preferences.sidebarWidth = Math.min(
      400,
      Math.max(220, Number(sidebarLayout?.width) || 280),
    )
    store.preferences.sidebarCollapsed = sidebarLayout?.collapsed === true
    await saveStore(store)
  }),
)

ipcMain.handle('preferences:get-pdf-open-destination', () =>
  withStore((store) => sanitizePdfOpenDestination(store.preferences.defaultPdfOpenDestination)),
)

ipcMain.handle('preferences:set-pdf-open-destination', (_event, destination) =>
  withStore(async (store) => {
    store.preferences.defaultPdfOpenDestination = sanitizePdfOpenDestination(destination)
    await saveStore(store)
    return store.preferences.defaultPdfOpenDestination
  }),
)

ipcMain.handle('window:get-fullscreen', (event) =>
  BrowserWindow.fromWebContents(event.sender)?.isFullScreen() ?? false,
)

ipcMain.handle('window:toggle-fullscreen', (event) => {
  const window = BrowserWindow.fromWebContents(event.sender)
  if (!window) {
    throw new Error('The application window is unavailable.')
  }

  window.setFullScreen(!window.isFullScreen())
  return window.isFullScreen()
})

ipcMain.handle('window:exit-fullscreen', (event) => {
  const window = BrowserWindow.fromWebContents(event.sender)
  if (window?.isFullScreen()) {
    window.setFullScreen(false)
  }
  return false
})

ipcMain.handle('performance:get-memory', async () => {
  const mainProcessMemory = await process.getProcessMemoryInfo()
  const processes = app.getAppMetrics().map((metric) => ({
    type: metric.type,
    workingSetMb: Math.round(metric.memory.workingSetSize / 1024),
    peakWorkingSetMb: Math.round(metric.memory.peakWorkingSetSize / 1024),
    privateMb: Math.round(metric.memory.privateBytes / 1024),
  }))

  return {
    mainWorkingSetMb: Math.round(mainProcessMemory.residentSet / 1024),
    totalWorkingSetMb: processes.reduce((total, metric) => total + metric.workingSetMb, 0),
    totalPrivateMb: processes.reduce((total, metric) => total + metric.privateMb, 0),
    processes,
  }
})

if (hasSingleInstanceLock) {
  const startupPdfPath = getPdfPathFromArguments(process.argv)
  if (startupPdfPath) {
    pendingSystemPdfPaths.push(startupPdfPath)
  }

  app.on('second-instance', (_event, commandLine, workingDirectory) => {
    enqueueSystemPdf(getPdfPathFromArguments(commandLine, workingDirectory))
    void showAndFocusMainWindow()
  })

  app.on('open-file', (event, filePath) => {
    event.preventDefault()
    if (path.extname(filePath).toLowerCase() === '.pdf') {
      enqueueSystemPdf(path.normalize(filePath))
      void showAndFocusMainWindow()
    }
  })

  app.whenReady().then(async () => {
    await createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        void createWindow()
      } else {
        void showAndFocusMainWindow()
      }
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
