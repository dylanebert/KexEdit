/** per-user editor preferences: the settings an author configures once and expects to find on the
 *  next visit. The document (`doc.ts`) deliberately doesn't carry them — per-user prefs aren't
 *  authored track state — so they persist to `localStorage` (the PlayCanvas/Figma model — sticky
 *  per user, per origin) as one small JSON object under `SNAP_KEY`.
 *
 *  Today that's the two **manipulator** snap quanta — the angle grid and the chord-length grid the
 *  polar controls resolve through. `magnet.ts` reads this singleton per quantize, so an edited
 *  value takes effect on the next drag with nothing to re-wire, and the tool rail's magnet popover
 *  (`Timeline.svelte`) is the surface that writes it. Two deliberate boundaries: the timeline's
 *  force grids (`S_GRID`/`G_GRID`, `timeline.ts`) stay named constants — the manipulator quanta are
 *  the ones an author varies (Figma's precedent: configurable nudge, hardcoded rotation snap) — and
 *  `LENGTH_MIN` (`magnet.ts`) is a different quantity, the floor a chord can never collapse below,
 *  not a grid.
 *
 *  Both quanta clamp to a RANGE, not just a floor: a floor alone lets a typed extreme persist (it's
 *  in storage, so it survives the reload) and collapse the control — past a 180° grid every angle
 *  rounds to one direction, and a 100 m+ length grid quantizes every chord onto the `LENGTH_MIN`
 *  floor. The ceilings exist for recoverability, not precision.
 *
 *  The clamps are pure (and the load path's only shape guard); storage is the one impure edge and
 *  swallows its own failure, since a disabled or full `localStorage` must never break authoring.
 *  Values are stored in the units the app computes in — radians and metres — so nothing converts
 *  at the boundary; the popover's degree field converts at the field instead. */

/** the default angle grid: 5° (the shipped feel — configurability doesn't move the default). */
export const ANGLE_STEP_DEFAULT = Math.PI / 36;
/** the finest configurable angle grid: 1° (Blender's snap-increment floor). */
export const ANGLE_STEP_MIN = Math.PI / 180;
/** the coarsest configurable angle grid: 180° — the largest grid with more than one snap point per
 *  half-turn. Past it every real angle rounds to one direction, i.e. the control stops working, and
 *  the value persists across a reload; the ceiling's job is recoverability, not precision. */
export const ANGLE_STEP_MAX = Math.PI;
/** the default chord-length grid: whole metres. */
export const LENGTH_STEP_DEFAULT = 1;
/** the finest configurable chord-length grid: 0.1 m. */
export const LENGTH_STEP_MIN = 0.1;
/** the coarsest configurable chord-length grid: 100 m — beyond any section scale, so it bounds the
 *  same collapse (every chord quantizing to the `LENGTH_MIN` floor) without bounding real authoring. */
export const LENGTH_STEP_MAX = 100;

/** the `localStorage` key the whole preference object lives under. */
export const SNAP_KEY = "kex2d.snap";

/** the manipulator snap quanta, in the units the drag math uses. */
export interface SnapSteps {
    /** the angle grid, radians (tip incline + interior chord alike). */
    angle: number;
    /** the chord-length grid, metres. */
    length: number;
}

/** the LIVE quanta — the one source of truth `magnet.ts` quantizes against. Read it, never copy it
 *  into a captured constant: the whole point is that a field edit lands on the next gesture. */
export const snapSteps: SnapSteps = {
    angle: ANGLE_STEP_DEFAULT,
    length: LENGTH_STEP_DEFAULT,
};

/** a candidate angle grid clamped into `[ANGLE_STEP_MIN, ANGLE_STEP_MAX]`, and the default for
 *  anything non-finite (a corrupt stored value, a cleared field). */
export function clampAngleStep(rad: number): number {
    return Number.isFinite(rad)
        ? Math.min(ANGLE_STEP_MAX, Math.max(ANGLE_STEP_MIN, rad))
        : ANGLE_STEP_DEFAULT;
}

/** a candidate chord-length grid clamped into `[LENGTH_STEP_MIN, LENGTH_STEP_MAX]`, the default when
 *  non-finite. */
export function clampLengthStep(m: number): number {
    return Number.isFinite(m)
        ? Math.min(LENGTH_STEP_MAX, Math.max(LENGTH_STEP_MIN, m))
        : LENGTH_STEP_DEFAULT;
}

/** set the angle grid (radians) — clamped, live immediately, persisted. */
export function setSnapAngle(rad: number): void {
    snapSteps.angle = clampAngleStep(rad);
    save();
}

/** set the chord-length grid (metres) — clamped, live immediately, persisted. */
export function setSnapLength(m: number): void {
    snapSteps.length = clampLengthStep(m);
    save();
}

/** load the persisted quanta into the live singleton — called once at boot (`main.ts`). Missing,
 *  unparsable, wrong-typed, and out-of-range values all resolve through the same clamps, so a
 *  hand-edited or stale store can only ever yield a usable grid. */
export function loadSnapSteps(): void {
    const stored = read();
    snapSteps.angle = clampAngleStep(num(stored?.angle));
    snapSteps.length = clampLengthStep(num(stored?.length));
}

/** a stored field as a number, or NaN for any non-number (`Number(null)` is 0, which would clamp to
 *  the floor instead of falling back to the default). */
function num(v: unknown): number {
    return typeof v === "number" ? v : Number.NaN;
}

function read(): Record<string, unknown> | null {
    try {
        const raw = store()?.getItem(SNAP_KEY);
        if (raw === null || raw === undefined) return null;
        const parsed: unknown = JSON.parse(raw);
        return typeof parsed === "object" && parsed !== null
            ? (parsed as Record<string, unknown>)
            : null;
    } catch {
        // a corrupt value, or a read that throws (blocked storage in an embedded context), reads as
        // absent — the whole read is inside the guard, since `loadSnapSteps` runs at boot and an
        // escaping exception would abort the module before the app mounts
        return null;
    }
}

function save(): void {
    try {
        store()?.setItem(
            SNAP_KEY,
            JSON.stringify({ angle: snapSteps.angle, length: snapSteps.length }),
        );
    } catch {
        // storage full or write-denied: the live values still hold for this session
    }
}

function store(): Storage | null {
    try {
        return typeof localStorage === "undefined" ? null : localStorage;
    } catch {
        return null; // a sandboxed context throws on ACCESS, not just on write
    }
}
