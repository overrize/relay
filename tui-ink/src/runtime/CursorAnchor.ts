export interface CursorAnchorState {
  enabled: boolean;
  focused: boolean;
  row: number;
  col: number;
}

const state: CursorAnchorState = {
  enabled: process.env.SPAWN_INPUT_CURSOR_ANCHOR !== "0",
  focused: false,
  row: 1,
  col: 1,
};

export function setCursorAnchor(patch: Partial<CursorAnchorState>): void {
  Object.assign(state, patch);
}

export function getCursorAnchorSequence(): string {
  if (!state.enabled) return "";
  if (!state.focused) return "\x1b[?25l";
  // A real steady bar preserves the glyph beneath it and anchors native IMEs.
  return `\x1b[${state.row};${state.col}H\x1b[6 q\x1b[?25h`;
}

let saved=false;
/** Ink tracks its own end-of-frame position; never let IME anchoring change it. */
export function cursorAnchoredFrame(content:string):string{
 const restore=saved?'\x1b8':'';
 saved=true;
 return `${restore}${content}\x1b7${getCursorAnchorSequence()}`;
}
