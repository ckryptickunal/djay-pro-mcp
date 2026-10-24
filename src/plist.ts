import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

/** Reads any plist or .strings file (XML, binary or UTF-16 text) as JSON using macOS plutil. */
export function readPlist<T = any>(path: string): T {
  const out = execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", path], {
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out.toString("utf8")) as T;
}

/** Reads a plist that may contain data/date values (plutil's JSON conversion rejects those). */
export function readPlistLoose(path: string): any {
  try {
    return readPlist(path);
  } catch {
    const xml = execFileSync("/usr/bin/plutil", ["-convert", "xml1", "-o", "-", path], {
      maxBuffer: 64 * 1024 * 1024,
    }).toString("utf8");
    return parseXmlPlist(xml);
  }
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function encode(v: unknown, indent: string): string {
  const next = indent + "\t";
  if (v === true) return `${indent}<true/>`;
  if (v === false) return `${indent}<false/>`;
  if (typeof v === "number") {
    return Number.isInteger(v) ? `${indent}<integer>${v}</integer>` : `${indent}<real>${v}</real>`;
  }
  if (typeof v === "string") return `${indent}<string>${esc(v)}</string>`;
  if (Array.isArray(v)) {
    if (v.length === 0) return `${indent}<array/>`;
    return `${indent}<array>\n${v.map((x) => encode(x, next)).join("\n")}\n${indent}</array>`;
  }
  if (v && typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined);
    if (entries.length === 0) return `${indent}<dict/>`;
    const body = entries.map(([k, x]) => `${next}<key>${esc(k)}</key>\n${encode(x, next)}`).join("\n");
    return `${indent}<dict>\n${body}\n${indent}</dict>`;
  }
  throw new Error(`cannot encode ${typeof v} in plist`);
}

export function toXmlPlist(value: unknown): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n` +
    `<plist version="1.0">\n${encode(value, "")}\n</plist>\n`
  );
}

export function writeXmlPlist(path: string, value: unknown): void {
  writeFileSync(path, toXmlPlist(value), "utf8");
}

/** Minimal XML plist parser (used only as a fallback when JSON conversion fails). */
function parseXmlPlist(xml: string): any {
  const tokens = xml.match(/<[^>]+>|[^<]+/g) ?? [];
  let i = 0;
  const unesc = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  function textUntil(close: string): string {
    let s = "";
    while (i < tokens.length && tokens[i] !== close) s += tokens[i++];
    i++;
    return unesc(s);
  }
  function value(): any {
    while (i < tokens.length && !tokens[i].startsWith("<")) i++;
    const t = tokens[i++];
    if (t === "<dict>") {
      const o: Record<string, any> = {};
      while (tokens[i] !== "</dict>") {
        if (!tokens[i].startsWith("<")) { i++; continue; }
        if (tokens[i] === "<key>") { i++; const k = textUntil("</key>"); o[k] = value(); } else i++;
      }
      i++;
      return o;
    }
    if (t === "<dict/>") return {};
    if (t === "<array>") {
      const a: any[] = [];
      while (tokens[i] !== "</array>") {
        if (!tokens[i].startsWith("<")) { i++; continue; }
        a.push(value());
      }
      i++;
      return a;
    }
    if (t === "<array/>") return [];
    if (t === "<string>") return textUntil("</string>");
    if (t === "<string/>") return "";
    if (t === "<integer>") return parseInt(textUntil("</integer>"), 10);
    if (t === "<real>") return parseFloat(textUntil("</real>"));
    if (t === "<true/>") return true;
    if (t === "<false/>") return false;
    if (t === "<date>") return textUntil("</date>");
    if (t === "<data>") return { $data: textUntil("</data>").replace(/\s+/g, "") };
    if (t?.startsWith("<plist")) return value();
    return null;
  }
  return value();
}
