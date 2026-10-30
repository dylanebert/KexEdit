# Contributing

For anyone changing KexEdit, person or agent. Each API's contract is the JSDoc beside it. This page holds what the tree, the CLI and a failing check do not say.

## Layout

KexEdit is a Vite and Svelte app using Shallot as a library. The project owns `index.html` and `vite.config.ts`; `View.svelte` imports the plugins it runs. The view pane owns the one canvas: `View.svelte` starts Shallot when it mounts and disposes the app when it unmounts. There is one canvas, one engine and no iframe.

`src/path/` is the one artifact every later layer produces or consumes. Its frame is Shallot's: right-handed, `-Z` forward, `+Y` up, `+X` right. A rotation is a unit quaternion stored `(x, y, z, w)`; roll is derived, never stored. Strides and WGSL structs come from the typegpu schemas, never typed by hand. Check physics against analytic fixtures or independent integration, not the march's own arithmetic.

Layout is view right, context panel left, timeline bottom, one reserved status line.

Chrome and canvas are not page content: no text selection, tap highlight, drag, long-press callout or keyboard focus. Passive chrome uses the default cursor. Editor bindings own keyboard access. Enabled text fields, including readonly fields, retain focus and selection; other copyable content, such as diagnostics, retains selection.

## Commands

```bash
bun run dev             # vite
bun run build           # vite build
bun run test            # cheap and headless GPU tiers
bun check               # TypeScript
bun run typecheck       # Svelte diagnostics
```

## Tests

- `bun run test` runs cheap and GPU checks using Shallot's testing timeouts
- Run cheap checks alone with `bun run test --path-ignore-patterns '**/*.gpu.test.ts'`, or Dawn checks with `bun test src/view.gpu.test.ts`; missing adapters fail rather than skip
- After `bunx playwright install chromium`, `bunx playwright test --workers=1` builds the page and checks stepped presentation, interaction and lifecycle
- `.github/workflows/test.yml` owns CI host setup and tier commands

## Shallot

`bun install --frozen-lockfile` reproduces the published dependencies in `package.json` and `bun.lock`. Links and packed tarballs are temporary local iteration tools, never committed dependencies. Vite runs the project's own config with `svelte()` and `shallot()`; do not add a second TypeGPU plugin or Shallot/typegpu-specific optimization or dedupe settings.
