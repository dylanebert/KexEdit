<script lang="ts">
import { flyoutFit, type MenuItem } from "./menu";
import Menu from "./Menu.svelte"; // self-reference: a submenu is another Menu (Svelte 5 recursion)

// the shared menu renderer (root ui.md's one-language): a MenuItem[] drawn as rows in the
// `.menu` look — separators, submenus (a `▸` flyout), checks, shortcuts, disabled rows — so
// every menu (section context, node context, append flyout) is one instance of this, not a
// bespoke `{#each}`. the caller owns the root position; this owns the row + flyout rendering.
const { items, onclose }: { items: MenuItem[]; onclose?: () => void } = $props();

// the index of the row whose submenu is open (one at a time). hovering a submenu row opens
// its flyout; hovering a sibling leaf closes it (the standard menu hover model).
let open = $state<number | null>(null);
let rowEls = $state<(HTMLButtonElement | undefined)[]>([]); // submenu-parent row refs, by index
let subEl = $state<HTMLDivElement | undefined>(undefined);
let flipX = $state(false); // flip the flyout to the parent's LEFT when the right side clips
let shiftY = $state(0); // vertical nudge to keep the flyout off the top / bottom edges
// the open parent row's top within the menu box. the flyout is hoisted OUT of the row (a sibling
// of the rows-wrapper) so the wrapper's overflow-clip can't swallow it, so it carries the row's
// offset itself. offsetTop and an absolute `top` share the offsetParent's padding box as origin,
// so `top: rowTop` lands the flyout beside its row with no border bookkeeping.
let rowTop = $state(0);

// keep the flyout in the viewport (root ui.md "summoned panels fit the viewport"): measured
// once on open from the parent row's rect + the flyout's own box (both flip-independent, so
// one pass settles), guarding all four edges via `flyoutFit`. It never covers the parent row
// (it sits beside it) and never runs off-screen.
$effect(() => {
    const row = open === null ? undefined : rowEls[open];
    if (!subEl || !row) {
        flipX = false;
        shiftY = 0;
        rowTop = 0;
        return;
    }
    rowTop = row.offsetTop - 1; // align the flyout's top border with the parent row (1px overlap)
    const p = row.getBoundingClientRect();
    const fit = flyoutFit(
        { left: p.left, right: p.right, top: p.top },
        { w: subEl.offsetWidth, h: subEl.offsetHeight },
        { w: window.innerWidth, h: window.innerHeight },
    );
    flipX = fit.flipX;
    shiftY = fit.shiftY;
});

function enter(i: number, item: MenuItem): void {
    open = item.children ? i : null; // hovering a leaf sibling closes any open submenu
}
function leaf(item: MenuItem): void {
    item.action?.();
    onclose?.(); // a leaf action dismisses the whole menu (standard context-menu close)
}
</script>

<!-- the rows live in an inner wrapper that owns the rounded-corner clip (its overflow:hidden
     trims each row's hover wash to the corners); the flyout is hoisted OUT of it below, a direct
     child of the outer `.menu`, so the clip can't swallow it. -->
<div class="menu-rows">
    {#each items as item, i (i)}
        {#if item.separator}
            <div class="menu-sep" role="separator"></div>
        {:else if item.children}
            <button
                type="button"
                class="menu-item"
                class:checked={item.checked}
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={open === i}
                disabled={item.enabled === false}
                aria-disabled={item.enabled === false || undefined}
                onmouseenter={() => item.enabled !== false && enter(i, item)}
                onclick={() => item.enabled !== false && (open = i)}
                bind:this={rowEls[i]}
            >
                <span>{item.label}</span>
                <span class="submark" aria-hidden="true">▸</span>
            </button>
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
                <span class="menu-lead">
                    {#if item.glyph}
                        <svg class="menu-glyph" viewBox="0 0 22 14" aria-hidden="true">
                            <path
                                d={item.glyph}
                                fill="none"
                                stroke="currentColor"
                                stroke-width="1.5"
                                stroke-linecap="round"
                                stroke-linejoin="round"
                            />
                        </svg>
                    {/if}
                    <span>{item.label}</span>
                </span>
                {#if item.checked}<span class="tick" aria-hidden="true">✓</span>{/if}
                {#if item.shortcut}<span class="sk">{item.shortcut}</span>{/if}
            </button>
        {/if}
    {/each}
</div>
{#each items as item, i (i)}
    {#if item.children && open === i}
        <div
            class="menu submenu"
            class:flip-x={flipX}
            style="top: {rowTop}px; margin-top: {shiftY}px"
            bind:this={subEl}
            role="menu"
        >
            <Menu items={item.children} {onclose} />
        </div>
    {/if}
{/each}

<style>
    /* the inner rows-wrapper owns the corner clip: overflow:hidden trims each row's hover wash to
       the menu's rounded corners. The submenu flyout is a SIBLING of this (a direct child of the
       outer `.menu`, which is `overflow: visible`), so the clip can't swallow it. radius is the
       outer 5px minus its 1px border, so the wash clips flush with the border's interior. */
    .menu-rows {
        display: flex;
        flex-direction: column;
        overflow: hidden;
        border-radius: 4px;
    }
    .submark {
        font-size: 9px;
        color: var(--muted);
    }
    /* the leading label group: an optional glyph beside the label, held together on the row's
       left while the tick / shortcut sit right (the `.menu-item` space-between). a row with no
       glyph renders just the label here, laid out identically to before. */
    .menu-lead {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
    }
    .menu-glyph {
        width: 22px;
        height: 14px;
        flex: none;
    }
    /* the flyout sits beside its parent row — to the RIGHT (left:100%) by default, flipping LEFT
       / nudging vertically only to stay in the viewport. It's hoisted out of the row, so `top`
       carries the row's own offset within the menu box to line up beside it. */
    .submenu {
        position: absolute;
        left: 100%;
        margin-left: 3px;
        min-width: 128px;
        z-index: 1;
        animation: sub-in 100ms var(--ease-out);
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
