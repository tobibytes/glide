import { describe, expect, it } from "vitest";
import { firstLine, lastLine, parseDuration, parseScript, splitArguments } from "./parse";

const bash = `#!/bin/bash
# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title Say Hello
# @raycast.mode compact
# Optional parameters:
# @raycast.icon 👋
# @raycast.packageName Greetings
# @raycast.description Greets someone
# @raycast.argument1 { "type": "text", "placeholder": "Name", "optional": true }
echo "Hello $1"
`;

describe("parseScript", () => {
  it("reads raycast metadata", () => {
    const m = parseScript(bash);
    expect(m.errors).toEqual([]);
    expect(m).toMatchObject({ title: "Say Hello", mode: "compact", icon: "👋", packageName: "Greetings", description: "Greets someone" });
    expect(m.arguments).toEqual([{ type: "text", placeholder: "Name", optional: true, percentEncoded: false }]);
  });

  it("accepts the @glide. prefix and // and -- comments", () => {
    expect(parseScript("// @glide.title JS\n// @glide.mode silent").title).toBe("JS");
    const as = parseScript("-- @raycast.title AppleScript\n-- @raycast.mode fullOutput");
    expect(as).toMatchObject({ title: "AppleScript", mode: "fullOutput", errors: [] });
  });

  it("reports missing title and mode", () => {
    expect(parseScript("echo hi").errors).toEqual(["Missing @raycast.title", "Missing @raycast.mode"]);
  });

  it("reports an unknown mode once", () => {
    const m = parseScript("# @raycast.title X\n# @raycast.mode loud");
    expect(m.mode).toBeUndefined();
    expect(m.errors).toEqual([expect.stringMatching(/Unknown mode "loud"/)]);
  });

  it("parses refreshTime with a 10 s floor", () => {
    expect(parseScript("# @raycast.title X\n# @raycast.mode inline\n# @raycast.refreshTime 5m").refreshTime).toBe(300_000);
    expect(parseScript("# @raycast.title X\n# @raycast.mode inline\n# @raycast.refreshTime 1s").refreshTime).toBe(10_000);
    expect(parseScript("# @raycast.title X\n# @raycast.mode inline\n# @raycast.refreshTime soon").errors[0]).toMatch(/refreshTime/);
  });

  it("validates arguments", () => {
    expect(parseScript('# @raycast.title X\n# @raycast.mode silent\n# @raycast.argument1 {bad').errors).toEqual(["argument1 is not valid JSON"]);
    expect(parseScript('# @raycast.title X\n# @raycast.mode silent\n# @raycast.argument2 {"type":"text"}').errors[0]).toMatch(/argument1 is missing/);
    const dd = parseScript('# @raycast.title X\n# @raycast.mode silent\n# @raycast.argument1 {"type":"dropdown","placeholder":"Pick","data":[{"title":"A","value":"a"}]}');
    expect(dd.arguments[0]).toMatchObject({ type: "dropdown", data: [{ title: "A", value: "a" }] });
    expect(parseScript('# @raycast.title X\n# @raycast.mode silent\n# @raycast.argument1 {"type":"color"}').errors[0]).toMatch(/unsupported type/);
  });

  it("collects up to three arguments in order", () => {
    const src = ['# @raycast.title X', '# @raycast.mode silent', '# @raycast.argument2 {"placeholder":"b"}', '# @raycast.argument1 {"placeholder":"a"}'].join("\n");
    expect(parseScript(src).arguments.map((a) => a.placeholder)).toEqual(["a", "b"]);
  });
});

describe("helpers", () => {
  it("parses durations", () => {
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("2h")).toBe(7_200_000);
    expect(parseDuration("1d")).toBe(86_400_000);
    expect(parseDuration("10")).toBeNull();
  });
  it("splits arguments with quotes and a greedy last argument", () => {
    expect(splitArguments("hello world", 1)).toEqual(["hello world"]);
    expect(splitArguments('"New York" rainy day', 2)).toEqual(["New York", "rainy day"]);
    expect(splitArguments("a b c d", 3)).toEqual(["a", "b", "c d"]);
    expect(splitArguments("", 2)).toEqual([]);
    expect(splitArguments('"quoted all"', 1)).toEqual(["quoted all"]);
  });
  it("finds first and last non-empty lines", () => {
    expect(lastLine("a\nb\n\n")).toBe("b");
    expect(firstLine("\n\nx\ny")).toBe("x");
    expect(lastLine("")).toBe("");
  });
});
