import { describe, expect, it } from "vitest";
import request from "supertest";
import type { ApiControllerDependencies } from "../controllers/api.controller.ts";
import { createApp } from "../app.ts";
import type { SensorHandlingResult } from "../services/sensor.service.ts";

function createTestApp(overrides: Partial<ApiControllerDependencies> = {}) {
  const sensorResults = new Map<string, SensorHandlingResult>([
    ["duplicate-event", { status: "DUPLICATE", reason: "already processed" }],
    ["stale-event", { status: "STALE", reason: "too old" }],
    ["out-of-order-event", { status: "OUT_OF_ORDER", reason: "sequence is old" }],
  ]);
  const ackResults = new Map<string, "MATCHED" | "DUPLICATE" | "UNKNOWN" | "LATE" | "REJECTED">([
    ["ack-duplicate", "DUPLICATE"],
    ["ack-late", "LATE"],
    ["ack-unknown", "UNKNOWN"],
    ["ack-failed", "REJECTED"],
  ]);
  const dependencies: ApiControllerDependencies = {
    junctionService: {
      process: async (junctionId, input) => ({ junctionId, input } as never),
      getState: async (junctionId) => ({ junctionId } as never),
    },
    sensorService: {
      handle: async (event) => sensorResults.get(event.eventId) ?? ({
        status: "ACCEPTED",
        state: { junctionId: event.junctionId },
      } as SensorHandlingResult),
    },
    commandService: {
      handleAck: async (ack) => ackResults.get(ack.commandId) ?? "MATCHED",
    },
    listJunctions: async () => [{ id: "A", name: "Junction A" }] as never,
    getJunctionById: async (junctionId) =>
      junctionId === "A" ? ({ id: "A", name: "Junction A" } as never) : undefined,
    getQueues: async (junctionId) => [{ junction_id: junctionId, direction: "NORTH", queue_count: 1 }] as never,
    getCommandById: async (commandId) =>
      commandId === "cmd-1" ? ({ command_id: commandId, status: "PENDING" } as never) : undefined,
    listCommands: async (junctionId) => [{ junction_id: junctionId, command_id: "cmd-1" }] as never,
    listControllerEvents: async (junctionId) => [{ junction_id: junctionId, status: "ACKNOWLEDGED" }] as never,
    getHistory: async (junctionId) => [{ junction_id: junctionId, event_type: "TEST" }] as never,
    ...overrides,
  };

  return createApp(dependencies);
}

const validSensorEvent = {
  eventId: "event-1",
  junctionId: "A",
  direction: "NORTH",
  eventType: "ARRIVED",
  vehicleId: "car-1",
  vehicleType: "CAR",
  sequenceNo: 1,
  sensorTimestamp: "2026-10-08T12:00:00.000Z",
};

describe("REST API", () => {
  it("serves junction collection and status, with 404 for unknown junctions", async () => {
    const app = createTestApp();
    await request(app).get("/api/junctions").expect(200).expect(({ body }) => {
      expect(body.junctions).toHaveLength(1);
    });
    await request(app).get("/api/junctions/A/status").expect(200).expect(({ body }) => {
      expect(body.junction.id).toBe("A");
      expect(body.queues).toHaveLength(1);
    });
    await request(app).get("/api/junctions/missing/status").expect(404);
  });

  it("validates sensor events and maps accepted, duplicate, stale and missing junction cases", async () => {
    const app = createTestApp();
    await request(app).post("/api/sensor-events").send(validSensorEvent).expect(201);
    await request(app).post("/api/sensor-events").send({
      ...validSensorEvent,
      eventId: "duplicate-event",
    }).expect(200);
    await request(app).post("/api/sensor-events").send({
      ...validSensorEvent,
      eventId: "stale-event",
    }).expect(409);
    await request(app).post("/api/sensor-events").send({
      ...validSensorEvent,
      eventId: "out-of-order-event",
    }).expect(409);
    await request(app).post("/api/sensor-events").send({
      ...validSensorEvent,
      direction: "UP",
    }).expect(400).expect(({ body }) => {
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.details).toBeInstanceOf(Array);
    });
    await request(app).post("/api/sensor-events").send({
      ...validSensorEvent,
      junctionId: "missing",
    }).expect(404);
  });

  it("validates commands and reports accepted command requests", async () => {
    const app = createTestApp();
    await request(app).post("/api/commands").send({
      type: "MANUAL_MODE_REQUEST",
      junctionId: "A",
      phase: "EAST_WEST",
    }).expect(201);
    await request(app).post("/api/commands").send({
      type: "TARGET_PHASE_REQUEST",
      junctionId: "A",
    }).expect(400);
    await request(app).get("/api/commands?junctionId=A&limit=20").expect(200);
    await request(app).get("/api/commands/cmd-1").expect(200);
    await request(app).get("/api/commands/missing").expect(404);
  });

  it("maps controller ACK outcomes and serves events/history", async () => {
    const app = createTestApp();
    const ack = { commandId: "ack-matched", junctionId: "A", status: "ACKNOWLEDGED", actualState: "GREEN" };
    await request(app).post("/api/controller-events").send(ack).expect(201);
    await request(app).post("/api/controller-events").send({ ...ack, commandId: "ack-duplicate" }).expect(200);
    await request(app).post("/api/controller-events").send({ ...ack, commandId: "ack-late" }).expect(409);
    await request(app).post("/api/controller-events").send({ ...ack, commandId: "ack-unknown" }).expect(404);
    await request(app).post("/api/controller-events").send({ ...ack, commandId: "ack-failed", status: "FAILED" }).expect(201);
    await request(app).get("/api/controller-events?junctionId=A").expect(200);
    await request(app).get("/api/history?junctionId=A&limit=25").expect(200);
    await request(app).get("/api/history").expect(400);
  });

  it("returns 400 for malformed JSON", async () => {
    await request(createTestApp())
      .post("/api/sensor-events")
      .set("Content-Type", "application/json")
      .send("{invalid-json")
      .expect(400)
      .expect(({ body }) => expect(body.error.code).toBe("INVALID_JSON"));
  });

  it("uses the error middleware for unexpected failures", async () => {
    const app = createTestApp({
      listJunctions: async () => {
        throw new Error("secret database detail");
      },
    });
    await request(app).get("/api/junctions").expect(500).expect(({ body }) => {
      expect(body.error.code).toBe("INTERNAL_SERVER_ERROR");
      expect(body.error.message).not.toContain("secret database detail");
    });
  });
});