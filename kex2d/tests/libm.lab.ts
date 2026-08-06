import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { geofit, type GeofitBake } from "../src/geofit";
import { forceProfile } from "../src/profile";
import { refine } from "../src/refine";
import { scenarios } from "../src/scenarios";
import { evalForce, evalGeo } from "../src/section";
import golden from "./fixtures/convert-golden.json";

/** Cross-machine libm diffing lab (`kex2d-golden-reproducibility` 1a). ECMAScript pins the
 *  arithmetic operators and `sqrt` to exact IEEE-754 results but leaves the transcendentals
 *  implementation-defined, and the frozen conversion goldens were minted on a different
 *  platform than this one. This wraps every implementation-defined `Math` call reachable from
 *  the failing paths and emits a per-call table — call index, call site, argument/result bit
 *  patterns — ordered so two platforms' tables diff to the FIRST divergence, never the
 *  noisiest one.
 *
 *  **Two paths, not one.** The five Mac failures span two independent kernels: `circular-arc`
 *  through `section.evalGeo` → `refine` (`refine.ts`/`polish.ts`/`fit.ts`), and `hill-explicit`
 *  through `geofit.ts` (`bake.forces` + `spline.ts`'s `chainCounts`/`sampleAt`), which imports
 *  neither `refine` nor `polish`/`fit` at all. A single-path table would leave the geofit half's
 *  divergence unlocalized, so the lab emits one stamped table per path — driven the way its own
 *  failing test drives it (`geofit.test.ts`'s corpus: `forceProfile` over the frozen golden's
 *  `{s,g}` points → `evalForce` → `geofit`), not an approximation of that call sequence.
 *
 *  The refine solve makes ~7e5 wrapped calls even on its three-key scenario (a dense per-edge
 *  AL Gauss-Newton spine, iterated to convergence), so the full ordered table is a write-once
 *  file on disk (outside the repo — a run-time artifact, not a committed fixture) rather than
 *  console output: printing that many rows would drown the terminal and isn't what a diff needs.
 *  The determinism check hashes the table (`polish.oracle.ts`'s sha256-over-the-corpus
 *  convention) instead of holding two full copies for a deep-equal — cheaper, and the same
 *  strength of evidence: bit-for-bit over the whole ordered sequence, not a sample. */

const WRAPPED = ["sin", "cos", "tan", "atan2", "pow", "exp", "log", "hypot", "cbrt"] as const;
type WrappedFn = (typeof WRAPPED)[number];

interface Call {
    index: number;
    fn: WrappedFn;
    site: string;
    args: string[];
    result: string;
}

/** the raw IEEE-754 bit pattern of `x`, as a fixed-width hex string — the diffable unit, since
 *  a printed decimal can hide the exact ulp two platforms disagree on. */
function bits(x: number): string {
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, x);
    return view.getBigUint64(0).toString(16).padStart(16, "0");
}

/** the exact per-row string the running hasher feeds on — factored out so the ladder computes
 *  from the SAME serialization the whole-table hash uses, never a second spelling of a row
 *  (`kex2d-golden-reproducibility` 1a: two spellings would make a machine's ladder incomparable
 *  with the whole-table hash already frozen in the spec's live log). */
function rowString(call: Call): string {
    return `${call.index}|${call.fn}|${call.site}|${call.args.join(",")}|${call.result}\n`;
}

/** a sha256 over the first `n` recorded rows, using `rowString` — the ONE row serialization the
 *  streaming hasher also feeds on. */
function prefixHash(calls: Call[], n: number): string {
    const hasher = new Bun.CryptoHasher("sha256");
    for (let i = 0; i < n; i++) hasher.update(rowString(calls[i]));
    return hasher.digest("hex") as string;
}

/** the geometric ladder of prefix lengths: 1, 2, 4, 8, ... doubling up to the largest power of
 *  two below `count`, plus `count` itself as the final rung — dense at the front, since a
 *  divergence propagates and the first one is expected early. */
function ladderRungs(count: number): number[] {
    const rungs: number[] = [];
    for (let n = 1; n < count; n *= 2) rungs.push(n);
    rungs.push(count);
    return rungs;
}

/** `x`, bumped by exactly one ulp toward +Infinity — the smallest possible perturbation,
 *  matching the "1 ulp" language the diagnosis measures in. */
function bump(x: number): number {
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, x);
    view.setBigUint64(0, view.getBigUint64(0) + 1n);
    return view.getFloat64(0);
}

/** the immediate caller's `src/file.ts:line:col`, skipping every frame inside this lab file
 *  (the wrapper itself, the test body) so the reported site is the production call site — and
 *  relative to `kex2d/`, since an absolute checkout path differs between the two machines this
 *  table exists to compare. */
function site(): string {
    const frames = (new Error().stack ?? "").split("\n").slice(1);
    for (const frame of frames) {
        if (frame.includes("libm.lab.ts")) continue;
        const match = frame.match(/([^\s(]+\.ts):(\d+):(\d+)/);
        if (!match) continue;
        const [, file, line, col] = match;
        const rel = file.replace(/^.*\/kex2d\//, "");
        return `${rel}:${line}:${col}`;
    }
    return "unknown";
}

interface Wrapped {
    restore: () => void;
    count: () => number;
    counts: Partial<Record<WrappedFn, number>>;
    /** the first recorded call per wrapped function — enough to check a specific site's
     *  reaction to a perturbation without retaining the whole table. */
    firstByFn: Partial<Record<WrappedFn, Call>>;
    /** the full ordered table, only when `collect` is set — a second run only needs the hash to
     *  prove it reproduces the first. */
    calls: Call[];
    hash: () => string;
}

/** wrap every implementation-defined `Math` fn to record a `Call` per invocation, in call
 *  order, streamed into a running sha256 so two runs compare by digest rather than by holding
 *  two full tables. `restore()` puts the originals back — mandatory before the wrapped run's
 *  result is trusted for anything downstream, since a leaked wrapper would perturb every later
 *  test in the same process. */
function wrapMath(collect: boolean): Wrapped {
    const hasher = new Bun.CryptoHasher("sha256");
    let digest: string | undefined;
    const counts: Partial<Record<WrappedFn, number>> = {};
    const firstByFn: Partial<Record<WrappedFn, Call>> = {};
    const calls: Call[] = [];
    let count = 0;
    const originals = WRAPPED.map((fn) => [fn, Math[fn]] as const);
    const patched = Math as unknown as Record<WrappedFn, (...args: number[]) => number>;
    for (const [fn, original] of originals) {
        patched[fn] = (...args: number[]) => {
            const result = (original as (...a: number[]) => number)(...args);
            const call: Call = {
                index: count,
                fn,
                site: site(),
                args: args.map(bits),
                result: bits(result),
            };
            hasher.update(rowString(call));
            counts[fn] = (counts[fn] ?? 0) + 1;
            if (firstByFn[fn] === undefined) firstByFn[fn] = call;
            if (collect) calls.push(call);
            count++;
            return result;
        };
    }
    return {
        restore: () => {
            for (const [fn, original] of originals) patched[fn] = original;
        },
        count: () => count,
        counts,
        firstByFn,
        calls,
        hash: () => {
            digest ??= hasher.digest("hex") as string;
            return digest;
        },
    };
}

function circularArc() {
    const scenario = scenarios.find((candidate) => candidate.name === "circular-arc");
    if (!scenario) throw new Error("missing scenario circular-arc");
    const entry = { x: 0, y: 0, theta: 0, v: scenario.v0 };
    return { scenario, entry };
}

function hillExplicit() {
    const scenario = scenarios.find((candidate) => candidate.name === "hill-explicit");
    if (!scenario) throw new Error("missing scenario hill-explicit");
    const entry = { x: 0, y: 0, theta: 0, v: scenario.v0 };
    return { scenario, entry };
}

const Golden = golden as Record<
    string,
    { points: { s: number; g: number }[]; length: number; ds: number }
>;

/** the refine path's own drive: `section.evalGeo` → `refine`. */
function driveRefine(): void {
    const { scenario, entry } = circularArc();
    const bake = evalGeo(entry, scenario.nodes, scenario.ds);
    refine({ bake, entry, ds: scenario.ds });
}

/** the geofit path's own drive, mirroring `geofit.test.ts`'s corpus construction exactly:
 *  the frozen golden's `{s,g}` points → `profile.forceProfile` → `section.evalForce` →
 *  `geofit`. Building the target bake is part of the golden-producing call sequence, not
 *  a setup step outside it — `hill-explicit reproduces the frozen golden bit-identically`
 *  asserts on `geofit`'s output over exactly this input. */
function driveGeofit(): void {
    const { scenario, entry } = hillExplicit();
    const g = Golden[scenario.name];
    const profile = forceProfile(g.points, g.length, g.ds);
    const bake = evalForce(entry, profile, g.ds);
    const target: GeofitBake = {
        x: bake.posX,
        y: bake.posY,
        fN: bake.fN,
        ds: bake.ds,
        edges: bake.fN.length,
    };
    geofit(target, entry.v);
}

/** one wrapped run of `drive`. */
function runWrapped(collect: boolean, drive: () => void): Wrapped {
    const wrapped = wrapMath(collect);
    try {
        drive();
    } finally {
        wrapped.restore();
    }
    return wrapped;
}

interface PathSpec {
    /** the table's file-safe name and the description in test titles. */
    name: string;
    drive: () => void;
    /** the transcendentals this path actually reaches — reported and asserted nonzero.
     *  Measured directly (a probe run over `WRAPPED`, not assumed from reading the
     *  source): both paths reach exactly sin/cos/atan2/hypot; neither reaches
     *  tan/pow/exp/log/cbrt, so those are reported at zero rather than asserted on. */
    reaches: readonly WrappedFn[];
}

const PATHS: PathSpec[] = [
    {
        name: "circular-arc-refine",
        drive: driveRefine,
        reaches: ["sin", "cos", "atan2", "hypot"],
    },
    {
        name: "hill-explicit-geofit",
        drive: driveGeofit,
        reaches: ["sin", "cos", "atan2", "hypot"],
    },
];

for (const path of PATHS) {
    test(`libm call table — ${path.name} path`, async () => {
        const first = runWrapped(true, path.drive);
        const second = runWrapped(false, path.drive);

        // Validation criterion 1: two runs emit an identical table (same ordered call
        // sequence, bit-for-bit) — checked by digest rather than a huge deep-equal.
        expect(second.count()).toBe(first.count());
        expect(second.hash()).toBe(first.hash());

        // Validation criterion 2: the call count is nonzero for every transcendental this
        // path actually reaches.
        for (const fn of path.reaches) expect(first.counts[fn] ?? 0).toBeGreaterThan(0);

        const stamp = { platform: process.platform, arch: process.arch, bun: Bun.version };
        const outPath = join(
            tmpdir(),
            `kex2d-libm-${path.name}-${stamp.platform}-${stamp.arch}.jsonl`,
        );
        const header = JSON.stringify({
            path: path.name,
            ...stamp,
            count: first.count(),
            counts: first.counts,
            hash: first.hash(),
        });
        await Bun.write(
            outPath,
            `${header}\n${first.calls.map((call) => JSON.stringify(call)).join("\n")}\n`,
        );

        console.log(
            JSON.stringify({
                path: path.name,
                ...stamp,
                count: first.count(),
                counts: first.counts,
                hash: first.hash(),
                outPath,
            }),
        );
        console.table(first.counts);

        // Validation criterion (kex2d-golden-reproducibility 1a, resequenced): the whole-table
        // .jsonl doesn't travel between the two machines, so emit a small pasteable ladder + the
        // first 32 rows verbatim, both stamped, both to stdout.
        const rungs = ladderRungs(first.count());
        console.log(
            `\n=== prefix-hash ladder — ${path.name} (${stamp.platform} ${stamp.arch} | bun ${stamp.bun}) ===`,
        );
        for (const n of rungs) console.log(`  N=${n}\t${prefixHash(first.calls, n)}`);

        console.log(
            `\n=== first 32 rows verbatim — ${path.name} (${stamp.platform} ${stamp.arch} | bun ${stamp.bun}) ===`,
        );
        for (const call of first.calls.slice(0, 32)) console.log(JSON.stringify(call));
    }, 60_000);

    test(`red-first control — perturbing one wrapped call moves the ${path.name} table`, () => {
        const baseline = runWrapped(false, path.drive);

        // Perturb every Math.cos result by exactly one ulp before wrapping, so the wrapper's
        // own recorded result — not just the mutated site — reflects the change. A lab that
        // never reached a real `Math.cos` call on this path would produce an identical
        // table here, which is the failure this control exists to catch (`coding.md`: a check
        // is evidence only if you've seen it fail).
        const realCos = Math.cos;
        Math.cos = (x: number) => bump(realCos(x));
        let mutated: Wrapped;
        try {
            mutated = runWrapped(false, path.drive);
        } finally {
            Math.cos = realCos;
        }

        expect(mutated.hash()).not.toBe(baseline.hash());

        const baseFirstCos = baseline.firstByFn.cos;
        const mutatedFirstCos = mutated.firstByFn.cos;
        expect(baseFirstCos).toBeDefined();
        expect(mutatedFirstCos).toBeDefined();
        expect(mutatedFirstCos?.args).toEqual(baseFirstCos?.args);
        expect(mutatedFirstCos?.result).not.toBe(baseFirstCos?.result);
    }, 30_000);
}
