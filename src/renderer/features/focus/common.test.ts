import { describe, expect, it } from "vitest";
import { parseDurationPrefix } from "./common";

describe("parseDurationPrefix", () => {
  it("reads minutes and hours with a goal", () => {
    expect(parseDurationPrefix("45m write report")).toEqual({ minutes: 45, goal: "write report" });
    expect(parseDurationPrefix("1h deep work")).toEqual({ minutes: 60, goal: "deep work" });
    expect(parseDurationPrefix("1.5 hours")).toEqual({ minutes: 90, goal: "" });
    expect(parseDurationPrefix("30")).toEqual({ minutes: 30, goal: "" });
  });
  it("leaves plain goals alone", () => {
    expect(parseDurationPrefix("write report")).toBeNull();
    expect(parseDurationPrefix("3 little pigs")).toBeNull();
    expect(parseDurationPrefix("0m")).toBeNull();
  });
});
