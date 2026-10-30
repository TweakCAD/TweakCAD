# Security policy

## Reporting a vulnerability

**Please don't open a public issue.** Use GitHub's private vulnerability
reporting instead: the **Security** tab on this repository → **Report a
vulnerability**. That opens a private thread visible only to the maintainers.

Useful things to include, roughly in order of how much they help:

- What an attacker can do, and what they need to start (an account? a link the
  victim clicks? nothing?)
- The smallest sequence of steps that reproduces it
- Which version or commit you tested
- Whether you have shared it anywhere else

You will get an acknowledgement within a few days. This is a small project —
if it is a real issue, expect a conversation rather than a ticketing system.

## Scope

This repository is the **browser CAD editor**. It runs client-side: the
document, the geometry kernel and the solver all live in the user's tab.

The server side — accounts, projects, storage, moderation, the public gallery —
is a separate, closed-source project. Vulnerabilities there are in scope for a
report too; send them the same way and they will be routed.

Particularly interesting here:

- Anything that gets a document from one user into another user's session
- Anything that turns an imported file (`.cadjson`, STEP, STL, DXF, SVG,
  `.FCStd`) into code execution, or into a hang or allocation large enough to
  take down the tab — importers parse untrusted input by design
- Anything that lets a page outside the app drive the MCP bridge or the
  editor's command bus

Less interesting, and already known:

- A malformed import that fails with an error message. That is the importer
  working.
- Resource exhaustion that needs the user to import their own 10 GB file.
- `zod` 3.25.76's memory-exhaustion advisory. Known; the fix is a major-version
  migration, and request bodies and array lengths are capped server-side in the
  meantime.

## Supported versions

Pre-1.0 and unreleased: fixes land on `main`, and there are no maintained
release branches to backport to.
