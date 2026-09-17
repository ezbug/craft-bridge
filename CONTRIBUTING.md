# Contributing

Thanks for helping improve Craft Bridge. Keep changes small, testable, and focused on the public Bridge project; Craft Daily Notes synchronization is outside this repository's scope.

## Development requirements

- macOS 13+ and Xcode Command Line Tools for the Swift app and tests.
- [Node.js 22.23.2 (Jod LTS)](https://nodejs.org/en/download/archive/v22.23.2/) or a compatible Node 22 release for the Bridge and Obsidian plugin.
- An Obsidian test Vault containing only synthetic content. Do not use a personal Vault or live Craft space in automated tests.

## Local checks

```bash
cd obsidian-bridge
npm ci
npm test
npm run lint
npm run build

cd ../obsidian-plugin
npm ci
npm test
npm run lint
npm run build

cd ../macos/CraftBridgeApp
swift run CraftBridgeCoreTests
```

Do not run the release packager with private test data. Release archives are Apple Silicon-specific and ad-hoc signed; CI checks source correctness but do not assert that a build is Developer ID signed or notarized.

## Pull requests

- Describe the user-visible change, affected platforms, and validation performed.
- Add or update tests for behavior changes.
- Use fictional Vault names, Craft documents, IDs, paths, and API URLs in examples and fixtures.
- Never commit API Connection URLs, Bridge Tokens, private logs, Vault exports, generated app bundles, release ZIPs, or personal screenshots.
- Keep dependency versions and `package-lock.json` in sync when changing Node dependencies.

By submitting a contribution, you agree that it may be distributed under the repository's MIT License.
