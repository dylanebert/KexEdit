import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";
import typegpu from "unplugin-typegpu/vite";
import { projectPlugin } from "@dylanebert/shallot/vite";

export default defineConfig({
    plugins: [svelte(), typegpu(), projectPlugin(".")],
    optimizeDeps: { exclude: ["@dylanebert/shallot", "typegpu"] },
});
