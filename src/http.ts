import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Pool } from "pg";
import type { ReferenceData } from "./config.js";
import { IngestionService } from "./ingestion.js";
import { QueryService } from "./queries.js";
import { validateTelemetry } from "./validation.js";

const MAX_BODY_BYTES = 4 * 1024 * 1024;

export interface HttpDeps {
  pool: Pool;
  ref: ReferenceData;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`payload too large (limit ${MAX_BODY_BYTES} bytes)`));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function parseDateParam(value: string | null, name: string): Date | null {
  if (value === null || value === undefined) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new Error(`invalid ${name} (use RFC 3339 date-time)`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`invalid ${name}`);
  return date;
}

export function createApp({ pool, ref }: HttpDeps): Server {
  const ingestion = new IngestionService(pool, ref);
  const queries = new QueryService(pool);

  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      const path = url.pathname.replace(/\/+$/, "") || "/";
      const method = request.method ?? "GET";

      if (method === "GET" && path === "/health") {
        await pool.query("SELECT 1");
        sendJson(response, 200, {
          status: "ok",
          database: "up",
          units: ref.units.size,
          sensors: ref.sensors.size,
          time: new Date().toISOString(),
        });
        return;
      }

      if (method === "POST" && path === "/ingest") {
        const body = await readBody(request);
        if (body.trim() === "") {
          sendJson(response, 400, { error: "empty body: expected NDJSON telemetry lines" });
          return;
        }
        const { accepted, rejected } = validateTelemetry(body, ref.sensors);
        const result = await ingestion.ingest(accepted);
        sendJson(response, 200, {
          batch_id: result.batch_id,
          received: accepted.length + rejected.length,
          accepted: result.accepted,
          rejected: [...rejected, ...result.rejected].sort((a, b) => a.line - b.line),
          recomputed_units: result.recomputed_units,
        });
        return;
      }

      const unitMatch = /^\/units\/([^/]+)\/risk$/.exec(path);
      if (method === "GET" && unitMatch) {
        const unitId = decodeURIComponent(unitMatch[1]!);
        if (!ref.units.has(unitId)) {
          sendJson(response, 404, { error: `unknown unit ${unitId}` });
          return;
        }
        const current = await queries.currentRisk(unitId);
        sendJson(response, 200, { unit_id: unitId, current: current ?? null });
        return;
      }

      const windowsMatch = /^\/units\/([^/]+)\/windows$/.exec(path);
      if (method === "GET" && windowsMatch) {
        const unitId = decodeURIComponent(windowsMatch[1]!);
        if (!ref.units.has(unitId)) {
          sendJson(response, 404, { error: `unknown unit ${unitId}` });
          return;
        }
        const from = parseDateParam(url.searchParams.get("from"), "from");
        const to = parseDateParam(url.searchParams.get("to"), "to");
        if (!from || !to) {
          sendJson(response, 400, { error: "both 'from' and 'to' RFC 3339 query params are required" });
          return;
        }
        if (from >= to) {
          sendJson(response, 400, { error: "'from' must be before 'to'" });
          return;
        }
        const windows = await queries.windowsInRange(unitId, from, to);
        sendJson(response, 200, { unit_id: unitId, windows });
        return;
      }

      if (method === "GET" && path === "/alerts/active") {
        const unitId = url.searchParams.get("unit_id");
        if (unitId !== null && !ref.units.has(unitId)) {
          sendJson(response, 404, { error: `unknown unit ${unitId}` });
          return;
        }
        sendJson(response, 200, { alerts: await queries.activeAlerts(unitId) });
        return;
      }

      if (method === "GET" && path === "/alerts/history") {
        const unitId = url.searchParams.get("unit_id");
        if (unitId !== null && !ref.units.has(unitId)) {
          sendJson(response, 404, { error: `unknown unit ${unitId}` });
          return;
        }
        const from = parseDateParam(url.searchParams.get("from"), "from");
        const to = parseDateParam(url.searchParams.get("to"), "to");
        if ((from && !to) || (!from && to)) {
          sendJson(response, 400, { error: "provide both 'from' and 'to', or neither" });
          return;
        }
        if (from && to && from >= to) {
          sendJson(response, 400, { error: "'from' must be before 'to'" });
          return;
        }
        sendJson(response, 200, { alerts: await queries.alertHistory(unitId, from ?? undefined, to ?? undefined) });
        return;
      }

      sendJson(response, 404, { error: "not found" });
    } catch (error) {
      const message = (error as Error).message;
      if (message.startsWith("invalid ") || message.startsWith("payload too large")) {
        sendJson(response, 400, { error: message });
        return;
      }
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "internal error", detail: message }));
    }
  });
}
