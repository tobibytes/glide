import type { AiCommandDef } from "./types";

const TEXT = "<text>\n{selection}\n</text>";
const CODE = "<code>\n{selection}\n</code>";
const ONLY = "Reply with only the rewritten text — no preamble, no quotes, no explanation. Keep the original language and formatting (Markdown, line breaks) unless asked otherwise.";

export const BUILTIN_COMMANDS: AiCommandDef[] = [
  { id: "fix-spelling", name: "Fix Spelling and Grammar", icon: "✏️", replaces: true, prompt: `Fix the spelling, grammar and punctuation of the text below. Do not change its meaning or tone. ${ONLY}\n\n${TEXT}` },
  { id: "improve-writing", name: "Improve Writing", icon: "✨", replaces: true, prompt: `Improve the writing of the text below: make it clearer and more fluent while keeping its meaning and voice. ${ONLY}\n\n${TEXT}` },
  { id: "make-shorter", name: "Make Shorter", icon: "➖", replaces: true, prompt: `Make the text below noticeably shorter while keeping every key point. ${ONLY}\n\n${TEXT}` },
  { id: "make-longer", name: "Make Longer", icon: "➕", replaces: true, prompt: `Expand the text below with relevant detail so it is roughly twice as long, keeping its tone. ${ONLY}\n\n${TEXT}` },
  { id: "tone-friendly", name: "Change Tone to Friendly", icon: "😊", replaces: true, prompt: `Rewrite the text below in a warm, friendly tone. ${ONLY}\n\n${TEXT}` },
  { id: "tone-professional", name: "Change Tone to Professional", icon: "👔", replaces: true, prompt: `Rewrite the text below in a clear, professional tone. ${ONLY}\n\n${TEXT}` },
  { id: "summarize", name: "Summarize", icon: "📝", prompt: `Summarize the text below in a few concise bullet points.\n\n${TEXT}` },
  { id: "explain-simply", name: "Explain This in Simple Terms", icon: "💡", prompt: `Explain the text below in simple terms a curious 12-year-old would understand.\n\n${TEXT}` },
  { id: "translate", name: "Translate to …", icon: "🌐", replaces: true, acceptsArgument: true, argumentPlaceholder: "Language", prompt: `Translate the text below into {argument}. ${ONLY}\n\n${TEXT}` },
  { id: "explain-code", name: "Explain Code", icon: "🧑‍💻", prompt: `Explain what the code below does, step by step. Mention the language, inputs/outputs and anything surprising.\n\n${CODE}` },
  { id: "find-bugs", name: "Find Bugs in Code", icon: "🐞", prompt: `Review the code below for bugs. List each real problem with the line, why it is wrong and a fix. If you find none, say so.\n\n${CODE}` },
].map((c) => ({ ...c, builtin: true }));

/**
 * Fill {selection} and {argument} in a single pass so text inside the selection that happens
 * to contain "{argument}" is never substituted again.
 */
export function fillTemplate(template: string, vars: { selection?: string; argument?: string }): string {
  return template.replace(/\{(selection|argument)\}/g, (_m, key: "selection" | "argument") => vars[key] ?? "");
}

export function templateUses(template: string, key: "selection" | "argument"): boolean {
  return template.includes(`{${key}}`);
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Validate and normalise a user-defined command coming from the renderer. */
export function sanitizeCommand(raw: unknown): AiCommandDef | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === "string" ? r.name.trim().slice(0, 80) : "";
  const prompt = typeof r.prompt === "string" ? r.prompt.slice(0, 20_000) : "";
  if (!name || !prompt.trim()) return null;
  const id = typeof r.id === "string" && ID_RE.test(r.id) ? r.id : slug(name);
  const icon = typeof r.icon === "string" && r.icon.trim() ? [...r.icon.trim()].slice(0, 4).join("") : "🤖";
  const model = typeof r.model === "string" && r.model ? r.model : undefined;
  return {
    id,
    name,
    icon,
    prompt,
    model,
    acceptsArgument: templateUses(prompt, "argument"),
    argumentPlaceholder: typeof r.argumentPlaceholder === "string" ? r.argumentPlaceholder.slice(0, 40) : undefined,
    replaces: r.replaces === true,
  };
}

export function slug(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return `custom-${s || "command"}`;
}
