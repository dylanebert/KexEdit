<script lang="ts">
import type { MenuItem } from "./menu";
import Menu from "./Menu.svelte"; // self-reference: a submenu is another Menu (Svelte 5 recursion)

// the shared menu renderer (root ui.md's one-language): a MenuItem[] drawn as rows in the
// `.menu` look — separators, submenus (a `▸` flyout), checks, shortcuts, disabled rows — so
// every menu (section context, node context, append flyout) is one instance of this, not a
// bespoke `{#each}`. the caller owns the root position; this owns the row + flyout rendering.
const { items, onclose }: { items: MenuItem[]; onclose?: () => void } = $props();

// the index of the row whose submenu is open (one at a time). hovering a submenu row opens
// its flyout; hovering a sibling leaf closes it (the standard menu hover model).
let open = $state<number | null>(null);
let subEl = $state<HTMLDivElement | undefined>(undefined);
let flipX = $state(false); // flip the flyout to the parent's LEFT when it would clip the right edge
let shiftY = $state(0); // nudge the flyout up when it would clip the bottom edge

// keep the flyout in the viewport (root ui.md "summoned panels fit the viewport"): measured
// once on open, so it never covers the parent row (it sits beside it) and never runs off-screen.
$effect(() => {
    if (open === null || !subEl) {
        flipX = false;
        shiftY = 0;
        return;
    }
    const r = subEl.getBoundingClientRect();
    flipX = r.right > window.innerWidth - 4;
    shiftY = r.bottom > window.innerHeight - 4 ? window.innerHeight - 4 - r.bottom : 0;
});

function enter(i: number, item: MenuItem): void {
    open = item.children ? i : null; // hovering a leaf sibling closes any open submenu
}
function leaf(item: MenuItem): void {
    item.action?.();
    onclose?.(); // a leaf action dismisses the whole menu (standard context-menu close)
}
</script>

{#each items as item, i (i)}
    {#if item.separator}
        <div class="menu-sep" role="separator"></div>
    {:else if item.children}
        <div class="menu-parent">
            <button
                type="button"
                class="menu-item"
                class:checked={item.checked}
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={open === i}
                onmouseenter={() => enter(i, item)}
                onclick={() => (open = i)}
            >
                <span>{item.label}</span>
                <span class="submark" aria-hidden="true">▸</span>
            </button>
            {#if open === i}
                <div
                    class="menu submenu"
                    class:flip-x={flipX}
                    style="margin-top: {shiftY}px"
                    bind:this={subEl}
                    role="menu"
                >
                    <Menu items={item.children} {onclose} />
                </div>
            {/if}
        </div>
    {:else}
        <button
            type="button"
            class="menu-item"
            class:checked={item.checked}
            class:danger={item.danger}
            role="menuitem"
            aria-label={item.aria}
            disabled={item.enabled === false}
            aria-disabled={item.enabled === false || undefined}
            onmouseenter={() => enter(i, item)}
            onclick={() => leaf(item)}
        >
            <span>{item.label}</span>
            {#if item.checked}<span class="tick" aria-hidden="true">✓</span>{/if}
            {#if item.shortcut}<span class="sk">{item.shortcut}</span>{/if}
        </button>
    {/if}
{/each}

<style>
    /* the submenu parent row + its flyout share a positioning context; the flyout sits beside
       the row (left:100%), flipping left / nudging up only to stay in the viewport. */
    .menu-parent {
        position: relative;
        display: flex;
        flex-direction: column;
    }
    .submark {
        font-size: 9px;
        color: var(--muted);
    }
    .submenu {
        position: absolute;
        left: 100%;
        top: -1px;
        margin-left: 3px;
        min-width: 128px;
        z-index: 1;
        animation: sub-in 100ms ease;
    }
    .submenu.flip-x {
        left: auto;
        right: 100%;
        margin-left: 0;
        margin-right: 3px;
    }
    @keyframes sub-in {
        from {
            opacity: 0;
        }
    }
    /* a group divider: a hairline in the border token, inset from the rows. */
    .menu-sep {
        height: 1px;
        margin: 3px 8px;
        background: var(--border);
    }
</style>
