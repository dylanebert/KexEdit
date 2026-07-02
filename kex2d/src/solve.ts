import type { State } from "@dylanebert/shallot";
import { V_WARN } from "./bake";
import {
    collocate,
    collocateAL,
    collocateRTI,
    createRTIState,
    type PosTerm,
    type RTIState,
    type Terms,
} from "./collocate";
import {
    bandConfig,
    comfortConfig,
    constraintRev,
    type PinRow,
    pinRows,
    pinsFor,
    type PosPinRow,
    posPinsFor,
} from "./constraints";
import { forces64 } from "./force";
import { gestureActive } from "./history";
import { arcResample, fracResample, polylineLength } from "./resample";

/** the solver riding the live bake (spec `kex/specs/kex2d-unified-solver.md`,
 *  Stage 4). `BakeSystem` calls `solveStep` once per tick for a constrained
 *  track; the realized track (`samples`/`bakeOut`) is baked from the SOLVED
 *  geometry, so cart/timeline/render consume the solve with zero changes.
 *
 *  INVARIANT: the solver never writes authored state. `Handle.pos/theta` and
 *  `Pin.*` are inputs; output goes only to `SolveState` (and from there to
 *  `samples`/`bakeOut` in the bake). `bakeHash` reads only Handles, so solver
 *  writes can never re-trigger the bake — no feedback loop by construction.
 *
 *  the RTI schedule (Stage-2 evidence): one PHR-AL outer per tick, ≤15 LM
 *  inners, warm-started from the previous tick's solution; the λ multipliers
 *  persist in `SolveState.rti` — that carry is what converges a drag across
 *  frames. the solver grid is FIXED mid-gesture (the draft is resampled onto
 *  it); length adaptation happens only at gesture rest, by arclength
 *  resampling — never by index (the prior spec's "injects kinks" finding). */

const G = 9.80665;
/** solver grid cap; past it the grid coarsens rather than growing. */
const MAX_SOLVE_N = 1024;
/** band satisfaction tolerance (g) — the collocateAL/RTI contract value. */
const TOL = 1e-3;
/** pin "satisfied" readout threshold (g): half the documented ~0.1 g
 *  forces64-vs-display-bake centering gap — differences below it are not
 *  legible on the display curve anyway. */
const PIN_TOL = 0.05;
/** position-pin "satisfied" threshold (m): one worst-case viewport pixel. */
const POS_TOL = 0.15;
/** stage-2 standard soft terms. */
const W_SHAPE = 0.1;
const W_CHORD = 1;
const RHO0 = 50;
const INNERS = 15;
/** RTI stop test: once the constraint contract is met (band ≤ TOL), stop
 *  when an outer moves no node more than this (m). derived from BOTH display
 *  spaces: 0.5 mm is ~1/300 px in the viewport (≥0.15 m/px), and through the
 *  measured worst force sensitivity at a high-κ crest (~10 g/m of node
 *  motion) it bounds the residual noise floor at ~0.005 g — a tenth of the
 *  0.05 g readout threshold, so where the solve stops can never flip a
 *  "satisfied" verdict (a 5 mm stop measurably could: the same optimum
 *  landed at 2e-4 g or 5.1e-2 g depending on tick cadence). what remains
 *  past this is the LM crawling the soft-term valley — invisible by
 *  construction, and any edit re-opens the solve. */
const STEP_TOL = 5e-4;

export interface ConstraintReport {
    kind: "pin" | "band" | "pos";
    /** pin eid (selection) + stable authored id (gestures/undo). */
    eid?: number;
    id?: number;
    /** anchor arclength (m); for the band, the worst-violation location. */
    sigma: number;
    /** pin target / the violated band edge (g); 0 for a position pin. */
    target: number;
    /** `forces64` at the anchor on the solved geometry (g) — solver-space,
     *  honest to the solve; the display bake differs by the documented
     *  ~0.1 g node-vs-edge gap. */
    achieved: number;
    /** achieved − target, signed (g) — "losing by this much". a position
     *  pin's residual is its distance to the target (m). */
    residual: number;
    satisfied: boolean;
}

/** the draft polyline a solve pass consumes — `sampleChain` output. */
export interface DraftInput {
    posX: Float32Array;
    posY: Float32Array;
    /** per-edge chord lengths (`count − 1` valid entries). */
    dsArr: Float32Array;
    count: number;
    /** sample index of each baked node, for the `Handle.sample` remap. */
    offsets: number[];
}

export interface SolveState {
    /** solver grid size + nominal spacing. */
    n: number;
    ds: number;
    v0: number;
    /** current solved geometry (the realized track's source). */
    x: Float64Array;
    y: Float64Array;
    /** P° — the authored spine resampled onto the solver grid. */
    draftX: Float64Array;
    draftY: Float64Array;
    fTarget: Float64Array;
    wF: Float64Array;
    rti: RTIState | null;
    /** authored nodes as fractions of draft arclength (Handle.sample remap). */
    nodeFracs: number[];
    draftHash: string;
    rev: string;
    /** LM stationary AND band within tolerance — stop iterating. NOT a health
     *  claim: a step-size stall also lands here; health is the report. */
    converged: boolean;
    /** converged and the grid matches the solved length — skip the pass. */
    settled: boolean;
    /** draft is energy-infeasible (v < V_WARN somewhere) — the solve is
     *  physically meaningless there; identity fallback, red-track UX. */
    suspended: boolean;
    report: ConstraintReport[];
}

/** transient per-track solve state (mirrors `cartState`) — derived, never
 *  authored; deleted when the last constraint goes. */
export const solveState = new Map<number, SolveState>();

function gridIndex(sigma: number, ds: number, n: number): number {
    return Math.max(1, Math.min(n - 2, Math.round(sigma / ds)));
}

function buildTargets(st: SolveState, pins: PinRow[]): void {
    st.fTarget.fill(0);
    st.wF.fill(0);
    for (const p of pins) {
        for (const row of pinRows(p.sigma, p.w, p.width, st.ds, st.n)) {
            st.wF[row.i] = row.w;
            st.fTarget[row.i] = p.f;
        }
    }
}

function posTerm(st: SolveState, posPins: PosPinRow[]): PosTerm | undefined {
    if (posPins.length === 0) return undefined;
    return {
        rows: posPins.map((p) => ({
            i: gridIndex(p.sigma, st.ds, st.n),
            x: p.x,
            y: p.y,
            w: p.w,
        })),
    };
}

/** the live solve's term set — one assembly shared by the RTI pass and the
 *  relax solve (which only rescales the shape weight). */
function liveTerms(
    ecs: State,
    trackEid: number,
    st: SolveState,
    shapeW: number,
    rho: number,
): Terms {
    const band = bandConfig.get(trackEid);
    const comfort = comfortConfig.get(trackEid);
    return {
        wF: st.wF,
        band: band ? { ...band, w: rho } : undefined,
        shape: { w: shapeW },
        chord: { w: W_CHORD },
        pos: posTerm(st, posPinsFor(ecs, trackEid)),
        fRough: comfort ? { w: comfort } : undefined,
    };
}

function report(
    st: SolveState,
    pins: PinRow[],
    posPins: PosPinRow[],
    band: { lo: number; hi: number } | undefined,
) {
    const { fN } = forces64(st.x, st.y, st.n, st.v0);
    const out: ConstraintReport[] = [];
    for (const p of pins) {
        const i = gridIndex(p.sigma, st.ds, st.n);
        const achieved = fN[i];
        const residual = achieved - p.f;
        out.push({
            kind: "pin",
            eid: p.eid,
            id: p.id,
            sigma: p.sigma,
            target: p.f,
            achieved,
            residual,
            satisfied: Math.abs(residual) < PIN_TOL,
        });
    }
    for (const p of posPins) {
        const i = gridIndex(p.sigma, st.ds, st.n);
        const dist = Math.hypot(st.x[i] - p.x, st.y[i] - p.y);
        out.push({
            kind: "pos",
            eid: p.eid,
            id: p.id,
            sigma: p.sigma,
            target: 0,
            achieved: dist,
            residual: dist,
            satisfied: dist < POS_TOL,
        });
    }
    if (band) {
        let worst = 0;
        let arg = 1;
        for (let i = 1; i < st.n - 1; i++) {
            const v = Math.max(fN[i] - band.hi, band.lo - fN[i]);
            if (v > worst) {
                worst = v;
                arg = i;
            }
        }
        const above = fN[arg] - band.hi >= band.lo - fN[arg];
        out.push({
            kind: "band",
            sigma: arg * st.ds,
            target: above ? band.hi : band.lo,
            achieved: fN[arg],
            residual: fN[arg] - (above ? band.hi : band.lo),
            satisfied: worst < TOL,
        });
    }
    st.report = out;
}

/** one solve pass for a constrained track. `draft` is required on a bake-hash
 *  miss (the authored spine changed) and null on polish ticks (reuse the
 *  stored grid). returns the state; `suspended` means the caller should bake
 *  the draft identity path instead. */
export function solveStep(
    ecs: State,
    trackEid: number,
    draft: DraftInput | null,
    draftHash: string,
    v0: number,
    dsNominal: number,
): SolveState {
    const rev = constraintRev(ecs, trackEid);
    const band = bandConfig.get(trackEid);
    const pins = pinsFor(ecs, trackEid);
    let st = solveState.get(trackEid);

    if (draft) {
        // energy feasibility of the authored spine: below V_WARN the forward
        // model leaves the differentiable regime (vSafe/sqrt clamps) and the
        // solve is meaningless — suspend, let the red-track UX tell it.
        let minV2 = Number.POSITIVE_INFINITY;
        for (let i = 0; i < draft.count; i++) {
            minV2 = Math.min(minV2, v0 * v0 - 2 * G * (draft.posY[i] - draft.posY[0]));
        }
        if (minV2 < V_WARN * V_WARN || draft.count < 4) {
            const dead = st ?? emptyState(v0, dsNominal);
            dead.suspended = true;
            dead.draftHash = draftHash;
            dead.rev = rev;
            dead.report = [];
            solveState.set(trackEid, dead);
            return dead;
        }

        const lDraft = polylineLength(draft.posX, draft.posY, draft.count);
        if (!st || st.suspended) {
            const n = Math.max(4, Math.min(MAX_SOLVE_N, Math.round(lDraft / dsNominal) + 1));
            st = emptyState(v0, dsNominal, n);
            arcResample(draft.posX, draft.posY, draft.count, st.draftX, st.draftY, n);
            st.x.set(st.draftX);
            st.y.set(st.draftY);
            solveState.set(trackEid, st);
        } else {
            // grid FIXED mid-gesture: project the new draft onto it.
            arcResample(draft.posX, draft.posY, draft.count, st.draftX, st.draftY, st.n);
            // endpoints are hard pins — the solved curve follows them.
            st.x[0] = st.draftX[0];
            st.y[0] = st.draftY[0];
            st.x[st.n - 1] = st.draftX[st.n - 1];
            st.y[st.n - 1] = st.draftY[st.n - 1];
        }
        // authored nodes at draft-arclength fractions, for Handle.sample.
        st.nodeFracs = [];
        {
            let acc = 0;
            let next = 0;
            for (let i = 0; i < draft.count; i++) {
                if (next < draft.offsets.length && draft.offsets[next] === i) {
                    st.nodeFracs.push(lDraft > 0 ? acc / lDraft : 0);
                    next++;
                }
                if (i < draft.count - 1) acc += draft.dsArr[i];
            }
        }
        st.draftHash = draftHash;
        st.converged = false;
        st.settled = false;
        st.suspended = false;
    }

    if (!st) {
        // no stored state and no draft — nothing to solve from.
        st = emptyState(v0, dsNominal);
        st.suspended = true;
        solveState.set(trackEid, st);
        return st;
    }
    if (st.suspended) return st;

    if (rev !== st.rev) {
        buildTargets(st, pins);
        if (band && !st.rti) st.rti = createRTIState(st.n, RHO0);
        if (!band) st.rti = null;
        st.rev = rev;
        st.converged = false;
        st.settled = false;
    }

    if (st.settled) return st;

    if (!st.converged) {
        const r = collocateRTI(
            {
                fTarget: st.fTarget,
                x0: st.draftX,
                y0: st.draftY,
                ds: st.ds,
                v0: st.v0,
                wData: 0,
                terms: liveTerms(ecs, trackEid, st, W_SHAPE, st.rti?.rho ?? RHO0),
                xInit: st.x,
                yInit: st.y,
                maxIters: INNERS,
            },
            st.rti,
            TOL,
        );
        let finite = true;
        let drift = 0;
        for (let i = 0; i < st.n && finite; i++) {
            finite = Number.isFinite(r.x[i]) && Number.isFinite(r.y[i]);
            drift = Math.max(drift, Math.abs(r.x[i] - st.x[i]), Math.abs(r.y[i] - st.y[i]));
        }
        if (!finite) {
            // defensive: keep the last finite geometry, stop iterating loud.
            console.warn(`kex2d: solve for track ${trackEid} went non-finite; holding last state`);
            st.converged = true;
        } else {
            st.x = r.x;
            st.y = r.y;
            st.converged = (r.converged || drift < STEP_TOL) && (band ? r.viol < TOL : true);
        }
    }

    // length adaptation at gesture rest: arclength-resample onto a fresh
    // uniform grid and continue (releases the fixed-length budget).
    if (st.converged && !gestureActive()) {
        const lSolved = polylineLength(st.x, st.y, st.n);
        const m = Math.max(4, Math.min(MAX_SOLVE_N, Math.round(lSolved / st.ds) + 1));
        if (m !== st.n && Math.abs(lSolved - (st.n - 1) * st.ds) > st.ds / 2) {
            const nx = new Float64Array(m);
            const ny = new Float64Array(m);
            arcResample(st.x, st.y, st.n, nx, ny, m);
            const ndx = new Float64Array(m);
            const ndy = new Float64Array(m);
            arcResample(st.draftX, st.draftY, st.n, ndx, ndy, m);
            if (st.rti) {
                const lo = new Float64Array(m);
                const hi = new Float64Array(m);
                fracResample(st.rti.lamLo, st.n, lo, m);
                fracResample(st.rti.lamHi, st.n, hi, m);
                st.rti.lamLo = lo;
                st.rti.lamHi = hi;
            }
            st.x = nx;
            st.y = ny;
            st.draftX = ndx;
            st.draftY = ndy;
            st.n = m;
            st.fTarget = new Float64Array(m);
            st.wF = new Float64Array(m);
            buildTargets(st, pins); // anchors never resample: re-map σ → index
            st.converged = false;
        } else {
            st.settled = true;
        }
    }

    report(st, pins, posPinsFor(ecs, trackEid), band);
    return st;
}

/** the relax verb's solve: the SAME live problem under a reduced shape
 *  weight, run to convergence (not one RTI outer) from the current solution.
 *  free solver-side — the draft is already an explicit input; committing the
 *  result as the new P° (the node refit) is `relax.ts`'s job. */
export function relaxSolve(
    ecs: State,
    trackEid: number,
    strength: number,
): { x: Float64Array; y: Float64Array; n: number } | null {
    const st = solveState.get(trackEid);
    if (!st || st.suspended) return null;
    const band = bandConfig.get(trackEid);
    const opts = {
        fTarget: st.fTarget,
        x0: st.draftX,
        y0: st.draftY,
        ds: st.ds,
        v0: st.v0,
        wData: 0,
        terms: liveTerms(ecs, trackEid, st, W_SHAPE * strength, RHO0),
        xInit: st.x,
        yInit: st.y,
        maxIters: band ? INNERS : 200,
    };
    const r = band ? collocateAL(opts, { tol: TOL, outers: 40 }) : collocate(opts);
    for (let i = 0; i < st.n; i++) {
        if (!Number.isFinite(r.x[i]) || !Number.isFinite(r.y[i])) return null;
    }
    return { x: r.x, y: r.y, n: st.n };
}

function emptyState(v0: number, ds: number, n = 4): SolveState {
    return {
        n,
        ds,
        v0,
        x: new Float64Array(n),
        y: new Float64Array(n),
        draftX: new Float64Array(n),
        draftY: new Float64Array(n),
        fTarget: new Float64Array(n),
        wF: new Float64Array(n),
        rti: null,
        nodeFracs: [],
        draftHash: "",
        rev: "",
        converged: false,
        settled: false,
        suspended: false,
        report: [],
    };
}
