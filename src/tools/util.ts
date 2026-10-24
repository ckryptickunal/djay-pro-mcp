import { z } from "zod";
import { DjayError } from "../djay.js";

export const deckSchema = z.number().int().min(1).max(4);
export const unit = z.number().min(0).max(1);

export type ToolResult = {
  content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
  isError?: boolean;
};

export function ok(result: unknown, note?: string): ToolResult {
  const text = typeof result === "string" ? result : JSON.stringify(result, null, 1);
  return { content: [{ type: "text", text: note ? `${note}\n${text}` : text }] };
}

export function fail(err: unknown): ToolResult {
  const msg = err instanceof DjayError ? err.message : err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
}

/** Wraps a handler so thrown errors become MCP error results instead of crashing the call. */
export function safe<A>(fn: (args: A) => Promise<ToolResult>): (args: A) => Promise<ToolResult> {
  return async (args: A) => {
    try {
      return await fn(args);
    } catch (e) {
      return fail(e);
    }
  };
}
