<p align="center">
  <img src="electron/assets/bitcoin-logo.png" width="96" height="96" alt="Bitcoin Block Clock logo">
</p>

<h1 align="center">Bitcoin Block Clock</h1>

<p align="center">
  Quiet Bitcoin price alerts on desktop and Android, with a separate block-clock dashboard for web, Wear OS, and car screens.
</p>

<p align="center">
  <a href="https://github.com/patriceac/BitcoinBlockClock/releases/latest/download/BitcoinBlockClock-Windows-Setup.exe"><img alt="Download for Windows" src="https://img.shields.io/badge/Windows-Setup.exe-f6a21f?style=for-the-badge&logo=windows&logoColor=white"></a>
  <a href="https://github.com/patriceac/BitcoinBlockClock/releases/latest/download/BitcoinBlockClock-macOS.dmg"><img alt="Download for macOS" src="https://img.shields.io/badge/macOS-DMG-111820?style=for-the-badge&logo=apple&logoColor=white"></a>
  <a href="https://github.com/patriceac/BitcoinBlockClock/releases/latest/download/BitcoinBlockClock-Linux.AppImage"><img alt="Download for Linux" src="https://img.shields.io/badge/Linux-AppImage-8fc7ff?style=for-the-badge&logo=linux&logoColor=111820"></a>
  <a href="https://github.com/patriceac/BitcoinBlockClock/releases/latest/download/BitcoinBlockClock-Android.apk"><img alt="Download for Android" src="https://img.shields.io/badge/Android-APK-9be870?style=for-the-badge&logo=android&logoColor=111820"></a>
</p>

<p align="center">
  <a href="https://github.com/patriceac/BitcoinBlockClock/releases/latest">Latest release</a>
  ·
  <a href="app/src/main/assets/clock.html">Clock source</a>
  ·
  <a href="https://github.com/patriceac/BitcoinBlockClock/actions/workflows/release-installers.yml">Installer workflow</a>
</p>

![Bitcoin Price Alerts preview](docs/assets/bitcoin-price-alerts-preview.png)

## Install

| Platform | Download | Notes |
| --- | --- | --- |
| Windows | [BitcoinBlockClock-Windows-Setup.exe](https://github.com/patriceac/BitcoinBlockClock/releases/latest/download/BitcoinBlockClock-Windows-Setup.exe) | Standard setup installer with repaired Start at Login registration. |
| Windows portable | [BitcoinBlockClock-Windows-Portable.exe](https://github.com/patriceac/BitcoinBlockClock/releases/latest/download/BitcoinBlockClock-Windows-Portable.exe) | Rebuilt portable Windows executable that runs without installation. |
| macOS | [BitcoinBlockClock-macOS.dmg](https://github.com/patriceac/BitcoinBlockClock/releases/latest/download/BitcoinBlockClock-macOS.dmg) | Drag-and-drop desktop package. |
| Linux | [BitcoinBlockClock-Linux.AppImage](https://github.com/patriceac/BitcoinBlockClock/releases/latest/download/BitcoinBlockClock-Linux.AppImage) | Portable Linux build. |
| Linux package | [BitcoinBlockClock-Linux.deb](https://github.com/patriceac/BitcoinBlockClock/releases/latest/download/BitcoinBlockClock-Linux.deb) | Debian/Ubuntu package. |
| Android | [BitcoinBlockClock-Android.apk](https://github.com/patriceac/BitcoinBlockClock/releases/latest/download/BitcoinBlockClock-Android.apk) | Release-mode APK for sideloading. |

The latest GitHub release includes the rebuilt Windows installer and portable Windows executable. The Windows Start at Login option repairs stale startup entries so Windows launches the installed app at sign-in.

Release installers and the Android APK are attached to GitHub releases. The workflow builds desktop artifacts with Electron Builder and the Android APK with Gradle's `assembleRelease` task.

The Android APK is a release-mode sideload build. Configure production signing before using it for app-store distribution.

## Price alerts (v1.1)

Desktop and phone open a quiet alert screen, with no continuously displayed price. The phone widget displays monitoring status only.

- A move of **±2%** from the reference triggers an alert. The first fresh quote establishes the initial reference.
- Crossing **any positive $5,000 boundary** triggers an alert in either direction, including exact touches and multiple levels in a jump.
- A triggered level remains blocked until a sampled price is **at least 1% away**. That sample rearms the level for a subsequent crossing; small oscillations stay silent. An initial crossing that already overshoots 1% establishes this distance immediately.
- Both rules run on the same quote. If they trigger together, all reasons and crossed levels appear in **one notification**.
- **Every alert resets the percentage reference**, including a level-only alert. The notification reports the price, movement direction, change from the prior reference and any crossed levels.
- Reference, previous quote, blocked levels, latest alert and pending delivery survive app restarts. Pausing and starting again establishes a fresh reference. A missed fetch never resets the reference.

Both platforms sample Kraken XBT/USD approximately every **30 seconds**, using the last traded price. Crossings are detected between successful samples, so a price that crosses and returns between checks can be missed. Coalescing applies to conditions observed in the same sample. Each installation maintains its own reference; there is no cross-device alert deduplication or cloud account.

Windows monitoring runs in the main process while the window is closed to the tray. Enable **Start at Login** in the tray to resume at sign-in. Quitting or sleeping the computer stops checks until it resumes.

Android requests notification permission and uses a foreground service with a **silent, price-free status notification** and a Pause action. Monitoring continues after leaving the activity and resumes after reboot or an app update if previously enabled. Battery restrictions, Doze, force-stop, missing connectivity or disabled notifications can delay or prevent alerts. The app explicitly reports interrupted monitoring when open. No routine price notifications are sent.

Android is currently built as a release-mode sideload APK with the existing local signing identity so updates preserve installed data. Store distribution needs a managed production signing key and review of the foreground-service declaration.

### Verification

`npm test` covers the JavaScript reducer, monitor persistence, offline recovery, delivery retry and concurrent polls, plus existing dashboard tests. `./gradlew testReleaseUnitTest lintRelease assembleRelease` tests and builds Android. Both reducers run `app/src/test/resources/price-alert-vectors.json` to prevent rule drift.

The Windows package has an explicit isolated-QA entry point: `--verify-price-alerts=<evidence-directory>`. It runs synthetic quotes through the real main-process monitor and native notifications, checks tray/hidden-window processing and the rendered screen, and writes `alerts-result.json`. Use the executable test harness for this mode; it never contacts the quote provider.

## Separate block-clock surfaces

- Live BTC price with recent market context.
- Current block height and block timing.
- Fee pressure and mempool-oriented network signals.
- Hashrate and difficulty data.
- Halving countdown, progress, and estimated local date and time.

## Run Locally

Serve the shared clock asset in a browser:

```powershell
.\serve-browser.ps1
```

Launch the Electron wrapper:

```powershell
npm run electron
```

## Build

Install JavaScript dependencies:

```powershell
npm install
```

Build desktop installers for the current platform:

```powershell
npm run build:electron
```

Build the Windows release installers locally:

```powershell
npm run build:electron:win
```

Android release APK:

```powershell
.\gradlew.bat assembleRelease
```

Cross-platform desktop releases and the Android APK are produced by the [release installers workflow](https://github.com/patriceac/BitcoinBlockClock/actions/workflows/release-installers.yml) when a `v*` tag is pushed or the workflow is run manually with a release tag.
