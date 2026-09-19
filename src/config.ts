import { readFile } from "node:fs/promises";
import path from "node:path";
import type { SensorDef, ThresholdConfig, UnitDef } from "./types.js";
import type { GrowthStage, Metric } from "./types.js";

export interface Topology {
  campus_id: string;
  timezone: string;
  buildings: Array<{
    building_id: string;
    floors: Array<{
      floor_id: string;
      units: Array<{ unit_id: string; growth_stage: GrowthStage; pens: string[] }>;
    }>;
  }>;
}

export interface SensorRegistry {
  registry_version: string;
  sensors: Array<{
    sensor_id: string;
    unit_id: string;
    metric: Metric;
    min_value: number;
    max_value: number;
  }>;
}

export interface ReferenceData {
  topology: Topology;
  thresholds: ThresholdConfig;
  units: Map<string, UnitDef>;
  sensors: Map<string, SensorDef>;
}

async function loadJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T;
}

/**
 * Loads topology, sensor registry and growth-stage thresholds from the
 * repository fixtures. Fails fast on internal inconsistency: the running
 * service must share the exact assets the validator approved.
 */
export async function loadReferenceData(fixturesDir: string): Promise<ReferenceData> {
  const [topology, registry, thresholds] = await Promise.all([
    loadJson<Topology>(path.join(fixturesDir, "topology.json")),
    loadJson<SensorRegistry>(path.join(fixturesDir, "sensors.json")),
    loadJson<ThresholdConfig>(path.join(fixturesDir, "thresholds.json")),
  ]);

  const units = new Map<string, UnitDef>();
  for (const building of topology.buildings) {
    for (const floor of building.floors) {
      for (const unit of floor.units) {
        if (units.has(unit.unit_id)) {
          throw new Error(`duplicate unit ${unit.unit_id} in topology`);
        }
        if (!thresholds.growth_stages[unit.growth_stage]) {
          throw new Error(`missing thresholds for growth stage ${unit.growth_stage}`);
        }
        units.set(unit.unit_id, {
          unit_id: unit.unit_id,
          campus_id: topology.campus_id,
          building_id: building.building_id,
          floor_id: floor.floor_id,
          growth_stage: unit.growth_stage,
          pens: unit.pens,
        });
      }
    }
  }

  const sensors = new Map<string, SensorDef>();
  for (const sensor of registry.sensors) {
    if (sensors.has(sensor.sensor_id)) {
      throw new Error(`duplicate sensor ${sensor.sensor_id} in registry`);
    }
    const unit = units.get(sensor.unit_id);
    if (!unit) {
      throw new Error(`sensor ${sensor.sensor_id} references unknown unit ${sensor.unit_id}`);
    }
    if (sensor.min_value >= sensor.max_value) {
      throw new Error(`sensor ${sensor.sensor_id} has invalid range`);
    }
    sensors.set(sensor.sensor_id, { ...sensor, unit_id: unit.unit_id });
  }

  return { topology, thresholds, units, sensors };
}

export interface AppConfig {
  port: number;
  fixturesDir: string;
  databaseUrl: string;
}

export function loadConfig(): AppConfig {
  return {
    port: Number(process.env.PORT ?? 8080),
    fixturesDir: process.env.FIXTURES_DIR ?? "/app/fixtures",
    databaseUrl:
      process.env.DATABASE_URL ??
      "postgres://pig_risk:scaffold-only@postgres:5432/pig_risk",
  };
}
