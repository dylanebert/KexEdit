#!/usr/bin/env bun
import { readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";

type Size = { bytes: number; maxParagraphChars: number };
export type Surface = {
    files: Record<string, Size>;
    totalBytes: number;
    processChecks: string[];
};
export type Baseline = Surface & { version: 1 };

/** Discover independently of the baseline, including untracked and nested instructions. */
export function readSurface(root: string): Surface {
    const files: Record<string, Size> = {};
    const processChecks: string[] = [];
    const directories = new Set<string>();
    const physicalFiles = new Set<string>();
    const base = realpathSync(root);
    function walk(dir: string): void {
        const physical = realpathSync(join(base, dir));
        if (relative(base, physical).split(/[\\/]/)[0] === "..")
            throw new Error(`external directory: ${dir}`);
        if (directories.has(physical)) return;
        directories.add(physical);
        for (const name of readdirSync(physical).sort()) {
            if (name === ".git" || name === "node_modules") continue;
            const path = join(dir, name).replaceAll("\\", "/");
            const absolute = join(base, path);
            const stat = statSync(absolute);
            if (stat.isDirectory()) {
                walk(path);
                continue;
            }
            if (!stat.isFile()) continue;
            const instruction =
                /^(?:AGENTS|CLAUDE|context)\.md$/.test(name) ||
                /(?:^|\/)\.claude\/(?:rules|commands|skills)\//.test(path) ||
                /(?:^|\/)layers\//.test(path);
            const check = /\.(?:test|tier|oracle)\.[cm]?[jt]s$/.test(name);
            if (!instruction && !check) continue;
            const real = realpathSync(absolute);
            if (physicalFiles.has(real)) continue;
            physicalFiles.add(real);
            const text = readFileSync(absolute, "utf8");
            if (instruction) {
                files[path] = {
                    bytes: Buffer.byteLength(text),
                    maxParagraphChars: Math.max(
                        0,
                        ...text
                            .replaceAll("\r\n", "\n")
                            .split(/\n\s*\n/)
                            .map((p) => p.length),
                    ),
                };
            }
            // Mixed harness.test.ts belongs here; unrelated product tests do not.
            if (
                check &&
                (/(?:^|\/)harness\//.test(path) ||
                    /^(?:harness|surface-budget|process)[.-]/.test(basename(path)) ||
                    /(?:from\s*|import\s*\(?\s*|require\s*\(\s*)["'][^"']*harness\//.test(text))
            )
                processChecks.push(path);
        }
    }
    walk("");
    return {
        files,
        totalBytes: Object.values(files).reduce((sum, file) => sum + file.bytes, 0),
        processChecks: processChecks.sort(),
    };
}

function baseline(text: string): Baseline {
    const value = JSON.parse(text) as Baseline;
    const size = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0;
    if (
        value.version !== 1 ||
        !value.files ||
        Array.isArray(value.files) ||
        typeof value.files !== "object" ||
        !size(value.totalBytes) ||
        !Array.isArray(value.processChecks) ||
        !value.processChecks.every((path) => typeof path === "string") ||
        new Set(value.processChecks).size !== value.processChecks.length ||
        !Object.values(value.files).every(
            (file) => file && size(file.bytes) && size(file.maxParagraphChars),
        )
    )
        throw new Error("invalid surface baseline");
    return value;
}

/** Missing/invalid baseline refuses; only a fully passing reduction can write. */
export function runSurfaceBudget(root: string, baselinePath: string): number {
    try {
        const previous = baseline(readFileSync(baselinePath, "utf8"));
        const current = readSurface(root);
        const failures: string[] = [];
        for (const [path, size] of Object.entries(current.files)) {
            const ceiling = previous.files[path];
            if (!ceiling) failures.push(`unlisted instruction: ${path}`);
            else {
                if (size.bytes > ceiling.bytes) failures.push(`file bytes: ${path}`);
                if (size.maxParagraphChars > ceiling.maxParagraphChars)
                    failures.push(`paragraph: ${path}`);
            }
        }
        if (current.totalBytes > previous.totalBytes) failures.push("total bytes");
        for (const path of current.processChecks) {
            if (!previous.processChecks.includes(path))
                failures.push(`unlisted process check: ${path}`);
        }
        console.log(
            `surface-budget: ${Object.keys(current.files).length} files, ${current.totalBytes} bytes, ${current.processChecks.length} process checks`,
        );
        if (failures.length) {
            for (const failure of failures) console.error(`[FAIL] ${failure}`);
            return 1;
        }
        const lowered: Baseline = { version: 1, ...current };
        const reduced =
            current.totalBytes < previous.totalBytes ||
            current.processChecks.length < previous.processChecks.length ||
            Object.entries(previous.files).some(([path, size]) => {
                const next = current.files[path];
                return (
                    !next ||
                    next.bytes < size.bytes ||
                    next.maxParagraphChars < size.maxParagraphChars
                );
            });
        if (reduced) {
            writeFileSync(baselinePath, `${JSON.stringify(lowered, null, 4)}\n`);
            console.log("surface-budget: baseline lowered");
        }
        return 0;
    } catch (error) {
        console.error(`surface-budget: ${error instanceof Error ? error.message : String(error)}`);
        return 1;
    }
}

if (import.meta.main) {
    const args = process.argv.slice(2);
    if (args.length !== 0 && (args.length !== 2 || args.some((arg) => arg.startsWith("-")))) {
        console.error("usage: bun surface-budget.ts [project-root baseline.json]");
        process.exit(1);
    }
    process.exit(
        runSurfaceBudget(
            resolve(args[0] ?? join(import.meta.dir, "../..")),
            resolve(args[1] ?? join(import.meta.dir, "surface-budget.json")),
        ),
    );
}
