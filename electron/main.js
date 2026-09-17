const { app, BrowserWindow, shell, Tray, Menu } = require('electron');
const { PriceMonitor, fileStore } = require('./price-monitor');
const { TrayAttention } = require('./tray-attention');
const { execFileSync } = require('node:child_process');
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
const START_HIDDEN_ARG = 'start-hidden';
const LOGIN_ITEM_NAME = 'com.bitcoinblockclock.desktop';
const WINDOWS_RUN_REGISTRY_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const WINDOWS_TRAY_GUID = '8f20d7c4-2295-46a0-94a1-9d920b5f4f3a';
const DEFAULT_WINDOW_BOUNDS = {
    width: 1365,
    height: 820
};

let mainWindow = null;
let tray = null;
let staticServer = null;
let windowStateSaveTimer = null;
let isQuitting = false;
let shouldMaximizeOnShow = false;
let priceMonitor = null;
let trayAttention = null;
const verificationArg = process.argv.find(arg => arg.startsWith('--verify-price-alerts='));
const verificationDirectory = verificationArg ? path.resolve(verificationArg.slice('--verify-price-alerts='.length)) : null;

function getAssetRoot() {
    return path.join(app.getAppPath(), 'app', 'src', 'main', 'assets');
}

function getWindowIconPath() {
    return path.join(app.getAppPath(), 'electron', 'assets', 'bitcoin-logo.ico');
}

function getTrayIconPath() {
    if (!trayAttention?.alert) return getWindowIconPath();
    return path.join(app.getAppPath(), 'electron', 'assets', process.platform === 'win32' ? 'bitcoin-alert.ico' : 'bitcoin-alert.png');
}

function acknowledgeTrayAttention() {
    trayAttention?.acknowledge().catch(error => console.error('Acknowledging price alert failed:', error));
}

function updateTrayAttention() {
    if (!tray) return;
    tray.setImage(getTrayIconPath());
    tray.setToolTip(trayAttention.tooltip());
    updateTrayMenu();
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

function flushWindowState(window) {
    if (windowStateSaveTimer) {
        clearTimeout(windowStateSaveTimer);
        windowStateSaveTimer = null;
    }

    return writeWindowState(window);
}

function showMainWindow() {
    if (!mainWindow || mainWindow.isDestroyed()) {
        createMainWindow().catch(error => {
            console.error('Restoring window from tray failed:', error);
        });
        return;
    }

    if (mainWindow.isMinimized()) {
        mainWindow.restore();
    }

    mainWindow.show();
    mainWindow.setSkipTaskbar(false);

    if (shouldMaximizeOnShow) {
        shouldMaximizeOnShow = false;
        mainWindow.maximize();
    }

    mainWindow.focus();
    acknowledgeTrayAttention();
}

function hideMainWindowToTray() {
    if (!mainWindow || mainWindow.isDestroyed()) {
        return;
    }

    flushWindowState(mainWindow).catch(error => {
        console.error('Saving window state before hiding to tray failed:', error);
    });

    mainWindow.setSkipTaskbar(true);
    mainWindow.hide();
}

function toggleMainWindowFromTray() {
    if (trayAttention?.alert || !mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible() || mainWindow.isMinimized()) {
        showMainWindow();
        return;
    }

    hideMainWindowToTray();
}

function quitFromTray() {
    isQuitting = true;
    app.quit();
}

function shouldStartHidden() {
    return process.argv.includes(START_HIDDEN_ARG)
        || process.argv.includes('--hidden')
        || process.argv.includes('--start-minimized');
}

function getLoginItemOptions() {
    const args = [START_HIDDEN_ARG];

    if (!app.isPackaged) {
        args.unshift(app.getAppPath());
    }

    return {
        name: LOGIN_ITEM_NAME,
        path: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath,
        args
    };
}

function hasEnabledNamedLoginItem(settings) {
    return Array.isArray(settings.launchItems)
        && settings.launchItems.some(item => item.name === LOGIN_ITEM_NAME && item.enabled !== false);
}

function splitWindowsCommandLine(commandLine) {
    const args = [];
    let currentArg = '';
    let inQuotes = false;

    for (const character of commandLine.trim()) {
        if (character === '"') {
            inQuotes = !inQuotes;
            continue;
        }

        if (/\s/.test(character) && !inQuotes) {
            if (currentArg) {
                args.push(currentArg);
                currentArg = '';
            }
            continue;
        }

        currentArg += character;
    }

    if (currentArg) {
        args.push(currentArg);
    }

    return args;
}

function readRegisteredWindowsLoginItem() {
    try {
        const output = execFileSync('reg.exe', [
            'query',
            WINDOWS_RUN_REGISTRY_KEY,
            '/v',
            LOGIN_ITEM_NAME
        ], {
            encoding: 'utf8',
            windowsHide: true
        });

        const registryLine = output
            .split(/\r?\n/)
            .find(line => line.trim().startsWith(LOGIN_ITEM_NAME));

        if (!registryLine) {
            return null;
        }

        const value = registryLine.replace(/^\s*\S+\s+REG_\S+\s+/, '').trim();
        const [registeredPath, ...registeredArgs] = splitWindowsCommandLine(value);

        if (!registeredPath) {
            return null;
        }

        return {
            path: registeredPath,
            args: registeredArgs
        };
    } catch (error) {
        return null;
    }
}

function loginItemOptionsMatch(firstOptions, secondOptions) {
    if (!firstOptions || !secondOptions || firstOptions.path !== secondOptions.path) {
        return false;
    }

    const firstArgs = firstOptions.args || [];
    const secondArgs = secondOptions.args || [];

    return firstArgs.length === secondArgs.length
        && firstArgs.every((arg, index) => arg === secondArgs[index]);
}

function getStartAtLoginEnabled() {
    try {
        return app.getLoginItemSettings(getLoginItemOptions()).openAtLogin;
    } catch (error) {
        console.error('Reading startup setting failed:', error);
        return false;
    }
}

function setStartAtLoginEnabled(enabled) {
    try {
        app.setLoginItemSettings({
            ...getLoginItemOptions(),
            openAtLogin: enabled,
            enabled
        });
    } catch (error) {
        console.error('Updating startup setting failed:', error);
    }

    updateTrayMenu();
}

function repairStartAtLoginRegistration() {
    if (process.platform !== 'win32') {
        return;
    }

    try {
        const currentSettings = app.getLoginItemSettings(getLoginItemOptions());
        if (currentSettings.openAtLogin) {
            return;
        }

        const registeredLoginItem = readRegisteredWindowsLoginItem();
        if (!registeredLoginItem || loginItemOptionsMatch(registeredLoginItem, getLoginItemOptions())) {
            return;
        }

        const registeredSettings = app.getLoginItemSettings({
            name: LOGIN_ITEM_NAME,
            ...registeredLoginItem
        });

        if (!hasEnabledNamedLoginItem(registeredSettings)) {
            return;
        }

        app.setLoginItemSettings({
            ...getLoginItemOptions(),
            openAtLogin: true,
            enabled: true
        });
    } catch (error) {
        console.error('Repairing startup setting failed:', error);
    }
}

function updateTrayMenu() {
    if (!tray) {
        return;
    }

    const menuTemplate = [
        {
            label: 'Show Bitcoin Block Clock',
            click: showMainWindow
        },
        {
            label: 'Start at Login',
            type: 'checkbox',
            checked: getStartAtLoginEnabled(),
            click: menuItem => {
                setStartAtLoginEnabled(menuItem.checked);
            }
        },
        {
            label: 'Price alerts',
            type: 'checkbox',
            checked: priceMonitor?.data.enabled === true,
            click: menuItem => {
                priceMonitor?.setEnabled(menuItem.checked).then(updateTrayMenu).catch(console.error);
            }
        }
    ];

    if (trayAttention?.alert) {
        menuTemplate.splice(1, 0,
            { label: trayAttention.alert.title, enabled: false },
            { label: trayAttention.alert.body, enabled: false },
            { type: 'separator' }
        );
    }

    menuTemplate.push(
        { type: 'separator' },
        {
            label: 'Quit Bitcoin Block Clock',
            click: quitFromTray
        }
    );

    tray.setContextMenu(Menu.buildFromTemplate(menuTemplate));
}

function createTray() {
    if (tray) {
        return tray;
    }

    // Keep Windows notification-area identity stable across rebuilds and launch paths.
    tray = new Tray(getTrayIconPath(), WINDOWS_TRAY_GUID);
    updateTrayAttention();

    tray.on('click', toggleMainWindowFromTray);
    tray.on('double-click', showMainWindow);

    return tray;
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

    const clockUrl = new URL(`http://127.0.0.1:${address.port}/clock.html`);
    clockUrl.searchParams.set('v', String(Date.now()));

    return clockUrl.toString();
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
        if (!/^https?:\/\//i.test(url)) return { action: 'deny' };
        shell.openExternal(url).catch(error => {
            console.error('Opening external URL failed:', error);
        });

        return { action: 'deny' };
    });

    mainWindow.webContents.on('will-navigate', (event, url) => {
        const target = new URL(url);
        if (target.origin !== `http://127.0.0.1:${STATIC_PORT}` || target.pathname !== '/clock.html') event.preventDefault();
    });

    mainWindow.once('ready-to-show', () => {
        if (shouldStartHidden()) {
            shouldMaximizeOnShow = windowState.maximized;
            mainWindow.setSkipTaskbar(true);
            return;
        }

        if (windowState.maximized) {
            mainWindow.maximize();
        }

        mainWindow.show();
    });

    mainWindow.on('focus', acknowledgeTrayAttention);

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

    mainWindow.on('minimize', event => {
        if (isQuitting) {
            return;
        }

        event.preventDefault();
        hideMainWindowToTray();
    });

    mainWindow.on('close', event => {
        if (!isQuitting) {
            event.preventDefault();
            hideMainWindowToTray();
            return;
        }

        flushWindowState(mainWindow).catch(error => {
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

const hasSingleInstance = app.requestSingleInstanceLock();
if (!hasSingleInstance) app.quit();
app.on('second-instance', showMainWindow);

app.whenReady().then(async () => {
    if (!hasSingleInstance) return;
    const samples = [79900, 80000, 80010, 80800, 80000, 78400, 80050];
    let delivered = 0;
    trayAttention = new TrayAttention({
        store: fileStore(path.join(verificationDirectory || app.getPath('userData'), 'tray-attention.json')),
        render: updateTrayAttention
    });
    await trayAttention.load();
    priceMonitor = new PriceMonitor({
        store: fileStore(path.join(verificationDirectory || app.getPath('userData'), 'price-alerts.json')),
        ...(verificationDirectory ? { quote: async () => samples.shift() } : {}),
        notify: async alert => { await trayAttention.mark(alert); delivered++; }
    });
    await priceMonitor.load();
    if (!verificationDirectory) repairStartAtLoginRegistration();
    createTray();
    await createMainWindow();

    if (verificationDirectory) {
        await require('./verify-alerts').verify({ priceMonitor, mainWindow, tray, trayAttention, getTrayIconPath, samples, delivered: () => delivered, directory: verificationDirectory });
    } else {
        priceMonitor.start();
    }

    app.on('activate', async () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            await createMainWindow();
            return;
        }

        showMainWindow();
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
    isQuitting = true;

    if (staticServer) {
        event.preventDefault();
        Promise.all([priceMonitor?.stop(), trayAttention?.queue, closeStaticServer()]).finally(() => {
            app.exit();
        });
    }
});
