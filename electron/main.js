import { app, BrowserWindow, dialog, nativeImage, Notification, Tray } from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { startServer } from '../server/index.js'
import { createNotificationWatcher } from '../server/notifications.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Reference to the embedded Node server ({ server, port, url, core, close }).
let embeddedServer = null
let mainWindow = null
let tray = null

// The brand's pixel building as a menu-bar template image (black + alpha, so
// macOS recolors it for light/dark menu bars), pre-rendered at 1x and 2x.
// Regenerate with a scaled copy of public/index.html's #brand-logo grid if the
// logo ever changes.
const TRAY_ICON_1X =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAKUlEQVR42mNgoCH4j4Zpb8B/EjHtDEDm42LT1oBRLww2LxAjRz0DyAIA6wRvkSQi68cAAAAASUVORK5CYII='
const TRAY_ICON_2X =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAARElEQVR42mNgGAWkg/8E8KgDhr4D/tMYjzpg6DkAlzyp4qMOGLoOGM0Fo2lg1AGjuWA0DYw6gNjERPdcMOoAmjlgZAEAkhW+UA2E3aIAAAAASUVORK5CYII='

function createTrayIcon() {
  const icon = nativeImage.createEmpty()
  icon.addRepresentation({ scaleFactor: 1, dataURL: TRAY_ICON_1X })
  icon.addRepresentation({ scaleFactor: 2, dataURL: TRAY_ICON_2X })
  icon.setTemplateImage(true)
  return icon
}

function focusMainWindow() {
  if (mainWindow === null) {
    createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

// Menu-bar presence and native notifications for the moments the office needs
// the human (a session waiting for an answer or stuck on a tool call, a
// review-needed report). Only wired when this process owns a core — when the
// app merely attached to an already-running standalone server, that server's
// own osascript delivery covers notifications and a second set here would
// duplicate them. Known limitation: a standalone server forced onto another
// port (PORT=...) next to this app runs a second core, and both then notify —
// the loop-ownership guard covers the resident tick loop only.
function startNotifications(core) {
  tray = new Tray(createTrayIcon())
  tray.setToolTip('AI Office')
  tray.on('click', focusMainWindow)
  createNotificationWatcher({
    subscribe: core.subscribe,
    notify: ({ title, body }) => {
      if (!Notification.isSupported()) return
      const notification = new Notification({ title, body })
      notification.on('click', focusMainWindow)
      notification.show()
    },
    updateBadge: (count) => {
      const label = count > 0 ? String(count) : ''
      tray.setTitle(label)
      if (app.dock) app.dock.setBadge(label)
    }
  })
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 760,
    title: app.name,
    backgroundColor: '#1a1b26',
    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.loadURL(embeddedServer.url)
}

// Start the embedded server, waiting until it actually listens before the
// window loads its URL (avoids an ERR_CONNECTION_REFUSED race). If the default
// port is already taken — e.g. a standalone `npm start` is running — attach a
// window to that server instead of starting a second core: two cores over the
// same data directory means two tick loops, which double-run board cards and
// clobber each other's session-registry bindings.
async function startEmbeddedServer() {
  const handle = startServer()
  try {
    await handle.ready
    return handle
  } catch (error) {
    const url = handle.url
    handle.close()
    if (error && error.code !== 'EADDRINUSE') throw error
    const probe = await fetch(`${url}/api/board`).catch(() => null)
    if (probe === null || !probe.ok) throw error // port holder is not ai-office
    console.log(`[ai-office] attaching to the already-running server at ${url}`)
    return { url, close() {} }
  }
}

// One desktop instance at a time: a second launch focuses the existing
// window instead of spawning another full app over the same data directory.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(async () => {
    try {
      embeddedServer = await startEmbeddedServer()
    } catch (error) {
      dialog.showErrorBox('AI Office', `Failed to start the server:\n${error.message}`)
      app.quit()
      return
    }
    createWindow()
    if (embeddedServer.core) startNotifications(embeddedServer.core)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow()
      }
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// Stop the embedded server and its watchers cleanly before the process exits.
app.on('before-quit', () => {
  if (embeddedServer) {
    embeddedServer.close()
    embeddedServer = null
  }
})
