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
bun run check      # shallot check and svelte-check
bun run test       # every unit test, through the carrier
bun run test -- --integration --base <ref> --diff <ref>   # tests whose subject changed
bun run test -- --oracle "<claim>"   # one named oracle, never part of a sweep
bun run list       # what the same selectors would run
bun run workflow   # regenerate the hosted surface
```

## Tests

- The installed `shallot` bin is the runner. `test` and `list` go through `scripts/carrier.ts`, which adds one rule the pinned runner lacks: an integration selection that matches no test fails, so the tests selected by a changed subject never pass as an empty run. Delete the wrapper when the runner refuses an empty selection itself.
- Every `*.test.ts` and `*.oracle.ts` file is discovered by its name when the root `shallot.json` omits `check`. `.oracle.ts` files are named evidence and stay out of ordinary `test` and subject-selected integration sweeps; run one explicitly with `--oracle <claim>`.

## Shallot

The pinned Shallot is a full SHA in `package.json` and `bun.lock`. Local co-development is `bun link` in the engine and `bun link @dylanebert/shallot --no-save` here, never committed. Leaving it is a frozen install from an empty cache, with the manifest and lockfile byte-identical afterward. Short refs, moving refs, `link:` or `file:` paths and local packs are never committed. Every command uses the installed carrier, never a path into `node_modules` or a checkout. Vite dedupes Shallot and typegpu; `@dylanebert/shallot-grid` stays the registry plugin, and `vite.config.ts` excludes it from prebundling because a prebundled copy carries its own engine and never draws.
