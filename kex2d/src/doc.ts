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

import type { State } from "@dylanebert/shallot";
import { history } from "./history";
import { Domain } from "./section";
import type { Offset } from "./profile";
import type { Easing } from "./profile";
import type { Tangent } from "./spline";
import type { TangentMode } from "./spline";
import {
    createTrack,
    DS_NOMINAL,
    type ForceTangent,
    type NodeState,
    type OneShotSnapshot,
    reserveIds,
    restoreAll,
    type SectionSnapshot,
    SectionKind,
    type StripSnapshot,
    snapshotAll,
    Track,
    trackEntity,
    type TrackSnapshot,
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

function isFiniteNumber(v: unknown): v is number {
    return typeof v === "number" && Number.isFinite(v);
}

function isInt(v: unknown): v is number {
    return typeof v === "number" && Number.isInteger(v);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validateGeoTangent(v: unknown, path: string): DocGeoTangent | undefined {
    if (v === undefined) return undefined;
    if (!isPlainObject(v)) fail(`${path} is not an object`);
    if (!isInt(v.mode)) fail(`${path}.mode is missing or not an integer`);
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
    if (!isInt(v.mode)) fail(`${path}.mode is missing or not an integer`);
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
    if (!isInt(v.ease)) fail(`${path}.ease is missing or not an integer`);
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
    for (const k of ["ds", "domain", "friction", "resistance"] as const) {
        if (!isFiniteNumber(v[k])) fail(`track.${k} is missing or not a finite number`);
    }
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
 *  (spec Locked decision): parses + validates the WHOLE file first (throwing, touching
 *  nothing, on any rejection), only then destroys/respawns the ECS state
 *  (`restoreAll`) and writes the four `Track` scalars `restoreAll` doesn't own. Clears the
 *  undo stack — a load is a new document, not an edit to undo past. Reserves every stable id
 *  the file used (`reserveIds`) so a `create*` call right after a load can't collide with one. */
export function loadDocument(ecs: State, text: string): void {
    const doc = parseDocument(text); // throws first; the live document is untouched until here
    const snap = docToTrackSnapshot(doc);

    let trackEid = trackEntity(ecs);
    if (trackEid === null) trackEid = createTrack(ecs);

    restoreAll(ecs, snap);
    Track.ds.set(trackEid, doc.track.ds);
    Track.domain.set(trackEid, doc.track.domain);
    Track.friction.set(trackEid, doc.track.friction);
    Track.resistance.set(trackEid, doc.track.resistance);

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
