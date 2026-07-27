import { describe, expect, test } from "bun:test";
import { fit } from "../src/fit";
import { applyDof, forceMatrix, polish, readDof, spine } from "../src/polish";
import { type ForcePoint, sampleForce } from "../src/profile";
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

describe("polish families", () => {
    test("the full-free oracle is bit-identical to the landed stage-5 oracle", () => {
        const all = scenarios.map((scenario) => {
            const { out } = solve(scenario.name);
            return {
                name: scenario.name,
                points: out.points,
                length: out.length,
                ds: out.ds,
                edges: out.edges,
                keys: out.keys,
                iters: out.iters,
                outers: out.outers,
                converged: out.converged,
                feasibility: out.feasibility,
                exit: out.exit,
                deviation: out.deviation,
                at: out.at,
                deviations: out.deviations,
                rho: out.rho,
                peakG: out.peakG,
                maxDg: out.maxDg,
                spine: out.spine,
                snapshots: out.snapshots,
            };
        });
        const hash = new Bun.CryptoHasher("sha256");
        hash.update(JSON.stringify(all));
        expect(hash.digest("hex")).toBe(
            "7655378e96c479acd15f27a08d4b714ff7f8598b2b449c1822c722aa8782c803",
        );
    }, 30_000);

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
