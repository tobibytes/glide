# K1 (native hotkeys) → K2 (Keys.swift) contract

Hotkeys.swift owns global hotkeys. Modifier-only shortcuts (`Double+Cmd`, `Right+Alt`) already work through
Hotkeys.swift's own **listen-only** tap (Input Monitoring), so K2 does not have to do anything for them.
Forwarding events from Keys.swift's tap is optional but harmless: duplicates are dropped by event timestamp.

The one thing that needs K2: **"Hyper" tapped alone** (Caps Lock → F18). Keys.swift swallows F18 (`return nil`), so no
other tap can see it. Please add, all on the main thread (Keys.handle already is):

1. Once, e.g. in `Keys.init` or at the top of `configure(...)`:
   ```swift
   Hotkeys.shared.keysTapHooked = true
   ```
2. In `handle(type:event:)`, where the F18 key-up is handled alone (today: `if !hyperUsed { postKey(53) }`):
   ```swift
   if !hyperUsed && !Hotkeys.shared.handleHyperTap() { postKey(53) } // Hyper tap bound to a hotkey: no Escape
   ```

Optional (only if you want one tap for everything):
- `.flagsChanged` → `Hotkeys.shared.handleFlagsChanged(event)`
- `.keyDown` / mouse down → `Hotkeys.shared.handleKeyDown()`

`Hyper+<key>` combos need nothing: your tap adds ⌃⌥⇧⌘ and the Carbon hotkey `Ctrl+Alt+Shift+Cmd+<key>` matches.
API stability: `keysTapHooked`, `handleHyperTap() -> Bool`, `handleFlagsChanged(_ event: CGEvent)`, `handleKeyDown()`.
