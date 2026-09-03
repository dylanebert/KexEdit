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
import {
    assertRunStructure,
    createForcePoint,
    createSection,
    createTrack,
    SectionKind,
    snapshotRun,
} from "../src/track";

// the CLI's own suite: round-trip byte-identity over the committed
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
    workdir = mkdtempSync(join(tmpdir(), "kex2d-shell-test-"));
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
            expect(doc.segments.length).toBeGreaterThan(0);

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
            expect(payload.structuralRefusals).toEqual([]);
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
            expect(payload.structuralRefusals).toHaveLength(1);
            expect(payload.structuralRefusals[0].guard).toBe("documentInvalid");
            expect(payload.forceLimitBreaches).toEqual([]);
        } finally {
            teardown();
        }
    });
});

// `loadDocument`'s semantic-refusal path throws a typed `SemanticRefusalError` carrying
// `refusals: Refusal[]`, and every CLI path that catches a `loadDocument` throw emits those
// guard names structured — `validate`'s `structuralRefusals` above, and `stats`/`edit`'s
// (through `loadTrackFile`) `refusals` field beside the flattened `error.message` — rather than
// only the one prose string the guard names would otherwise flatten into.
describe("semantic refusals surface named guards structured, not just a flattened message", () => {
    async function readInvariantFixture(name: string): Promise<string> {
        const url = new URL(`./fixtures/invariants/${name}`, import.meta.url);
        return Bun.file(url).text();
    }

    test("validate names every violated guard in structuralRefusals", async () => {
        setup();
        try {
            const path = join(workdir, "duplicateId.kex");
            writeFileSync(path, await readInvariantFixture("duplicateId-red.kex"));
            const result = await dispatch(["validate", path]);
            expect(result.exitCode).toBe(1);
            const payload = JSON.parse(result.stdout);
            expect(payload.valid).toBe(false);
            expect(Array.isArray(payload.structuralRefusals)).toBe(true);
            expect(payload.structuralRefusals.length).toBeGreaterThan(0);
            expect(payload.structuralRefusals.map((r: { guard: string }) => r.guard)).toContain(
                "duplicateId",
            );
        } finally {
            teardown();
        }
    });

    test("stats (through loadTrackFile) surfaces the same named guard in a `refusals` field", async () => {
        setup();
        try {
            const path = join(workdir, "minForceExtent.kex");
            writeFileSync(path, await readInvariantFixture("minForceExtent-red.kex"));
            const result = await dispatch(["stats", path]);
            expect(result.exitCode).toBe(1);
            const payload = JSON.parse(result.stdout);
            expect(payload.error.guard).toBe("documentInvalid");
            expect(Array.isArray(payload.refusals)).toBe(true);
            expect(payload.refusals.map((r: { guard: string }) => r.guard)).toContain(
                "minForceExtent",
            );
        } finally {
            teardown();
        }
    });

    test("edit refuses a semantically invalid file with `refusals` naming the guard", async () => {
        setup();
        try {
            const path = join(workdir, "stationTaken.kex");
            writeFileSync(path, await readInvariantFixture("stationTaken-red.kex"));
            const result = await dispatch([
                "edit",
                path,
                "--ops",
                JSON.stringify({ type: "noop" }),
            ]);
            expect(result.exitCode).toBe(1);
            const payload = JSON.parse(result.stdout);
            expect(payload.error.guard).toBe("documentInvalid");
            expect(Array.isArray(payload.refusals)).toBe(true);
            expect(payload.refusals.map((r: { guard: string }) => r.guard)).toContain(
                "stationTaken",
            );
        } finally {
            teardown();
        }
    });

    test("a purely structural (JSON) failure carries no `refusals` field", async () => {
        setup();
        try {
            const path = join(workdir, "bad.kex");
            writeFileSync(path, "not json at all");
            const result = await dispatch(["validate", path]);
            const payload = JSON.parse(result.stdout);
            expect(payload.structuralRefusals).toHaveLength(1);
            expect(payload.structuralRefusals[0].guard).toBe("documentInvalid");

            const statsResult = await dispatch(["stats", path]);
            const statsPayload = JSON.parse(statsResult.stdout);
            expect(statsPayload.refusals).toBeUndefined();
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

    test("force create/move/ease/delete use the canonical segment surface", async () => {
        setup();
        try {
            const state = new State();
            createTrack(state);
            const run = createSection(state, 0, SectionKind.Force, 10.1);
            const entry = createForcePoint(state, run, 0, 1);
            const terminal = createForcePoint(state, run, 7.7, 1);
            const path = join(workdir, "force.kex");
            writeFileSync(path, saveDocument(state));

            const create = await dispatch([
                "edit",
                path,
                "--ops",
                JSON.stringify({ type: "force-create", section: run, s: 3.3, g: 2 }),
            ]);
            const created = JSON.parse(create.stdout).results[0].id as number;
            expect(create.exitCode).toBe(0);

            const edit = await dispatch([
                "edit",
                path,
                "--ops",
                JSON.stringify([
                    { type: "force-ease", ids: [entry], ease: 2 },
                    { type: "force-delete", ids: [created] },
                    { type: "force-move", id: terminal, s: 4.4, g: 1.5 },
                ]),
            ]);
            expect(edit.exitCode).toBe(0);

            const reopened = new State();
            loadDocument(reopened, readFileSync(path, "utf8"));
            const snap = snapshotRun(reopened, run);
            expect(snap.stations.at(-1)).toBe(10.1);
            expect(snap.stations).toEqual([0, 4.4, 10.1]);
        } finally {
            teardown();
        }
    });

    test("segment-author JSON dispatches every action and saves a reloadable fixed point", async () => {
        setup();
        try {
            const state = new State();
            createTrack(state);
            const run = createSection(state, 0, SectionKind.Force, 30);
            createForcePoint(state, run, 0, 1);
            createForcePoint(state, run, 20, 2);
            const path = join(workdir, "segment-author.kex");
            writeFileSync(path, saveDocument(state));

            const insertedResult = await dispatch([
                "edit",
                path,
                "--ops",
                JSON.stringify({
                    type: "segment-author",
                    edit: { action: "insert", segment: run, station: 10 },
                }),
            ]);
            expect(insertedResult.exitCode).toBe(0);
            const inserted = JSON.parse(insertedResult.stdout).results[0].id as number;

            const result = await dispatch([
                "edit",
                path,
                "--ops",
                JSON.stringify([
                    {
                        type: "segment-author",
                        edit: { action: "boundary-value", segment: inserted, value: 6 },
                    },
                    {
                        type: "segment-author",
                        edit: { action: "boundary-ease", segment: inserted, ease: 2 },
                    },
                    {
                        type: "segment-author",
                        edit: { action: "extent-ripple", segment: inserted, extent: 15 },
                    },
                    {
                        type: "segment-author",
                        edit: { action: "delete", segment: inserted },
                    },
                ]),
            ]);
            expect(result.exitCode).toBe(0);
            expect(JSON.parse(result.stdout).results).toHaveLength(4);

            const text = readFileSync(path, "utf8");
            const reopened = new State();
            loadDocument(reopened, text);
            assertRunStructure(reopened);
            expect(saveDocument(reopened)).toBe(text);
            expect(snapshotRun(reopened, run).members.map((row) => row.id)).not.toContain(inserted);
        } finally {
            teardown();
        }
    });

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
