import { mount, unmount } from "svelte";
import { pageSubject } from "./page-subject";
import App from "./App.svelte";
import "./app.css";

const target = document.getElementById("app");
if (!target) throw new Error("KexEdit mount point is missing");

let editor: ReturnType<typeof mount> | undefined = mount(App, { target });
if (pageSubject) {
    pageSubject.unmount = async () => {
        if (editor) await unmount(editor);
        editor = undefined;
    };
    pageSubject.mount = () => {
        if (editor) throw new Error("editor already mounted");
        editor = mount(App, { target });
    };
}
