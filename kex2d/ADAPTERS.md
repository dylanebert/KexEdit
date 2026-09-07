# Temporary adapter inventory

Every live `@temporary` adapter in `src/` has an exit class. This inventory is read by
`tests/purity.test.ts`, in both directions: a temporary symbol without a row fails the suite, and
a row naming a symbol no source file tags fails it too.

**The inventory is empty.** S2e-i cut the store over to lanes, and every symbol that carried a
`@temporary` tag was an adapter over the retired node/force-point/strip substrate — the v3
`segments`/`strips` wire columns, the run-projection rows and their aliases, the boundary
address mirrors, the section-named compatibility readers. Each left with the thing it adapted,
so the exit column has no rows left to hold.

| Symbol | Exit class | Exit |
|---|---|---|
