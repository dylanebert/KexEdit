# Temporary adapter inventory

Every live `@temporary` adapter in `src/` has an exit class. This inventory is read by `tests/purity.test.ts`; adding a temporary symbol without a row fails the suite.

| Symbol | Exit class | Exit |
|---|---|---|
| `RunProjectionRow` | derived `@plumbing` evaluation projection | Retag as permanent evaluator plumbing after segment interaction no longer consumes run compatibility. |
| `RunProjectionRow.stations` | authored owner | Retain as the conserved run-local station frame; remove the adapter annotation when run projection retires. |
| `rebuildRunProjection` | derived `@plumbing` evaluation projection | Retag as evaluator plumbing or replace with the final segment-to-payload projection. |
| `runProjection` | retirement | Remove with section/run compatibility readers. |
| `SectionProjectionRow` | migration compatibility | Remove the legacy vocabulary alias. |
| `rebuildSectionProjection` | migration compatibility | Remove the section-named alias. |
| `Segment.run` | authored owner | Retain run partition identity until final payload partition ownership is named without the adapter vocabulary. |
| `Segment.runStation` | authored owner | Retain the conserved member entry station. |
| `Segment.runExtent` | authored owner | Retain the conserved force-run extent on the entry member. |
| `Segment.runEntryForce` | authored owner | Retain the constant-time address of the run-entry force boundary until the final boundary address replaces it. |
| `Segment.forceEndKey` | authored owner | Retain as the constant-time canonical terminating force-boundary address. |
| `Segment.geoEndNode` | authored owner | Retain the constant-time terminating geometry-node address until the final boundary address replaces it. |
| `Segment.velocityBoundary` | migration compatibility | Partial force-run-boundary address over retained span storage, not a total owner; retire when S4 interaction projects directly from spans and canonical boundaries. |
| `TrackStart.velocity` | migration compatibility | Retain the entry one-shot address through S4, then use the final track-start boundary surface. |
| `Section` | migration compatibility | Remove the alias after section-facing callers migrate. |
| `Handle.section` | migration compatibility | Remove the run-id mirror after section-facing readers migrate to canonical member/run addresses. |
| `Force.section` | migration compatibility | Retained by command/CLI force operations, conversion and pin readers, canvas projection, and clip-lane compatibility; S5/S6 migrate canvas/conversion/pin owners and S7 removes the alias after the remaining command and lane exits. |
| `Force.g` | migration compatibility | Remove the alias; `ForceBoundary.g` is the authored owner. |
| `Force.ease` | migration compatibility | Remove the alias; `ForceBoundary.ease` is the authored owner. |
| `Force.s` | migration compatibility | Force station mirror maintained by the run splice host; retire when every consumer reads the conserved member/run station frame. |
| `runInfo` | derived `@plumbing` evaluation projection | Retag as permanent bake metadata if still required after section readers retire. |
| `sections` | migration compatibility | Retained by command/CLI, conversion, pin, canvas, and clip-lane owners; S5 migrates canvas, S6 migrates conversion/pin, and S7 removes the residual command/lane adapter. |
| `sectionAt` | migration compatibility | Retained by command/CLI, conversion, pin, canvas, and clip-lane identity lookups; S5/S6 migrate those surface owners and S7 removes the residual adapter. |
| `spliceGeoMembers` | retirement | Remove the migration transaction once all geometry authoring operates on canonical members. |
| `spliceRunMembers` | retirement | Replace the migration transaction with final segment operations once force/velocity interaction migration completes. |
| `VelocityBoundary` | migration compatibility | Remove the partial-address adapter after S4 consumes it. |
| `StartVelocity` | migration compatibility | Remove the entry one-shot adapter after S4 consumes it. |
| `RunEntryForceBoundary` | migration compatibility | Remove when force readers use the final boundary owner directly. |
| `SectionSnapshot` | migration compatibility | Remove the legacy type alias. |
| `snapshotSection` | migration compatibility | Remove the legacy function alias. |
| `restoreSection` | migration compatibility | Remove the legacy function alias. |
| `Provenance.payload` | migration compatibility | Remove with the S6 conversion façade compatibility payload. |
