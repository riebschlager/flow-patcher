# 0009 · Channels from day one

Status: Accepted · 2026-10-21

## Context
A pointer is really several pointers: up to 5 touches, plus a mouse and a pen. Adding channels later would mean rewriting every node.

## Decision
Every Event, Note and Signal port carries channels. Every event has a `channel` id, and nodes keep per-channel state. Merge and Split nodes combine and separate channels.

## Consequences
- Every node is written and tested with more than one channel from the start.
- Most cables carry a single channel, so the engine needs a single-channel fast path. The editor hides Merge/Split until they're needed.
