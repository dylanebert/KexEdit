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
 *  **Each solve phase ends on its own ANSWER frame.** `snapshots` are decimated accepted
 *  steps of the solve that produced the answer, so the last of them is not guaranteed to BE
 *  the answer — and in calm mode the answer comes out of a λ search that ran several solves.
 *  Appending the answer explicitly is what makes the last frame of a phase the thing the
 *  corpus table reports, rather than the closest step that happened to survive decimation.
 *
 *  **The legacy `fit` phase is the OTHER pipeline.** `fit.ts` places knots against the dense
 *  force, which is the wrong target (`refine.ts`'s note), and the shipping conversion path
 *  does not use its placement at all — it opens at two keys. Both timelines live here
 *  because the lab still draws the fit→polish baseline as the oracle/`exact` comparison the
 *  spike's numbers were taken on. `baseline` is that one; `pipeline` is the real one. */

import type { FitStep } from "./fit";
import type { PolishResult, Snapshot } from "./polish";
import { type ForcePoint, forceProfile } from "./profile";
import type { QuantizeResult } from "./quantize";
import type { RefineEvent, RefineResult } from "./refine";

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

/** one frame per accepted LM step the solve kept. */
function stepFrames(phase: Phase, out: PolishResult, label: (s: Snapshot) => string): Frame[] {
    return out.snapshots.map((snap) => ({
        phase,
        label: label(snap),
        points: snap.points,
        fN: snap.fN,
        snap,
        step: null,
        event: null,
        corners: out.corners,
    }));
}

/** the phase's terminal frame: the answer itself, not the last step that survived
 *  decimation (see the module note). */
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
        default:
            return `refine · diverged · ${dev}`;
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
        ...stepFrames("polish", out, (s) => `polish · iter ${s.step}`),
        answerFrame("polish", out, `polish · answer · ${out.keys} keys`),
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
        ...stepFrames("polish", r.final, (s) => `polish · iter ${s.step}`),
        answerFrame(
            "polish",
            r.final,
            `polish · answer · ${r.final.keys} keys · λ ${r.final.lambda.toExponential(1)}`,
        ),
    );
    // `quantize` hands its input back BY IDENTITY when nothing could be named, and that
    // no-op ran no solve of its own — so the phase is exactly its answer frame there.
    const tag = q.named.length === 0 ? "nothing named" : `${q.named.length} named`;
    if (q.final !== r.final)
        frames.push(...stepFrames("quantize", q.final, (s) => `quantize · iter ${s.step}`));
    frames.push(answerFrame("quantize", q.final, `quantize · ${tag}`));
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
        else if (seg.phase === "refine") {
            const kinds = frames
                .slice(seg.start, seg.end + 1)
                .reduce<Record<string, number>>((acc, fr) => {
                    const k = fr.event?.kind;
                    if (k) acc[k] = (acc[k] ?? 0) + 1;
                    return acc;
                }, {});
            const parts = (["split", "prune", "corner", "stall"] as const)
                .filter((k) => kinds[k])
                .map((k) => `${kinds[k]} ${k}`);
            seg.label = `refine · ${parts.join(" / ") || "no split"} (${n})`;
        }
    }
    return segs;
}
