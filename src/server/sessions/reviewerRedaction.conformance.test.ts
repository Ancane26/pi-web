import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { redactReviewerBridgeText } from "./reviewerBridgeRedaction.js";

interface CorpusCase {
  id: string;
  input?: string;
  fragments?: string[];
  expected: string;
  redacted: boolean;
}

const corpusPath = resolve(process.cwd(), "../ai-engineering-harness-build0148-pi-web-reviewer/tests/fixtures/pi_web_reviewer_redaction_conformance.json");
function isCorpusCase(value: unknown): value is CorpusCase {
  return value !== null && typeof value === "object" && "id" in value && typeof value.id === "string" && "expected" in value && typeof value.expected === "string" && "redacted" in value && typeof value.redacted === "boolean";
}

const parsedCorpus: unknown = JSON.parse(readFileSync(corpusPath, "utf8"));
if (!Array.isArray(parsedCorpus) || !parsedCorpus.every(isCorpusCase)) throw new Error("Invalid reviewer redaction conformance corpus");
const corpus: CorpusCase[] = parsedCorpus;

describe("reviewer redaction canonical conformance corpus", () => {
  it.each(corpus.map((entry) => [entry.id, entry]))("matches %s", (_id, entry) => {
    const input = entry.fragments === undefined ? entry.input ?? "" : entry.fragments.join("");
    const output = redactReviewerBridgeText(input);
    expect(output).toBe(entry.expected);
    if (entry.redacted) expect(output).not.toContain("SYNTH_");
  });
});
