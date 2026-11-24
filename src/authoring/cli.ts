import { tickAt } from "../trajectory/trajectory";
import { setKey } from "./commands";
import { isParameter, openRide, saveRide, solveRide } from "./document";

function numberArg(text: string, name: string): number {
    const value = Number(text);
    if (!text.trim() || !Number.isFinite(value)) throw new Error(`${name}: expected a finite number`);
    return value;
}

type Result = { stdout: string } | { evaluationError: string };

async function run([verb, file, ...args]: string[]): Promise<Result> {
    if (verb === "solve" && file && args.length === 0) {
        const source = openRide(await Bun.file(file).text());
        try {
            const { length, trajectory, refusal } = solveRide(source);
            if (refusal && (!Number.isFinite(refusal.need) || !Number.isFinite(refusal.have))) {
                const quantity = refusal.lane === "forces" ? refusal.quantity : "energy";
                throw new Error(`${quantity}: nonfinite refusal values (need ${refusal.need}, have ${refusal.have})`);
            }
            const { endReason, endTick } = trajectory.header;
            return { stdout: `${JSON.stringify({ length, endReason, endTick, endpoint: tickAt(trajectory, endTick),
                refusal: refusal ?? null })}\n` };
        } catch (error) {
            return { evaluationError: errorMessage(error) };
        }
    }
    if (verb === "set-key" && file && args.length === 5) {
        const [span, property, tick, value, ease] = args;
        if (!isParameter(property)) throw new Error("property: expected normal, lateral, roll, target or accel");
        if (ease !== "hold" && ease !== "linear") throw new Error("ease: expected hold or linear");
        const command = { span: numberArg(span, "span"), property,
            key: { tick: numberArg(tick, "tick"), value: numberArg(value, "value"), ease } } as const;
        const source = openRide(await Bun.file(file).text());
        return { stdout: saveRide(setKey(source, command).document) };
    }
    throw new Error(`usage:
  bun src/authoring/cli.ts solve FILE
  bun src/authoring/cli.ts set-key FILE SPAN_INDEX PROPERTY TICK VALUE EASE`);
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

try {
    const result = await run(Bun.argv.slice(2));
    if ("evaluationError" in result) {
        console.error(`evaluation error: ${result.evaluationError}`);
        process.exitCode = 2;
    } else {
        process.stdout.write(result.stdout);
    }
} catch (error) {
    console.error(errorMessage(error));
    process.exitCode = 1;
}
