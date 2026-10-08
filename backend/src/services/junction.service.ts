import type { PoolClient } from "pg";
import { withTransaction } from "../config/database.ts";
import {
  getQueues,
  lockJunction,
  updateJunctionState,
  updateQueueCount,
  type JunctionRow,
} from "../models/junction.model.ts";
import { appendHistory } from "../models/history.model.ts";
import {
  getActiveSensorVehicles,
  type ActiveSensorVehicleRow,
} from "../models/sensor.model.ts";
import type {
  Direction,
  JunctionState,
  Mode,
  Phase,
  TrafficEffect,
  TrafficInput,
  VehicleType,
} from "./traffic.service.ts";
import { DEFAULT_JUNCTION_CONFIG, decide } from "./traffic.service.ts";
import {
  persistentCommandService,
  persistEffectCommand,
  type PersistedControllerCommand,
} from "./command.service.ts";
import { listJunctions } from "../models/junction.model.ts";
import { supersedePendingCommands } from "../models/command.model.ts";

export interface JunctionSnapshotEvent {
  type: "JUNCTION_STATE";
  junctionId: string;
  state: JunctionState;
  effects: TrafficEffect[];
}

export interface JunctionServiceDependencies {
  transact<T>(operation: (client: PoolClient) => Promise<T>): Promise<T>;
  listJunctions(): Promise<JunctionRow[]>;
  lockJunction(client: PoolClient, junctionId: string): Promise<JunctionRow | undefined>;
  getQueues(junctionId: string, client: PoolClient): ReturnType<typeof getQueues>;
  getActiveVehicles(
    junctionId: string,
    client: PoolClient,
  ): Promise<ActiveSensorVehicleRow[]>;
  updateJunctionState(
    client: PoolClient,
    junctionId: string,
    mode: string,
    phase: string,
    controllerStatus: string,
  ): Promise<unknown>;
  updateQueueCount(
    client: PoolClient,
    junctionId: string,
    direction: string,
    delta: number,
  ): Promise<unknown>;
  persistEffect(
    client: PoolClient,
    junctionId: string,
    effect: TrafficEffect,
    now: number,
  ): Promise<PersistedControllerCommand>;
  executeEffect(command: PersistedControllerCommand): Promise<void>;
  appendAudit(
    client: PoolClient,
    entry: Parameters<typeof appendHistory>[0],
  ): Promise<unknown>;
  supersedePendingCommands(client: PoolClient, junctionId: string): Promise<number>;
  emit(event: JunctionSnapshotEvent): void | Promise<void>;
}

interface CommittedDecision {
  junctionId: string;
  state: JunctionState;
  effects: TrafficEffect[];
  commands: PersistedControllerCommand[];
}

function parsePhase(value: string): Phase {
  return value === "EAST_WEST" ? "EAST_WEST" : "NORTH_SOUTH";
}

function parseMode(value: string): Mode {
  if (value === "MANUAL" || value === "EMERGENCY" || value === "DEGRADED") return value;
  return "AUTOMATIC";
}

function allRed(): JunctionState["desired"]["signals"] {
  return { NORTH: "RED", SOUTH: "RED", EAST: "RED", WEST: "RED" };
}

function allUnknown(): JunctionState["desired"]["signals"] {
  return { NORTH: "UNKNOWN", SOUTH: "UNKNOWN", EAST: "UNKNOWN", WEST: "UNKNOWN" };
}

function signalsFor(phase: Phase, step: "GREEN" | "YELLOW" | "ALL_RED"):
  JunctionState["desired"]["signals"] {
  const signals = allRed();
  if (step === "ALL_RED") return signals;
  const activeSignal = step;
  if (phase === "NORTH_SOUTH") {
    signals.NORTH = activeSignal;
    signals.SOUTH = activeSignal;
  } else {
    signals.EAST = activeSignal;
    signals.WEST = activeSignal;
  }
  return signals;
}

function stateFromRow(
  row: JunctionRow,
  queueRows: Awaited<ReturnType<typeof getQueues>>,
  activeVehicles: ActiveSensorVehicleRow[],
): JunctionState {
  const phase = parsePhase(row.current_phase);
  const signals = allRed();
  const queueCounts: Record<Direction, number> = { NORTH: 0, SOUTH: 0, EAST: 0, WEST: 0 };

  for (const queue of queueRows) {
    if (queue.direction in queueCounts) {
      queueCounts[queue.direction as Direction] = queue.queue_count;
    }
  }

  const queues: JunctionState["queues"] = { NORTH: [], SOUTH: [], EAST: [], WEST: [] };
  for (const vehicle of activeVehicles) {
    if (!(vehicle.direction in queues)) continue;
    const vehicleType = vehicle.vehicle_type;
    const validVehicleType = vehicleType !== null &&
      vehicleType in DEFAULT_JUNCTION_CONFIG.vehiclePriorityWeights
      ? vehicleType as VehicleType
      : "CAR";
    queues[vehicle.direction as Direction].push({
      vehicleId: vehicle.vehicle_id,
      type: validVehicleType,
      arrivedAt: (vehicle.sensor_timestamp ?? vehicle.received_at).getTime(),
    });
  }

  return {
    junctionId: row.id,
    mode: parseMode(row.mode),
    config: DEFAULT_JUNCTION_CONFIG,
    pendingPhase: null,
    emergencyRequests: [],
    manualOverride: null,
    desired: { phase, step: "ALL_RED", signals: { ...signals } },
    actual: {
      phase,
      step: "ALL_RED",
      signals: { ...signals },
      confirmedAt: row.updated_at.getTime(),
    },
    queues,
    queueCounts,
  };
}

const defaultDependencies: JunctionServiceDependencies = {
  transact: withTransaction,
  listJunctions,
  lockJunction,
  getQueues: (junctionId, client) => getQueues(junctionId, client),
  getActiveVehicles: (junctionId, client) => getActiveSensorVehicles(junctionId, client),
  updateJunctionState,
  updateQueueCount,
  persistEffect: persistEffectCommand,
  executeEffect: (command) => persistentCommandService.execute(command),
  appendAudit: (client, entry) => appendHistory(entry, client),
  supersedePendingCommands,
  emit: () => undefined,
};

export class JunctionService {
  private readonly stateCache = new Map<string, JunctionState>();
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly dependencies: JunctionServiceDependencies = defaultDependencies) {}

  setEmitter(emit: JunctionServiceDependencies["emit"]): void {
    this.dependencies.emit = emit;
  }

  runSerialized<T>(junctionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(junctionId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.queues.set(junctionId, current);

    return current.finally(() => {
      if (this.queues.get(junctionId) === current) this.queues.delete(junctionId);
    });
  }

  async process(
    junctionId: string,
    input: TrafficInput,
    now: number,
  ): Promise<JunctionState> {
    return this.runSerialized(junctionId, async () => {
      const committed = await this.dependencies.transact(async (client) => {
        const row = await this.dependencies.lockJunction(client, junctionId);
        if (row === undefined) throw new Error(`Junction not found: ${junctionId}`);
        return this.processLocked(client, row, input, now);
      });
      await this.afterCommit(committed);
      return committed.state;
    });
  }

  async getState(junctionId: string): Promise<JunctionState> {
    const cachedState = this.stateCache.get(junctionId);
    if (cachedState !== undefined) return cachedState;

    const state = await this.dependencies.transact(async (client) => {
      const row = await this.dependencies.lockJunction(client, junctionId);
      if (row === undefined) throw new Error(`Junction not found: ${junctionId}`);
      return stateFromRow(
        row,
        await this.dependencies.getQueues(junctionId, client),
        await this.dependencies.getActiveVehicles(junctionId, client),
      );
    });
    this.stateCache.set(junctionId, state);
    return state;
  }

  async processLocked(
    client: PoolClient,
    row: JunctionRow,
    input: TrafficInput,
    now: number,
  ): Promise<CommittedDecision> {
    const junctionId = row.id;
    const state = this.stateCache.get(junctionId) ??
      stateFromRow(
        row,
        await this.dependencies.getQueues(junctionId, client),
        await this.dependencies.getActiveVehicles(junctionId, client),
      );
    const result = decide(state, input, now);
    const queueChanged = (["NORTH", "SOUTH", "EAST", "WEST"] as const).some(
      (direction) => result.state.queueCounts[direction] !== state.queueCounts[direction],
    );
    const stateChanged = result.state.mode !== state.mode ||
      result.state.desired.phase !== state.desired.phase ||
      result.state.desired.step !== state.desired.step ||
      result.state.pendingPhase !== state.pendingPhase ||
      result.state.emergencyRequests.length !== state.emergencyRequests.length ||
      result.state.emergencyRequests.some((request, index) => {
        const previous = state.emergencyRequests[index];
        return previous?.emergencyId !== request.emergencyId ||
          previous.expiresAt !== request.expiresAt;
      }) ||
      result.state.manualOverride?.phase !== state.manualOverride?.phase ||
      result.state.manualOverride?.expiresAt !== state.manualOverride?.expiresAt;
    const idleTick = input.type === "TICK" &&
      result.effects.length === 0 && !queueChanged && !stateChanged;

    for (const direction of ["NORTH", "SOUTH", "EAST", "WEST"] as const) {
      const delta = result.state.queueCounts[direction] - state.queueCounts[direction];
      if (delta !== 0) {
        await this.dependencies.updateQueueCount(client, junctionId, direction, delta);
      }
    }

    if (!idleTick) {
      await this.dependencies.updateJunctionState(
        client,
        junctionId,
        result.state.mode,
        result.state.actual.phase,
        result.state.mode === "DEGRADED" ? "DEGRADED" : row.controller_status,
      );
    }

    const commands: PersistedControllerCommand[] = [];
    for (const effect of result.effects) {
      commands.push(await this.dependencies.persistEffect(client, junctionId, effect, now));
    }

    if (!idleTick) {
      const eventType = input.type !== "TICK"
        ? input.type
        : state.mode !== result.state.mode
          ? "MODE_TIMEOUT"
          : result.effects.length > 0
            ? "TICK_TRANSITION"
            : "TICK_STATE_CHANGE";
      await this.dependencies.appendAudit(client, {
        junctionId,
        eventType,
        previousState: `${state.desired.phase}:${state.desired.step}`,
        newState: `${result.state.desired.phase}:${result.state.desired.step}`,
        details: { input },
      });
    }

    return { junctionId, state: result.state, effects: result.effects, commands };
  }

  async afterCommit(committed: CommittedDecision): Promise<void> {
    this.stateCache.set(committed.junctionId, committed.state);
    for (const command of committed.commands) {
      await this.dependencies.executeEffect(command);
    }
    await this.dependencies.emit({
      type: "JUNCTION_STATE",
      junctionId: committed.junctionId,
      state: committed.state,
      effects: committed.effects,
    });
  }

  async recoverStartup(now: number): Promise<JunctionState[]> {
    const junctionRows = await this.dependencies.listJunctions();
    const recovered: JunctionState[] = [];

    for (const listedRow of junctionRows) {
      const result = await this.runSerialized(listedRow.id, async () => {
        const committed = await this.dependencies.transact(async (client) => {
          const row = await this.dependencies.lockJunction(client, listedRow.id);
          if (row === undefined) throw new Error(`Junction not found during recovery: ${listedRow.id}`);

          const state = stateFromRow(
            row,
            await this.dependencies.getQueues(row.id, client),
            await this.dependencies.getActiveVehicles(row.id, client),
          );
          const supersededCount = await this.dependencies.supersedePendingCommands(client, row.id);
          const phase = parsePhase(row.current_phase);
          const redSignals = allRed();
          const nextState: JunctionState = {
            ...state,
            mode: "AUTOMATIC",
            pendingPhase: phase,
            emergencyRequests: [],
            manualOverride: null,
            desired: { phase, step: "ALL_RED", signals: redSignals },
            actual: {
              phase,
              step: "UNKNOWN",
              signals: allUnknown(),
              confirmedAt: now,
            },
          };

          await this.dependencies.updateJunctionState(client, row.id, "AUTOMATIC", phase, "RECOVERING");
          const effect: TrafficEffect = {
            type: "SET_DESIRED_SIGNALS",
            phase,
            step: "ALL_RED",
            signals: redSignals,
          };
          const command = await this.dependencies.persistEffect(client, row.id, effect, now);
          await this.dependencies.appendAudit(client, {
            junctionId: row.id,
            eventType: "RECOVERY_RESET",
            previousState: row.mode,
            newState: "ALL_RED",
            commandId: command.command_id,
            details: {
              previousPhase: row.current_phase,
              previousControllerStatus: row.controller_status,
              resetMode: "AUTOMATIC",
              recoveryPhase: phase,
              supersededCommands: supersededCount,
              rebuiltVehicleQueues: true,
            },
          });
          return { junctionId: row.id, state: nextState, effects: [effect], commands: [command] };
        });

        await this.afterCommit(committed);
        return committed.state;
      });
      recovered.push(result);
    }

    return recovered;
  }

  async confirmControllerState(
    junctionId: string,
    phase: Phase,
    step: "GREEN" | "YELLOW" | "ALL_RED",
    now: number,
  ): Promise<void> {
    const state = await this.runSerialized(junctionId, () => this.dependencies.transact(async (client) => {
      const row = await this.dependencies.lockJunction(client, junctionId);
      if (row === undefined) throw new Error(`Junction not found: ${junctionId}`);
      const current = this.stateCache.get(junctionId) ?? stateFromRow(
        row,
        await this.dependencies.getQueues(junctionId, client),
        await this.dependencies.getActiveVehicles(junctionId, client),
      );
      const actual = { phase, step, signals: signalsFor(phase, step), confirmedAt: now };
      const next = {
        ...current,
        actual,
        desired: current.desired.step === step && current.desired.phase === phase
          ? { phase, step, signals: signalsFor(phase, step) }
          : current.desired,
      };
      return next;
    }));
    this.stateCache.set(junctionId, state);
    await this.dependencies.emit({ type: "JUNCTION_STATE", junctionId, state, effects: [] });
  }

  clearCachedState(junctionId: string): void {
    this.stateCache.delete(junctionId);
  }
}

export function isJunctionInput(input: TrafficInput): boolean {
  return input.type !== "VEHICLE_ARRIVED" && input.type !== "VEHICLE_CLEARED";
}

export const junctionService = new JunctionService();