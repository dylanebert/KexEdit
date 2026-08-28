/** the kex2d document — a canonical, lossless text form of the authored ECS state
 *  (`kex2d/AGENTS.md` § Authoring API): the `Track` authored scalars (`ds`/`domain`/
 *  `friction`/`resistance` — NOT `count`, bake-derived, `BakeSystem` writes it, `track.ts:3920`)
 *  plus every section/node/force-point, strip/strip-keyframe, and the track-start one-shot.
 *  `.kex`, JSON inside, text canonical (spec Locked decision) — the glTF/`.ipynb` shape.
 *
 *  **Canonical emitter, not `JSON.stringify(doc, null, 2)`.** Determinism + diff-readability are
 *  emitter discipline: fixed key order per entity (mirroring each component's own field order),
 *  sections ordered by `order`, nodes by `order`, force points/strips/strip-keyframes by `id`
 *  (their STABLE identity — never by `s`/`start`, which `sectionForces`/`allStrips`/
 *  `stripKeyframes` sort by for the bake's own reasons; sorting the document by a value a drag
 *  can move would reorder the emitted list on every edit). One entity per line.
 *
 *  **f32 exactness.** Every stored scalar here is f32 (`sparse(f32)`/`vec2`'s lanes); a
 *  `Component.get` widens it to the f64 that represents the SAME bits, and `JSON.stringify`
 *  emits the shortest decimal that round-trips to that exact f64 (the JS number-to-string
 *  algorithm) — parse recovers the identical f64, and the f32 component write
 *  (`Math.fround` under the hood) restores identical bits. Never reach for `toFixed`/rounding
 *  here — that's exactly the exactness this module exists to hold.
 *
 *  **Validate fully before touching the ECS.** `loadDocument` parses + validates the WHOLE text
 *  first; a refused load throws and leaves the live document untouched (Locked decision:
 *  "a refused load leaves the live document untouched"). */

import { State } from "@dylanebert/shallot";
import type { Refusal } from "./commands";
import { history } from "./history";
import { Easing, type Offset } from "./profile";
import { Domain } from "./section";
import { TangentMode, type Tangent } from "./spline";
import {
    allStrips,
    createTrack,
    DS_NOMINAL,
    type ForceTangent,
    MIN_FORCE_LEN,
    MIN_V0,
    type NodeState,
    type OneShotSnapshot,
    reserveIds,
    restoreAll,
    type SectionSnapshot,
    SectionKind,
    stripCoversOneEdge,
    stripOverlapped,
    type StripSnapshot,
    snapshotAll,
    Track,
    trackEntity,
    type TrackSnapshot,
    validCoefficient,
    validStripValue,
} from "./track";

/** the document format's own version — forward-only migrations (below) bridge an older file up
 *  to this. Bumped when the authored shape changes (segment-first authoring, spec Locked
 *  decision, is the first expected bump); migrations stay cheap by design (one function per
 *  version step, applied in sequence). */
export const CURRENT_VERSION = 1;

// ── wire types (post-parse, post-migration — always shaped exactly like this) ────────────────

export interface DocTrack {
    ds: number;
    domain: number;
    friction: number;
    resistance: number;
}

export interface DocGeoTangent {
    mode: number;
    inX: number;
    inY: number;
    outX: number;
    outY: number;
}

export interface DocNode {
    order: number;
    x: number;
    y: number;
    theta: number;
    tangent?: DocGeoTangent;
}

export interface DocOffset {
    ds: number;
    dg: number;
}

export interface DocForceTangent {
    mode: number;
    in?: DocOffset;
    out?: DocOffset;
}

export interface DocPoint {
    id: number;
    s: number;
    g: number;
    ease: number;
    tangent?: DocForceTangent;
}

export interface DocSection {
    id: number;
    order: number;
    kind: number;
    length: number;
    nodes: DocNode[];
    points: DocPoint[];
}

export interface DocStripKeyframe {
    id: number;
    s: number;
    v: number;
}

export interface DocStrip {
    id: number;
    start: number;
    end: number;
    value: number;
    keyframes: DocStripKeyframe[];
}

export interface DocOneShot {
    id: number;
    value: number;
}

export interface Kex2dDocument {
    version: number;
    track: DocTrack;
    sections: DocSection[];
    strips: DocStrip[];
    oneShot: DocOneShot[];
}

// ── ECS → document ─────────────────────────────────────────────────────────────────────────

function toDocTangent(t: Tangent | undefined): DocGeoTangent | undefined {
    return t ? { mode: t.mode, inX: t.inX, inY: t.inY, outX: t.outX, outY: t.outY } : undefined;
}

function toDocForceTangent(t: ForceTangent | undefined): DocForceTangent | undefined {
    if (!t) return undefined;
    const out: DocForceTangent = { mode: t.mode };
    if (t.in) out.in = { ds: t.in.ds, dg: t.in.dg };
    if (t.out) out.out = { ds: t.out.ds, dg: t.out.dg };
    return out;
}

function toDocSection(s: SectionSnapshot): DocSection {
    return {
        id: s.id,
        order: s.order,
        kind: s.kind,
        length: s.length,
        nodes: s.nodes
            .slice()
            .sort((a, b) => a.order - b.order)
            .map((n) => ({
                order: n.order,
                x: n.x,
                y: n.y,
                theta: n.theta,
                tangent: toDocTangent(n.tangent),
            })),
        points: s.points
            .slice()
            .sort((a, b) => a.id - b.id)
            .map((p) => ({
                id: p.id,
                s: p.s,
                g: p.g,
                ease: p.ease,
                tangent: toDocForceTangent(p.tangent),
            })),
    };
}

function toDocStrip(st: StripSnapshot): DocStrip {
    return {
        id: st.id,
        start: st.start,
        end: st.end,
        value: st.value,
        keyframes: st.keyframes
            .slice()
            .sort((a, b) => a.id - b.id)
            .map((k) => ({ id: k.id, s: k.s, v: k.v })),
    };
}

function toDocOneShot(o: OneShotSnapshot): DocOneShot {
    return { id: o.id, value: o.value };
}

/** the whole live document — every authored ECS component, canonically ordered. `snapshotAll`
 *  supplies sections/strips/one-shot (already section-order / node-order sorted; force
 *  points/strips/keyframes re-sorted here from their bake-order `s`/`start` reads to their
 *  stable `id`); the four `Track` scalars ride separately (`snapshotAll`'s `TrackSnapshot`
 *  carries no track-global column — `count` is bake output and stays out on purpose). */
export function docFromEcs(ecs: State): Kex2dDocument {
    const snap = snapshotAll(ecs);
    const trackEid = trackEntity(ecs);
    const track: DocTrack =
        trackEid === null
            ? { ds: DS_NOMINAL, domain: Domain.Distance, friction: 0, resistance: 0 }
            : {
                  ds: Track.ds.get(trackEid),
                  domain: Track.domain.get(trackEid),
                  friction: Track.friction.get(trackEid),
                  resistance: Track.resistance.get(trackEid),
              };
    return {
        version: CURRENT_VERSION,
        track,
        sections: snap.sections
            .slice()
            .sort((a, b) => a.order - b.order)
            .map(toDocSection),
        strips: snap.strips
            .slice()
            .sort((a, b) => a.id - b.id)
            .map(toDocStrip),
        oneShot: snap.oneShot.map(toDocOneShot),
    };
}

// ── document → ECS ─────────────────────────────────────────────────────────────────────────

function fromDocTangent(t: DocGeoTangent | undefined): Tangent | undefined {
    return t
        ? { mode: t.mode as TangentMode, inX: t.inX, inY: t.inY, outX: t.outX, outY: t.outY }
        : undefined;
}

function fromDocOffset(o: DocOffset | undefined): Offset | undefined {
    return o ? { ds: o.ds, dg: o.dg } : undefined;
}

function fromDocForceTangent(t: DocForceTangent | undefined): ForceTangent | undefined {
    if (!t) return undefined;
    const out: ForceTangent = { mode: t.mode as TangentMode };
    const inOff = fromDocOffset(t.in);
    if (inOff) out.in = inOff;
    const outOff = fromDocOffset(t.out);
    if (outOff) out.out = outOff;
    return out;
}

function fromDocSection(s: DocSection): SectionSnapshot {
    return {
        id: s.id,
        order: s.order,
        kind: s.kind as SectionKind,
        length: s.length,
        nodes: s.nodes.map(
            (n): NodeState => ({
                order: n.order,
                x: n.x,
                y: n.y,
                theta: n.theta,
                tangent: fromDocTangent(n.tangent),
            }),
        ),
        points: s.points.map((p) => ({
            id: p.id,
            s: p.s,
            g: p.g,
            ease: p.ease as Easing,
            tangent: fromDocForceTangent(p.tangent),
        })),
    };
}

/** the document's sections/strips/one-shot, projected back onto `restoreAll`'s own
 *  `TrackSnapshot` shape — the four `Track` scalars are applied separately by the caller
 *  (`restoreAll` never touches the `Track` component itself). */
export function docToTrackSnapshot(doc: Kex2dDocument): TrackSnapshot {
    return {
        sections: doc.sections.map(fromDocSection),
        strips: doc.strips.map((st) => ({
            id: st.id,
            start: st.start,
            end: st.end,
            value: st.value,
            keyframes: st.keyframes.map((k) => ({ id: k.id, s: k.s, v: k.v })),
        })),
        oneShot: doc.oneShot.map((o) => ({ id: o.id, value: o.value })),
    };
}

// ── canonical text emitter ────────────────────────────────────────────────────────────────

/** a JSON number literal for `n` — `String(n)` (the same shortest-round-trip algorithm
 *  `JSON.stringify` uses for a number) EXCEPT for negative zero, which `JSON.stringify`
 *  silently collapses to `"0"` (`JSON.stringify(-0) === "0"`, confirmed) while `JSON.parse`
 *  correctly recovers `-0` from the literal `-0` (`Object.is(JSON.parse("-0"), -0) === true`,
 *  also confirmed) — so `JSON.stringify` alone breaks bit-identical f32 exactness for exactly
 *  this one value. `-0` is valid JSON (the grammar is `-? int frac? exp?`; `int` may be `0`). */
export function numLit(n: number): string {
    if (!Number.isFinite(n))
        throw new Error(
            `kex2d document: cannot serialize a non-finite number (${n}) — the live ECS holds invalid state (this is a bug, not a malformed-file case).`,
        );
    return Object.is(n, -0) ? "-0" : String(n);
}

/** a flat entity (no nested entity arrays, only plain objects/numbers) — one line, fixed key
 *  order. Recurses by hand rather than calling `JSON.stringify` directly so every number in the
 *  tree (not just the top level) routes through {@link numLit} and keeps its `-0`. Key order is
 *  whatever order the caller built the object in (JS preserves string-key insertion order),
 *  which every `toDoc*`/`fromDoc*` above builds to mirror its owning component's own field
 *  order — that's the "fixed key order" the module doc promises. An `undefined` value (an
 *  absent optional field, e.g. a node's `tangent`) drops its key, matching `JSON.stringify`'s
 *  own convention. */
function emitFlat(v: unknown): string {
    if (typeof v === "number") return numLit(v);
    if (Array.isArray(v)) return `[${v.map(emitFlat).join(",")}]`;
    if (v !== null && typeof v === "object") {
        const parts: string[] = [];
        for (const [k, val] of Object.entries(v)) {
            if (val === undefined) continue;
            parts.push(`${JSON.stringify(k)}:${emitFlat(val)}`);
        }
        return `{${parts.join(",")}}`;
    }
    return JSON.stringify(v);
}

/** an array of flat entities, one per line, at `indent` (the array's OWN key's indent — each
 *  entity lands one level deeper). `[]` inline when empty, never an empty multi-line pair. */
function emitFlatArray(indent: string, items: unknown[]): string {
    if (items.length === 0) return "[]";
    const inner = items.map((it) => `${indent}  ${emitFlat(it)}`).join(",\n");
    return `[\n${inner}\n${indent}]`;
}

/** an array of already-rendered multi-line entity blocks (each a bare, un-indented string
 *  starting at `{` and ending at `}`, built by `renderSection`/`renderStrip` below) — indents
 *  every line of every block by `indent + "  "` and joins them, entity commas included. */
function emitBlockArray(indent: string, blocks: string[]): string {
    if (blocks.length === 0) return "[]";
    const inner = blocks
        .map((b) =>
            b
                .split("\n")
                .map((l) => `${indent}  ${l}`)
                .join("\n"),
        )
        .join(",\n");
    return `[\n${inner}\n${indent}]`;
}

/** one section, rendered at LOCAL indent 0 (its own `{` has none; its fields sit two spaces
 *  in) — `emitBlockArray` re-indents the whole block uniformly when it's embedded, so the
 *  local nesting here only has to be internally consistent. */
function renderSection(sec: DocSection): string {
    return [
        "{",
        `  "id": ${sec.id},`,
        `  "order": ${sec.order},`,
        `  "kind": ${sec.kind},`,
        `  "length": ${emitFlat(sec.length)},`,
        `  "nodes": ${emitFlatArray("  ", sec.nodes)},`,
        `  "points": ${emitFlatArray("  ", sec.points)}`,
        "}",
    ].join("\n");
}

function renderStrip(st: DocStrip): string {
    return [
        "{",
        `  "id": ${st.id},`,
        `  "start": ${emitFlat(st.start)},`,
        `  "end": ${emitFlat(st.end)},`,
        `  "value": ${emitFlat(st.value)},`,
        `  "keyframes": ${emitFlatArray("  ", st.keyframes)}`,
        "}",
    ].join("\n");
}

/** the canonical serializer: `serialize(parse(text)) === text` for every document this module
 *  produces (the round-trip oracle's idempotence leg) — no field this function reads is ever
 *  computed from anything but the document itself, so two calls on the same document always
 *  agree. */
export function serializeDocument(doc: Kex2dDocument): string {
    const lines = [
        "{",
        `  "version": ${doc.version},`,
        `  "track": ${emitFlat(doc.track)},`,
        `  "sections": ${emitBlockArray("  ", doc.sections.map(renderSection))},`,
        `  "strips": ${emitBlockArray("  ", doc.strips.map(renderStrip))},`,
        `  "oneShot": ${emitFlatArray("  ", doc.oneShot)}`,
        "}",
    ];
    return `${lines.join("\n")}\n`;
}

// ── parse + validate + migrate ───────────────────────────────────────────────────────────

/** every parse/validate/migrate failure throws through here — one message shape, the named
 *  remedy the spec's rejection-arm oracle checks for. */
function fail(msg: string): never {
    throw new Error(
        `kex2d document: ${msg}. The file may be truncated, corrupted, or hand-edited invalid — re-save from a working document to recover.`,
    );
}

/** thrown by the semantic-refusal path only (`failSemantics`, below) — carries the per-invariant
 *  `Refusal[]` a structural `fail()` throw never has, so a CLI caller (`cli.ts`'s
 *  `loadTrackFile`/`cmdEdit`/`cmdValidate`) can emit the violated guards structured instead of
 *  re-flattening this error's own message string. `message` still reads exactly like a
 *  structural rejection (same `kex2d document: … ` wrapper) for a caller matching on that prefix
 *  or the recovery-remedy text alone. */
export class SemanticRefusalError extends Error {
    readonly refusals: Refusal[];
    constructor(message: string, refusals: Refusal[]) {
        super(message);
        this.name = "SemanticRefusalError";
        this.refusals = refusals;
    }
}

/** every semantic-invariant refusal throws through here, one thrown message naming every
 *  violated guard — `fail`'s own remedy suffix, so a semantic rejection reads exactly like a
 *  structural one to a caller matching on `/kex2d document:/` or the recovery-remedy text. */
function failSemantics(refusals: Refusal[]): never {
    const detail = refusals.map((r) => `${r.guard}: ${r.message}`).join("; ");
    const msg = `document violates ${refusals.length} invariant${refusals.length === 1 ? "" : "s"} — ${detail}`;
    throw new SemanticRefusalError(
        `kex2d document: ${msg}. The file may be truncated, corrupted, or hand-edited invalid — re-save from a working document to recover.`,
        refusals,
    );
}

function isFiniteNumber(v: unknown): v is number {
    return typeof v === "number" && Number.isFinite(v);
}

function isInt(v: unknown): v is number {
    return typeof v === "number" && Number.isInteger(v);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** the document's `tangent` key is only ever present for an EXPLICIT tangent (`TangentMode`'s
 *  1|2|3 — Aligned/Free/Mirror); the "no explicit tangent" sentinel (`Auto`, `TANGENT_AUTO` =
 *  0, `track.ts`) is encoded as the key's ABSENCE, never as `{"mode":0,...}` — `toDocTangent`/
 *  `toDocForceTangent` only ever call through with a defined `Tangent`/`ForceTangent`, which
 *  `readTangent`/`readForceTangent` only return for a non-Auto mode. So a document carrying
 *  `mode: 0` (or anything outside 1|2|3) inside a `tangent` object is malformed, not a valid
 *  Auto encoding. */
function isExplicitTangentMode(v: unknown): v is TangentMode {
    return v === TangentMode.Aligned || v === TangentMode.Free || v === TangentMode.Mirror;
}

function validateGeoTangent(v: unknown, path: string): DocGeoTangent | undefined {
    if (v === undefined) return undefined;
    if (!isPlainObject(v)) fail(`${path} is not an object`);
    if (!isExplicitTangentMode(v.mode))
        fail(`${path}.mode is missing or not a valid TangentMode (1, 2, or 3)`);
    for (const k of ["inX", "inY", "outX", "outY"] as const) {
        if (!isFiniteNumber(v[k])) fail(`${path}.${k} is missing or not a finite number`);
    }
    return {
        mode: v.mode as number,
        inX: v.inX as number,
        inY: v.inY as number,
        outX: v.outX as number,
        outY: v.outY as number,
    };
}

function validateOffset(v: unknown, path: string): DocOffset | undefined {
    if (v === undefined) return undefined;
    if (!isPlainObject(v)) fail(`${path} is not an object`);
    if (!isFiniteNumber(v.ds)) fail(`${path}.ds is missing or not a finite number`);
    if (!isFiniteNumber(v.dg)) fail(`${path}.dg is missing or not a finite number`);
    return { ds: v.ds as number, dg: v.dg as number };
}

function validateForceTangent(v: unknown, path: string): DocForceTangent | undefined {
    if (v === undefined) return undefined;
    if (!isPlainObject(v)) fail(`${path} is not an object`);
    if (!isExplicitTangentMode(v.mode))
        fail(`${path}.mode is missing or not a valid TangentMode (1, 2, or 3)`);
    return {
        mode: v.mode as number,
        in: validateOffset(v.in, `${path}.in`),
        out: validateOffset(v.out, `${path}.out`),
    };
}

function validateNode(v: unknown, path: string): DocNode {
    if (!isPlainObject(v)) fail(`${path} is not an object`);
    if (!isInt(v.order)) fail(`${path}.order is missing or not an integer`);
    for (const k of ["x", "y", "theta"] as const) {
        if (!isFiniteNumber(v[k])) fail(`${path}.${k} is missing or not a finite number`);
    }
    return {
        order: v.order as number,
        x: v.x as number,
        y: v.y as number,
        theta: v.theta as number,
        tangent: validateGeoTangent(v.tangent, `${path}.tangent`),
    };
}

function validatePoint(v: unknown, path: string): DocPoint {
    if (!isPlainObject(v)) fail(`${path} is not an object`);
    if (!isInt(v.id)) fail(`${path}.id is missing or not an integer`);
    for (const k of ["s", "g"] as const) {
        if (!isFiniteNumber(v[k])) fail(`${path}.${k} is missing or not a finite number`);
    }
    if (
        !isInt(v.ease) ||
        (v.ease !== Easing.Linear && v.ease !== Easing.Cubic && v.ease !== Easing.Quintic)
    )
        fail(`${path}.ease is missing or not a valid Easing (0, 1, or 2)`);
    return {
        id: v.id as number,
        s: v.s as number,
        g: v.g as number,
        ease: v.ease as number,
        tangent: validateForceTangent(v.tangent, `${path}.tangent`),
    };
}

function validateSection(v: unknown, i: number): DocSection {
    const path = `sections[${i}]`;
    if (!isPlainObject(v)) fail(`${path} is not an object`);
    if (!isInt(v.id)) fail(`${path}.id is missing or not an integer`);
    if (!isInt(v.order)) fail(`${path}.order is missing or not an integer`);
    if (!isInt(v.kind) || (v.kind !== SectionKind.Geo && v.kind !== SectionKind.Force))
        fail(`${path}.kind is missing or not a valid SectionKind (0 or 1)`);
    if (!isFiniteNumber(v.length)) fail(`${path}.length is missing or not a finite number`);
    if (!Array.isArray(v.nodes)) fail(`${path}.nodes is missing or not an array`);
    if (!Array.isArray(v.points)) fail(`${path}.points is missing or not an array`);
    return {
        id: v.id as number,
        order: v.order as number,
        kind: v.kind as number,
        length: v.length as number,
        nodes: v.nodes.map((n, j) => validateNode(n, `${path}.nodes[${j}]`)),
        points: v.points.map((p, j) => validatePoint(p, `${path}.points[${j}]`)),
    };
}

function validateStripKeyframe(v: unknown, path: string): DocStripKeyframe {
    if (!isPlainObject(v)) fail(`${path} is not an object`);
    if (!isInt(v.id)) fail(`${path}.id is missing or not an integer`);
    if (!isFiniteNumber(v.s)) fail(`${path}.s is missing or not a finite number`);
    if (!isFiniteNumber(v.v)) fail(`${path}.v is missing or not a finite number`);
    return { id: v.id as number, s: v.s as number, v: v.v as number };
}

function validateStrip(v: unknown, i: number): DocStrip {
    const path = `strips[${i}]`;
    if (!isPlainObject(v)) fail(`${path} is not an object`);
    if (!isInt(v.id)) fail(`${path}.id is missing or not an integer`);
    for (const k of ["start", "end", "value"] as const) {
        if (!isFiniteNumber(v[k])) fail(`${path}.${k} is missing or not a finite number`);
    }
    if (!Array.isArray(v.keyframes)) fail(`${path}.keyframes is missing or not an array`);
    return {
        id: v.id as number,
        start: v.start as number,
        end: v.end as number,
        value: v.value as number,
        keyframes: v.keyframes.map((k, j) => validateStripKeyframe(k, `${path}.keyframes[${j}]`)),
    };
}

function validateOneShot(v: unknown, i: number): DocOneShot {
    const path = `oneShot[${i}]`;
    if (!isPlainObject(v)) fail(`${path} is not an object`);
    if (!isInt(v.id)) fail(`${path}.id is missing or not an integer`);
    if (!isFiniteNumber(v.value)) fail(`${path}.value is missing or not a finite number`);
    return { id: v.id as number, value: v.value as number };
}

function validateTrack(v: unknown): DocTrack {
    if (!isPlainObject(v)) fail("track is missing or not an object");
    for (const k of ["ds", "friction", "resistance"] as const) {
        if (!isFiniteNumber(v[k])) fail(`track.${k} is missing or not a finite number`);
    }
    if (!isInt(v.domain) || (v.domain !== Domain.Distance && v.domain !== Domain.Time))
        fail("track.domain is missing or not a valid Domain (0 or 1)");
    return {
        ds: v.ds as number,
        domain: v.domain as number,
        friction: v.friction as number,
        resistance: v.resistance as number,
    };
}

/** the full structural validator — every field type-checked, every required key present,
 *  before a single ECS write happens (`loadDocument` calls this, then `restoreAll`, never the
 *  other order). Applied AFTER migration, so it only ever sees `CURRENT_VERSION` shape. */
function validateDocument(raw: Record<string, unknown>): Kex2dDocument {
    if (!isInt(raw.version)) fail("version is missing or not an integer");
    const track = validateTrack(raw.track);
    if (!Array.isArray(raw.sections)) fail("sections is missing or not an array");
    if (!Array.isArray(raw.strips)) fail("strips is missing or not an array");
    if (!Array.isArray(raw.oneShot)) fail("oneShot is missing or not an array");
    if (raw.oneShot.length > 1) fail("oneShot carries more than one entry (at most one may exist)");
    return {
        version: raw.version as number,
        track,
        sections: raw.sections.map((s, i) => validateSection(s, i)),
        strips: raw.strips.map((s, i) => validateStrip(s, i)),
        oneShot: raw.oneShot.map((o, i) => validateOneShot(o, i)),
    };
}

// ── semantic invariant validation (document-boundary guard census) ───────────────────────
//
// `validateDocument` above is purely structural (types present, enums in range) — it lets
// through a document that is well-SHAPED but violates an authoring invariant the live setters
// enforce (`track.ts`'s guard predicates). `restoreAll`'s spawn path bypasses every one of
// those guards on purpose (an in-session undo snapshot is already-validated state, spec Locked
// decision), so a hand-authored `.kex` file that breaks one loads silently today. The checks
// below close that: every one reuses the SAME named predicate a setter or S2's `commands.ts`
// already reads (`Refusal`'s `{guard, message}` shape imported from there, not reinvented), so
// a refusal here and a refusal from an edit op key on the same guard vocabulary.
//
// Two passes. `checkDocInvariants` is pure — doc-shape only, no ECS — and covers everything
// that's a plain scalar/count comparison over the parsed document (duplicate ids, section-order
// collisions, kind-mismatched payloads, node/extent floors, duplicate stations, coefficient/
// value validity, the start-speed floor). `checkGeometryInvariants` covers the two guards that
// are irreducibly geometric — `stripOverlapped`/`stripCoversOneEdge` resolve a strip's edge
// range against a section's OWN chord length (`sectionEdgeDs`/`geoChordDs`), a real spline
// evaluation, not a doc-level number — so it builds a throwaway `State`, loads the CANDIDATE
// document into it (no bake tick needed: both predicates are pure derivations off the authored
// payload), and reads the predicates there. This throwaway state is never the caller's `ecs` —
// `loadDocument`'s "untouched on refusal" guarantee holds by construction, not by rollback.

function checkDuplicateIds(doc: Kex2dDocument): Refusal[] {
    const refusals: Refusal[] = [];
    const check = (category: string, ids: number[]) => {
        const seen = new Set<number>();
        for (const id of ids) {
            if (seen.has(id))
                refusals.push({
                    guard: "duplicateId",
                    message: `two or more ${category} share id ${id} — ids must be unique within their category`,
                });
            seen.add(id);
        }
    };
    check(
        "sections",
        doc.sections.map((s) => s.id),
    );
    check(
        "force points",
        doc.sections.flatMap((s) => s.points.map((p) => p.id)),
    );
    check(
        "strips",
        doc.strips.map((st) => st.id),
    );
    check(
        "strip keyframes",
        doc.strips.flatMap((st) => st.keyframes.map((k) => k.id)),
    );
    return refusals;
}

/** the pure, no-ECS half: every invariant checkable from the parsed document's own fields.
 *  Named per-guard, matching `track.ts`'s predicate names (or `commands.ts`'s `sectionKind`,
 *  where the guard is an affordance fence rather than a `track.ts` export) so a caller can
 *  branch on the reason without parsing the message, the same contract `commands.ts` keeps. */
export function checkDocInvariants(doc: Kex2dDocument): Refusal[] {
    const refusals: Refusal[] = checkDuplicateIds(doc);

    if (doc.sections.length === 0)
        refusals.push({
            guard: "emptyTrack",
            message: "a document must contain at least one section",
        });

    const orders = new Set<number>();
    for (const s of doc.sections) {
        if (orders.has(s.order))
            refusals.push({
                guard: "duplicateSectionOrder",
                message: `two or more sections claim order ${s.order}`,
            });
        orders.add(s.order);
    }

    for (const s of doc.sections) {
        if (s.kind === SectionKind.Geo) {
            if (s.points.length > 0)
                refusals.push({
                    guard: "sectionKind",
                    message: `section ${s.id} is a geo section but carries force points`,
                });
            if (s.nodes.length < 2)
                refusals.push({
                    guard: "minNodeFloor",
                    message: `section ${s.id} is a geo section with fewer than two nodes (node 0 + one shape node)`,
                });
            const node0 = s.nodes.find((n) => n.order === 0);
            if (node0 && (node0.x !== 0 || node0.y !== 0 || node0.theta !== 0))
                refusals.push({
                    guard: "nodeZeroOrigin",
                    message: `section ${s.id}'s node 0 must sit at the local origin (0, 0) with heading 0 (the rigid-placement law) — found (${node0.x}, ${node0.y}, θ=${node0.theta})`,
                });
        } else {
            if (s.nodes.length > 0)
                refusals.push({
                    guard: "sectionKind",
                    message: `section ${s.id} is a force section but carries geo nodes`,
                });
            if (s.length < MIN_FORCE_LEN)
                refusals.push({
                    guard: "minForceExtent",
                    message: `section ${s.id}'s extent ${s.length} is below the minimum force-section extent ${MIN_FORCE_LEN}`,
                });
        }
        const stations = new Set<number>();
        for (const p of s.points) {
            const key = Math.fround(p.s);
            if (stations.has(key))
                refusals.push({
                    guard: "stationTaken",
                    message: `two or more force points on section ${s.id} share station ${p.s}`,
                });
            stations.add(key);
        }
    }

    for (const st of doc.strips) {
        if (!validStripValue(st.value))
            refusals.push({
                guard: "validStripValue",
                message: `strip ${st.id}'s value ${st.value} must be finite and strictly positive`,
            });
        const stations = new Set<number>();
        for (const k of st.keyframes) {
            const key = Math.fround(k.s);
            if (stations.has(key))
                refusals.push({
                    guard: "stripKeyframeTaken",
                    message: `two or more keyframes on strip ${st.id} share station ${k.s}`,
                });
            stations.add(key);
        }
    }

    if (!validCoefficient(doc.track.friction))
        refusals.push({
            guard: "validCoefficient",
            message: `track.friction (${doc.track.friction}) must be finite and non-negative`,
        });
    if (!validCoefficient(doc.track.resistance))
        refusals.push({
            guard: "validCoefficient",
            message: `track.resistance (${doc.track.resistance}) must be finite and non-negative`,
        });

    for (const o of doc.oneShot) {
        if (o.value < MIN_V0)
            refusals.push({
                guard: "minStartSpeed",
                message: `the track-start speed ${o.value} is below the minimum ${MIN_V0}`,
            });
    }

    return refusals;
}

/** the four `Track` scalars `restoreAll` doesn't own, read off a known-live track entity —
 *  `loadDocument`'s own rollback snapshot for the geometry-refusal path. */
function readTrackScalars(trackEid: number) {
    return {
        ds: Track.ds.get(trackEid),
        domain: Track.domain.get(trackEid),
        friction: Track.friction.get(trackEid),
        resistance: Track.resistance.get(trackEid),
        count: Track.count.get(trackEid),
    };
}

/** a throwaway `State` carrying `doc`'s candidate document — never the caller's live `ecs`,
 *  never bake-ticked (the two geometry guards below are pure derivations off the authored
 *  payload, `track.ts`'s own docblocks on `sectionEdgeDs`/`stripCoversOneEdge`).
 *
 *  **Isolation contract: call only where no OTHER `State` is concurrently live in the
 *  process.** `track.ts`'s component storage is module-scoped and eid-indexed with no
 *  per-State bank (spec Residue) — two `State`s allocating the same eid alias the same
 *  storage slot, so building this scratch state while another live `ecs` exists can corrupt
 *  it. `loadDocument` never calls this for exactly that reason (its geometry check runs
 *  in-place on the caller's own `ecs`, with an in-place rollback); this path is for a caller
 *  validating a candidate file in isolation — a one-shot CLI `validate` invocation, a bare
 *  unit test — with no other `State` around to alias. */
function buildScratchEcs(doc: Kex2dDocument): State {
    const ecs = new State();
    const trackEid = createTrack(ecs);
    restoreAll(ecs, docToTrackSnapshot(doc));
    Track.ds.set(trackEid, doc.track.ds);
    Track.domain.set(trackEid, doc.track.domain);
    Track.friction.set(trackEid, doc.track.friction);
    Track.resistance.set(trackEid, doc.track.resistance);
    return ecs;
}

/** the two guards that need a real (throwaway) ECS: strip overlap and the strip min-extent
 *  floor, both read off `track.ts`'s own exported predicates — the exact functions `setStrip`/
 *  `createStrip` check, not a doc-level reimplementation of the edge-range math. */
function checkGeometryInvariants(ecs: State): Refusal[] {
    const refusals: Refusal[] = [];
    for (const st of allStrips(ecs)) {
        if (stripOverlapped(ecs, st.start, st.end, st.id))
            refusals.push({
                guard: "stripOverlapped",
                message: `strip ${st.id} [${st.start}, ${st.end}) overlaps another velocity strip`,
            });
        else if (!stripCoversOneEdge(ecs, st.start, st.end))
            refusals.push({
                guard: "minExtentFloor",
                message: `strip ${st.id} [${st.start}, ${st.end}) covers no edge of the current bake`,
            });
    }
    return refusals;
}

/** the full document-boundary invariant check — every setter guard `restoreAll`'s spawn path
 *  bypasses, read against `doc` rather than any live `ecs`. Pass a `parseDocument`-produced
 *  document, get back every violated guard (empty when the document is fully valid —
 *  structurally AND semantically). **Not** the entry point `cli.ts`'s `validate` verb calls —
 *  that verb runs `loadDocument` on its own headless `State` (it needs the loaded, baked track
 *  for the force-limit check that follows), so its structural/semantic refusals come off
 *  `loadDocument`'s thrown `SemanticRefusalError.refusals`, not this function. This export is
 *  for a caller with no live `ecs` to load into and no other `State` concurrently live in the
 *  process (a bare unit test; `tests/invariants.test.ts`'s own oracle) — it builds its own
 *  throwaway scratch state (`buildScratchEcs`) for the geometry half. Skips the geometry pass
 *  when the doc-level pass already found something: a
 *  document with duplicate ids or a kind-mismatched section produces a meaningless or unsafe
 *  scratch ECS to build geometry checks against. */
export function checkDocumentSemantics(doc: Kex2dDocument): Refusal[] {
    const refusals = checkDocInvariants(doc);
    if (refusals.length > 0) return refusals;
    return checkGeometryInvariants(buildScratchEcs(doc));
}

/** forward-only migrations, keyed by the version they migrate FROM — `migrations[1]` (once it
 *  exists) takes a v1 raw doc and returns a v2 one. Empty today: `CURRENT_VERSION` is 1, so
 *  there is nothing to migrate from yet (segment-first authoring is the first expected bump,
 *  spec Locked decision) — the seam exists so that bump costs one function, not a rewrite. */
const migrations: Record<number, (doc: Record<string, unknown>) => Record<string, unknown>> = {};

/** walk a raw parsed object forward from its declared `version` to `CURRENT_VERSION`, one
 *  registered migration step at a time. Refuses (never guesses) a version this build doesn't
 *  recognize — newer than `CURRENT_VERSION`, or older than any registered migration can
 *  bridge — both are "unknown version" the spec's rejection-arm oracle checks for. */
function migrate(raw: Record<string, unknown>): Record<string, unknown> {
    if (!isInt(raw.version)) fail("version is missing or not an integer");
    let doc = raw;
    let v = raw.version as number;
    if (v > CURRENT_VERSION)
        fail(
            `version ${v} is newer than this build supports (max ${CURRENT_VERSION}) — update kex2d`,
        );
    while (v < CURRENT_VERSION) {
        const step = migrations[v];
        if (!step) fail(`version ${v} has no migration path to ${CURRENT_VERSION}`);
        doc = step(doc);
        if (!isInt(doc.version)) fail(`migration from version ${v} did not stamp a valid version`);
        v = doc.version as number;
    }
    return doc;
}

/** parse + migrate + validate `text` as a kex2d document. Never touches an ECS — the pure half
 *  of the load boundary, so a caller can validate a candidate file before deciding to load it.
 *  Throws (never returns a partial document) on invalid JSON, an unrecognized version, or any
 *  malformed/missing field — every throw carries a named remedy (`fail`, above). */
export function parseDocument(text: string): Kex2dDocument {
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch (e) {
        fail(`invalid JSON (${(e as Error).message})`);
    }
    if (!isPlainObject(raw)) fail("root is not a JSON object");
    return validateDocument(migrate(raw));
}

// ── the save/load boundary ───────────────────────────────────────────────────────────────

/** the whole live document, canonically serialized — `loadDocument(ecs, saveDocument(ecs))` is
 *  a no-op on the live ECS (the round-trip oracle). */
export function saveDocument(ecs: State): string {
    return serializeDocument(docFromEcs(ecs));
}

/** replace the live document with `text`'s — the document-boundary convention of every editor
 *  (spec Locked decision): parses + validates structurally first (throwing, touching nothing,
 *  on a structural or doc-shape semantic rejection), only then destroys/respawns the ECS state
 *  (`restoreAll`) and writes the four `Track` scalars `restoreAll` doesn't own. **The geometry
 *  half of semantic validation is the one exception**: it needs a real, in-place `ecs` to
 *  resolve a strip's edge range against (below), so the candidate loads BEFORE that guard runs
 *  and an in-place rollback (never a second `State` — the two-`State`-aliasing hazard, `AGENTS.md`
 *  Hard gotchas) restores the caller's live document on refusal — the live ECS is touched and
 *  then unwound, not left untouched throughout. Clears the undo stack on a landed load — a load
 *  is a new document, not an edit to undo past. Reserves every stable id the file used
 *  (`reserveIds`) so a `create*` call right after a load can't collide with one. */
export function loadDocument(ecs: State, text: string): void {
    const doc = parseDocument(text); // throws first; the live document is untouched until here

    // semantic invariants, doc-shape half (`checkDocInvariants`) — pure, no ECS touched, so this
    // throws exactly like a structural refusal above: nothing written, nothing to undo.
    const docRefusals = checkDocInvariants(doc);
    if (docRefusals.length > 0) failSemantics(docRefusals);

    const snap = docToTrackSnapshot(doc);

    // the geometry half (`stripOverlapped`/`stripCoversOneEdge`) needs a REAL ecs to resolve a
    // section's chord length against — but it must be run in-place on THIS `ecs`, never a
    // second `State`: `track.ts`'s component storage is module-scoped and eid-indexed with no
    // per-State bank (spec Residue), so a throwaway scratch state built while `ecs` is live can
    // silently alias and corrupt it the moment the two allocate an overlapping eid (measured:
    // building a second `State` here clobbered a live strip's `start`/`end` through exactly
    // this aliasing). So the candidate loads into `ecs` itself, geometry-checked there, and an
    // in-place rollback (never a second `State`) undoes it on refusal.
    const hadTrack = trackEntity(ecs) !== null;
    const rollbackSnap: TrackSnapshot = hadTrack
        ? snapshotAll(ecs)
        : { sections: [], strips: [], oneShot: [] };
    let trackEid = trackEntity(ecs);
    const rollbackScalars = trackEid === null ? null : readTrackScalars(trackEid);

    if (trackEid === null) trackEid = createTrack(ecs);
    // `createTrack`'s fresh entity already zeroes `count`; a REUSED entity carries the previous
    // document's bake-derived sample count until the next tick recomputes it — zero it here too,
    // so there's no window where `Track.count` describes a document that's no longer live.
    else Track.count.set(trackEid, 0);

    restoreAll(ecs, snap);
    Track.ds.set(trackEid, doc.track.ds);
    Track.domain.set(trackEid, doc.track.domain);
    Track.friction.set(trackEid, doc.track.friction);
    Track.resistance.set(trackEid, doc.track.resistance);

    const geomRefusals = checkGeometryInvariants(ecs);
    if (geomRefusals.length > 0) {
        restoreAll(ecs, rollbackSnap);
        if (hadTrack && rollbackScalars) {
            Track.ds.set(trackEid, rollbackScalars.ds);
            Track.domain.set(trackEid, rollbackScalars.domain);
            Track.friction.set(trackEid, rollbackScalars.friction);
            Track.resistance.set(trackEid, rollbackScalars.resistance);
            Track.count.set(trackEid, rollbackScalars.count);
        } else {
            ecs.destroy(trackEid);
        }
        failSemantics(geomRefusals);
    }

    reserveIds({
        section: doc.sections.map((s) => s.id),
        force: doc.sections.flatMap((s) => s.points.map((p) => p.id)),
        strip: doc.strips.map((st) => st.id),
        stripKeyframe: doc.strips.flatMap((st) => st.keyframes.map((k) => k.id)),
        oneShot: doc.oneShot.map((o) => o.id),
    });

    history.undo.length = 0;
    history.redo.length = 0;
}
