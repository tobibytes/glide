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
   (`view` and `no-view`; `menu-bar` commands are skipped with a warning), command `arguments`
   (`text`, `password`, `dropdown`), extension and command-scoped `preferences` (`textfield`,
   `password`, `checkbox`, `dropdown`; `appPicker`/`file`/`directory` become text fields).
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
| `List` | sections, items (title/subtitle/icon/keywords/accessories: text, tag, date, icon, colours), `isShowingDetail` + `List.Item.Detail` (markdown, metadata), `isLoading`, `filtering`, `onSearchTextChange`, controlled `searchText`, `searchBarPlaceholder`, `searchBarAccessory` (`List.Dropdown` with sections, `storeValue`; ⌘P), `pagination`, `onSelectionChange`, `List.EmptyView`, `navigationTitle` | `selectedItemId`, `throttle` (always debounced ~140 ms), `quickLook`, keeping section order while filtering |
| `Grid` | columns / `itemSize`, `aspectRatio`, `fit`, `inset`, sections, items (image / colour / emoji content, title, subtitle, keywords), dropdown, pagination, empty view | per-section column overrides, item accessories are shown only as icons |
| `Detail` | markdown, `isLoading`, `navigationTitle`, metadata (`Label`, `Link`, `TagList`, `Separator`), actions | markdown tables, HTML |
| `Form` | `TextField`, `PasswordField`, `TextArea`, `Checkbox`, `DatePicker` (date / date-time), `Dropdown` (+ sections), `TagPicker`, `FilePicker` (path field + chooser), `Separator`, `Description`; `value`/`defaultValue`/`onChange`/`onBlur`/`error`/`info`/`autoFocus`/`storeValue`; actions on ⌘K, ⌘⏎ runs the first | `enableDrafts`, `Form.LinkAccessory`, `focus()`/`reset()` on field refs are no-ops, dropdown `onSearchTextChange` |
| `ActionPanel` / `Action` | `Action` (`onAction`), `CopyToClipboard` (text/html, `onCopy`), `Paste`, `OpenInBrowser`, `Open` (+ `application`), `OpenWith` (opens with the default app), `ShowInFinder`, `Push` (`onPush`/`onPop`), `SubmitForm`, `Trash`; `ActionPanel.Section`/`Submenu` (flattened, section shown in ⌘K), `shortcut` (incl. `Keyboard.Shortcut.Common`), `style: Destructive`, icons | `CreateSnippet`, `CreateQuicklink`, `ToggleQuickLook`, `PickDate` show "not supported" |
| Navigation | `useNavigation()` push/pop, `popToRoot`, `closeMainWindow`, `clearSearchBar`, `launchCommand` (same or another installed extension, `arguments`, `context` → `launchContext`) | `launchType: background`, `interval` commands |
| Feedback | `showToast` (incl. legacy signature) returning an updatable `Toast` (`style`/`title`/`message` setters), `showHUD`, `confirmAlert` (modal in the launcher; native dialog for no-view), `Alert.ActionStyle` | toast `primaryAction`/`secondaryAction`, `toast.hide()` |
| Data | `LocalStorage`, `Cache` (synchronous, per extension, `subscribe`), `Clipboard` (`copy`/`paste` with text/html/file, `readText`, `read`, `clear`), `getPreferenceValues` (extension + command scope), `environment` (`extensionName`, `commandName`, `commandMode`, `assetsPath`, `supportPath`, `launchType`, `appearance`, `textSize`, `raycastVersion`, `isDevelopment`, `canAccess`) | `Clipboard.read` returns text only, `concealed`/`transient` copies |
| System | `open`, `showInFinder`, `trash`, `getSelectedText` (through the native helper), `getApplications` (scans /Applications folders), `openExtensionPreferences`/`openCommandPreferences` | `getSelectedFinderItems`, `getFrontmostApplication`, `getDefaultApplication`, `WindowManagement`, `BrowserExtension`, `AI`, `OAuth` (reject with a clear error) |
| Images | `Icon.*` (≈300 names mapped to glyphs; unknown names render ▫️), `Color.*`, `{ source, tintColor }` (tinted circles become colour dots), `{ source: { light, dark } }`, `{ fileIcon }`, URLs, `assets/` files, `Image.Mask` (ignored) | tinting arbitrary icons |
| `@raycast/utils` | `usePromise` (incl. pagination, `mutate` with optimistic updates, `abortable`, `execute`, `onData`/`onError`/`onWillExecute`), `useCachedPromise` (`keepPreviousData`), `useFetch` (incl. paginated URL functions and `mapResult`), `useCachedState`, `useLocalStorage`, `useForm` + `FormValidation`, `useExec`, `runAppleScript`, `showFailureToast`, `getFavicon`, `getAvatarIcon`, `getProgressIcon` | `useSQL`, `useStreamJSON`, `useAI`, `OAuthService`/`withAccessToken` throw "not supported" |
| Commands | `view`, `no-view` (default export called with `{ arguments, launchType, launchContext }`), arguments, preferences | `menu-bar` (skipped on import), React DOM / `react-dom` usage |

Fixtures that exercise most of this live in `extensions-examples/raycast-fixtures/`; the
end-to-end check is `pnpm build && node scripts/ext-raycast-e2e.mjs`.
