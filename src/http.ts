import express from "express";
import type { PgPool } from "./db.js";
import { ingestBatch } from "./engine.js";
import {
  getActiveAlerts,
  getAlertHistory,
  getCurrentRisk,
  getReadings,
  getWindows,
} from "./queries.js";
import type { StaticData } from "./staticData.js";
import { parseTelemetry } from "./validation.js";

export interface HttpDeps {
  pool: PgPool;
  data: StaticData;
}

const ISO_DATE_RE =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?$/;

function parseTimeParam(
  req: express.Request,
  res: express.Response,
  name: string,
): Date | null {
  const raw = req.query[name];
  if (typeof raw !== "string" || !ISO_DATE_RE.test(raw)) {
    res
      .status(400)
      .json({ error: `query parameter '${name}' must be an ISO 8601 date-time` });
    return null;
  }
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    res.status(400).json({ error: `query parameter '${name}' is not a valid date` });
    return null;
  }
  return date;
}

function parseUnitFilter(req: express.Request): string[] | undefined {
  const raw = req.query.unit_id;
  if (raw === undefined) return undefined;
  const list = Array.isArray(raw) ? raw.map(String) : [String(raw)];
  const filtered = list.filter((s) => s.length > 0);
  return filtered.length > 0 ? filtered : undefined;
}

export function createApp({ pool, data }: HttpDeps): express.Express {
  const app = express();
  app.disable("x-powered-by");

  app.get("/livez", (_req, res) => {
    res.json({ status: "alive" });
  });

  app.get("/healthz", async (_req, res) => {
    try {
      await pool.query("SELECT 1");
      res.json({ status: "ok", database: "ok" });
    } catch (error) {
      res.status(503).json({
        status: "degraded",
        database: "unavailable",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // ---- Batch telemetry ingestion (NDJSON) ---------------------------------

  app.post(
    "/v1/telemetry",
    express.text({
      type: (req) => {
        const contentType = req.headers["content-type"] ?? "";
        return (
          contentType.includes("application/x-ndjson") ||
          contentType.includes("text/plain") ||
          contentType.includes("application/octet-stream")
        );
      },
      limit: "10mb",
    }),
    async (req, res) => {
      const body = typeof req.body === "string" ? req.body : "";
      if (body.trim() === "") {
        res.status(400).json({ error: "request body must be a non-empty NDJSON batch" });
        return;
      }

      const { parsed, rejected: parseRejections } = parseTelemetry(
        body,
        data.sensors,
      );
      const validReadings = parsed
        .filter((p) => p.reading)
        .map((p) => ({ ...p.reading!, line: p.line }));

      const outcome = await ingestBatch(
        pool,
        validReadings,
        parseRejections,
        data.thresholds,
        data.units,
      );

      // 207 Multi-Status: individual lines are accepted/rejected independently.
      res.status(207).json({
        batch_size: parsed.length,
        accepted_count: outcome.accepted.length,
        rejected_count: outcome.rejected.length,
        accepted: outcome.accepted,
        rejected: outcome.rejected,
        windows_changed: outcome.windows_changed,
        alert_transitions: outcome.alert_transitions,
      });
    },
  );

  // ---- Current unit risk ----------------------------------------------------

  app.get("/v1/risk", async (req, res) => {
    const units = parseUnitFilter(req);
    const rows = await getCurrentRisk(pool, data.thresholds.window_minutes, units);
    res.json({ units: rows });
  });

  app.get("/v1/units/:unitId/risk", async (req, res) => {
    const unit = data.units.get(req.params.unitId);
    if (!unit) {
      res.status(404).json({ error: `unknown unit ${req.params.unitId}` });
      return;
    }
    const [row] = await getCurrentRisk(pool, data.thresholds.window_minutes, [
      unit.unit_id,
    ]);
    res.json(row ?? null);
  });

  // ---- Alerts ----------------------------------------------------------------

  app.get("/v1/alerts/active", async (req, res) => {
    const units = parseUnitFilter(req);
    const alerts = await getActiveAlerts(pool, units);
    res.json({ count: alerts.length, alerts });
  });

  app.get("/v1/alerts", async (req, res) => {
    const from = parseTimeParam(req, res, "from");
    if (!from) return;
    const to = parseTimeParam(req, res, "to");
    if (!to) return;
    if (from.getTime() >= to.getTime()) {
      res.status(400).json({ error: "'from' must be before 'to'" });
      return;
    }
    const alerts = await getAlertHistory(pool, {
      from,
      to,
      unitIds: parseUnitFilter(req),
    });
    res.json({ count: alerts.length, alerts });
  });

  // ---- Window detail ----------------------------------------------------------

  app.get("/v1/windows", async (req, res) => {
    const from = parseTimeParam(req, res, "from");
    if (!from) return;
    const to = parseTimeParam(req, res, "to");
    if (!to) return;
    if (from.getTime() >= to.getTime()) {
      res.status(400).json({ error: "'from' must be before 'to'" });
      return;
    }
    const windows = await getWindows(pool, data.thresholds.window_minutes, {
      from,
      to,
      unitIds: parseUnitFilter(req),
    });
    res.json({ count: windows.length, windows });
  });

  app.get("/v1/units/:unitId/windows", async (req, res) => {
    const unit = data.units.get(req.params.unitId);
    if (!unit) {
      res.status(404).json({ error: `unknown unit ${req.params.unitId}` });
      return;
    }
    const from = parseTimeParam(req, res, "from");
    if (!from) return;
    const to = parseTimeParam(req, res, "to");
    if (!to) return;
    if (from.getTime() >= to.getTime()) {
      res.status(400).json({ error: "'from' must be before 'to'" });
      return;
    }
    const windows = await getWindows(pool, data.thresholds.window_minutes, {
      from,
      to,
      unitIds: [unit.unit_id],
    });
    res.json({ count: windows.length, windows });
  });

  // ---- Persisted readings ------------------------------------------------------

  app.get("/v1/readings", async (req, res) => {
    const from = parseTimeParam(req, res, "from");
    if (!from) return;
    const to = parseTimeParam(req, res, "to");
    if (!to) return;
    if (from.getTime() >= to.getTime()) {
      res.status(400).json({ error: "'from' must be before 'to'" });
      return;
    }
    const readings = await getReadings(pool, {
      from,
      to,
      unitIds: parseUnitFilter(req),
    });
    res.json({ count: readings.length, readings });
  });

  // ---- Error handling ----------------------------------------------------------

  app.use((req, res) => {
    res.status(404).json({ error: `no route for ${req.method} ${req.path}` });
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      console.error("request failed:", err);
      if (err instanceof SyntaxError) {
        res.status(400).json({ error: "malformed request body" });
        return;
      }
      res.status(500).json({ error: "internal error" });
    },
  );

  return app;
}
