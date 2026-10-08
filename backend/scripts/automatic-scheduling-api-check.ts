import "dotenv/config";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import request from "supertest";
import { DEFAULT_JUNCTION_CONFIG } from "../src/services/traffic.service.ts";

const databaseName = `factory_schedule_api_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const adminPool = new pg.Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});
const controllerCommands: Array<{ command_id: string; phase: string; step: string }> = [];
const ackJobs: Promise<void>[] = [];
let apiBase = "";
let serverOutput = "";
let dbCreated = false;
let apiPool: pg.Pool | undefined;
let backend: ReturnType<typeof spawn> | undefined;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function freePort(): Promise<number> {
  const listener = net.createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  if (address === null || typeof address === "string") throw new Error("Could not allocate test port");
  await new Promise<void>((resolveClose, rejectClose) => listener.close((error) => error ? rejectClose(error) : resolveClose()));
  return address.port;
}

const controller = createServer(async (incoming, outgoing) => {
  if (incoming.method !== "POST" || incoming.url !== "/commands") {
    outgoing.writeHead(404).end();
    return;
  }
  let body = "";
  for await (const chunk of incoming) body += chunk.toString();
  const command = JSON.parse(body) as { command_id: string; junction_id: string; phase: string; step: string };
  controllerCommands.push({ command_id: command.command_id, phase: command.phase, step: command.step });
  outgoing.writeHead(200, { "content-type": "application/json" }).end("{}");
  ackJobs.push((async () => {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      try {
        const response = await fetch(`${apiBase}/controller-events`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            commandId: command.command_id,
            junctionId: command.junction_id,
            status: "ACKNOWLEDGED",
            actualState: command.step,
          }),
        });
        if (response.status === 503) {
          await delay(50);
          continue;
        }
        if (!response.ok) throw new Error(`Controller ACK failed ${response.status}: ${await response.text()}`);
        return;
      } catch (error) {
        if (attempt === 79) throw error;
        await delay(50);
      }
    }
  })());
});

async function waitReady(): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (backend?.exitCode !== null && backend?.exitCode !== undefined) {
      throw new Error(`Backend exited early (${backend.exitCode}): ${serverOutput}`);
    }
    try {
      const response = await fetch(`${apiBase}/junctions/A/status`);
      if (response.status === 200) return;
    } catch {
      // Continue until the child has completed startup recovery.
    }
    await delay(100);
  }
  throw new Error(`Backend did not become ready: ${serverOutput}`);
}

async function waitForEastWestGreen(): Promise<Record<string, any>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await request(apiBase).get("/junctions/A/status");
    if (response.status === 200) {
      const state = response.body.state;
      if (state?.desired?.phase === "EAST_WEST" && state?.desired?.step === "GREEN" &&
          state?.actual?.phase === "EAST_WEST" && state?.actual?.step === "GREEN") {
        return response.body;
      }
    }
    await delay(500);
  }
  throw new Error(`Automatic scheduler did not reach acknowledged EAST_WEST GREEN. Last log: ${serverOutput}`);
}

try {
  await adminPool.query(`CREATE DATABASE ${databaseName}`);
  dbCreated = true;
  apiPool = new pg.Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    database: databaseName,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  });
  const schemaClient = await apiPool.connect();
  try {
    await schemaClient.query(await (await import("node:fs/promises")).readFile("sql/001_initial_schema.sql", "utf8"));
    await schemaClient.query(await (await import("node:fs/promises")).readFile("sql/002_seed_data.sql", "utf8"));
  } finally {
    schemaClient.release();
  }

  controller.listen(0, "127.0.0.1");
  await once(controller, "listening");
  const controllerAddress = controller.address();
  if (controllerAddress === null || typeof controllerAddress === "string") throw new Error("Controller simulator failed to listen");
  const apiPort = await freePort();
  apiBase = `http://127.0.0.1:${apiPort}/api`;
  backend = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DB_NAME: databaseName,
      PORT: String(apiPort),
      TICK_INTERVAL_MS: "250",
      CONTROLLER_URL: `http://127.0.0.1:${controllerAddress.port}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  backend.stdout?.on("data", (chunk: Buffer) => { serverOutput += chunk.toString(); });
  backend.stderr?.on("data", (chunk: Buffer) => { serverOutput += chunk.toString(); });
  await waitReady();

  let status = await request(apiBase).get("/junctions/A/status");
  for (let attempt = 0; attempt < 30 && status.body.state?.actual?.step !== "GREEN"; attempt += 1) {
    await delay(250);
    status = await request(apiBase).get("/junctions/A/status");
  }
  assert(status.body.state?.actual?.phase === "NORTH_SOUTH" && status.body.state?.actual?.step === "GREEN", "Initial NORTH_SOUTH GREEN was not controller-confirmed");

  const eventIds: string[] = [];
  for (let index = 0; index < 3; index += 1) {
    const eventId = `live-east-car-${index}-${randomUUID()}`;
    eventIds.push(eventId);
    const response = await request(apiBase).post("/sensor-events").send({
      eventId,
      junctionId: "A",
      direction: "EAST",
      eventType: "VEHICLE_ARRIVED",
      vehicleId: `live-vehicle-${index}-${randomUUID()}`,
      vehicleType: "CAR",
      sensorTimestamp: new Date().toISOString(),
    });
    assert(response.status === 201, `EAST arrival ${index} rejected: ${response.status} ${JSON.stringify(response.body)}`);
  }

  const finalStatus = await waitForEastWestGreen();
  await Promise.all(ackJobs);
  const finalQueues = (await apiPool.query("SELECT direction,queue_count FROM junction_queues WHERE junction_id=$1 ORDER BY direction", ["A"])).rows;
  const eventRows = (await apiPool.query("SELECT event_id,direction,vehicle_type,status FROM sensor_events WHERE event_id=ANY($1::varchar[]) ORDER BY event_id", [eventIds])).rows;
  const transitionAudit = (await apiPool.query("SELECT event_type,previous_state,new_state FROM audit_logs WHERE junction_id=$1 AND event_type='TICK_TRANSITION' ORDER BY id", ["A"])).rows;
  const breakdown = {
    NORTH_SOUTH: { count: 0, score: 0 },
    EAST_WEST: {
      count: finalStatus.state.queueCounts.EAST + finalStatus.state.queueCounts.WEST,
      score: (finalStatus.state.queueCounts.EAST + finalStatus.state.queueCounts.WEST) * DEFAULT_JUNCTION_CONFIG.vehiclePriorityWeights.CAR,
    },
    margin: DEFAULT_JUNCTION_CONFIG.scoreSwitchMargin,
  };
  assert(breakdown.EAST_WEST.score - breakdown.NORTH_SOUTH.score >= breakdown.margin, "Live competing score did not clear switch margin");
  assert(finalQueues.find((row) => row.direction === "EAST")?.queue_count === 3, "Live DB EAST queue is not three");

  console.log(JSON.stringify({
    apiScenario: {
      name: "three EAST cars outrank empty active NORTH_SOUTH after minimum green",
      arrivals: { status: 201, eventRows },
      scoreCalculation: breakdown,
      desired: { phase: finalStatus.state.desired.phase, step: finalStatus.state.desired.step },
      actual: { phase: finalStatus.state.actual.phase, step: finalStatus.state.actual.step },
      controllerCommandSteps: controllerCommands.map((command) => `${command.phase}:${command.step}`),
      queues: finalQueues,
      auditTransitions: transitionAudit,
    },
  }, null, 2));
} finally {
  if (backend !== undefined && backend.exitCode === null) {
    backend.kill("SIGTERM");
    await Promise.race([once(backend, "exit"), delay(2_000)]);
    if (backend.exitCode === null) backend.kill("SIGKILL");
  }
  await Promise.all(ackJobs).catch(() => undefined);
  await apiPool?.end();
  await new Promise<void>((resolveClose) => controller.close(() => resolveClose()));
  await adminPool.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1", [databaseName]).catch(() => undefined);
  if (dbCreated) await adminPool.query(`DROP DATABASE ${databaseName}`).catch((error) => console.error("Could not drop scheduler API test DB", error));
  await adminPool.end();
}
