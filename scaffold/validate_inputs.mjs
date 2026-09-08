import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadJson(relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
}

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function collectUnits(topology) {
  const units = new Map();
  for (const building of topology.buildings) {
    for (const floor of building.floors) {
      for (const unit of floor.units) {
        requireValue(!units.has(unit.unit_id), `duplicate unit ${unit.unit_id}`);
        requireValue(Array.isArray(unit.pens) && unit.pens.length > 0, `${unit.unit_id} has no pens`);
        units.set(unit.unit_id, unit);
      }
    }
  }
  return units;
}

function validateReading(reading, lineNumber, sensors) {
  const prefix = `telemetry line ${lineNumber}`;
  requireValue(
    Object.keys(reading).sort().join(",") === "metric,observed_at,reading_id,sensor_id,value",
    `${prefix}: fields do not match the contract`,
  );
  requireValue(/^[a-z0-9][a-z0-9-]{7,63}$/.test(reading.reading_id), `${prefix}: invalid reading_id`);
  requireValue(!Number.isNaN(Date.parse(reading.observed_at)), `${prefix}: invalid observed_at`);
  requireValue(typeof reading.value === "number" && Number.isFinite(reading.value), `${prefix}: invalid value`);
  const sensor = sensors.get(reading.sensor_id);
  requireValue(sensor, `${prefix}: unknown sensor ${reading.sensor_id}`);
  requireValue(reading.metric === sensor.metric, `${prefix}: metric does not match sensor`);
  requireValue(reading.value >= sensor.min_value && reading.value <= sensor.max_value, `${prefix}: value outside sensor range`);
}

async function main() {
  const [schema, topology, registry, thresholds, telemetryText] = await Promise.all([
    loadJson("contracts/telemetry.schema.json"),
    loadJson("fixtures/topology.json"),
    loadJson("fixtures/sensors.json"),
    loadJson("fixtures/thresholds.json"),
    readFile(path.join(root, "fixtures/sample-telemetry.ndjson"), "utf8"),
  ]);

  requireValue(schema.type === "object" && schema.additionalProperties === false, "telemetry contract boundary");
  requireValue(
    [...schema.required].sort().join(",") === "metric,observed_at,reading_id,sensor_id,value",
    "telemetry required fields",
  );

  const units = collectUnits(topology);
  requireValue(Object.keys(thresholds.growth_stages).length === 3, "growth-stage thresholds");
  for (const unit of units.values()) {
    requireValue(thresholds.growth_stages[unit.growth_stage], `missing thresholds for ${unit.growth_stage}`);
  }

  const sensors = new Map();
  for (const sensor of registry.sensors) {
    requireValue(!sensors.has(sensor.sensor_id), `duplicate sensor ${sensor.sensor_id}`);
    requireValue(units.has(sensor.unit_id), `${sensor.sensor_id} references unknown unit`);
    requireValue(schema.properties.metric.enum.includes(sensor.metric), `${sensor.sensor_id} has unsupported metric`);
    requireValue(sensor.min_value < sensor.max_value, `${sensor.sensor_id} has invalid range`);
    sensors.set(sensor.sensor_id, sensor);
  }

  const lines = telemetryText.split(/\r?\n/).filter((line) => line.trim() !== "");
  const readingIds = new Set();
  lines.forEach((line, index) => {
    const reading = JSON.parse(line);
    validateReading(reading, index + 1, sensors);
    requireValue(!readingIds.has(reading.reading_id), `telemetry line ${index + 1}: duplicate reading_id`);
    readingIds.add(reading.reading_id);
  });

  console.log(`validated ${lines.length} telemetry records, ${sensors.size} sensors, and ${units.size} units`);
}

await main();
