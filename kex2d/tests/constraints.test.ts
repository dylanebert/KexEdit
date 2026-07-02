import { describe, expect, test } from "bun:test";
import { pinRows } from "../src/constraints";

describe("pinRows — the finite-width pin's solver rows", () => {
    test("width covers its interval at the density weight; the demand is grid-invariant", () => {
        // a pin is a short interval force target: each row weighs w·ds, so
        // the total demand approximates the continuum w·width at any grid —
        // halving ds doubles the rows and halves each row's weight. the
        // discrete edge is one row's worth (w·ds).
        for (const [ds, n] of [
            [0.5, 200],
            [0.25, 400],
        ] as const) {
            const rows = pinRows(42, 100, 2, ds, n);
            expect(rows.length).toBe(Math.round(2 / ds) + 1);
            expect(rows[0].i).toBe(Math.round((42 - 1) / ds));
            let total = 0;
            for (const r of rows) {
                expect(r.w).toBeCloseTo(100 * ds, 9);
                total += r.w;
            }
            expect(Math.abs(total - 100 * 2)).toBeLessThanOrEqual(100 * ds + 1e-9);
        }
    });

    test("zero width still claims its one center row (a density sample)", () => {
        const rows = pinRows(10, 100, 0, 0.5, 100);
        expect(rows).toEqual([{ i: 20, w: 50 }]);
    });

    test("rows clamp to the interior (endpoints are hard pins, never data rows)", () => {
        const start = pinRows(0, 100, 4, 0.5, 100);
        expect(start[0].i).toBe(1);
        const end = pinRows(49.5, 100, 4, 0.5, 100);
        expect(end[end.length - 1].i).toBe(98);
        for (const rows of [start, end]) {
            for (const r of rows) expect(r.w).toBeCloseTo(50, 9);
        }
    });
});
