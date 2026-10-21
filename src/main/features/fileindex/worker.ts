/**
 * Worker-thread entry (bundled to dist/main/fileindex-worker.cjs by
 * scripts/build-fileindex-worker.mjs). Thin RPC shim like Raycast's
 * indexer-worker.mjs: {id, type, ...} in, {id, type: progress|done|error} out.
 */
import { parentPort } from "node:worker_threads";
import { compact, fullBuild } from "./build";
import type { WorkerRequest, WorkerResponse } from "./worker-protocol";

const port = parentPort;
if (!port) throw new Error("fileindex worker must run in a worker thread");

let stopRequested = false;

const send = (msg: WorkerResponse, transfer: ArrayBuffer[] = []) => port.postMessage(msg, transfer);

port.on("message", (req: WorkerRequest) => {
  if (req.type === "stop") {
    stopRequested = true;
    return;
  }
  stopRequested = false;
  const run = req.type === "crawl"
    ? fullBuild(req.config, req.dir, req.configKey, { onProgress: (entries) => send({ id: req.id, type: "progress", entries }), shouldStop: () => stopRequested })
    : compact(req.dir);
  run.then(
    (result) => {
      if (!result) return send({ id: req.id, type: "done", bytes: null, meta: null });
      // Copy into an exclusively owned buffer so it can be transferred, not cloned.
      const bytes = result.bytes.byteOffset === 0 && result.bytes.byteLength === result.bytes.buffer.byteLength ? result.bytes : result.bytes.slice();
      send({ id: req.id, type: "done", bytes, meta: result.meta }, [bytes.buffer as ArrayBuffer]);
    },
    (err: unknown) => send({ id: req.id, type: "error", message: err instanceof Error ? err.message : String(err) }),
  );
});
