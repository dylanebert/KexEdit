/** the fit lab's PLAYBACK TIMELINE: the conversion pipeline's own decisions, turned into
 *  frames a scrubber can walk. Pure and framework-free — no DOM, no canvas — so the thing
 *  the lab draws is unit-testable apart from the page that draws it (`fitlab.ts` owns the
 *  drawing, `tests/playback.test.ts` owns this).
 *
 *  **A frame is a decision the kernel already made, never a re-derivation.** The refine
 *  phase is one frame per `RefineEvent` — the split/prune/corner stream, carrying the λ = 0
 *  probe profile the loop actually held at that knot set (`RefineEvent.points`) — and the
 *  two solve phases are their own accepted LM steps (`PolishResult.snapshots`). Nothing here
 *  solves, samples, or decides anything; the only computation is `forceProfile`, which is
 *  the dense force a profile already implies. So playback is deterministic in the same sense
 *  the pipeline is: same bake, same frames, and no wall clock anywhere in what is shown.
 *
 *  **Each solve phase ends ON its answer, and draws it once.** `snapshots` are decimated
 *  accepted steps, but `polish` guarantees the terminal one is recorded (`polish.ts`,
 *  "playback must end on the answer" — at the frame cap it REPLACES the last entry rather
 *  than overflowing it), and in calm mode the snapshots come from the λ the search kept. So
 *  the last snapshot already IS the answer: this module labels it as such and appends
 *  nothing. Appending a separate answer frame would draw the identical state twice, which
 *  reads as a solver step that changed nothing. The one phase that needs an explicit answer
 *  frame is a quantize that named nothing — it ran no solve of its own, so it has no
 *  snapshots to label (`pipeline`).
 *
 *  **The legacy `fit` phase is the OTHER pipeline.** `fit.ts` places knots against the dense
 *  force, which is the wrong target (`refine.ts`'s note), and the shipping conversion path
 *  does not use its placement at all — it opens at two keys. Both timelines live here
 *  because the lab still draws the fit→polish baseline as the oracle/`exact` comparison the
 *  spike's numbers were taken on. `baseline` is that one; `pipeline` is the real one. */

import type { Scale } from "./census";
import type { FitStep } from "./fit";
import type { PolishResult, Snapshot } from "./polish";
import { type ForcePoint, forceProfile } from "./profile";
import type { QuantizeResult } from "./quantize";
import type { RefineEvent, RefineResult } from "./refine";

/** the force panel's box, in CSS px. Here rather than in `fitlab.ts` because the panel's
 *  transform is part of what the vocabulary census MEANS — the classification is
 *  screen-space (`census.ts`), so "does the displayed profile read as broken" is a question
 *  about these numbers, and a test that asked it at a scale of its own would be asking about
 *  a picture nobody looks at. */
export const PANEL = { w: 620, h: 340, padL: 46, padR: 14, padT: 26, padB: 34 } as const;

/** the g-range the force panel fits: every frame's dense force plus whatever reference
 *  curves are drawn beside them, padded 6%. Spanning every FRAME (not just the answer) is
 *  what keeps an early wild state from clipping mid-playback.
 *
 * @example
 * const { lo, hi } = forceRange(frames, [bake.fN, finalDense]);
 */
export function forceRange(
    frames: readonly Frame[],
    extra: readonly ArrayLike<number>[] = [],
): { lo: number; hi: number } {
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    const sweep = (vals: ArrayLike<number>): void => {
        for (let i = 0; i < vals.length; i++) {
            lo = Math.min(lo, vals[i]);
            hi = Math.max(hi, vals[i]);
        }
    };
    for (const vals of extra) sweep(vals);
    for (const fr of frames) if (fr.fN) sweep(fr.fN);
    if (!Number.isFinite(lo) || !Number.isFinite(hi))
        throw new Error("playback: no finite force values to range over");
    const pad = 0.06 * Math.max(hi - lo, 1e-3);
    return { lo: lo - pad, hi: hi + pad };
}

/** the px-per-unit of the force panel's transform — the `Scale` the handle census judges
 *  in. Only the linear part of the mapping enters the judgment, so this is the whole of it.
 *
 * @example
 * const sc = panelScale(out.length, lo, hi);
 * census(out.points, sc).broken; // what an author would meet as `Free`
 */
export function panelScale(length: number, lo: number, hi: number): Scale {
    if (!(length > 0) || !Number.isFinite(length))
        throw new Error(`playback: panel length must be > 0, got ${length}`);
    if (!(hi > lo)) throw new Error(`playback: panel g-range must ascend, got ${lo}..${hi}`);
    return {
        s: (PANEL.w - PANEL.padL - PANEL.padR) / length,
        g: (PANEL.h - PANEL.padB - PANEL.padT) / (hi - lo),
    };
}

/** which stage of a pipeline a frame belongs to. `fit` appears only in the baseline
 *  timeline, `refine`/`quantize` only in the pipeline one. */
export type Phase = "recover" | "fit" | "refine" | "polish" | "quantize";

/** one playback frame. Frame 0 of either timeline is the DENSE RECOVERY — the observed
 *  curve, before any profile exists — so `points`/`fN` are null exactly there. */
export interface Frame {
    phase: Phase;
    label: string;
    points: readonly ForcePoint[] | null;
    /** the dense force this frame's profile drives, on the uniform integration grid. */
    fN: ArrayLike<number> | null;
    /** the solver's own reading at this step; null outside a solve phase. */
    snap: Snapshot | null;
    /** the fit's diagnostics at this step; null outside the fit phase. */
    step: FitStep | null;
    /** the refine decision this frame IS; null outside the refine phase. */
    event: RefineEvent | null;
    /** KEY indices carrying a corner here — the one broken-handle state that is deliberate.
     *  The refine stream carries corners as dense knots, so they are resolved to keys once,
     *  here, rather than by every reader. */
    corners: readonly number[];
}

/** a contiguous run of frames belonging to one phase — the segmented scrub bar. */
export interface Segment {
    phase: Phase;
    label: string;
    start: number;
    end: number;
}

function recovered(): Frame {
    return {
        phase: "recover",
        label: "dense recovered F_n",
        points: null,
        fN: null,
        snap: null,
        step: null,
        event: null,
        corners: [],
    };
}

/** one frame per accepted LM step the solve kept, the last of them labelled as the answer it
 *  is (see the module note — `polish` guarantees the terminal step is recorded). Throws on a
 *  solve that recorded no step, which `polish` cannot produce: `maxSnapshots` floors at 1 and
 *  the terminal frame is always written, so an empty list means the contract this module
 *  reads has changed under it. */
function solveFrames(
    phase: Phase,
    out: PolishResult,
    step: (s: Snapshot) => string,
    answer: string,
): Frame[] {
    const last = out.snapshots.length - 1;
    if (last < 0) throw new Error(`playback: ${phase} recorded no step to draw`);
    return out.snapshots.map((snap, i) => ({
        phase,
        label: i === last ? answer : step(snap),
        points: snap.points,
        fN: snap.fN,
        snap,
        step: null,
        event: null,
        corners: out.corners,
    }));
}

/** a phase's answer with no solve behind it — the quantize that named nothing. */
function answerFrame(phase: Phase, out: PolishResult, label: string): Frame {
    return {
        phase,
        label,
        points: out.points,
        fN: forceProfile(out.points, out.length, out.ds),
        snap: null,
        step: null,
        event: null,
        corners: out.corners,
    };
}

/** the key indices a refine event's corners sit at. Throws on a corner that is not in the
 *  event's own knot set — the loop only ever breaks a knot it holds, so that state is a
 *  defect in the stream rather than something a reader should draw around. */
export function cornerKeys(e: RefineEvent): number[] {
    return e.corners.map((c) => {
        const k = e.knots.indexOf(c);
        if (k < 0) throw new Error(`playback: corner knot ${c} is not in the event's knot set`);
        return k;
    });
}

/** one refine decision as a line of text: what it did, where, and where that left the
 *  residual. `sigma` is the dense arclength frame the event's `at` indexes
 *  (`fit.arclength`). */
export function eventLabel(e: RefineEvent, sigma: ArrayLike<number>): string {
    const at = e.at >= 0 ? ` @ ${sigma[e.at].toFixed(1)} m` : "";
    const corners = e.corners.length ? ` / ${e.corners.length} corner` : "";
    const state = `${e.knots.length} keys${corners}`;
    const dev = `dev ${e.deviation.toFixed(3)} m`;
    switch (e.kind) {
        case "init":
            return `refine · open · ${state} · ${dev}`;
        case "split":
            return `refine · split${at} · ${state} · ${dev}`;
        case "prune":
            return `refine · prune${at} · ${state} · ${dev}`;
        case "corner":
            return `refine · corner${at} · ${state} · ${dev}`;
        // the one event whose `deviation` describes something other than its own knots: the
        // trial that was rejected. Said out loud, because the frame draws the state that
        // stalled while the number is the state that did not happen.
        case "stall":
            return `refine · stall${at} · trial rejected at ${dev}`;
        case "budget":
            return `refine · budget · no admissible site · ${dev}`;
        case "diverged":
            return `refine · diverged · ${dev}`;
        // a kind added to `RefineEventKind` later renders as ITSELF. Falling through to
        // `diverged` would label it the one outcome that means "a defect to surface".
        default:
            return `refine · ${e.kind} · ${dev}`;
    }
}

/** the LEGACY timeline: dense recovery → the fit's split/prune steps → the polish that
 *  moved values at the knots the fit chose. The `exact` oracle baseline the spike measured,
 *  not the shipping path.
 *
 * @example
 * const frames = baseline(fit(bake.fN, bake.ds, 0.05).steps, polish({ … }));
 */
export function baseline(steps: readonly FitStep[], out: PolishResult): Frame[] {
    if (steps.length === 0) throw new Error("playback: fit produced no steps");
    const frames = [recovered()];
    steps.forEach((step, i) => {
        frames.push({
            phase: "fit",
            label:
                i === 0
                    ? `fit · first piece · ${step.knots.length} keys`
                    : `fit · ${step.phase} ${i} · ${step.knots.length} keys`,
            points: step.points,
            fN: forceProfile(step.points, out.length, out.ds),
            snap: null,
            step,
            event: null,
            corners: [],
        });
    });
    return [
        ...frames,
        ...solveFrames(
            "polish",
            out,
            (s) => `polish · iter ${s.step}`,
            `polish · answer · ${out.keys} keys`,
        ),
    ];
}

/** the REAL conversion timeline: dense recovery → the refine loop's structural decisions →
 *  the calm λ-search over the settled knots → the vocabulary snap. `sigma` is the dense
 *  arclength frame (`fit.arclength(bake.ds)`), used only for the event labels.
 *
 * @example
 * const r = refine({ bake, entry, ds });
 * const frames = pipeline(r, quantize({ bake, entry, ds, answer: r.final }), arclength(bake.ds));
 */
export function pipeline(r: RefineResult, q: QuantizeResult, sigma: ArrayLike<number>): Frame[] {
    const frames = [recovered()];
    for (const e of r.events)
        frames.push({
            phase: "refine",
            label: eventLabel(e, sigma),
            points: e.points,
            fN: forceProfile(e.points, r.final.length, r.final.ds),
            snap: null,
            step: null,
            event: e,
            corners: cornerKeys(e),
        });
    frames.push(
        ...solveFrames(
            "polish",
            r.final,
            (s) => `polish · iter ${s.step}`,
            `polish · answer · ${r.final.keys} keys · λ ${r.final.lambda.toExponential(1)}`,
        ),
    );
    // `quantize` hands its input back BY IDENTITY when nothing could be named. It still SPENT
    // probes reaching that conclusion — one per candidate segment — but it produced no new
    // answer, so there are no snapshots of its own to draw and the phase is one frame. When it
    // did name something, `q.final` is its own solve and draws its own steps.
    const tag = q.named.length === 0 ? "nothing named" : `${q.named.length} named`;
    frames.push(
        ...(q.final === r.final
            ? [answerFrame("quantize", q.final, `quantize · ${tag}`)]
            : solveFrames(
                  "quantize",
                  q.final,
                  (s) => `quantize · iter ${s.step}`,
                  `quantize · ${tag}`,
              )),
    );
    return frames;
}

/** collapse a frame list into its phase runs. `note` labels the polish segment with which
 *  solve it was (the baseline's mode, or the pipeline's λ-search).
 *
 * @example
 * const segs = segments(pipeline(r, q, sigma), "calm λ-search");
 */
export function segments(frames: readonly Frame[], note: string): Segment[] {
    const segs: Segment[] = [];
    frames.forEach((fr, i) => {
        const tail = segs[segs.length - 1];
        if (tail && tail.phase === fr.phase) tail.end = i;
        else segs.push({ phase: fr.phase, label: fr.phase, start: i, end: i });
    });
    for (const seg of segs) {
        const n = seg.end - seg.start + 1;
        if (seg.phase === "fit") seg.label = `fit · split → prune (${n})`;
        else if (seg.phase === "polish") seg.label = `polish · ${note} (${n})`;
        else if (seg.phase === "quantize") seg.label = `quantize (${n})`;
        // `refine` keeps the bare phase name: the strip expands that phase into one chip per
        // decision (`fitlab.drawPhases`), so a summary label there would render nowhere.
    }
    return segs;
}
