# KexEdit

KexEdit is the MIT FVD coaster editor. This `1.0-beta` line starts with the document layer (layer 1 of `strategy/kexedit.md`): named channels of animation curves over integer ticks, saved as canonical JSON. `src/document/` holds it.

## Test Surface

Declarations live in `shallot.json`; an undeclared `*.test.ts` refuses at load. Commands, from this root:

- `bun run test`: hermetic unit checks.
- `bun run check`: `tsc`, `biome`, and `shallot check` (population and workflow drift).
- `bun run list`: the declared population.
- `bun run test:integration -- --base <base> --diff <head>`: declared integration rows selected by subject.
- `bun run workflow`: regenerates `.github/workflows/test-surface.yml`; never edit it by hand.
