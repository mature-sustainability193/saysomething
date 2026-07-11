# Say Something, macOS port guide

How to recreate Say Something on macOS. Read `docs/HANDOFF.md` first for the overall architecture.

**The big picture:** the app is deliberately structured so that **one native binary holds all of the OS-level integration** (`native/SaySomethingHelper.cs`), and it talks to the JS main process over a **JSON-lines-over-stdio protocol**. Everything above that line is portable. So the port is:

1. **Rewrite exactly one thing deeply:** the C# Windows helper becomes a macOS helper that speaks the *same* stdio protocol.
2. **Swap a handful of constants and the packaging.**
3. **Reuse everything else as-is:** the entire JS main process, the whisper HTTP stack, all renderers, IPC, the stores, and Electron itself.

Do not rewrite the app. Rewrite the helper.

---

## 1. What stays vs what changes

### Reused as-is (confirmed cross-platform)
- **JS main process / state machine** (`src/main/state.js`): pure orchestration, no OS calls, talks only to `helper.*`, `client`, `formatter`, `rewriter`, `windows`, `ipc`.
- **Helper supervisor** (`src/main/helper.js`): spawn / stdio / JSON-lines / backoff-restart / command queues. (Two small edits, see §5.)
- **Whisper over HTTP** (`whisper/server.js`, `client.js`, `streaming.js`, `models.js`): the whisper.cpp HTTP wire contract is identical cross-platform. Only the server *binary* differs.
- **`formatter.js`, `rewrite.js`**: pure text + loopback HTTP. The rewrite loopback gate works unchanged.
- **Stores** (`stores/settings.js`, `history.js`): JSON under the user-data dir.
- **IPC + preloads, all renderers** (`overlay/`, `pad/`, `settings/`, `welcome/`), the WebAudio capture path.
- **Electron + electron-builder** themselves.

### Must change
- `native/SaySomethingHelper.cs` (the whole file) → the macOS helper. **This is the real work.** See §2.
- `native/build.cmd` → a mac build step (or ship a prebuilt binary). See §5.
- `src/main/config.js` constants (binary names, tar, whisper zip, data dir). See §5.
- `src/main/whisper/binaries.js` (`.dll`/`.exe` assumptions). See §5.
- `package.json` build config (`win/nsis` → add a `mac` target). See §6.
- Copy/asset tweaks: `tray.js` "Start with Windows" label + tooltip, `.ico` → `.icns` icon in `windows.js`, the `*.ps1` scripts.
- **The one subtle cross-cutting item:** Windows Virtual-Key numbers leak into the JS layer. See §3.

---

## 2. The macOS helper

Ship a small **Swift command-line tool** (a bare `main.swift`, no app bundle) spawned by Electron, speaking the **same JSON-lines stdio protocol** as the Windows helper. It's built on CoreGraphics **Quartz Event Services** (`CGEventTap`, `CGEvent`) + AppKit (`NSPasteboard`, `NSWorkspace`).

### The stdio protocol it must reproduce exactly
The mac helper must emit byte-identical lines. From `docs/CONTRACTS.md`:
- **Commands in** (Electron → helper): `ping`, `watch {vks[]}`, `capture`, `capture-cancel`, `paste {text,restoreMs}`, `type {text}`, `clipboard {text}`, `placeAt {text,x,y,restoreMs}`, `pickPoint`, `pick-cancel`, `foreground`, `quit`.
- **Events out** (helper → Electron): `ready`, `pong`, `key {vk,down,held[]}`, `captured {vk,name,mods[]}`, `picked {x,y}`, `pasted/typed/copied/placed {ok,err}`, `foreground {exe,title}`, `log {msg}`.

### Windows API → macOS API mapping

| Windows mechanism (in the C# helper) | Feature | macOS replacement |
|---|---|---|
| `WH_KEYBOARD_LL` hook | Global hotkey watch, Esc-to-cancel, chord/rebind capture | **`CGEventTap`** on `keyDown`/`keyUp`/`flagsChanged`. Modifiers arrive **only as `flagsChanged`**, that's how you see the Alt in "Alt+T". Use `.cgSessionEventTap` location, `.headInsertEventTap` placement, **`.defaultTap`** option so you can return `nil` to *swallow* the hotkey chord. |
| `WH_MOUSE_LL` hook (one-shot pick + swallow) | Drop-pad "place" point | A second `CGEventTap` (or the same tap, OR the masks) on `leftMouseDown`/`leftMouseUp`. Read `event.location` (global `CGPoint`, top-left origin). Return `nil` to swallow the captured click. |
| `SendInput` (`Ctrl+V`) + unicode type | Paste + type injection | `CGEvent` keyboard events + `event.post(tap: .cghidEventTap)`. **Paste = synthesize Cmd+V, not Ctrl+V** (the one behavioral change; key `kVK_ANSI_V = 0x09` with `.maskCommand`). Type = `CGEventKeyboardSetUnicodeString` (best-effort; some apps ignore the unicode string and re-derive from keycode, so **clipboard-swap paste stays the reliable default**, same as Windows). |
| `NSWindows.Forms.Clipboard` on an STA thread | Clipboard-swap paste + `clipboard` command | `NSPasteboard.general`: `clearContents()` + `setString(_, forType:.string)`; save/restore prior contents; keep the non-text warn-once. No STA; use the AppKit thread. |
| `SetCursorPos` + `mouse_event` | Drop-pad "place at point" | `CGWarpMouseCursorPosition(pt)` then synthesized `CGEvent` `.leftMouseDown`/`.leftMouseUp` at the point, then Cmd+V. (After a warp, if clicks land stale, call `CGAssociateMouseAndMouseCursorPosition(true)`.) |
| `GetForegroundWindow` + `QueryFullProcessImageName` | History `app` field | `NSWorkspace.shared.frontmostApplication` → `.bundleIdentifier` (stable) / `.localizedName`. **No permission needed.** Window title (optional) needs the Accessibility `AXUIElement` API. |
| `GetAsyncKeyState` snapshot | The stale-modifier fix (mirrors commit c0e6e33) | `CGEventSource.keyState(_:key:)` and `CGEventSource.flagsState(_:)`. On a `keyDown` for the trigger, snapshot `flagsState` and confirm the modifier is *genuinely* down instead of trusting a possibly-stale cache. |
| `GetModuleHandle` + message loop | Hook install + pump | **A `CFRunLoop` on a dedicated thread.** The tap only fires while a `CFRunLoop` runs on its thread. |

### Threading (required)
- **Tap thread:** create the tap(s), `CFMachPortCreateRunLoopSource`, `CFRunLoopAddSource`, `CFRunLoopRun()`. All callbacks fire here. Do not block it on stdin.
- **stdin thread (or main):** blocking-read JSON commands and hand them to the tap thread via a thread-safe queue or `CFRunLoopPerformBlock` + `CFRunLoopWakeUp`.
- **Watchdog:** a signed tap can be **silently disabled** (code-sign race, `kCGEventTapDisabledByTimeout`, `...ByUserInput`). Handle those event types in the callback and call `CGEvent.tapEnable(tap:, enable:true)` to re-arm. Also poll `CGEventTapIsEnabled` on a timer. Budget for this, "a non-nil tap is not a healthy tap."

---

## 3. The one gotcha: Virtual-Key numbers leak into JS

`state.js` (`hotkeyVk=163` Right Ctrl, `padHotkeyVk=165` Right Alt, `ESC_VK=27`), `hotkey-match.js` (`MOD_VARIANTS` = 16/17/18/91 + L/R variants 160-165, 91/92), and the **persisted `settings.hotkey/padHotkey.{vk,mods}`** all speak **Windows Virtual-Key numbers**. macOS uses different key codes (`CGKeyCode`, e.g. `kVK_ANSI_T=0x11`, `kVK_Option=0x3A`).

**Recommended approach (cheapest, keeps the whole JS + settings layer untouched):** the mac helper **translates at the boundary**. It keeps a `CGKeyCode ↔ Windows-VK` table and:
- emits `key`/`captured`/`held` events using **Windows-VK numbers** (so `state.js` and `hotkey-match.js` and saved settings work verbatim, and a `settings.json` is portable between platforms),
- interprets `watch {vks[]}` (Windows-VK) by mapping back to `CGKeyCode` for its filter.

This means the only place that knows about macOS key codes is the helper. The alternative (moving the whole stack to mac key codes) is more invasive and breaks settings portability; prefer the boundary translation.

`VkName()` (the ~90-case VK→friendly-name table used for rebind display) is rebuilt from the same mapping so "Alt + T" still renders.

---

## 4. Permissions (TCC), the part that trips everyone up

Three separate permissions, and the classic confusion is that **Accessibility and Input Monitoring are gated by which `CGEventTap` option you use**:

| Capability | TCC permission | How to request |
|---|---|---|
| Observe global keyboard/mouse (`.listenOnly` tap) | **Input Monitoring** (`kTCCServiceListenEvent`) | `CGPreflightListenEventAccess()` / `CGRequestListenEventAccess()` |
| Swallow/modify the hotkey chord or capture-click (`.defaultTap`) | Input Monitoring **+ Accessibility** | as above + `AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt: true])` |
| Inject paste/type/clicks (`CGEvent.post`) | **Accessibility** (`kTCCServiceAccessibility`) | `AXIsProcessTrustedWithOptions(...)` |
| Frontmost app bundle id + name | **None** | — |
| `keyState` / `flagsState` snapshot | None (Input Monitoring assumed in practice) | — |
| Microphone | **Microphone** | `NSMicrophoneUsageDescription` in Info.plist + `AVCaptureDevice.requestAccess(for:.audio)` |

Because the app needs to **swallow** the hotkey (so "T" doesn't type through) **and** inject text, plan the onboarding to request **both Input Monitoring and Accessibility** up front, plus Microphone.

**You cannot pre-grant any of these.** The TCC DB is SIP-protected. Your app can only trigger the prompt or deep-link the user to the pane:
- `x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent`
- `...?Privacy_Accessibility`
- `...?Privacy_Microphone`

**Recommended onboarding:** the helper reports each grant's status back over stdio (add a `perms`/`ready` field), and the Electron UI (extend the welcome / a new first-run permissions screen) gates the "start dictating" button until all three are green, with buttons that deep-link to each pane. Re-check `AXIsProcessTrusted()` on focus.

---

## 5. Constants and small JS edits

- `src/main/config.js`: `BIN_HELPER`/`BIN_WHISPER` names lose `.exe`; `CSC` (csc path) unused; `TAR` → `/usr/bin/tar` (mac bsdtar) or just `unzip`; `WHISPER_ZIP_URL`/`HASHES` → a **Darwin arm64/x64 whisper.cpp build** (or build from source, see §7); `resolveUserData()` → `~/Library/Application Support/SaySomething` (Electron's `getPath('appData')` already resolves; only the plain-node `process.env.APPDATA` fallback needs a mac branch).
- `src/main/helper.js`: the compile-on-missing path (`process.env.ComSpec || 'cmd.exe'`, `BUILD_CMD = .../build.cmd`) is cmd-specific. Simplest: **ship the mac helper prebuilt** and skip compile-on-demand on mac (branch on `process.platform`).
- `src/main/whisper/binaries.js`: `.dylib` not `.dll`, no `.exe`, and the "which members to keep" filter changes; `serverExe()`/`isReady()` drop the `.exe`.
- `src/main/tray.js`: "Start with Windows" → "Start at login"; tooltip copy. `setLoginItemSettings` is cross-platform in Electron but behaves differently on mac (ignores `path`), verify.
- `src/main/windows.js`: `windowIcon()` wants `.icns`/PNG, not `.ico`. The always-on-top / click-through overlay calls are already wrapped in try/catch, test them on mac.
- Replace the `*.ps1` scripts (`make-shortcut.ps1`, the `*-transcribe.ps1` e2e helpers) with shell equivalents.

---

## 6. Packaging (electron-builder)

Add a `mac` target to `package.json` `build`:
```jsonc
"mac": {
  "target": [
    { "target": "dmg", "arch": ["arm64", "x64"] },
    { "target": "zip", "arch": ["arm64", "x64"] }
  ],
  "icon": "assets/SaySomething.icns",
  "category": "public.app-category.productivity",
  "hardenedRuntime": true,
  "entitlements": "build/entitlements.mac.plist",
  "entitlementsInherit": "build/entitlements.mac.inherit.plist",
  "extendInfo": { "NSMicrophoneUsageDescription": "Say Something transcribes your voice on your Mac." }
}
```
- Keep `extraResources` shipping the **mac** `bin/` (the whisper-server binary + the Swift helper), not the Windows tree. Resolve at runtime with `process.resourcesPath` when `app.isPackaged`. `chmod 0o755` the binaries (afterPack hook) so they can be spawned.
- **Entitlements** (`build/entitlements.mac.plist`): `com.apple.security.cs.allow-jit` (Electron needs it under hardened runtime) and `com.apple.security.device.audio-input` (mic). **There is NO entitlement for Accessibility or Input Monitoring** — those are pure TCC user grants, not entitlements. Do not add anything to the plist for them.
- **`entitlementsInherit`** (`com.apple.security.inherit`) is what makes the whole scheme work: a child process (the Swift helper, `whisper-server`) signed with the same Team ID + inherit entitlement runs under the main `.app` as its **responsible process**, so the mic/Accessibility/Input-Monitoring grants the user gives to the one `.app` cascade to the helpers, one entry in System Settings, not three.
- **Every Mach-O in the bundle must be signed** for notarization (Electron helpers + `whisper-server` + the Swift helper). electron-builder signs known locations; add extras to `mac.binaries` or sign in an `afterSign` hook.

---

## 7. whisper.cpp for macOS (Metal)

Build the server (`examples/server`) with Metal:
```
cmake -B build \
  -DCMAKE_OSX_ARCHITECTURES="arm64;x86_64" \
  -DCMAKE_OSX_DEPLOYMENT_TARGET=13.0 \
  -DGGML_METAL=ON \
  -DGGML_METAL_EMBED_LIBRARY=ON \
  -DWHISPER_BUILD_SERVER=ON
cmake --build build -j --config Release
# run identically to Windows:  ./whisper-server --host 127.0.0.1 --port 8737 -m models/ggml-small.en.bin -t <threads>
```
- **`GGML_METAL_EMBED_LIBRARY=ON` is critical for bundling.** It embeds the Metal shader lib inside the binary; without it, the binary looks for `default.metallib` next to itself and breaks once relocated into `Contents/Resources`.
- Metal accelerates the **arm64** slice only; the x86_64 slice runs on CPU. If cross-compiling the Intel slice is painful on Apple Silicon, build each arch and `lipo -create` them.
- Sign the binary (ad-hoc for dev, Developer ID for release). It inherits the app's TCC identity via the inherit entitlement.

---

## 8. Signing and distribution, the honest version

### The paid path ($99/yr Apple Developer)
Developer ID Application cert + `hardenedRuntime: true` + `notarize: true`. electron-builder does **sign → notarize (notarytool) → staple** automatically given `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID` (or an API key). Result: **Gatekeeper is silent, and TCC grants persist across updates** because the app has a stable Developer ID identity. This is the only way to get both.

### The free path (no paid account), and exactly what breaks
Since the current Windows build ships unsigned, the mac equivalent is:
- **Ad-hoc sign, do NOT ship fully unsigned.** On Apple Silicon, unsigned code won't even launch (the loader kills it). Set `"identity": "-"` and `"hardenedRuntime": false` (or keep hardened + add `com.apple.security.cs.disable-library-validation`), else the ad-hoc app can fail to start.
- **Gatekeeper will scare users.** A downloaded (quarantined) ad-hoc app shows "cannot be opened because the developer cannot be verified" or the harsher "is damaged." On macOS 15 Sequoia the right-click→Open bypass is mostly gone; users go to **System Settings › Privacy & Security › Open Anyway** after the first blocked launch.
- **Document the one command** (in the README *and* an in-app first-run screen):
  ```
  xattr -dr com.apple.quarantine /Applications/Say\ Something.app
  ```
  (Locally-built / build-from-source apps aren't quarantined, so "build it yourself" and a Homebrew cask that runs the `xattr` step are the friendlier free channels.)
- **Can an ad-hoc app get Accessibility + Input Monitoring + Mic? YES.** macOS does not hard-block TCC grants for ad-hoc apps. **But the ad-hoc identity is not stable:** every rebuild has a different cdhash, so TCC thinks it's a new program and **the user must re-grant all three permissions after every update** (and stale entries pile up in the privacy list). That re-grant tax is the core cost of shipping free.
- **Soften it:** sign with a **consistent self-signed certificate** instead of raw `-` ad-hoc, so grants survive some rebuilds (still won't remove the Gatekeeper prompt); and ship an in-app permissions screen that deep-links to the three panes and re-checks grant status so re-granting is one click each.

**Bottom line:** for a truly free app, ad-hoc sign + documented quarantine removal + an in-app permissions/re-grant flow is the least-bad path. Silent Gatekeeper AND persistent TCC grants require the $99/yr Developer ID + notarization.

---

## 9. Suggested order of work

1. **Helper first, in isolation.** Write the Swift `main.swift` that speaks the stdio protocol. Test it standalone: `echo '{"cmd":"ping"}' | ./helper` should print `{"evt":"pong"}`; wire up `watch`, `key` events, `paste`, `foreground`. Get the CGEventTap + CFRunLoop + threading right here before touching Electron.
2. **VK boundary translation** (§3) inside the helper, so the JS layer never learns about mac key codes.
3. **Point Electron at it:** platform-branch `config.js` (binary paths, data dir) and `helper.js` (skip compile-on-demand on mac). Run `npm start` on the Mac, it should behave identically once permissions are granted.
4. **whisper.cpp Metal build** (§7), drop it in `bin/`, update `binaries.js`/`config.js` hashes.
5. **Permissions onboarding** (§4): grant-status over stdio + a first-run screen.
6. **Packaging** (§6) + signing/distribution (§8).

Everything else, the state machine, formatter, rewrite, drop pad, combo hotkeys, whisper HTTP, renderers, is already done and portable.

---

## Sources
- Apple: [CGEvent](https://developer.apple.com/documentation/coregraphics/cgevent), [CGEventSource](https://developer.apple.com/documentation/coregraphics/cgeventsource), [keyState](https://developer.apple.com/documentation/coregraphics/cgeventsource/1408768-keystate), [audio-input entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.device.audio-input), [Input Monitoring control](https://support.apple.com/guide/mac-help/control-access-to-input-monitoring-on-mac-mchl4cedafb6/mac), [ad-hoc/TCC forum thread 678816](https://developer.apple.com/forums/thread/678816)
- CGEventTap in practice: [pqrs-org event-observer examples](https://github.com/pqrs-org/osx-event-observer-examples), [tap silent-disable + code signing](https://danielraffel.me/til/2026/02/19/cgevent-taps-and-code-signing-the-silent-disable-race/), [Input Monitoring vs Accessibility (AeroSpace #1012)](https://github.com/nikitabobko/AeroSpace/issues/1012), [TCC service names](https://hacktricks.wiki/en/macos-hardening/macos-security-and-privilege-escalation/macos-security-protections/macos-input-monitoring-screen-capture-accessibility.html), [CGEventKeyboardSetUnicodeString caveat](https://delphihaven.wordpress.com/2015/07/04/sending-keystrokes-on-os-x/)
- whisper.cpp: [ggml-org/whisper.cpp](https://github.com/ggml-org/whisper.cpp), [macOS CMake / universal / embed metallib](https://prakashjoshipax.com/whispercpp-cmake-guide-for-macos-and-ios-apps/)
- Packaging: [electron-builder mac](https://www.electron.build/docs/mac/), [notarization](https://www.electron.build/docs/notarization/), [Kilian Valkhof notarizing](https://kilianvalkhof.com/2019/electron/notarizing-your-electron-application/), [quarantine/distribution gist](https://gist.github.com/rsms/929c9c2fec231f0cf843a1a746a416f5)
