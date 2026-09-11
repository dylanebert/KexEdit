# KexEdit

KexEdit is the MIT FVD coaster editor. The live S0 surface is an ejected Vite + Svelte app: Vite owns `index.html` and `vite.config.ts`, `projectPlugin(".")` turns `shallot.json` into the plugin set, and `vite` serves the app. The view pane owns the one plain canvas; `View.svelte` starts Shallot in its mount effect and disposes the app in cleanup. `window.__harness` is the browser-check protocol, not a second UI surface. There is no iframe; any future overlay is reserved for in-view HUD content.

## Test Surface

The carrier is native to this project. `test` runs the hermetic Svelte-compiler unit witness; `check` runs the manifest-authority surface check and `svelte-check`; `test:integration` selects the Chromium/GPU browser row by changed subject. Every check is listed once in the root `shallot.json` authority.

## Provisional S1 Look

The first looked-at pass was too busy, so the requested refinement removes persistent panel headers and speculative empty-state chrome. The shell keeps only the three pane surfaces, their quiet `#202830` separation, one canvas in the view, and the status line. The pane ground remains near-black `#0b0d10`, with the view as one blue-black lift, `#0e151b`; these are provisional and have not received human acceptance.

Sizing is responsive but bounded: the context pane is `clamp(16rem, 18vw, 24rem)`, the timeline is `clamp(12rem, 18vh, 18rem)`, and the view owns the remainder. At 2560×1440 those resolve to 24rem (384px) and 18vh (259.2px), with a 32px status line.

The viewport has no placeholder mesh. The GPU ground grid is the sole spatial referent: restrained neutral minor and major lines, a red X axis, and a blue Z axis. Unity-like axis semantics apply only on the XZ ground plane; there is no visible Y line. The scene retains Shallot's established standard lighting components, ambient `0xd0dcec` plus directional `-0.4 -1 -0.55`, `0xfff4e0`, intensity `1.1`, as structural scene defaults rather than visible acceptance evidence. Dark panels are accepted as the direction; grid visibility and axis distinction remain requested refinements, and overall S1 acceptance is still pending.

<!-- kex-test-surface
{"version":1,"status":"active","verdict":"executable population","authority":"shallot.json","native":{"test":"shallot test","check":"shallot check && svelte-check","changed":null}}
-->
