import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

// WSL bridge: kex2d runs under WSL, but the shallot runtime needs WebGPU, which lives on the
// Windows-host Chrome (kex2d renders canvas2D, but `run()` still acquires a real device). A capture
// stages its self-contained Playwright files onto the host and runs them there. The fragile piece of
// the harness, isolated here — mirrors orrstead's harness and shallot's capture.

export const isWSL =
    process.platform === "linux" && existsSync("/proc/sys/fs/binfmt_misc/WSLInterop");

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

function windowsTempPaths(name: string): WindowsPaths {
    const winTemp = new TextDecoder()
        .decode(
            Bun.spawnSync(["powershell.exe", "-Command", "Write-Host -NoNewline $env:TEMP"], {
                stdout: "pipe",
            }).stdout,
        )
        .trim()
        .replace(/\r/g, "");
    const wslTemp = new TextDecoder()
        .decode(Bun.spawnSync(["wslpath", winTemp], { stdout: "pipe" }).stdout)
        .trim();
    return { win: `${winTemp}\\${name}`, wsl: join(wslTemp, name) };
}

export interface Stage {
    /** persistent Windows TEMP dir name — its `node_modules` survives between runs */
    name: string;
    /** files (relative to `srcDir`) mirrored to the host every run */
    files: string[];
    /** dirs (relative to the stage) wiped every run, so a run never reads the previous run's output */
    clean?: string[];
}

function version(pkgJson: string): string | null {
    if (!existsSync(pkgJson)) return null;
    return JSON.parse(readFileSync(pkgJson, "utf8")).version ?? null;
}

// Mirror the harness's Playwright files into a PERSISTENT Windows TEMP dir so the host Chrome can run
// them, provisioning deps there only when the installed Playwright stops satisfying the harness's pin.
// The install is the cold-run cliff (tens of seconds) and buys nothing while `node_modules` matches, so
// it is version-keyed — shallot's `scripts/wsl-bridge.ts provisionHost` is the precedent. No browser
// download: the capture config launches `channel: "chrome"`, the host's own Chrome, not a Playwright
// chromium. Returns both path views — `win` for the PowerShell `cd`, `wsl` for reading screenshots back.
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

    const pin = JSON.parse(readFileSync(join(paths.wsl, "package.json"), "utf8")).dependencies?.[
        "@playwright/test"
    ];
    if (!pin) throw new Error("staged package.json declares no @playwright/test dependency");
    const installed = version(join(paths.wsl, "node_modules/@playwright/test/package.json"));

    if (installed && Bun.semver.satisfies(installed, pin)) {
        console.log(`Windows host provisioned: @playwright/test ${installed} satisfies ${pin}.`);
        return paths;
    }

    console.log(
        `Installing @playwright/test ${pin} on the Windows host (found: ${installed ?? "none"})...`,
    );
    Bun.spawnSync(["powershell.exe", "-Command", `cd '${paths.win}'; bun install --silent`], {
        stdout: "inherit",
        stderr: "inherit",
    });
    const now = version(join(paths.wsl, "node_modules/@playwright/test/package.json"));
    if (!now || !Bun.semver.satisfies(now, pin))
        throw new Error(
            `host provisioning failed: @playwright/test ${now ?? "missing"} does not satisfy ${pin}`,
        );

    return paths;
}
