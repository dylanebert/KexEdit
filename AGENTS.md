# KexEdit

MIT Force Vector Design (FVD) coaster editor.

## Structure

- `packages/core/`: Rust physics, graph, `.kex` binary persistence and handle-based FFI. Layer order: sim → graph → nodes → track → persistence → ffi. Frontends never leak into core.
- `plugins/blender/`: Blender 4.2+ addon. `kexedit/` is the required addon package name; `ffi.py` mirrors core persistence and alone touches ctypes.
- `app/`: placeholder for the Shallot web editor, not implemented.
- `kex2d/`: Shallot + Svelte + canvas2D prototype. Canonical geo/force segment chain; section/run compatibility still feeds evaluation and some interactions. Read `kex2d/AGENTS.md` before working there. It is separate from the Rust/Blender implementation.

## Rules

Always read `.claude/rules/fidelity.md`: rider forces and track shape require physical accuracy, proven references and independent-model convergence. Other rules are selected by repo-root-relative paths, not cwd:

- `plugins/blender/**/*` → `.claude/rules/blender.md`
- `packages/core/**/*` → `.claude/rules/core.md`
- `**/*.svelte`, `kex2d/**/*.ts` → `.claude/rules/editor-ui.md`
- `kex2d/harness/**/*`, `kex2d/tests/harness.test.ts` → `.claude/rules/kex2d-harness.md`
- `kex2d/src/**/*`, `kex2d/tests/**/*` → `.claude/rules/kex2d-map.md`

Read matching rules explicitly outside Claude Code. Rule `paths:` frontmatter owns this index; keep both aligned. Public `CLAUDE.md` files import their adjacent entry.

## Build and verify

From this root:

```sh
plugins/blender/scripts/build_lib.sh
plugins/blender/scripts/build_lib.sh windows # mingw, Linux/WSL
plugins/blender/scripts/build_lib.sh all
cd packages/core && cargo test && cargo clippy
cd plugins/blender && uvx pytest tests/ -v
cd kex2d && bun run test && bun run check
```

The build script copies the library and core fixtures to ignored addon `lib/` and `fixtures/`; never commit those copies. `KEXEDIT_DEV_INSTALL=path1[:path2]` also rsyncs to local Blender extension installs. Restart Blender fully after replacing a Windows DLL.

In `kex2d`, run `bun run surface-budget` explicitly after instruction/process-check changes. It discovers instruction files and process checks, refuses growth, and lowers its baseline only on a passing reduction. It is not part of read-only `check`.
