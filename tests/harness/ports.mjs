// CDP port allocation. Builder S10 owns 9470-9479; CI can move the window with GLIDE_TEST_PORT_BASE.
import net from "node:net";

const BASE = Number(process.env.GLIDE_TEST_PORT_BASE ?? 9470);
const COUNT = Number(process.env.GLIDE_TEST_PORT_COUNT ?? 10);
const taken = new Set();

function isFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen({ port, host: "127.0.0.1", exclusive: true }, () => srv.close(() => resolve(true)));
  });
}

/** Reserve a free port in the window (in-process reservation + an OS bind probe). */
export async function allocatePort() {
  for (let i = 0; i < COUNT; i++) {
    const port = BASE + i;
    if (taken.has(port)) continue;
    if (await isFree(port)) {
      taken.add(port);
      return port;
    }
  }
  throw new Error(`no free port in ${BASE}-${BASE + COUNT - 1}`);
}

export function releasePort(port) {
  taken.delete(port);
}

export const PORT_RANGE = { base: BASE, count: COUNT };
