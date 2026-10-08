import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import request from "supertest";
import basePool from "../src/config/database.ts";

const dbName = `factory_sensor_e2e_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const adminPool = new pg.Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});
const psqlPath = "C:\\Program Files\\PostgreSQL\\18\\bin\\psql.exe";
const env = { ...process.env, PGPASSWORD: process.env.DB_PASSWORD };
const results: Array<Record<string, unknown>> = [];
let dbCreated = false;
let testPool: pg.Pool | undefined;
let server: ReturnType<typeof spawn> | undefined;
let serverOutput = "";
let baseUrl = "";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function psql(args: string[]) {
  const result = spawnSync(psqlPath, [
    "-X", "-v", "ON_ERROR_STOP=1", "-h", process.env.DB_HOST ?? "127.0.0.1",
    "-p", process.env.DB_PORT ?? "5432", "-U", process.env.DB_USER ?? "postgres",
    "-d", dbName, ...args,
  ], { encoding: "utf8", env });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

async function freePort(): Promise<number> {
  const listener = net.createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  if (address === null || typeof address === "string") throw new Error("Unable to get a free TCP port");
  await new Promise<void>((resolveClose, rejectClose) => listener.close((error) => error ? rejectClose(error) : resolveClose()));
  return address.port;
}

async function waitForServer(): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      throw new Error(`Test server exited early (${server.exitCode}): ${serverOutput}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/junctions`);
      if (response.status === 200) return;
    } catch {
      // Wait for the child server to bind its port.
    }
    await delay(100);
  }
  throw new Error(`Test server did not become ready: ${serverOutput}`);
}

async function dbSnapshot(eventIds: string[], directions: string[]) {
  const client = testPool!;
  const sensors = eventIds.length === 0
    ? []
    : (await client.query(
        "SELECT event_id, direction, vehicle_id, vehicle_type, status FROM sensor_events WHERE event_id = ANY($1::varchar[]) ORDER BY event_id",
        [eventIds],
      )).rows;
  const queues = (await client.query(
    "SELECT direction, queue_count FROM junction_queues WHERE junction_id = $1 ORDER BY direction",
    ["A"],
  )).rows;
  const audit = eventIds.length === 0
    ? []
    : (await client.query(
        "SELECT event_type, details->>'eventId' AS event_id, details->>'reason' AS reason FROM audit_logs WHERE junction_id = $1 AND details->>'eventId' = ANY($2::text[]) ORDER BY id",
        ["A", eventIds],
      )).rows;
  const selectedQueues = queues.filter((row) => directions.includes(row.direction));
  return { sensor_events: sensors, junction_queues: selectedQueues, audit_logs: audit };
}

function responseSummary(response: { status: number; body: Record<string, any> }) {
  const body = response.body;
  if (body.status === "ACCEPTED") {
    return { status: response.status, body: { status: body.status, queueCounts: body.state?.queueCounts } };
  }
  return { status: response.status, body };
}

async function recordCase(
  id: string,
  description: string,
  response: { status: number; body: Record<string, any> },
  eventIds: string[],
  directions: string[],
  verify: (snapshot: Awaited<ReturnType<typeof dbSnapshot>>) => void,
) {
  const rows = await dbSnapshot(eventIds, directions);
  verify(rows);
  results.push({ id, test: description, response: responseSummary(response), rows });
}

async function postSensor(body: unknown, raw = false) {
  const testRequest = request(baseUrl).post("/api/sensor-events");
  if (raw) return testRequest.set("Content-Type", "application/json").send(body as string);
  return testRequest.send(body as object);
}

try {
  await adminPool.query(`CREATE DATABASE ${dbName}`);
  dbCreated = true;
  testPool = new pg.Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    database: dbName,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    max: 30,
  });

  for (const schemaFile of ["sql/001_initial_schema.sql", "sql/002_seed_data.sql"]) {
    const applied = psql(["-f", schemaFile]);
    assert(applied.status === 0, `Failed applying ${schemaFile}: ${applied.stderr}`);
  }

  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DB_NAME: dbName,
      PORT: String(port),
      TICK_INTERVAL_MS: "60000",
      CONTROLLER_URL: "http://127.0.0.1:1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", (chunk: Buffer) => { serverOutput += chunk.toString(); });
  server.stderr?.on("data", (chunk: Buffer) => { serverOutput += chunk.toString(); });
  await waitForServer();

  const directions = ["NORTH", "SOUTH", "EAST", "WEST"] as const;
  const vehicleTypes = ["CAR", "MOTORCYCLE", "BUS", "TRUCK", "EMERGENCY", "EMPLOYEE_VEHICLE"] as const;
  const case1: Array<{ eventId: string; direction: string; vehicleType: string; response: any }> = [];
  for (const direction of directions) {
    for (const vehicleType of vehicleTypes) {
      const eventId = `all-${direction}-${vehicleType}`;
      const response = await postSensor({
        eventId,
        junctionId: "A",
        direction,
        eventType: "VEHICLE_ARRIVED",
        vehicleId: `vehicle-${eventId}`,
        vehicleType,
        sensorTimestamp: new Date(Date.now() + case1.length).toISOString(),
      });
      assert(response.status === 201, `Case 1 ${direction}/${vehicleType}: expected 201, got ${response.status} ${JSON.stringify(response.body)}`);
      case1.push({ eventId, direction, vehicleType, response });
    }
  }
  const case1Snapshot = await dbSnapshot(case1.map((item) => item.eventId), [...directions]);
  assert(case1Snapshot.sensor_events.length === 24, `Case 1 expected 24 sensor rows, got ${case1Snapshot.sensor_events.length}`);
  assert(case1Snapshot.audit_logs.filter((row) => row.event_type === "SENSOR_ACCEPTED").length === 24, "Case 1 expected 24 accepted audit rows");
  assert(case1Snapshot.junction_queues.every((row) => row.queue_count === 6), "Case 1 expected six arrivals per direction");
  for (const item of case1) {
    results.push({
      id: `1-${item.direction}-${item.vehicleType}`,
      test: "Valid VEHICLE_ARRIVED",
      eventId: item.eventId,
      response: responseSummary(item.response),
      rows: {
        sensor_events: case1Snapshot.sensor_events.filter((row) => row.event_id === item.eventId),
        junction_queues: case1Snapshot.junction_queues.filter((row) => row.direction === item.direction),
        audit_logs: case1Snapshot.audit_logs.filter((row) => row.event_id === item.eventId),
      },
    });
  }

  const duplicateEvent = `dup-${randomUUID()}`;
  const duplicateBody = {
    eventId: duplicateEvent,
    junctionId: "A",
    direction: "NORTH",
    eventType: "VEHICLE_ARRIVED",
    vehicleId: `vehicle-${duplicateEvent}`,
    vehicleType: "CAR",
    sensorTimestamp: new Date().toISOString(),
  };
  const queueBeforeDup = (await testPool.query<{ queue_count: number }>("SELECT queue_count FROM junction_queues WHERE junction_id=$1 AND direction=$2", ["A", "NORTH"])).rows[0]!.queue_count;
  const dupFirst = await postSensor(duplicateBody);
  const dupSecond = await postSensor(duplicateBody);
  assert(dupFirst.status === 201 && dupSecond.status === 200 && dupSecond.body.duplicate === true, "Case 2 response contract failed");
  await recordCase("2", "Same event_id submitted twice", dupSecond, [duplicateEvent], ["NORTH"], (rows) => {
    assert(rows.sensor_events.length === 1, `Expected one sensor row, got ${rows.sensor_events.length}`);
    assert(rows.audit_logs.some((row) => row.event_type === "SENSOR_DUPLICATE"), "Duplicate audit row missing");
  });
  const queueAfterDup = (await testPool.query<{ queue_count: number }>("SELECT queue_count FROM junction_queues WHERE junction_id=$1 AND direction=$2", ["A", "NORTH"])).rows[0]!.queue_count;
  assert(queueAfterDup === queueBeforeDup + 1, "Duplicate event changed queue more than once");
  results[results.length - 1]!.queue_before = queueBeforeDup;
  results[results.length - 1]!.queue_after = queueAfterDup;
  results[results.length - 1]!.first_response = responseSummary(dupFirst);

  const parallelEvent = `parallel-${randomUUID()}`;
  const parallelBody = {
    eventId: parallelEvent,
    junctionId: "A",
    direction: "SOUTH",
    eventType: "VEHICLE_ARRIVED",
    vehicleId: `vehicle-${parallelEvent}`,
    vehicleType: "TRUCK",
    sensorTimestamp: new Date().toISOString(),
  };
  const queueBeforeParallel = (await testPool.query<{ queue_count: number }>("SELECT queue_count FROM junction_queues WHERE junction_id=$1 AND direction=$2", ["A", "SOUTH"])).rows[0]!.queue_count;
  const parallelResponses = await Promise.all(Array.from({ length: 20 }, () => postSensor(parallelBody)));
  const parallelAccepted = parallelResponses.filter((response) => response.status === 201).length;
  const parallelDuplicates = parallelResponses.filter((response) => response.status === 200 && response.body.duplicate === true).length;
  assert(parallelAccepted === 1 && parallelDuplicates === 19, `Case 3 expected 1 accepted + 19 duplicates, got ${parallelAccepted}+${parallelDuplicates}`);
  await recordCase("3", "Same event_id submitted 20 times concurrently", parallelResponses.find((response) => response.status === 200)!, [parallelEvent], ["SOUTH"], (rows) => {
    assert(rows.sensor_events.length === 1, "Parallel duplicate event produced more than one sensor row");
    assert(rows.audit_logs.filter((row) => row.event_type === "SENSOR_DUPLICATE").length === 19, "Expected 19 duplicate audit rows");
  });
  const queueAfterParallel = (await testPool.query<{ queue_count: number }>("SELECT queue_count FROM junction_queues WHERE junction_id=$1 AND direction=$2", ["A", "SOUTH"])).rows[0]!.queue_count;
  assert(queueAfterParallel === queueBeforeParallel + 1, "Parallel duplicate changed queue more than once");
  results[results.length - 1]!.http_counts = { created201: parallelAccepted, duplicate200: parallelDuplicates };
  results[results.length - 1]!.queue_before = queueBeforeParallel;
  results[results.length - 1]!.queue_after = queueAfterParallel;

  const knownVehicle = `vehicle-all-EAST-CAR`;
  const clearKnownId = `clear-known-${randomUUID()}`;
  const clearKnown = await postSensor({
    eventId: clearKnownId, junctionId: "A", direction: "EAST", eventType: "VEHICLE_CLEARED",
    vehicleId: knownVehicle, sensorTimestamp: new Date(Date.now() + 1_000).toISOString(),
  });
  assert(clearKnown.status === 201, `Case 4 expected 201, got ${clearKnown.status}: ${JSON.stringify(clearKnown.body)}`);
  await recordCase("4", "Clear a known vehicle", clearKnown, [clearKnownId], ["EAST"], (rows) => {
    assert(rows.sensor_events.some((row) => row.status === "PROCESSED"), "Known clear not stored as PROCESSED");
    assert(rows.audit_logs.some((row) => row.event_type === "SENSOR_ACCEPTED"), "Known clear audit missing");
  });
  results[results.length - 1]!.queue_before = 6;
  results[results.length - 1]!.queue_after = (await testPool.query<{ queue_count: number }>("SELECT queue_count FROM junction_queues WHERE junction_id=$1 AND direction=$2", ["A", "EAST"])).rows[0]?.queue_count;

  const unmatchedId = `clear-missing-${randomUUID()}`;
  const beforeUnmatched = (await testPool.query<{ queue_count: number }>("SELECT queue_count FROM junction_queues WHERE junction_id=$1 AND direction=$2", ["A", "WEST"])).rows[0]!.queue_count;
  const unmatched = await postSensor({ eventId: unmatchedId, junctionId: "A", direction: "WEST", eventType: "VEHICLE_CLEARED", vehicleId: `never-${unmatchedId}`, sensorTimestamp: new Date().toISOString() });
  assert(unmatched.status === 409 && unmatched.body.error?.code === "UNMATCHED_CLEAR", `Case 5 expected audited 409, got ${unmatched.status}: ${JSON.stringify(unmatched.body)}`);
  await recordCase("5", "Clear a vehicle with no arrival", unmatched, [unmatchedId], ["WEST"], (rows) => {
    assert(rows.sensor_events[0]?.status === "UNMATCHED_CLEAR", "Unmatched clear status was not persisted");
    assert(rows.audit_logs.some((row) => row.event_type === "SENSOR_UNMATCHED_CLEAR"), "Unmatched clear audit missing");
  });
  const afterUnmatched = (await testPool.query<{ queue_count: number }>("SELECT queue_count FROM junction_queues WHERE junction_id=$1 AND direction=$2", ["A", "WEST"])).rows[0]!.queue_count;
  assert(beforeUnmatched === afterUnmatched, "Unmatched clear changed the queue");
  results[results.length - 1]!.queue_before = beforeUnmatched;
  results[results.length - 1]!.queue_after = afterUnmatched;

  const zeroVehicleId = `zero-floor-${randomUUID()}`;
  const zeroArrivalId = `zero-arrival-${randomUUID()}`;
  const westCountBeforeDrain = (await testPool.query<{ queue_count: number }>("SELECT queue_count FROM junction_queues WHERE junction_id=$1 AND direction=$2", ["A", "WEST"])).rows[0]!.queue_count;
  const zeroArrival = await postSensor({ eventId: zeroArrivalId, junctionId: "A", direction: "WEST", eventType: "VEHICLE_ARRIVED", vehicleId: zeroVehicleId, vehicleType: "BUS", sensorTimestamp: new Date(Date.now() + 1_000).toISOString() });
  assert(zeroArrival.status === 201, `Case 6 precondition arrival failed: ${zeroArrival.status}`);
  const westVehicleIds = [...case1.filter((item) => item.direction === "WEST").map((item) => `vehicle-${item.eventId}`), zeroVehicleId];
  const zeroClearIds: string[] = [];
  let lastKnownClear: any;
  for (const vehicleId of westVehicleIds) {
    const eventId = `zero-drain-${randomUUID()}`;
    const latestTimestamp = await testPool.query<{ sensor_timestamp: Date | null }>(
      "SELECT max(sensor_timestamp) AS sensor_timestamp FROM sensor_events WHERE junction_id = $1 AND direction = $2 AND status = 'PROCESSED'",
      ["A", "WEST"],
    );
    const timestamp = Math.max(Date.now() + 25, (latestTimestamp.rows[0]?.sensor_timestamp?.getTime() ?? 0) + 25);
    assert(timestamp - Date.now() <= 5_000, "Could not choose an in-window WEST clear timestamp");
    lastKnownClear = await postSensor({ eventId, junctionId: "A", direction: "WEST", eventType: "VEHICLE_CLEARED", vehicleId, sensorTimestamp: new Date(timestamp).toISOString() });
    assert(lastKnownClear.status === 201, `Case 6 failed to drain a known WEST vehicle: ${lastKnownClear.status}`);
    zeroClearIds.push(eventId);
  }
  const westAtZero = (await testPool.query<{ queue_count: number }>("SELECT queue_count FROM junction_queues WHERE junction_id=$1 AND direction=$2", ["A", "WEST"])).rows[0]?.queue_count;
  assert(westAtZero === 0, `Case 6 precondition did not reach zero: ${westAtZero}`);
  const zeroClearId = `zero-clear-${randomUUID()}`;
  const latestWestTimestamp = await testPool.query<{ sensor_timestamp: Date | null }>(
    "SELECT max(sensor_timestamp) AS sensor_timestamp FROM sensor_events WHERE junction_id = $1 AND direction = $2 AND status = 'PROCESSED'",
    ["A", "WEST"],
  );
  const zeroClearTimestamp = Math.max(Date.now() + 25, (latestWestTimestamp.rows[0]?.sensor_timestamp?.getTime() ?? 0) + 25);
  const zeroClear = await postSensor({ eventId: zeroClearId, junctionId: "A", direction: "WEST", eventType: "VEHICLE_CLEARED", vehicleId: zeroVehicleId, sensorTimestamp: new Date(zeroClearTimestamp).toISOString() });
  assert(zeroClear.status === 409 && zeroClear.body.error?.code === "UNMATCHED_CLEAR", `Case 6 expected rejected clear at zero, got ${zeroClear.status}`);
  const westZero = (await testPool.query<{ queue_count: number }>("SELECT queue_count FROM junction_queues WHERE junction_id=$1 AND direction=$2", ["A", "WEST"])).rows[0]?.queue_count;
  assert(westZero === 0, `Case 6 queue went below or above zero: ${westZero}`);
  await recordCase("6", "Clear after queue drained to zero", zeroClear, [zeroArrivalId, ...zeroClearIds, zeroClearId], ["WEST"], (rows) => {
    assert(rows.sensor_events.length === westVehicleIds.length + 2, "Arrival/drain/repeated-clear sensor rows missing");
    assert(rows.audit_logs.some((row) => row.event_type === "SENSOR_UNMATCHED_CLEAR" && row.event_id === zeroClearId), "Zero-count clear rejection audit missing");
  });
  results[results.length - 1]!.queue_before = westCountBeforeDrain;
  results[results.length - 1]!.queue_after = westZero;

  const repeatedVehicle = `vehicle-repeat-${randomUUID()}`;
  const repeatedArrival1 = `repeat-first-${randomUUID()}`;
  const repeatedArrival2 = `repeat-second-${randomUUID()}`;
  const repeatedFirst = await postSensor({ eventId: repeatedArrival1, junctionId: "A", direction: "NORTH", eventType: "VEHICLE_ARRIVED", vehicleId: repeatedVehicle, vehicleType: "CAR", sensorTimestamp: new Date(Date.now() + 3_000).toISOString() });
  const northBeforeRepeat = (await testPool.query<{ queue_count: number }>("SELECT queue_count FROM junction_queues WHERE junction_id=$1 AND direction=$2", ["A", "NORTH"])).rows[0]!.queue_count;
  const repeatedSecond = await postSensor({ eventId: repeatedArrival2, junctionId: "A", direction: "NORTH", eventType: "VEHICLE_ARRIVED", vehicleId: repeatedVehicle, vehicleType: "CAR", sensorTimestamp: new Date(Date.now() + 3_001).toISOString() });
  assert(repeatedFirst.status === 201 && repeatedSecond.status === 200 && repeatedSecond.body.duplicate === true, "Case 7 duplicate vehicle response incorrect");
  const northAfterRepeat = (await testPool.query<{ queue_count: number }>("SELECT queue_count FROM junction_queues WHERE junction_id=$1 AND direction=$2", ["A", "NORTH"])).rows[0]!.queue_count;
  assert(northAfterRepeat === northBeforeRepeat, "Repeated vehicle id incremented queue");
  await recordCase("7", "Same vehicle_id with different event_ids", repeatedSecond, [repeatedArrival1, repeatedArrival2], ["NORTH"], (rows) => {
    assert(rows.sensor_events.find((row) => row.event_id === repeatedArrival2)?.status === "DUPLICATE_VEHICLE", "Duplicate vehicle row status missing");
    assert(rows.audit_logs.some((row) => row.event_type === "SENSOR_DUPLICATE_VEHICLE"), "Duplicate vehicle audit missing");
  });
  results[results.length - 1]!.first_response = responseSummary(repeatedFirst);
  results[results.length - 1]!.queue_before = northBeforeRepeat;
  results[results.length - 1]!.queue_after = northAfterRepeat;

  const sequenceBase = Date.now() + 4_000;
  const sequenceOneId = `seq-one-${randomUUID()}`;
  const sequenceOne = await postSensor({ eventId: sequenceOneId, junctionId: "A", direction: "SOUTH", eventType: "VEHICLE_ARRIVED", vehicleId: `seq-v1-${sequenceOneId}`, vehicleType: "CAR", sequenceNo: 100, sensorTimestamp: new Date(sequenceBase).toISOString() });
  assert(sequenceOne.status === 201, `Case 8 setup failed: ${sequenceOne.status}`);
  const sequenceOldId = `seq-old-${randomUUID()}`;
  const sequenceOld = await postSensor({ eventId: sequenceOldId, junctionId: "A", direction: "SOUTH", eventType: "VEHICLE_ARRIVED", vehicleId: `seq-v2-${sequenceOldId}`, vehicleType: "CAR", sequenceNo: 99, sensorTimestamp: new Date(sequenceBase + 1).toISOString() });
  assert(sequenceOld.status === 409 && sequenceOld.body.error?.code === "OUT_OF_ORDER", `Case 8 expected out-of-order 409, got ${sequenceOld.status}`);
  await recordCase("8", "Sequence number lower than latest accepted", sequenceOld, [sequenceOneId, sequenceOldId], ["SOUTH"], (rows) => {
    assert(rows.sensor_events.find((row) => row.event_id === sequenceOldId)?.status === "OUT_OF_ORDER", "Out-of-order status not persisted");
    assert(rows.audit_logs.some((row) => row.event_type === "SENSOR_OUT_OF_ORDER"), "Out-of-order audit missing");
  });
  results[results.length - 1]!.setup_response = responseSummary(sequenceOne);

  const staleId = `stale-${randomUUID()}`;
  const staleResponse = await postSensor({ eventId: staleId, junctionId: "A", direction: "EAST", eventType: "VEHICLE_ARRIVED", vehicleId: `stale-v-${staleId}`, vehicleType: "TRUCK", sensorTimestamp: new Date(Date.now() - 60_000).toISOString() });
  assert(staleResponse.status === 409 && staleResponse.body.error?.code === "STALE", `Case 9 expected stale 409, got ${staleResponse.status}`);
  await recordCase("9", "Sensor timestamp older than 30-second threshold", staleResponse, [staleId], ["EAST"], (rows) => {
    assert(rows.sensor_events[0]?.status === "STALE", "Stale status not persisted");
    assert(rows.audit_logs.some((row) => row.event_type === "SENSOR_STALE"), "Stale audit missing");
  });

  const queuesBeforeInvalid = (await testPool.query("SELECT direction,queue_count FROM junction_queues WHERE junction_id=$1 ORDER BY direction", ["A"])).rows;
  const invalidTotalsBefore = (await testPool.query("SELECT (SELECT count(*) FROM sensor_events WHERE junction_id=$1) AS sensors, (SELECT count(*) FROM audit_logs WHERE junction_id=$1) AS audits", ["A"])).rows[0];
  const invalidCases: Array<{ name: string; response: any }> = [];
  invalidCases.push({ name: "missing fields", response: await postSensor({}) });
  invalidCases.push({ name: "bad timestamp", response: await postSensor({ ...duplicateBody, eventId: `invalid-time-${randomUUID()}`, sensorTimestamp: "not-a-date" }) });
  invalidCases.push({ name: "empty body", response: await postSensor("", true) });
  invalidCases.push({ name: "wrong field types", response: await postSensor({ ...duplicateBody, eventId: 123, vehicleId: false }) });
  for (const item of invalidCases) assert(item.response.status === 400, `Case 10 ${item.name}: expected 400, got ${item.response.status}`);
  const queuesAfterInvalid = (await testPool.query("SELECT direction,queue_count FROM junction_queues WHERE junction_id=$1 ORDER BY direction", ["A"])).rows;
  const invalidTotalsAfter = (await testPool.query("SELECT (SELECT count(*) FROM sensor_events WHERE junction_id=$1) AS sensors, (SELECT count(*) FROM audit_logs WHERE junction_id=$1) AS audits", ["A"])).rows[0];
  assert(JSON.stringify(queuesBeforeInvalid) === JSON.stringify(queuesAfterInvalid), "Invalid sensor input changed junction queues");
  assert(JSON.stringify(invalidTotalsBefore) === JSON.stringify(invalidTotalsAfter), "Invalid sensor input changed sensor/audit row counts");
  results.push({ id: "10", test: "Missing fields, bad timestamp, empty body, wrong field types", responses: invalidCases.map(({ name, response }) => ({ name, status: response.status, body: response.body })), rows: { before: { junction_queues: queuesBeforeInvalid, totals: invalidTotalsBefore }, after: { junction_queues: queuesAfterInvalid, totals: invalidTotalsAfter } } });

  const unknownJunctionId = `missing-junction-${randomUUID()}`;
  const unknownJunction = await postSensor({ ...duplicateBody, eventId: unknownJunctionId, junctionId: "UNKNOWN-JUNCTION" });
  assert(unknownJunction.status === 404, `Case 11 unknown junction expected 404, got ${unknownJunction.status}`);
  const unknownTypeId = `unknown-type-${randomUUID()}`;
  const unknownType = await postSensor({ ...duplicateBody, eventId: unknownTypeId, vehicleType: "SPACESHIP" });
  assert(unknownType.status === 400, `Case 11 unknown vehicle type expected 400, got ${unknownType.status}`);
  const unknownDirectionId = `unknown-direction-${randomUUID()}`;
  const unknownDirection = await postSensor({ ...duplicateBody, eventId: unknownDirectionId, direction: "UP" });
  assert(unknownDirection.status === 400, `Case 11 unknown direction expected 400, got ${unknownDirection.status}`);
  const rejectedSensorEvents = await testPool.query("SELECT event_id,status FROM sensor_events WHERE event_id = ANY($1::varchar[])", [[unknownJunctionId, unknownTypeId, unknownDirectionId]]);
  const rejectedAuditEvents = await testPool.query("SELECT event_type,details->>'eventId' AS event_id FROM audit_logs WHERE junction_id = $1 AND details->>'eventId' = ANY($2::text[])", ["A", [unknownJunctionId, unknownTypeId, unknownDirectionId]]);
  const queuesAfterUnknown = (await testPool.query("SELECT direction,queue_count FROM junction_queues WHERE junction_id=$1 ORDER BY direction", ["A"])).rows;
  assert(rejectedSensorEvents.rows.length === 0 && rejectedAuditEvents.rows.length === 0, "Unknown junction/type/direction wrote sensor or audit rows");
  results.push({
    id: "11",
    test: "Unknown junction / vehicle type / direction",
    responses: [
      { name: "junction", status: unknownJunction.status, body: unknownJunction.body },
      { name: "vehicle type", status: unknownType.status, body: unknownType.body },
      { name: "direction", status: unknownDirection.status, body: unknownDirection.body },
    ],
    rows: {
      sensor_events: rejectedSensorEvents.rows,
      junction_queues: queuesAfterUnknown,
      audit_logs: rejectedAuditEvents.rows,
    },
  });
  assert(results.at(-1)!.rows && (results.at(-1)!.rows as any).sensor_events.length === 0, "Rejected unknown inputs changed sensor rows");

  const clearSouthVehicles = [...case1.filter((item) => item.direction === "SOUTH").map((item) => `vehicle-${item.eventId}`), `vehicle-${parallelEvent}`, `seq-v1-${sequenceOneId}`];
  let drainTimestamp = Date.now();
  for (const vehicleId of clearSouthVehicles) {
    const eventId = `drain-south-${randomUUID()}`;
    const latestTime = await testPool.query<{ sensor_timestamp: Date | null }>(
      "SELECT max(sensor_timestamp) AS sensor_timestamp FROM sensor_events WHERE junction_id = $1 AND direction = $2 AND status = 'PROCESSED'",
      ["A", "SOUTH"],
    );
    drainTimestamp = Math.max(Date.now() + 25, (latestTime.rows[0]?.sensor_timestamp?.getTime() ?? 0) + 25);
    assert(drainTimestamp - Date.now() <= 5_000, "Could not choose an in-window timestamp for the queue drain");
    const response = await postSensor({ eventId, junctionId: "A", direction: "SOUTH", eventType: "VEHICLE_CLEARED", vehicleId, sensorTimestamp: new Date(drainTimestamp).toISOString() });
    assert(response.status === 201, `Could not drain SOUTH before parallel case: ${response.status} ${JSON.stringify(response.body)}`);
  }
  const southBaseline = (await testPool.query<{ queue_count: number }>("SELECT queue_count FROM junction_queues WHERE junction_id=$1 AND direction=$2", ["A", "SOUTH"])).rows[0]!.queue_count;
  assert(southBaseline === 0, `Expected SOUTH baseline zero, got ${southBaseline}`);

  const latestSouthTimestamp = await testPool.query<{ sensor_timestamp: Date | null }>(
    "SELECT max(sensor_timestamp) AS sensor_timestamp FROM sensor_events WHERE junction_id = $1 AND direction = $2 AND status = 'PROCESSED'",
    ["A", "SOUTH"],
  );
  const batchTimestampMs = Math.max(
    Date.now() + 25,
    (latestSouthTimestamp.rows[0]?.sensor_timestamp?.getTime() ?? 0) + 25,
  );
  assert(batchTimestampMs - Date.now() <= 5_000, "Could not choose an in-window timestamp for parallel arrivals");
  const parallelArrivals = Array.from({ length: 50 }, (_, index) => ({
    eventId: `fifty-${index}-${randomUUID()}`,
    junctionId: "A",
    direction: "SOUTH",
    eventType: "VEHICLE_ARRIVED",
    vehicleId: `fifty-vehicle-${index}-${randomUUID()}`,
    vehicleType: vehicleTypes[index % vehicleTypes.length],
    sensorTimestamp: new Date(batchTimestampMs).toISOString(),
  }));
  const fiftyResponses = await Promise.all(parallelArrivals.map((body) => postSensor(body)));
  const fiftyAccepted = fiftyResponses.filter((response) => response.status === 201).length;
  assert(
    fiftyAccepted === 50,
    `Case 12 expected 50 accepted unique arrivals, got ${fiftyAccepted}; ` +
      JSON.stringify(fiftyResponses.slice(0, 5).map((response) => ({ status: response.status, body: response.body }))),
  );
  const southFinal = (await testPool.query<{ queue_count: number }>("SELECT queue_count FROM junction_queues WHERE junction_id=$1 AND direction=$2", ["A", "SOUTH"])).rows[0]!.queue_count;
  assert(southFinal === 50, `Case 12 expected queue 50, got ${southFinal}`);
  const fiftyRows = await testPool.query("SELECT event_id,vehicle_id,status FROM sensor_events WHERE event_id = ANY($1::varchar[]) ORDER BY event_id", [parallelArrivals.map((body) => body.eventId)]);
  const fiftyAudits = await testPool.query("SELECT event_type,details->>'eventId' AS event_id FROM audit_logs WHERE junction_id = $1 AND details->>'eventId' = ANY($2::text[])", ["A", parallelArrivals.map((body) => body.eventId)]);
  assert(fiftyRows.rows.length === 50 && fiftyAudits.rows.length === 50, "Case 12 database event/audit row totals incorrect");
  results.push({
    id: "12",
    test: "50 valid unique arrivals concurrently",
    response: { statuses: { "201": fiftyAccepted } },
    rows: { sensor_events: { count: fiftyRows.rows.length, sample: fiftyRows.rows.slice(0, 3) }, junction_queues: [{ direction: "SOUTH", queue_count: southFinal }], audit_logs: { count: fiftyAudits.rows.length, sample: fiftyAudits.rows.slice(0, 3) } },
  });

  console.log(JSON.stringify({ database: dbName }));
  for (const result of results) console.log(JSON.stringify(result));
} finally {
  if (server !== undefined && server.exitCode === null) {
    server.kill("SIGTERM");
    await Promise.race([once(server, "exit"), delay(2_000)]);
    if (server.exitCode === null) server.kill("SIGKILL");
  }
  await testPool?.end();
  await adminPool.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1", [dbName]).catch(() => undefined);
  if (dbCreated) await adminPool.query(`DROP DATABASE ${dbName}`).catch((error) => console.error("Could not drop E2E database", error));
  await adminPool.end();
  await basePool.end();
}
