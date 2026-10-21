import type { Quicklink, Snippet, Workflow } from "@shared/types";

/** Example content written on first launch so the app is not empty. */
export function seedWorkflows(now: number): Workflow[] {
  return [
    {
      id: "wf-morning-setup",
      name: "Morning Setup",
      description: "Open Calendar and Notes, then say hello",
      icon: { kind: "emoji", value: "☀️" },
      keywords: ["start", "day"],
      actions: [
        { id: "a1", type: "openApp", params: { app: "Calendar" } },
        { id: "a2", type: "openApp", params: { app: "Notes" } },
        { id: "a3", type: "notify", params: { title: "Good morning", body: "Calendar and Notes are ready. Today is {{date}}." } },
      ],
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "wf-search-clipboard",
      name: "Search Clipboard on Google",
      description: "Google whatever is on the clipboard",
      icon: { kind: "emoji", value: "🔎" },
      keywords: ["google", "lookup"],
      actions: [
        { id: "a1", type: "getClipboard", params: {} },
        { id: "a2", type: "openUrl", params: { url: "https://www.google.com/search?q={{clipboard}}" } },
      ],
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "wf-quick-note",
      name: "Quick Note",
      description: "Append a line to ~/Desktop/notes.txt",
      icon: { kind: "emoji", value: "📝" },
      keywords: ["note", "jot"],
      acceptsInput: true,
      actions: [
        { id: "a1", type: "askInput", params: { prompt: "What's on your mind?", placeholder: "Note text" } },
        {
          id: "a2",
          type: "runShell",
          params: { command: 'printf "%s  %s\\n" "{{date}} {{time}}" "{{input}}" >> ~/Desktop/notes.txt', shell: "/bin/zsh" },
        },
        { id: "a3", type: "notify", params: { title: "Note saved", body: "{{input}}" } },
      ],
      createdAt: now,
      updatedAt: now,
    },
  ];
}

export function seedQuicklinks(): Quicklink[] {
  return [
    { id: "ql-google", name: "Google", url: "https://www.google.com/search?q={query}", icon: { kind: "emoji", value: "🌐" }, alias: "g" },
    { id: "ql-github", name: "GitHub", url: "https://github.com/search?q={query}", icon: { kind: "emoji", value: "🐙" } },
    { id: "ql-youtube", name: "YouTube", url: "https://www.youtube.com/results?search_query={query}", icon: { kind: "emoji", value: "▶️" } },
  ];
}

export function seedSnippets(): Snippet[] {
  return [
    { id: "sn-email-sig", name: "Email signature", text: "Best regards,\n\n— sent from Glide", keyword: ";sig" },
    { id: "sn-shrug", name: "Shrug", text: "¯\\_(ツ)_/¯", keyword: ";shrug" },
  ];
}
