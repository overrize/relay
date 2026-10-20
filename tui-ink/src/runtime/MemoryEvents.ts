import type { TuiEvent } from "../protocol.js";

// Store-accepted events are the single source for secretary projections. Tool
// results originate in the runtime, not the model emitter, and must pass here too.
const observers = new Map<string, (event: TuiEvent) => void>();

export function registerMemoryObserver(id: string, observe: (event: TuiEvent) => void): () => void {
  observers.set(id, observe);
  return () => { if (observers.get(id) === observe) observers.delete(id); };
}

export function observeMemoryEvent(event: TuiEvent): void {
  for (const observe of observers.values()) observe(event);
}
