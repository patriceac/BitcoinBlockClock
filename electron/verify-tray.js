'use strict';

const { execFileSync } = require('node:child_process');

// Isolated Windows QA only: expose Explorer's hidden-icons flyout without
// focusing the dashboard (which intentionally acknowledges the alert).
exports.exposeTray = bounds => {
    if (process.platform !== 'win32' || !bounds.width || !bounds.height) return null;
    const x = Math.round(bounds.x + bounds.width / 2);
    const y = Math.round(bounds.y + bounds.height / 2);
    const script = `
        $ErrorActionPreference = 'Stop'
        Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class TrayBadgeQa { [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y); [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra); }'
        # The isolated baseline reports the hidden-icons chevron as the tray bounds.
        # These coordinates come from the live Tray API, not host screen assumptions.
        [void][TrayBadgeQa]::SetCursorPos(${x}, ${y})
        [TrayBadgeQa]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
        [TrayBadgeQa]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
        @{ x = ${x}; y = ${y}; clicked = $true } | ConvertTo-Json -Compress
    `;
    return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8', windowsHide: true, timeout: 10_000
    }));
};
