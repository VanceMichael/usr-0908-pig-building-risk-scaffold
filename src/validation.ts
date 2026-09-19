import type { AcceptedReading, Metric, RejectedLine, SensorDef } from "./types.js";
import type { ValidatedReading } from "./protocol.js";

const READING_ID_RE = /^[a-z0-9][a-z0-9-]{7,63}$/;
const SENSOR_ID_RE = /^SNS-[A-Z0-9-]{3,24}$/;
// RFC 3339 date-time, mandatory offset (Z or ±hh:mm), millisecond part allowed.
const DATE_TIME_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const METRICS = ["temperature_c", "humidity_pct", "ammonia_ppm", "coughs_per_min"];
const CONTRACT_FIELDS = ["reading_id", "sensor_id", "observed_at", "metric", "value"];

export interface BatchOutcome {
  accepted: ValidatedReading[];
  rejected: RejectedLine[];
}

/**
 * Validates one NDJSON payload. Every physical line is judged independently:
 * a rejected line never prevents sibling lines from being accepted, and the
 * reported line number is the 1-based physical line in the request body.
 */
export function validateTelemetry(
  body: string,
  sensors: Map<string, SensorDef>,
): BatchOutcome {
  const accepted: ValidatedReading[] = [];
  const rejected: RejectedLine[] = [];
  const seenInBatch = new Set<string>();

  // split() preserves physical line numbers: a trailing newline yields one
  // empty final element which is skipped without consuming a number shift.
  const lines = body.split(/\r?\n/);
  lines.forEach((rawLine, index) => {
    const line = index + 1;
    if (rawLine.trim() === "") return;

    const fail = (reason: string, readingId: string | null = null): void => {
      rejected.push({ line, reading_id: readingId, reason });
    };

    let record: Record<string, unknown>;
    try {
      record = JSON.parse(rawLine) as Record<string, unknown>;
    } catch {
      fail("malformed JSON");
      return;
    }
    if (record === null || typeof record !== "object" || Array.isArray(record)) {
      fail("record is not a JSON object");
      return;
    }

    const keys = Object.keys(record).sort();
    if (keys.join(",") !== [...CONTRACT_FIELDS].sort().join(",")) {
      fail(
        `fields do not match contract: expected ${CONTRACT_FIELDS.join("|")}, got ${keys.join("|") || "(none)"}`,
        typeof record.reading_id === "string" ? record.reading_id : null,
      );
      return;
    }

    const { reading_id, sensor_id, observed_at, metric, value } = record as Record<
      string,
      unknown
    >;

    if (typeof reading_id !== "string" || !READING_ID_RE.test(reading_id)) {
      fail("invalid reading_id (pattern ^[a-z0-9][a-z0-9-]{7,63}$)");
      return;
    }
    if (seenInBatch.has(reading_id)) {
      fail(`duplicate reading_id ${reading_id} within batch`, reading_id);
      return;
    }

    if (typeof sensor_id !== "string" || !SENSOR_ID_RE.test(sensor_id)) {
      fail("invalid sensor_id (pattern ^SNS-[A-Z0-9-]{3,24}$)", reading_id);
      return;
    }
    const sensor = sensors.get(sensor_id);
    if (!sensor) {
      // 设备归属：设备必须在注册表中。
      fail(`unknown sensor ${sensor_id} (not registered to any unit)`, reading_id);
      return;
    }

    // 指标类型：必须属于契约枚举且与设备注册的指标一致。
    if (typeof metric !== "string" || !METRICS.includes(metric)) {
      fail(`invalid metric ${String(metric)}`, reading_id);
      return;
    }
    if (metric !== sensor.metric) {
      fail(
        `metric ${metric} does not match sensor ${sensor_id} registered metric ${sensor.metric}`,
        reading_id,
      );
      return;
    }

    // 时间戳：必须是带时区偏移的 RFC 3339 日期时间。
    if (typeof observed_at !== "string" || !DATE_TIME_RE.test(observed_at)) {
      fail("invalid observed_at (expected RFC 3339 date-time with timezone)", reading_id);
      return;
    }
    const observedAt = Date.parse(observed_at);
    if (Number.isNaN(observedAt)) {
      fail("invalid observed_at (unparseable calendar date)", reading_id);
      return;
    }

    // 值域：JSON number、有限、落在设备物理量程内。
    if (typeof value !== "number" || !Number.isFinite(value)) {
      fail("invalid value (must be a finite JSON number)", reading_id);
      return;
    }
    if (value < sensor.min_value || value > sensor.max_value) {
      fail(
        `value ${value} outside sensor range [${sensor.min_value}, ${sensor.max_value}]`,
        reading_id,
      );
      return;
    }

    seenInBatch.add(reading_id);
    accepted.push({
      reading_id,
      sensor_id,
      unit_id: sensor.unit_id,
      metric: metric as Metric,
      observed_at: new Date(observedAt),
      value,
      line,
    });
  });

  return { accepted, rejected };
}
