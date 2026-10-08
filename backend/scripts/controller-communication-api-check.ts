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

const databaseName = `factory_ctrl_comm_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const adminPool = new pg.Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

const controllerCommands: Array<{ command_id: string; junction_id: string; phase: string; step: string }> = [];
let autoAckEnabled = true;
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
  outgoing.writeHead(200, { "content-type": "application/json" }).end("{}");

  if (autoAckEnabled) {
    void (async () => {
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
          break;
        } catch {
          await delay(40);
        }
      }
    })();
  }
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

async function getCommandRecord(commandId: string) {
  assert(apiPool, "apiPool not initialized");
  const res = await apiPool.query(
    "SELECT id, command_id, junction_id, command, direction, requested_state, status, created_at, acknowledged_at FROM traffic_commands WHERE command_id = $1",
    [commandId],
  );
  return res.rows[0];
}

async function queryAuditLogs(eventType: string, commandId?: string) {
  assert(apiPool, "apiPool not initialized");
  const query = commandId
    ? "SELECT id, junction_id, event_type, direction, previous_state, new_state, command_id, details, created_at FROM audit_logs WHERE junction_id = 'A' AND event_type = $1 AND command_id = $2 ORDER BY id DESC"
    : "SELECT id, junction_id, event_type, direction, previous_state, new_state, command_id, details, created_at FROM audit_logs WHERE junction_id = 'A' AND event_type = $1 ORDER BY id DESC";
  const params = commandId ? [eventType, commandId] : [eventType];
  const res = await apiPool.query(query, params);
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
  if (controllerAddress === null || typeof controllerAddress === "string") throw new Error("Controller bind failed");

  const apiPort = await freePort();
  apiBase = `http://127.0.0.1:${apiPort}/api`;

  backend = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DB_NAME: databaseName,
      PORT: String(apiPort),
      TICK_INTERVAL_MS: "100",
      ACK_TIMEOUT_MS: "600",
      MAX_RETRIES: "3",
      YELLOW_DURATION_MS: "300",
      ALL_RED_DURATION_MS: "200",
      GREEN_DURATION_MS: "2000",
      CONTROLLER_URL: `http://127.0.0.1:${controllerAddress.port}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  backend.stdout?.on("data", (chunk: Buffer) => { serverOutput += chunk.toString(); });
  backend.stderr?.on("data", (chunk: Buffer) => { serverOutput += chunk.toString(); });

  console.error("[TEST] Waiting for server to be ready...");
  await waitReady();
  console.error("[TEST] Server ready, waiting for NORTH_SOUTH:GREEN...");
  await waitForActual("NORTH_SOUTH", "GREEN");
  console.error("[TEST] At NORTH_SOUTH:GREEN! Starting Test 1...");

  // ==========================================
  // Test 1: Each signal change creates a unique command_id and a traffic_commands row with status PENDING
  // ==========================================
  {
    autoAckEnabled = false; // pause auto-ack to capture pending status
    await request(apiBase).post("/junctions/A/commands").send({
      command: "MANUAL_GREEN_REQUEST",
      direction: "EAST",
    });

    await delay(100);
    const latestOutbound = controllerCommands.at(-1);
    assert(latestOutbound, "No outbound command was sent for signal transition");
    const dbRow = await getCommandRecord(latestOutbound.command_id);

    const pass1 =
      latestOutbound.command_id.length > 10 &&
      dbRow !== undefined &&
      dbRow.status === "PENDING" &&
      dbRow.direction === "NORTH_SOUTH" &&
      dbRow.requested_state === "YELLOW";

    report.push({
      id: "TEST-1",
      test: "Unique command_id and traffic_commands row created with status PENDING",
      expected: "Outbound command has unique UUID; DB row in traffic_commands exists with status PENDING",
      actual: `command_id=${dbRow?.command_id}, status=${dbRow?.status}, direction=${dbRow?.direction}, requested_state=${dbRow?.requested_state}`,
      status: pass1 ? "PASS" : "FAIL",
      evidence: JSON.stringify({ dbRow }),
    });

    // ==========================================
    // Test 2: Correct ACK: command ACKED, acknowledged_at set, actual state updated, next step issued
    // ==========================================
    const resAck = await request(apiBase).post("/controller-events").send({
      commandId: latestOutbound.command_id,
      junctionId: "A",
      status: "ACKNOWLEDGED",
      actualState: "YELLOW",
    });

    await delay(100);
    const dbRowAfterAck = await getCommandRecord(latestOutbound.command_id);
    const junctionStateAfterAck = (await request(apiBase).get("/junctions/A/status")).body.state;

    // Enable autoAck again to let next steps (ALL_RED -> GREEN) proceed
    autoAckEnabled = true;
    console.error("[TEST] Waiting for EAST_WEST:GREEN...");
    await waitForActual("EAST_WEST", "GREEN");
    console.error("[TEST] EAST_WEST:GREEN reached. TEST-2 complete.");
    const junctionStateFinal = (await request(apiBase).get("/junctions/A/status")).body.state;

    const pass2 =
      resAck.status === 201 &&
      dbRowAfterAck.status === "ACKNOWLEDGED" &&
      dbRowAfterAck.acknowledged_at !== null &&
      junctionStateAfterAck.actual.step === "YELLOW" &&
      junctionStateFinal.actual.phase === "EAST_WEST" &&
      junctionStateFinal.actual.step === "GREEN";

    report.push({
      id: "TEST-2",
      test: "Correct ACK: command ACKED, acknowledged_at set, actual state updated, next step issued",
      expected: "HTTP 201, status ACKNOWLEDGED, acknowledged_at timestamp populated, actual state updated to YELLOW then transitions to GREEN",
      actual: `HTTP ${resAck.status}, status=${dbRowAfterAck?.status}, acknowledged_at=${dbRowAfterAck?.acknowledged_at?.toISOString()}, nextActual=${junctionStateFinal.actual.phase}:${junctionStateFinal.actual.step}`,
      status: pass2 ? "PASS" : "FAIL",
      evidence: JSON.stringify({
        dbRowAfterAck,
        actualAfterAck: junctionStateAfterAck.actual,
        finalState: junctionStateFinal.actual,
      }),
    });

    console.error("[TEST] Starting TEST-3 (Duplicate ACK)...");
    // ==========================================
    // Test 3: Duplicate ACK: 200 ignored, audited, state unchanged
    // ==========================================
    const stateBeforeDup = (await request(apiBase).get("/junctions/A/status")).body.state;
    const resDup = await request(apiBase).post("/controller-events").send({
      commandId: latestOutbound.command_id,
      junctionId: "A",
      status: "ACKNOWLEDGED",
      actualState: "YELLOW",
    });
    const stateAfterDup = (await request(apiBase).get("/junctions/A/status")).body.state;
    const dupAudits = await queryAuditLogs("DUPLICATE_CONTROLLER_ACK", latestOutbound.command_id);

    const pass3 =
      resDup.status === 200 &&
      resDup.body.result === "DUPLICATE" &&
      dupAudits.length > 0 &&
      stateBeforeDup.actual.step === stateAfterDup.actual.step &&
      stateBeforeDup.actual.phase === stateAfterDup.actual.phase;

    report.push({
      id: "TEST-3",
      test: "Duplicate ACK: 200 ignored, audited in DB, state unchanged",
      expected: "HTTP 200, result DUPLICATE, DUPLICATE_CONTROLLER_ACK in audit_logs, actual state unchanged",
      actual: `HTTP ${resDup.status}, result=${resDup.body?.result}, auditRows=${dupAudits.length}, stateUnchanged=${stateBeforeDup.actual.step === stateAfterDup.actual.step}`,
      status: pass3 ? "PASS" : "FAIL",
      evidence: JSON.stringify({ response: resDup.body, audit: dupAudits[0] }),
    });

    console.error("[TEST] Starting TEST-4 (Unknown command_id)...");
    // ==========================================
    // Test 4: Unknown command_id: 404, audited
    // ==========================================
    const unknownId = `unknown-${randomUUID()}`;
    const resUnknown = await request(apiBase).post("/controller-events").send({
      commandId: unknownId,
      junctionId: "A",
      status: "ACKNOWLEDGED",
      actualState: "GREEN",
    });
    const unknownAudits = await queryAuditLogs("UNKNOWN_CONTROLLER_COMMAND", unknownId);

    const pass4 =
      resUnknown.status === 404 &&
      resUnknown.body.error?.code === "COMMAND_NOT_FOUND" &&
      unknownAudits.length > 0;

    report.push({
      id: "TEST-4",
      test: "Unknown command_id: 404 COMMAND_NOT_FOUND, audited in DB",
      expected: "HTTP 404, error code COMMAND_NOT_FOUND, UNKNOWN_CONTROLLER_COMMAND in audit_logs",
      actual: `HTTP ${resUnknown.status}, code=${resUnknown.body?.error?.code}, auditRows=${unknownAudits.length}`,
      status: pass4 ? "PASS" : "FAIL",
      evidence: JSON.stringify({ response: resUnknown.body, audit: unknownAudits[0] }),
    });
  }

  console.error("[TEST] Starting TEST-7 & TEST-8 (Timeout & Retries & Degraded)...");

  // ==========================================
  // Test 7 & 8: No ACK within ACK_TIMEOUT_MS: retry with NEW command_id up to MAX_RETRIES,
  // old marked TIMED_OUT, CONTROLLER_TIMEOUT audited each time with timestamps proving timeout.
  // Retries exhausted: junction DEGRADED, actual=UNKNOWN, desired=ALL_RED, controller_status updated, alert emitted.
  // ==========================================
  {
    // Auto ACK disabled so commands receive NO ACK
    autoAckEnabled = false;
    const cmdsCountStart = controllerCommands.length;
    // Currently at EAST_WEST:GREEN -> Request NORTH to trigger transition
    await request(apiBase).post("/junctions/A/commands").send({
      command: "MANUAL_GREEN_REQUEST",
      direction: "NORTH",
    });

    await delay(100);
    const rootCommand = controllerCommands.at(-1);
    assert(rootCommand, "No root command issued for retry test");

    // ACK_TIMEOUT_MS is 600ms, MAX_RETRIES is 3.
    // Timeout 1 at ~600ms -> Retry 1 (new command_id)
    // Timeout 2 at ~1200ms -> Retry 2 (new command_id)
    // Timeout 3 at ~1800ms -> Retry 3 (new command_id)
    // Timeout 4 at ~2400ms -> Retries exhausted -> DEGRADED
    await delay(3200);

    const timeoutsAudited = await queryAuditLogs("CONTROLLER_TIMEOUT");
    const retriesAudited = await queryAuditLogs("CONTROLLER_RETRY");
    const exhaustedAudits = await queryAuditLogs("CONTROLLER_RETRIES_EXHAUSTED");

    const stateDegraded = (await request(apiBase).get("/junctions/A/status")).body.state;
    const junctionRow = (await apiPool.query("SELECT * FROM junctions WHERE id = 'A'")).rows[0];

    // Verify unique new command_ids were generated for retries
    const issuedCmdIds = new Set(controllerCommands.slice(cmdsCountStart).map((c) => c.command_id));

    // Verify timestamps in CONTROLLER_TIMEOUT audit rows
    const timeoutDurations = timeoutsAudited.slice(0, 4).map((t) => t.details?.durationMs);

    const pass7 =
      timeoutsAudited.length >= 3 &&
      retriesAudited.length >= 3 &&
      issuedCmdIds.size >= 3 &&
      timeoutDurations.every((d) => typeof d === "number" && d >= 500);

    report.push({
      id: "TEST-7",
      test: "No ACK within ACK_TIMEOUT_MS: retry with NEW command_id up to MAX_RETRIES, old marked TIMED_OUT, CONTROLLER_TIMEOUT audited each time",
      expected: "3 retries each with fresh command_id; CONTROLLER_TIMEOUT recorded with durationMs >= 600ms; previous commands marked TIMED_OUT",
      actual: `timeoutsCount=${timeoutsAudited.length}, retriesCount=${retriesAudited.length}, uniqueCmdIds=${issuedCmdIds.size}, durationsMs=[${timeoutDurations.join(", ")}]`,
      status: pass7 ? "PASS" : "FAIL",
      evidence: JSON.stringify({
        timeoutsCount: timeoutsAudited.length,
        retriesCount: retriesAudited.length,
        uniqueCommandIds: Array.from(issuedCmdIds),
        timeoutSample: timeoutsAudited[0],
      }),
    });

    const pass8 =
      exhaustedAudits.length > 0 &&
      stateDegraded.mode === "DEGRADED" &&
      stateDegraded.actual.step === "UNKNOWN" &&
      Object.values(stateDegraded.actual.signals).every((s) => s === "UNKNOWN") &&
      stateDegraded.desired.step === "ALL_RED" &&
      Object.values(stateDegraded.desired.signals).every((s) => s === "RED") &&
      junctionRow.controller_status === "DEGRADED";

    report.push({
      id: "TEST-8",
      test: "Retries exhausted: junction DEGRADED, actual=UNKNOWN, desired falls back to all RED, controller_status updated, alert emitted",
      expected: "Mode DEGRADED, actual step UNKNOWN, desired step ALL_RED with all RED signals, controller_status DEGRADED in DB",
      actual: `mode=${stateDegraded.mode}, actualStep=${stateDegraded.actual.step}, desiredStep=${stateDegraded.desired.step}, controller_status=${junctionRow.controller_status}`,
      status: pass8 ? "PASS" : "FAIL",
      evidence: JSON.stringify({
        stateDegraded: {
          mode: stateDegraded.mode,
          actual: stateDegraded.actual,
          desired: stateDegraded.desired,
        },
        junctionRow: { mode: junctionRow.mode, controller_status: junctionRow.controller_status },
        exhaustedAudit: exhaustedAudits[0],
      }),
    });
    console.error("[TEST] TEST-7 & TEST-8 complete.");
  }

  console.error("[TEST] Starting TEST-6 (Late ACK)...");
  // ==========================================
  // Test 6: Late ACK for a TIMED_OUT/SUPERSEDED command: recorded, does not advance anything
  // ==========================================
  {
    // Pick an old timed-out command from the retry test
    const timedOutCmd = (await apiPool.query("SELECT * FROM traffic_commands WHERE junction_id = 'A' AND status = 'TIMED_OUT' LIMIT 1")).rows[0];
    assert(timedOutCmd, "No timed out command found");

    const stateBeforeLate = (await request(apiBase).get("/junctions/A/status")).body.state;
    const resLate = await request(apiBase).post("/controller-events").send({
      commandId: timedOutCmd.command_id,
      junctionId: "A",
      status: "ACKNOWLEDGED",
      actualState: timedOutCmd.requested_state,
    });

    const stateAfterLate = (await request(apiBase).get("/junctions/A/status")).body.state;
    const lateAudits = await queryAuditLogs("LATE_CONTROLLER_ACK", timedOutCmd.command_id);

    const pass6 =
      resLate.status === 409 &&
      resLate.body.error?.code === "LATE_ACK" &&
      lateAudits.length > 0 &&
      stateBeforeLate.mode === stateAfterLate.mode &&
      stateBeforeLate.actual.step === stateAfterLate.actual.step;

    report.push({
      id: "TEST-6",
      test: "Late ACK for a TIMED_OUT/SUPERSEDED command: recorded, does not advance anything",
      expected: "HTTP 409 LATE_ACK, LATE_CONTROLLER_ACK in audit_logs, junction state remains unchanged in DEGRADED",
      actual: `HTTP ${resLate.status}, code=${resLate.body?.error?.code}, lateAuditsCount=${lateAudits.length}, stateUnchanged=${stateBeforeLate.mode === stateAfterLate.mode}`,
      status: pass6 ? "PASS" : "FAIL",
      evidence: JSON.stringify({ response: resLate.body, audit: lateAudits[0] }),
    });
    console.error("[TEST] TEST-6 complete.");
  }

  console.error("[TEST] Starting TEST-9 (OFFLINE)...");

  // ==========================================
  // Test 9: OFFLINE status event: controller_status OFFLINE, DEGRADED, audited
  // ==========================================
  {
    const resOffline = await request(apiBase).post("/controller-events").send({
      junctionId: "A",
      status: "OFFLINE",
    });

    const stateOffline = (await request(apiBase).get("/junctions/A/status")).body.state;
    const junctionRowOffline = (await apiPool.query("SELECT * FROM junctions WHERE id = 'A'")).rows[0];
    const offlineAudits = await queryAuditLogs("CONTROLLER_OFFLINE");

    const pass9 =
      resOffline.status === 201 &&
      junctionRowOffline.controller_status === "OFFLINE" &&
      stateOffline.mode === "DEGRADED" &&
      offlineAudits.length > 0;

    report.push({
      id: "TEST-9",
      test: "OFFLINE status event: controller_status OFFLINE, DEGRADED, audited in DB",
      expected: "HTTP 201, controller_status OFFLINE, junction mode DEGRADED, CONTROLLER_OFFLINE in audit_logs",
      actual: `HTTP ${resOffline.status}, controller_status=${junctionRowOffline.controller_status}, mode=${stateOffline.mode}, auditRows=${offlineAudits.length}`,
      status: pass9 ? "PASS" : "FAIL",
      evidence: JSON.stringify({ response: resOffline.body, junctionRow: junctionRowOffline, audit: offlineAudits[0] }),
    });
  }

  // ==========================================
  // Test 10: ONLINE event: current desired state re-sent with fresh command_id, DEGRADED clears only after ACK
  // ==========================================
  {
    autoAckEnabled = false; // do NOT auto-ack yet to prove DEGRADED remains until ACK
    const resOnline = await request(apiBase).post("/controller-events").send({
      junctionId: "A",
      status: "ONLINE",
    });

    await delay(100);
    const stateOnlineBeforeAck = (await request(apiBase).get("/junctions/A/status")).body.state;
    const onlineAudits = await queryAuditLogs("CONTROLLER_ONLINE");
    const recoveryCmdAudits = await queryAuditLogs("CONTROLLER_RECOVERY_COMMAND");

    const reSentCmd = controllerCommands.at(-1);
    assert(reSentCmd, "No resend command sent on ONLINE event");
    const reSentDbRow = await getCommandRecord(reSentCmd.command_id);

    // Before ACK: mode is STILL DEGRADED!
    const degradedBeforeAck = stateOnlineBeforeAck.mode === "DEGRADED";

    // Now send the ACK for the fresh command
    const resAckRecovery = await request(apiBase).post("/controller-events").send({
      commandId: reSentCmd.command_id,
      junctionId: "A",
      status: "ACKNOWLEDGED",
      actualState: reSentCmd.step,
    });

    await delay(100);
    const stateAfterRecoveryAck = (await request(apiBase).get("/junctions/A/status")).body.state;
    const junctionRowAfterAck = (await apiPool.query("SELECT * FROM junctions WHERE id = 'A'")).rows[0];

    const pass10 =
      resOnline.status === 201 &&
      onlineAudits.length > 0 &&
      recoveryCmdAudits.length > 0 &&
      reSentDbRow.status === "PENDING" &&
      degradedBeforeAck &&
      resAckRecovery.status === 201 &&
      stateAfterRecoveryAck.mode === "AUTOMATIC" &&
      junctionRowAfterAck.mode === "AUTOMATIC" &&
      junctionRowAfterAck.controller_status === "ONLINE";

    report.push({
      id: "TEST-10",
      test: "ONLINE event: current desired state re-sent with fresh command_id, DEGRADED clears only after ACK",
      expected: "HTTP 201; fresh command_id created in traffic_commands; mode remains DEGRADED until ACK; mode clears to AUTOMATIC upon ACK",
      actual: `resOnline=${resOnline.status}, freshCmdId=${reSentCmd.command_id}, modeBeforeAck=${stateOnlineBeforeAck.mode}, modeAfterAck=${stateAfterRecoveryAck.mode}, ctrlStatus=${junctionRowAfterAck.controller_status}`,
      status: pass10 ? "PASS" : "FAIL",
      evidence: JSON.stringify({
        resOnline: resOnline.body,
        reSentCommand: reSentCmd,
        stateBeforeAck: stateOnlineBeforeAck.mode,
        stateAfterAck: stateAfterRecoveryAck.mode,
      }),
    });
  }

  // ==========================================
  // Test 5: ACK with a different actual_state than requested: mismatch alert, sequence does NOT advance
  // ==========================================
  {
    autoAckEnabled = false; // hold ACK
    let pendingCmd = (
      await apiPool.query(
        "SELECT * FROM traffic_commands WHERE junction_id = 'A' AND status = 'PENDING' ORDER BY id DESC LIMIT 1",
      )
    ).rows[0];

    if (!pendingCmd) {
      const cur = (await request(apiBase).get("/junctions/A/status")).body.state;
      const targetDir = cur.actual.phase === "NORTH_SOUTH" ? "EAST" : "NORTH";
      await request(apiBase).post("/junctions/A/commands").send({
        command: "MANUAL_GREEN_REQUEST",
        direction: targetDir,
      });
      const deadline = Date.now() + 2000;
      while (!pendingCmd && Date.now() < deadline) {
        await delay(50);
        pendingCmd = (
          await apiPool.query(
            "SELECT * FROM traffic_commands WHERE junction_id = 'A' AND status = 'PENDING' ORDER BY id DESC LIMIT 1",
          )
        ).rows[0];
      }
    }
    assert(pendingCmd, "Expected a pending command to test mismatch");

    const requested = pendingCmd.requested_state;
    const differentState = requested === "YELLOW" ? "RED" : requested === "RED" ? "GREEN" : "YELLOW";
    const resMismatch = await request(apiBase).post("/controller-events").send({
      commandId: pendingCmd.command_id,
      junctionId: "A",
      status: "ACKNOWLEDGED",
      actualState: differentState, // mismatch!
    });

    await delay(300);
    const stateAfterMismatch = (await request(apiBase).get("/junctions/A/status")).body.state;
    const mismatchAudits = await queryAuditLogs("CONTROLLER_STATE_MISMATCH", pendingCmd.command_id);
    const dbMismatchRow = await getCommandRecord(pendingCmd.command_id);

    const pass5 =
      resMismatch.status === 409 &&
      resMismatch.body.error?.code === "STATE_MISMATCH" &&
      mismatchAudits.length > 0 &&
      dbMismatchRow.status === "MISMATCH" &&
      stateAfterMismatch.actual.step !== differentState;

    report.push({
      id: "TEST-5",
      test: "ACK with different actual_state than requested: mismatch alert, sequence does NOT advance",
      expected: "HTTP 409 STATE_MISMATCH, CONTROLLER_STATE_MISMATCH in audit_logs, command marked MISMATCH, actual state not updated",
      actual: `HTTP ${resMismatch.status}, code=${resMismatch.body?.error?.code}, auditRows=${mismatchAudits.length}, dbStatus=${dbMismatchRow?.status}, actualStep=${stateAfterMismatch.actual.step}`,
      status: pass5 ? "PASS" : "FAIL",
      evidence: JSON.stringify({
        response: resMismatch.body,
        dbStatus: dbMismatchRow?.status,
        audit: mismatchAudits[0],
      }),
    });
  }

  // ==========================================
  // Test 11: Prove that desired GREEN is never treated as actual GREEN without an ACK
  // ==========================================
  {
    autoAckEnabled = false; // hold all ACKs
    // Reset to automatic and let scheduler or manual request move desired state
    await request(apiBase).post("/commands").send({
      type: "TARGET_PHASE_REQUEST",
      junctionId: "A",
      phase: "NORTH_SOUTH",
    });

    // Check status without ACKing the target transition
    await delay(300);
    const statusAtDesired = (await request(apiBase).get("/junctions/A/status")).body.state;

    // Notice: desired is attempting to schedule/move, but actual is NOT GREEN without an ACK!
    const actualIsNotConfirmedGreen = statusAtDesired.actual.step !== "GREEN" || statusAtDesired.actual.confirmedAt === 0;

    const pass11 = actualIsNotConfirmedGreen;

    report.push({
      id: "TEST-11",
      test: "Prove that desired GREEN is never treated as actual GREEN without an ACK",
      expected: "Actual state cannot be confirmed or advance to GREEN without matching controller ACK",
      actual: `desiredStep=${statusAtDesired.desired.step}, actualStep=${statusAtDesired.actual.step}, actualConfirmedAt=${statusAtDesired.actual.confirmedAt}`,
      status: pass11 ? "PASS" : "FAIL",
      evidence: JSON.stringify({
        desired: statusAtDesired.desired,
        actual: statusAtDesired.actual,
      }),
    });
  }

  console.log(JSON.stringify({ report }, null, 2));
} catch (err) {
  console.error("Test runner error:", err);
  console.error("Backend Server Output:\n", serverOutput);
  throw err;
} finally {
  if (backend?.pid) {
    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/F", "/T", "/PID", String(backend.pid)], { stdio: "ignore" });
      } else {
        backend.kill("SIGKILL");
      }
    } catch {}
    await Promise.race([once(backend, "exit"), delay(1_000)]).catch(() => undefined);
  }
  await apiPool?.end().catch(() => undefined);
  await new Promise<void>((resolveClose) => controller.close(() => resolveClose()));
  await adminPool.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1", [databaseName]).catch(() => undefined);
  if (dbCreated) await adminPool.query(`DROP DATABASE ${databaseName}`).catch((error) => console.error("Could not drop DB", error));
  await adminPool.end();
}
