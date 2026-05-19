const { app, BrowserWindow, shell } = require('electron');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');

const MIME_TYPES = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp'
};

const STATIC_PORT = 38765;
const DEFAULT_WINDOW_BOUNDS = {
    width: 1365,
    height: 820
};

let mainWindow = null;
let staticServer = null;
let windowStateSaveTimer = null;

function getAssetRoot() {
    return path.join(app.getAppPath(), 'app', 'src', 'main', 'assets');
}

function getWindowIconPath() {
    return path.join(app.getAppPath(), 'electron', 'assets', 'bitcoin-logo.ico');
}

function getWindowStatePath() {
    return path.join(app.getPath('userData'), 'window-state.json');
}

async function readWindowState() {
    try {
        const stateFile = await fs.readFile(getWindowStatePath(), 'utf8');
        const parsedState = JSON.parse(stateFile);

        return {
            width: Math.max(parsedState.width || DEFAULT_WINDOW_BOUNDS.width, 1100),
            height: Math.max(parsedState.height || DEFAULT_WINDOW_BOUNDS.height, 650),
            x: Number.isFinite(parsedState.x) ? parsedState.x : undefined,
            y: Number.isFinite(parsedState.y) ? parsedState.y : undefined,
            maximized: parsedState.maximized === true
        };
    } catch (error) {
        return {
            ...DEFAULT_WINDOW_BOUNDS,
            x: undefined,
            y: undefined,
            maximized: false
        };
    }
}

async function writeWindowState(window) {
    if (!window || window.isDestroyed()) {
        return;
    }

    const bounds = window.getBounds();
    const state = {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        maximized: window.isMaximized()
    };

    try {
        await fs.writeFile(getWindowStatePath(), JSON.stringify(state, null, 2));
    } catch (error) {
        console.error('Saving window state failed:', error);
    }
}

function scheduleWindowStateSave(window) {
    if (windowStateSaveTimer) {
        clearTimeout(windowStateSaveTimer);
    }

    windowStateSaveTimer = setTimeout(() => {
        writeWindowState(window).catch(error => {
            console.error('Persisting window state failed:', error);
        });
    }, 200);
}

function getMimeType(filePath) {
    return MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

async function serveAsset(requestPath, response) {
    const assetRoot = getAssetRoot();
    const parsedUrl = new URL(requestPath || '/', 'http://127.0.0.1');
    const pathname = parsedUrl.pathname === '/' ? '/clock.html' : decodeURIComponent(parsedUrl.pathname);
    const normalizedPath = path.normalize(path.join(assetRoot, pathname));

    if (!normalizedPath.startsWith(assetRoot)) {
        response.writeHead(403);
        response.end('Forbidden');
        return;
    }

    try {
        const fileContents = await fs.readFile(normalizedPath);
        response.writeHead(200, {
            'Content-Type': getMimeType(normalizedPath),
            'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
            'Pragma': 'no-cache',
            'Expires': '0'
        });
        response.end(fileContents);
    } catch (error) {
        if (error.code === 'ENOENT') {
            response.writeHead(404);
            response.end('Not found');
            return;
        }

        console.error('Serving asset failed:', error);
        response.writeHead(500);
        response.end('Internal server error');
    }
}

async function startStaticServer() {
    if (staticServer) {
        return staticServer;
    }

    staticServer = await new Promise((resolve, reject) => {
        const server = http.createServer((request, response) => {
            serveAsset(request.url || '/', response).catch(error => {
                console.error('Unexpected asset handler failure:', error);
                response.writeHead(500);
                response.end('Internal server error');
            });
        });

        server.once('error', reject);
        server.listen(STATIC_PORT, '127.0.0.1', () => resolve(server));
    });

    return staticServer;
}

function getClockUrl(server) {
    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('Static server did not expose a TCP port.');
    }

    return `http://127.0.0.1:${address.port}/clock.html?v=${Date.now()}`;
}

async function createMainWindow() {
    const server = await startStaticServer();
    const windowState = await readWindowState();

    mainWindow = new BrowserWindow({
        width: windowState.width,
        height: windowState.height,
        x: windowState.x,
        y: windowState.y,
        minWidth: 1100,
        minHeight: 650,
        autoHideMenuBar: true,
        backgroundColor: '#101418',
        icon: getWindowIconPath(),
        show: false,
        title: 'Bitcoin Block Clock',
        webPreferences: {
            contextIsolation: true,
            sandbox: true
        }
    });

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url).catch(error => {
            console.error('Opening external URL failed:', error);
        });

        return { action: 'deny' };
    });

    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
        if (windowState.maximized) {
            mainWindow.maximize();
        }
    });

    mainWindow.on('resize', () => {
        if (!mainWindow.isMaximized()) {
            scheduleWindowStateSave(mainWindow);
        }
    });

    mainWindow.on('move', () => {
        if (!mainWindow.isMaximized()) {
            scheduleWindowStateSave(mainWindow);
        }
    });

    mainWindow.on('maximize', () => {
        scheduleWindowStateSave(mainWindow);
    });

    mainWindow.on('unmaximize', () => {
        scheduleWindowStateSave(mainWindow);
    });

    mainWindow.on('close', () => {
        if (windowStateSaveTimer) {
            clearTimeout(windowStateSaveTimer);
            windowStateSaveTimer = null;
        }
        writeWindowState(mainWindow).catch(error => {
            console.error('Saving window state during close failed:', error);
        });
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });

    await mainWindow.loadURL(getClockUrl(server));
}

async function closeStaticServer() {
    if (!staticServer) {
        return;
    }

    await new Promise((resolve, reject) => {
        staticServer.close(error => {
            if (error) {
                reject(error);
                return;
            }

            resolve();
        });
    }).catch(error => {
        console.error('Closing static server failed:', error);
    });

    staticServer = null;
}

app.setAppUserModelId('com.bitcoinblockclock.desktop');

app.whenReady().then(async () => {
    await createMainWindow();

    app.on('activate', async () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            await createMainWindow();
        }
    });
}).catch(error => {
    console.error('Launching Electron app failed:', error);
    app.quit();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('before-quit', event => {
    if (staticServer) {
        event.preventDefault();
        closeStaticServer().finally(() => {
            app.exit();
        });
    }
});
