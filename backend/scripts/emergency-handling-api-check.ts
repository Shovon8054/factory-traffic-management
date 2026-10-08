import "dotenv/config";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import request from "supertest";

const databaseName = `factory_emergency_api_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const adminPool = new pg.Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});
const mockCommands: Array<{ command_id: string; junction_id: string; phase: string; step: string }> = [];
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
  if (address === null || typeof address === "string") throw new Error("Could not allocate TCP port");
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
  const command = JSON.parse(body) as typeof mockCommands[number];
  mockCommands.push(command);
  outgoing.writeHead(200, { "content-type": "application/json" }).end("{}");

  ackJobs.push((async () => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
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
        if (!response.ok) throw new Error(`ACK failed (${response.status}): ${await response.text()}`);
        return;
      } catch (error) {
        if (attempt === 99) throw error;
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
      // Wait for startup recovery to finish and open the API readiness gate.
    }
    await delay(100);
  }
  throw new Error(`Backend did not become ready: ${serverOutput}`);
}

async function waitForActualGreen(phase: "NORTH_SOUTH" | "EAST_WEST", timeoutMs = 15_000): Promise<Record<string, any>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await request(apiBase).get("/junctions/A/status");
    const state = response.body.state;
    if (response.status === 200 && state?.actual?.phase === phase && state?.actual?.step === "GREEN") return response.body;
    await delay(100);
  }
  throw new Error(`Timed out waiting for actual ${phase} GREEN; latest server output: ${serverOutput}`);
}

async function postEvent(eventId: string, direction: string, eventType: string, vehicleId: string, vehicleType?: string) {
  const response = await request(apiBase).post("/sensor-events").send({
    eventId,
    junctionId: "A",
    direction,
    eventType,
    vehicleId,
    ...(vehicleType === undefined ? {} : { vehicleType }),
    sensorTimestamp: new Date().toISOString(),
  });
  assert(response.status === 201, `Event ${eventId} failed (${response.status}): ${JSON.stringify(response.body)}`);
  return response;
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
  const client = await apiPool.connect();
  try {
    await client.query(await readFile("sql/001_initial_schema.sql", "utf8"));
    await client.query(await readFile("sql/002_seed_data.sql", "utf8"));
  } finally {
    client.release();
  }

  controller.listen(0, "127.0.0.1");
  await once(controller, "listening");
  const controllerAddress = controller.address();
  if (controllerAddress === null || typeof controllerAddress === "string") throw new Error("Mock controller failed to bind");
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
  await waitForActualGreen("NORTH_SOUTH");

  const firstId = `emergency-east-${randomUUID()}`;
  const secondId = `emergency-north-${randomUUID()}`;
  const thirdId = `emergency-east-bus-${randomUUID()}`;
  await postEvent(firstId, "EAST", "VEHICLE_ARRIVED", firstId, "EMERGENCY");
  const afterFirst = (await request(apiBase).get("/junctions/A/status")).body.state;
  assert(afterFirst.mode === "EMERGENCY" && afterFirst.desired.step === "YELLOW" && afterFirst.pendingPhase === "EAST_WEST", "First conflicting emergency did not start safe yellow transition");
  const firstEmergencyBeforeRefresh = afterFirst.emergencyRequests.find((emergency: { emergencyId: string }) => emergency.emergencyId === firstId);
  const repeatedEmergency = await request(apiBase).post("/sensor-events").send({
    eventId: firstId,
    junctionId: "A",
    direction: "EAST",
    eventType: "VEHICLE_ARRIVED",
    vehicleId: firstId,
    vehicleType: "EMERGENCY",
    sensorTimestamp: new Date().toISOString(),
  });
  const afterEmergencyRefresh = (await request(apiBase).get("/junctions/A/status")).body.state;
  const refreshedEmergency = afterEmergencyRefresh.emergencyRequests.find((emergency: { emergencyId: string }) => emergency.emergencyId === firstId);
  assert(repeatedEmergency.status === 200 && repeatedEmergency.body.duplicate === true, "Repeated emergency event did not return duplicate:true");
  assert(afterEmergencyRefresh.emergencyRequests.length === 1 && refreshedEmergency.lastSeenAt > firstEmergencyBeforeRefresh.lastSeenAt, "Emergency repeat did not refresh lastSeen only");
  assert(refreshedEmergency.receivedAt === firstEmergencyBeforeRefresh.receivedAt && refreshedEmergency.expiresAt === firstEmergencyBeforeRefresh.expiresAt, "Emergency repeat changed immutable queue metadata");

  await postEvent(secondId, "NORTH", "VEHICLE_ARRIVED", secondId, "EMERGENCY");
  const afterSecond = (await request(apiBase).get("/junctions/A/status")).body.state;
  assert(afterSecond.mode === "EMERGENCY" && afterSecond.pendingPhase === "EAST_WEST", "Second conflicting emergency interrupted the active emergency target");

  await postEvent(thirdId, "WEST", "VEHICLE_ARRIVED", thirdId, "EMERGENCY");
  const afterSamePhase = (await request(apiBase).get("/junctions/A/status")).body.state;
  assert(afterSamePhase.emergencyRequests.length === 3, "Emergency requests were not retained in FIFO state");
  assert(afterSamePhase.pendingPhase === "EAST_WEST", "Same-phase emergency changed the active target");
  await waitForActualGreen("EAST_WEST");

  const clearFirstId = `clear-${firstId}`;
  await postEvent(clearFirstId, "EAST", "VEHICLE_CLEARED", firstId);
  const afterClearFirst = (await request(apiBase).get("/junctions/A/status")).body.state;
  assert(afterClearFirst.mode === "EMERGENCY" && afterClearFirst.pendingPhase === "NORTH_SOUTH", "First clear did not promote queued conflicting emergency");
  await waitForActualGreen("NORTH_SOUTH");

  const clearSecondId = `clear-${secondId}`;
  await postEvent(clearSecondId, "NORTH", "VEHICLE_CLEARED", secondId);
  const afterClearSecond = (await request(apiBase).get("/junctions/A/status")).body.state;
  assert(afterClearSecond.mode === "EMERGENCY" && afterClearSecond.pendingPhase === "EAST_WEST", "Second clear did not promote remaining same-phase emergency");
  await waitForActualGreen("EAST_WEST");

  const clearThirdId = `clear-${thirdId}`;
  await postEvent(clearThirdId, "WEST", "VEHICLE_CLEARED", thirdId);
  const afterAllCleared = (await request(apiBase).get("/junctions/A/status")).body.state;
  assert(afterAllCleared.mode === "AUTOMATIC" && afterAllCleared.emergencyRequests.length === 0, "Mode did not return to AUTOMATIC after all emergencies cleared");

  const staleId = `stale-emergency-${randomUUID()}`;
  const commandResponse = await request(apiBase).post("/commands").send({
    type: "EMERGENCY_REQUEST",
    junctionId: "A",
    emergencyId: staleId,
    phase: "NORTH_SOUTH",
    occurredAt: Date.now(),
  });
  assert(commandResponse.status === 201, `Stale expiry setup failed: ${JSON.stringify(commandResponse.body)}`);
  const expiryDeadline = Date.now() + 31_000;
  let expiredState: Record<string, any> | undefined;
  while (Date.now() < expiryDeadline) {
    expiredState = (await request(apiBase).get("/junctions/A/status")).body.state;
    if (expiredState && !expiredState.emergencyRequests.some((emergency: { emergencyId: string }) => emergency.emergencyId === staleId)) break;
    await delay(250);
  }
  assert(expiredState?.mode === "AUTOMATIC" && !expiredState.emergencyRequests.some((emergency: { emergencyId: string }) => emergency.emergencyId === staleId), "Unrefreshed emergency did not expire back to AUTOMATIC");
  await Promise.all(ackJobs);

  const auditRows = (await apiPool.query(
    "SELECT event_type,details->>'emergencyId' AS emergency_id,details->>'vehicleId' AS vehicle_id,previous_state,new_state FROM audit_logs WHERE junction_id=$1 AND event_type IN ('EMERGENCY_DETECTED','EMERGENCY_QUEUED','SIGNAL_TRANSITION_STARTED','MODE_CHANGE','EMERGENCY_CLEARED','EMERGENCY_EXPIRED') ORDER BY id",
    ["A"],
  )).rows;
  const requiredNames = ["EMERGENCY_DETECTED", "SIGNAL_TRANSITION_STARTED", "MODE_CHANGE", "EMERGENCY_CLEARED", "EMERGENCY_EXPIRED"];
  for (const name of requiredNames) assert(auditRows.some((row) => row.event_type === name), `Audit event missing: ${name}`);
  const firstDetectedIndex = auditRows.findIndex((row) => row.event_type === "EMERGENCY_DETECTED" && row.emergency_id === firstId);
  const firstTransitionIndex = auditRows.findIndex((row) => row.event_type === "SIGNAL_TRANSITION_STARTED");
  const firstModeIndex = auditRows.findIndex((row) => row.event_type === "MODE_CHANGE" && row.new_state === "EMERGENCY");
  const firstClearIndex = auditRows.findIndex((row) => row.event_type === "EMERGENCY_CLEARED" && row.vehicle_id === firstId);
  assert(firstDetectedIndex < firstTransitionIndex && firstTransitionIndex < firstModeIndex && firstModeIndex < firstClearIndex, "Emergency audit order is not DETECTED -> TRANSITION_STARTED -> MODE_CHANGE -> CLEARED");

  console.log(JSON.stringify({
    liveApi: {
      firstConflictingEmergency: { mode: afterFirst.mode, desired: `${afterFirst.desired.phase}:${afterFirst.desired.step}`, pendingPhase: afterFirst.pendingPhase },
      repeatedEmergency: { httpStatus: repeatedEmergency.status, body: repeatedEmergency.body, requestCount: afterEmergencyRefresh.emergencyRequests.length, lastSeenUpdated: refreshedEmergency.lastSeenAt > firstEmergencyBeforeRefresh.lastSeenAt },
      conflictingSecondEmergencyQueued: { emergencyIds: afterSecond.emergencyRequests.map((emergency: { emergencyId: string }) => emergency.emergencyId), pendingPhase: afterSecond.pendingPhase },
      samePhaseEmergencyBatched: { count: afterSamePhase.emergencyRequests.length, pendingPhase: afterSamePhase.pendingPhase },
      clears: [afterClearFirst.mode, afterClearSecond.mode, afterAllCleared.mode],
      staleExpiry: expiredState?.mode,
      controllerCommands: mockCommands.map((command) => `${command.phase}:${command.step}`),
    },
    auditRows,
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
  if (dbCreated) await adminPool.query(`DROP DATABASE ${databaseName}`).catch((error) => console.error("Could not drop emergency API test DB", error));
  await adminPool.end();
}
