/** the node-action radial menu geometry — the one ring the add/delete buttons (App.svelte) and the
 *  two polar manipulator knobs (render + pick + the harness hook) all slot into. one placement so
 *  they can't drift into each other (feel round 5: the knobs used to be placed chord-relative and
 *  landed behind the add button). every affordance sits `RADIAL_R` screen px from the node at a slot
 *  60° off the node's heading direction, an even fan — length ·(−60°)· extend ·(+60°)· delete
 *  ·(+120°)· angle — with the length and angle knobs on opposite sides of the ring.
 *
 *  pure screen-space: the caller passes the node's heading (world radians) + the view scale to
 *  `ringBase`, then adds the node's screen point to the offset `ringSlot` returns (the DOM `.radial`
 *  container already sits at the node, so App adds nothing; a canvas caller adds it explicitly).
 *  the idle button *position* is all this places — the drag *loci* (the chord ray / tangential arc)
 *  stay chord-relative in the manipulator, unaffected. */

/** screen px from the node center to a slot center — the ring radius (matches the `.rbtn` orbit). */
export const RADIAL_R = 46;

/** the angular pitch between adjacent slots (60°). */
export const RADIAL_STEP = Math.PI / 3;

/** each affordance's slot index around the ring (× `RADIAL_STEP` off the heading). extend sits along
 *  the heading (where the next piece lays); the length and angle knobs are opposite each other. */
export const RadialSlot = {
    Length: -1, // −60°, opposite Angle
    Extend: 0, // along the heading
    Delete: 1, // +60°
    Angle: 2, // +120°, opposite Length
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
