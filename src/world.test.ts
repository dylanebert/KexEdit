import { GridPlugin } from "@dylanebert/shallot-grid";
import { OrbitPlugin } from "@dylanebert/shallot/extras";
import { expect, test } from "bun:test";
import { PathPlugin } from "./path/view";
import { editorWorld } from "./world";

test("both editor fixtures compose the published grid, orbit and integrated path plugins", () => {
    for (const stalled of [false, true]) {
        expect(editorWorld(stalled).dependencies).toEqual([PathPlugin, OrbitPlugin, GridPlugin]);
    }
});
