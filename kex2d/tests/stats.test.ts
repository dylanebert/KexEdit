import { describe, expect, test } from "bun:test";
import { V_WARN } from "../src/bake";
import { V_FLOOR } from "../src/forward";
import { scenarios } from "../src/scenarios";
import { evalGeo, type Entry } from "../src/section";
import {
    airtimeMoments,
    type BakeOutLike,
    computeStats,
    cumulativeArclength,
    feasibilitySpans,
    gEnvelope,
    speedRange,
    trackLength,
} from "../src/stats";
import { rk4 } from "./oracles/rk4";

const G = 9.80665;

/** builds the `t`/`feasible`/`firstInfeasible` fields the real bake computes
 *  (`track.ts`'s `computeTime`), independently re-derived here rather than
 *  imported — `track.ts` is out of this stage's footprint, and stats.ts must
 *  consume this shape without ever importing the ECS layer that produces it. */
function timeAndFeasibility(
    v: ArrayLike<number>,
    ds: ArrayLike<number>,
    count: number,
): { t: Float32Array; feasible: Uint8Array; firstInfeasible: number; tTotal: number } {
    const t = new Float32Array(count);
    const feasible = new Uint8Array(count);
    feasible[0] = Math.abs(v[0]) >= V_WARN ? 1 : 0;
    let firstInfeasible = feasible[0] === 0 ? 0 : -1;
    for (let i = 0; i < count - 1; i++) {
        const vA = Math.max(Math.abs(v[i]), V_FLOOR);
        const vB = Math.max(Math.abs(v[i + 1]), V_FLOOR);
        t[i + 1] = t[i] + ds[i] / (0.5 * (vA + vB));
        const f = Math.abs(v[i + 1]) >= V_WARN ? 1 : 0;
        feasible[i + 1] = f;
        if (firstInfeasible < 0 && f === 0) firstInfeasible = i + 1;
    }
    return { t, feasible, firstInfeasible, tTotal: count > 0 ? t[count - 1] : 0 };
}

function bakeFrom(
    fN: ArrayLike<number>,
    ds: ArrayLike<number>,
    v: ArrayLike<number>,
    count: number,
): BakeOutLike {
    const { t, feasible, firstInfeasible, tTotal } = timeAndFeasibility(v, ds, count);
    return { fN, ds, v, t, tTotal, feasible, firstInfeasible };
}

describe("cumulativeArclength / trackLength", () => {
    test("s[0] = 0, s[i] = sum of prior edges", () => {
        const ds = [1, 2, 3, 4];
        const s = cumulativeArclength(ds, 5);
        expect(Array.from(s)).toEqual([0, 1, 3, 6, 10]);
    });

    test("trackLength equals the last cumulative entry without allocating the table", () => {
        const ds = [1, 2, 3, 4];
        expect(trackLength(ds, 5)).toBe(10);
        expect(trackLength(ds, 5)).toBe(cumulativeArclength(ds, 5)[4]);
    });

    test("count 0 and 1 have zero edges", () => {
        expect(trackLength([1, 2], 0)).toBe(0);
        expect(trackLength([1, 2], 1)).toBe(0);
        expect(Array.from(cumulativeArclength([1, 2], 1))).toEqual([0]);
    });
});

describe("speedRange", () => {
    test("min/max over live samples only", () => {
        const v = [5, 12, 3, 9];
        expect(speedRange(v, 4)).toEqual({ min: 3, max: 12 });
    });

    test("ignores samples past count", () => {
        const v = [5, 12, 3, 9, 999];
        expect(speedRange(v, 4)).toEqual({ min: 3, max: 12 });
    });
});

describe("gEnvelope", () => {
    test("min/max fN over edges [0, count-1), tagged with leading-sample station", () => {
        // ds = [1,1,1,1] -> stations [0,1,2,3,4]; fN has 4 edges.
        const out = { fN: [1.0, 4.0, -2.0, 2.5], ds: [1, 1, 1, 1] };
        const env = gEnvelope(out, 5)!;
        expect(env.max).toEqual({ value: 4.0, station: 1, index: 1 });
        expect(env.min).toEqual({ value: -2.0, station: 2, index: 2 });
    });

    test("ties keep the first index reached", () => {
        const out = { fN: [3.0, 3.0, 1.0], ds: [1, 1, 1] };
        const env = gEnvelope(out, 4)!;
        expect(env.max.index).toBe(0);
    });

    test("null with fewer than 2 samples (no edges)", () => {
        expect(gEnvelope({ fN: [1], ds: [1] }, 1)).toBeNull();
        expect(gEnvelope({ fN: [], ds: [] }, 0)).toBeNull();
    });
});

describe("airtimeMoments", () => {
    // edges: [1.5, -0.5, -0.2, 0.8, -1.0], ds all 1 -> stations [0,1,2,3,4,5]
    const ds = [1, 1, 1, 1, 1];
    const t = [0, 1, 2, 3, 4, 5];
    const fN = [1.5, -0.5, -0.2, 0.8, -1.0];
    const out = { fN, ds, t };

    test("groups contiguous below-threshold edges into spans with s/m duration", () => {
        const moments = airtimeMoments(out, 6, 0);
        expect(moments).toEqual([
            {
                startIndex: 1,
                endIndex: 3,
                startStation: 1,
                endStation: 3,
                startTime: 1,
                endTime: 3,
                durationS: 2,
                durationM: 2,
            },
            {
                startIndex: 4,
                endIndex: 5,
                startStation: 4,
                endStation: 5,
                startTime: 4,
                endTime: 5,
                durationS: 1,
                durationM: 1,
            },
        ]);
    });

    test("threshold moves which edges count", () => {
        // at threshold 1.0 every edge but the first qualifies -> one span.
        const moments = airtimeMoments(out, 6, 1.0);
        expect(moments.length).toBe(1);
        expect(moments[0]).toMatchObject({ startIndex: 1, endIndex: 5 });
    });

    test("no edges below threshold -> empty", () => {
        expect(airtimeMoments(out, 6, -10)).toEqual([]);
    });

    test("a run reaching the last edge closes at count-1", () => {
        const out2 = { fN: [1, -1], ds: [2, 2], t: [0, 1, 2] };
        const moments = airtimeMoments(out2, 3, 0);
        expect(moments).toEqual([
            {
                startIndex: 1,
                endIndex: 2,
                startStation: 2,
                endStation: 4,
                startTime: 1,
                endTime: 2,
                durationS: 1,
                durationM: 2,
            },
        ]);
    });
});

describe("feasibilitySpans", () => {
    test("splits on every feasible-value transition", () => {
        const feasible = [1, 1, 0, 0, 0, 1];
        const ds = [1, 1, 1, 1, 1];
        const t = [0, 1, 2, 3, 4, 5];
        const spans = feasibilitySpans({ feasible, ds, t }, 6);
        expect(spans).toEqual([
            {
                feasible: true,
                startIndex: 0,
                endIndex: 2,
                startStation: 0,
                endStation: 1,
                startTime: 0,
                endTime: 1,
            },
            {
                feasible: false,
                startIndex: 2,
                endIndex: 5,
                startStation: 2,
                endStation: 4,
                startTime: 2,
                endTime: 4,
            },
            {
                feasible: true,
                startIndex: 5,
                endIndex: 6,
                startStation: 5,
                endStation: 5,
                startTime: 5,
                endTime: 5,
            },
        ]);
    });

    test("fully feasible chain is one span", () => {
        const spans = feasibilitySpans({ feasible: [1, 1, 1], ds: [1, 1], t: [0, 1, 2] }, 3);
        expect(spans.length).toBe(1);
        expect(spans[0].feasible).toBe(true);
    });

    test("the first infeasible span starts at firstInfeasible", () => {
        const v = [10, 10, 0.2, 10];
        const ds = [1, 1, 1];
        const { feasible, t, firstInfeasible } = timeAndFeasibility(v, ds, 4);
        const spans = feasibilitySpans({ feasible, ds, t }, 4);
        const bad = spans.find((s) => !s.feasible);
        expect(bad?.startIndex).toBe(firstInfeasible);
    });
});

describe("computeStats — integration", () => {
    test("aggregates length/time/speed/g/airtime/feasibility in one pass", () => {
        const ds = [1, 1, 1, 1];
        const v = [10, 10, 10, 10, 10];
        const fN = [1, -1, 1, 1];
        const out = bakeFrom(fN, ds, v, 5);
        const stats = computeStats(out, 5);
        expect(stats.length).toBe(4);
        expect(stats.totalTime).toBe(out.tTotal);
        expect(stats.speedMin).toBe(10);
        expect(stats.speedMax).toBe(10);
        expect(stats.gEnvelope).toEqual({
            min: { value: -1, station: 1, index: 1 },
            max: { value: 1, station: 0, index: 0 },
        });
        expect(stats.airtimeMoments.length).toBe(1);
        expect(stats.airtimeMoments[0]).toMatchObject({ startIndex: 1, endIndex: 2 });
        expect(stats.feasibilitySpans).toEqual([
            {
                feasible: true,
                startIndex: 0,
                endIndex: 5,
                startStation: 0,
                endStation: 4,
                startTime: 0,
                endTime: out.t[4],
            },
        ]);
    });

    test("count 0 returns a zeroed, non-throwing struct", () => {
        const stats = computeStats(bakeFrom([], [], [], 0), 0);
        expect(stats).toEqual({
            length: 0,
            totalTime: 0,
            speedMin: 0,
            speedMax: 0,
            gEnvelope: null,
            airtimeMoments: [],
            feasibilitySpans: [],
        });
    });
});

describe("analytic: flat horizontal line -> 1g everywhere, constant speed", () => {
    // mirrors rk4.test.ts's own "F_n = 1 at θ₀ = 0" case: with F_n locked to 1 and
    // θ₀ = 0, dθ/dt = 0 so the path never leaves the horizontal and v never changes —
    // the textbook 1g-on-the-flats case every rider stat should read back exactly.
    const v0 = 10;
    const ds = 0.5;
    const N = 16;
    const traj = rk4(0, 0, 0, v0, N, ds, () => 1.0, G);

    test("stats reads exactly 1g, constant speed, full length, no airtime", () => {
        const v = new Float32Array(traj.map((s) => s[3]));
        const dsArr = new Float32Array(N - 1).fill(ds);
        const fN = new Float32Array(N - 1).fill(1.0);
        const out = bakeFrom(fN, dsArr, v, N);
        const stats = computeStats(out, N);

        expect(stats.length).toBeCloseTo((N - 1) * ds, 10);
        expect(stats.speedMin).toBeCloseTo(v0, 6);
        expect(stats.speedMax).toBeCloseTo(v0, 6);
        expect(stats.gEnvelope!.min.value).toBeCloseTo(1, 10);
        expect(stats.gEnvelope!.max.value).toBeCloseTo(1, 10);
        expect(stats.airtimeMoments).toEqual([]);
        expect(stats.feasibilitySpans.length).toBe(1);
        expect(stats.feasibilitySpans[0].feasible).toBe(true);
    });
});

describe("analytic: circular arc -> known rider-felt g", () => {
    // a cart constrained to a circle of radius r has a kinematic heading law
    // θ(σ) = σ/r independent of speed (`dθ/dσ = 1/r`), and since F_n does no
    // work, energy conservation gives v(σ)² = v0² − 2·g·y(σ) with
    // y(σ) = r·(1 − cos θ(σ)) (the same `circleNode` parametrization
    // `scenarios.ts` builds its arcs from). Solving the ODE's own
    // dθ/dt = (F_n − cosθ)·g/v for the F_n that REALIZES θ(σ) = σ/r gives the
    // textbook rider-felt-g formula: F_n(σ) = cos θ(σ) + v(σ)²/(r·g) — this is
    // the closed form under test, not re-derived from stats.ts.
    const r = 50;
    const v0 = 20;
    const arcLen = r * (Math.PI / 6); // 30°, `scenarios.circularArc`'s own sweep
    const N = 61;
    const ds = arcLen / (N - 1);

    const theta = (sigma: number) => sigma / r;
    const ySigma = (sigma: number) => r * (1 - Math.cos(theta(sigma)));
    const vSigma = (sigma: number) => Math.sqrt(Math.max(v0 * v0 - 2 * G * ySigma(sigma), 0));
    const fNClosed = (sigma: number) => Math.cos(theta(sigma)) + vSigma(sigma) ** 2 / (r * G);

    test("rk4 driven by the closed-form F_n(σ) actually follows the circle", () => {
        // control: prove the closed form is self-consistent before trusting it as
        // ground truth — the trajectory it drives must reproduce θ(σ) = σ/r and
        // the energy-conservation v(σ) it was built from.
        const traj = rk4(0, 0, 0, v0, N, ds, fNClosed, G);
        for (let i = 0; i < N; i += 12) {
            const sigma = i * ds;
            expect(traj[i][2]).toBeCloseTo(theta(sigma), 4);
            expect(traj[i][3]).toBeCloseTo(vSigma(sigma), 3);
        }
    });

    test("stats' g envelope matches the closed form at the correct stations", () => {
        // fN sampled per-edge at each edge's leading station (station convention
        // this module documents), independent of any rk4 run.
        const fN = new Float32Array(N - 1);
        const dsArr = new Float32Array(N - 1).fill(ds);
        const v = new Float32Array(N);
        for (let i = 0; i < N - 1; i++) fN[i] = fNClosed(i * ds);
        for (let i = 0; i < N; i++) v[i] = vSigma(i * ds);

        const out = bakeFrom(fN, dsArr, v, N);
        const env = gEnvelope(out, N)!;

        // θ increases monotonically over [0, 30°] so cosθ falls monotonically while
        // v also falls (climbing) — cosθ dominates near σ=0 (max) and the tail
        // (σ near arcLen) reads the smallest combined value in this regime.
        expect(env.max.value).toBeCloseTo(fNClosed(0), 5);
        expect(env.max.station).toBeCloseTo(0, 6);
        expect(env.min.value).toBeCloseTo(fNClosed((N - 2) * ds), 5);
        expect(env.min.station).toBeCloseTo((N - 2) * ds, 6);
    });
});

describe("scenario corpus regression", () => {
    // every scenario in `scenarios.ts` should bake to a coherent stats readback:
    // finite, positive length/time, speed bounds matching the raw sample array,
    // and — since `scenarios.test.ts` already proves every scenario stays above
    // V_WARN throughout — a single, fully-feasible span.
    for (const s of scenarios) {
        test(`${s.name}: coherent readback over the baked chain`, () => {
            const entry: Entry = { x: 0, y: 0, theta: 0, v: s.v0 };
            const r = evalGeo(entry, s.nodes, s.ds);
            const count = r.edges + 1;
            const out = bakeFrom(r.fN, r.ds, r.v, count);
            const stats = computeStats(out, count);

            let minV = Number.POSITIVE_INFINITY;
            let maxV = Number.NEGATIVE_INFINITY;
            let length = 0;
            for (let i = 0; i < count; i++) {
                minV = Math.min(minV, r.v[i]);
                maxV = Math.max(maxV, r.v[i]);
            }
            for (let i = 0; i < count - 1; i++) length += r.ds[i];

            expect(Number.isFinite(stats.length)).toBe(true);
            expect(stats.length).toBeCloseTo(length, 6);
            expect(stats.totalTime).toBeGreaterThan(0);
            expect(stats.speedMin).toBeCloseTo(minV, 6);
            expect(stats.speedMax).toBeCloseTo(maxV, 6);
            expect(stats.gEnvelope).not.toBeNull();
            expect(stats.feasibilitySpans.length).toBe(1);
            expect(stats.feasibilitySpans[0].feasible).toBe(true);
        });
    }
});
