import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg, { type Pool } from "pg";
import pool from "../src/config/database.ts";
import { withTransaction } from "../src/config/database.ts";
import {
  createJunction,
  getJunctionById,
  getQueues,
  listJunctions,
  lockJunction,
  updateJunctionState,
  updateQueueCount,
} from "../src/models/junction.model.ts";
import {
  getActiveSensorVehicles,
  getLatestSensorSequence,
  getLatestSensorTimestamp,
  getSensorEventById,
  insertSensorEvent,
  listSensorEvents,
  updateSensorEventStatus,
} from "../src/models/sensor.model.ts";
import {
  createCommand,
  getCommandById,
  listCommands,
  updateCommandStatus,
} from "../src/models/command.model.ts";
import {
  createControllerEvent,
  getControllerEventById,
  listControllerEvents,
} from "../src/models/controller-event.model.ts";
import {
  appendHistory,
  getHistory,
  getHistoryEntryById,
} from "../src/models/history.model.ts";

const psqlPath = "C:\\Program Files\\PostgreSQL\\18\\bin\\psql.exe";
const databaseName = `factory_traffic_qa_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
const adminPool = new pg.Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});
const psqlEnv = { ...process.env, PGPASSWORD: process.env.DB_PASSWORD };
const evidence: Record<string, unknown> = {};
let testPool: Pool | undefined;
let databaseCreated = false;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function psql(args: string[]) {
  const result = spawnSync(psqlPath, [
    "-X", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose", "-P", "pager=off",
    "-h", process.env.DB_HOST ?? "127.0.0.1",
    "-p", process.env.DB_PORT ?? "5432",
    "-U", process.env.DB_USER ?? "postgres",
    "-d", databaseName,
    ...args,
  ], { encoding: "utf8", env: psqlEnv });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

function assertRejected(label: string, sql: string, expectedCode: string) {
  const result = psql(["-c", sql]);
  assert(result.status !== 0, `${label}: invalid row unexpectedly accepted`);
  assert(result.stderr.includes(expectedCode), `${label}: expected SQLSTATE ${expectedCode}, received ${result.stderr}`);
  return result.stderr.split("\n").find((line) => line.includes(expectedCode)) ?? result.stderr;
}

try {
  await adminPool.query(`CREATE DATABASE ${databaseName}`);
  databaseCreated = true;

  const backendDirectory = resolve(fileURLToPath(import.meta.url), "../..");
  const schemaFile = resolve(backendDirectory, "sql/001_initial_schema.sql");
  const seedFile = resolve(backendDirectory, "sql/002_seed_data.sql");
  const schemaResult = psql(["-f", schemaFile]);
  assert(schemaResult.status === 0, `Schema script failed: ${schemaResult.stderr}`);
  const seedResult = psql(["-f", seedFile]);
  assert(seedResult.status === 0, `Seed script failed: ${seedResult.stderr}`);
  const seededRowsResult = psql(["-F", "|", "-A", "-t", "-c", "SELECT j.id, j.name, q.direction, q.queue_count FROM junctions j JOIN junction_queues q ON q.junction_id = j.id ORDER BY q.direction"]);
  const seededRows = seededRowsResult.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  assert(seededRows.length === 4, `Expected four seed queue rows, got ${seededRows.length}`);
  assert(seededRows.every((line) => line.startsWith("A|Junction A|") && line.endsWith("|0")), "Seed data does not match Junction A and four zero queues");
  evidence.schema = { exitCode: schemaResult.status, output: schemaResult.stdout };
  evidence.seed = { exitCode: seedResult.status, rows: seededRows };

  const catalogResult = psql(["-F", "|", "-A", "-c", "SELECT c.conname, c.contype, pg_get_constraintdef(c.oid) FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid WHERE t.relname IN ('sensor_events','traffic_commands','junction_queues') ORDER BY t.relname, c.conname"]);
  assert(catalogResult.status === 0, `Catalog query failed: ${catalogResult.stderr}`);
  for (const required of ["UNIQUE (event_id)", "UNIQUE (command_id)", "CHECK ((queue_count >= 0))", "PRIMARY KEY (junction_id, direction)"]) {
    assert(catalogResult.stdout.includes(required), `Missing constraint ${required}: ${catalogResult.stdout}`);
  }
  const duplicateEventInsert = "INSERT INTO sensor_events (event_id,junction_id,direction,event_type) VALUES ('qa-duplicate-event','A','NORTH','ARRIVED')";
  assert(psql(["-c", duplicateEventInsert]).status === 0, "First event_id insert failed");
  const duplicateEventError = assertRejected("duplicate event_id", duplicateEventInsert, "23505");
  const duplicateCommandInsert = "INSERT INTO traffic_commands (command_id,junction_id,command) VALUES ('qa-duplicate-command','A','TEST')";
  assert(psql(["-c", duplicateCommandInsert]).status === 0, "First command_id insert failed");
  const duplicateCommandError = assertRejected("duplicate command_id", duplicateCommandInsert, "23505");
  const negativeQueueError = assertRejected("negative queue_count", "UPDATE junction_queues SET queue_count = -1 WHERE junction_id = 'A' AND direction = 'NORTH'", "23514");
  evidence.constraints = { catalog: catalogResult.stdout, duplicateEventError, duplicateCommandError, negativeQueueError };

  testPool = new pg.Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    database: databaseName,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    max: 30,
  });
  const isolatedPool = testPool;
  const client = await isolatedPool.connect();
  try {
    const junction = await getJunctionById("A", client);
    const junctionList = await listJunctions(client);
    const queueRows = await getQueues("A", client);
    assert(junction?.name === "Junction A" && junctionList.length === 1 && queueRows.length === 4, "Junction read/list failed");
    const createdJunction = await createJunction(client, "QA-MODEL", "Model Test Junction");
    assert(createdJunction.id === "QA-MODEL", "Junction create failed");
    assert((await listJunctions(client)).some((row) => row.id === "QA-MODEL"), "Created junction missing from list");
    await updateJunctionState(client, "A", "MANUAL", "EAST_WEST", "ONLINE");
    assert((await getJunctionById("A", client))?.mode === "MANUAL", "Junction update failed");
    await updateJunctionState(client, "A", "AUTOMATIC", "NORTH_SOUTH", "ONLINE");

    const eventInput = {
      eventId: "qa-model-event",
      junctionId: "A",
      direction: "NORTH",
      eventType: "ARRIVED",
      vehicleId: "qa-vehicle",
      vehicleType: "CAR",
      sequenceNo: 71,
      sensorTimestamp: new Date(),
    };
    const sensorInsert = await insertSensorEvent(eventInput, client);
    assert(sensorInsert?.event_id === eventInput.eventId, "Sensor insert failed");
    assert((await getSensorEventById(eventInput.eventId, client))?.id === sensorInsert.id, "Sensor read failed");
    assert((await getLatestSensorSequence("A", "NORTH", client)) === 71, "Sensor sequence read failed");
    assert((await getLatestSensorTimestamp("A", "NORTH", client)) !== null, "Sensor timestamp read failed");
    assert((await getActiveSensorVehicles("A", client)).some((vehicle) => vehicle.vehicle_id === "qa-vehicle"), "Active sensor vehicle list failed");
    assert((await listSensorEvents("A", 20, client)).some((row) => row.event_id === eventInput.eventId), "Sensor list failed");
    assert((await updateSensorEventStatus(eventInput.eventId, "REVIEWED", client))?.status === "REVIEWED", "Sensor update failed");
    assert(await insertSensorEvent(eventInput, client) === undefined, "Idempotent sensor duplicate did not return no row");

    const command = await createCommand({ commandId: "qa-model-command", junctionId: "A", command: "SET_SIGNALS", direction: "NORTH_SOUTH", requestedState: "YELLOW" }, client);
    assert((await getCommandById(command.command_id, client))?.id === command.id, "Command read failed");
    assert((await listCommands("A", 20, client)).some((row) => row.command_id === command.command_id), "Command list failed");
    assert((await updateCommandStatus(command.command_id, "ACKNOWLEDGED", true, client))?.status === "ACKNOWLEDGED", "Command update failed");

    const controllerEvent = await createControllerEvent({ commandId: command.command_id, junctionId: "A", status: "ACKNOWLEDGED", actualState: "YELLOW" }, client);
    assert((await getControllerEventById(controllerEvent.id, client))?.id === controllerEvent.id, "Controller event read failed");
    assert((await listControllerEvents("A", 20, client)).some((row) => row.id === controllerEvent.id), "Controller event create/list failed");
    const history = await appendHistory({ junctionId: "A", eventType: "QA_MODEL_TEST", commandId: command.command_id, details: { checked: true } }, client);
    assert((await getHistoryEntryById(history.id, client))?.id === history.id, "History read failed");
    assert((await getHistory("A", 20, client)).some((row) => row.id === history.id), "History create/list failed");
    await updateQueueCount(client, "A", "NORTH", 1);
    assert((await getQueues("A", client)).find((row) => row.direction === "NORTH")?.queue_count === 1, "Queue update failed");
    evidence.models = {
      junction: "create/read/update/list/queue update PASS",
      sensor: "insert/read/update/list/latest sequence/latest timestamp/active list/idempotency PASS",
      command: "create/read/list/update PASS",
      controllerEvent: "create/read/list PASS (append-only; update intentionally unsupported)",
      history: "append/read/list PASS (append-only audit table; update intentionally unsupported)",
    };
  } finally {
    client.release();
  }

  const psqlSetCount = psql(["-c", "UPDATE junction_queues SET queue_count = 3 WHERE junction_id = 'A' AND direction = 'NORTH'"]);
  assert(psqlSetCount.status === 0, `Failed to set queue count for concurrency test: ${psqlSetCount.stderr}`);
  const decrementClients = await Promise.all(Array.from({ length: 20 }, () => isolatedPool.connect()));
  const decrementResults = await Promise.all(decrementClients.map(async (parallelClient) => {
    try {
      return await updateQueueCount(parallelClient, "A", "NORTH", -1);
    } finally {
      parallelClient.release();
    }
  }));
  const finalCount = await isolatedPool.query<{ queue_count: number }>("SELECT queue_count FROM junction_queues WHERE junction_id = $1 AND direction = $2", ["A", "NORTH"]);
  const observedCounts = decrementResults.map((row) => row?.queue_count);
  assert(observedCounts.every((count) => count !== undefined && count >= 0), `A concurrent decrement observed a negative or missing count: ${observedCounts}`);
  assert(finalCount.rows[0]?.queue_count === 0, `Parallel queue decrement ended at ${finalCount.rows[0]?.queue_count}`);
  evidence.parallelDecrements = {
    attempted: 20,
    startingCount: 3,
    minObservedCount: Math.min(...observedCounts as number[]),
    finalCount: finalCount.rows[0]?.queue_count,
    successfulUpdates: decrementResults.filter(Boolean).length,
  };

  const rollbackToken = randomUUID();
  let rollbackThrown = false;
  try {
    await withTransaction(async (transactionClient) => {
      await transactionClient.query("INSERT INTO audit_logs (junction_id,event_type,details) VALUES ($1,$2,$3::jsonb)", ["A", "QA_ROLLBACK_PROBE", JSON.stringify({ token: rollbackToken })]);
      await transactionClient.query("INSERT INTO traffic_commands (command_id,junction_id,command) VALUES ($1,$2,$3)", ["qa-model-command", "A", "FORCED_CONSTRAINT_ERROR"]);
    }, isolatedPool);
  } catch {
    rollbackThrown = true;
  }
  const partialRows = await testPool.query<{ count: string }>("SELECT count(*)::text AS count FROM audit_logs WHERE junction_id = $1 AND event_type = $2 AND details->>'token' = $3", ["A", "QA_ROLLBACK_PROBE", rollbackToken]);
  assert(rollbackThrown && partialRows.rows[0]?.count === "0", "Transaction did not roll back partial audit row");
  evidence.rollback = { errorForcedBy: "duplicate command_id unique violation", transactionRejected: rollbackThrown, partialRowsRemaining: Number(partialRows.rows[0]?.count) };

  const lockClient1 = await testPool.connect();
  const lockClient2 = await testPool.connect();
  try {
    await lockClient1.query("BEGIN");
    await lockJunction(lockClient1, "A");
    const secondPid = await lockClient2.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    let acquired = false;
    const waitingLock = lockJunction(lockClient2, "A").then(() => { acquired = true; });
    let observedWaiting = false;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const activity = await adminPool.query<{ wait_event_type: string | null }>(
        "SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1",
        [secondPid.rows[0]?.pid],
      );
      if (activity.rows[0]?.wait_event_type === "Lock") {
        observedWaiting = true;
        break;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    }
    assert(observedWaiting && !acquired, "Second SELECT FOR UPDATE did not block while the first row lock was held");
    await lockClient1.query("COMMIT");
    await waitingLock;
    evidence.rowLock = { firstClientHeldLock: true, secondWaitEvent: "Lock", secondAcquiredAfterCommit: acquired };
  } finally {
    await lockClient1.query("ROLLBACK").catch(() => undefined);
    lockClient1.release();
    lockClient2.release();
  }

  console.log(JSON.stringify({ database: databaseName, checks: evidence }, null, 2));
} finally {
  await testPool?.end();
  await adminPool.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1", [databaseName]).catch(() => undefined);
  if (databaseCreated) await adminPool.query(`DROP DATABASE ${databaseName}`).catch((error) => console.error("Could not drop disposable test DB", error));
  await adminPool.end();
  await pool.end();
}
