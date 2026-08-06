// the force→geo fit's corpus-wide oracles — run explicitly (`bun test ./tests/forcegeo.oracle.ts`), outside the
// default `bun test` glob because they drive the whole ten-scenario corpus through the fit. The
// fast tier (`forcegeo.test.ts`) keeps the document-seam pins and two hand-picked ECS fidelity
// cases; the corpus-wide claims live here.
import { describe, expect, test } from "bun:test";
import { FORCE_BUDGET, GEO_BUDGET, geofit, type GeofitBake } from "../src/geofit";
import { forceProfile } from "../src/profile";
import { scenarios } from "../src/scenarios";
import { evalForce, evalGeo } from "../src/section";
import { sampleChain } from "../src/spline";
import { DS_NOMINAL, MAX_SAMPLES } from "../src/track";
import { FORCEGEO_SOURCE } from "./helpers/golden";
import { hausdorff, posDrift, posStations, drift, stations } from "./helpers/stations";

// ── the corpus-wide document-metric oracle ───────────────────────────────────
// the gate. The two hand-picked ECS cases (`forcegeo.test.ts`) prove the seam end to end; this
// drives the WHOLE 10-scenario corpus through the same metric, because a single case can land
// where the kernel's alignment and the document's coincide (the previous fidelity case did:
// kernel 0.466 vs document 0.452, so the span-normalization defect was invisible to it while
// four corpus scenarios were over budget — valley-explicit at 1.57 g against a reported 0.48 g).
//
// Device-free by construction: `applyConvertGeo` localizes the fit's world nodes into the
// section's own entry frame and `BakeSystem` bakes them through `chain`, which for a section at
// the track start is exactly `evalGeo(entry, nodes, DS_NOMINAL, MAX_SAMPLES)` — the same call,
// without ten worker spawns. The ECS pins are what tie that equality to the real path.
describe("document-layer fidelity: the whole corpus", () => {
    for (const scenario of scenarios) {
        test(scenario.name, () => {
            const g = FORCEGEO_SOURCE(scenario.name);
            const entry = { x: 0, y: 0, theta: 0, v: scenario.v0 };
            const bake = evalForce(entry, forceProfile(g.points, g.length, g.ds), g.ds);
            const target: GeofitBake = {
                x: bake.posX,
                y: bake.posY,
                fN: bake.fN,
                ds: bake.ds,
                edges: bake.fN.length,
            };

            const fit = geofit(target, entry.v, {
                dsNominal: DS_NOMINAL,
                maxSamples: MAX_SAMPLES,
            });
            expect(fit.outcome).toBe("floor");
            const landed = evalGeo(entry, fit.nodes, DS_NOMINAL, MAX_SAMPLES);

            // both budgets, read the way the document reads them.
            expect(
                drift(
                    stations(target.fN, target.ds, target.edges),
                    stations(landed.fN, landed.ds, landed.edges),
                ),
            ).toBeLessThanOrEqual(FORCE_BUDGET);
            expect(
                posDrift(
                    posStations(target.x, target.y, target.ds, target.edges),
                    posStations(landed.posX, landed.posY, landed.ds, landed.edges),
                ),
            ).toBeLessThanOrEqual(GEO_BUDGET);

            // and the kernel's self-report IS that reading — same metric, same sampling, so the
            // two are the same number and any future divergence is a regression in the
            // alignment, not a tolerance to widen.
            expect(fit.forceError).toBeLessThanOrEqual(FORCE_BUDGET);
            expect(fit.deviation).toBeLessThanOrEqual(GEO_BUDGET);
        });
    }
});

// the Validation round-trip oracle: a geo scenario → the SHIPPED geo→force convert (the frozen
// golden, `convert-golden.json`) → this fit → back to the ORIGINAL scenario's own sampled
// geometry. bit-identical device-free, no ECS/history needed (the pure kernel atoms this command
// wraps). the point is that the trip closes on the shape it started from, which means actually
// sampling that shape and comparing against it — a check that never looks at the original
// geometry measures no round trip at all.
//
// the bound is derived from the two directions' own geometric floors, by the triangle
// inequality:
//
//   |fit − original| ≤ |fit − forceBake| + |forceBake − original| ≤ GEO_BUDGET + floor
//
// where `floor` is the geo→force direction's OWN shipping constraint for this scenario
// (`chordDeficit(spine) + 0.5·CONVERT_STEP`, `refine.ts`), read per-scenario off the frozen
// golden rather than assumed — it is not the same number for every scenario, and it is not
// `GEO_BUDGET` (that the two happen to sit near 0.5 m is arithmetic, not a derivation).
//
// the metric is symmetric nearest-point distance (discrete Hausdorff over the two sample sets).
// that is the quantity both floors bound: each direction's own reported deviation is a
// correspondence distance, which is ≥ the nearest-point distance to the same curve, so using the
// nearest-point metric here keeps the triangle bound conservative rather than mixing two
// alignments that were never defined against each other.
describe("round-trip: geo scenario → shipped geo→force convert → this fit → the scenario's shape", () => {
    for (const scenario of scenarios) {
        test(scenario.name, () => {
            const g = FORCEGEO_SOURCE(scenario.name);
            const entry = { x: 0, y: 0, theta: 0, v: scenario.v0 };

            // leg 0 — the original shape, the trip's own reference.
            const origin = evalGeo(entry, scenario.nodes, scenario.ds);

            // leg 1 — the shipped geo→force convert, replayed off its frozen golden.
            const bake = evalForce(entry, forceProfile(g.points, g.length, g.ds), g.ds);
            const target: GeofitBake = {
                x: bake.posX,
                y: bake.posY,
                fN: bake.fN,
                ds: bake.ds,
                edges: bake.fN.length,
            };

            // leg 2 — this fit, then the geometry the LANDED section bakes from its nodes (the
            // fit emits nodes, not samples; the shape only exists once they are sampled).
            const fit = geofit(target, entry.v);
            expect(fit.outcome).toBe("floor");
            const posX = new Float32Array(MAX_SAMPLES);
            const posY = new Float32Array(MAX_SAMPLES);
            const dsArr = new Float32Array(MAX_SAMPLES - 1);
            const landed = sampleChain(fit.nodes, DS_NOMINAL, posX, posY, dsArr, MAX_SAMPLES);
            expect(landed.valid).toBe(true);

            const gap = hausdorff(
                { x: origin.posX, y: origin.posY, n: origin.edges + 1 },
                { x: posX, y: posY, n: landed.edges + 1 },
            );
            expect(gap).toBeLessThanOrEqual(g.floor + GEO_BUDGET);
        });
    }
});
