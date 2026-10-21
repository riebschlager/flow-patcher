# 0015 · Patch migrations start in M4

Status: Accepted · 2026-10-21

## Context
The design gives every node type a version number and a migration function, and loads unknown node types as placeholders. With no users and no saved patches worth keeping, writing migrations before files are shared is wasted work.

## Decision
- From M1, patches record the format version and each node's type version. This is cheap and makes M4 easier.
- Migration functions and unknown-node placeholders arrive in M4, when sharing `.flowpatch` files begins.

## Consequences
- Before M4, a breaking node change updates the example patches and test fixtures in the same PR. No migration is written.
- From M4 on, changing a node's params needs a migration function and a test.
