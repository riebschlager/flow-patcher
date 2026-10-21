import { useRef, useState } from 'react';

// M0 starting point: proves audio unlocks on the first tap and logs the
// tap-to-sound latency the gate measures. Replace freely.
export function App() {
  const ctxRef = useRef<AudioContext | null>(null);
  const [log, setLog] = useState<string[]>([]);

  const onPointerDown = async (e: React.PointerEvent) => {
    const tapPerf = e.timeStamp;
    const y = e.clientY / window.innerHeight;
    const ctx = (ctxRef.current ??= new AudioContext({ latencyHint: 'interactive' }));
    if (ctx.state !== 'running') await ctx.resume();
    // The pointerdown's time on the audio clock (the gate's reference point):
    // currentTime, minus how long the event took to reach this handler.
    const tapAudio = ctx.currentTime - (performance.now() - tapPerf) / 1000;
    const when = Math.max(ctx.currentTime, tapAudio) + 0.01;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 220 + 660 * (1 - y);
    gain.gain.setValueAtTime(0.2, when);
    gain.gain.exponentialRampToValueAtTime(0.001, when + 0.3);
    osc.connect(gain).connect(ctx.destination);
    osc.start(when);
    osc.stop(when + 0.3);
    const ms = (when - tapAudio) * 1000;
    const out = (ctx.outputLatency || ctx.baseLatency) * 1000;
    const line = `tap-to-sound ${ms.toFixed(1)} ms (gate ≤ 20), + output latency ${out.toFixed(1)} ms`;
    console.log('[spike] tap', line);
    setLog((l) => [line, ...l].slice(0, 8));
  };

  return (
    <div
      onPointerDown={(e) => void onPointerDown(e)}
      onContextMenu={(e) => e.preventDefault()}
      style={{ position: 'fixed', inset: 0, touchAction: 'none', background: '#111', color: '#ccc', font: '14px system-ui', padding: 16 }}
    >
      <p>Flow Patcher M0 spike. Tap anywhere.</p>
      {log.map((line, i) => <div key={i}>{line}</div>)}
    </div>
  );
}
