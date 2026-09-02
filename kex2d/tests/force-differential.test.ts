import { describe, expect, test } from "bun:test";
import { forceProfile, resolveStep, type ForcePoint } from "../src/profile";
import golden from "./fixtures/force-golden.json";
import { captureForceFixture } from "./mint-force-golden";

const FIXTURE_DIR = new URL("./fixtures/force/", import.meta.url);
type V2Document = {
    track: { ds: number };
    sections: { kind: number; length: number; points: ForcePoint[] }[];
};

describe("constructed pre-ownership force differential", () => {
    for (const name of Object.keys(golden).sort()) {
        test(`${name}: live evaluator matches e27294a`, async () => {
            const got = await captureForceFixture(new URL(name, FIXTURE_DIR).pathname);
            expect(got).toEqual(golden[name as keyof typeof golden]);
        });
    }

    for (const name of ["keyless.kex", "adjacent-force-runs.kex"] as const) {
        test(`${name}: reference input cross-checks profile.ts forceProfile`, async () => {
            const doc = JSON.parse(await Bun.file(new URL(name, FIXTURE_DIR)).text()) as V2Document;
            const want = golden[name].pureProfiles;
            const got = doc.sections
                .filter((section) => section.kind === 1)
                .map((section, id) => ({
                    id,
                    dense: Array.from(
                        forceProfile(section.points, resolveStep(section.length, doc.track.ds)),
                    ),
                }));
            expect(got).toEqual(want);
        });
    }
});
