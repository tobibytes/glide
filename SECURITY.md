# Security

Glide runs locally with your user's privileges. Please report vulnerabilities privately through GitHub's **Report a vulnerability** (Security tab) rather than a public issue.

## Design notes

- **No telemetry.** Glide makes network requests only for features you use:
  - Anthropic API: AI features, with your own key.
  - Currency rates: can be turned off.
  - GitHub Releases: update checks, only if you set an update feed.
- **Secrets:** the Anthropic key is encrypted with Electron `safeStorage` (macOS keychain) and never sent to the renderer. Sync never writes secrets.
- **Extensions run third-party code** with your privileges in a separate process. Only install extensions you trust; Glide shows a warning before importing.
- **Glide Agent** asks before every action that changes state unless you allow a tool explicitly.
- **Browser data** is read from temporary copies of local databases and never leaves your Mac. History indexing is off by default.
