import { app, BrowserWindow, dialog, ipcMain, screen } from 'electron'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

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

let mainWindow = null
let storeCache = null
let storeOperation = Promise.resolve()
let rendererReady = false
let processingSystemPdf = false
const pendingSystemPdfPaths = []
const hasSingleInstanceLock = app.requestSingleInstanceLock()

if (!hasSingleInstanceLock) {
  app.quit()
}

function emptyStore() {
  return {
    recentFiles: [],
    documentStates: {},
    preferences: {
      sidebarTab: 'thumbnails',
      viewMode: 'continuous',
      viewerBackground: 'dark-gray',
      sidebarWidth: 280,
      sidebarCollapsed: false,
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
      documentStates:
        parsed.documentStates && typeof parsed.documentStates === 'object'
          ? parsed.documentStates
          : {},
      preferences: {
        sidebarTab: ['thumbnails', 'bookmarks', 'info'].includes(parsed.preferences?.sidebarTab)
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
      },
      windowState: sanitizeWindowState(parsed.windowState),
    }
  } catch (error) {
    if (error.code !== 'ENOENT' && error.name !== 'SyntaxError') {
      throw error
    }
    storeCache = emptyStore()
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
  await fs.writeFile(getStorePath(), JSON.stringify(store, null, 2), 'utf8')
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

async function loadPdf(filePath) {
  const buffer = await fs.readFile(filePath)
  const id = getDocumentId(filePath)
  const name = path.basename(filePath)

  return withStore(async (store) => {
    store.recentFiles = [
      { id, name, path: filePath, openedAt: Date.now() },
      ...store.recentFiles.filter((item) => item.id !== id),
    ].slice(0, 20)
    await saveStore(store)

    return {
      id,
      name,
      filePath,
      fileSize: buffer.byteLength,
      dataUrl: `data:application/pdf;base64,${buffer.toString('base64')}`,
      readingState: sanitizeReadingState(store.documentStates[id]),
    }
  })
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

ipcMain.handle('pdf:recent-list', () =>
  withStore((store) =>
    store.recentFiles.map(({ id, name }) => ({ id, name })),
  ),
)

ipcMain.handle('pdf:open-recent', (_event, id) =>
  withStore(async (store) => {
    const recentFile = store.recentFiles.find((item) => item.id === id)
    if (!recentFile) {
      throw new Error('This recent PDF is no longer available.')
    }

    try {
      const buffer = await fs.readFile(recentFile.path)
      recentFile.openedAt = Date.now()
      store.recentFiles = [
        recentFile,
        ...store.recentFiles.filter((item) => item.id !== id),
      ].slice(0, 20)
      await saveStore(store)

      return {
        id: recentFile.id,
        name: recentFile.name,
        filePath: recentFile.path,
        fileSize: buffer.byteLength,
        dataUrl: `data:application/pdf;base64,${buffer.toString('base64')}`,
        readingState: sanitizeReadingState(store.documentStates[id]),
      }
    } catch (error) {
      if (error.code === 'ENOENT') {
        store.recentFiles = store.recentFiles.filter((item) => item.id !== id)
        delete store.documentStates[id]
        await saveStore(store)
        throw new Error(`PDF no longer exists: ${recentFile.name}`)
      }
      throw error
    }
  }),
)

ipcMain.handle('pdf:save-state', (_event, id, state) =>
  withStore(async (store) => {
    if (!store.recentFiles.some((item) => item.id === id)) {
      return
    }

    const readingState = sanitizeReadingState(state)
    console.debug('Saved page:', readingState.page)
    store.documentStates[id] = readingState
    await saveStore(store)
  }),
)

ipcMain.handle('pdf:print', async (_event, id) => {
  const recentFile = await withStore((store) =>
    store.recentFiles.find((item) => item.id === id),
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

ipcMain.handle('preferences:get-sidebar-tab', () =>
  withStore((store) => store.preferences.sidebarTab),
)

ipcMain.handle('preferences:set-sidebar-tab', (_event, sidebarTab) =>
  withStore(async (store) => {
    store.preferences.sidebarTab = ['thumbnails', 'bookmarks', 'info'].includes(sidebarTab)
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
