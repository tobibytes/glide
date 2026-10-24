# Glide on iPhone: design and contract

Status: beta in v0.4. Everything here is off by default.

## Goals

Use Glide from an iPhone without an iPhone app, an Apple Developer account, or any server run by us:

- **A. Glide Remote**: a web app served by Glide on the local network, paired once with a QR code.
- **B. Send to Mac**: share text, links and photos from the phone to the Mac's clipboard, a note, or the browser.
- **C. Phone triggers**: iPhone Shortcuts automations (leave home, CarPlay, alarm…) run Glide workflows.
- **Clipboard sync** that works when Apple's Universal Clipboard doesn't.
- **D. Notifications** to the phone (opt-in, ntfy) with remote approve / deny.
- **E. Remote control**: trackpad, keys, media and slide clicker from the phone.
- **F. Find on Mac**: search files and pull one to the phone.
- **G. Glide Agent from the phone**, with confirmations on the phone.
- H (later, needs an Apple Developer account): a native iPhone app with widgets and App Intents.

Everything is **off by default** (Settings → iPhone).

## Two transports, one action registry

Every capability is a named action in `PhoneActionRegistry` (`Sources/Features/Phone/PhoneProtocol.swift`).
`PhoneCore.perform(action:args:caller:)` is the only way to run one, and it applies the same gate for both transports:

1. Unknown action → `not-found`. Relay caller and `relay == false` → `denied` (live controls are LAN-only).
2. Per-action policy (Settings → iPhone, like MCP): **Allow** / **Ask** / **Off**. Default: `safe` → Allow, `confirm` → Ask,
   `sensitive` or any action in a disabled group → Off.
3. Ask → a confirmation on the Mac (launcher view `phone.confirm`), which a paired phone can also answer .
   Timeout 60 s → denied.
4. Every call is logged (time, device, action, outcome; never clipboard or file contents).

Group switches in Settings → iPhone: **Clipboard** (sensitive), **Remote control**, **Files**, **Glide Agent**.

### Transport 1: LAN (Glide Remote web app)

- `NWListener` on TCP **7470** (falls back to a free port), all interfaces while enabled; Bonjour `_glide._tcp`.
  Env overrides for tests: `GLIDE_PHONE_HOST` (bind address, tests use `127.0.0.1`), `GLIDE_PHONE_PORT` (0 = any).
- `GET /` and static assets: the web app (`PhoneWebAssets`), unauthenticated, code only, never data.
- `POST /api` carries one encrypted call. The page runs in an **insecure context** (plain http on a LAN IP), so it cannot
  use `crypto.subtle` or `navigator.clipboard`: it uses its own ChaCha20-Poly1305 (RFC 8439) in `Web/crypto.js` and
  `crypto.getRandomValues`. The Mac uses CryptoKit `ChaChaPoly`.

Request body (JSON):
```json
{"v":1,"d":"<deviceId>","n":"<base64url 12-byte nonce>","c":"<base64url ciphertext||16-byte tag>"}
```
- Key: 32 random bytes per device, created at pairing, stored in the login Keychain (service "Glide Phone Devices").
- AAD: UTF-8 of `glide-phone-v1|<deviceId>|req` (responses: `…|res`).
- Plaintext: `{"id":"<uuid>","ts":<unix ms>,"action":"<name>","args":{…}}`.
- Rejected (HTTP 401, body `{"error":"unpaired"}`, nothing else): unknown device, bad tag, `|ts − now| > 120 s`, or a
  nonce already seen for that device (keep the last 1024 per device).
- Response (HTTP 200): same envelope with a fresh nonce; plaintext `{"id","ok":true,"result":…}` or
  `{"id","ok":false,"error":{"code","message"}}`.
- Max request body 32 MB (photos are scaled down in the browser above 12 MB). Responses are not capped by the server; `files.get` (25 MB file limit) can produce a response of about 47 MB after base64 + base64url.

Pairing:
1. Settings → iPhone → **Pair iPhone** creates a pending device `{id: 16 random bytes base64url, key, name: "iPhone"}` and
   shows a QR code for `http://<LAN IP>:<port>/#pair=<deviceId>.<base64url key>` (plus the `<host>.local` URL as text).
   The key travels only in the URL fragment, which browsers never send.
2. The page stores `{deviceId, key, base}` in `localStorage` and calls `hello {name}`; the device becomes active.
3. Pending devices expire after 10 minutes. Each device can be renamed or revoked; revoking deletes its key.

### Transport 2: iCloud Drive relay (Shortcuts, works away from home)

- Folder `~/Library/Mobile Documents/com~apple~CloudDocs/Glide/Phone/` (env `GLIDE_PHONE_RELAY_DIR` for tests), with
  `inbox/` and `outbox/`. Apple encrypts it in transit and at rest; no extra keys.
- A shortcut writes `inbox/<id>.json`: `{"v":1,"id":"<id>","action":"<name>","args":{…},"from":"Shortcuts"}`.
- Glide watches the folder, downloads iCloud placeholders when needed, runs the action with caller
  `{deviceId:"icloud", deviceName:"Shortcuts", transport:.relay}`, writes `outbox/<id>.json`
  (`{"id","ok",…}` as on the LAN), and deletes the inbox file. Outbox files older than 10 minutes are pruned.
- **Clipboard mirror** (opt-in, Clipboard group): Glide keeps `clipboard.json` (`{"text","at"}`, text only, ≤ 64 KB) in
  that folder up to date, so "Get Mac Clipboard" is a plain file read on the phone.
- Glide generates the Shortcuts (Send to Mac, Send Clipboard to Mac, Get Mac Clipboard, Run Glide Workflow,
  Ask Glide Agent) and signs them with `shortcuts sign` when the user asks; never in tests.

## Actions

| Action | Owner | Group | Risk | Relay | Args → result |
|---|---|---|---|---|---|
| `hello` | core | core | safe | yes | `{name}` → `{mac:{name,version}, device:{id,name}}` |
| `status` | core | core | safe | yes | → `{mac, timers:[…], focus, battery}` |
| `search` | core | core | safe | yes | `{query, limit}` → `{items:[{id,title,subtitle,kind,acceptsArgument}]}` |
| `run` | core | core | confirm | yes | `{id, argument?}` → `{ok, message?}` |
| `timers.start` / `timers.stop` | core | core | safe | yes | `{minutes?, seconds?, name?}` / `{id}` |
| `workflows.list` / `workflows.run` | core | core | safe / confirm | yes | → `{workflows:[{id,name}]}` / `{id or name, input?}` → `{result}` |
| `send` | core | core | safe | yes | `{text? , url? , image? (base64), to:"clipboard"/"note"/"open"}` |
| `clipboard.get` / `clipboard.set` / `clipboard.history` | core | clipboard | safe, sensitive | yes | → `{text}` / `{text}` / `{limit}` → `{items}` |
| `notes.append` | core | core | safe | yes | `{text}` |
| `mac.lock` / `mac.sleep` | core | core | safe / confirm | yes | |
| `media` | core | remote | safe | no | `{key: playpause, next, prev, volup, voldown, mute}` |
| `pointer.move` / `pointer.click` / `pointer.scroll` | web | remote | safe | no | `{dx,dy}` / `{button, double}` / `{dx,dy}` |
| `keys.press` / `type.text` / `slides.next` / `slides.prev` | web | remote | safe | no | `{key, modifiers}` / `{text}` |
| `files.search` / `files.get` | web | files | safe | no | `{query}` → `{files:[{path,name,size,kind}]}` / `{path}` → `{name, type, data}` (≤ 25 MB) |
| `agent.ask` | notify | agent | confirm | yes | `{prompt}` → `{text, pending?:[…]}` |
| `approvals.list` / `approvals.respond` | notify | core | safe | no | → `{pending:[…]}` / `{id, decision}` |
| `notify.test` | notify | notify | safe | yes | |

The Remote control group's actions are safe one by one but the whole group is off until the user turns it on.

## Notifications on the iPhone (ntfy)

Glide can tell your iPhone when a timer finishes, an automation fails, or something waits for your OK. It uses
[ntfy](https://ntfy.sh), a free, open-source notification service, so there is no Glide app to install. It is off
until you turn it on.

Set it up:

1. On the iPhone, install **ntfy** from the App Store (free).
2. On the Mac, open Glide → Settings → iPhone → Notifications and turn on **Send notifications to my iPhone**.
   Glide creates a private topic (`glide-` followed by 32 random characters) and shows it with a QR code.
3. Scan the QR code with the iPhone's Camera, or in the ntfy app tap **+** and enter the topic. Leave the server as
   `ntfy.sh` unless you run your own.
4. Click **Send Test Notification**. It should arrive within a few seconds.
5. Choose what to get: timers, failed automations, and requests that wait for your OK.

Good to know:

- **The topic is the password.** Anyone who knows it can read these notifications, so don't share it. Click
  **Regenerate Topic** if it leaks, then subscribe to the new one.
- Notifications only say what happened ("Tea is done.", "Glide Agent wants to: Open URL."). They never include
  clipboard text, file contents, what you asked Glide Agent, or error details.
- **Approve from the notification.** While Glide Remote is on (same Wi-Fi), a request notification has a
  **Review** button that opens Glide Remote at `http://<Mac>:<port>/#approve=<id>`. Away from home the link won't
  open; answer on the Mac instead. MCP requests are always answered on the Mac.
- **Your own server.** Enter its https address (for example `https://ntfy.example.com`). If your topic needs a
  login, create an access token in ntfy and paste it into **Access token**; Glide keeps it in the Keychain.
  Plain http is refused (except 127.0.0.1 for tests).
- Glide sends at most 6 notifications a minute and retries a failed send 3 times (1, 2 and 4 seconds apart, or as
  the server asks). Failures are logged and shown under **Last notification**; they never slow Glide down.

### Glide Agent and approvals from the phone 

- `agent.ask {prompt, conversationId?}` starts a normal Glide Agent run in its own conversation (`phone-…`). Look-ups
  run at once; **every** step that changes something waits for approval, even tools the Mac's always-allow list
  covers. Read-only mode, the 12 tool-call cap and the agent's rate limit apply unchanged. It returns when the run
  finishes or stops at a confirmation (at most 90 s): `{text, status, runId, conversationId, steps:[{title,status,mutating}],
  pending?:[item]}`. `status` is `done`, `error`, `cancelled`, `confirming`, or `running` (still busy after 90 s:
  call `agent.ask {runId}` to check again). Follow-ups pass the `conversationId` of a phone conversation.
- `approvals.list` → `{pending:[item]}`, newest first. An item is
  `{id, source:"phone"|"agent", deviceName, action, title, summary, at}`; agent items also carry `runId` and
  `steps` (tool titles). Agent confirmations of runs started on the Mac are listed too while the Glide Agent group is on.
- `approvals.respond {id, decision:"allow"|"always"|"deny"}` (LAN only). Phone items → `{ok, decision}`. Agent items
  → the run's next state, same shape as `agent.ask`, plus `decision`. For agent items "always" counts as "allow"
  (the phone never adds tools to the agent's always-allow list). Unknown or already answered ids → `not-found`.
- `notify.test` → `{sent:true}`, or an error with code `off` (not set up) or `failed` (message says why).
- Test channel: `invoke phone notify.state | notify.setSettings | notify.regenerateTopic | notify.setToken | notify.test | notify.pending`.
  Settings live in `settings.features.phone.notify` (`enabled, server, topic, timer, automation, confirmation`).
  Headless runs keep the token in memory (`GLIDE_PHONE_NTFY_TEST_TOKEN` seeds it).

## How the core works (LAN server, pairing, gate)

Code: `Sources/Features/Phone/PhoneCore*.swift`. Tests: `Tests/PhoneCoreTests`.

- **Shared API** (for the other phone modules): `feature.perform(action, args:, caller:)` (the only way to run an
  action), `isGroupEnabled(group)`, `lanBaseURL` (`http://<LAN IP>:<port>` while the server runs, else nil),
  `confirmations` (`pending`, `respond(id, decision:)`, `addObserver`), plus `addMethod(name) { args in … }`
  (`invoke phone <name>`) and `addSettingsSection(id:order:) { AnyView(…) }` (Settings → iPhone).
- **Server**: runs only while "Let my iPhone use Glide" is on. Headless runs never listen unless `GLIDE_PHONE_HOST`
  is set; a pinned host never advertises on Bonjour. Static files need no key; `POST /api` is the only data path.
  Limits: 32 MB bodies (413), 64 KB headers (431), 48 connections, a connection idle for 30 s is closed (waiting on
  a confirmation does not count). HTTP parsing reuses the MCP server's `MCPHTTPParser`.
- **Envelope**: `PhoneEnvelope.seal/open/request/response` (public in GlideFeatures, usable from any test target).
  Order of checks: device known (active, or pending and not expired) → tag (CryptoKit, constant time) → ts within
  ±120 s → nonce unseen for that device. Every failure is the same `401 {"error":"unpaired"}`. The nonce is cached
  only after the tag checks, so junk cannot fill the cache. Fixed vector for `Web/crypto.js`: key bytes `00…1f`,
  nonce bytes `a0…ab` (`oKGio6Slpqeoqaqr`), device `dev1`, direction `req`, plaintext `{"action":"hello"}` →
  `c = d4kZPDmPrcOCNdF8mZaRlL8j62IU6iMWCUR-ysGOQbz0vg`.
- **Pairing**: a pending device lives in memory only; its key reaches the Keychain (service "Glide Phone Devices",
  account = device id) on the first valid request, which also closes the QR on the Mac. `hello {name}` names the
  device only while it is still called "iPhone", so a rename on the Mac sticks. Revoking deletes the key, the
  device's "always" grants and its nonce cache. Headless runs keep keys in `<data>/features/phone/headless-keys.json`
  (0600), never the Keychain. `devices.json` holds names and last-seen times, never keys.
- **Gate**: group switch off → Off; else the user's per-action choice; else sensitive outside a switchable group →
  Off, `confirm` → Ask, `safe` → Allow. "Always" from a confirmation is stored per device. Confirmation summaries
  are short and never contain clipboard text or file contents. The request log (`requests.json`, 300 entries)
  keeps time, device, transport, action, outcome, error code and approval only.
- **Core actions** reuse features through `callFeature` / `executeItem`, so headless runs record effects. `run`
  refuses `phone:`, `agent:` and `mcp-server:` items. `send to:"open"` opens only http(s) and mailto links. Notes go
  to one note titled "From iPhone". `media` volume keys reuse the System Commands items; play/pause/next/prev post
  media key events (recorded as `phone.media` in headless runs).
- **Test hooks** (`invoke phone …`): `state`, `setEnabled`, `setSettings`, `setGroup {group, enabled}`,
  `setPolicy {name, policy}`, `resetPolicies`, `revokeAlways`, `beginPairing`, `cancelPairing`, `devices`,
  `renameDevice`, `revokeDevice`, `pending`, `respond {id?, decision}`, `log`, `clearLog`, `snapshotSettings`.
  Headless only: `pairDevice {name?, activate?}` → `{deviceId, key, base}` and `perform {action, args, deviceId?,
  deviceName?, transport?}`.

## Shortcuts 

Settings → iPhone → **Shortcuts and iCloud** turns the relay on (settings key `relay`). **Share the Mac clipboard**
(`clipboardMirror`) also needs the Clipboard group. **Add Shortcuts to iPhone** signs the five shortcuts with
`shortcuts sign --mode anyone`, saves them to `~/Downloads/Glide Shortcuts` and shows them in Finder. AirDrop them
to the iPhone, or put them in iCloud Drive and tap them in the Files app.

How the relay behaves (`Sources/Features/Phone/PhoneRelay*.swift`):

- Folders: Glide watches both `iCloud Drive/Glide/Phone` (the contract folder) and `iCloud Drive/Shortcuts/Glide/Phone`.
  A shortcut that saves a file without asking where can only save inside the Shortcuts folder, so the generated
  shortcuts use the second one. A shortcut you build by hand can use either. `GLIDE_PHONE_RELAY_DIR` replaces both.
- Every inbox file that is not hidden is read as JSON (a plist works too). The id comes from the file, or from the
  file name when it has none. Ids may use letters, digits, `.`, `-` and `_` (64 at most).
- A file that is not valid JSON yet is treated as still syncing for 15 seconds, then answered with `bad-request`.
  Files over 25 MB get `too-large`. Requests older than an hour (the Mac was off) get `expired` and do not run.
- A request id that was already answered is never run again: the earlier reply is written back.
- `.<name>.icloud` placeholders are downloaded with `startDownloadingUbiquitousItem`.
- Replies carry an extra `text` field: the answer, message or error in one line, so a shortcut can show it without
  parsing. When Glide Agent waits for an approval, `text` says to approve it in Glide Remote or on the Mac.
- Outbox replies are written atomically (a hidden temp file, then a rename) and deleted after 10 minutes.
- The clipboard mirror follows Clipboard History's watcher (no second poller; when Clipboard History is off, Glide
  checks the change count itself every 1.5 seconds). It skips concealed and transient types (password managers),
  ignored apps, paused history and text over 64 KB, keeping the last text. Turning it off deletes `clipboard.json`.

### The five shortcuts

| Shortcut | What it does | Needs |
|---|---|---|
| Send to Glide | Share sheet for text, links and photos. Asks "Copy to the Mac clipboard", "Open on the Mac" or "Add to a Glide note", then writes `send`. Photos become JPEG and go to the clipboard. | nothing extra |
| Send Clipboard to Mac | Writes `clipboard.set` with the iPhone clipboard, waits up to 30 s for the reply and shows it. | Clipboard group |
| Get Mac Clipboard | Reads `clipboard.json` and copies its `text` to the iPhone. No request, so it works even while the Mac sleeps (with the last text). | Clipboard group and Share the Mac clipboard |
| Run Glide Workflow | Writes `workflows.run {name}`. Uses its input as the workflow name (for automations), or asks. | Set Run a workflow to Allow if nobody is at the Mac |
| Ask Glide Agent | Asks for a question (or takes its input), writes `agent.ask`, waits up to 2 minutes and shows the answer. | Glide Agent group |

### Building them by hand

Use this when you can't import the files. Every request is a Dictionary saved as `Glide/Phone/inbox/<id>.json`:

1. **Format Date**: Current Date, Custom format `yyyyMMddHHmmssSSS`.
2. **Random Number** between 100000 and 999999.
3. **Text**: `Formatted Date-Random Number`. Rename the variable to **Request ID**.
4. **Dictionary** with: `v` (Number) 1, `id` (Text) Request ID, `action` (Text) the action name, `args` (Dictionary)
   the arguments below, `from` (Text) `Shortcuts`.
5. **Set Name** of Dictionary to `Request ID.json`, with "Don't Include File Extension" on.
6. **Save File**: turn off Ask Where to Save, Destination Path `Glide/Phone/inbox/`, Overwrite on. (If you pick a folder
   instead, choose `iCloud Drive/Glide/Phone/inbox` or `iCloud Drive/Shortcuts/Glide/Phone/inbox`.)

To wait for the answer: **Repeat** 30 times { **Wait** 2 seconds, **Get File** `Glide/Phone/outbox/Request ID.json`
(Error If Not Found off), **If** File has any value { **Get Dictionary Value** `text`, **Show Result**, **Delete** File,
**Stop This Shortcut** } }.

- **Send to Glide**: in the shortcut's details turn on Show in Share Sheet (Text, URLs, Images). Add **Choose from Menu**
  (Clipboard, Open, Note) and set `args` to `text` = Shortcut Input (or, for a photo: Convert Image to JPEG,
  Base64 Encode with line breaks None, `image` = the encoded text) and `to` = `clipboard`, `open` or `note`.
  Action `send`.
- **Send Clipboard to Mac**: **Get Clipboard**, then the request with action `clipboard.set` and `args` `text` = Clipboard.
- **Get Mac Clipboard**: **Get File** `Glide/Phone/clipboard.json` (Error If Not Found off), **Get Dictionary Value**
  `text`, **Copy to Clipboard**. No request needed.
- **Run Glide Workflow**: **If** Shortcut Input has any value use it, otherwise **Ask for Input** "Which Glide workflow?".
  Action `workflows.run`, `args` `name` = that text. In the details, set it to receive Text.
- **Ask Glide Agent**: **Ask for Input** "Ask Glide", action `agent.ask`, `args` `prompt` = Provided Input, then wait for
  the answer as above (Repeat 60 times for two minutes).

### iPhone automations that run a Glide workflow

In the Shortcuts app, open Automation, tap **+** and pick a trigger, choose **Run Immediately**, and add the action
**Run Shortcut** → Run Glide Workflow, with Input set to a Text action that holds the workflow's exact name.

- **Leave home**: trigger Leave, location Home (for example a "Leaving home" workflow that locks the Mac and pauses music).
- **Connect to CarPlay**: trigger CarPlay, Connects.
- **Alarm stopped**: trigger Alarm, Is Stopped, any alarm or your wake-up alarm (for example a "Good morning" workflow).

Workflows ask on the Mac before they run by default, and nobody may be there to answer. For workflows you run from
automations, set **Run a workflow** to Allow in Settings → iPhone. Requests land as soon as iCloud Drive syncs,
usually within seconds, and the Mac must be awake (or wake for network access).

## Implementation notes

- Settings → iPhone → Notifications is added with `addSettingsSection(id: "notify", order: 50)`,
  and the `notify.*` test-channel methods with `addMethod`.
- Notification links open `<lanBaseURL>/#approve=<id>`. The web app should, after
  unlocking, call `approvals.list`, show the item with that id (Allow / Deny), and answer with `approvals.respond`.
  For agent items the response carries the run's next state (`text`, maybe a new `pending`), so show it.
- The "Ask Glide Agent" shortcut gets `{text, status, pending?}`. Approvals are
  LAN-only, so when `status` is `confirming` the shortcut should say "Approve it in Glide Remote or on the Mac".
- Additive hooks in other features: `GlideFeatureEvents` posts from Timers (finished), Automations
  (unattended failure), Glide Agent (confirmation waiting) and the MCP server (confirmation waiting). Glide Agent's
  `start` invoke takes `confirmAll: true` (every state-changing step asks; used for phone runs).
- Contract additions in Transport 2, all additive: Glide also watches
  `iCloud Drive/Shortcuts/Glide/Phone` (generated shortcuts can't save to the contract folder without a folder picker);
  replies carry a `text` summary; requests older than an hour are answered `expired`; any non-hidden inbox file is read
  (Shortcuts may name it `<id>.json` or `<id>.json.json`). See "Shortcuts ".
- Settings → iPhone → Shortcuts and iCloud uses `addSettingsSection(id: "relay", order: 40)`
  and test-channel methods `relay.status`, `relay.set {relay?, clipboardMirror?}`, `relay.scan`, `relay.prune`,
  `relay.writeShortcuts {dir}`. Settings keys `relay` and `clipboardMirror` live in the phone bag and are written with
  `context.setSettings` directly, so `PhoneCore.applySettings`'s clean-up must keep them (it does not touch them today).
  Signed shortcuts are saved to ~/Downloads; serving them at `/shortcuts/<name>.shortcut` from the LAN server would
  need an extra-route hook, which is not needed now.
- The `send` shortcut sends `text` (a shared link arrives as its text) and `to`; `send` with
  `to: "open"` already accepts a link in `text`. The clipboard mirror needs one additive line in ClipboardFeature
  (`PasteboardChangeObservers.notify`).
- `PhoneWebAssets` keeps `files` (text, `body: String`) and adds `binary` (base64) plus
  `PhoneWebAssets.asset(path) -> (type, data)?`. The server should serve through `asset(_:)` so `/icon-180.png`
  (the apple-touch-icon) is served; with `files[path]` only, the icon is a 404.
- Sizes: `files.get` data is base64 inside the envelope's base64url, so a 25 MB file is a ~47 MB HTTP
  response (the server doesn't cap responses). Photos sent by the web app are
  scaled to 4096 px JPEG above 12 MB so the request stays under the 32 MB body limit.
- Extra error codes from the web actions: `needs-permission` (no Accessibility for Remote control),
  `not-allowed` (path outside home, in ~/Library or hidden), `too-large`, `missing`, `unreadable`. `pointer.scroll`
  `{dx,dy}` is the finger movement in points (natural scrolling). Headless: `GLIDE_HEADLESS_AX=0` simulates no
  Accessibility, `GLIDE_PHONE_FILES_HOME` moves the files root; effects `remote-move/click/scroll/key/type`.
