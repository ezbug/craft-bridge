# Third-Party Notices

Craft Bridge is distributed under the MIT License. Its app and source builds also use third-party software, each under its own license. Do not interpret this file as replacing notices shipped with a dependency; the original license text and attribution remain applicable.

## App runtime

- **Node.js 22.23.2** — MIT License. The [official archive](https://nodejs.org/en/download/archive/v22.23.2/) lists the v22.23.2 Apple Silicon macOS binary; the Node.js distribution includes additional third-party components and notices. The app release must retain the `LICENSE` and third-party notices supplied with the exact Node.js archive used to build that release.
- **better-sqlite3** — MIT License. The native module uses SQLite; SQLite is in the public domain. Preserve the package's license and attribution files in the app bundle.

## Bridge dependencies

The versions resolved in `obsidian-bridge/package-lock.json` are authoritative for a source checkout. Direct runtime dependencies include:

| Package | License |
|---|---|
| `@modelcontextprotocol/sdk` | MIT |
| `better-sqlite3` | MIT |
| `proper-lockfile` | MIT |
| `yaml` | ISC |
| `zod` | MIT |

The transitive dependencies in `package-lock.json` include MIT, ISC, Apache-2.0, BSD-2-Clause, and BSD-3-Clause packages. Each dependency's license metadata and license file are distributed with its package. Before creating a release, regenerate and review the bundled notices for the exact lockfile and runtime artifacts.

## Build and test dependencies

The source tree also uses TypeScript (Apache-2.0), Vitest (MIT), esbuild (MIT), and their locked transitive dependencies for development and tests. These are not intended as standalone app runtime features.

## Trademarks

Craft and Obsidian names and marks belong to their respective owners. Their use here identifies compatible products only; it does not imply endorsement or affiliation.
