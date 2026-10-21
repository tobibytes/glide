/**
 * Additive IPC channels owned by the main process (not in src/shared/ipc.ts).
 * See src/main/CONTRACT-REQUESTS.md. Shared by main and preload only.
 */
export const EXTRA_IPC = {
  /** main -> launcher: { requestId, prompt, placeholder } — a workflow askInput step is waiting */
  EVT_ASK_INPUT: "evt:askInput",
  /** renderer -> main: (requestId: string, value: string | null) — null cancels */
  ASK_INPUT_ANSWER: "askInput:answer",
  /** main -> launcher: { title?, text } — a workflow showResult step */
  EVT_SHOW_RESULT: "evt:showResult",
} as const;

export interface AskInputRequest {
  requestId: string;
  prompt: string;
  placeholder?: string;
}

export interface ShowResultPayload {
  title?: string;
  text: string;
}

/** Methods added to window.glide beyond GlideApi. */
export interface GlideApiExtras {
  onAskInput(cb: (req: AskInputRequest) => void): () => void;
  answerInput(requestId: string, value: string | null): void;
  onShowResult(cb: (payload: ShowResultPayload) => void): () => void;
}
