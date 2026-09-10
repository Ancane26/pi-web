// Fail-closed credential-field redaction for the Pi Web reviewer boundary.

const CREDENTIAL_LABELS = ["ssh_auth_sock", "authorization", "password", "api_key", "api-key", "secret", "token"] as const;
const SEPARATOR_WHITESPACE = new Set(" \t\f\v\u0085\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u202f\u205f\u3000\ufeff");
const LINE_BREAKS = new Set(["\r", "\n", "\u2028", "\u2029"]);
const REDACTED = "<redacted>";

function lineBounds(value: string, start: number): [number, number] {
  let index = start;
  while (index < value.length && !LINE_BREAKS.has(value.charAt(index))) index += 1;
  if (index === value.length) return [index, index];
  if (value.charAt(index) === "\r" && value.charAt(index + 1) === "\n") return [index, index + 2];
  return [index, index + 1];
}

function hasUnescapedQuote(value: string, start: number, end: number, quote: string): boolean {
  let escaped = false;
  for (let index = start; index < end; index += 1) {
    const character = value.charAt(index);
    if (escaped) escaped = false;
    else if (character === "\\") escaped = true;
    else if (character === quote) return true;
  }
  return false;
}

function startsCredential(value: string, start: number, end: number): boolean {
  for (const label of CREDENTIAL_LABELS) {
    const labelEnd = start + label.length;
    if (labelEnd > end || value.slice(start, labelEnd).toLowerCase() !== label) continue;
    let cursor = labelEnd;
    while (cursor < end && SEPARATOR_WHITESPACE.has(value.charAt(cursor))) cursor += 1;
    if (cursor < end && (value.charAt(cursor) === "\"" || value.charAt(cursor) === "'")) cursor += 1;
    else if (cursor + 1 < end && value.charAt(cursor) === "\\" && (value.charAt(cursor + 1) === "\"" || value.charAt(cursor + 1) === "'")) cursor += 2;
    while (cursor < end && SEPARATOR_WHITESPACE.has(value.charAt(cursor))) cursor += 1;
    if (cursor < end && (value.charAt(cursor) === ":" || value.charAt(cursor) === "=")) return true;
  }
  return false;
}

function credentialField(value: string, start: number): { valueStart: number; lineEnd: number; lineAfterBreak: number; consumeEnd: number } | undefined {
  const [lineEnd, lineAfterBreak] = lineBounds(value, start);
  for (const label of CREDENTIAL_LABELS) {
    const labelEnd = start + label.length;
    if (labelEnd > lineEnd || value.slice(start, labelEnd).toLowerCase() !== label) continue;
    let cursor = labelEnd;
    while (cursor < lineEnd && SEPARATOR_WHITESPACE.has(value.charAt(cursor))) cursor += 1;
    if (cursor < lineEnd && (value.charAt(cursor) === "\"" || value.charAt(cursor) === "'")) cursor += 1;
    else if (cursor + 1 < lineEnd && value.charAt(cursor) === "\\" && (value.charAt(cursor + 1) === "\"" || value.charAt(cursor + 1) === "'")) cursor += 2;
    while (cursor < lineEnd && SEPARATOR_WHITESPACE.has(value.charAt(cursor))) cursor += 1;
    if (cursor >= lineEnd || (value.charAt(cursor) !== ":" && value.charAt(cursor) !== "=")) continue;
    const separatorEnd = cursor + 1;
    let valueStart = separatorEnd;
    while (valueStart < lineEnd && SEPARATOR_WHITESPACE.has(value.charAt(valueStart))) valueStart += 1;

    let consumeEnd = lineAfterBreak;
    const marker = valueStart < lineEnd ? value.charAt(valueStart) : "";
    if (marker === "|" || marker === ">") {
      let continuation = lineAfterBreak;
      while (continuation < value.length) {
        const [nextEnd, nextAfterBreak] = lineBounds(value, continuation);
        if (nextEnd === continuation || !SEPARATOR_WHITESPACE.has(value.charAt(continuation))) break;
        consumeEnd = nextAfterBreak;
        continuation = nextAfterBreak;
      }
    } else if (valueStart < lineEnd && (value.charAt(valueStart) === "\"" || value.charAt(valueStart) === "'")) {
      const quote = value.charAt(valueStart);
      if (!hasUnescapedQuote(value, valueStart + 1, lineEnd, quote)) {
        let continuation = lineAfterBreak;
        while (continuation < value.length) {
          const [nextEnd, nextAfterBreak] = lineBounds(value, continuation);
          if (nextEnd === continuation || startsCredential(value, continuation, nextEnd)) break;
          consumeEnd = nextAfterBreak;
          continuation = nextAfterBreak;
        }
      }
    }
    return { valueStart, lineEnd, lineAfterBreak, consumeEnd };
  }
  return undefined;
}

export function redactReviewerBridgeText(value: string): string {
  const output: string[] = [];
  let cursor = 0;
  let index = 0;
  while (index < value.length) {
    const field = credentialField(value, index);
    if (field === undefined) {
      index += 1;
      continue;
    }
    output.push(value.slice(cursor, field.valueStart), REDACTED);
    if (field.lineEnd < value.length) output.push(value.slice(field.lineEnd, field.lineAfterBreak));
    cursor = field.consumeEnd;
    index = field.consumeEnd;
  }
  output.push(value.slice(cursor));
  return output.join("");
}

function sanitizeUnknown(value: unknown): unknown {
  if (typeof value === "string") return redactReviewerBridgeText(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeUnknown(item));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [redactReviewerBridgeText(key), sanitizeUnknown(item)]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function sanitizeReviewerBridgePayload(value: Record<string, unknown>): Record<string, unknown> {
  const sanitized = sanitizeUnknown(value);
  if (!isRecord(sanitized)) throw new Error("Sanitized reviewer bridge payload was not an object");
  return sanitized;
}
