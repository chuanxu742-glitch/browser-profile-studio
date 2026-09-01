# Firefox custom core

This directory pins the exact Firefox source and Playwright Juggler patch set used by this project. It adds only the native gaps that stock Firefox 153 cannot cover for Service Workers:

- propagate the profile timezone before a Service Worker realm is created;
- allow an exact `navigator.hardwareConcurrency` profile value even when it is higher than the host CPU count.

The regular launcher already uses Firefox's native preferences for UA, appVersion, platform, OSCPU, languages, HTTP headers and WebGL strings. Keeping those out of the C++ patch minimizes the security-update merge surface.

## Build on Windows

Mozilla's current Windows build documentation requires Windows 10+, at least 40 GB free, and MozillaBuild. This host has enough space only on `D:`, so the default checkout is `D:\abs-browser-core\firefox-153`.

```powershell
./browser-core/firefox/prepare.ps1
./browser-core/firefox/build.ps1
$env:ABS_FIREFOX_EXECUTABLE_PATH='D:\abs-browser-core\firefox-153\mozilla-source\obj-abs-firefox\dist\bin\firefox.exe'
npm run test:fingerprint-runtime
```

`build.ps1` writes `build-provenance.json` beside `firefox.exe`. The application refuses a configured custom executable if its version lock or SHA-256 does not match that provenance file.

Source and patch licensing remains governed by Mozilla Public License 2.0 and the upstream Playwright repository licenses. A distributable build still needs the project's code-signing certificate and a security-update release process; this repository does not embed private signing material.
