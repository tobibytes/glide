import { randomUUID } from "node:crypto";
import { ipcMain } from "electron";
import { EXTRA_IPC, type AskInputRequest, type ShowResultPayload } from "./extra-ipc";
import type { Windows } from "./window";

const ASK_TIMEOUT_MS = 5 * 60 * 1000;

export interface Prompts {
  askInput(prompt: string, placeholder?: string): Promise<string | null>;
  showResult(text: string, title?: string): void;
  /** Resolve every pending prompt with null (launcher hidden, app quitting). */
  cancelAll(): void;
}

/** Bridges workflow askInput/showResult steps to the launcher renderer. */
export function createPrompts(windows: Windows): Prompts {
  const pending = new Map<string, { resolve: (v: string | null) => void; timer: NodeJS.Timeout }>();

  const settle = (requestId: string, value: string | null) => {
    const entry = pending.get(requestId);
    if (!entry) return;
    pending.delete(requestId);
    clearTimeout(entry.timer);
    entry.resolve(value);
  };

  ipcMain.on(EXTRA_IPC.ASK_INPUT_ANSWER, (_event, requestId: unknown, value: unknown) => {
    if (typeof requestId === "string") settle(requestId, typeof value === "string" ? value : null);
  });

  return {
    askInput(prompt, placeholder) {
      return new Promise((resolve) => {
        const req: AskInputRequest = { requestId: randomUUID(), prompt, placeholder };
        const timer = setTimeout(() => settle(req.requestId, null), ASK_TIMEOUT_MS);
        pending.set(req.requestId, { resolve, timer });
        windows.showLauncher();
        windows.sendToLauncher(EXTRA_IPC.EVT_ASK_INPUT, req);
      });
    },
    showResult(text, title) {
      const payload: ShowResultPayload = { text, title };
      windows.showLauncher();
      windows.sendToLauncher(EXTRA_IPC.EVT_SHOW_RESULT, payload);
    },
    cancelAll() {
      for (const id of [...pending.keys()]) settle(id, null);
    },
  };
}
