/** The six port types (design.md, Core concepts). */
export type PortType = 'event' | 'note' | 'signal' | 'audio' | 'field' | 'value';

export type EventField = number | string | boolean;

/** A timestamped discrete message. `time` is on the audio clock, in seconds. */
export interface EngineEvent {
  time: number;
  /** Stable id for one pointer, touch or key for the life of the contact (ADR 0009). */
  channel: number;
  [field: string]: EventField;
}

/** The Note subtype of Event. */
export interface NoteEvent extends EngineEvent {
  /** MIDI pitch; fractional values are allowed. */
  pitch: number;
  /** 0–1. */
  velocity: number;
  /** Seconds. */
  duration: number;
}

export const isNoteEvent = (event: EngineEvent): event is NoteEvent =>
  typeof event.pitch === 'number' && typeof event.velocity === 'number' && typeof event.duration === 'number';

/** Orders events by time, then channel, so merges are deterministic. */
export const compareEvents = (a: EngineEvent, b: EngineEvent): number => a.time - b.time || a.channel - b.channel;

/**
 * How an event reached the graph. 'immediate': pushed live (a tap), stamped
 * currentTime + 5 ms; 'scheduled': everything a window query produced. Visual
 * nodes get a tap's own events on the next frame, without the output-latency
 * shift (ADR 0020).
 */
export type EventPath = 'scheduled' | 'immediate';
