import { beforeEach, expect, test } from "bun:test";
import {
    editor,
    enterForceEdit,
    enterTangentEdit,
    type Selection,
    select,
    selectForce,
    selectSection,
    selectStart,
    setMember,
    toggleMember,
} from "../src/editor";

// the selection substrate: a per-kind set + active member, single-select the size-1 case. these are
// pure editor-state tests — the select* APIs touch no ECS (only the SelectionHook does; its
// set-restore-across-recycle lives in history.test.ts). ids here are arbitrary numbers (the set
// stores eids/stable-ids opaquely). clear every kind before each so a leftover can't leak.
beforeEach(() => {
    select(null);
    selectForce(null);
    selectSection(null);
    selectStart(false);
});

// ── pure set helpers ──

test("toggleMember adds-and-activates, removes-and-promotes the most-recently-added survivor", () => {
    const sel: Selection = { ids: new Set(), active: null };
    toggleMember(sel, 1);
    expect([...sel.ids]).toEqual([1]);
    expect(sel.active).toBe(1);
    toggleMember(sel, 2);
    toggleMember(sel, 3);
    expect([...sel.ids]).toEqual([1, 2, 3]);
    expect(sel.active).toBe(3); // active follows the last toggled-in member
    toggleMember(sel, 1); // remove a non-active member — active unchanged
    expect([...sel.ids]).toEqual([2, 3]);
    expect(sel.active).toBe(3);
    toggleMember(sel, 3); // remove the active → promote the last survivor in insertion order
    expect([...sel.ids]).toEqual([2]);
    expect(sel.active).toBe(2);
    toggleMember(sel, 2); // remove the last member → active clears
    expect(sel.ids.size).toBe(0);
    expect(sel.active).toBeNull();
});

test("active promotion picks the last-inserted survivor, independent of what was removed", () => {
    const sel: Selection = { ids: new Set(), active: null };
    for (const id of [5, 6, 7]) toggleMember(sel, id); // active 7
    toggleMember(sel, 6); // remove an interior non-active member
    expect([...sel.ids]).toEqual([5, 7]);
    toggleMember(sel, 7); // remove the active → promote 5 (the sole survivor, last in order)
    expect(sel.active).toBe(5);
});

test("setMember replaces the set with one member, or clears it", () => {
    const sel: Selection = { ids: new Set([1, 2, 3]), active: 2 };
    setMember(sel, 9);
    expect([...sel.ids]).toEqual([9]);
    expect(sel.active).toBe(9);
    setMember(sel, null);
    expect(sel.ids.size).toBe(0);
    expect(sel.active).toBeNull();
});

// ── replace (single-select, the default) ──

test("replace select collapses the node kind to one active member", () => {
    select(10);
    expect([...editor.nodes.ids]).toEqual([10]);
    expect(editor.selection).toBe(10); // the scalar accessor reads the active member
    select(20);
    expect([...editor.nodes.ids]).toEqual([20]);
    expect(editor.selection).toBe(20);
    select(null);
    expect(editor.nodes.ids.size).toBe(0);
    expect(editor.selection).toBeNull();
});

test("the scalar setter is a replace-select", () => {
    editor.selection = 42;
    expect([...editor.nodes.ids]).toEqual([42]);
    expect(editor.nodes.active).toBe(42);
    editor.force = 7; // switches kinds
    expect(editor.nodes.ids.size).toBe(0);
    expect([...editor.forces.ids]).toEqual([7]);
});

// ── toggle (shift-click) ──

test("toggle builds a node set, active following the last toggled-in member", () => {
    select(10); // replace baseline
    select(20, "toggle");
    select(30, "toggle");
    expect([...editor.nodes.ids]).toEqual([10, 20, 30]);
    expect(editor.selection).toBe(30);
    select(20, "toggle"); // remove a non-active member
    expect([...editor.nodes.ids]).toEqual([10, 30]);
    expect(editor.selection).toBe(30);
    select(30, "toggle"); // remove the active → promote the survivor
    expect([...editor.nodes.ids]).toEqual([10]);
    expect(editor.selection).toBe(10);
});

test("toggling out the active with ≥2 survivors promotes the last-inserted one, not the oldest", () => {
    select(1); // {1}
    select(2, "toggle"); // {1,2}
    select(3, "toggle"); // {1,2,3}, active 3
    expect(editor.selection).toBe(3);
    select(3, "toggle"); // remove the active while TWO survivors {1,2} remain
    expect([...editor.nodes.ids]).toEqual([1, 2]);
    expect(editor.selection).toBe(2); // the last-inserted survivor — a regression to order 1 would pass every ≤1-survivor test
});

// ── kind exclusivity ──

test("selecting into one kind clears the others (a multi-member set included)", () => {
    select(10);
    select(11, "toggle"); // a two-node set
    selectForce(5); // switch to the force kind
    expect(editor.nodes.ids.size).toBe(0);
    expect(editor.selection).toBeNull();
    expect([...editor.forces.ids]).toEqual([5]);
    selectSection(3);
    expect(editor.forces.ids.size).toBe(0);
    expect([...editor.sections.ids]).toEqual([3]);
    selectStart(true);
    expect(editor.sections.ids.size).toBe(0);
    expect(editor.start).toBe(true);
    select(10);
    expect(editor.start).toBe(false);
});

test("toggling into a kind while another kind is active switches kinds", () => {
    selectForce(5);
    selectForce(6, "toggle"); // a two-point force set
    select(10, "toggle"); // shift-click a node with forces selected
    expect(editor.forces.ids.size).toBe(0);
    expect([...editor.nodes.ids]).toEqual([10]);
    expect(editor.selection).toBe(10);
});

// ── sub-mode collapse ──

test("entering tangent edit collapses a multi-node set to its subject", () => {
    select(10);
    select(20, "toggle");
    select(30, "toggle"); // a three-node set
    enterTangentEdit(20);
    expect([...editor.nodes.ids]).toEqual([20]);
    expect(editor.selection).toBe(20);
    expect(editor.tangentEdit).toBe(20);
});

test("growing the node set past the tangent-edit subject exits the sub-mode", () => {
    select(10);
    enterTangentEdit(10);
    expect(editor.tangentEdit).toBe(10);
    select(20, "toggle"); // the set grows to two → the single-subject sub-mode drops
    expect(editor.tangentEdit).toBeNull();
    expect([...editor.nodes.ids]).toEqual([10, 20]);
});

test("re-selecting the tangent-edit subject alone keeps the sub-mode", () => {
    select(10);
    enterTangentEdit(10);
    select(10); // replace-select the same sole node
    expect(editor.tangentEdit).toBe(10);
});

test("entering force handle-edit collapses a multi-point set to its subject", () => {
    selectForce(5);
    selectForce(6, "toggle");
    enterForceEdit(6);
    expect([...editor.forces.ids]).toEqual([6]);
    expect(editor.force).toBe(6);
    expect(editor.forceEdit).toBe(6);
});
