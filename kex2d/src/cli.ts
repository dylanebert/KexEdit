#!/usr/bin/env bun
/** the headless CLI: stateless, file-in/file-out subcommands over the
 *  `.kex` document — no session, no server, no RPC: every invocation loads, acts, saves/reports,
 *  exits. One dispatcher (`dispatch`, exported so the test suite drives
 *  it in-process rather than spawning a process per case — the ~12s gate can't afford that) that
 *  every verb below routes through; the process entry point at the bottom is a thin wrapper
 *  (`argv` in, exit code + stdout text out).
 *
 *  **JSON out, refusals structured.** Every successful verb prints `{ ok: true, ... }`; every
 *  failure prints `{ ok: false, error: { guard, message } }` (or, for `edit`'s per-op refusals,
 *  `{ ok, results: OpResult[] }` — S2's own `{guard, message}` shape, one entry per op). Exit
 *  codes are the verdict: 0 success, 1 a refusal the file itself carries (a malformed document,
 *  a setter guard, a force-limit breach), 2 a usage error (bad argv) — never a thrown stack
 *  trace for an expected failure class.
 *
 *  **No second write path.** `edit` dispatches through `commands.applyOp` (S2) inside a fresh
 *  `history.createHistory()` — the same `track.ts` setters the UI drives, never a bespoke
 *  mutation. `stats`/`dump`/`validate` load + bake (`track.BakeSystem`) and read pure derived
 *  state (`stats.ts`/`forcelimits.ts`); `fmt` never touches an ECS at all — `doc.parseDocument` +
 *  `doc.serializeDocument` are pure text↔document, the canonicalization the round-trip oracle
 *  pins (`serialize(parse(text)) === text`). `new` seeds through `track.TrackPlugin`'s own
 *  `initialize` (the exact call `tests/track.test.ts` uses for "a NEW authored document"), not a
 *  hand-rolled seed — the one seed the UI's own boot path runs. */

import { existsSync } from "node:fs";
import { State } from "@dylanebert/shallot";
import {
    applyForceSegmentOp,
    applyOp,
    applyVelocitySegmentOp,
    isForceSegmentOp,
    isVelocitySegmentOp,
    type Op,
    type OpResult,
    type Refusal,
} from "./commands";
import {
    loadDocument,
    parseDocument,
    saveDocument,
    SemanticRefusalError,
    serializeDocument,
} from "./doc";
import { checkForceLimits, DEFAULT_PROFILE } from "./forcelimits";
import { createHistory } from "./history";
import { computeStats } from "./stats";
import { bakeOut, BakeSystem, samples, Track, trackEntity, TrackPlugin } from "./track";

export interface CliResult {
    exitCode: number;
    stdout: string;
}

const USAGE = `kex2d — a headless CLI over the kex2d authored substrate (.kex documents)

Usage:
  kex2d stats <file>                 structured stats readback (length, time, g envelope, airtime)
  kex2d dump <file>                  the baked curves (positions, force, speed, time)
  kex2d edit <file> [--ops <json>]   apply S2 ops (JSON array or single op), save in place
                                      (ops read from stdin when --ops is absent)
  kex2d fmt <file>                   parse + canonically reserialize in place
  kex2d new <file> [--force]         seed a fresh document (refuses to overwrite unless --force)
  kex2d validate <file>              report load refusals + force-limit breaches

Every verb loads the file, acts, saves or reports, and exits — no session, no server. JSON to
stdout on success; a refusal is a JSON error object ({guard, message}) and a non-zero exit.
Exit codes: 0 ok, 1 a refusal the file/ops carry, 2 a usage error.`;

function jsonOut(payload: unknown): string {
    return JSON.stringify(payload, null, 2);
}

function okResult(payload: Record<string, unknown>): CliResult {
    return { exitCode: 0, stdout: jsonOut({ ok: true, ...payload }) };
}

function errResult(
    exitCode: number,
    guard: string,
    message: string,
    extra?: Record<string, unknown>,
): CliResult {
    return { exitCode, stdout: jsonOut({ ok: false, error: { guard, message }, ...extra }) };
}

function toArray(x: ArrayLike<number>, n: number): number[] {
    return Array.from({ length: Math.max(0, n) }, (_, i) => x[i]);
}

// ── the file → baked-ECS boundary shared by stats/dump/validate ──────────────────────────────

interface LoadedTrack {
    state: State;
    trackEid: number;
}

type LoadOutcome = { ok: true; loaded: LoadedTrack } | { ok: false; result: CliResult };

/** read `file`, `loadDocument` it onto a fresh headless `State`, then run `BakeSystem` once
 *  (`state.step(0)`) so `bakeOut`/`samples`/`Track.count` are live — the same boundary
 *  `tests/track.test.ts`'s own scenario fixtures drive. A parse/load refusal or a missing file
 *  never touches anything past this function; it just reports. */
async function loadTrackFile(file: string): Promise<LoadOutcome> {
    let text: string;
    try {
        text = await Bun.file(file).text();
    } catch (e) {
        return {
            ok: false,
            result: errResult(1, "fileNotFound", `cannot read ${file}: ${(e as Error).message}`),
        };
    }
    const state = new State();
    state.addSystem(BakeSystem);
    try {
        loadDocument(state, text);
    } catch (e) {
        const extra = e instanceof SemanticRefusalError ? { refusals: e.refusals } : undefined;
        return {
            ok: false,
            result: errResult(1, "documentInvalid", (e as Error).message, extra),
        };
    }
    state.step(0);
    const trackEid = trackEntity(state);
    if (trackEid === null)
        return {
            ok: false,
            result: errResult(1, "noTrack", "the loaded document carries no track entity"),
        };
    return { ok: true, loaded: { state, trackEid } };
}

// ── verbs ─────────────────────────────────────────────────────────────────────────────────

async function cmdStats(file: string): Promise<CliResult> {
    const loaded = await loadTrackFile(file);
    if (!loaded.ok) return loaded.result;
    const { trackEid } = loaded.loaded;
    const out = bakeOut.get(trackEid);
    if (!out) return errResult(1, "bakeUnavailable", "no bake output for this track");
    const count = Track.count.get(trackEid);
    return okResult({ stats: computeStats(out, count) });
}

async function cmdDump(file: string): Promise<CliResult> {
    const loaded = await loadTrackFile(file);
    if (!loaded.ok) return loaded.result;
    const { trackEid } = loaded.loaded;
    const out = bakeOut.get(trackEid);
    const samp = samples.get(trackEid);
    if (!out || !samp) return errResult(1, "bakeUnavailable", "no bake output for this track");
    const count = Track.count.get(trackEid);
    const edges = Math.max(0, count - 1);
    return okResult({
        count,
        hash: out.hash,
        positions: {
            x: toArray(samp.posX, count),
            y: toArray(samp.posY, count),
            theta: toArray(samp.theta, count),
        },
        bake: {
            fN: toArray(out.fN, edges),
            ds: toArray(out.ds, edges),
            v: toArray(out.v, count),
            t: toArray(out.t, count),
            tTotal: out.tTotal,
            feasible: toArray(out.feasible, count),
            firstInfeasible: out.firstInfeasible,
        },
    });
}

function isOpShaped(op: unknown): op is { type: string } {
    return (
        typeof op === "object" && op !== null && typeof (op as { type?: unknown }).type === "string"
    );
}

/** apply every op in `opsText` (a JSON array of ops, or a single op object) to `file` through
 *  S2's `applyOp`, in one fresh `history.createHistory()` gesture stack, then save whatever
 *  landed — a per-axis refusal (S2's own `stationTaken`/`stripKeyframeTaken` shape) still
 *  applies part of the write, so the save always reflects the live document, never a rollback.
 *  `anyRefusal` (any op carrying a non-empty `refusals`, or a shape/dispatch failure) drives the
 *  exit code; the file is written either way — refusals are reported, not silently dropped. */
async function cmdEdit(file: string, opsText: string): Promise<CliResult> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(opsText);
    } catch (e) {
        return errResult(2, "opsInvalid", `ops is not valid JSON: ${(e as Error).message}`);
    }
    const ops: unknown[] = Array.isArray(parsed) ? parsed : [parsed];

    let text: string;
    try {
        text = await Bun.file(file).text();
    } catch (e) {
        return errResult(1, "fileNotFound", `cannot read ${file}: ${(e as Error).message}`);
    }
    const state = new State();
    try {
        loadDocument(state, text);
    } catch (e) {
        const extra = e instanceof SemanticRefusalError ? { refusals: e.refusals } : undefined;
        return errResult(1, "documentInvalid", (e as Error).message, extra);
    }

    const h = createHistory();
    const results: OpResult[] = [];
    let anyRefusal = false;
    for (const op of ops) {
        if (!isOpShaped(op)) {
            results.push({
                applied: false,
                refusals: [
                    {
                        guard: "opShapeInvalid",
                        message: `op is not a {"type": string, ...} object: ${JSON.stringify(op)}`,
                    },
                ],
            });
            anyRefusal = true;
            continue;
        }
        try {
            const result = isForceSegmentOp(op)
                ? applyForceSegmentOp(state, h, op)
                : isVelocitySegmentOp(op)
                  ? applyVelocitySegmentOp(state, h, op)
                  : applyOp(state, h, op as Op);
            results.push(result);
            if (result.refusals.length > 0) anyRefusal = true;
        } catch (e) {
            results.push({
                applied: false,
                refusals: [{ guard: "unknownOp", message: (e as Error).message }],
            });
            anyRefusal = true;
        }
    }
    await Bun.write(file, saveDocument(state));
    return { exitCode: anyRefusal ? 1 : 0, stdout: jsonOut({ ok: !anyRefusal, results }) };
}

/** pure text↔document canonicalization — never touches an ECS (no `loadDocument`/`BakeSystem`),
 *  the round-trip oracle's idempotence leg (`doc.serializeDocument`'s own docblock:
 *  `serialize(parse(text)) === text`) run as a verb. */
async function cmdFmt(file: string): Promise<CliResult> {
    let text: string;
    try {
        text = await Bun.file(file).text();
    } catch (e) {
        return errResult(1, "fileNotFound", `cannot read ${file}: ${(e as Error).message}`);
    }
    let doc: ReturnType<typeof parseDocument>;
    try {
        doc = parseDocument(text);
    } catch (e) {
        return errResult(1, "documentInvalid", (e as Error).message);
    }
    const canonical = serializeDocument(doc);
    await Bun.write(file, canonical);
    return okResult({ changed: canonical !== text, bytes: canonical.length });
}

/** seed a fresh document through `TrackPlugin`'s own `initialize` (`track.ts`'s `seed`) — the
 *  exact seed the app's boot path runs (`main.ts`'s `run({ plugins: [... TrackPlugin ...] })`),
 *  not a hand-rolled duplicate. Refuses to clobber an existing file unless `--force`, since this
 *  is the one verb that doesn't require the target to already exist. */
async function cmdNew(file: string, force: boolean): Promise<CliResult> {
    if (!force && existsSync(file))
        return errResult(1, "fileExists", `${file} already exists; pass --force to overwrite`);
    const state = new State();
    await TrackPlugin.initialize?.(state);
    await Bun.write(file, saveDocument(state));
    return okResult({ created: file });
}

/** structural + semantic refusals (`doc.loadDocument`'s per-invariant `Refusal[]`, off its thrown
 *  `SemanticRefusalError`) plus force-limit breaches (`forcelimits.checkForceLimits`,
 *  `DEFAULT_PROFILE`). `structuralRefusals` is the named-guard list `loadDocument`'s S4 boundary
 *  enforces — empty on a structurally+semantically valid document, never a single flattened
 *  prose string. */
async function cmdValidate(file: string): Promise<CliResult> {
    let text: string;
    try {
        text = await Bun.file(file).text();
    } catch (e) {
        return errResult(1, "fileNotFound", `cannot read ${file}: ${(e as Error).message}`);
    }
    const state = new State();
    state.addSystem(BakeSystem);
    try {
        loadDocument(state, text);
    } catch (e) {
        const structuralRefusals: Refusal[] =
            e instanceof SemanticRefusalError
                ? e.refusals
                : [{ guard: "documentInvalid", message: (e as Error).message }];
        return {
            exitCode: 1,
            stdout: jsonOut({
                ok: false,
                valid: false,
                structuralRefusals,
                forceLimitBreaches: [],
            }),
        };
    }
    state.step(0);
    const trackEid = trackEntity(state);
    if (trackEid === null) {
        return {
            exitCode: 1,
            stdout: jsonOut({
                ok: false,
                valid: false,
                structuralRefusals: [
                    { guard: "noTrack", message: "the loaded document carries no track entity" },
                ],
                forceLimitBreaches: [],
            }),
        };
    }
    const out = bakeOut.get(trackEid);
    const count = Track.count.get(trackEid);
    const breaches = out ? checkForceLimits(out, count, DEFAULT_PROFILE) : [];
    const valid = breaches.length === 0;
    return {
        exitCode: valid ? 0 : 1,
        stdout: jsonOut({
            ok: valid,
            valid,
            structuralRefusals: [],
            forceLimitBreaches: breaches,
        }),
    };
}

// ── argv parsing + dispatch ──────────────────────────────────────────────────────────────────

function parseFlags(rest: string[]): {
    positional: string[];
    flags: Record<string, string | true>;
} {
    const positional: string[] = [];
    const flags: Record<string, string | true> = {};
    for (let i = 0; i < rest.length; i++) {
        const arg = rest[i];
        if (arg.startsWith("--")) {
            const key = arg.slice(2);
            const next = rest[i + 1];
            if (next !== undefined && !next.startsWith("--")) {
                flags[key] = next;
                i++;
            } else {
                flags[key] = true;
            }
        } else {
            positional.push(arg);
        }
    }
    return { positional, flags };
}

/** the one dispatcher — `argv` (never including the `bun`/script argv[0..1]) in, an exit code +
 *  stdout string out. `readStdin` is injected so the test suite can drive `edit`'s stdin-ops
 *  path in-process (a real spawn per case would blow the ~12s gate); the process entry point
 *  below supplies the real `Bun.stdin.text`. */
export async function dispatch(
    argv: string[],
    readStdin: () => Promise<string> = () => Bun.stdin.text(),
): Promise<CliResult> {
    const [verb, ...rest] = argv;
    if (!verb) return { exitCode: 2, stdout: USAGE };
    if (verb === "--help" || verb === "-h") return { exitCode: 0, stdout: USAGE };

    const { positional, flags } = parseFlags(rest);
    const file = positional[0];

    switch (verb) {
        case "stats":
            if (!file) return errResult(2, "usage", "stats requires a <file> argument");
            return cmdStats(file);
        case "dump":
            if (!file) return errResult(2, "usage", "dump requires a <file> argument");
            return cmdDump(file);
        case "edit": {
            if (!file) return errResult(2, "usage", "edit requires a <file> argument");
            const opsFlag = flags.ops;
            const opsText = typeof opsFlag === "string" ? opsFlag : await readStdin();
            return cmdEdit(file, opsText);
        }
        case "fmt":
            if (!file) return errResult(2, "usage", "fmt requires a <file> argument");
            return cmdFmt(file);
        case "new":
            if (!file) return errResult(2, "usage", "new requires a <file> argument");
            return cmdNew(file, flags.force === true || flags.force === "true");
        case "validate":
            if (!file) return errResult(2, "usage", "validate requires a <file> argument");
            return cmdValidate(file);
        default:
            return errResult(2, "usage", `unknown verb "${verb}" — run with --help for usage`);
    }
}

if (import.meta.main) {
    const result = await dispatch(process.argv.slice(2));
    console.log(result.stdout);
    process.exit(result.exitCode);
}
