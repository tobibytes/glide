# Extension Store

Glide has no backend. The store is a static JSON index (`store/index.json` in this repository) plus
release tarballs. The index ships with Glide for the bundled examples, and Glide also fetches the remote
copy, but only when you open **Store** or press **Refresh (⌘R)**. Nothing installs automatically.

- Default index URL: `https://raw.githubusercontent.com/tobibytes/glide/main/store/index.json`
- Override it in Settings → Extensions → "Store index URL", or with the `GLIDE_STORE_URL` environment
  variable (used by tests and self-hosting). The setting wins over the variable.
- The fetched index is cached at `<userData>/features/extensions/store-cache.json`. Opening the store
  reuses a cache younger than 1 hour. ⌘R always fetches again. When you are offline, the cached index
  stays visible with a banner.
- Headless runs (`GLIDE_HEADLESS=1`) never fetch the public default URL.

## Index format (schema v1)

The schema is `store/schema.json`. The authoritative validator is
`src/main/features/extensions/store-schema.ts`. An invalid entry is dropped and the rest of the index
still loads. A `schemaVersion` newer than this Glide understands is rejected and the user is asked to
update Glide.

```jsonc
{
  "schemaVersion": 1,
  "updatedAt": "2026-10-21",
  "extensions": [
    {
      "id": "e2e-greeter",               // unique; lower-case [a-z0-9._-]
      "name": "e2e-greeter",             // package.json "name" (the install folder); must match the package
      "title": "E2E Greeter",
      "description": "…",
      "author": "you",
      "version": "1.1.0",                // semver; must equal the package's version for downloads
      "categories": ["Developer Tools"],
      "icon": "👋",                       // emoji or https image URL
      "kind": "glide",                   // or "raycast" (pre-built dist/<command>.js)
      "minGlideVersion": "0.2.0",
      "commands": [{ "name": "greet", "title": "Say Hello", "description": "…", "mode": "no-view" }],
      "download": { "url": "pkg/e2e-greeter-1.1.0.tgz", "sha256": "<64 hex>", "size": 351 },
      "source": { "bundled": true, "path": "uuid-generator" }, // instead of / besides download: ships in extensions-examples/
      "screenshots": ["https://…/shot.png"],
      "changelog": [{ "version": "1.1.0", "date": "2026-10-21", "notes": "…" }],
      "homepage": "https://…",
      "license": "MIT"
    }
  ]
}
```

URLs may be relative to the index URL. Downloads, screenshots and the index itself must use `https://`.
Plain `http://` is accepted only for `127.0.0.1` and `localhost`. Screenshots are fetched by the main
process, only for URLs that the index lists, and are shown as `data:` images (PNG, JPEG, GIF or WebP,
4 MB maximum).

## Install, update and uninstall

1. You press **⏎ Install**. An in-launcher card explains that extensions are third-party code that runs
   with your privileges. It also says whether the files come from the bundled copy or from a download,
   and shows the download size. **⏎** confirms and **⎋** cancels. The main process refuses any install
   or update that was not confirmed.
2. For a bundled extension whose bundled copy is the listed version, Glide copies it from
   `extensions-examples/` with no network access.
3. Otherwise Glide downloads the tarball. The download is streamed with a hard cap of `download.size`
   bytes (50 MB maximum). Glide then checks the exact size and the SHA-256. On a mismatch nothing is
   installed.
4. Glide extracts the package with its own tar reader (`store-tar.ts`, using `node:zlib` and no
   dependencies) into a new temporary folder. The extraction:
   - accepts only regular files and directories, and rejects symlinks, hard links, devices and FIFOs;
   - rejects absolute paths, drive letters, backslashes, NUL bytes and `..` segments, including in pax
     and GNU long names;
   - rejects duplicate paths and files nested under a file;
   - caps the number of entries and the decompressed size (gzip-bomb safe);
   - creates each file exclusively (`wx`), with mode 0644 or 0755.
5. The package's `package.json` must validate, and its name, version and kind must match the index
   entry. Glide then installs it into `installed/<name>` through the extension registry, the commands
   appear in search, and `store-state.json` records where the install came from.
6. **Update** appears when the listed version is newer than the installed one by semver precedence. The
   details pane then shows "What's New" from the `changelog`. An update goes through the same confirm,
   verify and extract steps.
7. **⌃X Uninstall** asks for confirmation, stops any running sessions of the extension, and removes its
   files and preferences.

## Keyboard

| Key | Action |
| --- | --- |
| type | search title, description, author, categories, commands |
| ⌘] / ⌘[ | next / previous category (the chips at the top; also available as actions in ⌘K) |
| ⏎ | Install, or Update if one is available, or Run the first command if installed |
| ⌘⏎ | Run the first command (when an update is pending) |
| ⌃X | Uninstall |
| ⌘R | Refresh the index |
| ⌘O | Open the homepage |
| ⌘M | Manage Extensions |
| ⌘K | All actions |

## Publishing an extension

```sh
# build first (Raycast-style extensions: npm run build → dist/<command>.js)
node scripts/store-pack.mjs path/to/my-ext \
  --out release/my-ext-1.0.0.tgz \
  --url https://github.com/you/my-ext/releases/download/v1.0.0/my-ext-1.0.0.tgz \
  --categories "Developer Tools,Productivity" --min-glide 0.2.0
```

The command packs `package.json`, `dist/`, `assets/`, README, CHANGELOG, LICENSE and each command's
entry file under `package/`. It refuses symlinks and commands that have not been built. The archive is
reproducible (fixed mtimes, sorted paths). The command prints the index entry, with `sha256` and `size`,
to stdout. Upload the `.tgz`, edit the `changelog` notes, add the entry to `store/index.json`, and open
a pull request.

## Code map

| File | Role |
| --- | --- |
| `src/main/features/extensions/store-schema.ts` | types, validation, semver compare, URL rules |
| `src/main/features/extensions/store-tar.ts` | strict tar/tgz reader and writer |
| `src/main/features/extensions/store-client.ts` | index fetch, download with SHA-256/size checks, screenshots |
| `src/main/features/extensions/store-service.ts` | merge of bundled and remote entries, cache, install/update/uninstall |
| `src/main/features/extensions/store-feature.ts` | Electron glue; renderer methods `storeList`, `storeInstall`, `storeUpdate`, `storeUninstall`, `storeScreenshot` |
| `src/main/features/extensions/store-contract.ts` | types shared with the renderer |
| `src/renderer/features/extensions/StoreView.tsx`, `StoreConfirm.tsx`, `StoreView.css` | the launcher view |
| `store/index.json`, `store/schema.json` | the index and its JSON Schema |
| `scripts/store-pack.mjs` | the packer |
| `scripts/store-e2e.mjs` | headless end-to-end test (local 127.0.0.1 server) |

Tests: `pnpm vitest run src/main/features/extensions/store-` and
`pnpm build && node scripts/store-e2e.mjs` (port 9463, set `GLIDE_E2E_APP` to test a separate build).
