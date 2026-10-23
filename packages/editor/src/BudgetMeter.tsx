import { useEffect, useState } from 'react';
import type { LivePatch, VoiceStats } from './live';

/** How often the readout reads the voice pool, ms. */
const POLL_MS = 250;

/** Voices in use against the limit, and steals (design system BudgetMeter, compact). Warns at the limit and once anything was stolen. */
export function VoiceReadout({ live }: { live: LivePatch }) {
  const [stats, setStats] = useState<VoiceStats>(() => live.voiceStats());
  useEffect(() => {
    const id = setInterval(() => setStats((prev) => {
      const next = live.voiceStats();
      return next.inUse === prev.inUse && next.steals === prev.steals && next.limit === prev.limit ? prev : next;
    }), POLL_MS);
    return () => clearInterval(id);
  }, [live]);
  const full = stats.inUse >= stats.limit;
  return (
    <span className="budget" data-testid="voice-readout" data-in-use={stats.inUse} data-steals={stats.steals} title="Voices in use, of the limit; voices stolen">
      <span className={`budget__row${full ? ' budget__row--warn' : ''}`}><i className="icon-piano" />{stats.inUse}/{stats.limit} voices</span>
      <span className={`budget__row${stats.steals ? ' budget__row--warn' : ''}`}>{stats.steals} stolen</span>
    </span>
  );
}
