import { run } from "@dylanebert/shallot";
import { ProfilePlugin } from "@dylanebert/shallot/extras";
import { mount, unmount } from "svelte";
import App from "./App.svelte";
import { CartPlugin } from "./cart";
import { history } from "./history";
import { RenderPlugin } from "./render";
import { targetDrift, targetsFor } from "./targets";
import { addNode, Handle, handleAt, Track, TrackPlugin, V0 } from "./track";

const { state: ecs, dispose } = await run({
    plugins: [ProfilePlugin, TrackPlugin, CartPlugin, RenderPlugin],
    defaults: false,
});

// DEV-only harness inspection hook: the capture flow's golden-path assertions read
// target/drift/undo state through this and induce drift with a raw node nudge (a
// bare geometry edit, the "later edit" that opens a gap). Never ships — kex2d is a
// `defaults:false` prototype with no production build path. See harness/shot.pw.ts.
if (import.meta.env.DEV) {
    let track = -1;
    for (const eid of ecs.query([Track])) {
        track = eid;
        break;
    }
    (window as unknown as { __kex: unknown }).__kex = {
        track,
        targets: () => targetsFor(ecs, track),
        drift: () => targetDrift(ecs, track),
        undoDepth: () => history.undo.length,
        nudge: (order: number, dy: number): void => {
            const eid = handleAt(ecs, order);
            if (eid !== null)
                Handle.pos.set(eid, Handle.pos.x.get(eid), Handle.pos.y.get(eid) + dy);
        },
        // lay the stage-1 airtime hill (scaled to V0, crest at order 3) so the flow
        // starts from the representable draft the dogfood scenario authors against.
        seedHill: (): void => {
            for (const eid of [...ecs.query([Handle])]) ecs.destroy(eid);
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
                addNode(ecs, x * s, y * s);
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
