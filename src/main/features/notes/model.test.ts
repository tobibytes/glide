import { describe, expect, it } from "vitest";
import { addNote, cycle, deleteNote, EMPTY_FILE, newNote, sanitize, searchNotes, summarize, titleOf, updateNote, type NotesFile } from "./model";

const mk = (id: string, body: string, t = 1) => ({ id, body, createdAt: t, updatedAt: t });
const file = (ids: string[], current: string | null): NotesFile => ({ notes: ids.map((id, i) => mk(id, id, i)), currentId: current });

describe("titles", () => {
  it("uses the first non-empty line without markdown markers", () => {
    expect(titleOf("\n\n# Groceries\n- milk")).toBe("Groceries");
    expect(titleOf("- [ ] call mom")).toBe("call mom");
    expect(titleOf("   ")).toBe("Untitled Note");
    expect(titleOf("x".repeat(80))).toHaveLength(61);
  });
  it("summarizes", () => {
    expect(summarize(mk("a", "Title\nline one\nline two"))).toMatchObject({ title: "Title", preview: "line one line two", chars: 23 });
  });
});

describe("list operations", () => {
  it("adds new notes on top and makes them current", () => {
    const f = addNote(EMPTY_FILE, newNote(5, "hi"));
    expect(f.notes).toHaveLength(1);
    expect(f.currentId).toBe(f.notes[0].id);
  });
  it("updates only changed bodies", () => {
    const f = file(["a", "b"], "a");
    const g = updateNote(f, "a", "new", 99);
    expect(g.notes[0]).toMatchObject({ body: "new", updatedAt: 99 });
    expect(updateNote(f, "a", "a", 99).notes[0].updatedAt).toBe(0);
  });
  it("moves the current note to a neighbour on delete", () => {
    expect(deleteNote(file(["a", "b", "c"], "b"), "b").currentId).toBe("c");
    expect(deleteNote(file(["a", "b", "c"], "c"), "c").currentId).toBe("b");
    expect(deleteNote(file(["a"], "a"), "a").currentId).toBeNull();
    expect(deleteNote(file(["a", "b"], "a"), "b").currentId).toBe("a");
  });
  it("cycles with wrap-around", () => {
    expect(cycle(file(["a", "b", "c"], "c"), 1)).toBe("a");
    expect(cycle(file(["a", "b", "c"], "a"), -1)).toBe("c");
    expect(cycle(EMPTY_FILE, 1)).toBeNull();
  });
});

describe("searchNotes", () => {
  const notes = [mk("1", "Groceries\nmilk eggs", 1), mk("2", "Meeting notes\nbuy milk later", 2), mk("3", "Ideas", 3)];
  it("returns most recent first for an empty query", () => {
    expect(searchNotes(notes, "").map((n) => n.id)).toEqual(["3", "2", "1"]);
  });
  it("requires every token and prefers title matches", () => {
    expect(searchNotes(notes, "milk").map((n) => n.id)).toEqual(["2", "1"]);
    expect(searchNotes(notes, "groc").map((n) => n.id)).toEqual(["1"]);
    expect(searchNotes(notes, "milk eggs").map((n) => n.id)).toEqual(["1"]);
  });
});

describe("sanitize", () => {
  it("drops junk and fixes the current id", () => {
    const f = sanitize({ notes: [{ id: "a", body: "x" }, { id: 3 }, null], currentId: "zz", bounds: { x: 1, y: 2, width: 3 } });
    expect(f.notes.map((n) => n.id)).toEqual(["a"]);
    expect(f.currentId).toBe("a");
    expect(f.bounds).toBeUndefined();
    expect(sanitize("nope")).toEqual(EMPTY_FILE);
  });
});
