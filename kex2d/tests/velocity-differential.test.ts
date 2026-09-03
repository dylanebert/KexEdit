import { describe, expect, test } from "bun:test";
import { checkDocumentSemantics, parseDocument } from "../src/doc";
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

    test("a wholly-past strip is refused by minExtentFloor", () => {
        // This inert non-displacement class cannot be a loadable fixture; the document boundary refuses it.
        const doc = parseDocument(
            JSON.stringify({
                version: 2,
                track: { ds: 0.5, domain: 0, friction: 0.02, resistance: 0.0001 },
                sections: [0, 1].map((id) => ({
                    id,
                    order: id,
                    kind: 1,
                    length: 20,
                    nodes: [],
                    points: [
                        { id: id * 10, s: 0, g: 1, ease: 1 },
                        { id: id * 10 + 1, s: 20, g: 1, ease: 1 },
                    ],
                })),
                strips: [
                    {
                        id: 0,
                        start: 42,
                        end: 48,
                        value: 16,
                        keyframes: [
                            { id: 0, s: 42, v: 16 },
                            { id: 1, s: 48, v: 16 },
                        ],
                    },
                ],
                oneShot: [{ id: 0, value: 20 }],
            }),
        );

        expect(checkDocumentSemantics(doc)).toEqual([
            { guard: "minExtentFloor", message: expect.any(String) },
        ]);
    });
});
