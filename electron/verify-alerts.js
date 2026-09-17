'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { nativeImage } = require('electron');
const { fileStore } = require('./price-monitor');
const { TrayAttention } = require('./tray-attention');

// Explicit packaged QA entry point, run only in the isolated executable harness.
exports.verify = async ({ priceMonitor, mainWindow, tray, trayAttention, getTrayIconPath, samples, delivered, directory }) => {
    const checks = {};
    try {
        await priceMonitor.poll();
        checks.initialSilent = delivered() === 0 && trayAttention.alert === null;
        mainWindow.hide();
        while (samples.length) await priceMonitor.poll();
        checks.hiddenMonitoring = delivered() === 4;
        checks.combined = priceMonitor.data.lastAlert?.levels[0] === 80000 && priceMonitor.data.lastAlert?.percentageTriggered === true;
        checks.referenceReset = priceMonitor.data.engine.reference === 80050;
        const saved = JSON.parse(await fs.readFile(path.join(directory, 'price-alerts.json'), 'utf8'));
        checks.persisted = saved.engine.reference === 80050 && saved.pending === null;
        checks.attentionSet = trayAttention.alert?.id === priceMonitor.data.lastAlert?.id;
        checks.alertDetails = trayAttention.tooltip().includes('$80,050.00') && trayAttention.tooltip().includes('+2.10%');
        const restarted = new TrayAttention({ store: fileStore(path.join(directory, 'tray-attention.json')) });
        await restarted.load();
        checks.attentionPersisted = restarted.alert?.id === trayAttention.alert?.id;
        const attentionIcon = nativeImage.createFromPath(getTrayIconPath());
        checks.attentionIcon = !attentionIcon.isEmpty() && path.basename(getTrayIconPath()) === 'bitcoin-alert.ico';
        await fs.writeFile(path.join(directory, 'tray-attention-32.png'), attentionIcon.resize({ width: 32, height: 32 }).toPNG());
        const trayBounds = tray.getBounds();
        let trayExposure;
        try { trayExposure = require('./verify-tray').exposeTray(trayBounds); }
        catch (error) { trayExposure = { error: error.message }; }
        await fs.writeFile(path.join(directory, 'tray-attention-ready.json'), JSON.stringify({ alert: trayAttention.alert, bounds: trayBounds, trayExposure }));
        // Let the isolated harness expose and capture the notification area.
        await new Promise(resolve => setTimeout(resolve, 15_000));
        tray.emit('click');
        await trayAttention.queue;
        // Settle the native focus event before simulating a later hourly movement.
        await new Promise(resolve => setTimeout(resolve, 250));
        await trayAttention.queue;
        checks.trayOpensWindow = mainWindow.isVisible();
        checks.attentionCleared = trayAttention.alert === null && path.basename(getTrayIconPath()) === 'bitcoin-logo.ico';
        await restarted.load();
        checks.acknowledgementPersisted = restarted.alert === null;
        await restarted.mark(priceMonitor.data.lastAlert);
        checks.acknowledgedRetryStaysQuiet = restarted.alert === null;
        samples.push(80060, 81660);
        await priceMonitor.poll();
        checks.ordinaryQuoteStaysQuiet = trayAttention.alert === null && delivered() === 4;
        await priceMonitor.poll();
        checks.nextAlertMarksAgain = trayAttention.alert?.price === 81660 && delivered() === 5;
        // An alert click must show/acknowledge, even if the dashboard is already visible.
        tray.emit('click');
        await trayAttention.queue;
        checks.visibleDashboardAcknowledges = mainWindow.isVisible() && trayAttention.alert === null;
        await priceMonitor.setEnabled(false);
        checks.paused = priceMonitor.status().status === 'paused';
        await new Promise(resolve => setTimeout(resolve, 2300));
        checks.screen = await mainWindow.webContents.executeJavaScript(`location.pathname === '/clock.html' && !!document.querySelector('[data-mobile-range="day"]') && !!document.querySelector('[data-mobile-currency-toggle]') && !document.querySelector('#toggle')`);
    } catch (error) {
        checks.error = error.message;
    }
    await fs.writeFile(path.join(directory, 'alerts-result.json'), JSON.stringify({ passed: Object.values(checks).every(value => value === true), checks, delivered: delivered(), status: priceMonitor.status() }, null, 2));
};
