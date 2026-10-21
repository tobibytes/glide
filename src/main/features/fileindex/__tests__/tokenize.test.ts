import { describe, expect, it } from "vitest";
import { nameTokens, queryTokens, splitWords } from "../tokenize";

describe("tokenizer", () => {
  it("splits on separators, camelCase and digit edges", () => {
    expect(splitWords("my-report_final v2.PDF")).toEqual(["my", "report", "final", "v", "2", "PDF"]);
    expect(splitWords("XMLHttpRequest.ts")).toEqual(["XML", "Http", "Request", "ts"]);
    expect(splitWords("fooBar2024")).toEqual(["foo", "Bar", "2024"]);
  });
  it("lowercases and folds diacritics", () => {
    expect(nameTokens("Café Résumé.docx")).toEqual(expect.arrayContaining(["cafe", "resume", "docx"]));
  });
  it("adds the joined name so run-together queries match", () => {
    expect(nameTokens("my-report.pdf")).toContain("myreportpdf");
    expect(nameTokens("single")).toEqual(["single"]);
  });
  it("gives CJK ideographs their own tokens", () => {
    expect(splitWords("报告2024")).toEqual(["报", "告", "2024"]);
  });
  it("tokenizes queries like names", () => {
    expect(queryTokens("Foo bar-BAZ")).toEqual(["foo", "bar", "baz"]);
    expect(queryTokens("  ")).toEqual([]);
  });
});
