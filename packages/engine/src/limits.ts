// Runtime limits (ADR 0011; design.md, Budgets): event caps and the per-node
// warnings the editor shows when one bites.
//
// The caps count events per limit window: a fixed grid of LIMIT_WINDOW-second
// slices of the audio clock, [k × LIMIT_WINDOW, (k + 1) × LIMIT_WINDOW), not
// whatever stretch one query happens to cover. A node keeps its first
// NODE_EVENT_LIMIT events in each slice (in log order, all its output ports
// together) and drops the rest; of those, the patch keeps at most
// PATCH_EVENT_LIMIT across all nodes, taken in the order nodes run. The node
// cap counts what it let through, whatever the patch cap then did, so an event
// past both is a node-cap drop. A node's dropped events never reach the nodes
// downstream of it, the log, frames or audio.
//
// Window independence:
// - The node cap depends only on the node's own event times, so it drops the
//   same events however time is split into queries, and a rewind (ADR 0019)
//   restores each node's count with its state, so a live event is capped as if
//   it had been known in advance.
// - The patch cap is shared, and nodes run one after another in each chunk:
//   which node's events it drops depends on where the chunks fall, and in a
//   rewind's re-run nodes outside the re-run count their events in the slice
//   even past the live event. So once a patch passes PATCH_EVENT_LIMIT in a
//   slice, which events drop may depend on the window size and the wake
//   timing. It is still deterministic for one sequence of queries and pushes.
// - Caps apply to an event's computed time, before a catch-up moves it later
//   for audio, so catch-up never changes what drops. Windows a stall skips
//   are never queried and count nothing: the rest of a slice a stall cut into
//   may keep events a full run would have dropped.
// - Drop counts (RuntimeCounters, NodeWarning.count) are net of rewinds: a
//   re-run takes back the drops it re-runs before making its own.

/** Events one node may emit per limit window, all output ports together. */
export const NODE_EVENT_LIMIT = 256;
/** Events the whole patch may emit per limit window. */
export const PATCH_EVENT_LIMIT = 2048;
/** Seconds per limit window: the scheduler's lookahead, which is the design's
 *  "window", on a fixed grid so the count doesn't depend on wake timing. */
export const LIMIT_WINDOW = 0.12;

/** The limit window an event time falls in. */
export const limitWindowOf = (time: number): number => Math.floor(time / LIMIT_WINDOW);

export type NodeWarningKind =
  /** The node passed NODE_EVENT_LIMIT in a limit window; the excess was dropped. */
  | 'node-event-limit'
  /** The patch passed PATCH_EVENT_LIMIT in a limit window; this node's events past it were dropped. */
  | 'patch-event-limit'
  /** An audio node without cancel() was asked to withdraw events a live event replaced. */
  | 'no-cancel';

/** A problem one node is having at run time, for the editor to show on the node. */
export interface NodeWarning {
  node: string;
  kind: NodeWarningKind;
  /** One line, for the node's tooltip or a log. */
  message: string;
  /** Events affected so far: dropped by a cap (net of rewinds that re-ran them), or left uncancelled. */
  count: number;
  /** Audio-clock time of the latest affected event. */
  time: number;
}

/** Display order of warning kinds on one node. */
export const WARNING_KINDS: readonly NodeWarningKind[] = ['node-event-limit', 'patch-event-limit', 'no-cancel'];
