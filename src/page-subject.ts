import type { App } from "@dylanebert/shallot";

/** The built-page subject owns explicit steps; ordinary pages retain the engine's rAF loop. */
export const pageSubject = typeof location !== "undefined" && new URLSearchParams(location.search).has("stepped")
    ? { app: undefined as App | undefined,
        mount: () => {}, unmount: async () => {},
        async step(dt: number) {
            if (!this.app) throw new Error("page subject has no mounted app");
            this.app.world.step(dt);
            await this.app.world.frameFence;
        },
        adapter() { return this.app?.world.gpu.adapter; },
    } : undefined;

declare global { interface Window { kexeditSubject?: NonNullable<typeof pageSubject> } }
if (pageSubject) window.kexeditSubject = pageSubject;
