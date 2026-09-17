'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');

// Explicit packaged QA entry point, run only in the isolated executable harness.
exports.verify = async ({ priceMonitor, mainWindow, samples, delivered, directory }) => {
    const checks = {};
    try {
        await priceMonitor.poll();
        checks.initialSilent = delivered() === 0;
        mainWindow.hide();
        while (samples.length) await priceMonitor.poll();
        checks.hiddenMonitoring = delivered() === 4;
        checks.combined = priceMonitor.data.lastAlert?.levels[0] === 80000 && priceMonitor.data.lastAlert?.percentageTriggered === true;
        checks.referenceReset = priceMonitor.data.engine.reference === 80050;
        const saved = JSON.parse(await fs.readFile(path.join(directory, 'price-alerts.json'), 'utf8'));
        checks.persisted = saved.engine.reference === 80050 && saved.pending === null;
        await priceMonitor.setEnabled(false);
        checks.paused = priceMonitor.status().status === 'paused';
        mainWindow.show();
        await new Promise(resolve => setTimeout(resolve, 2300));
        checks.screen = await mainWindow.webContents.executeJavaScript(`document.title === 'Bitcoin Price Alerts' && document.querySelector('#status').textContent === 'Monitoring paused' && document.querySelector('#alert-title').textContent.includes('80,050') && !document.querySelector('canvas')`);
    } catch (error) {
        checks.error = error.message;
    }
    await fs.writeFile(path.join(directory, 'alerts-result.json'), JSON.stringify({ passed: Object.values(checks).every(value => value === true), checks, delivered: delivered(), status: priceMonitor.status() }, null, 2));
};
