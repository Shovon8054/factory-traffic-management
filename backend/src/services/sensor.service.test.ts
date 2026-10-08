import { describe, expect, it } from "vitest";
import type { PoolClient } from "pg";
import type {
  JunctionQueueRow,
  JunctionRow,
} from "../models/junction.model.ts";
import type { SensorEventRow } from "../models/sensor.model.ts";
import {
  JunctionService,
  type JunctionServiceDependencies,
} from "./junction.service.ts";
import {
  SensorService,
  type SensorServiceDependencies,
} from "./sensor.service.ts";

const dbClient = {} as PoolClient;

function createFakeServices(): {
  sensorService: SensorService;
  latestSequence: () => number | null;
  queueCount: () => number;
  auditEvents: () => string[];
  emissions: number;
  junctionService: JunctionService;
} {
  const row: JunctionRow = {
    id: "A",
    name: "Junction A",
    mode: "AUTOMATIC",
    current_phase: "NORTH_SOUTH",
    controller_status: "ONLINE",
    created_at: new Date(0),
    updated_at: new Date(0),
  };
  const queueCounts: Record<string, number> = {
    NORTH: 0,
    SOUTH: 0,
    EAST: 0,
    WEST: 0,
  };
  const events = new Map<string, SensorEventRow>();
  let latestSeq: number | null = null;
  let latestTimestamp: Date | null = null;
  let nextSensorId = 1;
  let emissionCount = 0;
  let commandCount = 0;
  const auditRows: string[] = [];

  const junctionDependencies: JunctionServiceDependencies = {
    transact: async (operation) => operation(dbClient),
    listJunctions: async () => [row],
    lockJunction: async (_client, junctionId) => junctionId === row.id ? row : undefined,
    getQueues: async (junctionId): Promise<JunctionQueueRow[]> =>
      Object.entries(queueCounts).map(([direction, queue_count]) => ({
        junction_id: junctionId,
        direction,
        queue_count,
        updated_at: new Date(0),
      })),
    getActiveVehicles: async () => [],
    updateJunctionState: async () => undefined,
    updateQueueCount: async (_client, _junctionId, direction, delta) => {
      queueCounts[direction] = Math.max((queueCounts[direction] ?? 0) + delta, 0);
    },
    persistEffect: async (_client, junctionId, effect, issuedAt) => ({
      command_id: `command-${++commandCount}`,
      junction_id: junctionId,
      phase: effect.phase,
      step: effect.step,
      signals: effect.signals,
      issued_at: issuedAt,
    }),
    executeEffect: async () => undefined,
    appendAudit: async (_client, entry) => {
      auditRows.push(entry.eventType);
    },
    supersedePendingCommands: async () => 2,
    emit: async () => {
      emissionCount += 1;
    },
  };
  const junctionService = new JunctionService(junctionDependencies);

  const sensorDependencies: SensorServiceDependencies = {
    transact: async (operation) => operation(dbClient),
    lockJunction: async (_client, junctionId) => junctionId === row.id ? row : undefined,
    getSensorEventById: async (eventId) => events.get(eventId),
    getLatestSensorSequence: async () => latestSeq,
    getLatestSensorTimestamp: async () => latestTimestamp,
    getActiveVehicles: async () => {
      const latestByVehicle = new Map<string, SensorEventRow>();
      for (const event of events.values()) {
        if (event.status !== "PROCESSED" || event.vehicle_id === null) continue;
        latestByVehicle.set(event.vehicle_id, event);
      }
      return [...latestByVehicle.values()]
        .filter((event) => event.event_type === "ARRIVED" || event.event_type === "VEHICLE_ARRIVED")
        .map((event) => ({
          vehicle_id: event.vehicle_id!,
          direction: event.direction,
          vehicle_type: event.vehicle_type,
          sensor_timestamp: event.sensor_timestamp,
          received_at: event.received_at,
        }));
    },
    insertSensorEvent: async (event) => {
      if (events.has(event.eventId)) return undefined;
      const sensorRow: SensorEventRow = {
        id: nextSensorId++,
        event_id: event.eventId,
        junction_id: event.junctionId,
        direction: event.direction,
        event_type: event.eventType,
        vehicle_id: event.vehicleId ?? null,
        vehicle_type: event.vehicleType ?? null,
        sequence_no: event.sequenceNo ?? null,
        sensor_timestamp: event.sensorTimestamp ?? null,
        received_at: new Date(),
        status: event.status ?? "PROCESSED",
      };
      events.set(event.eventId, sensorRow);
      if (sensorRow.status === "PROCESSED") {
        latestSeq = sensorRow.sequence_no;
        latestTimestamp = sensorRow.sensor_timestamp;
      }
      return sensorRow;
    },
    appendAudit: async (_client, entry) => {
      auditRows.push(entry.eventType);
    },
  };

  return {
    sensorService: new SensorService(junctionService, sensorDependencies),
    latestSequence: () => latestSeq,
    queueCount: () => queueCounts.NORTH ?? 0,
    auditEvents: () => auditRows,
    junctionService,
    get emissions() {
      return emissionCount;
    },
  };
}

describe("SensorService concurrency", () => {
  it("omits idle tick audit rows and records ticks that transition phase", async () => {
    const fake = createFakeServices();

    await fake.junctionService.process("A", { type: "TICK" }, 100);
    expect(fake.auditEvents()).toEqual([]);

    await fake.junctionService.process("A", {
      type: "MANUAL_MODE_REQUEST",
      phase: "EAST_WEST",
    }, 200);
    await fake.junctionService.process("A", { type: "TICK" }, 1_000);

    expect(fake.auditEvents()).toContain("TICK_TRANSITION");
  });

  it("recovers junctions to automatic UNKNOWN/ALL_RED and audits reset", async () => {
    const fake = createFakeServices();
    const [state] = await fake.junctionService.recoverStartup(100_000);

    expect(state?.mode).toBe("AUTOMATIC");
    expect(state?.desired.step).toBe("ALL_RED");
    expect(state?.actual.step).toBe("UNKNOWN");
    expect(Object.values(state?.actual.signals ?? {}).every((signal) => signal === "UNKNOWN"))
      .toBe(true);
    expect(state?.pendingPhase).toBe("NORTH_SOUTH");
    expect(fake.auditEvents()).toContain("RECOVERY_RESET");
    expect(fake.emissions).toBe(1);
  });

  it("serializes a five-event sequence submitted concurrently", async () => {
    const fake = createFakeServices();
    const baseTime = 1_000_000;
    const sequence = [1, 2, 3, 4, 5];
    const results = await Promise.all(sequence.map((sequenceNo) => {
      const sensorTimestamp = new Date(baseTime + sequenceNo);
      return fake.sensorService.handle({
        eventId: `event-${sequenceNo}`,
        junctionId: "A",
        direction: "NORTH",
        eventType: "ARRIVED",
        vehicleId: `vehicle-${sequenceNo}`,
        vehicleType: "CAR",
        sequenceNo,
        sensorTimestamp,
      }, baseTime + sequenceNo);
    }));

    expect(results.map((result) => result.status)).toEqual([
      "ACCEPTED",
      "ACCEPTED",
      "ACCEPTED",
      "ACCEPTED",
      "ACCEPTED",
    ]);
    const finalResult = results[results.length - 1];
    expect(finalResult?.status).toBe("ACCEPTED");
    if (finalResult?.status === "ACCEPTED") {
      expect(finalResult.state.queueCounts.NORTH).toBe(5);
    }
    expect(fake.latestSequence()).toBe(5);
    expect(fake.queueCount()).toBe(5);
    expect(fake.emissions).toBe(5);
  });

  it("audits duplicate, out-of-order, and stale sensor events without applying them", async () => {
    const fake = createFakeServices();
    const now = 2_000_000;
    const accepted = await fake.sensorService.handle({
      eventId: "sensor-1",
      junctionId: "A",
      direction: "NORTH",
      eventType: "ARRIVED",
      vehicleId: "car-1",
      vehicleType: "CAR",
      sequenceNo: 10,
      sensorTimestamp: new Date(now),
    }, now);
    expect(accepted.status).toBe("ACCEPTED");

    const duplicate = await fake.sensorService.handle({
      eventId: "sensor-1",
      junctionId: "A",
      direction: "NORTH",
      eventType: "ARRIVED",
      vehicleId: "car-1",
      vehicleType: "CAR",
      sequenceNo: 10,
      sensorTimestamp: new Date(now),
    }, now + 1);
    expect(duplicate.status).toBe("DUPLICATE");
    expect(duplicate).toMatchObject({ duplicate: true });

    const outOfOrder = await fake.sensorService.handle({
      eventId: "sensor-old-sequence",
      junctionId: "A",
      direction: "NORTH",
      eventType: "CLEARED",
      vehicleId: "car-1",
      sequenceNo: 9,
      sensorTimestamp: new Date(now + 2),
    }, now + 2);
    expect(outOfOrder.status).toBe("OUT_OF_ORDER");

    const stale = await fake.sensorService.handle({
      eventId: "sensor-stale",
      junctionId: "A",
      direction: "NORTH",
      eventType: "CLEARED",
      vehicleId: "car-1",
      sequenceNo: 11,
      sensorTimestamp: new Date(now - 31_000),
    }, now);
    expect(stale.status).toBe("STALE");
    expect(fake.queueCount()).toBe(1);
    expect(fake.auditEvents()).toEqual([
      "VEHICLE_ARRIVED",
      "SENSOR_ACCEPTED",
      "SENSOR_DUPLICATE",
      "SENSOR_OUT_OF_ORDER",
      "SENSOR_STALE",
    ]);

    const invalid = await fake.sensorService.handle({
      eventId: "bad-direction",
      junctionId: "A",
      direction: "UP",
      eventType: "ARRIVED",
      vehicleId: "car-2",
      vehicleType: "CAR",
      sensorTimestamp: new Date(now),
    }, now);
    expect(invalid.status).toBe("INVALID");
  });

  it("rejects a second active vehicle arrival and an unmatched clear without changing queues", async () => {
    const fake = createFakeServices();
    const now = 3_000_000;
    const arrival = {
      junctionId: "A",
      direction: "NORTH",
      eventType: "VEHICLE_ARRIVED",
      vehicleId: "same-vehicle",
      vehicleType: "TRUCK",
      sensorTimestamp: new Date(now),
    };
    const first = await fake.sensorService.handle({ ...arrival, eventId: "arrival-one" }, now);
    expect(first.status).toBe("ACCEPTED");

    const duplicateVehicle = await fake.sensorService.handle({
      ...arrival,
      eventId: "arrival-two",
      sequenceNo: 2,
      sensorTimestamp: new Date(now + 1),
    }, now + 1);
    expect(duplicateVehicle).toMatchObject({ status: "DUPLICATE", duplicate: true });
    expect(fake.queueCount()).toBe(1);

    const unmatchedClear = await fake.sensorService.handle({
      eventId: "clear-unmatched",
      junctionId: "A",
      direction: "EAST",
      eventType: "VEHICLE_CLEARED",
      vehicleId: "never-arrived",
      sensorTimestamp: new Date(now + 2),
    }, now + 2);
    expect(unmatchedClear.status).toBe("UNMATCHED_CLEAR");
    expect(fake.queueCount()).toBe(1);
    expect(fake.auditEvents()).toContain("SENSOR_DUPLICATE_VEHICLE");
    expect(fake.auditEvents()).toContain("SENSOR_UNMATCHED_CLEAR");
  });
});