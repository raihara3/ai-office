import { app, BrowserWindow, dialog } from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { startServer } from '../server/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Reference to the embedded Node server ({ server, port, url, core, close }).
let embeddedServer = null
let mainWindow = null

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
// port is already taken — e.g. a standalone `npm start` is running — fall back
// to an arbitrary free port so the desktop app still opens.
async function startEmbeddedServer() {
  let handle = startServer()
  try {
    await handle.ready
  } catch (error) {
    if (error && error.code === 'EADDRINUSE') {
      handle.close()
      handle = startServer({ port: 0 })
      await handle.ready
    } else {
      throw error
    }
  }
  return handle
}

app.whenReady().then(async () => {
  try {
    embeddedServer = await startEmbeddedServer()
  } catch (error) {
    dialog.showErrorBox('AI Office', `Failed to start the server:\n${error.message}`)
    app.quit()
    return
  }
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

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
