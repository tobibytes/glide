# Contributing to Glide

Thanks for helping! Glide is a TypeScript/Electron app with a small Swift helper.

## Setup

```sh
pnpm install
pnpm dev            # watch mode
pnpm typecheck && pnpm test
pnpm test:e2e       # optional: drives a real instance with an isolated data dir
```

## Adding a feature

1. Create `src/main/features/<id>/index.ts` exporting `feature: FeatureModule`, and `src/renderer/features/<id>/index.tsx` exporting `ui: FeatureUI`.
2. Register both in `src/main/features/registry.ts` and `src/renderer/features/registry.ts`.
3. Build lists with `<NavList>` so vim keys, ⌘K actions and the detail pane work automatically.
4. Put CSS in your feature folder, prefix classes with your feature id, and use the tokens from `src/renderer/styles/tokens.css`.
5. Anything that changes system settings, sends data off the machine, or triggers a permission prompt must be an explicit user action.

## Guidelines

- Strict TypeScript, no `any` at boundaries, small modules.
- Keyboard first: every view must be fully usable without a mouse, and shortcuts must be shown in the UI.
- Add unit tests for parsers and logic. Tests must never touch the real `~/Library/Application Support/Glide` or `/Applications/Glide.app`.
- Run external tools with `execFile` and argument arrays, never shell strings built from user input.

## Pull requests

Keep PRs focused, describe how you tested, and make sure `pnpm typecheck` and `pnpm test` pass (CI runs both).
