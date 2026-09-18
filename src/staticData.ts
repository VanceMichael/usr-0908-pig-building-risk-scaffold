import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  SensorRecord,
  SensorRegistry,
  Thresholds,
  Topology,
  UnitRecord,
} from "./types.js";

export interface StaticData {
  topology: Topology;
  thresholds: Thresholds;
  sensors: Map<string, SensorRecord>;
  units: Map<string, UnitRecord>;
}

/**
 * Loads the repository fixtures (topology, sensor registry, growth-stage
 * thresholds). These describe the physical installation and are treated as
 * configuration; runtime telemetry lives in PostgreSQL.
 */
export async function loadStaticData(fixturesDir: string): Promise<StaticData> {
  const [topology, registry, thresholds] = await Promise.all([
    readJson<Topology>(path.join(fixturesDir, "topology.json")),
    readJson<SensorRegistry>(path.join(fixturesDir, "sensors.json")),
    readJson<Thresholds>(path.join(fixturesDir, "thresholds.json")),
  ]);

  const units = new Map<string, UnitRecord>();
  for (const building of topology.buildings) {
    for (const floor of building.floors) {
      for (const unit of floor.units) {
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

  const sensors = new Map<string, SensorRecord>();
  for (const sensor of registry.sensors) {
    sensors.set(sensor.sensor_id, sensor);
  }

  return { topology, thresholds, sensors, units };
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}
