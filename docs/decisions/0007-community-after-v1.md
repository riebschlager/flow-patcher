# 0007 · Community comes after v1

Status: Accepted · 2026-10-21

## Decision
v1 is local-first: patches live in IndexedDB and move around as `.flowpatch` files. Publishing, browsing, remixing online, moderation and the backend are M5, after v1.

## Consequences
- The app is a static site until M5. No backend, accounts or server code before then.
- Nothing in the patch format or the engine may depend on a server.
