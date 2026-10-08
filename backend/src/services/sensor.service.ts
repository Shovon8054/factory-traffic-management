import type { PoolClient } from "pg";
import { withTransaction } from "../config/database.ts";
import {
  lockJunction,
  type JunctionRow,
} from "../models/junction.model.ts";
import {
  getLatestSensorSequence,
  getLatestSensorTimestamp,
  getActiveSensorVehicles,
  getSensorEventById,
  insertSensorEvent,
  type ActiveSensorVehicleRow,
  type SensorEventInput,
} from "../models/sensor.model.ts";
import { appendHistory } from "../models/history.model.ts";
import type { Direction, Phase, TrafficInput, VehicleType } from "./traffic.service.ts";
import { JunctionService, junctionService } from "./junction.service.ts";

const VALID_DIRECTIONS = new Set<Direction>(["NORTH", "SOUTH", "EAST", "WEST"]);
const VALID_VEHICLE_TYPES = new Set<VehicleType>([
  "CAR",
  "MOTORCYCLE",
  "BUS",
  "TRUCK",
  "FORKLIFT",
  "EMERGENCY",
  "EMPLOYEE_VEHICLE",
]);
const EVENT_TYPES = new Set(["ARRIVED", "CLEARED", "VEHICLE_ARRIVED", "VEHICLE_CLEARED"]);

export interface SensorEvent extends SensorEventInput {
  eventId: string;
  junctionId: string;
  direction: string;
  eventType: string;
  vehicleId: string;
  sequenceNo?: number | null;
  sensorTimestamp: Date;
}

export type SensorHandlingResult =
  | { status: "ACCEPTED"; state: Awaited<ReturnType<JunctionService["process"]>> }
  | { status: "DUPLICATE"; duplicate: true; reason: string }
  | { status: "OUT_OF_ORDER" | "STALE" | "UNMATCHED_CLEAR"; reason: string }
  | { status: "INVALID"; reason: string };

export interface SensorServiceDependencies {
  transact<T>(operation: (client: PoolClient) => Promise<T>): Promise<T>;
  lockJunction(client: PoolClient, junctionId: string): Promise<JunctionRow | undefined>;
  getSensorEventById(eventId: string, client: PoolClient): ReturnType<typeof getSensorEventById>;
  getLatestSensorSequence(
    junctionId: string,
    direction: string,
    client: PoolClient,
  ): Promise<number | null>;
  getLatestSensorTimestamp(
    junctionId: string,
    direction: string,
    client: PoolClient,
  ): Promise<Date | null>;
  getActiveVehicles(
    junctionId: string,
    client: PoolClient,
  ): ReturnType<typeof getActiveSensorVehicles>;
  insertSensorEvent(event: SensorEventInput, client: PoolClient): ReturnType<typeof insertSensorEvent>;
  appendAudit(client: PoolClient, entry: Parameters<typeof appendHistory>[0]): Promise<unknown>;
}

interface SensorTransactionResult {
  result: SensorHandlingResult;
  committed?: Awaited<ReturnType<JunctionService["processLocked"]>>;
}

const defaultDependencies: SensorServiceDependencies = {
  transact: withTransaction,
  lockJunction,
  getSensorEventById: (eventId, client) => getSensorEventById(eventId, client),
  getLatestSensorSequence: (junctionId, direction, client) =>
    getLatestSensorSequence(junctionId, direction, client),
  getLatestSensorTimestamp: (junctionId, direction, client) =>
    getLatestSensorTimestamp(junctionId, direction, client),
  getActiveVehicles: (junctionId, client) => getActiveSensorVehicles(junctionId, client),
  insertSensorEvent: (event, client) => insertSensorEvent(event, client),
  appendAudit: (client, entry) => appendHistory(entry, client),
};

export class SensorService {
  constructor(
    private readonly junctionService = new JunctionService(),
    private readonly dependencies: SensorServiceDependencies = defaultDependencies,
    private readonly staleAfterMs = 30_000,
    private readonly futureSkewMs = 5_000,
  ) {}

  async handle(event: SensorEvent, now: number): Promise<SensorHandlingResult> {
    const validationError = this.validate(event, now);
    if (validationError !== null) return { status: "INVALID", reason: validationError };

    return this.junctionService.runSerialized(event.junctionId, async () => {
      const transaction = await this.dependencies.transact<SensorTransactionResult>(async (client) => {
        const junction = await this.dependencies.lockJunction(client, event.junctionId);
        if (junction === undefined) throw new Error(`Junction not found: ${event.junctionId}`);

        const existing = await this.dependencies.getSensorEventById(event.eventId, client);
        if (existing !== undefined) {
          await this.audit(client, event, "DUPLICATE", { duplicateEventId: event.eventId });
          const isEmergencyArrival =
            (event.eventType === "ARRIVED" || event.eventType === "VEHICLE_ARRIVED") &&
            event.vehicleType === "EMERGENCY" &&
            existing.vehicle_type === "EMERGENCY" &&
            now - event.sensorTimestamp.getTime() <= this.staleAfterMs;
          if (isEmergencyArrival) {
            const committed = await this.junctionService.processLocked(client, junction, {
              type: "EMERGENCY_REQUEST",
              emergencyId: event.vehicleId,
              vehicleId: event.vehicleId,
              phase: this.phaseForDirection(event.direction as Direction),
              occurredAt: now,
            }, now);
            return {
              result: { status: "DUPLICATE", duplicate: true, reason: "emergency last-seen refreshed" },
              committed,
            };
          }
          return {
            result: { status: "DUPLICATE", duplicate: true, reason: "event_id already processed" },
          };
        }

        const staleAt = now - this.staleAfterMs;
        const latestTimestamp = await this.dependencies.getLatestSensorTimestamp(
          event.junctionId,
          event.direction,
          client,
        );
        if (event.sensorTimestamp.getTime() < staleAt) {
          await this.recordRejected(client, event, "STALE", "sensor timestamp exceeded stale window");
          return { result: { status: "STALE", reason: "sensor timestamp exceeded stale window" } };
        }

        const latestSequence = await this.dependencies.getLatestSensorSequence(
          event.junctionId,
          event.direction,
          client,
        );
        if (
          (event.sequenceNo != null && latestSequence !== null && event.sequenceNo <= latestSequence) ||
          (latestTimestamp !== null && event.sensorTimestamp < latestTimestamp)
        ) {
          await this.recordRejected(client, event, "OUT_OF_ORDER", "sequence or timestamp is not newer");
          return { result: { status: "OUT_OF_ORDER", reason: "sequence or timestamp is not newer" } };
        }

        const activeVehicles = await this.dependencies.getActiveVehicles(event.junctionId, client);
        const matchingActiveVehicle = activeVehicles.find(
          (vehicle) => vehicle.vehicle_id === event.vehicleId,
        );
        const isArrival = event.eventType === "ARRIVED" || event.eventType === "VEHICLE_ARRIVED";
        if (isArrival && matchingActiveVehicle !== undefined) {
          const isEmergencyRefresh = event.vehicleType === "EMERGENCY" &&
            matchingActiveVehicle.vehicle_type === "EMERGENCY";
          if (isEmergencyRefresh) {
            const insertedRefresh = await this.dependencies.insertSensorEvent({
              ...event,
              status: "PROCESSED",
            }, client);
            if (insertedRefresh === undefined) {
              await this.audit(client, event, "DUPLICATE", { duplicateEventId: event.eventId });
              return {
                result: { status: "DUPLICATE", duplicate: true, reason: "event_id already processed" },
              };
            }
            const committed = await this.junctionService.processLocked(client, junction, {
              type: "EMERGENCY_REQUEST",
              emergencyId: event.vehicleId,
              vehicleId: event.vehicleId,
              phase: this.phaseForDirection(event.direction as Direction),
              occurredAt: now,
            }, now);
            await this.audit(client, event, "EMERGENCY_REFRESHED", { sensorRowId: insertedRefresh.id });
            return {
              result: { status: "ACCEPTED", state: committed.state },
              committed,
            };
          }

          await this.dependencies.insertSensorEvent({ ...event, status: "DUPLICATE_VEHICLE" }, client);
          await this.audit(client, event, "DUPLICATE_VEHICLE", {
            activeDirection: matchingActiveVehicle.direction,
          });
          return {
            result: {
              status: "DUPLICATE",
              duplicate: true,
              reason: "vehicleId is already active in a junction queue",
            },
          };
        }

        const isClear = event.eventType === "CLEARED" || event.eventType === "VEHICLE_CLEARED";
        if (
          isClear &&
          !activeVehicles.some((vehicle) =>
            vehicle.vehicle_id === event.vehicleId && vehicle.direction === event.direction,
          )
        ) {
          await this.recordRejected(client, event, "UNMATCHED_CLEAR", "vehicle has no active arrival in this direction");
          return {
            result: { status: "UNMATCHED_CLEAR", reason: "vehicle has no active arrival in this direction" },
          };
        }

        const inserted = await this.dependencies.insertSensorEvent({
          ...event,
          status: "PROCESSED",
        }, client);
        if (inserted === undefined) {
          await this.audit(client, event, "DUPLICATE", { duplicateEventId: event.eventId });
          return { result: { status: "DUPLICATE", duplicate: true, reason: "event_id already processed" } };
        }

        const input = this.toTrafficInput(event);
        const committed = await this.junctionService.processLocked(client, junction, input, now);
        await this.audit(client, event, "ACCEPTED", { sensorRowId: inserted.id });
        return {
          result: { status: "ACCEPTED", state: committed.state },
          committed,
        };
      });

      if (transaction.committed !== undefined) {
        await this.junctionService.afterCommit(transaction.committed);
      }
      return transaction.result;
    });
  }

  private validate(event: SensorEvent, now: number): string | null {
    if (event.eventId.trim().length === 0) return "eventId is required";
    if (event.junctionId.trim().length === 0) return "junctionId is required";
    if (!VALID_DIRECTIONS.has(event.direction as Direction)) return "invalid direction";
    if (!EVENT_TYPES.has(event.eventType)) return "invalid eventType";
    if (event.vehicleId.trim().length === 0) return "vehicleId is required";
    if (
      event.eventType === "ARRIVED" || event.eventType === "VEHICLE_ARRIVED"
    ) {
      if (event.vehicleType == null || !VALID_VEHICLE_TYPES.has(event.vehicleType as VehicleType)) {
        return "valid vehicleType is required for arrival";
      }
    }
    if (event.sequenceNo != null && (!Number.isInteger(event.sequenceNo) || event.sequenceNo < 0)) {
      return "sequenceNo must be a non-negative integer";
    }
    if (!(event.sensorTimestamp instanceof Date) || Number.isNaN(event.sensorTimestamp.getTime())) {
      return "sensorTimestamp must be a valid Date";
    }
    if (event.sensorTimestamp.getTime() > now + this.futureSkewMs) {
      return "sensorTimestamp is too far in the future";
    }
    return null;
  }

  private toTrafficInput(event: SensorEvent): TrafficInput {
    const direction = event.direction as Direction;
    if (event.eventType === "ARRIVED" || event.eventType === "VEHICLE_ARRIVED") {
      return {
        type: "VEHICLE_ARRIVED",
        direction,
        vehicleId: event.vehicleId,
        vehicleType: event.vehicleType as VehicleType,
      };
    }
    return { type: "VEHICLE_CLEARED", direction, vehicleId: event.vehicleId };
  }

  private phaseForDirection(direction: Direction): Phase {
    return direction === "NORTH" || direction === "SOUTH" ? "NORTH_SOUTH" : "EAST_WEST";
  }

  private async recordRejected(
    client: PoolClient,
    event: SensorEvent,
    status: "STALE" | "OUT_OF_ORDER" | "UNMATCHED_CLEAR",
    reason: string,
  ): Promise<void> {
    await this.dependencies.insertSensorEvent({ ...event, status }, client);
    await this.audit(client, event, status, { reason });
  }

  private audit(
    client: PoolClient,
    event: SensorEvent,
    result: string,
    details: Record<string, unknown>,
  ): Promise<unknown> {
    return this.dependencies.appendAudit(client, {
      junctionId: event.junctionId,
      eventType: `SENSOR_${result}`,
      direction: event.direction,
      details: { ...details, eventId: event.eventId, vehicleId: event.vehicleId },
    });
  }
}

export const sensorService = new SensorService(junctionService);