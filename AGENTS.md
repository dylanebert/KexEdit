# KexEdit

MIT Force Vector Design (FVD) coaster editor.

## Structure

- `packages/core/`: Rust physics, graph, `.kex` binary persistence and handle-based FFI. Layer order: sim → graph → nodes → track → persistence → ffi. Frontends never leak into core.
- `plugins/blender/`: Blender 4.2+ addon. `kexedit/` is the required addon package name; `ffi.py` mirrors core persistence and alone touches ctypes.
- `app/`: placeholder for the Shallot web editor, not implemented.
- `kex2d/`: Shallot + Svelte + canvas2D prototype. Independent velocity, force and geo lanes feed a derived run partition; read `kex2d/AGENTS.md` before working there. It is separate from the Rust/Blender implementation.

## Rules

Always read `.claude/rules/fidelity.md`: rider forces and track shape require physical accuracy, proven references and independent-model convergence. Other rules are selected by repo-root-relative paths, not cwd:

- `plugins/blender/**/*` → `.claude/rules/blender.md`
- `packages/core/**/*` → `.claude/rules/core.md`
- `**/*.svelte`, `kex2d/**/*.ts` → `.claude/rules/editor-ui.md`
- `kex2d/harness/**/*`, `kex2d/tests/harness.test.ts` → `.claude/rules/kex2d-harness.md`
- `kex2d/src/**/*`, `kex2d/tests/**/*` → `.claude/rules/kex2d-map.md`

Read matching rules explicitly outside Claude Code. Rule `paths:` frontmatter owns this index; keep both aligned. Public `CLAUDE.md` files import their adjacent entry.

## kex2d development

From `kex2d/`:

```sh
bunx shallot dev
bunx shallot build
```

Register the local engine package, then link it by name:

```sh
KEX_ROOT=/path/to/kex
cd "$KEX_ROOT/shallot/packages/shallot" && bun link
cd "$KEX_ROOT/kexedit/kex2d" && bun link @dylanebert/shallot --save
```

Only when TypeGPU resolves outside that checkout:

```sh
cd "$KEX_ROOT/shallot/node_modules/typegpu" && bun link
cd "$KEX_ROOT/kexedit/kex2d" && bun link typegpu --save
```

Check realpaths before changing a same-target link. In kex2d run `bun run test`, `bun run check` and `bun run surface-budget` serially after instruction or process-check changes.

## Other builds

Blender build scripts copy libraries and fixtures into ignored addon paths; core and addon tests remain owned by their package entry docs.
