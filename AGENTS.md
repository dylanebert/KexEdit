# KexEdit

KexEdit is the MIT FVD coaster editor. The live S0 surface is an ejected Vite + Svelte app: Vite owns `index.html` and `vite.config.ts`, `projectPlugin(".")` turns `shallot.json` into the plugin set, and `vite` serves the app. The view pane owns the one plain canvas; `View.svelte` starts Shallot in its mount effect and disposes the app in cleanup. `window.__harness` is the browser-check protocol, not a second UI surface. There is no iframe; any future overlay is reserved for in-view HUD content.

## Test Surface

The carrier is native to this project. `test` runs the hermetic Svelte-compiler unit witness; `check` runs the manifest-authority surface check and `svelte-check`; `test:integration` selects the Chromium/GPU browser row by changed subject. Every check is listed once in the root `shallot.json` authority.

<!-- kex-test-surface
{"version":1,"status":"active","verdict":"executable population","authority":"shallot.json","native":{"test":"shallot test","check":"shallot check && svelte-check","changed":null}}
-->
