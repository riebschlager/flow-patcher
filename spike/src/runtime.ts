import { LivePatch } from './live-graph';
import { outputLevel } from './nodes/output';
import { Scheduler } from './scheduler';
import { stats } from './stats';

// One live patch and scheduler per page. They live outside React, and outside App.tsx so a hot
// reload of the UI doesn't start a second scheduler.
export const live = new LivePatch();
export const scheduler = new Scheduler(live);

// Debug hooks for Playwright and the console: sound level, gate counters, and the immediate path.
(window as unknown as { spike: unknown }).spike = {
  level: outputLevel,
  stats,
  push: (node: string, port: string, fields: Record<string, unknown> = {}) => live.push(node, port, fields),
};
