#!/usr/bin/env node
// End-to-end test client: starts the MCP server over stdio and runs a list of tool calls.
// Usage: node scripts/mcp-session.mjs calls.json     (calls.json = [{"tool": "...", "args": {...}, "wait_ms": 0}, ...])
//        node scripts/mcp-session.mjs --list
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--disable-warning=ExperimentalWarning", join(root, "dist/index.js")],
  stderr: "inherit",
});
const client = new Client({ name: "djay-mcp-test", version: "0.0.1" });
await client.connect(transport);

if (process.argv[2] === "--list") {
  const { tools } = await client.listTools();
  for (const t of tools) console.log(`${t.name.padEnd(18)} ${t.description.slice(0, 110)}`);
  console.log(`${tools.length} tools`);
} else {
  const calls = JSON.parse(readFileSync(process.argv[2], "utf8"));
  for (const c of calls) {
    if (c.wait_ms) await new Promise((r) => setTimeout(r, c.wait_ms));
    const t0 = Date.now();
    const res = await client.callTool({ name: c.tool, arguments: c.args ?? {} }, undefined, { timeout: 600000 });
    const parts = res.content.map((p) => (p.type === "text" ? p.text : `[${p.type} ${p.mimeType} ${p.data?.length} b64 chars]`));
    const text = parts.join("\n");
    console.log(`\n### ${c.tool} ${JSON.stringify(c.args ?? {})}  (${Date.now() - t0} ms)${res.isError ? "  ERROR" : ""}`);
    console.log(c.full ? text : text.slice(0, c.max ?? 2500));
    if (c.save && res.content[0]?.type === "image") {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(c.save, Buffer.from(res.content[0].data, "base64"));
      console.log(`saved ${c.save}`);
    }
  }
}
await client.close();
