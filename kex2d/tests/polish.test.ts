import { describe, expect, test } from "bun:test";
import { fit } from "../src/fit";
import { applyDof, forceMatrix, polish, readDof, spine } from "../src/polish";
import { Easing, type ForcePoint, sampleForce } from "../src/profile";
import { scenarios } from "../src/scenarios";
import { evalGeo } from "../src/section";

const solve = (name: string) => {
    const scenario = scenarios.find((candidate) => candidate.name === name);
    if (!scenario) throw new Error(`missing scenario ${name}`);
    const entry = { x: 0, y: 0, theta: 0, v: scenario.v0 };
    const bake = evalGeo(entry, scenario.nodes, scenario.ds);
    const fitted = fit(bake.fN, bake.ds, 0.05);
    return {
        scenario,
        entry,
        bake,
        fitted,
        out: polish({ bake, entry, points: fitted.points, ds: scenario.ds }),
    };
};

// behavior checks on cheap scenarios — the fast tier. The corpus-wide full-free bit-identity
// hash runs at the full tier (`polish.oracle.ts`, `bun run test:full`).
describe("polish families", () => {
    test("flat is exactly one g variable per key and materializes no shaping", () => {
        const points: ForcePoint[] = [
            { s: 0, g: 1 },
            { s: 10, g: -1 },
            { s: 20, g: 2 },
        ];
        const dof = readDof(points, "flat");
        expect([...dof]).toEqual([1, -1, 2]);
        expect(applyDof(points, "flat", dof)).toEqual(points);
        expect(() => applyDof(points, "flat", new Float64Array(4))).toThrow(/takes 3 dof/);
    });

    test("the probed force map is linear in both surviving families", () => {
        const { fitted, bake, scenario } = solve("circular-arc");
        const sp = spine(bake, scenario.ds);
        for (const family of ["free", "flat"] as const) {
            const points =
                family === "free" ? fitted.points : fitted.points.map(({ s, g }) => ({ s, g }));
            const dof = readDof(points, family);
            const matrix = forceMatrix(points, family, sp.edges, sp.ds);
            for (let j = 0; j < sp.edges; j++) {
                let mapped = 0;
                for (let p = 0; p < dof.length; p++) mapped += matrix[p][j] * dof[p];
                expect(Math.abs(mapped - sampleForce(points, j * sp.ds))).toBeLessThan(1e-12);
            }
        }
    });

    test("the terminal playback snapshot is the returned answer", () => {
        const { out } = solve("straight-fillet");
        const tail = out.snapshots.at(-1);
        expect(tail).toBeDefined();
        expect(tail?.points).toEqual(out.points);
        expect(tail?.deviation).toBe(out.deviation);
        expect(tail?.feasibility).toBe(out.feasibility);
    });

    // recording is pure observation, so the production path (`maxSnapshots: 0`, no frames
    // built at all) must return the byte-identical answer the recorded run does.
    test("recording nothing leaves the answer untouched", () => {
        const { bake, entry, fitted, scenario } = solve("straight-fillet");
        const base = { bake, entry, points: fitted.points, ds: scenario.ds };
        const rich = polish(base);
        const quiet = polish({ ...base, maxSnapshots: 0 });
        expect(rich.snapshots.length).toBeGreaterThan(0);
        expect(quiet.snapshots).toEqual([]);
        expect({ ...quiet, snapshots: rich.snapshots }).toEqual(rich);
    });

    test("family representation guards fail at the boundary", () => {
        const { bake, entry, fitted, scenario } = solve("circular-arc");
        expect(() =>
            polish({
                bake,
                entry,
                points: fitted.points,
                ds: scenario.ds,
                family: "flat",
            }),
        ).toThrow(/flat keyframe 0 carries authored shaping/);
        expect(() =>
            polish({
                bake,
                entry,
                points: fitted.points.map(({ s, g }) => ({ s, g })),
                ds: scenario.ds,
            }),
        ).toThrow(/no out handle/);
        expect(() =>
            polish({
                bake,
                entry,
                points: fitted.points,
                ds: scenario.ds,
                family: "other" as never,
            }),
        ).toThrow(/family must be/);

        const malformed = fitted.points.map((point) => ({
            ...point,
            in: point.in && { ...point.in },
            out: point.out && { ...point.out },
        }));
        if (!malformed[0].out) throw new Error("missing fitted out handle");
        malformed[0].out.dg = Number.NaN;
        expect(() => polish({ bake, entry, points: malformed, ds: scenario.ds })).toThrow(
            /keyframe 0 out handle is not finite/,
        );
    });

    test("schedule guards refuse values that would poison or bypass the solve", () => {
        const { bake, entry, fitted, scenario } = solve("circular-arc");
        const base = { bake, entry, points: fitted.points, ds: scenario.ds };
        expect(() => polish({ ...base, tol: Number.NaN })).toThrow(/tol must be/);
        expect(() => polish({ ...base, outers: 1.5 })).toThrow(/outers must be/);
        expect(() => polish({ ...base, maxIters: -1 })).toThrow(/maxIters must be/);
        expect(() => polish({ ...base, escalate: 0 })).toThrow(/escalate must be/);
        expect(() => polish({ ...base, rho0: 0 })).toThrow(/rho0 must be/);
        expect(() => polish({ ...base, maxSnapshots: Number.NaN })).toThrow(/maxSnapshots must be/);
    });
});

// stage-3 spike (`kex/specs/kex2d-roundtrip.md`): the flat family's selectable segment basis.
describe("polish flat-family easing (stage-3 spike)", () => {
    test("unset easing leaves applyDof/forceMatrix byte-identical to before the option existed", () => {
        const points: ForcePoint[] = [
            { s: 0, g: 1 },
            { s: 10, g: -1 },
            { s: 20, g: 2 },
        ];
        const dof = readDof(points, "flat");
        const withArg = applyDof(points, "flat", dof);
        const withUndefined = applyDof(points, "flat", dof, undefined);
        expect(withArg).toEqual(points);
        expect(withUndefined).toEqual(points);
        // `toEqual` treats a stray `ease: undefined` key as equal to a missing key — exactly
        // the regression this test exists to catch — so key presence is asserted directly.
        for (const pt of [...withArg, ...withUndefined]) expect("ease" in pt).toBe(false);

        const edges = 10;
        const ds = 0.5;
        const withArgMatrix = forceMatrix(points, "flat", edges, ds);
        const withUndefinedMatrix = forceMatrix(points, "flat", edges, ds, undefined);
        expect(withArgMatrix).toEqual(withUndefinedMatrix);
        for (let p = 0; p < withArgMatrix.length; p++)
            for (let j = 0; j < edges; j++)
                expect(withArgMatrix[p][j]).toBe(withUndefinedMatrix[p][j]);
    });

    test("a set easing stamps the tag on every emitted flat point and only there", () => {
        const points: ForcePoint[] = [
            { s: 0, g: 1 },
            { s: 10, g: -1 },
            { s: 20, g: 2 },
        ];
        const dof = readDof(points, "flat");
        const out = applyDof(points, "flat", dof, Easing.Quintic);
        expect(out.map((p) => p.ease)).toEqual([Easing.Quintic, Easing.Quintic, Easing.Quintic]);
        expect(out.map(({ s, g }) => ({ s, g }))).toEqual(points.map(({ s, g }) => ({ s, g })));
        // the free family carries its own explicit handles — easing never applies there.
        const free = fittedFree();
        expect(
            applyDof(free, "free", readDof(free, "free"), Easing.Quintic).map((p) => p.ease),
        ).toEqual(free.map(() => undefined));
    });

    test("Quintic changes the flat force map from the default Cubic basis", () => {
        const points: ForcePoint[] = [
            { s: 0, g: 1 },
            { s: 10, g: -1 },
        ];
        const edges = 20;
        const ds = 0.5;
        const cubic = forceMatrix(points, "flat", edges, ds);
        const quintic = forceMatrix(points, "flat", edges, ds, Easing.Quintic);
        // the two bases only diverge inside the transition, never at the two shared endpoints.
        expect(cubic[0][0]).toBeCloseTo(quintic[0][0], 10);
        let diverged = false;
        for (let j = 1; j < edges - 1; j++)
            if (Math.abs(cubic[0][j] - quintic[0][j]) > 1e-9) diverged = true;
        expect(diverged).toBe(true);
    });

    test("Quintic solves a real scenario to the same feasibility contract as Cubic", () => {
        const { bake, entry, fitted, scenario } = solve("straight-fillet");
        const flatPoints = fitted.points.map(({ s, g }) => ({ s, g }));
        const base = { bake, entry, points: flatPoints, ds: scenario.ds, family: "flat" as const };
        const cubic = polish(base);
        const quintic = polish({ ...base, easing: Easing.Quintic });
        expect(cubic.converged).toBe(true);
        expect(quintic.converged).toBe(true);
        expect(quintic.points.every((p) => p.ease === Easing.Quintic)).toBe(true);
        expect(cubic.points.every((p) => p.ease === undefined)).toBe(true);
        // same key placement, different basis: the deviation profiles are not the same answer.
        expect(quintic.deviation).not.toBeCloseTo(cubic.deviation, 6);
    });

    test("easing only applies to the flat family, and only to a real Easing tag", () => {
        const { bake, entry, fitted, scenario } = solve("circular-arc");
        expect(() =>
            polish({ bake, entry, points: fitted.points, ds: scenario.ds, easing: Easing.Quintic }),
        ).toThrow(/easing only applies to the flat family/);
        const flatPoints = fitted.points.map(({ s, g }) => ({ s, g }));
        expect(() =>
            polish({
                bake,
                entry,
                points: flatPoints,
                ds: scenario.ds,
                family: "flat",
                easing: 99 as Easing,
            }),
        ).toThrow(/easing must be a valid Easing tag/);
    });
});

function fittedFree(): ForcePoint[] {
    const scenario = scenarios.find((candidate) => candidate.name === "circular-arc");
    if (!scenario) throw new Error("missing scenario circular-arc");
    const entry = { x: 0, y: 0, theta: 0, v: scenario.v0 };
    const bake = evalGeo(entry, scenario.nodes, scenario.ds);
    return fit(bake.fN, bake.ds, 0.05).points;
}
