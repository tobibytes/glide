import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

export declare const FIXTURE_TOOLS: Array<{ name: string; description?: string; inputSchema: Record<string, unknown>; annotations?: Record<string, boolean> }>;
export declare function createFixtureServer(opts?: { log?: (line: string) => void }): { server: Server; notes: string[] };
export declare function startHttpFixture(opts?: { port?: number; token?: string; log?: (line: string) => void }): Promise<{ port: number; close(): Promise<void> }>;
