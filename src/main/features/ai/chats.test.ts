import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatStore, deriveTitle, isChatId } from "./chats";

let dir: string;
let store: ChatStore;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "glide-ai-chats-"));
  store = new ChatStore(path.join(dir, "chats"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("ChatStore", () => {
  it("saves, lists, reads and deletes chats as <id>.json", () => {
    const saved = store.save({ id: "abc-1", messages: [{ role: "user", content: "How do I tar a folder?" }, { role: "assistant", content: "Use `tar -czf`." }] });
    expect(saved.title).toBe("How do I tar a folder?");
    expect(fs.existsSync(path.join(dir, "chats", "abc-1.json"))).toBe(true);
    expect(store.get("abc-1")?.messages).toHaveLength(2);
    const list = store.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: "abc-1", messageCount: 2, preview: "Use `tar -czf`." });
    expect(store.delete("abc-1")).toBe(true);
    expect(store.list()).toHaveLength(0);
    expect(store.get("abc-1")).toBeNull();
  });

  it("orders by most recently updated and keeps explicit titles", async () => {
    store.save({ id: "a", title: "First", messages: [{ role: "user", content: "1" }] });
    await new Promise((r) => setTimeout(r, 5));
    store.save({ id: "b", messages: [{ role: "user", content: "2" }] });
    expect(store.list().map((c) => c.id)).toEqual(["b", "a"]);
    expect(store.get("a")?.title).toBe("First");
  });

  it("drops malformed messages and refuses path traversal ids", () => {
    const saved = store.save({ id: "../../evil", messages: [{ role: "system", content: "x" }, { role: "user", content: 5 }, { role: "user", content: "ok" }] });
    expect(isChatId(saved.id)).toBe(true);
    expect(saved.id).not.toContain("..");
    expect(saved.messages).toEqual([{ role: "user", content: "ok", at: undefined, model: undefined }]);
    expect(store.get("../x")).toBeNull();
    expect(store.delete("../x")).toBe(false);
    expect(fs.readdirSync(dir)).toEqual(["chats"]);
  });

  it("ignores corrupt files", () => {
    fs.mkdirSync(path.join(dir, "chats"), { recursive: true });
    fs.writeFileSync(path.join(dir, "chats", "bad.json"), "{nope");
    expect(store.list()).toEqual([]);
  });
});

describe("deriveTitle", () => {
  it("truncates long first messages", () => {
    expect(deriveTitle([{ role: "user", content: "x".repeat(100) }]).length).toBe(58);
    expect(deriveTitle([])).toBe("New Chat");
  });
});
