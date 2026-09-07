import { describe, expect, test } from "bun:test";
import { hillSeed, sweepForceLeg, sweepGeoLeg } from "./helpers/roundtrip-doc";

// the fast-tier sentinel for `roundtrip.oracle.ts`'s corpus-wide sweep (kex2d-provenance stage
// 4): the hill seed alone — the symptom's own named oracle (spec Goal) — round-tripped both
// directions at the document layer, so a kernel-seam regression in either provenance consult
// fails in seconds, not only at the full-tier corpus gate.

describe("document-layer round trip: hill seed", () => {
    test("geo→force→geo restores", async () => {
        const result = await sweepGeoLeg(hillSeed);
        expect(result.scenario).toBe(hillSeed.name);
    }, 60_000);

    test("force→geo→force restores", async () => {
        const result = await sweepForceLeg(hillSeed);
        expect(result.scenario).toBe(hillSeed.name);
    }, 60_000);
});
