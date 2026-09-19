# Archive

Retired KexEdit lines live in Git tags, not in the live tree. Each row names the last readable implementation and what, if anything, may return from it.

| Name | Tag | Path at tag | Retired because | What may return |
|---|---|---|---|---|
| Kex2D prototype | `retired/fresh-start` | `kex2d/` | The prototype accumulated editor and solver decisions that the 1.0 beta clean slate rejected as a product foundation. | Only a measured lesson named by the workspace strategy. Rebuild behavior from the current KexEdit contracts and referents; don't transplant the archived implementation. |
| Chromium integration rows | `retired/chromium-seat` | `src/boot.test.ts`, `src/transport.test.ts`, `src/browser.fixture.ts`, `src/harness.d.ts`, the Chromium rows in `src/path/view.test.ts` and `src/trajectory/train.test.ts`, the page-side handles in `src/View.svelte` and the fragment probe in `src/path/view.ts` | They required a Mac Chromium seat that never existed; each printed selected and exited green unrun, and Shallot retired the seat on 2026-09-19. | Browser pixel and DOM rows, once Shallot's device-seat item rebuilds a seat. Write them against that seat's contract; don't restore the archived harness. |
