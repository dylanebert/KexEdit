/// <reference types="vite/client" />

declare global {
    interface Window {
        __kexeditGridProbe?: () => Promise<{ samples: number; drawn: boolean }>;
    }
}

declare module "virtual:project" {
    import type { Plugin } from "@dylanebert/shallot";

    const project: {
        capacity: number | null;
        pixelRatio: number | "auto" | null;
        plugins: Plugin[];
        scene: string | null;
    };

    export default project;
}
