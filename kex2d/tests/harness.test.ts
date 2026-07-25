import { describe, expect, test } from "bun:test";
import { boolEnv, intEnv, parseArgs, UsageError } from "../harness/args";
import { provisioned, provisionKey } from "../harness/wsl";

// The capture orchestrator's pure decision layer. Everything here decides something the gate's
// honesty rests on: whether a run merges or WIPES the shot set, whether the host reinstalls, and
// whether a knob value is legal at all (the fail-closed pass that runs before anything is wiped).

describe("parseArgs — the shot-set fate of a command line", () => {
    test("a bare run is a full run: no passthrough, default out, wipes-and-captures", () => {
        expect(parseArgs([])).toEqual({
            out: null,
            testArgs: [],
            selective: false,
            listing: false,
        });
    });

    test("a filter is passthrough and makes the run SELECTIVE (merge, never wipe)", () => {
        const args = parseArgs(["-g", "geo authoring flow"]);
        expect(args.testArgs).toEqual(["-g", "geo authoring flow"]);
        expect(args.selective).toBe(true);
        expect(args.listing).toBe(false);
    });

    test("the bare `--` bun forwards is DROPPED, so `-g` stays an option", () => {
        // passed through, Playwright reads `--` as end-of-options and `-g` degrades to a positional
        // file filter: the whole suite runs while the caller still counts the run selective.
        expect(parseArgs(["--", "-g", "force authoring flow"]).testArgs).toEqual([
            "-g",
            "force authoring flow",
        ]);
    });

    test("--out is consumed by the harness, never forwarded — and it alone is not selective", () => {
        expect(parseArgs(["--out", "/tmp/iter"])).toEqual({
            out: "/tmp/iter",
            testArgs: [],
            selective: false,
            listing: false,
        });
        expect(parseArgs(["--out=/tmp/iter"]).out).toBe("/tmp/iter");
    });

    test("--out sits anywhere in the line, leaving the rest of the args in order", () => {
        const args = parseArgs(["-g", "lab", "--out", "/tmp/iter", "--repeat-each", "3"]);
        expect(args.out).toBe("/tmp/iter");
        expect(args.testArgs).toEqual(["-g", "lab", "--repeat-each", "3"]);
        expect(args.selective).toBe(true);
    });

    test("--list is recognized through the passthrough (it captures nothing)", () => {
        expect(parseArgs(["--list"])).toEqual({
            out: null,
            testArgs: ["--list"],
            selective: true,
            listing: true,
        });
    });

    test("a directory-less --out is a usage error, not a swallowed flag", () => {
        // the interesting edge: the next arg is the NEXT FLAG, so a naive shift would eat it and
        // resolve the shot dir to "-g" — a wipe of a directory nobody named.
        expect(() => parseArgs(["--out", "-g"])).toThrow(UsageError);
        expect(() => parseArgs(["--out"])).toThrow(UsageError);
        expect(() => parseArgs(["--out="])).toThrow(UsageError);
    });
});

describe("intEnv / boolEnv — the fail-closed knob pass", () => {
    test("an unset knob takes the default", () => {
        expect(intEnv("KEX_WORKERS", undefined, 4, 1, 64)).toBe(4);
        expect(boolEnv("KEX_HEADED", undefined)).toBe(false);
    });

    test("a legal value parses, at the range's ends included", () => {
        expect(intEnv("KEX_WORKERS", "8", 4, 1, 64)).toBe(8);
        expect(intEnv("KEX_WORKERS", "1", 4, 1, 64)).toBe(1);
        expect(intEnv("KEX_WORKERS", "64", 4, 1, 64)).toBe(64);
        expect(boolEnv("KEX_HEADED", "1")).toBe(true);
        expect(boolEnv("KEX_HEADED", "0")).toBe(false);
    });

    test("the two values `Number` would silently accept are rejected", () => {
        // `Number("")` is 0 — zero workers runs NO tests, burning to the global timeout after the
        // shot set is already wiped; `Number("50%")` is NaN, which lands in a timeout.
        expect(() => intEnv("KEX_WORKERS", "", 4, 1, 64)).toThrow(UsageError);
        expect(() => intEnv("KEX_WORKERS", "50%", 4, 1, 64)).toThrow(UsageError);
    });

    test("out-of-range and non-integer values are rejected", () => {
        expect(() => intEnv("KEX_WORKERS", "0", 4, 1, 64)).toThrow(UsageError);
        expect(() => intEnv("KEX_WORKERS", "65", 4, 1, 64)).toThrow(UsageError);
        expect(() => intEnv("KEX_WORKERS", "2.5", 4, 1, 64)).toThrow(UsageError);
        expect(() => intEnv("KEX_PORT", "80", 3014, 1024, 65_535)).toThrow(UsageError);
    });

    test("the error names the knob and the value it saw", () => {
        expect(() => intEnv("KEX_PORT", "80", 3014, 1024, 65_535)).toThrow(
            'KEX_PORT must be an integer in [1024, 65535] (got "80")',
        );
        expect(() => boolEnv("KEX_HEADED", "true")).toThrow(
            'KEX_HEADED must be 0 or 1 (got "true")',
        );
    });

    test("a boolean knob takes only 0 or 1 — no truthy-string coercion", () => {
        expect(() => boolEnv("KEX_HEADED", "true")).toThrow(UsageError);
        expect(() => boolEnv("KEX_HEADED", "")).toThrow(UsageError);
    });
});

describe("provisionKey / provisioned — when the host reinstalls", () => {
    const pkg = { dependencies: { "@playwright/test": "^1.59.1", playwright: "^1.59.1" } };

    test("the key covers the whole dependency block and is order-independent", () => {
        const { key, pin } = provisionKey(pkg);
        expect(pin).toBe("^1.59.1");
        expect(
            provisionKey({ dependencies: { playwright: "^1.59.1", "@playwright/test": "^1.59.1" } })
                .key,
        ).toBe(key);
    });

    test("a changed RANGE changes the key even though the installed version still satisfies it", () => {
        // the whole point of hashing the block rather than reading the installed version: 1.59.1
        // satisfies ^1.59.1 forever, so a version key would never reinstall after this edit.
        const bumped = { dependencies: { ...pkg.dependencies, "@playwright/test": "^1.62.0" } };
        expect(provisionKey(bumped).key).not.toBe(provisionKey(pkg).key);
    });

    test("an added dependency changes the key", () => {
        const added = { dependencies: { ...pkg.dependencies, "@axe-core/playwright": "^4.0.0" } };
        expect(provisionKey(added).key).not.toBe(provisionKey(pkg).key);
    });

    test("a package.json declaring no Playwright is a hard error, not an empty key", () => {
        expect(() => provisionKey({ dependencies: { svelte: "^5.0.0" } })).toThrow(
            "no @playwright/test dependency",
        );
        expect(() => provisionKey({})).toThrow("no @playwright/test dependency");
    });

    test("the stage is reused only when the marker matches AND the tree is really there", () => {
        const key = provisionKey(pkg).key;
        expect(provisioned(`${key}\n`, key, true)).toBe(true); // the marker is written with a newline
        expect(provisioned(null, key, true)).toBe(false); // never provisioned
        expect(provisioned("deadbeef", key, true)).toBe(false); // provisioned for other deps
        expect(provisioned(`${key}\n`, key, false)).toBe(false); // marker without the install
    });
});
