# KexEdit

Roller coaster editor using Force Vector Design (FVD).

## Structure

- `packages/core/` — Rust crate. Physics simulation, node graph, binary format (.kex). Only runtime dep: `approx`
- `plugins/blender/` — Blender 4.2+ addon. `kexedit/` is the addon package (name required by Blender). Flat: ffi.py, types.py, coords.py (no bpy), operators.py, panels.py, properties.py, curve.py, fcurve.py (bpy). Loads core via handle-based FFI (`kex_load` → `kex_build` → `kex_output_read_*`). Python-side `.kex` serializer in `ffi.py` mirrors the format in `packages/core/src/persistence/`
- `app/` — placeholder for the Shallot-based web editor (not yet implemented)
- `kex2d/` — 2D coaster prototype (Shallot + Svelte + canvas2D). Sections-of-atoms track model: a chain of geo (author shape → recover force) and force (author F_n → integrate geometry) sections joined by anchor propagation, with structural ops (append/split/join/delete/convert). An optimization tier (invoked cross-kind conversion/fitting over the kernel atoms) is a future scope-first spike. Parallel to `app/`. Model + code map: `kex2d/AGENTS.md`

## Rules

`.claude/rules/` holds the per-area conventions, all path-scoped. Globs match the path from the repo root, not your cwd:

- `app/**/*` → `.claude/rules/app.md`
- `plugins/blender/**/*` → `.claude/rules/blender.md`
- `packages/core/**/*` → `.claude/rules/core.md`
- `**/*.svelte`, `**/*.css`, `app/**/*.ts`, `kex2d/**/*.ts` → `.claude/rules/editor-ui.md`
- `kex2d/harness/**/*`, `kex2d/tests/harness.test.ts` → `.claude/rules/kex2d-harness.md`
- `kex2d/src/**/*`, `kex2d/tests/**/*` → `.claude/rules/kex2d-map.md`

Read the ones whose globs match the files you're editing. Claude Code loads them for you on a matching read; other runtimes read them from this index. Each rule's `paths:` frontmatter is the source of truth — edit it first, then mirror it here, in order.

## Architecture

```
app (shallot + UI) → core (rust/wasm)
blender (python)   → core (rust/cdylib via FFI)
```

Core is the shared truth. Frontends never leak into core.

## Core Modules

sim → graph → nodes → track → persistence → ffi

sim is pure math (zero deps). Each layer only depends on layers to its left. FFI is feature-gated.

## Build

```bash
plugins/blender/scripts/build_lib.sh           # host platform
plugins/blender/scripts/build_lib.sh windows   # cross-compile DLL (mingw, runs from Linux/WSL)
plugins/blender/scripts/build_lib.sh all       # host + Windows
```

`build_lib.sh` builds the Rust crate and copies the artifact + `.kex` fixtures into `plugins/blender/kexedit/{lib,fixtures}/` (both gitignored — single source of truth lives in `packages/core/`).

Set `KEXEDIT_DEV_INSTALL=path1[:path2]` to also rsync the addon dir to a Blender extensions location after building. Useful for syncing into a Windows-side Blender from WSL where cross-filesystem symlinks don't behave.

## Verify

```bash
cd packages/core && cargo test
cd packages/core && cargo clippy
cd plugins/blender && uvx pytest tests/ -v
cd kex2d && bun check && bun test
cd kex2d && bun run capture   # Playwright UI screenshots → harness/shots/ (display-gated)
```
