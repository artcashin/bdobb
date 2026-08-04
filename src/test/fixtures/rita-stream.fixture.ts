// Loads the real byte-for-byte SSE captures from a live Agent Rita instance
// (src/test/fixtures/rita/*.sse) so the parser is exercised against actual
// wire traffic, not hand-written strings. See task-13-report.md for how each
// fixture was captured and what it covers.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Plain text answer: 32 `copilotMessageChunk` events. */
export const simpleTextSse = readFileSync(path.join(here, "rita/simple-text.sse"), "utf8");

/**
 * Rita asking for widget data: one `copilotStatusUpdate`, then one
 * `copilotFunctionCall`, then the stream ends (no trailing events).
 */
export const functionCallSse = readFileSync(path.join(here, "rita/function-call.sse"), "utf8");

/**
 * The continuation after sending widget data back: `copilotStatusUpdate`
 * (carrying an inline `artifacts` array), 105 `copilotMessageChunk` events,
 * and one `copilotCitationCollection`.
 */
export const roundtripAnswerSse = readFileSync(
  path.join(here, "rita/roundtrip-answer.sse"),
  "utf8"
);

/** Feeds `text` through a ReadableStream in small byte slices, simulating a chunked/partial network read. */
export function streamOf(text: string, chunkSize = 7): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize) {
        controller.enqueue(bytes.slice(i, i + chunkSize));
      }
      controller.close();
    },
  });
}
