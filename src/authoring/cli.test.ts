import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openRide, saveRide } from "./document";

const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
const fixture = Bun.file(new URL("./straight.ride.json", import.meta.url));

function run(...args: string[]) {
    return Bun.spawnSync([process.execPath, cli, ...args], { stdout: "pipe", stderr: "pipe" });
}

test("saved straight completes; saved edit refuses at tick 25 with the analytic prefix", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ride-cli-"));
    try {
        const original = join(dir, "original.json");
        const edited = join(dir, "edited.json");
        const text = await fixture.text();
        await Bun.write(original, saveRide(openRide(text)));
        const complete = run("solve", original);
        expect(complete.exitCode, complete.stderr.toString()).toBe(0);
        const solved = JSON.parse(complete.stdout.toString());
        expect(solved).toMatchObject({ length: 100, endTick: 100, endReason: "complete", refusal: null,
            endpoint: { speed: 6 } });
        expect(solved.endpoint.position[0]).toBeCloseTo(0, 5);
        expect(solved.endpoint.position[1]).toBeCloseTo(0, 5);
        expect(solved.endpoint.position[2]).toBeCloseTo(-6, 5);
        const edit = run("set-key", original, "0", "normal", "25", "-1", "hold");
        expect(edit.exitCode, edit.stderr.toString()).toBe(0);
        const output = edit.stdout.toString();
        expect(output).toBe(saveRide(openRide(output)));
        expect(openRide(output).spans[0].normal.at(-1)).toEqual({ tick: 25, value: -1, ease: "hold" });
        expect(await Bun.file(original).text()).toBe(text);
        await Bun.write(edited, output);
        const refuse = run("solve", edited);
        expect(refuse.exitCode, refuse.stderr.toString()).toBe(0);
        const refused = JSON.parse(refuse.stdout.toString());
        expect(refused).toMatchObject({ length: 100, endTick: 25, endReason: "unsatisfiable",
            refusal: { tick: 25, lane: "forces", quantity: "normal discriminant", reason: "unsatisfiable", need: 0 },
            endpoint: { speed: 6 } });
        expect(refused.endpoint.position[0]).toBeCloseTo(0, 5);
        expect(refused.endpoint.position[1]).toBeCloseTo(0, 5);
        expect(refused.endpoint.position[2]).toBeCloseTo(-1.5, 5);
        expect(refused.refusal.have).toBeCloseTo(-34.632, 5);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

const overflowCases = [
    ["normal", "-1e308", "normal discriminant"],
    ["lateral", "1e308", "trajectory position: tick 26 float 0 is NaN"],
];

test.each(overflowCases)("solve reports %s overflow as an evaluation error without JSON", async (property, value, diagnostic) => {
    const dir = await mkdtemp(join(tmpdir(), "ride-cli-"));
    try {
        const source = join(dir, "source.json");
        const edited = join(dir, "edited.json");
        await Bun.write(source, await fixture.text());
        const edit = run("set-key", source, "0", property, "25", value, "hold");
        expect(edit.exitCode, edit.stderr.toString()).toBe(0);
        await Bun.write(edited, edit.stdout.toString());
        const solve = run("solve", edited);
        expect(solve.stdout.toString()).toBe("");
        expect(solve.exitCode).toBe(2);
        expect(solve.stderr.toString()).toStartWith("evaluation error: ");
        expect(solve.stderr.toString()).toContain(diagnostic);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("malformed or unreadable source and invalid arguments fail without a solve result", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ride-cli-"));
    try {
        const malformed = join(dir, "malformed.json");
        const original = join(dir, "original.json");
        await Bun.write(malformed, "{");
        await Bun.write(original, await fixture.text());
        for (const [args, diagnostic] of [
            [["solve", malformed], "malformed JSON"],
            [["solve", join(dir, "missing.json")], "missing.json"],
            [["solve", original, "extra"], "usage:"],
            [["set-key", original, "0", "normal", "25", "", "hold"], "value"],
            [["set-key", original, "0", "other", "25", "1", "hold"], "property"],
        ] as const) {
            const result = run(...args);
            expect(result.exitCode).toBe(1);
            expect(result.stdout.toString()).toBe("");
            expect(result.stderr.toString()).toContain(diagnostic);
        }
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
