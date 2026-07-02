import { run } from "@dylanebert/shallot";
import { ProfilePlugin } from "@dylanebert/shallot/extras";
import { mount, unmount } from "svelte";
import App from "./App.svelte";
import { CartPlugin } from "./cart";
import { seedSolveDemo } from "./demo";
import { RenderPlugin } from "./render";
import { solveState } from "./solve";
import { samples, TrackPlugin } from "./track";

const { state: ecs, dispose } = await run({
    plugins: [ProfilePlugin, TrackPlugin, CartPlugin, RenderPlugin],
    defaults: false,
});

// `?demo=solve|losing` seeds the solver demo (the capture harness's entry);
// the window handle lets it assert on the live solve.
const demo = new URLSearchParams(window.location.search).get("demo");
if (demo === "solve" || demo === "losing") {
    seedSolveDemo(ecs, demo === "losing" ? "losing" : "valley");
    (window as unknown as Record<string, unknown>).__kexSolve = { solveState, samples };
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
