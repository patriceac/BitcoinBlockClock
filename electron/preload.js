'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('priceAlerts', {
    status: () => ipcRenderer.invoke('alerts:status'),
    setEnabled: enabled => ipcRenderer.invoke('alerts:set-enabled', enabled === true)
});
