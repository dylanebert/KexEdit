import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import typegpu from "unplugin-typegpu/vite";

export default defineConfig({
    base: "./",
    // the linked shallot's TGSL kernels need the build-time transform; exactly one instance may run
    plugins: [typegpu(), svelte()],
    server: {
        port: 3000,
        fs: {
            // allow the bun-linked shallot dev copy two levels up.
            allow: [".", "../../shallot"],
        },
    },
    build: {
        target: "esnext",
        outDir: "dist",
        emptyOutDir: true,
    },
});
