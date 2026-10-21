# Writing a Glide extension

An extension is a folder with a `package.json` and one JavaScript file per command. Glide runs
each command in its own process and renders what the command describes — there is no React and
no build step required.

Glide also runs **Raycast extensions** (React + `@raycast/api`): see
[Running Raycast extensions](#running-raycast-extensions) at the end of this guide.

> **Security.** Extensions run with your user's privileges in a separate process (an Electron
> utility process): they can read and write your files, run programs and use the network.
> Installing an extension from a URL runs that author's code. Only install extensions you trust.

## 5-minute quick start

```
hello-glide/
  package.json
  hello.js
```

`package.json`:

```json
{
  "name": "hello-glide",
  "version": "1.0.0",
  "glide": {
    "title": "Hello Glide",
    "description": "My first extension",
    "icon": "👋",
    "commands": [
      { "name": "hello", "title": "Say Hello", "mode": "view", "keywords": ["greet"] }
    ]
  }
}
```

`hello.js` (CommonJS):

```js
const { List, Detail, Action, showToast } = require("@glide/api");

module.exports = async function hello(ctx) {
  ctx.render(
    List({
      searchPlaceholder: "Filter greetings…",
      items: ["Hello", "Bonjour", "Hola"].map((word) => ({
        title: word,
        subtitle: "Greeting",
        icon: "💬",
        actions: [
          Action.CopyToClipboard(word),
          Action.Push("Show Details", () => Detail({ markdown: `# ${word}\n\nSaid **${word}**.` })),
          Action.Run("Toast It", () => showToast({ title: word })),
        ],
      })),
    }),
  );
};
```

Install it: launcher → **Manage Extensions** → **Install from Folder…** (or Settings → Extensions →
*Choose Folder…*), then search "Say Hello". After editing your files, run **Update** on the
extension (it re-copies the folder).

## Manifest (`package.json` → `glide`)

| Field | Notes |
| --- | --- |
| `name` (top level) | 1–64 letters, digits, `.`, `_`, `-`. Becomes the install folder name. |
| `glide.title` | Required. Shown as the command subtitle in search. |
| `glide.description`, `glide.icon` | Icon: an emoji, an https URL, `#rrggbb`, or a file in `assets/`. |
| `glide.commands[]` | `name`, `title`, optional `subtitle`, `description`, `keywords[]`, `mode` (`"view"` default or `"no-view"`), `arguments[]` (`{ name, placeholder, required }`). |
| `glide.preferences[]` | `{ name, title, type: "textfield" \| "password" \| "checkbox" \| "dropdown", default, required, description, data }`. `data` is `[{ value, title }]` for dropdowns. |

Each command's code is looked up in this order: `dist/<name>.js`, `dist/<name>.cjs`, `<name>.js`,
`<name>.cjs`, `src/<name>.js`, `src/<name>.cjs`. Use CommonJS (`module.exports = …` or
`exports.default = …`); if you write TypeScript, compile to CommonJS in `dist/` and treat
`@glide/api` as external. Types: point your editor at `src/extension-api/index.d.ts` (or add
`"@glide/api": "file:<glide>/src/extension-api"` as a dev dependency).

When a required preference has no value, Glide shows the preferences form before the first run.
When a command has arguments, the text typed after the command name in search (⇥ to enter
argument mode) fills them: one word per argument, the last argument takes the rest. A missing
required argument opens a small form.

## The command function

```js
module.exports = async function (ctx) {
  ctx.arguments;   // { [argumentName]: string }
  ctx.preferences; // same as getPreferenceValues()
  ctx.environment; // see below
  ctx.render(view); // show or replace the root view; call again to re-render
};
```

- **no-view** commands run to completion and exit (use `showHUD` for feedback). They are stopped
  after 30 s without any API activity.
- **view** commands call `ctx.render(...)` (as often as they like). The process stays alive while
  the view is on screen and is stopped about 1.5 s after the user leaves it (or after 30 s if the
  view is never shown). Render before your function returns: a view command that returns without
  rendering just closes.
- A thrown error shows an error view (view commands) or an error toast (no-view).

## Views

All views are plain objects; functions inside them stay in your process and are called by id.

### `List({ items, searchPlaceholder?, isLoading?, emptyText?, onSearchTextChange? })`

Items: `{ id?, title, subtitle?, icon?, accessories?: [{ text?, tag?, icon?, tooltip? }], keywords?, section?, detail?: { markdown, metadata? }, actions? }`.

- Without `onSearchTextChange`, Glide filters items locally by title, subtitle, keywords and
  accessory text as the user types.
- With `onSearchTextChange(text)`, Glide stops filtering and calls it (debounced ~140 ms) on every
  change; re-render with your results. Set `isLoading: true` while fetching.
- If any item has `detail`, the list shows a right-hand preview pane (markdown + metadata).
- Give items stable `id`s so the selection survives re-renders.

### `Detail({ markdown, title?, metadata?: [{ label, text, link? }], actions?, isLoading? })`

Markdown supports headings, paragraphs, lists, fenced code, blockquotes, rules, `code`,
**bold**, *italic*, links and https images. Raw HTML is shown as text, never interpreted.
Only http(s)/mailto links are clickable. ↑/↓ (or j/k in vim normal mode) scroll.

### `Form({ fields, onSubmit, submitTitle?, description?, isLoading? })`

Fields: `{ id, title, type: "text" | "password" | "textarea" | "checkbox" | "dropdown", placeholder?, default?, required?, options?: [{ value, title }], info? }`.
⏎ moves to the next field (submits on the last), ⌘⏎ submits, ⎋ goes back. `onSubmit(values)` gets
`{ [id]: string | boolean }`.

## Actions

The first action runs on ⏎, the second on ⌘⏎, all of them are in the ⌘K panel. Every action
takes an optional last argument `{ title?, shortcut?, icon? }` (`shortcut` is a display string such
as `"⌘D"` or `"⇧⌘C"` and also triggers the action).

| Action | Effect |
| --- | --- |
| `Action.OpenInBrowser(url)` | Opens an http(s)/mailto URL and closes Glide. |
| `Action.CopyToClipboard(text)` | Copies, closes Glide and flashes "Copied to Clipboard". |
| `Action.Paste(text)` | Pastes into the frontmost app (needs Accessibility permission). |
| `Action.Push(factory)` / `Action.Push(title, factory)` | `factory(nav)` returns a view that is pushed; `nav.render(view)` re-renders it, `nav.pop()` closes it. |
| `Action.Run(title, handler)` | Runs `handler()` in your process (re-render from it if needed). Errors become a failure toast. |

## Utilities

```js
const { showToast, showHUD, closeMainWindow, open, getPreferenceValues,
        Clipboard, LocalStorage, environment, fetch } = require("@glide/api");

await showToast({ style: "success" | "failure" | "animated", title, message }); // or showToast(title, message)
await showHUD("Done");            // hides Glide and flashes a message
await closeMainWindow();
await open("https://…" | "/path/to/file" | "~/Downloads" | "app-scheme://…");
await Clipboard.copy("text"); await Clipboard.paste("text"); const text = await Clipboard.read();
await LocalStorage.setItem("key", { any: "json" });
await LocalStorage.getItem("key"); await LocalStorage.removeItem("key");
await LocalStorage.allItems(); await LocalStorage.clear();
environment.extensionName; environment.commandName; environment.assetsPath;
environment.supportPath; // a writable folder for your extension
const res = await fetch("https://api.example.com"); // Node's global fetch
```

`LocalStorage` is a per-extension JSON file managed by Glide
(`<Glide data>/features/extensions/storage/<name>.json`). Preferences are stored in
`…/preferences/<name>.json` with owner-only permissions.

## Distributing

- **Git:** push the folder (with built `dist/` files if you compile) to a repository; users install
  it with *Install from Git URL* and update it with *Update* (`git pull --ff-only`).
- **Registry:** host a JSON index and set Settings → Extensions → *Store index URL*:

```json
[
  { "name": "hello-glide", "title": "Hello Glide", "description": "My first extension",
    "author": "you", "icon": "👋", "repo": "https://github.com/you/hello-glide.git",
    "version": "1.0.0", "commands": [{ "name": "hello", "title": "Say Hello" }] }
]
```

The index is fetched only when the store is opened. Installing a registry entry clones its `repo`.

## Examples

See `extensions-examples/`: `uuid-generator` (no-view + HUD + checkbox preference),
`color-converter` (List + `onSearchTextChange` + argument), `timezones` (local filtering,
LocalStorage, `Action.Run`, dropdown preference), `hacker-news` (network, list detail pane,
`Action.Push` with `nav.render`), `github-search` (network search-as-you-type, password preference).

## How it works

Main forks `runner.cjs` with Electron's `utilityProcess` for each command run. The runner installs a
`Module._resolveFilename` hook so `require("@glide/api")` resolves to Glide's API shim, loads the
command module and calls its default export. Views are serialised to JSON (functions become handler
ids) and sent over `process.parentPort`; the launcher renders them and sends back
`invoke`/`search`/`submit` messages. Side effects (clipboard, open, storage, HUD) are requests that
main performs and answers.

## Running Raycast extensions

Glide can run extensions written for Raycast — React components that import `@raycast/api` and
`@raycast/utils` — usually without changes.

> **Importing runs that folder's code.** Glide bundles the folder's `src/` files together with
> whatever is in its `node_modules`, and each command then runs with your user's privileges. Only
> import extensions whose source you trust. Glide never downloads anything: it does not run
> `npm install`, and "Install from Raycast Store…" only opens raycast.com in your browser.

**Import:** launcher → *Manage Extensions* → **Import Raycast Extension Folder…** (⏎) → pick the
folder that contains the extension's `package.json`. ("Install from Folder…" also detects Raycast
folders.) If the extension has dependencies besides `@raycast/api`/`@raycast/utils`/`react`, run
`npm install` in that folder yourself first; a missing package is reported by name
(`Missing dependency "date-fns" (src/index.tsx:3) …`). *Update* rebuilds from the same folder.

What happens on import (`src/main/features/extensions/raycast-*.ts`):

1. `package.json` is translated: top-level `title`, `icon` (a file in `assets/`), `commands`
   (`view`, `no-view` and `menu-bar`, with `interval` for no-view / menu-bar commands), command
   `arguments` (`text`, `password`, `dropdown`), extension and command-scoped `preferences`
   (`textfield`, `password`, `checkbox`, `dropdown`; `appPicker`/`file`/`directory` become text
   fields). Command-scoped preferences are stored as `<command>/<name>`, so two commands (or a
   command and the extension) can declare the same name without sharing a value.
2. Each command's `src/<command>.tsx|ts|jsx|js` is bundled with esbuild into
   `<installed>/<name>/.glide-build/<command>.cjs` (CommonJS, Node target, automatic JSX).
   `react`, `react/jsx-runtime`, `@raycast/api` and `@raycast/utils` stay external; everything
   else is resolved from the folder (its `node_modules`, `tsconfig` paths). A folder without
   sources but with a `ray build` output (`dist/<command>.js`) is used as is.
3. Only `package.json`, `assets/`, README/CHANGELOG/LICENSE and the bundles are copied into Glide.

Required preferences are asked for on the first run (a form generated from the manifest); all of
them are editable later with ⌘, on the command or in Settings → Extensions.

### How it works

Glide has no `react-reconciler`, so the extension process uses a small React-compatible runtime
(`src/extension-api/raycast/react.ts`): JSX/`createElement`, function and class components,
`useState`/`useReducer`/`useEffect`/`useLayoutEffect`/`useMemo`/`useCallback`/`useRef`/
`useContext`/`useId`/`useSyncExternalStore`/`useImperativeHandle`/`use`, context, `memo`,
`forwardRef`, `Fragment`, `Children`, error boundaries and basic `Suspense`/`lazy`. `require("react")`
inside the extension resolves to it. Raycast components (`List`, `List.Item`, `Action.Push`, …)
are host components; after every commit the host tree is serialised (`raycast/serialize.ts`) to the
same JSON view model Glide's own API uses, with functions replaced by handler ids that stay stable
while a component stays mounted. The launcher renders it natively (`RunView`, `GridBody`,
`FieldsForm` — vim/arrow keys work like everywhere else) and sends UI events back
(`invoke`/`event`/`submit`). Each `useNavigation().push` is a new root at the next depth.

### Compatibility

| Area | Supported | Notes / not yet |
| --- | --- | --- |
| `List` | sections, items (title/subtitle/icon/keywords/accessories: text, tag, date, icon, colours), `isShowingDetail` + `List.Item.Detail` (markdown, metadata), `isLoading`, `filtering`, `onSearchTextChange`, controlled `searchText`, `searchBarPlaceholder`, `searchBarAccessory` (`List.Dropdown` with sections, `storeValue`; ⌘P), `pagination`, `onSelectionChange`, `selectedItemId`, item `quickLook`, `List.EmptyView`, `navigationTitle` | `throttle` (always debounced ~140 ms), keeping section order while filtering |
| `Grid` | columns / `itemSize`, `aspectRatio`, `fit`, `inset`, sections, items (image / colour / emoji content, title, subtitle, keywords, `quickLook`), dropdown, pagination, `selectedItemId`, empty view | per-section column overrides, item accessories are shown only as icons |
| `Detail` | markdown, `isLoading`, `navigationTitle`, metadata (`Label`, `Link`, `TagList`, `Separator`), actions | markdown tables, HTML |
| `Form` | `TextField`, `PasswordField`, `TextArea`, `Checkbox`, `DatePicker` (date / date-time), `Dropdown` (+ sections), `TagPicker`, `FilePicker` (path field + chooser), `Separator`, `Description`; `value`/`defaultValue`/`onChange`/`onBlur`/`error`/`info`/`autoFocus`/`storeValue`; `enableDrafts` (unsent values are saved per command, restored as defaults and passed as `draftValues`; a submit clears them); field refs `focus()` / `reset()`; actions on ⌘K, ⌘⏎ runs the first | `Form.LinkAccessory`, dropdown `onSearchTextChange` |
| `ActionPanel` / `Action` | `Action` (`onAction`), `CopyToClipboard` (text/html, `onCopy`), `Paste`, `OpenInBrowser`, `Open` (+ `application`), `OpenWith` (opens with the default app), `ShowInFinder`, `Push` (`onPush`/`onPop`), `SubmitForm`, `Trash`, `PickDate` (date / date-time picker overlay, ⌘⌫ clears), `ToggleQuickLook` (⌘Y: in-launcher preview of the item's `quickLook` file — Quick Look thumbnail or text, never a Quick Look window), `CreateSnippet` / `CreateQuicklink` (prefilled form, ⌘⏎ saves into Glide's snippets / quicklinks); `ActionPanel.Section`, `ActionPanel.Submenu` (real nested ⌘K panels with `onOpen`; ⎋ goes back a level), `shortcut` (incl. `Keyboard.Shortcut.Common`), `style: Destructive`, icons | submenu `onSearchTextChange` / `filtering` / `isLoading` |
| Navigation | `useNavigation()` push/pop, `popToRoot`, `closeMainWindow`, `clearSearchBar`, `launchCommand` (same or another installed extension, `arguments`, `context` → `launchContext`, `type: LaunchType.Background`) | |
| Background | `interval` on no-view and menu-bar commands (`10s`…`1d`, ≥ 10 s): runs with `LaunchType.Background` (`environment.launchType`, the `launchType` prop). A command is activated by its first user launch or the **Activate Background Refresh / Menu Bar Item** action on the command (⌘K); the same action deactivates it. Background runs never show HUDs. | no-view runs need their required preferences and arguments filled in already |
| Menu bar | `mode: "menu-bar"` commands render `MenuBarExtra` (`title`, `icon`, `tooltip`, `isLoading`) with `MenuBarExtra.Item` (`title`, `subtitle`, `icon`, `shortcut`, `onAction`), `.Section` (title shown as a disabled row), `.Submenu`, `.Separator` as a status item (`src/main/menubar.ts`). The command's process stays alive while the item is shown so clicks run immediately; `interval` relaunches it in the background; active items are restored at launch. Errors show a ⚠️ item. | `alternate` items, `MenuBarExtra.Item` tooltips, opening the menu does not relaunch the command (Raycast does) |
| Feedback | `showToast` (incl. legacy signature) returning an updatable `Toast` (`style`/`title`/`message` setters), `primaryAction` / `secondaryAction` (buttons on the toast; their `shortcut` or ⌘T / ⌥⌘T), `toast.hide()`, `showHUD`, `confirmAlert` (modal in the launcher; native dialog for no-view), `Alert.ActionStyle` | |
| Data | `LocalStorage`, `Cache` (synchronous, per extension, `subscribe`), `Clipboard` (`copy`/`paste` with text/html/file, `readText`, `read`, `clear`), `getPreferenceValues` (extension + command scope, namespaced), `environment` (`extensionName`, `commandName`, `commandMode`, `assetsPath`, `supportPath`, `launchType`, `appearance`, `textSize`, `raycastVersion`, `isDevelopment`, `canAccess`) | `Clipboard.read` returns text only, `concealed`/`transient` copies |
| System | `open`, `showInFinder`, `trash`, `getSelectedText` (native helper), `getFrontmostApplication` (helper `app.frontmost`), `getSelectedFinderItems` (helper `finder.selection`; a helper without it rejects with "not supported"), `getApplications` (scans the Applications folders, bundle ids from XML `Info.plist`), `openExtensionPreferences`/`openCommandPreferences` | `getDefaultApplication`, `WindowManagement`, `BrowserExtension` |
| AI | `AI.ask` (promise + `"data"` stream events, `model`, `creativity`, `signal`) and `useAI` answer through Glide AI (Settings → AI; the key stays in the main process). Raycast model names containing Haiku/Sonnet/Opus map to the matching Claude model, others use Glide AI's model. `environment.canAccess(AI)` is true once a key is set. | `creativity` only adjusts the instructions; no image / file input |
| OAuth | `OAuth.PKCEClient` (`authorizationRequest` with S256 PKCE, `authorize`, `setTokens` / `getTokens` / `removeTokens`, `TokenSet.isExpired()`); the redirect URI is `glide://oauth?package_name=<extension>` (registered by packaged builds). Glide shows a "Sign in with …" card first; ⏎ opens the provider in the browser. Tokens are saved per extension in `<Glide data>/features/extensions/oauth/<name>.bin`, encrypted with the system keychain (safeStorage), and removed on uninstall. `@raycast/utils`: generic `OAuthService` (code exchange + refresh, `json` / `url-encoded` bodies, `personalAccessToken`, `onAuthorize`), `withAccessToken`, `getAccessToken` | provider presets (`OAuthService.github()` …); providers that only accept `https://` redirect URIs (Raycast's web redirect proxy) |
| Images | `Icon.*` (≈300 names mapped to glyphs; unknown names render ▫️), `Color.*`, `{ source, tintColor }` (tinted circles become colour dots), `{ source: { light, dark } }`, `{ fileIcon }`, URLs, `assets/` files, `Image.Mask` (ignored) | tinting arbitrary icons |
| `@raycast/utils` | `usePromise` (incl. pagination, `mutate` with optimistic updates, `abortable`, `execute`, `onData`/`onError`/`onWillExecute`), `useCachedPromise` (`keepPreviousData`), `useFetch` (incl. paginated URL functions and `mapResult`), `useCachedState`, `useLocalStorage`, `useForm` + `FormValidation`, `useExec`, `useAI`, `OAuthService`/`withAccessToken`/`getAccessToken`, `runAppleScript`, `showFailureToast`, `getFavicon`, `getAvatarIcon`, `getProgressIcon` | `useSQL`, `useStreamJSON` throw "not supported" |
| Commands | `view`, `no-view` (default export called with `{ arguments, launchType, launchContext }`), `menu-bar`, `interval`, arguments, preferences (extension + command-scoped) | React DOM / `react-dom` usage |

Fixtures that exercise most of this live in `extensions-examples/raycast-fixtures/`; the
end-to-end check is `pnpm build && node scripts/ext-raycast-e2e.mjs`.
