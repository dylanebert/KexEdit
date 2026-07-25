import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// WSL bridge: kex2d runs under WSL, but the shallot runtime needs WebGPU, which lives on the
// Windows-host Chrome (kex2d renders canvas2D, but `run()` still acquires a real device). A capture
// stages its self-contained Playwright files onto the host and runs them there. The fragile piece of
// the harness, isolated here — mirrors orrstead's harness and shallot's capture.

export const isWSL =
    process.platform === "linux" && existsSync("/proc/sys/fs/binfmt_misc/WSLInterop");

// Every host round-trip is time-bounded — provisioning sits outside Playwright's own timeouts and the
// caller's spawn ceiling, so an unresponsive host would otherwise hang the capture forever.
const PROBE_TIMEOUT_MS = 15_000;
const INSTALL_TIMEOUT_MS = 180_000;

/** true if a real-GPU display is reachable (WSL always is; bare Linux needs an X/Wayland display). */
export function detectDisplay(): boolean {
    if (isWSL) return true;
    if (process.platform !== "linux") return true;
    return !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

export interface WindowsPaths {
    win: string;
    wsl: string;
}

function probe(cmd: string[], what: string): string {
    const result = Bun.spawnSync(cmd, {
        stdout: "pipe",
        stderr: "inherit",
        timeout: PROBE_TIMEOUT_MS,
    });
    if (result.exitCode === null)
        throw new Error(
            `${what} did not answer within ${PROBE_TIMEOUT_MS}ms (\`${cmd[0]}\` killed)`,
        );
    if (result.exitCode !== 0) throw new Error(`${what} failed (exit ${result.exitCode})`);
    const out = new TextDecoder().decode(result.stdout).trim().replace(/\r/g, "");
    if (!out) throw new Error(`${what} returned nothing`);
    return out;
}

function windowsTempPaths(name: string): WindowsPaths {
    const winTemp = probe(
        ["powershell.exe", "-Command", "Write-Host -NoNewline $env:TEMP"],
        "Windows TEMP probe",
    );
    const wslTemp = probe(["wslpath", winTemp], `wslpath of ${winTemp}`);
    return { win: `${winTemp}\\${name}`, wsl: join(wslTemp, name) };
}

export interface Stage {
    /** persistent Windows TEMP dir name — its `node_modules` survives between runs */
    name: string;
    /**
     * files (relative to `srcDir`) mirrored to the host every run — the `package.json` is required
     * (it carries the Playwright pin), and staging the `bun.lock` beside it is what lets the host
     * install `--frozen-lockfile` instead of re-resolving the ranges
     */
    files: string[];
    /** dirs (relative to the stage) wiped every run, so a run never reads the previous run's output */
    clean?: string[];
}

/** marker file holding the dependency key the stage's `node_modules` was provisioned for */
const MARKER = ".provisioned";

function readJson(path: string, what: string): Record<string, unknown> {
    let text: string;
    try {
        text = readFileSync(path, "utf8");
    } catch (e) {
        throw new Error(`${what} is unreadable (${path}): ${e instanceof Error ? e.message : e}`);
    }
    try {
        return JSON.parse(text) as Record<string, unknown>;
    } catch (e) {
        throw new Error(
            `${what} is not valid JSON (${path}): ${e instanceof Error ? e.message : e}`,
        );
    }
}

/** every `package.json` block that changes what an install produces */
const DEP_BLOCKS = [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
    "overrides",
    "trustedDependencies",
] as const;

/** object keys sorted at every depth, so a reordered block is the same key */
function normalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === "object")
        return Object.keys(value as Record<string, unknown>)
            .sort()
            .map((k) => [k, normalize((value as Record<string, unknown>)[k])]);
    return value ?? null;
}

/**
 * The provisioning key a staged install asks for, plus the Playwright range it declares.
 *
 * Keyed on every dependency-relevant block of the staged `package.json` PLUS the staged lockfile
 * text, never on one package's installed version: an installed version satisfies a caret range
 * forever, so a version key would never reinstall after a dependency edit — and the ranges alone
 * miss a transitive bump that only the lock records.
 */
export function provisionKey(
    pkg: Record<string, unknown>,
    lock: string,
): { key: string; pin: string } {
    const deps = (pkg.dependencies ?? {}) as Record<string, string>;
    const pin = deps["@playwright/test"];
    if (!pin) throw new Error("staged package.json declares no @playwright/test dependency");
    const blocks = DEP_BLOCKS.map((block) => [block, normalize(pkg[block] ?? null)]);
    return { key: Bun.hash(JSON.stringify([blocks, lock])).toString(16), pin };
}

/**
 * Whether the host stage can be reused as-is: its marker records THIS key AND the install it claims
 * is really on disk. A torn install can't reach here — the marker is deleted before the install and
 * written only after the result is verified — so the `treeExists` half covers what the ordering
 * can't see: a `node_modules` deleted (or a stage dir emptied) out from under a valid marker.
 */
export function provisioned(marker: string | null, key: string, treeExists: boolean): boolean {
    return marker !== null && marker.trim() === key && treeExists;
}

function installedVersion(pkgJson: string): string | null {
    if (!existsSync(pkgJson)) return null;
    try {
        return (JSON.parse(readFileSync(pkgJson, "utf8")).version as string | undefined) ?? null;
    } catch {
        return null;
    }
}

// Mirror the harness's Playwright files into a PERSISTENT Windows TEMP dir so the host Chrome can run
// them, provisioning deps there only when the staged dependency blocks or the staged lockfile change.
// The install is the cold-run cliff (tens of seconds) and buys nothing while `node_modules` matches,
// so it is keyed by a marker file written ONLY after a clean install — a torn or failed install
// leaves no marker, so the next run reinstalls. shallot's `scripts/wsl-bridge.ts provisionHost` is
// the precedent.
//
// No browser download: the capture config launches `channel: "chrome"`, the host's own Chrome, never a
// Playwright-managed chromium. If a config here ever launches bundled chromium (or a non-Chrome
// browser), provisioning must add `bunx playwright install <browser>` back behind this same marker.
//
// Note: a spawn-ceiling kill (`playwright.ts` timeout) kills only the powershell child WSL-side —
// Windows-side grandchildren (bun, node, chrome) can survive holding this dir open, so the next run's
// `clean` can hit EBUSY. That needs manual host cleanup (end the stray processes); there is no job
// object across the WSL boundary.
export function stageOnWindows(srcDir: string, stage: Stage): WindowsPaths {
    const paths = windowsTempPaths(stage.name);

    mkdirSync(paths.wsl, { recursive: true });
    for (const dir of stage.clean ?? [])
        rmSync(join(paths.wsl, dir), { recursive: true, force: true });
    for (const file of stage.files) {
        const dest = join(paths.wsl, file);
        mkdirSync(dirname(dest), { recursive: true });
        cpSync(join(srcDir, file), dest);
    }

    // The staged lock is part of the key AND the install's input: with it, the host reproduces this
    // checkout's tree exactly instead of re-resolving the declared ranges into whatever is newest.
    const stagedLock = join(paths.wsl, "bun.lock");
    const lock = existsSync(stagedLock) ? readFileSync(stagedLock, "utf8") : "";
    const { key, pin } = provisionKey(
        readJson(join(paths.wsl, "package.json"), "staged package.json"),
        lock,
    );
    const marker = join(paths.wsl, MARKER);
    const tree = join(paths.wsl, "node_modules/@playwright/test/package.json");
    if (
        provisioned(existsSync(marker) ? readFileSync(marker, "utf8") : null, key, existsSync(tree))
    ) {
        console.log(`Windows host provisioned (deps ${key}); skipping install.`);
        return paths;
    }

    console.log(`Installing host deps (key ${key}, @playwright/test ${pin})...`);
    rmSync(marker, { force: true });
    const install = Bun.spawnSync(
        [
            "powershell.exe",
            "-Command",
            `$ErrorActionPreference = 'Stop'; cd '${paths.win}'; bun install${lock ? " --frozen-lockfile" : ""}`,
        ],
        { stdout: "inherit", stderr: "pipe", timeout: INSTALL_TIMEOUT_MS },
    );
    const stderr = new TextDecoder().decode(install.stderr ?? new Uint8Array()).trim();
    if (install.exitCode === null)
        throw new Error(`host \`bun install\` did not finish within ${INSTALL_TIMEOUT_MS}ms`);
    if (install.exitCode !== 0)
        throw new Error(`host \`bun install\` failed (exit ${install.exitCode}): ${stderr}`);

    const now = installedVersion(join(paths.wsl, "node_modules/@playwright/test/package.json"));
    if (!now || !Bun.semver.satisfies(now, pin))
        throw new Error(
            `host provisioning failed: @playwright/test ${now ?? "missing"} does not satisfy ${pin}${
                stderr ? ` — ${stderr}` : ""
            }`,
        );

    writeFileSync(marker, `${key}\n`);
    return paths;
}
