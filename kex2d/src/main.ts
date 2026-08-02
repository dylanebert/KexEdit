import { run } from "@dylanebert/shallot";
import { ProfilePlugin } from "@dylanebert/shallot/extras";
import { mount, unmount } from "svelte";
import App from "./App.svelte";
import { cartArc, cartState, CartPlugin } from "./cart";
import { editor, sandbox, select, selectionHook } from "./editor";
import {
    appendSection,
    convertSection,
    createForce,
    history,
    removeSection,
    setSelectionHook,
} from "./history";
import { RenderPlugin } from "./render";
import { loadSnapSteps } from "./settings";
import { tangentHandles } from "./tangents";
import {
    addNode,
    bakeOut,
    createForcePoint,
    destroyForce,
    forceEase,
    forceMarkers,
    forceTangent,
    Handle,
    handleAt,
    handleTangent,
    lastHandle,
    samples,
    SectionKind,
    sectionForces,
    sectionHandles,
    sectionInfo,
    sections,
    setSectionLength,
    setTrackV0,
    Track,
    TrackPlugin,
    V0,
} from "./track";
import { camera, Canvas2D, snapGuides, viewTransform } from "./view";

const { state: ecs, dispose } = await run({
    plugins: [ProfilePlugin, TrackPlugin, CartPlugin, RenderPlugin],
    defaults: false,
});

// wire the editor's selection snapshot into the history stack (the injected hook — history stores the
// snapshot opaquely and never imports editor). undo restores each command's pre-selection, redo its post.
setSelectionHook(selectionHook);

// pull the persisted per-user preferences (the manipulator snap quanta) into their live singleton
// before anything reads them — a stored value only ever resolves through the clamps.
loadSnapSteps();

// DEV-only harness inspection hook: the capture flow's geo-authoring assertions read
// node/undo/track state through this and drive the real UI (extend, drag, undo).
// Never ships — kex2d is a `defaults:false` prototype with no production build path.
// See harness/flow.ts (the `Kex` mirror of this hook) and the `*.pw.ts` flows beside it.
if (import.meta.env.DEV) {
    let track = -1;
    for (const eid of ecs.query([Track])) {
        track = eid;
        break;
    }
    // the first (only, in the foundation) section — the surface the flow authors.
    const sec = (): number => sections(ecs)[0]?.id ?? 0;
    (window as unknown as { __kex: unknown }).__kex = {
        track,
        nodeCount: (): number => sectionHandles(ecs, sec()).length,
        undoDepth: (): number => history.undo.length,
        tTotal: (): number => bakeOut.get(track)?.tTotal ?? 0,
        // the whole viewport camera — `[zoom, ox, oy]`, view state, never authored, so it's
        // read-only like poses(). All three, not just the scale: one wheel tick writes the origin
        // too (`zoomAt` holds the world point under the cursor), so a scale-only read would call a
        // camera that shifted without rescaling unchanged. The wheel-guard flow asserts it comes
        // out identical across a mid-gesture wheel and moves under an idle one; the timeline's own
        // x view has a separate reader (`xView`), in Timeline.svelte where that state lives.
        cam: (): [number, number, number] => [camera.zoom, camera.ox, camera.oy],
        // `view.ts snapGuides` — and only that: whether the incline ray is being drawn, plus the two
        // readout labels a manipulator drag publishes (`dragReadout`, which `clearGuides` also resets,
        // belongs to handle drags and is not mirrored here). The ray is canvas-drawn and the labels
        // are one input to a readout that has other sources, so "no guide is on screen" has no honest
        // DOM assert — the blur-cancel flow asserts the ray IS up mid-drag and that the whole thing is
        // cleared by the cancel. Read-only, like cam()/poses().
        guides: (): { ray: boolean; angle: string | null; length: string | null } => ({
            ray: snapGuides.ray !== null,
            angle: snapGuides.angleLabel,
            length: snapGuides.lengthLabel,
        }),
        // the authored initial speed — the flow drives the real v0 popover and asserts it.
        v0: (): number => Track.v0.get(track),
        // author it directly, as test SETUP: the domain flow needs the ride off the default speed
        // (at exactly `V0` metres and seconds are proportional by one constant, so the two units
        // are indistinguishable), and the popover itself is already driven pointer-true by the v0
        // flow.
        setV0: (v: number): void => setTrackV0(track, v),
        // section-local pose signature — the flow asserts an undo reverts geometry.
        poses: (): number[][] =>
            sectionHandles(ecs, sec()).map((eid) => [
                Handle.pos.x.get(eid),
                Handle.pos.y.get(eid),
                Handle.theta.get(eid),
            ]),
        // select the chain end so the keyboard extend/trim (controls.ts) fire.
        selectEnd: (): void => select(lastHandle(ecs, sec())),
        // select an interior/end node by order — the tangent flow authors an explicit
        // tangent on an interior node (both in/out handles), which selectEnd (chain end,
        // one handle) can't reach. node 0 is reached through the START (`startAt` + a
        // double-click), not this order selector, so it's skipped here.
        selectNode: (order: number): void => {
            if (order === 0) return;
            const eid = handleAt(ecs, sec(), order);
            if (eid !== null) select(eid);
        },
        // the selected node's stored explicit tangent (mode + absolute local vectors), or
        // null when the node is Auto (the arc rule) — the flow asserts a summon flips it
        // explicit and a handle drag moves the authored vector. read-only, like poses().
        tangent: (): {
            mode: number;
            inX: number;
            inY: number;
            outX: number;
            outY: number;
        } | null => {
            const eid = editor.selection;
            if (eid === null) return null;
            const tan = handleTangent(ecs, Handle.section.get(eid), Handle.order.get(eid));
            return tan
                ? { mode: tan.mode, inX: tan.inX, inY: tan.inY, outX: tan.outX, outY: tan.outY }
                : null;
        },
        // the selected node's visible tangent handles in screen px (canvas-local). the
        // handles are canvas-drawn (render.ts), so they carry no DOM box — this is their
        // locator, the tangent analogue of the timeline's .fhit/.clip boxes. the flow adds
        // the canvas offset to reach page coords, then drives a real pointer drag.
        tangentHandles: (): { side: string; x: number; y: number }[] => {
            const eid = editor.selection;
            const s = samples.get(track);
            const canvas = Canvas2D.element;
            if (eid === null || !s || !canvas) return [];
            const tx = viewTransform(canvas);
            return tangentHandles(ecs, s, tx, eid).map((h) => ({ side: h.side, x: h.x, y: h.y }));
        },
        // whether a node is in tangent-edit mode (double-click summon) — the flow asserts the
        // double-click entered it before driving the dots submenu + handle drag. read-only.
        editing: (): boolean => editor.tangentEdit !== null,
        // the selected node's per-section order, or null — the START-handle flow asserts the
        // double-click at the START reached node 0 (order 0), the entry anchor.
        selectedOrder: (): number | null =>
            editor.selection === null ? null : Handle.order.get(editor.selection),
        // the whole selected node SET, by order (kex2d-multiselect stage 6) — `selectedOrder`
        // above is the ACTIVE member (the substrate's single-subject accessor); this is the
        // membership the marquee/shift-toggle/suffix-delete flows assert against. sorted for a
        // stable read (a JS Set's insertion order isn't what a flow wants to assert on); eids
        // don't survive a snapshot restore (`editor.ts`), so this reads through `Handle.order`,
        // not the raw eid, like the tangent/pose accessors above.
        nodeSelOrders: (): number[] =>
            [...editor.nodes.ids].map((eid) => Handle.order.get(eid)).sort((a, b) => a - b),
        // the START diamond's screen point (canvas-local px) — sample 0, the world origin the
        // first section's node 0 sits at. the START-handle flow double-/right-clicks here to reach
        // node 0's entry handle (nodeAt(0) is null by contract, so this is its locator).
        startAt: (): { x: number; y: number } | null => {
            const s = samples.get(track);
            const canvas = Canvas2D.element;
            if (!s || !canvas) return null;
            const tx = viewTransform(canvas);
            return { x: tx.ox + s.posX[0] * tx.sx, y: tx.oy + s.posY[0] * tx.sy };
        },
        // a node's screen point (canvas-local px) — where the flow double-clicks to enter
        // tangent edit. mirrors tangentHandles: canvas-drawn nodes carry no DOM box, so this is
        // their locator. node 0's locator is `startAt` (the coincident START diamond), so this
        // order selector skips it — the two locators stay separate.
        nodeAt: (order: number): { x: number; y: number } | null => {
            if (order === 0) return null;
            const eid = handleAt(ecs, sec(), order);
            const s = samples.get(track);
            const canvas = Canvas2D.element;
            if (eid === null || !s || !canvas) return null;
            const tx = viewTransform(canvas);
            const i = Handle.sample.get(eid);
            return { x: tx.ox + s.posX[i] * tx.sx, y: tx.oy + s.posY[i] * tx.sy };
        },
        // move a node in y — the "drag a node, the curve reacts" step, without pixels.
        // node 0's position is pinned at the local origin (the entry anchor never moves,
        // even though its tangent is now editable), so nudging it is a no-op.
        nudge: (order: number, dy: number): void => {
            if (order === 0) return;
            const eid = handleAt(ecs, sec(), order);
            if (eid !== null)
                Handle.pos.set(eid, Handle.pos.x.get(eid), Handle.pos.y.get(eid) + dy);
        },
        // lay a gentle airtime hill (scaled to V0) so the flow starts from a shaped
        // track rather than the flat seed. node 0 stays at the local origin.
        seedHill: (): void => {
            const id = sec();
            for (const eid of sectionHandles(ecs, id)) ecs.destroy(eid);
            const s = (V0 / 22) ** 2;
            for (const [x, y] of [
                [0, 0],
                [20, 0],
                [38, 7],
                [56, 11],
                [74, 7],
                [92, 0],
                [112, 0],
            ])
                addNode(ecs, id, x * s, y * s);
        },
        // lay TWO of those hills back to back — the shape the invoked-solve flow converts. the
        // single hill above solves in ~0.1 s, which is under one frame of modal: this one is a
        // second-scale solve, so the progress surface is really on screen and really climbing.
        seedTwinHill: (): void => {
            const id = sec();
            for (const eid of sectionHandles(ecs, id)) ecs.destroy(eid);
            const s = (V0 / 22) ** 2;
            const hill = [
                [0, 0],
                [20, 0],
                [38, 7],
                [56, 11],
                [74, 7],
                [92, 0],
                [112, 0],
            ];
            for (const [x, y] of [...hill, ...hill.slice(1).map(([x, y]) => [x + 112, y])])
                addNode(ecs, id, x * s, y * s);
        },
        // ── force-authoring hooks (stage C) ──
        kind: (): number => sections(ecs)[0]?.kind ?? SectionKind.Geo,
        forceCount: (): number => sectionForces(ecs, sec()).length,
        // the authored points, sorted by s — the flow asserts a dblclick create
        // resolves its g ON the profile (not at the cursor's y).
        forces: (): { s: number; g: number }[] =>
            sectionForces(ecs, sec()).map((p) => ({ s: p.s, g: p.g })),
        // a section span's mid-sample screen point (canvas-local px), by chain index — where
        // the pin flow pixel-probes the polyline for the out-of-scope dim (mirrors
        // startAt/nodeAt: the canvas-drawn track carries no DOM box). null pre-bake.
        spanMidAt: (i: number): { x: number; y: number } | null => {
            const s = samples.get(track);
            const canvas = Canvas2D.element;
            const secId = sections(ecs)[i]?.id;
            if (!s || !canvas || secId === undefined) return null;
            const info = sectionInfo.get(secId);
            if (!info) return null;
            const tx = viewTransform(canvas);
            const mid = (info.startSample + info.endSample) >> 1;
            return { x: tx.ox + s.posX[mid] * tx.sx, y: tx.oy + s.posY[mid] * tx.sy };
        },
        // a viewport force marker's canvas-local screen point, by index over `forceMarkers`'
        // own order (per-section, sorted by s) — where the marker flow clicks/right-clicks
        // (mirrors nodeAt: canvas-drawn markers carry no DOM box). null pre-bake or out of range.
        forceMarkerAt: (i: number): { x: number; y: number } | null => {
            const canvas = Canvas2D.element;
            if (!canvas) return null;
            const m = forceMarkers(ecs)[i];
            if (!m) return null;
            const tx = viewTransform(canvas);
            return { x: tx.ox + m.x * tx.sx, y: tx.oy + m.y * tx.sy };
        },
        // the stable id of the viewport marker under the pointer, or null (`editor.hoverForce`)
        // — the canvas hover has no honest DOM assert, so the flow reads the live field.
        // read-only, like cam()/guides().
        hoverForceId: (): number | null => editor.hoverForce,
        // the easing tag per point (sorted by s) — the menu flow asserts an Easing ▸ pick
        // flips the leading keyframe's tag.
        forceEases: (): number[] => sectionForces(ecs, sec()).map((p) => forceEase(ecs, p.id)),
        // whether a force keyframe is in handle-edit sub-mode — the flow asserts a
        // double-click summoned the handles.
        forceEditing: (): boolean => editor.forceEdit !== null,
        // whether an pin-mode session is open, and how many keys it holds locked — the
        // pin flow asserts the transactional exits (mode open/closed) and the lock
        // gesture's effect; the popup's badge/buttons are driven and read pointer-true by DOM.
        pinning: (): boolean => editor.pinning !== null,
        lockedCount: (): number => editor.locked.size,
        // the sandbox's undo depth, or null with no mode open — the pin flow asserts
        // in-mode edits land HERE while the outer depth stands still (the sandbox contract).
        sandboxDepth: (): number | null => sandbox()?.undo.length ?? null,
        // every section's baked entry (order-sorted) — the downstream-freeze assert reads the
        // section AFTER the pinning one and pins it byte-stable across an in-mode edit.
        entries: (): { x: number; y: number; theta: number; v: number }[] =>
            sections(ecs).map((s) => {
                const e = sectionInfo.get(s.id)?.entry;
                return e
                    ? { x: e.x, y: e.y, theta: e.theta, v: e.v }
                    : { x: 0, y: 0, theta: 0, v: 0 };
            }),
        // whether the paced landing animation is running — the pin flow asserts a landed
        // Solve raises it (the feedback) and that it settles closed.
        landing: (): boolean => editor.landing !== null,
        // which handle is selected within handle-edit ("in"/"out"/null) — the flow asserts a
        // click on a knob selects it (swapping the readout to the handle).
        forceHandleSel: (): string | null => editor.forceHandle,
        // the whole selected force keyframe SET, by stable id (kex2d-multiselect stage 6) —
        // `editor.forces.ids` already stores stable ids (not eids), so no re-resolution is
        // needed; sorted for a stable read, the set analog of `forceHandleSel`'s single subject.
        forceSelIds: (): number[] => [...editor.forces.ids].sort((a, b) => a - b),
        // the active force keyframe's stable id, or null — the set's single-subject accessor
        // (`editor.force`), added alongside `forceSelIds` since no scalar accessor read it before.
        forceSelActive: (): number | null => editor.force,
        // the explicit handle offsets per point (sorted by s), or null when derived from the
        // easing tag — the flow asserts a handle drag authored explicit handles and Reset
        // clears them.
        forceTangents: (): (null | {
            mode: number;
            inOn: boolean;
            inDs: number;
            inDg: number;
            outOn: boolean;
            outDs: number;
            outDg: number;
        })[] =>
            sectionForces(ecs, sec()).map((p) => {
                const t = forceTangent(ecs, p.id);
                // each side is independently optional (the segment-scoped Custom model): an
                // absent side reads 0 and its `*On` flag is false, so the flow can assert which
                // side actually carries an explicit handle.
                return t
                    ? {
                          mode: t.mode,
                          inOn: t.in !== undefined,
                          inDs: t.in?.ds ?? 0,
                          inDg: t.in?.dg ?? 0,
                          outOn: t.out !== undefined,
                          outDs: t.out?.ds ?? 0,
                          outDg: t.out?.dg ?? 0,
                      }
                    : null;
            }),
        // flip geo↔force on the section (destructive convert, one undo entry).
        convert: (): void => convertSection(history, ecs, sec()),
        // author a force point at (s, g) — the "place a point on the curve" step.
        placeForce: (s: number, g: number): number => createForce(history, ecs, sec(), s, g),
        // lay an airtime bump in force mode: dip below 1g mid-track, back to 1g.
        seedForceBump: (): void => {
            const id = sec();
            if ((sections(ecs)[0]?.kind ?? SectionKind.Geo) === SectionKind.Geo)
                convertSection(history, ecs, id);
            const len = sections(ecs)[0]?.length ?? 0;
            createForce(history, ecs, id, len * 0.2, 1);
            createForce(history, ecs, id, len * 0.5, 0); // airtime crest
            createForce(history, ecs, id, len * 0.8, 1);
        },
        // lay a force profile authored explicitly to make the force→geo FIT (not the geo→force
        // solve `seedForceBump` targets) take long enough for the capture harness to observe its
        // modal mid-flight: 8 alternating crests/troughs over 400 m (800 edges) at ±0.5 g — the
        // fit is one closed-form call, not a search, so widening the window needs an oscillating
        // profile over many edges (more split rounds, each an O(edges) scan), not a bigger single
        // hump. Two constraints on how far that can be pushed. It must stay **feasible** (hence
        // v0 = 30 and the modest amplitude): a profile that stalls the cart has no force fidelity
        // any node count can hold, so the fit saturates instead of converging — seconds become
        // tens of seconds and the landed section is one node per dense sample. And the fit's cost
        // climbs superlinearly with section length (the prune probes every interior removal each
        // round), so a longer section overshoots the window rather than widening it. The browser
        // worker runs this fit ~7× slower than bun, so both flow constraints read in browser
        // time: 1200 m measures ~1.9 s under bun (≈12 s in the worker) and lands 17 nodes —
        // slow enough for the cancel steps, inside the completion wait's 30 s. (The
        // absolute-arclength scoring collapsed the old 400 m seed to ~60 ms; a 2000 m retry
        // overshot the completion wait.)
        seedForceStress: (): void => {
            const id = sec();
            if ((sections(ecs)[0]?.kind ?? SectionKind.Geo) === SectionKind.Geo)
                convertSection(history, ecs, id);
            for (const p of sectionForces(ecs, id)) destroyForce(ecs, p.id);
            const len = 1200;
            const waves = 24;
            const amp = 0.8;
            setTrackV0(track, 35);
            setSectionLength(ecs, id, len);
            createForcePoint(ecs, id, 0, 1);
            for (let k = 1; k <= waves; k++) {
                const g = k % 2 === 0 ? 1 : k % 4 === 1 ? 1 + amp : 1 - amp;
                createForcePoint(ecs, id, (len / waves) * k, g);
            }
            createForcePoint(ecs, id, len, 1);
        },
        // ── multi-section hooks — the ops addressed by chain position ──
        sectionCount: (): number => sections(ecs).length,
        sectionKinds: (): number[] => sections(ecs).map((x) => x.kind),
        // ── section-editor reads — the capture flow drives the real clip/flyout/trim/
        // context-menu affordances and asserts the resulting state here. ──
        sectionIds: (): number[] => sections(ecs).map((x) => x.id),
        sectionLengths: (): number[] => sections(ecs).map((x) => x.length),
        // author a section's extent directly, as test SETUP (the real trim is a pointer drag on the
        // clip's right edge, already driven pointer-true by the clip-strip flow): the domain flow
        // needs a track the conversion CANNOT run on, and a force section run off the end of the
        // flat SoA is the one persistent such state.
        setLen: (i: number, len: number): void => {
            const s = sections(ecs)[i];
            if (s) setSectionLength(ecs, s.id, len);
        },
        // the per-section baking step (`Section.ds`, 0 = the track-nominal sentinel) — only an
        // invoked solve writes one, so the solve flow asserts the realized step landed with the
        // rest of the answer.
        sectionSteps: (): number[] => sections(ecs).map((x) => x.ds),
        sectionForceCounts: (): number[] =>
            sections(ecs).map((x) => sectionForces(ecs, x.id).length),
        selectedSection: (): number | null => editor.section,
        // the bake's own infeasibility signal (`bakeOut.feasible`/`firstInfeasible`) — the input
        // the dashed-red track pass and the warning banner both read: the first infeasible sample,
        // how many samples are infeasible track-wide, the stable id of the section that OWNS the first one
        // (the infeasible-shot flow asserts the selection accent lands on that same section), and
        // that section's feasible `head` — the samples before the red, which are exactly what the
        // accent has left to paint under it. a sample on a section boundary is shared, and this
        // resolves it to the UPSTREAM section — the exit-inclusive convention `toLocal` already
        // uses. read-only, like poses().
        infeasibleSpan: (): {
            first: number;
            count: number;
            section: number | null;
            head: number;
        } => {
            const out = bakeOut.get(track);
            if (!out) return { first: -1, count: 0, section: null, head: 0 };
            const n = Track.count.get(track);
            let count = 0;
            for (let i = 0; i < n; i++) if (out.feasible[i] === 0) count++;
            const first = out.firstInfeasible;
            let section: number | null = null;
            let head = 0;
            if (first >= 0)
                for (const s of sections(ecs)) {
                    const info = sectionInfo.get(s.id);
                    if (info && first >= info.startSample && first <= info.endSample) {
                        section = s.id;
                        head = first - info.startSample;
                        break;
                    }
                }
            return { first, count, section, head };
        },
        // the whole selected section SET, by stable id (kex2d-multiselect stage 6) — the
        // membership behind `selectedSection`'s active member; sorted for a stable read.
        sectionSelIds: (): number[] => [...editor.sections.ids].sort((a, b) => a - b),
        // the parked/parking playhead's arclength on the bake — the flow parks via a
        // real ruler scrub, drags a keyframe, and asserts this held under the re-time.
        cartArc: (): number | null => cartArc(track),
        parked: (): boolean => cartState.get(track)?.held ?? false,
        append: (kind: number): number => appendSection(history, ecs, kind as SectionKind),
        deleteAt: (i: number): boolean => {
            const s = sections(ecs)[i];
            return s ? removeSection(history, ecs, s.id) : false;
        },
        convertAt: (i: number): void => {
            const s = sections(ecs)[i];
            if (s) convertSection(history, ecs, s.id);
        },
    };
}

function onKey(e: KeyboardEvent): void {
    if (e.key === "F3") {
        e.preventDefault();
        document.body.toggleAttribute("data-shallot-debug");
    }
}
window.addEventListener("keydown", onKey);

const target = document.getElementById("app") as HTMLDivElement;
const app = mount(App, { target, props: { ecs } });

if (import.meta.hot) {
    import.meta.hot.dispose(() => {
        window.removeEventListener("keydown", onKey);
        unmount(app);
        dispose();
    });
}
