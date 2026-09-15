const [command, ...args] = process.argv.slice(2);
if (command !== "list" && command !== "test") throw new Error(`unsupported carrier command: ${command ?? "missing"}`);

function run(argv: string[]): { status: number; output: string } {
    const result = Bun.spawnSync(["shallot", ...argv], { stdout: "pipe", stderr: "pipe" });
    const output = `${new TextDecoder().decode(result.stdout)}${new TextDecoder().decode(result.stderr)}`;
    return { status: result.exitCode ?? 1, output };
}

const integration = args.includes("--integration");
if (command === "test" && integration) {
    const selection = run(["list", ...args]);
    if (selection.status !== 0) {
        process.stdout.write(selection.output);
        process.exit(selection.status);
    }
    if (/^0 checks \(/m.test(selection.output)) {
        process.stdout.write(selection.output);
        console.error("KexEdit integration selection refused: no admitted row matches the selector");
        process.exit(1);
    }
}

const result = run([command, ...args]);
process.stdout.write(result.output);
if (command === "list" && integration && result.status === 0 && /^0 checks \(/m.test(result.output)) {
    console.error("KexEdit integration selection refused: no admitted row matches the selector");
    process.exit(1);
}
process.exit(result.status);
