import type { AcceptedReading } from "./types.js";

/** An accepted line carries its 1-based physical NDJSON line number. */
export type ValidatedReading = AcceptedReading & { line: number };
