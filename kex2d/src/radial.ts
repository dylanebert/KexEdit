/** the node-action ring geometry — the two polar manipulator knobs (real DOM `.rbtn` buttons in
 *  App.svelte) slot into it. feel round 7 stripped the ring to just these two (extend + delete left
 *  the ring for the keyboard + right-click menu — a healthier attention economy): the length
 *  (measure) knob at the front along the heading, the angle (pitch) knob one slot off it.
 *
 *  pure screen-space: the caller passes the node's heading (world radians) + the view scale to
 *  `ringBase`, then adds the node's screen point to the offset `ringSlot` returns. the button
 *  *position* is all this places — the drag *loci* (the chord ray / tangential arc) stay
 *  chord-relative in the manipulator, unaffected. */

/** screen px from the node center to a slot center — the ring radius (matches the `.rbtn` orbit). */
export const RADIAL_R = 46;

/** the angular pitch between adjacent slots (60°). */
export const RADIAL_STEP = Math.PI / 3;

/** each knob's slot index around the ring (× `RADIAL_STEP` off the heading). the length knob sits at
 *  the front (along the heading, where extend used to be); the angle knob one slot off it. */
export const RadialSlot = {
    Length: 0, // along the heading — the front of the ring
    Angle: 1, // +60° off the heading
} as const;

/** the heading's SCREEN angle at a node — its world heading mapped through the view (the y-flip
 *  rides in `sy < 0`). the base angle every ring slot is measured from. */
export function ringBase(headingWorld: number, sx: number, sy: number): number {
    return Math.atan2(Math.sin(headingWorld) * sy, Math.cos(headingWorld) * sx);
}

/** a ring slot's screen-px OFFSET from the node center: `RADIAL_R` at `base + slot·RADIAL_STEP`.
 *  the caller adds the node's screen point when it needs an absolute point. */
export function ringSlot(base: number, slot: number): { x: number; y: number } {
    const a = base + slot * RADIAL_STEP;
    return { x: RADIAL_R * Math.cos(a), y: RADIAL_R * Math.sin(a) };
}
