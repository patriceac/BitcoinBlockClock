'use strict';
(() => {
    const $ = id => document.getElementById(id);
    const bridge = window.priceAlerts || (window.AndroidAlerts && {
        status: async () => JSON.parse(window.AndroidAlerts.status()),
        setEnabled: async enabled => { window.AndroidAlerts.setEnabled(enabled); return null; }
    });
    let current = null;
    let busy = false;
    const labels = { monitoring: 'Monitoring quietly', connecting: 'Connecting…', paused: 'Monitoring paused', interrupted: 'Monitoring interrupted', permission: 'Notifications need permission' };
    async function refresh() {
        if (!bridge) {
            $('status').textContent = 'Open the installed app';
            $('status-detail').textContent = 'Background alerts are available in the desktop and Android applications.';
            return;
        }
        try {
            current = await bridge.status();
            $('status').textContent = labels[current.status] || 'Monitoring interrupted';
            $('status-dot').className = `dot ${current.status}`;
            $('status-detail').textContent = current.message || (current.status === 'monitoring' ? 'No qualifying movement means no notification.' : current.status === 'paused' ? 'Starting again sets a fresh reference.' : 'The first fresh quote sets your reference.');
            $('toggle').textContent = current.status === 'permission' ? 'Enable notifications' : current.enabled ? 'Pause monitoring' : 'Start monitoring';
            $('toggle').disabled = busy;
            $('platform-note').textContent = current.platform === 'android' ? 'A silent Android status notification keeps monitoring active. Battery restrictions may delay checks.' : 'Monitoring continues in the tray. Quitting the app stops checks.';
            if (current.lastAlert) {
                $('alert-title').textContent = current.lastAlert.title;
                $('alert-body').textContent = current.lastAlert.body;
                $('alert-time').textContent = new Date(current.lastAlert.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
                $('alert-time').dateTime = new Date(current.lastAlert.at).toISOString();
            }
        } catch (_) {
            $('status').textContent = 'Monitoring status unavailable';
            $('status-detail').textContent = 'Reopen the app to reconnect.';
        }
    }
    $('toggle').addEventListener('click', async () => {
        if (!current || busy) return;
        busy = true;
        $('toggle').disabled = true;
        $('error').hidden = true;
        try { await bridge.setEnabled(current.status === 'permission' || !current.enabled); }
        catch (_) { $('error').textContent = 'Could not change monitoring. Please try again.'; $('error').hidden = false; }
        finally { busy = false; await refresh(); }
    });
    void refresh();
    setInterval(() => void refresh(), 2000);
})();
