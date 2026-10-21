# Raycast-style fixture extensions

Small extensions written against `@raycast/api` / `@raycast/utils` (Raycast's manifest format,
`src/<command>.tsx`), used by Glide's tests and `scripts/ext-raycast-e2e.mjs` to exercise the
Raycast compatibility layer. They have no dependencies beyond the APIs Glide provides.

Import one: launcher → Manage Extensions → **Import Raycast Extension Folder…** → pick the folder.

| Folder | Exercises |
| --- | --- |
| `rc-fruits` | List (sections, accessories, detail pane, dropdown, filtering), Action.Push → Detail with metadata, shortcuts, preferences (required), arguments, a no-view command (Clipboard + showHUD) |
| `rc-notes` | Form (text, textarea, checkbox, dropdown, date, tags), useForm validation, Action.SubmitForm, LocalStorage, Toast updates, confirmAlert |
| `rc-colors` | Grid (sections, colour + emoji content, columns), useNavigation, Cache |
| `rc-fetch` | useFetch against a URL from preferences (the e2e test points it at a local 127.0.0.1 server), isLoading, onSearchTextChange, pagination |
