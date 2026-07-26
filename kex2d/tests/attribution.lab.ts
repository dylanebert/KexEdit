// The ATTRIBUTION HARNESS for the conversion tier (spec `kex/specs/kex2d-geoforce-convert.md`).
// The tier changes three things in sequence — the DOF family (stage 1), the prior (stage 2),
// the knots (stage 3) — and each stage's job is to show which of them moved a metric. So
// this sweeps the corpus over the axes `polish` exposes and prints one row per solve:
// convergence, geometry against the derived authoring floor, violence, and the vocabulary
// census. Flip one axis, diff two runs, and the delta is attributable.
//
// Two measurement caveats carry over from the spike's verdict, and neither is negotiable:
//
//   - **violence numbers are ds-dependent.** `peakG` is the peak of the DENSE force on the
//     uniform grid, so it is a property of (profile, ds) and not of the profile alone.
//     Compare rows solved at the same `scenario.ds`, never across a ds change.
//   - **censuses are FINAL-FRAME only.** A mid-solve frame's handles are wherever the LM
//     left them that iteration; only the answer is a profile anyone would author.
//
// The census scale mirrors the fit lab's force panel, which is the surface the judgment is
// made on (`census.ts`) — `minPx` reports the shortest handle on it, so a "0 broken" row
// resting on the collapsed-side branch instead of on collinearity is visible rather than
// silent.
//
// Run explicitly, not part of `bun test`:  bun run tests/attribution.lab.ts

import { census } from "../src/census";
import { fit } from "../src/fit";
import {
    authoringFloor,
    fairNorm,
    fairRows,
    type HandleDof,
    type PolishMode,
    polish,
    readDof,
    spine,
} from "../src/polish";
import { collinear, type ForcePoint, forceProfile } from "../src/profile";
import { refine } from "../src/refine";
import { scenarios } from "../src/scenarios";
import { type Entry, evalForce, evalGeo, type SectionResult } from "../src/section";
import { G_GRID } from "../src/timeline";

/** stage 2's own bar, half the force axis's authoring quantum (`fit.test.ts`). */
const FIT_TOL = 0.05;

/** the fit lab's force-panel plot rect (`fitlab.ts` PANEL_W/H minus its pads). */
const PANEL_W = 620 - 46 - 14;
const PANEL_H = 340 - 34 - 26;

function panelScale(points: readonly ForcePoint[], length: number, ds: number) {
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (const g of forceProfile(points, length, ds)) {
        lo = Math.min(lo, g);
        hi = Math.max(hi, g);
    }
    for (const p of points) {
        lo = Math.min(lo, p.g);
        hi = Math.max(hi, p.g);
    }
    return { s: PANEL_W / length, g: PANEL_H / Math.max(hi - lo, 1e-3) };
}

/** how many segments read as each NAMED EASING — the stage-2 attribution's other half.
 *
 *  The prior decides which member of the near-null space the solve lands on, and the two
 *  candidates are named tags rather than arbitrary handles: a segment whose two facing
 *  handles are FLAT is `Easing.Cubic` at the fit's span/3 reach (`profile.ts`'s influence
 *  table), and one whose handles lie along its CHORD is `Easing.Linear` (the bezier
 *  degenerates to the straight line). Anything else is Custom — the handle layer.
 *
 *  The tolerance is the force axis's own authoring quantum (`G_GRID`, half of it), the same
 *  bar `polish.test.ts` reads "handles went flat" at: a Δg the chart's readout cannot show
 *  is a Δg the author would meet as the named tag. NOT stage 4's quantizer — that one
 *  re-integrates and owns its own derivation; this is a census, and it counts only.
 *
 *  A flat segment between equal-valued keys is BOTH (the chord is horizontal); it counts
 *  Cubic, the default tag. */
function easings(points: readonly ForcePoint[]): { cubic: number; linear: number; custom: number } {
    const tol = G_GRID / 2;
    const out = { cubic: 0, linear: 0, custom: 0 };
    for (let k = 0; k + 1 < points.length; k++) {
        const a = points[k];
        const b = points[k + 1];
        const span = b.s - a.s;
        const slope = span > 0 ? (b.g - a.g) / span : 0;
        const sides = [a.out, b.in];
        let flat = true;
        let chord = true;
        for (const side of sides) {
            if (!side) continue;
            if (Math.abs(side.dg) > tol) flat = false;
            if (Math.abs(side.dg - slope * side.ds) > tol) chord = false;
        }
        if (flat) out.cubic++;
        else if (chord) out.linear++;
        else out.custom++;
    }
    return out;
}

/** the profile re-integrated through the LIVE f32 `evalForce` path and measured against
 *  the bake by arclength — never the solver's own spine, which would be taking its word. */
function reference(
    bake: SectionResult,
    entry: Entry,
    points: readonly ForcePoint[],
    length: number,
    ds: number,
) {
    const out = evalForce(entry, forceProfile(points, length, ds), ds);
    const sigma = [0];
    for (let i = 0; i < bake.edges; i++) sigma.push(sigma[i] + bake.ds[i]);
    const total = sigma[bake.edges];
    let dev = 0;
    let i = 0;
    for (let j = 0; j <= out.edges; j++) {
        const a = Math.min(j * ds, total);
        while (i < bake.edges - 1 && sigma[i + 1] < a) i++;
        const span = sigma[i + 1] - sigma[i];
        const t = span > 0 ? Math.min(1, Math.max(0, (a - sigma[i]) / span)) : 0;
        const x = bake.posX[i] + t * (bake.posX[i + 1] - bake.posX[i]);
        const y = bake.posY[i] + t * (bake.posY[i + 1] - bake.posY[i]);
        dev = Math.max(dev, Math.hypot(out.posX[j] - x, out.posY[j] - y));
    }
    return {
        dev,
        exit: Math.hypot(
            out.posX[out.edges] - bake.posX[bake.edges],
            out.posY[out.edges] - bake.posY[bake.edges],
        ),
    };
}

const HEAD = [
    "scenario",
    "mode",
    "dof",
    "K",
    "P",
    "conv",
    "dev",
    "floor",
    "held",
    "refDev",
    "refExit",
    "peakG",
    "maxDg",
    "brk",
    "algn",
    "mirr",
    "sngl",
    "eCub",
    "eLin",
    "eCus",
    "minPx",
    "iters",
    "ms",
];
const rows: string[] = [HEAD.join("\t")];

for (const s of scenarios) {
    const entry: Entry = { x: 0, y: 0, theta: 0, v: s.v0 };
    const bake = evalGeo(entry, s.nodes, s.ds);
    const warm = fit(bake.fN, bake.ds, FIT_TOL);
    const floor = authoringFloor(spine(bake, s.ds));
    for (const mode of ["exact", "calm"] as PolishMode[])
        for (const handles of ["free", "aligned"] as HandleDof[]) {
            const t0 = performance.now();
            const out = polish({ bake, entry, points: warm.points, ds: s.ds, mode, handles });
            const ms = performance.now() - t0;
            const sc = panelScale(out.points, out.length, out.ds);
            const c = census(out.points, sc);
            const e = easings(out.points);
            const r = reference(bake, entry, out.points, out.length, out.ds);
            let minPx = Number.POSITIVE_INFINITY;
            for (const p of out.points)
                for (const side of [p.in, p.out])
                    if (side) minPx = Math.min(minPx, Math.hypot(side.ds * sc.s, side.dg * sc.g));
            rows.push(
                [
                    s.name,
                    mode,
                    handles,
                    `${out.keys}`,
                    `${handles === "aligned" ? 2 * out.keys : 3 * out.keys - 2}`,
                    out.converged ? "y" : "NO",
                    out.deviation.toExponential(2),
                    floor.toExponential(2),
                    out.heldFloor ? "y" : "NO",
                    r.dev.toExponential(2),
                    r.exit.toExponential(2),
                    out.peakG.toFixed(2),
                    out.maxDg.toFixed(3),
                    `${c.broken}`,
                    `${c.aligned}`,
                    `${c.mirror}`,
                    `${c.single}`,
                    `${e.cubic}`,
                    `${e.linear}`,
                    `${e.custom}`,
                    minPx.toFixed(2),
                    `${out.iters}`,
                    ms.toFixed(0),
                ].join("\t"),
            );
        }
}

console.log(rows.join("\n"));

// ---- stage 3: the refine loop against the fixed-knot baseline it replaces ----
// The tier's shipping answer is the last row's `aligned`/`calm` pair; this sweep re-solves
// it with the KNOTS chosen by `refine` instead of by `fit`, so the delta attributes to lock
// 3/4 (placement) rather than to the DOF family or the prior. Roughness is the fairing
// seminorm, which with the dense peak is what "violence" means after stage 2's metric law —
// maxDg does not measure it.
const REFINE_HEAD = [
    "scenario",
    "baseK",
    "refK",
    "floor",
    "baseDev",
    "refDev",
    "baseHeld",
    "refHeld",
    "basePeak",
    "refPeak",
    "baseRough",
    "refRough",
    "brk",
    "corners",
    "probes",
    "solves",
    "ms",
    "events",
];
const refineRows: string[] = [REFINE_HEAD.join("\t")];
for (const s of scenarios) {
    const entry: Entry = { x: 0, y: 0, theta: 0, v: s.v0 };
    const bake = evalGeo(entry, s.nodes, s.ds);
    const warm = fit(bake.fN, bake.ds, FIT_TOL);
    const floor = authoringFloor(spine(bake, s.ds));
    const base = polish({
        bake,
        entry,
        points: warm.points,
        ds: s.ds,
        mode: "calm",
        handles: "aligned",
    });
    const t0 = performance.now();
    const r = refine({ bake, entry, ds: s.ds });
    const ms = performance.now() - t0;
    const rough = (pts: readonly ForcePoint[]): number =>
        fairNorm(fairRows(pts, "aligned"), readDof(pts, "aligned"));
    refineRows.push(
        [
            s.name,
            `${base.keys}`,
            `${r.final.keys}`,
            floor.toFixed(4),
            base.deviation.toFixed(4),
            r.final.deviation.toFixed(4),
            base.heldFloor ? "y" : "NO",
            r.final.heldFloor ? "y" : "NO",
            base.peakG.toFixed(2),
            r.final.peakG.toFixed(2),
            rough(base.points).toExponential(1),
            rough(r.final.points).toExponential(1),
            `${r.final.points.filter((p) => !collinear(p.in, p.out)).length}`,
            `${r.cornerKnots.length}`,
            `${r.probes}`,
            `${r.solves}`,
            ms.toFixed(0),
            r.events
                .map(
                    (e) =>
                        ({
                            init: "i",
                            split: "s",
                            prune: "p",
                            corner: "C",
                            stall: "!",
                            budget: "B",
                        })[e.kind],
                )
                .join(""),
        ].join("\t"),
    );
}
console.log(`\n${refineRows.join("\n")}`);
