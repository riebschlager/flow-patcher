# 0012 · A fixed visual vocabulary

Status: Accepted · 2026-10-21

## Context
"Any visual" turns into a shader IDE, and that would take years.

## Decision
Visuals in v1 are a fixed set of music-shaped building blocks around one fluid field: Fluid writers and readers, the overlay nodes (Ripple, Droplet, Halo, Motes, Trace, Orbit Rings, Text), Palette, Lighting and Renderer. There's no general shader graph.

A GLSL Shader node is a post-v1 option. It stays local-only until there's a sandboxing story for shared patches.

## Consequences
- New visual ideas become new building-block nodes, not shader plumbing.
- Shared patches never contain executable code. A future Shader node is stripped from public uploads or shown only after an explicit warning.
- Every overlay obeys reduced-motion: it keeps color and drops added motion.
