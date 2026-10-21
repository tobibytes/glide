import type { ActionSpec, ActionType } from "@shared/types";
import { CONDITION_OPERATORS } from "./template";

const SYSTEM_SOUNDS = ["Basso", "Blow", "Bottle", "Frog", "Funk", "Glass", "Hero", "Morse", "Ping", "Pop", "Purr", "Sosumi", "Submarine", "Tink"];

const emoji = (value: string) => ({ kind: "emoji" as const, value });

export const ACTION_SPECS: ActionSpec[] = [
  {
    type: "openApp",
    title: "Open Application",
    description: "Launch or activate an application",
    icon: emoji("🚀"),
    category: "apps",
    params: [{ key: "app", label: "Application", kind: "app", placeholder: "Safari", required: true }],
  },
  {
    type: "openUrl",
    title: "Open URL",
    description: "Open a link in the default browser",
    icon: emoji("🌐"),
    category: "web",
    params: [{ key: "url", label: "URL", kind: "url", placeholder: "https://example.com/?q={{input}}", required: true }],
  },
  {
    type: "runShell",
    title: "Run Shell Script",
    description: "Run a command in your login shell; stdout becomes {{result}}",
    icon: emoji("💻"),
    category: "scripting",
    params: [
      { key: "command", label: "Command", kind: "multiline", placeholder: "echo {{input}}", required: true },
      { key: "shell", label: "Shell", kind: "select", options: ["/bin/zsh", "/bin/bash", "/bin/sh"], default: "/bin/zsh" },
      { key: "continueOnError", label: "Continue on error", kind: "select", options: ["false", "true"], default: "false" },
    ],
    outputVar: "stdout",
  },
  {
    type: "runAppleScript",
    title: "Run AppleScript",
    description: "Run an AppleScript; its return value becomes {{result}}",
    icon: emoji("📜"),
    category: "scripting",
    params: [
      { key: "script", label: "Script", kind: "multiline", placeholder: 'display dialog "{{input}}"', required: true },
      { key: "continueOnError", label: "Continue on error", kind: "select", options: ["false", "true"], default: "false" },
    ],
    outputVar: "scriptResult",
  },
  {
    type: "typeText",
    title: "Type Text",
    description: "Paste text into the frontmost app",
    icon: emoji("⌨️"),
    category: "text",
    params: [{ key: "text", label: "Text", kind: "multiline", placeholder: "Hello {{input}}", required: true }],
  },
  {
    type: "setClipboard",
    title: "Set Clipboard",
    description: "Copy text to the clipboard",
    icon: emoji("📋"),
    category: "clipboard",
    params: [{ key: "text", label: "Text", kind: "multiline", placeholder: "{{result}}", required: true }],
  },
  {
    type: "getClipboard",
    title: "Get Clipboard",
    description: "Read the clipboard into {{clipboard}}",
    icon: emoji("📥"),
    category: "clipboard",
    params: [],
    outputVar: "clipboard",
  },
  {
    type: "notify",
    title: "Show Notification",
    description: "Post a macOS notification",
    icon: emoji("🔔"),
    category: "system",
    params: [
      { key: "title", label: "Title", kind: "text", placeholder: "Done", required: true },
      { key: "body", label: "Body", kind: "multiline", placeholder: "{{result}}" },
    ],
  },
  {
    type: "wait",
    title: "Wait",
    description: "Pause before the next action",
    icon: emoji("⏳"),
    category: "control",
    params: [{ key: "seconds", label: "Seconds", kind: "number", placeholder: "1", default: "1", required: true }],
  },
  {
    type: "askInput",
    title: "Ask for Input",
    description: "Prompt in the launcher; the answer becomes {{input}}",
    icon: emoji("❓"),
    category: "control",
    params: [
      { key: "prompt", label: "Prompt", kind: "text", placeholder: "What would you like to do?", required: true },
      { key: "placeholder", label: "Placeholder", kind: "text", placeholder: "Type here…" },
    ],
    outputVar: "input",
  },
  {
    type: "setVariable",
    title: "Set Variable",
    description: "Store a value as {{name}}",
    icon: emoji("🏷️"),
    category: "control",
    params: [
      { key: "name", label: "Name", kind: "text", placeholder: "greeting", required: true },
      { key: "value", label: "Value", kind: "multiline", placeholder: "Hello {{input}}" },
    ],
  },
  {
    type: "condition",
    title: "If",
    description: "Run the Then or Else branch depending on a comparison",
    icon: emoji("🔀"),
    category: "control",
    params: [
      { key: "left", label: "Value", kind: "text", placeholder: "{{input}}", required: true },
      { key: "operator", label: "Operator", kind: "select", options: CONDITION_OPERATORS, default: "equals", required: true },
      { key: "right", label: "Compare to", kind: "text", placeholder: "yes" },
    ],
  },
  {
    type: "httpRequest",
    title: "HTTP Request",
    description: "Fetch a URL; the response body becomes {{response}}",
    icon: emoji("📡"),
    category: "web",
    params: [
      { key: "method", label: "Method", kind: "select", options: ["GET", "POST", "PUT", "PATCH", "DELETE"], default: "GET", required: true },
      { key: "url", label: "URL", kind: "url", placeholder: "https://api.example.com/items", required: true },
      { key: "headers", label: "Headers", kind: "multiline", placeholder: "Content-Type: application/json\nAuthorization: Bearer …" },
      { key: "body", label: "Body", kind: "multiline", placeholder: '{"text": "{{input}}"}' },
      { key: "continueOnError", label: "Continue on error", kind: "select", options: ["false", "true"], default: "false" },
    ],
    outputVar: "response",
  },
  {
    type: "runWorkflow",
    title: "Run Workflow",
    description: "Run another workflow and use its result",
    icon: emoji("🧩"),
    category: "control",
    params: [
      { key: "workflowId", label: "Workflow", kind: "text", placeholder: "workflow id", required: true },
      { key: "input", label: "Input", kind: "text", placeholder: "{{result}}" },
    ],
    outputVar: "workflowResult",
  },
  {
    type: "showResult",
    title: "Show Result",
    description: "Display text in the launcher window",
    icon: emoji("🪟"),
    category: "text",
    params: [
      { key: "text", label: "Text", kind: "multiline", placeholder: "{{result}}", required: true },
      { key: "title", label: "Title", kind: "text", placeholder: "Result" },
    ],
  },
  {
    type: "openFile",
    title: "Open File",
    description: "Open a file or folder with its default app",
    icon: emoji("📂"),
    category: "apps",
    params: [{ key: "path", label: "Path", kind: "file", placeholder: "~/Documents/todo.md", required: true }],
  },
  {
    type: "playSound",
    title: "Play Sound",
    description: "Play a macOS system sound",
    icon: emoji("🔊"),
    category: "system",
    params: [{ key: "name", label: "Sound", kind: "select", options: SYSTEM_SOUNDS, default: "Glass", required: true }],
  },
];

export function specFor(type: ActionType): ActionSpec | undefined {
  return ACTION_SPECS.find((s) => s.type === type);
}
