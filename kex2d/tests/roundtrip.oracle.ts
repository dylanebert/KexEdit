import { describe, expect, test } from "bun:test";
import { scenarios } from "../src/scenarios";
import { sweepCorpus, sweepForceLeg, sweepGeoLeg } from "./helpers/roundtrip-doc";

// the document-layer corpus sweep (kex2d-provenance stage 4, spec `kex/specs/kex2d-provenance.md`
// Approach 4 + Validation): the universal claim — EVERY untouched conversion round trip restores,
// both directions — over the 10-scenario corpus (`src/scenarios.ts`) plus the hill seed (the
// symptom's own named oracle). Exactness admits no budget fall-through on an untouched trip, so
// any non-"restored" outcome here is a DEFECT, not a coverage gap: `sweepGeoLeg`/`sweepForceLeg`
// (`helpers/roundtrip-doc.ts`) throw loudly on one, failing the test rather than skipping it.
//
// Full tier (`bun run test:full`): real solves over 22 document-layer trips (11 scenarios × 2
// directions), each driving the real worker pool / dedicated fit worker `geoforce.ts`/
// `forcegeo.ts` use — the fast-tier sentinel (`roundtrip.test.ts`, the hill seed alone) covers
// the same claim in seconds for the default `bun test` loop.
const corpus = sweepCorpus(scenarios);

describe("document-layer round trip: geo→force→geo (corpus)", () => {
    for (const scenario of corpus) {
        test(scenario.name, async () => {
            const result = await sweepGeoLeg(scenario);
            expect(result.scenario).toBe(scenario.name);
        }, 60_000);
    }
});

describe("document-layer round trip: force→geo→force (corpus, derived)", () => {
    for (const scenario of corpus) {
        test(scenario.name, async () => {
            const result = await sweepForceLeg(scenario);
            expect(result.scenario).toBe(scenario.name);
        }, 60_000);
    }
});
