import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AiError, buildParams, describeError, streamAnswer, SYSTEM_PROMPT, toApiMessages } from "./client";

describe("buildParams", () => {
  it("caches the frozen system prompt and the conversation, with fallbacks on Opus", () => {
    const p = buildParams({ model: "claude-opus-5-5", effort: "medium", messages: [{ role: "user", content: "hi" }], system: "Be terse." });
    const system = p.system as Array<{ text: string; cache_control?: unknown }>;
    expect(system[0].text).toBe(SYSTEM_PROMPT);
    expect(system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(system[1]).toEqual({ type: "text", text: "Be terse." });
    expect(p.cache_control).toEqual({ type: "ephemeral" });
    expect(p.output_config).toEqual({ effort: "medium" });
    expect(p.fallbacks).toBe("default");
    expect(p.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect(p).not.toHaveProperty("thinking");
    expect(p).not.toHaveProperty("temperature");
  });
  it("omits effort and fallbacks on Haiku", () => {
    const p = buildParams({ model: "claude-haiku-4-5", effort: "low", messages: [{ role: "user", content: "hi" }] });
    expect(p.output_config).toBeUndefined();
    expect(p.fallbacks).toBeUndefined();
  });
  it("keeps the system prompt free of volatile data", () => {
    expect(SYSTEM_PROMPT).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});

describe("toApiMessages", () => {
  it("drops empty turns and leading assistant turns", () => {
    expect(toApiMessages([{ role: "assistant", content: "hello" }, { role: "user", content: "q" }, { role: "assistant", content: " " }, { role: "user", content: "again" }])).toEqual([
      { role: "user", content: "q" },
      { role: "user", content: "again" },
    ]);
  });
  it("refuses to send a conversation that ends with the assistant (no prefill)", () => {
    expect(() => toApiMessages([{ role: "user", content: "q" }, { role: "assistant", content: "a" }])).toThrow(AiError);
  });
});

// A local stand-in for the API that rejects every key, so no real tokens are spent.
let server: http.Server;
let baseURL = "";
let seenKey = "";
beforeAll(async () => {
  server = http.createServer((req, res) => {
    seenKey = String(req.headers["x-api-key"] ?? "");
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

describe("streamAnswer with a bad key", () => {
  it("fails with a friendly auth error", async () => {
    let deltas = "";
    const err = await streamAnswer(
      { apiKey: "sk-ant-fake", effort: "low", messages: [{ role: "user", content: "hi" }], signal: new AbortController().signal, baseURL },
      { onText: (t) => (deltas += t) },
    ).catch((e: unknown) => describeError(e));
    expect(err).toBeInstanceOf(AiError);
    expect((err as AiError).kind).toBe("auth");
    expect((err as AiError).message).toMatch(/Invalid API key/);
    expect((err as AiError).message).not.toContain("sk-ant-fake");
    expect(deltas).toBe("");
    expect(seenKey).toBe("sk-ant-fake");
  });
});
