import type {
  Metric,
  ReadingInput,
  RejectedLine,
  SensorRecord,
} from "./types.js";
import { METRICS } from "./types.js";

const READING_ID_RE = /^[a-z0-9][a-z0-9-]{7,63}$/;
const SENSOR_ID_RE = /^SNS-[A-Z0-9-]{3,24}$/;
// Strict RFC 3339 date-time (the contract's "format": "date-time"), with
// explicit offset or Z. Date.parse alone accepts plain dates and other junk.
const DATE_TIME_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export interface ParsedLine {
  line: number;
  reading?: ReadingInput & { unit_id: string };
  rejection?: RejectedLine;
}

export interface ParseResult {
  parsed: ParsedLine[];
  rejected: RejectedLine[];
}

function reject(
  line: number,
  code: RejectedLine["code"],
  message: string,
  readingId?: string,
): ParsedLine {
  return { line, rejection: { line, code, message, reading_id: readingId } };
}

/**
 * Validates one NDJSON body independently of the database. Physical line
 * numbers are preserved (blank lines are skipped but still consume a line).
 * Duplicate reading_id checks against persisted readings happen in the
 * transactional ingest step.
 */
export function parseTelemetry(
  body: string,
  sensors: Map<string, SensorRecord>,
): ParseResult {
  const parsed: ParsedLine[] = [];
  const rejected: RejectedLine[] = [];
  const seenInBatch = new Set<string>();
  const lines = body.split(/\r?\n/);

  lines.forEach((raw, index) => {
    const line = index + 1;
    if (raw.trim() === "") return;

    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      push(parsed, rejected, reject(line, "invalid_json", "line is not valid JSON"));
      return;
    }

    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      push(parsed, rejected, reject(line, "invalid_record", "record must be a JSON object"));
      return;
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort().join(",");
    if (keys !== "metric,observed_at,reading_id,sensor_id,value") {
      push(
        parsed,
        rejected,
        reject(line, "invalid_record", `fields must be exactly reading_id, sensor_id, observed_at, metric, value`),
      );
      return;
    }

    const { reading_id, sensor_id, observed_at, metric, value: metricValue } = record;

    if (typeof reading_id !== "string" || !READING_ID_RE.test(reading_id)) {
      push(parsed, rejected, reject(line, "invalid_record", "invalid reading_id"));
      return;
    }
    if (typeof sensor_id !== "string" || !SENSOR_ID_RE.test(sensor_id)) {
      push(parsed, rejected, reject(line, "invalid_record", "invalid sensor_id", reading_id));
      return;
    }
    if (typeof observed_at !== "string" || !DATE_TIME_RE.test(observed_at) ||
        Number.isNaN(Date.parse(observed_at))) {
      push(parsed, rejected, reject(line, "invalid_record", "observed_at must be an RFC 3339 date-time", reading_id));
      return;
    }
    if (typeof metric !== "string" || !(METRICS as readonly string[]).includes(metric)) {
      push(parsed, rejected, reject(line, "invalid_record", `metric must be one of ${METRICS.join(", ")}`, reading_id));
      return;
    }
    if (typeof metricValue !== "number" || !Number.isFinite(metricValue)) {
      push(parsed, rejected, reject(line, "invalid_record", "value must be a finite number", reading_id));
      return;
    }

    const sensor = sensors.get(sensor_id);
    if (!sensor) {
      push(parsed, rejected, reject(line, "unknown_sensor", `sensor ${sensor_id} is not registered`, reading_id));
      return;
    }
    if (sensor.metric !== metric) {
      push(
        parsed,
        rejected,
        reject(
          line,
          "metric_mismatch",
          `sensor ${sensor_id} is registered for ${sensor.metric}, not ${metric}`,
          reading_id,
        ),
      );
      return;
    }
    if (metricValue < sensor.min_value || metricValue > sensor.max_value) {
      push(
        parsed,
        rejected,
        reject(
          line,
          "value_out_of_range",
          `value ${metricValue} is outside ${sensor_id} range [${sensor.min_value}, ${sensor.max_value}]`,
          reading_id,
        ),
      );
      return;
    }

    if (seenInBatch.has(reading_id)) {
      push(
        parsed,
        rejected,
        reject(line, "duplicate_reading_id", `reading_id ${reading_id} already appears at an earlier line of this batch`, reading_id),
      );
      return;
    }
    seenInBatch.add(reading_id);

    parsed.push({
      line,
      reading: {
        reading_id,
        sensor_id,
        observed_at,
        metric: metric as Metric,
        value: metricValue,
        unit_id: sensor.unit_id,
      },
    });
  });

  return { parsed, rejected };
}

function push(
  parsed: ParsedLine[],
  rejected: RejectedLine[],
  entry: ParsedLine,
): void {
  parsed.push(entry);
  if (entry.rejection) rejected.push(entry.rejection);
}
