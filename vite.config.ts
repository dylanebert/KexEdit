import { svelte } from "@sveltejs/vite-plugin-svelte";
import { shallot } from "@dylanebert/shallot/vite";
import { defineConfig } from "vite";

export default defineConfig({
    plugins: [svelte(), shallot()],
});
