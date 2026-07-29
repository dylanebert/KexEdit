// the full-free oracle's corpus-wide bit-identity hash — the full tier (`bun run test:full`),
// outside the default `bun test` glob because it solves the whole ten-scenario corpus. The fast
// tier (`polish.test.ts`) keeps every behavior check on cheap scenarios.
import { describe, expect, test } from "bun:test";
import { fit } from "../src/fit";
import { polish } from "../src/polish";
import { scenarios } from "../src/scenarios";
import { evalGeo } from "../src/section";

describe("polish families: the corpus", () => {
    test("the full-free oracle is bit-identical to the landed stage-5 oracle", () => {
        const all = scenarios.map((scenario) => {
            const entry = { x: 0, y: 0, theta: 0, v: scenario.v0 };
            const bake = evalGeo(entry, scenario.nodes, scenario.ds);
            const fitted = fit(bake.fN, bake.ds, 0.05);
            const out = polish({ bake, entry, points: fitted.points, ds: scenario.ds });
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
});
