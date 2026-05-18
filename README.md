# Bitcoin Block Clock

Bitcoin Block Clock is an Android and Electron dashboard for live Bitcoin price, block height, hashrate, fee pressure, and halving progress.

## Build

Android debug APK:

```powershell
.\gradlew.bat assembleDebug
```

Android release APK:

```powershell
.\gradlew.bat assembleRelease
```

Electron portable build:

```powershell
npm install
npm run build:electron
```

## Run Locally

Serve the shared clock asset in a browser:

```powershell
.\serve-browser.ps1
```

Launch the Electron wrapper:

```powershell
npm run electron
```
