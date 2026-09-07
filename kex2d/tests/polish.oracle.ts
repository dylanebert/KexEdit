// the full-free oracle's corpus-wide field-wise golden gate — run explicitly
// (`bun test ./tests/polish.oracle.ts`), outside the default `bun test` glob because it solves
// the whole ten-scenario corpus. The fast tier (`polish.test.ts`) keeps every behavior check on
// cheap scenarios. Routed through the shared comparison seam (`helpers/compare.ts`) and a
// declared, stamp-matched field registry (`helpers/golden.ts`'s `POLISH_REGISTRY`) —
// `kex2d-golden-reproducibility` 3c replaced the single whole-record sha256 this file used to
// pin, which could only ever be loosened by giving up bit-identity entirely.
import { describe, expect, test } from "bun:test";
import { fit } from "../src/fit";
import { polish } from "../src/polish";
import { scenarios } from "../src/scenarios";
import { evalGeo } from "../src/section";
import { assertGolden, registryClosure } from "./helpers/compare";
import { narrowPolish, POLISH_GOLDEN, POLISH_REGISTRY } from "./helpers/golden";

function full(name: string) {
    const scenario = scenarios.find((candidate) => candidate.name === name);
    if (!scenario) throw new Error(`missing scenario ${name}`);
    const entry = { x: 0, y: 0, theta: 0, v: scenario.v0 };
    const bake = evalGeo(entry, scenario.nodes, scenario.ds);
    const fitted = fit(bake.fN, bake.ds, 0.05);
    const out = polish({ bake, entry, points: fitted.points, ds: scenario.ds });
    return narrowPolish(name, out);
}

describe("polish families: the corpus", () => {
    // Structure (`converged`) hard-fails ahead of any bound; every other field, continuous or
    // diagnostic, is exact on this own-stamp comparison (`kex2d-golden-reproducibility` 4 —
    // own-stamp against a deterministic solve presents zero spread, so no bound belongs there).
    // The five diagnostic members (`iters`, `outers`, `rho`, `at`, `snapshots`) staying pinned
    // exact is the sha256's trajectory coverage, preserved rather than dropped.
    test("the full-free oracle field-wise matches the frozen stamp-matched golden", () => {
        for (const scenario of scenarios)
            assertGolden(
                full(scenario.name),
                POLISH_GOLDEN(scenario.name),
                POLISH_REGISTRY,
                scenario.name,
            );
    }, 30_000);

    // the declared-registry law, closed both directions against a REAL record (never a
    // hand-typed key list) — `compare.test.ts` carries the positive controls per direction plus
    // the vector/object mechanism's own red-first proofs; this is the corpus-shape check that a
    // real `PolishRecord` has no undeclared key and no orphan declaration.
    test("the registry is closed both directions against a real record", () => {
        expect(registryClosure(full("circular-arc"), POLISH_REGISTRY)).toEqual({
            missing: [],
            orphan: [],
        });
    });
});
