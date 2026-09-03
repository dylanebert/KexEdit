import { describe, expect, test } from "bun:test";
import golden from "./fixtures/velocity-golden.json";
import { captureVelocityFixture } from "./mint-velocity-golden";

const FIXTURE_DIR = new URL("./fixtures/velocity/", import.meta.url);

describe("constructed pre-ownership velocity differential", () => {
    for (const name of Object.keys(golden).sort()) {
        test(`${name}: live evaluator matches f0ebd7a`, async () => {
            const got = await captureVelocityFixture(new URL(name, FIXTURE_DIR).pathname);
            expect(got).toEqual(golden[name as keyof typeof golden]);
        });
    }
});
