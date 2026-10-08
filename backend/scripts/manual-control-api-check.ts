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

interface TestReportItem {
  id: string;
  test: string;
  expected: string;
  actual: string;
  status: "PASS" | "FAIL";
  evidence: string;
}

const databaseName = `factory_manual_api_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const adminPool = new pg.Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

const observedSignals: Array<{ phase: string; step: string; timestamp: number }> = [];
const controllerCommands: Array<{ command_id: string; junction_id: string; phase: string; step: string }> = [];
const ackJobs: Promise<void>[] = [];
let apiBase = "";
let serverOutput = "";
let dbCreated = false;
let apiPool: pg.Pool | undefined;
let backend: ReturnType<typeof spawn> | undefined;

const report: TestReportItem[] = [];

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function freePort(): Promise<number> {
  const listener = net.createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  if (address === null || typeof address === "string") throw new Error("Could not allocate test port");
  await new Promise<void>((resolveClose, rejectClose) =>
    listener.close((error) => (error ? rejectClose(error) : resolveClose())),
  );
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
  controllerCommands.push(command);
  observedSignals.push({ phase: command.phase, step: command.step, timestamp: Date.now() });
  outgoing.writeHead(200, { "content-type": "application/json" }).end("{}");

  ackJobs.push(
    (async () => {
      // Simulate prompt ACK
      await delay(20);
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
            await delay(40);
            continue;
          }
          if (!response.ok) throw new Error(`Controller ACK failed ${response.status}: ${await response.text()}`);
          return;
        } catch (error) {
          if (attempt === 79) throw error;
          await delay(40);
        }
      }
    })(),
  );
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
      // Wait for server to bind
    }
    await delay(100);
  }
  throw new Error(`Backend did not become ready: ${serverOutput}`);
}

async function waitForActual(phase: "NORTH_SOUTH" | "EAST_WEST", step: "GREEN" | "YELLOW" | "ALL_RED", timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await request(apiBase).get("/junctions/A/status");
    if (response.status === 200) {
      const state = response.body.state;
      if (state?.actual?.phase === phase && state?.actual?.step === step) {
        return state;
      }
    }
    await delay(50);
  }
  throw new Error(`Timed out waiting for actual ${phase}:${step}`);
}

async function findAuditLogs(eventType: string, direction?: string) {
  assert(apiPool, "apiPool not initialized");
  const query = direction
    ? "SELECT id, junction_id, event_type, direction, previous_state, new_state, details FROM audit_logs WHERE junction_id = 'A' AND event_type = $1 AND direction = $2"
    : "SELECT id, junction_id, event_type, direction, previous_state, new_state, details FROM audit_logs WHERE junction_id = 'A' AND event_type = $1";
  const params = direction ? [eventType, direction] : [eventType];
  const res = await apiPool.query(query, params);
  return res.rows;
}

async function getRecentAuditLogs(junctionId = "A", limit = 10) {
  assert(apiPool, "apiPool not initialized");
  const res = await apiPool.query(
    "SELECT id, junction_id, event_type, direction, previous_state, new_state, details FROM audit_logs WHERE junction_id = $1 ORDER BY id DESC LIMIT $2",
    [junctionId, limit],
  );
  return res.rows;
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
      TICK_INTERVAL_MS: "100",
      YELLOW_DURATION_MS: "300",
      ALL_RED_DURATION_MS: "200",
      GREEN_DURATION_MS: "2000",
      MANUAL_TTL_MS: "1500",
      CONTROLLER_URL: `http://127.0.0.1:${controllerAddress.port}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  backend.stdout?.on("data", (chunk: Buffer) => { serverOutput += chunk.toString(); });
  backend.stderr?.on("data", (chunk: Buffer) => { serverOutput += chunk.toString(); });

  await waitReady();
  // Wait for initial startup recovery to reach NORTH_SOUTH GREEN
  await waitForActual("NORTH_SOUTH", "GREEN");

  // ==========================================
  // Test 1: MANUAL_GREEN_REQUEST for each direction: safe sequence to that phase, mode MANUAL
  // ==========================================
  {
    // Direction NORTH (maps to NORTH_SOUTH, currently GREEN)
    const resNorth = await request(apiBase).post("/junctions/A/commands").send({
      command: "MANUAL_GREEN_REQUEST",
      direction: "NORTH",
    });
    const status1 = (await request(apiBase).get("/junctions/A/status")).body.state;
    const auditNorth = await getRecentAuditLogs("A", 3);

    // Direction EAST (transition from NORTH_SOUTH -> EAST_WEST)
    const commandsBeforeEast = controllerCommands.length;
    const resEast = await request(apiBase).post("/junctions/A/commands").send({
      command: "MANUAL_GREEN_REQUEST",
      direction: "EAST",
    });
    // Wait for transition through YELLOW -> ALL_RED -> EAST_WEST:GREEN
    await waitForActual("EAST_WEST", "GREEN");
    const statusEast = (await request(apiBase).get("/junctions/A/status")).body.state;
    const commandsEast = controllerCommands.slice(commandsBeforeEast);
    const stepsEast = commandsEast.map((c) => `${c.phase}:${c.step}`);
    const auditEast = await getRecentAuditLogs("A", 5);

    // Direction WEST (maps to EAST_WEST, currently GREEN)
    const resWest = await request(apiBase).post("/junctions/A/commands").send({
      command: "MANUAL_GREEN_REQUEST",
      direction: "WEST",
    });

    // Direction SOUTH (transition from EAST_WEST -> NORTH_SOUTH)
    const commandsBeforeSouth = controllerCommands.length;
    const resSouth = await request(apiBase).post("/junctions/A/commands").send({
      command: "MANUAL_GREEN_REQUEST",
      direction: "SOUTH",
    });
    await waitForActual("NORTH_SOUTH", "GREEN");
    const statusSouth = (await request(apiBase).get("/junctions/A/status")).body.state;
    const commandsSouth = controllerCommands.slice(commandsBeforeSouth);
    const stepsSouth = commandsSouth.map((c) => `${c.phase}:${c.step}`);
    const auditSouth = await getRecentAuditLogs("A", 5);

    const auditEastLogs = await findAuditLogs("MANUAL_MODE_REQUEST", "EAST");
    const auditSouthLogs = await findAuditLogs("MANUAL_MODE_REQUEST", "SOUTH");
    const auditNorthLogs = await findAuditLogs("MANUAL_MODE_REQUEST", "NORTH");
    const auditWestLogs = await findAuditLogs("MANUAL_MODE_REQUEST", "WEST");

    const safeSequenceVerified =
      resNorth.status === 201 &&
      resEast.status === 201 &&
      resWest.status === 201 &&
      resSouth.status === 201 &&
      statusEast.actual.phase === "EAST_WEST" &&
      statusEast.mode === "MANUAL" &&
      stepsEast.includes("NORTH_SOUTH:YELLOW") &&
      stepsEast.includes("NORTH_SOUTH:ALL_RED") &&
      stepsEast.includes("EAST_WEST:GREEN") &&
      statusSouth.actual.phase === "NORTH_SOUTH" &&
      statusSouth.mode === "MANUAL" &&
      stepsSouth.includes("EAST_WEST:YELLOW") &&
      stepsSouth.includes("EAST_WEST:ALL_RED") &&
      stepsSouth.includes("NORTH_SOUTH:GREEN") &&
      auditNorthLogs.length > 0 &&
      auditEastLogs.length > 0 &&
      auditWestLogs.length > 0 &&
      auditSouthLogs.length > 0;

    report.push({
      id: "TEST-1",
      test: "MANUAL_GREEN_REQUEST for each direction (NORTH, EAST, WEST, SOUTH) with DB audit check",
      expected: "HTTP 201, safe sequence (GREEN -> YELLOW -> ALL_RED -> target GREEN), mode MANUAL, DB audit logs present",
      actual: `HTTP ${resNorth.status}/${resEast.status}/${resWest.status}/${resSouth.status}, mode=${statusSouth.mode}, stepsEast=[${stepsEast.join("->")}], stepsSouth=[${stepsSouth.join("->")}]`,
      status: safeSequenceVerified ? "PASS" : "FAIL",
      evidence: JSON.stringify({
        resEast: resEast.body,
        stepsEast,
        stepsSouth,
        auditRecent: auditSouth.slice(0, 3),
      }),
    });
  }

  // ==========================================
  // Test 2: Request for the phase that is already GREEN: no needless transition
  // ==========================================
  {
    // Currently at NORTH_SOUTH:GREEN
    const commandsCountBefore = controllerCommands.length;
    const resAlreadyGreen = await request(apiBase).post("/junctions/A/commands").send({
      command: "MANUAL_GREEN_REQUEST",
      direction: "NORTH",
    });
    await delay(300);
    const stateAfter = (await request(apiBase).get("/junctions/A/status")).body.state;
    const commandsAdded = controllerCommands.length - commandsCountBefore;
    const auditLogs = await getRecentAuditLogs("A", 3);
    const hasUnwantedTransitionAudit = auditLogs.some(
      (a) => a.event_type === "SIGNAL_TRANSITION_STARTED" && a.details?.newPhase?.includes("YELLOW"),
    );

    const pass2 =
      resAlreadyGreen.status === 201 &&
      commandsAdded === 0 &&
      stateAfter.desired.phase === "NORTH_SOUTH" &&
      stateAfter.desired.step === "GREEN" &&
      stateAfter.actual.phase === "NORTH_SOUTH" &&
      stateAfter.actual.step === "GREEN" &&
      !hasUnwantedTransitionAudit &&
      auditLogs[0].event_type === "MANUAL_MODE_REQUEST";

    report.push({
      id: "TEST-2",
      test: "Request for phase that is already GREEN (direction NORTH while NORTH_SOUTH:GREEN)",
      expected: "HTTP 201, 0 new controller transition commands, desired step remains GREEN, no transition audit",
      actual: `HTTP ${resAlreadyGreen.status}, newCommands=${commandsAdded}, desired=${stateAfter.desired.phase}:${stateAfter.desired.step}, auditTop=${auditLogs[0]?.event_type}`,
      status: pass2 ? "PASS" : "FAIL",
      evidence: JSON.stringify({
        state: stateAfter.desired,
        audit: auditLogs[0],
        newCommands: commandsAdded,
      }),
    });
  }

  // ==========================================
  // Test 3: RETURN_TO_AUTOMATIC: mode AUTOMATIC and the scheduler resumes
  // ==========================================
  {
    const resReturn = await request(apiBase).post("/junctions/A/commands").send({
      command: "RETURN_TO_AUTOMATIC",
    });
    const stateAfterReturn = (await request(apiBase).get("/junctions/A/status")).body.state;
    const auditReturn = await getRecentAuditLogs("A", 3);

    // Queue 3 cars on EAST approach to test scheduler resumption
    const carEventId = `sched-car-${randomUUID()}`;
    await request(apiBase).post("/sensor-events").send({
      eventId: carEventId,
      junctionId: "A",
      direction: "EAST",
      eventType: "ARRIVED",
      vehicleId: carEventId,
      vehicleType: "CAR",
      sensorTimestamp: new Date().toISOString(),
    });

    // Wait for automatic scheduler to switch to EAST_WEST
    await waitForActual("EAST_WEST", "GREEN", 8000);
    const stateAfterSwitch = (await request(apiBase).get("/junctions/A/status")).body.state;

    const pass3 =
      resReturn.status === 201 &&
      stateAfterReturn.mode === "AUTOMATIC" &&
      auditReturn.some((a) => a.event_type === "RETURN_TO_AUTOMATIC") &&
      auditReturn.some((a) => a.event_type === "MODE_CHANGE" && a.previous_state === "MANUAL" && a.new_state === "AUTOMATIC") &&
      stateAfterSwitch.mode === "AUTOMATIC" &&
      stateAfterSwitch.actual.phase === "EAST_WEST" &&
      stateAfterSwitch.actual.step === "GREEN";

    report.push({
      id: "TEST-3",
      test: "RETURN_TO_AUTOMATIC: mode AUTOMATIC and scheduler resumes automatic dispatch",
      expected: "HTTP 201, mode changes to AUTOMATIC, audit records MODE_CHANGE/RETURN_TO_AUTOMATIC, scheduler switches phase for waiting traffic",
      actual: `HTTP ${resReturn.status}, initialMode=${stateAfterReturn.mode}, switchedPhase=${stateAfterSwitch.actual.phase}:${stateAfterSwitch.actual.step}`,
      status: pass3 ? "PASS" : "FAIL",
      evidence: JSON.stringify({
        returnBody: resReturn.body,
        auditRecent: auditReturn.slice(0, 3),
        scheduledState: stateAfterSwitch.desired,
      }),
    });
  }

  // ==========================================
  // Test 4: Manual TTL expiry: auto-returns to automatic and audits it (use short TTL)
  // ==========================================
  {
    // MANUAL_TTL_MS is set to 1500ms
    const resManual = await request(apiBase).post("/junctions/A/commands").send({
      command: "MANUAL_GREEN_REQUEST",
      direction: "EAST",
    });
    const stateManual = (await request(apiBase).get("/junctions/A/status")).body.state;
    assert(stateManual.mode === "MANUAL", "Failed to enter manual mode for TTL test");

    // Wait for TTL (1500ms) + tick interval (100ms) to trigger expiry
    await delay(2200);

    const stateAfterTtl = (await request(apiBase).get("/junctions/A/status")).body.state;
    const auditTtl = await getRecentAuditLogs("A", 5);
    const modeTimeoutEntry = auditTtl.find((a) => a.event_type === "MODE_TIMEOUT");
    const modeChangeEntry = auditTtl.find(
      (a) => a.event_type === "MODE_CHANGE" && a.previous_state === "MANUAL" && a.new_state === "AUTOMATIC",
    );

    const pass4 =
      resManual.status === 201 &&
      stateAfterTtl.mode === "AUTOMATIC" &&
      modeTimeoutEntry !== undefined &&
      modeChangeEntry !== undefined;

    report.push({
      id: "TEST-4",
      test: "Manual TTL expiry: auto-returns to AUTOMATIC and audits MODE_TIMEOUT/MODE_CHANGE",
      expected: "Mode auto-reverts to AUTOMATIC after 1500ms TTL; DB audit records MODE_TIMEOUT and MODE_CHANGE",
      actual: `Initial mode=${stateManual.mode}, post-TTL mode=${stateAfterTtl.mode}, modeTimeoutAudited=${Boolean(modeTimeoutEntry)}, modeChangeAudited=${Boolean(modeChangeEntry)}`,
      status: pass4 ? "PASS" : "FAIL",
      evidence: JSON.stringify({
        stateAfterTtl: { mode: stateAfterTtl.mode },
        modeTimeoutEntry,
        modeChangeEntry,
      }),
    });
  }

  // ==========================================
  // Test 5: Two manual commands back to back, and in parallel: last wins, no conflicting GREEN
  // ==========================================
  {
    // 5a: Back to back commands
    // Currently at EAST_WEST:GREEN
    const resB2b1 = await request(apiBase).post("/junctions/A/commands").send({
      command: "MANUAL_GREEN_REQUEST",
      direction: "NORTH", // Wants NORTH_SOUTH
    });
    const resB2b2 = await request(apiBase).post("/junctions/A/commands").send({
      command: "MANUAL_GREEN_REQUEST",
      direction: "EAST", // Overrides: wants EAST_WEST
    });

    await delay(600);
    const stateB2b = (await request(apiBase).get("/junctions/A/status")).body.state;
    const auditB2b = await getRecentAuditLogs("A", 4);

    // 5b: Parallel commands
    const [resP1, resP2] = await Promise.all([
      request(apiBase).post("/junctions/A/commands").send({ command: "MANUAL_GREEN_REQUEST", direction: "NORTH" }),
      request(apiBase).post("/junctions/A/commands").send({ command: "MANUAL_GREEN_REQUEST", direction: "SOUTH" }),
    ]);

    await waitForActual("NORTH_SOUTH", "GREEN");
    const stateParallel = (await request(apiBase).get("/junctions/A/status")).body.state;

    // Check that observed signals NEVER showed conflicting green
    const conflictingSignals = observedSignals.filter(
      (s) => s.step === "GREEN" && (s.phase !== "NORTH_SOUTH" && s.phase !== "EAST_WEST"),
    );

    const pass5 =
      resB2b1.status === 201 &&
      resB2b2.status === 201 &&
      resP1.status === 201 &&
      resP2.status === 201 &&
      conflictingSignals.length === 0 &&
      stateParallel.actual.phase === "NORTH_SOUTH" &&
      stateParallel.actual.step === "GREEN";

    report.push({
      id: "TEST-5",
      test: "Two manual commands back-to-back and in parallel: last wins, zero conflicting GREEN",
      expected: "HTTP 201 for all, serialized without conflict, last wins, zero conflicting greens",
      actual: `B2B HTTP ${resB2b1.status}/${resB2b2.status}, Parallel HTTP ${resP1.status}/${resP2.status}, conflictingSignalsCount=${conflictingSignals.length}, finalPhase=${stateParallel.actual.phase}:${stateParallel.actual.step}`,
      status: pass5 ? "PASS" : "FAIL",
      evidence: JSON.stringify({
        b2bResults: [resB2b1.status, resB2b2.status],
        parallelResults: [resP1.status, resP2.status],
        finalActual: stateParallel.actual,
        auditRecent: auditB2b.slice(0, 2),
      }),
    });
  }

  // ==========================================
  // Test 6: Manual command during an active emergency: returns 409
  // ==========================================
  {
    // Post emergency request via /api/commands
    const emergencyId = `emg-${randomUUID()}`;
    const resEmg = await request(apiBase).post("/commands").send({
      type: "EMERGENCY_REQUEST",
      junctionId: "A",
      emergencyId,
      phase: "NORTH_SOUTH",
      occurredAt: Date.now(),
    });
    const stateEmg = (await request(apiBase).get("/junctions/A/status")).body.state;
    assert(stateEmg.mode === "EMERGENCY", `Expected EMERGENCY mode, got ${stateEmg.mode}`);

    // Attempt manual command during active emergency
    const resManualDuringEmg = await request(apiBase).post("/junctions/A/commands").send({
      command: "MANUAL_GREEN_REQUEST",
      direction: "EAST",
    });

    const resReturnDuringEmg = await request(apiBase).post("/junctions/A/commands").send({
      command: "RETURN_TO_AUTOMATIC",
    });

    const stateStillEmg = (await request(apiBase).get("/junctions/A/status")).body.state;
    const auditEmg = await getRecentAuditLogs("A", 3);
    const hasManualAuditDuringEmg = auditEmg.some(
      (a) => a.event_type === "MANUAL_MODE_REQUEST" && a.details?.newPhase?.includes("EAST_WEST"),
    );

    const pass6 =
      resEmg.status === 201 &&
      resManualDuringEmg.status === 409 &&
      resManualDuringEmg.body.error?.code === "EMERGENCY_ACTIVE" &&
      resReturnDuringEmg.status === 409 &&
      stateStillEmg.mode === "EMERGENCY" &&
      !hasManualAuditDuringEmg;

    report.push({
      id: "TEST-6",
      test: "Manual command during an active emergency returns HTTP 409 EMERGENCY_ACTIVE",
      expected: "HTTP 409, code EMERGENCY_ACTIVE, state remains EMERGENCY, no manual audit entry created",
      actual: `HTTP ${resManualDuringEmg.status}, code=${resManualDuringEmg.body?.error?.code}, mode=${stateStillEmg.mode}`,
      status: pass6 ? "PASS" : "FAIL",
      evidence: JSON.stringify({
        response: resManualDuringEmg.body,
        stateMode: stateStillEmg.mode,
      }),
    });

    // Clear emergency by waiting for expiry or returning to normal
    await request(apiBase).post("/commands").send({
      type: "RETURN_TO_AUTOMATIC",
      junctionId: "A",
    });
  }

  // ==========================================
  // Test 7: Invalid command name, missing direction, invalid direction: 400, state unchanged
  // ==========================================
  {
    const stateBefore7 = (await request(apiBase).get("/junctions/A/status")).body.state;
    const logsBefore7 = (await getRecentAuditLogs("A", 1))[0]?.id;

    // 7a: Invalid command name
    const resInvalidCmd = await request(apiBase).post("/junctions/A/commands").send({
      command: "NON_EXISTENT_COMMAND",
      direction: "NORTH",
    });

    // 7b: Missing direction for MANUAL_GREEN_REQUEST
    const resMissingDir = await request(apiBase).post("/junctions/A/commands").send({
      command: "MANUAL_GREEN_REQUEST",
    });

    // 7c: Invalid direction
    const resInvalidDir = await request(apiBase).post("/junctions/A/commands").send({
      command: "MANUAL_GREEN_REQUEST",
      direction: "SIDEWAYS",
    });

    const stateAfter7 = (await request(apiBase).get("/junctions/A/status")).body.state;
    const logsAfter7 = (await getRecentAuditLogs("A", 1))[0]?.id;

    const pass7 =
      resInvalidCmd.status === 400 &&
      resInvalidCmd.body.error?.code === "VALIDATION_ERROR" &&
      resMissingDir.status === 400 &&
      resMissingDir.body.error?.code === "VALIDATION_ERROR" &&
      resInvalidDir.status === 400 &&
      resInvalidDir.body.error?.code === "VALIDATION_ERROR" &&
      stateBefore7.mode === stateAfter7.mode &&
      stateBefore7.desired.phase === stateAfter7.desired.phase &&
      logsBefore7 === logsAfter7;

    report.push({
      id: "TEST-7",
      test: "Invalid command name, missing direction, invalid direction: 400, state unchanged",
      expected: "HTTP 400 VALIDATION_ERROR for all 3 bad inputs; junction state and DB audit logs unchanged",
      actual: `HTTP ${resInvalidCmd.status}/${resMissingDir.status}/${resInvalidDir.status}, stateUnchanged=${stateBefore7.desired.phase === stateAfter7.desired.phase}, newAuditRows=${logsAfter7 === logsBefore7 ? 0 : 1}`,
      status: pass7 ? "PASS" : "FAIL",
      evidence: JSON.stringify({
        invalidCmd: resInvalidCmd.body,
        missingDir: resMissingDir.body,
        invalidDir: resInvalidDir.body,
      }),
    });
  }

  // ==========================================
  // Test 8: Unknown junction: 404
  // ==========================================
  {
    const resUnknown = await request(apiBase).post("/junctions/NON_EXISTENT_JUNCTION/commands").send({
      command: "MANUAL_GREEN_REQUEST",
      direction: "NORTH",
    });

    const pass8 =
      resUnknown.status === 404 &&
      resUnknown.body.error?.code === "JUNCTION_NOT_FOUND";

    report.push({
      id: "TEST-8",
      test: "Unknown junction: returns 404 JUNCTION_NOT_FOUND",
      expected: "HTTP 404 with code JUNCTION_NOT_FOUND",
      actual: `HTTP ${resUnknown.status}, code=${resUnknown.body?.error?.code}`,
      status: pass8 ? "PASS" : "FAIL",
      evidence: JSON.stringify(resUnknown.body),
    });
  }

  // ==========================================
  // Test 9: Confirm no endpoint lets a client set a signal state directly
  // ==========================================
  {
    const probeEndpoints = [
      { method: "POST", url: "/junctions/A/signals", body: { direction: "NORTH", state: "GREEN" } },
      { method: "PUT", url: "/junctions/A/signals", body: { signals: { NORTH: "GREEN" } } },
      { method: "PATCH", url: "/junctions/A/signals", body: { state: "GREEN" } },
      { method: "POST", url: "/signals", body: { junctionId: "A", state: "GREEN" } },
      { method: "PUT", url: "/signals/NORTH", body: { state: "GREEN" } },
    ];

    const results: number[] = [];
    for (const probe of probeEndpoints) {
      const res = await request(apiBase)[probe.method.toLowerCase() as "post" | "put" | "patch"](probe.url).send(probe.body);
      results.push(res.status);
    }

    const all404 = results.every((status) => status === 404);

    report.push({
      id: "TEST-9",
      test: "Confirm no endpoint lets a client set a signal state directly",
      expected: "HTTP 404 on all arbitrary signal-setting routes; client cannot force signal colors",
      actual: `Probed ${probeEndpoints.length} endpoints; statuses=[${results.join(", ")}]`,
      status: all404 ? "PASS" : "FAIL",
      evidence: JSON.stringify({ probed: probeEndpoints.map((p, i) => `${p.method} ${p.url} => ${results[i]}`) }),
    });
  }

  // Print summary JSON
  console.log(JSON.stringify({ report }, null, 2));
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
  if (dbCreated) await adminPool.query(`DROP DATABASE ${databaseName}`).catch((error) => console.error("Could not drop test DB", error));
  await adminPool.end();
}
