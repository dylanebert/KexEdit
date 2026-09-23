# Contributing

For anyone changing KexEdit, person or agent. Each API's contract is the JSDoc beside it. This page holds what the tree, the CLI and a failing check do not say.

## Layout

KexEdit is an ejected Vite and Svelte app on Shallot. Vite owns `index.html` and `vite.config.ts`; `projectPlugin(".")` turns `shallot.json` into the plugin set. The view pane owns the one canvas: `View.svelte` starts Shallot when it mounts and disposes the app when it unmounts. There is one canvas, one engine and no iframe.

`src/path/` is the one artifact every later layer produces or consumes. Its frame is Shallot's: right-handed, `-Z` forward, `+Y` up, `+X` right. A rotation is a unit quaternion stored `(x, y, z, w)`; roll is derived, never stored. Strides and WGSL structs come from the typegpu schemas, never typed by hand. Every check compares a record to its closed-form curve, not to the builder's arithmetic.

Layout is view right, context panel left, timeline bottom, one reserved status line.

## Commands

```bash
bun run dev        # vite
bun run build      # vite build
bun run check      # shallot test --list and svelte-check
bun run test       # every test
bun run list       # what the same selectors would run (`shallot test --list`)
```

## Tests

- The installed `shallot` bin is the runner; `test` and `list` call it directly.
- Every `*.test.ts` file is discovered by its name when the root `shallot.json` omits `check`. Every test is a unit test: its body fits the unit budget in one process.

## Shallot

The pinned Shallot is a full SHA in `package.json` and `bun.lock`. Local co-development is `bun link` in the engine and `bun link @dylanebert/shallot --no-save` here, never committed. Leaving it is a frozen install from an empty cache, with the manifest and lockfile byte-identical afterward. Short refs, moving refs, `link:` or `file:` paths and local packs are never committed. Every command uses the installed runner, never a path into `node_modules` or a checkout. Vite dedupes Shallot and typegpu; `@dylanebert/shallot-grid` stays pinned by full git SHA, and `vite.config.ts` excludes it from prebundling because a prebundled copy carries its own engine and never draws.
