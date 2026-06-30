import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
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

// Mirror the harness's Playwright files to a fresh Windows TEMP dir so the host Chrome can run them,
// then install their deps there. `files` are relative to `srcDir`. Returns both path views — `win`
// for the PowerShell `cd`, `wsl` for reading screenshots back.
export function stageOnWindows(srcDir: string, name: string, files: string[]): WindowsPaths {
    const paths = windowsTempPaths(name);

    rmSync(paths.wsl, { recursive: true, force: true });
    mkdirSync(paths.wsl, { recursive: true });
    for (const file of files) {
        const dest = join(paths.wsl, file);
        mkdirSync(dirname(dest), { recursive: true });
        cpSync(join(srcDir, file), dest);
    }

    console.log("Installing Playwright dependencies on the Windows host...");
    Bun.spawnSync(
        [
            "powershell.exe",
            "-Command",
            `cd '${paths.win}'; bun install --silent; bunx playwright install chromium`,
        ],
        { stdout: "inherit", stderr: "inherit" },
    );

    return paths;
}
