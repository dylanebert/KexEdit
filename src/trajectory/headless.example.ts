import { evaluateRide } from "./ride";

// Run from the repository root: bun src/trajectory/headless.example.ts
// One second of authored straight, driven motion; no scene or fixture catalog.
const { ride, trajectory, refusal } = evaluateRide({
    length: 100,
    rate: 100,
    initial: { position: [0, 0, 0], rotation: [0, 0, 0, 1], speed: 2, distance: 0 },
    constants: { g: 9.81, heartToCom: -0.9, mass: 500, friction: 0.03, drag: 2e-5 },
    intents: Array.from({ length: 100 }, () => ({
        shape: { kind: "rates", omega: [0, 0, 0] },
        energy: { kind: "driven", target: 2, accel: 1 },
    })),
});
console.log(JSON.stringify({ endReason: trajectory.header.endReason,
    endTick: trajectory.header.endTick, pathPoses: ride.path().path.header.count,
    refusal: refusal ?? null }));
