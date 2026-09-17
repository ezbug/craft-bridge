# Security Policy

## Supported versions

Security fixes are intended for the latest published release. Please update to the latest release before reporting an issue where possible.

## Report a vulnerability

Please do not open a public issue for an unpatched vulnerability. Use GitHub's **Report a vulnerability** action in the repository's Security tab to start a private advisory. If private reporting is unavailable, contact the maintainer privately through the contact method listed on the [ezbug GitHub profile](https://github.com/ezbug).

Include the affected version, macOS/Obsidian versions, impact, and a minimal reproduction that does not contain real Vault content, Craft API Connection URLs, Bridge Tokens, or private document identifiers. Do not attach live credentials or personal logs.

The maintainer will acknowledge reports as time permits, investigate privately, and coordinate a fix and disclosure timeline with the reporter. This is a best-effort policy; no response-time guarantee is made.

## Scope notes

Craft Bridge is a local application, not a security boundary against other software already running as the same macOS user. Protect your macOS account, Keychain, and Obsidian sync settings. The Obsidian plugin stores its local Bridge Token in plugin settings; if those settings are synced to another device or service, the token may be copied there.
