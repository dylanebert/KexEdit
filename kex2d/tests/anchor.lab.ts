// Recovery-anchor spike (roadmap "kex2d Phase 2a" / scratch "Optimizer design").
//
// Two measurements the design left open, console-only (not a `bun test` gate):
//   1. The fore/aft lobe split — how the compensating force doublet distributes
//      around the pin. scratch.md: "the exact fore/aft lobe distribution (measure
//      in the spike, don't assert)."
//   2. The single-shoot crossover — at what track length one linearized heal stops
//      being clean. The conditioning probe (conditioning.lab.ts) showed the
//      endpoint-position lever grows ~N^1.56; this measures where that shows up as
//      heal-residual growth (the length past which multiple-shooting is wanted).
//
// Run: bun tests/anchor.lab.ts

import { recoveryRows } from "../src/anchor";
import { type Anchor, DEFAULT_BAND, solve } from "../src/solve";
import { forward64, type SampleState } from "./helpers/forward64";

const DS = 0.5;
const SMOOTH = 10;
const BAND_WEIGHT = 4;
const STIFF = 1e4; // pin + anchor weight

function rollout(F: Float64Array | Float32Array, n: number, v0: number): SampleState[] {
    const fn = (s: number): number => F[Math.min(n - 1, Math.round(s / DS))];
    return forward64(0, 0, 0, v0, n, DS, fn);
}

/** smooth gentle draft (continuous, in-band), fixed per-length shape. */
function draft(n: number): Float64Array {
    const F = new Float64Array(n);
    for (let i = 0; i < n; i++) F[i] = 1 + 0.25 * Math.sin((2 * Math.PI * (i * DS)) / 14);
    return F;
}

function anchorsAt(theta: Float64Array, v: Float64Array, n: number, r: number): Anchor[] {
    const ds = new Float32Array(n - 1).fill(DS);
    const rows = recoveryRows(theta, v, ds, r);
    return [
        { row: rows.x, weight: STIFF },
        { row: rows.y, weight: STIFF },
        { row: rows.theta, weight: STIFF },
    ];
}

// --- 1. fore/aft lobe split -------------------------------------------------
{
    const n = 96;
    const v0 = 24;
    const k = Math.floor(0.25 * n);
    const r = Math.floor(0.7 * n);
    const Fpos = draft(n);
    const fp = Float32Array.from(Fpos);
    const base = rollout(Fpos, n, v0);
    const theta = Float64Array.from(base, (s) => s[2]);
    const v = Float64Array.from(base, (s) => s[3]);

    const con = [{ index: k, value: Fpos[k] + 1.2, weight: STIFF }];
    const anchors = anchorsAt(theta, v, n, r);
    const opts = { posWeight: 1, smooth: SMOOTH, band: DEFAULT_BAND, bandWeight: BAND_WEIGHT };
    const solved = solve(fp, { ...opts, con, anchors }).fN;

    // the doublet is the deviation of the solved force from the draft prior.
    const dF = Float64Array.from(solved, (f, i) => f - Fpos[i]);
    let foreArea = 0; // i < k  (upstream of the pin)
    let aftArea = 0; //  k ≤ i < r (the compensation span)
    let tailArea = 0; // i ≥ r  (should be ≈ 0)
    let dfMax = 0;
    let dfMin = 0;
    for (let i = 0; i < n; i++) {
        const a = dF[i] * DS;
        if (i < k) foreArea += a;
        else if (i < r) aftArea += a;
        else tailArea += a;
        dfMax = Math.max(dfMax, dF[i]);
        dfMin = Math.min(dfMin, dF[i]);
    }
    console.log("--- fore/aft lobe split ---");
    console.log(
        `n=${n} pin@${k} recovery@${r}  ΔF peak=${dfMax.toFixed(3)} trough=${dfMin.toFixed(3)} g`,
    );
    console.log(
        `∫ΔF·ds  fore[0,k)=${foreArea.toFixed(3)}  comp[k,r)=${aftArea.toFixed(3)}  ` +
            `tail[r,n)=${tailArea.toFixed(3)}  (g·m)`,
    );
    console.log(
        `net ∫ΔF over [0,r)=${(foreArea + aftArea).toFixed(3)} g·m ` +
            `(→ ≈0 means the doublet cancels the heading the pin adds)\n`,
    );

    // compact ΔF sparkline over [0, r+5].
    const ramp = " .:-=+*#%@";
    const span = Math.min(n, r + 5);
    const scale = Math.max(dfMax, -dfMin) || 1;
    let pos = "";
    let neg = "";
    for (let i = 0; i < span; i++) {
        const up = Math.max(dF[i], 0) / scale;
        const dn = Math.max(-dF[i], 0) / scale;
        pos += ramp[Math.min(9, Math.round(up * 9))];
        neg += ramp[Math.min(9, Math.round(dn * 9))];
    }
    console.log(`ΔF>0 ${pos}`);
    console.log(`ΔF<0 ${neg}`);
    console.log(`     ${" ".repeat(k)}^pin${" ".repeat(Math.max(0, r - k - 4))}^recovery\n`);
}

// --- 2. single-shoot heal residual vs length --------------------------------
{
    console.log("--- single-shoot crossover (heal residual vs N) ---");
    console.log("   N    L(m)   v_min   red_end(m)   green_end(m)   ratio");
    const v0 = 40; // high launch so v stays in-regime at every N (cf. conditioning.lab)
    for (const n of [48, 96, 192, 384, 768]) {
        const k = Math.floor(0.25 * n);
        const r = n - 1; // worst case: heal the full remaining length
        const Fpos = draft(n);
        const fp = Float32Array.from(Fpos);
        const base = rollout(Fpos, n, v0);
        const theta = Float64Array.from(base, (s) => s[2]);
        const v = Float64Array.from(base, (s) => s[3]);
        const vMin = Math.min(...v);

        const con = [{ index: k, value: Fpos[k] + 1.2, weight: STIFF }];
        const anchors = anchorsAt(theta, v, n, r);
        const opts = { posWeight: 1, smooth: SMOOTH, band: DEFAULT_BAND, bandWeight: BAND_WEIGHT };
        const red = rollout(solve(fp, { ...opts, con }).fN, n, v0);
        const green = rollout(solve(fp, { ...opts, con, anchors }).fN, n, v0);

        const off = (a: SampleState[]): number =>
            Math.hypot(a[n - 1][0] - base[n - 1][0], a[n - 1][1] - base[n - 1][1]);
        const redEnd = off(red);
        const greenEnd = off(green);
        console.log(
            `${String(n).padStart(5)} ${(n * DS).toFixed(0).padStart(6)} ${vMin.toFixed(1).padStart(7)} ` +
                `${redEnd.toExponential(2).padStart(11)} ${greenEnd.toExponential(2).padStart(13)} ` +
                `${(redEnd / greenEnd).toFixed(0).padStart(7)}`,
        );
    }
    console.log(
        "\ngreen_end is the O(δ²) linearization residual; the length where it stops\n" +
            "shrinking (relative to red) marks the single-shoot crossover — past it,\n" +
            "re-linearization (Gauss-Newton) or multiple-shooting is the lever.",
    );
}
