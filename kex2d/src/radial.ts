/** the node-action ring geometry — the ring's three DOM `.rbtn` buttons (App.svelte) slot into it: the
 *  length (measure) knob, the extend (add-node) button, and the angle (pitch) knob. feel round 12
 *  restored extend to the ring (double-clicking to append wasn't discoverable enough); delete stays
 *  OFF the ring (the Del key + the right-click menu). the symmetric round-6 fan minus delete:
 *  measure ·(−60°)· extend ·(0°, front, along the heading)· pitch ·(+60°).
 *
 *  pure screen-space: the caller passes the node's heading (world radians) + the view scale to
 *  `ringBase`, then adds the node's screen point to the offset `ringSlot` returns. the button
 *  *position* is all this places — the drag *loci* (the chord ray / tangential arc) stay
 *  chord-relative in the manipulator, unaffected. */

/** screen px from the node center to a slot center — the ring radius (matches the `.rbtn` orbit). */
export const RADIAL_R = 46;

/** the angular pitch between adjacent slots (60°). */
export const RADIAL_STEP = Math.PI / 3;

/** each affordance's slot index around the ring (× `RADIAL_STEP` off the heading). extend sits at the
 *  front (along the heading, where the next piece lays); the length and angle knobs flank it
 *  symmetrically at ±60°. */
export const RadialSlot = {
    Length: -1, // −60°, mirror of Angle about Extend
    Extend: 0, // along the heading — the front of the ring
    Angle: 1, // +60°, mirror of Length about Extend
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
