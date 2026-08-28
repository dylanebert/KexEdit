import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { describe, expect, test } from "bun:test";
import { State } from "@dylanebert/shallot";
import { applyOp, type Op } from "../src/commands";
import { dispatch } from "../src/cli";
import { loadDocument, parseDocument, saveDocument } from "../src/doc";
import { createHistory } from "../src/history";

// the CLI's own suite (spec `kex2d-cli` S3): round-trip byte-identity over the committed
// `.kex` fixture corpus (`tests/fixtures/cli/`, minted by `tests/mint-cli-fixtures.ts` from
// `scenarios.ts`), a CLI-edited file reopened via `loadDocument` equalling the same ops applied
// directly through `commands.applyOp` (S2's own differential arm, run through the shell), and
// usage/refusal snapshots. In-process against the exported `dispatch` function throughout
// (`AGENTS.md`/spec: a process spawn per case blows the ~12s gate) — one small process-level
// smoke block at the bottom is the only part that actually spawns `bun src/cli.ts`.

const FIXTURE_DIR = join(import.meta.dir, "fixtures", "cli");
const FIXTURE_NAMES = readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith(".kex"))
    .sort();

let workdir: string;

function freshCopy(fixture: string): string {
    const src = join(FIXTURE_DIR, fixture);
    const dst = join(workdir, fixture);
    writeFileSync(dst, readFileSync(src, "utf8"));
    return dst;
}

function setup(): void {
    workdir = mkdtempSync(join(tmpdir(), "kex2d-cli-"));
}

function teardown(): void {
    rmSync(workdir, { recursive: true, force: true });
}

describe("fmt: round-trip byte-identity over the committed fixture corpus", () => {
    test("the corpus is non-empty", () => {
        expect(FIXTURE_NAMES.length).toBeGreaterThan(0);
    });

    for (const name of FIXTURE_NAMES) {
        test(`${name} is already canonical (fmt is a byte-identical no-op)`, async () => {
            setup();
            try {
                const path = freshCopy(name);
                const before = readFileSync(path, "utf8");
                const result = await dispatch(["fmt", path]);
                expect(result.exitCode).toBe(0);
                const payload = JSON.parse(result.stdout);
                expect(payload).toMatchObject({ ok: true, changed: false });
                const after = readFileSync(path, "utf8");
                expect(after).toBe(before);
            } finally {
                teardown();
            }
        });
    }

    test("fmt refuses a malformed file and leaves it untouched", async () => {
        setup();
        try {
            const path = join(workdir, "bad.kex");
            const bad = "{ not json";
            writeFileSync(path, bad);
            const result = await dispatch(["fmt", path]);
            expect(result.exitCode).toBe(1);
            const payload = JSON.parse(result.stdout);
            expect(payload.ok).toBe(false);
            expect(payload.error.guard).toBe("documentInvalid");
            expect(readFileSync(path, "utf8")).toBe(bad);
        } finally {
            teardown();
        }
    });

    test("fmt refuses a missing file", async () => {
        setup();
        try {
            const path = join(workdir, "missing.kex");
            const result = await dispatch(["fmt", path]);
            expect(result.exitCode).toBe(1);
            const payload = JSON.parse(result.stdout);
            expect(payload.error.guard).toBe("fileNotFound");
        } finally {
            teardown();
        }
    });
});

describe("stats / dump: structured readback over the fixture corpus", () => {
    test("stats reports a positive length and total time for every fixture", async () => {
        setup();
        try {
            for (const name of FIXTURE_NAMES) {
                const path = freshCopy(name);
                const result = await dispatch(["stats", path]);
                expect(result.exitCode).toBe(0);
                const { stats } = JSON.parse(result.stdout);
                expect(stats.length).toBeGreaterThan(0);
                expect(stats.totalTime).toBeGreaterThan(0);
            }
        } finally {
            teardown();
        }
    });

    test("dump reports baked curves sized to the live sample count", async () => {
        setup();
        try {
            const path = freshCopy(FIXTURE_NAMES[0]);
            const result = await dispatch(["dump", path]);
            expect(result.exitCode).toBe(0);
            const payload = JSON.parse(result.stdout);
            expect(payload.count).toBeGreaterThan(1);
            expect(payload.positions.x).toHaveLength(payload.count);
            expect(payload.bake.fN).toHaveLength(payload.count - 1);
            expect(payload.bake.v).toHaveLength(payload.count);
        } finally {
            teardown();
        }
    });
});

describe("new: seeds a fresh document", () => {
    test("new writes a loadable, non-empty document and refuses to clobber it without --force", async () => {
        setup();
        try {
            const path = join(workdir, "fresh.kex");
            const created = await dispatch(["new", path]);
            expect(created.exitCode).toBe(0);
            expect(existsSync(path)).toBe(true);
            const doc = parseDocument(readFileSync(path, "utf8"));
            expect(doc.sections.length).toBeGreaterThan(0);

            const clobber = await dispatch(["new", path]);
            expect(clobber.exitCode).toBe(1);
            const payload = JSON.parse(clobber.stdout);
            expect(payload.error.guard).toBe("fileExists");

            const forced = await dispatch(["new", path, "--force"]);
            expect(forced.exitCode).toBe(0);
        } finally {
            teardown();
        }
    });
});

describe("validate: structural refusals + force-limit breaches", () => {
    test("a fixture from the corpus validates clean", async () => {
        setup();
        try {
            const path = freshCopy(FIXTURE_NAMES[0]);
            const result = await dispatch(["validate", path]);
            const payload = JSON.parse(result.stdout);
            expect(payload.structuralError).toBeNull();
            expect(Array.isArray(payload.forceLimitBreaches)).toBe(true);
            expect(result.exitCode).toBe(payload.valid ? 0 : 1);
        } finally {
            teardown();
        }
    });

    test("a malformed file refuses structurally, never reaching the force-limit check", async () => {
        setup();
        try {
            const path = join(workdir, "bad.kex");
            writeFileSync(path, "not json at all");
            const result = await dispatch(["validate", path]);
            expect(result.exitCode).toBe(1);
            const payload = JSON.parse(result.stdout);
            expect(payload.valid).toBe(false);
            expect(payload.structuralError.guard).toBe("documentInvalid");
            expect(payload.forceLimitBreaches).toEqual([]);
        } finally {
            teardown();
        }
    });
});

describe("edit: no second write path — a CLI-edited file reopened equals the ops applied directly", () => {
    /** every op family S2's own differential arm already proves against a direct setter call;
     *  this arm proves the SHELL doesn't diverge from `applyOp` — same op, same fixture, one
     *  path through `dispatch`'s `--ops` flag, one path calling `applyOp` directly, documents
     *  compared byte-raw (no id-normalizing needed: neither op below allocates a fresh id). */
    const Cases: { name: string; op: Op }[] = [
        { name: "friction", op: { type: "friction", value: 0.05 } },
        { name: "resistance", op: { type: "resistance", value: 1e-4 } },
        { name: "domain", op: { type: "domain", value: 1 } },
    ];

    for (const { name, op } of Cases) {
        test(`${name}: CLI edit == direct applyOp, byte-identical`, async () => {
            setup();
            try {
                const viaCli = freshCopy(FIXTURE_NAMES[0]);
                const cliResult = await dispatch(["edit", viaCli, "--ops", JSON.stringify(op)]);
                expect(cliResult.exitCode).toBe(0);
                const cliPayload = JSON.parse(cliResult.stdout);
                expect(cliPayload.ok).toBe(true);
                expect(cliPayload.results[0].applied).toBe(true);
                expect(cliPayload.results[0].refusals).toEqual([]);

                const directState = new State();
                loadDocument(
                    directState,
                    readFileSync(join(FIXTURE_DIR, FIXTURE_NAMES[0]), "utf8"),
                );
                applyOp(directState, createHistory(), op);
                const directDoc = saveDocument(directState);

                const cliDoc = readFileSync(viaCli, "utf8");
                expect(cliDoc).toBe(directDoc);
            } finally {
                teardown();
            }
        });
    }

    test("ops read from stdin when --ops is absent", async () => {
        setup();
        try {
            const path = freshCopy(FIXTURE_NAMES[0]);
            const op: Op = { type: "friction", value: 0.03 };
            const result = await dispatch(["edit", path], async () => JSON.stringify(op));
            expect(result.exitCode).toBe(0);
        } finally {
            teardown();
        }
    });

    test("a single op object (not wrapped in an array) is accepted", async () => {
        setup();
        try {
            const path = freshCopy(FIXTURE_NAMES[0]);
            const result = await dispatch([
                "edit",
                path,
                "--ops",
                JSON.stringify({ type: "resistance", value: 2e-4 }),
            ]);
            expect(result.exitCode).toBe(0);
        } finally {
            teardown();
        }
    });

    test("an array of ops applies in order and saves the cumulative result", async () => {
        setup();
        try {
            const path = freshCopy(FIXTURE_NAMES[0]);
            const ops: Op[] = [
                { type: "friction", value: 0.01 },
                { type: "resistance", value: 5e-5 },
            ];
            const result = await dispatch(["edit", path, "--ops", JSON.stringify(ops)]);
            expect(result.exitCode).toBe(0);
            const payload = JSON.parse(result.stdout);
            expect(payload.results).toHaveLength(2);
            const doc = parseDocument(readFileSync(path, "utf8"));
            expect(doc.track.friction).toBe(0.01);
            expect(doc.track.resistance).toBeCloseTo(5e-5, 10);
        } finally {
            teardown();
        }
    });

    test("a guard refusal still saves the document and exits non-zero", async () => {
        setup();
        try {
            const path = freshCopy(FIXTURE_NAMES[0]);
            // friction must be finite and non-negative (`track.validCoefficient`) — a negative
            // value refuses structurally, applying nothing.
            const result = await dispatch([
                "edit",
                path,
                "--ops",
                JSON.stringify({ type: "friction", value: -1 }),
            ]);
            expect(result.exitCode).toBe(1);
            const payload = JSON.parse(result.stdout);
            expect(payload.ok).toBe(false);
            expect(payload.results[0].refusals[0].guard).toBe("validCoefficient");
            // the file is still written (unchanged, since nothing applied) — never left absent.
            expect(existsSync(path)).toBe(true);
        } finally {
            teardown();
        }
    });

    test("an unrecognized op type refuses with a named guard rather than throwing", async () => {
        setup();
        try {
            const path = freshCopy(FIXTURE_NAMES[0]);
            const result = await dispatch([
                "edit",
                path,
                "--ops",
                JSON.stringify({ type: "not-a-real-op" }),
            ]);
            expect(result.exitCode).toBe(1);
            const payload = JSON.parse(result.stdout);
            expect(payload.results[0].refusals[0].guard).toBe("unknownOp");
        } finally {
            teardown();
        }
    });

    test("malformed ops JSON refuses with a usage-tier exit code", async () => {
        setup();
        try {
            const path = freshCopy(FIXTURE_NAMES[0]);
            const result = await dispatch(["edit", path, "--ops", "{ not json"]);
            expect(result.exitCode).toBe(2);
            const payload = JSON.parse(result.stdout);
            expect(payload.error.guard).toBe("opsInvalid");
        } finally {
            teardown();
        }
    });

    test("a non-object op in the array refuses with opShapeInvalid, others still apply", async () => {
        setup();
        try {
            const path = freshCopy(FIXTURE_NAMES[0]);
            const ops = [42, { type: "friction", value: 0.02 }];
            const result = await dispatch(["edit", path, "--ops", JSON.stringify(ops)]);
            expect(result.exitCode).toBe(1);
            const payload = JSON.parse(result.stdout);
            expect(payload.results[0].refusals[0].guard).toBe("opShapeInvalid");
            expect(payload.results[1].applied).toBe(true);
        } finally {
            teardown();
        }
    });
});

describe("usage / --help", () => {
    test("no verb prints usage at a usage-tier exit code", async () => {
        const result = await dispatch([]);
        expect(result.exitCode).toBe(2);
        expect(result.stdout).toContain("Usage:");
    });

    test("--help prints usage at exit 0", async () => {
        const result = await dispatch(["--help"]);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("Usage:");
    });

    test("an unknown verb refuses with a named guard", async () => {
        const result = await dispatch(["frobnicate", "x.kex"]);
        expect(result.exitCode).toBe(2);
        const payload = JSON.parse(result.stdout);
        expect(payload.error.guard).toBe("usage");
    });

    test("a verb missing its file argument refuses with a named guard", async () => {
        const result = await dispatch(["stats"]);
        expect(result.exitCode).toBe(2);
        const payload = JSON.parse(result.stdout);
        expect(payload.error.guard).toBe("usage");
    });
});

// a small process-level smoke block: `dispatch` above proves the shell's own logic exhaustively
// in-process; this just proves the process ENTRY POINT (`import.meta.main`'s argv/stdout/exit-code
// wiring) actually works when invoked the way a real caller would, at minimal cost (2 spawns).
describe("process-level smoke (bun src/cli.ts)", () => {
    test("stats over a real spawn prints JSON and exits 0", async () => {
        setup();
        try {
            const path = freshCopy(FIXTURE_NAMES[0]);
            const cliPath = join(import.meta.dir, "..", "src", "cli.ts");
            const result = await $`bun ${cliPath} stats ${path}`.quiet();
            expect(result.exitCode).toBe(0);
            const payload = JSON.parse(result.stdout.toString());
            expect(payload.ok).toBe(true);
        } finally {
            teardown();
        }
    });

    test("a missing file exits non-zero over a real spawn", async () => {
        setup();
        try {
            const cliPath = join(import.meta.dir, "..", "src", "cli.ts");
            const missing = join(workdir, "missing.kex");
            const result = await $`bun ${cliPath} stats ${missing}`.quiet().nothrow();
            expect(result.exitCode).toBe(1);
            const payload = JSON.parse(result.stdout.toString());
            expect(payload.error.guard).toBe("fileNotFound");
        } finally {
            teardown();
        }
    });
});
