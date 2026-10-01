# Contributing

For anyone changing KexEdit, person or agent. Each API's contract is the JSDoc beside it. This page holds what the tree, the CLI and a failing check do not say.

## Layout

KexEdit is a Vite and Svelte app using Shallot as a library. The project owns `index.html` and `vite.config.ts`; `View.svelte` imports the plugins it runs. The view pane owns the one canvas: `View.svelte` starts Shallot when it mounts and disposes the app when it unmounts. There is one canvas, one engine and no iframe.

`src/path/` is the one artifact every later layer produces or consumes. Its frame is Shallot's: right-handed, `-Z` forward, `+Y` up, `+X` right. A rotation is a unit quaternion stored `(x, y, z, w)`; roll is derived, never stored. Strides and WGSL structs come from the typegpu schemas, never typed by hand. Every check compares a record to its closed-form curve, not to the builder's arithmetic.

Layout is view right, context panel left, timeline bottom, one reserved status line.

## Commands

```bash
bun run dev        # vite
bun run build      # vite build
bun run test       # Bun's cheap test tier
bun run check      # tests and svelte-check
```

## Tests

- `bun test --timeout=250` discovers the cheap tier by `*.test.ts` filenames. Each `test()` name is the failure claim; explicit per-test timeouts preserve smaller budgets.
- All current checks are in this tier. There are no browser (`*.e2e.ts`) or named GPU, Node or oracle tiers.

## Shallot

The registry ranges are Shallot `^0.10.0-next.1` (locked to `0.10.0-next.1`) and `@dylanebert/shallot-grid` `^0.2.0-next.1` (locked to `0.2.0-next.1`). Released: `bun install` resolves these registry pins. Staged: run `bun pm pack` in either package's repo, then `bun add --no-save <tarball>` here. Live: run `bun link` in a package repo, then `bun link @dylanebert/shallot` or `bun link @dylanebert/shallot-grid` here. `bun install` restores the registry pins when they resolve. Vite runs the project's own config with `svelte()` and `shallot()`; do not add a second TypeGPU plugin or Shallot/typegpu-specific optimization or dedupe settings.
