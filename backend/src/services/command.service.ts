import { randomUUID } from "node:crypto";
import {
  decide,
  type JunctionState,
  type Phase,
  type PhaseStep,
  type SetDesiredSignalsEffect,
  type SignalState,
  type TrafficInput,
} from "./traffic.service.ts";
import type { PoolClient } from "pg";
import { withTransaction } from "../config/database.ts";
import {
  createCommand,
  getCommandById,
  getPendingCommands,
  updateCommandStatus,
} from "../models/command.model.ts";
import { createControllerEvent } from "../models/controller-event.model.ts";
import { appendHistory } from "../models/history.model.ts";
import { lockJunction, updateJunctionState } from "../models/junction.model.ts";

export const ACK_TIMEOUT_MS = typeof process !== "undefined" && process.env.ACK_TIMEOUT_MS
  ? Number(process.env.ACK_TIMEOUT_MS)
  : 5_000;
export const MAX_RETRIES = typeof process !== "undefined" && process.env.MAX_RETRIES
  ? Number(process.env.MAX_RETRIES)
  : 3;

export interface ControllerCommand {
  command_id: string;
  junction_id: string;
  phase: Phase;
  step: PhaseStep;
  signals: Record<"NORTH" | "SOUTH" | "EAST" | "WEST", SignalState>;
  issued_at: number;
}

export interface ControllerGateway {
  sendCommand(command: ControllerCommand): Promise<void>;
  reconnect(): Promise<void>;
}

export type AckResult = "MATCHED" | "DUPLICATE" | "UNKNOWN" | "LATE" | "REJECTED" | "MISMATCH";

type CommandStatus = "PENDING" | "ACKED" | "TIMED_OUT";

interface CommandRecord {
  command: ControllerCommand;
  status: CommandStatus;
  retries: number;
}

interface PendingCommand extends CommandRecord {
  lastSentAt: number;
  fallback: boolean;
}

export interface CommandServiceSnapshot {
  state: JunctionState;
  pendingCommand: ControllerCommand | null;
  retries: number;
}

export class RestSimulatorGateway implements ControllerGateway {
  constructor(
    private readonly baseUrl: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async sendCommand(command: ControllerCommand): Promise<void> {
    const response = await this.fetcher(`${this.baseUrl}/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(command),
    });

    if (!response.ok) {
      throw new Error(`Controller simulator rejected command: ${response.status}`);
    }
  }

  async reconnect(): Promise<void> {
    const response = await this.fetcher(`${this.baseUrl}/health`);
    if (!response.ok) {
      throw new Error(`Controller simulator is unavailable: ${response.status}`);
    }
  }
}

export class CommandService {
  private state: JunctionState;
  private pending: PendingCommand | null = null;
  private queuedEffect: SetDesiredSignalsEffect | null = null;
  private readonly history = new Map<string, CommandRecord>();

  constructor(
    initialState: JunctionState,
    private readonly gateway: ControllerGateway,
    private readonly ackTimeoutMs = ACK_TIMEOUT_MS,
    private readonly maxRetries = MAX_RETRIES,
  ) {
    this.state = initialState;
  }

  snapshot(): CommandServiceSnapshot {
    return {
      state: this.state,
      pendingCommand: this.pending?.command ?? null,
      retries: this.pending?.retries ?? 0,
    };
  }

  async dispatch(input: TrafficInput, now: number): Promise<CommandServiceSnapshot> {
    if (input.type === "TICK" && this.pending !== null) {
      await this.handleTimeout(now);
      return this.snapshot();
    }

    if (input.type === "TICK" && this.state.mode === "DEGRADED") {
      return this.snapshot();
    }

    const wasDegraded = this.state.mode === "DEGRADED";
    const result = decide(this.state, input, now);
    this.state = wasDegraded
      ? { ...result.state, mode: "DEGRADED" }
      : result.state;

    if (wasDegraded || this.state.mode === "DEGRADED") {
      return this.snapshot();
    }

    for (const effect of result.effects) {
      if (effect.type !== "SET_DESIRED_SIGNALS") continue;
      if (this.pending !== null) {
        this.queuedEffect = effect;
      } else {
        await this.sendEffect(effect, now);
      }
    }

    return this.snapshot();
  }

  handleAck(commandId: string, now: number): AckResult {
    const record = this.history.get(commandId);
    if (record === undefined) return "UNKNOWN";
    if (record.status === "ACKED") return "DUPLICATE";
    if (record.status === "TIMED_OUT") return "LATE";
    if (this.pending?.command.command_id !== commandId) return "UNKNOWN";

    record.status = "ACKED";
    this.state = {
      ...this.state,
      actual: {
        phase: record.command.phase,
        step: record.command.step,
        signals: { ...record.command.signals },
        confirmedAt: now,
      },
    };
    const wasFallback = this.pending.fallback;
    this.pending = null;

    if (!wasFallback && this.queuedEffect !== null && this.state.mode !== "DEGRADED") {
      const queuedEffect = this.queuedEffect;
      this.queuedEffect = null;
      void this.sendEffect(queuedEffect, now);
    }

    return "MATCHED";
  }

  async reconnect(now: number): Promise<boolean> {
    try {
      await this.gateway.reconnect();
    } catch {
      return false;
    }

    if (this.state.mode !== "DEGRADED") {
      if (this.pending !== null) {
        this.pending.lastSentAt = now;
        await this.sendToGateway(this.pending.command);
      }
      return true;
    }

    if (this.pending !== null) {
      const pendingRecord = this.history.get(this.pending.command.command_id);
      if (pendingRecord !== undefined) pendingRecord.status = "TIMED_OUT";
      this.pending = null;
    }

    const emergencyRequests = this.state.emergencyRequests.filter(
      (request) => request.expiresAt > now,
    );
    const manualOverride = this.state.manualOverride !== null &&
      this.state.manualOverride.expiresAt > now
      ? this.state.manualOverride
      : null;
    const mode = emergencyRequests.length > 0
      ? "EMERGENCY"
      : manualOverride !== null
        ? "MANUAL"
        : "AUTOMATIC";
    const recoveryPhase = this.state.pendingPhase ?? this.state.desired.phase;
    const signals: ControllerCommand["signals"] = {
      NORTH: "RED",
      SOUTH: "RED",
      EAST: "RED",
      WEST: "RED",
    };

    this.state = {
      ...this.state,
      mode,
      emergencyRequests,
      manualOverride,
      pendingPhase: recoveryPhase,
      desired: { phase: this.state.desired.phase, step: "ALL_RED", signals },
    };
    await this.sendEffect(
      {
        type: "SET_DESIRED_SIGNALS",
        phase: this.state.desired.phase,
        step: "ALL_RED",
        signals,
      },
      now,
      true,
    );
    return true;
  }

  private async handleTimeout(now: number): Promise<void> {
    const pending = this.pending;
    if (pending === null || now - pending.lastSentAt < this.ackTimeoutMs) return;

    if (pending.retries < this.maxRetries) {
      pending.retries += 1;
      pending.lastSentAt = now;
      await this.sendToGateway(pending.command);
      return;
    }

    const pendingRecord = this.history.get(pending.command.command_id);
    if (pendingRecord !== undefined) pendingRecord.status = "TIMED_OUT";
    this.pending = null;
    if (pending.fallback) {
      this.state = { ...this.state, mode: "DEGRADED" };
      return;
    }

    const allRed: ControllerCommand["signals"] = {
      NORTH: "RED",
      SOUTH: "RED",
      EAST: "RED",
      WEST: "RED",
    };
    this.state = {
      ...this.state,
      mode: "DEGRADED",
      pendingPhase: this.state.pendingPhase ?? pending.command.phase,
      desired: {
        phase: pending.command.phase,
        step: "ALL_RED",
        signals: allRed,
      },
    };
    this.queuedEffect = null;
    await this.sendEffect(
      {
        type: "SET_DESIRED_SIGNALS",
        phase: pending.command.phase,
        step: "ALL_RED",
        signals: allRed,
      },
      now,
      true,
    );
  }

  private async sendEffect(
    effect: SetDesiredSignalsEffect,
    now: number,
    fallback = false,
  ): Promise<void> {
    const command: ControllerCommand = {
      command_id: randomUUID(),
      junction_id: this.state.junctionId,
      phase: effect.phase,
      step: effect.step,
      signals: { ...effect.signals },
      issued_at: now,
    };
    const record: CommandRecord = { command, status: "PENDING", retries: 0 };
    this.history.set(command.command_id, record);
    this.pending = { ...record, lastSentAt: now, fallback };
    await this.sendToGateway(command);
  }

  private async sendToGateway(command: ControllerCommand): Promise<void> {
    try {
      await this.gateway.sendCommand(command);
    } catch {
      // Delivery failures are handled by the same ACK timeout and retry path.
    }
  }
}

export interface PersistedControllerCommand extends ControllerCommand {
  retries?: number;
}

export async function persistEffectCommand(
  client: PoolClient,
  junctionId: string,
  effect: SetDesiredSignalsEffect,
  now: number,
): Promise<PersistedControllerCommand> {
  const commandId = randomUUID();
  await createCommand({
    commandId,
    junctionId,
    command: "SET_SIGNALS",
    direction: effect.phase,
    requestedState: effect.step,
  }, client);
  return {
    command_id: commandId,
    junction_id: junctionId,
    phase: effect.phase,
    step: effect.step,
    signals: { ...effect.signals },
    issued_at: now,
  };
}

export interface ControllerAck {
  commandId: string;
  junctionId: string;
  status: string;
  actualState: string | null;
}

export class PersistentCommandService {
  private emitCallback: (event: {
    type: "CONTROLLER_ACK" | "CONTROLLER_ALERT" | "CONTROLLER_STATUS";
    result: AckResult | "OFFLINE" | "ONLINE";
    ack?: ControllerAck;
    details?: Record<string, unknown>;
  }) => void | Promise<void>;
  private readonly retryCounts = new Map<string, number>();
  private junctionServiceRef?: any;

  constructor(
    private readonly gateway: ControllerGateway,
    emit: (event: any) => void | Promise<void> = () => undefined,
    private readonly transact: typeof withTransaction = withTransaction,
    private readonly ackTimeoutMs: number = ACK_TIMEOUT_MS,
    private readonly maxRetries: number = MAX_RETRIES,
  ) {
    this.emitCallback = emit;
  }

  setJunctionService(service: any): void {
    this.junctionServiceRef = service;
  }

  setEmitter(emit: (event: any) => void | Promise<void>): void {
    this.emitCallback = emit;
  }

  async execute(command: PersistedControllerCommand): Promise<void> {
    try {
      await this.gateway.sendCommand(command);
    } catch {
      // Delivery failures are handled by ACK timeout and retries.
    }
  }

  async reconnect(): Promise<boolean> {
    try {
      await this.gateway.reconnect();
      return true;
    } catch {
      return false;
    }
  }

  async handleAck(ack: ControllerAck, now: number): Promise<AckResult> {
    const result = await this.transact(async (client) => {
      let command = await getCommandById(ack.commandId, client);
      if (command === undefined || command.junction_id !== ack.junctionId) {
        await appendHistory({
          junctionId: ack.junctionId,
          eventType: "UNKNOWN_CONTROLLER_COMMAND",
          commandId: ack.commandId,
          details: { status: ack.status, actualState: ack.actualState },
        }, client);
        return "UNKNOWN" as const;
      }

      const junction = await lockJunction(client, ack.junctionId);
      if (junction === undefined) return "UNKNOWN" as const;
      command = await getCommandById(ack.commandId, client);
      if (command === undefined) return "UNKNOWN" as const;

      if (command.status === "ACKNOWLEDGED") {
        await createControllerEvent({
          commandId: ack.commandId,
          junctionId: ack.junctionId,
          status: "DUPLICATE",
          actualState: ack.actualState,
        }, client);
        await appendHistory({
          junctionId: ack.junctionId,
          eventType: "DUPLICATE_CONTROLLER_ACK",
          commandId: ack.commandId,
          details: { actualState: ack.actualState },
        }, client);
        return "DUPLICATE" as const;
      }

      if (command.status === "TIMED_OUT" || command.status === "SUPERSEDED" || command.status === "FAILED") {
        await createControllerEvent({
          commandId: ack.commandId,
          junctionId: ack.junctionId,
          status: "LATE",
          actualState: ack.actualState,
        }, client);
        await appendHistory({
          junctionId: ack.junctionId,
          eventType: "LATE_CONTROLLER_ACK",
          previousState: command.status,
          newState: ack.actualState,
          commandId: ack.commandId,
          details: { status: ack.status, actualState: ack.actualState },
        }, client);
        return "LATE" as const;
      }

      if (ack.status !== "ACKNOWLEDGED") {
        await updateCommandStatus(ack.commandId, ack.status, false, client);
        await createControllerEvent({
          commandId: ack.commandId,
          junctionId: ack.junctionId,
          status: ack.status,
          actualState: ack.actualState,
        }, client);
        await appendHistory({
          junctionId: ack.junctionId,
          eventType: "CONTROLLER_REJECTED",
          previousState: command.status,
          newState: ack.status,
          commandId: ack.commandId,
          details: { actualState: ack.actualState },
        }, client);
        return "REJECTED" as const;
      }

      if (
        ack.actualState !== null &&
        ack.actualState !== undefined &&
        command.requested_state !== null &&
        ack.actualState !== command.requested_state
      ) {
        await updateCommandStatus(ack.commandId, "MISMATCH", false, client);
        await createControllerEvent({
          commandId: ack.commandId,
          junctionId: ack.junctionId,
          status: "MISMATCH",
          actualState: ack.actualState,
        }, client);
        await appendHistory({
          junctionId: ack.junctionId,
          eventType: "CONTROLLER_STATE_MISMATCH",
          previousState: command.requested_state,
          newState: ack.actualState,
          commandId: ack.commandId,
          details: {
            requestedState: command.requested_state,
            actualState: ack.actualState,
            alert: "STATE_MISMATCH",
          },
        }, client);
        return "MISMATCH" as const;
      }

      this.retryCounts.delete(ack.junctionId);
      await updateCommandStatus(ack.commandId, "ACKNOWLEDGED", true, client);
      const nextMode = junction.mode === "DEGRADED" ? "AUTOMATIC" : junction.mode;
      await updateJunctionState(
        client,
        ack.junctionId,
        nextMode,
        command.direction ?? junction.current_phase,
        "ONLINE",
      );
      await createControllerEvent({
        commandId: ack.commandId,
        junctionId: ack.junctionId,
        status: "ACKNOWLEDGED",
        actualState: ack.actualState,
      }, client);
      await appendHistory({
        junctionId: ack.junctionId,
        eventType: "CONTROLLER_ACKNOWLEDGED",
        previousState: command.status,
        newState: ack.actualState,
        commandId: ack.commandId,
        details: { acknowledgedAt: now },
      }, client);
      if (junction.mode === "DEGRADED") {
        await updateJunctionState(client, ack.junctionId, "AUTOMATIC", junction.current_phase, "ONLINE");
        await appendHistory({
          junctionId: ack.junctionId,
          eventType: "MODE_CHANGE",
          previousState: "DEGRADED",
          newState: "AUTOMATIC",
          details: { reason: "CONTROLLER_RECOVERY_ACKNOWLEDGED" },
        }, client);
      }
      return "MATCHED" as const;
    });

    if (result === "MISMATCH") {
      await this.emitCallback({
        type: "CONTROLLER_ALERT",
        result,
        ack,
        details: { alert: "STATE_MISMATCH" },
      });
    } else {
      await this.emitCallback({ type: "CONTROLLER_ACK", result, ack });
    }
    return result;
  }

  async handleOffline(junctionId: string, now: number): Promise<{ result: "OFFLINE"; junctionId: string }> {
    await this.transact(async (client) => {
      const junction = await lockJunction(client, junctionId);
      if (junction === undefined) throw new Error(`Junction not found: ${junctionId}`);

      await updateJunctionState(client, junctionId, "DEGRADED", junction.current_phase, "OFFLINE");
      await createControllerEvent({
        junctionId,
        status: "OFFLINE",
        commandId: null,
        actualState: null,
      }, client);
      await appendHistory({
        junctionId,
        eventType: "CONTROLLER_OFFLINE",
        previousState: junction.mode,
        newState: "DEGRADED",
        details: { controllerStatus: "OFFLINE" },
      }, client);
      if (junction.mode !== "DEGRADED") {
        await appendHistory({
          junctionId,
          eventType: "MODE_CHANGE",
          previousState: junction.mode,
          newState: "DEGRADED",
          details: { reason: "CONTROLLER_OFFLINE" },
        }, client);
      }
    });

    if (this.junctionServiceRef) {
      await this.junctionServiceRef.setDegraded(junctionId, now);
    }
    await this.emitCallback({
      type: "CONTROLLER_STATUS",
      result: "OFFLINE",
      details: { junctionId, controllerStatus: "OFFLINE", mode: "DEGRADED" },
    });
    return { result: "OFFLINE", junctionId };
  }

  async handleOnline(junctionId: string, now: number): Promise<{ result: "ONLINE"; junctionId: string; commandId: string }> {
    const resendCommand = await this.transact(async (client) => {
      const junction = await lockJunction(client, junctionId);
      if (junction === undefined) throw new Error(`Junction not found: ${junctionId}`);

      await updateJunctionState(client, junctionId, junction.mode, junction.current_phase, "ONLINE");
      await createControllerEvent({
        junctionId,
        status: "ONLINE",
        commandId: null,
        actualState: null,
      }, client);
      await appendHistory({
        junctionId,
        eventType: "CONTROLLER_ONLINE",
        details: { controllerStatus: "ONLINE" },
      }, client);

      const freshCommandId = randomUUID();
      const phase = (junction.current_phase as Phase) ?? "NORTH_SOUTH";
      const step: PhaseStep = "ALL_RED";
      await createCommand({
        commandId: freshCommandId,
        junctionId,
        command: "SET_SIGNALS",
        direction: phase,
        requestedState: step,
        status: "PENDING",
      }, client);
      await appendHistory({
        junctionId,
        eventType: "CONTROLLER_RECOVERY_COMMAND",
        commandId: freshCommandId,
        details: { phase, step, resendReason: "CONTROLLER_ONLINE" },
      }, client);

      const redSignals: Record<"NORTH" | "SOUTH" | "EAST" | "WEST", SignalState> = {
        NORTH: "RED",
        SOUTH: "RED",
        EAST: "RED",
        WEST: "RED",
      };
      const command: PersistedControllerCommand = {
        command_id: freshCommandId,
        junction_id: junctionId,
        phase,
        step,
        signals: redSignals,
        issued_at: now,
      };
      return command;
    });

    await this.execute(resendCommand);
    await this.emitCallback({
      type: "CONTROLLER_STATUS",
      result: "ONLINE",
      details: { junctionId, controllerStatus: "ONLINE", resendCommandId: resendCommand.command_id },
    });
    return { result: "ONLINE", junctionId, commandId: resendCommand.command_id };
  }

  async checkTimeouts(now: number, junctionService?: any): Promise<void> {
    const service = junctionService ?? this.junctionServiceRef;
    const pendingList = await getPendingCommands();
    for (const pending of pendingList) {
      const issuedAt = pending.created_at.getTime();
      if (now - issuedAt < this.ackTimeoutMs) continue;

      let commandToExecute: PersistedControllerCommand | null = null;
      let shouldDegrade = false;

      await this.transact(async (client) => {
        const junction = await lockJunction(client, pending.junction_id);
        if (junction === undefined) return;

        const currentCmd = await getCommandById(pending.command_id, client);
        if (currentCmd === undefined || currentCmd.status !== "PENDING") return;

        await updateCommandStatus(pending.command_id, "TIMED_OUT", false, client);
        const retries = (this.retryCounts.get(pending.junction_id) ?? 0) + 1;

        await appendHistory({
          junctionId: pending.junction_id,
          eventType: "CONTROLLER_TIMEOUT",
          previousState: "PENDING",
          newState: "TIMED_OUT",
          commandId: pending.command_id,
          details: {
            retryCount: retries,
            maxRetries: this.maxRetries,
            issuedAt,
            timedOutAt: now,
            durationMs: now - issuedAt,
          },
        }, client);

        if (retries <= this.maxRetries) {
          this.retryCounts.set(pending.junction_id, retries);
          const newCommandId = randomUUID();
          await createCommand({
            commandId: newCommandId,
            junctionId: pending.junction_id,
            command: pending.command,
            direction: pending.direction,
            requestedState: pending.requested_state,
            status: "PENDING",
          }, client);
          await appendHistory({
            junctionId: pending.junction_id,
            eventType: "CONTROLLER_RETRY",
            commandId: newCommandId,
            details: {
              retryNumber: retries,
              previousCommandId: pending.command_id,
              phase: pending.direction,
              step: pending.requested_state,
            },
          }, client);

          const redSignals: Record<"NORTH" | "SOUTH" | "EAST" | "WEST", SignalState> = {
            NORTH: pending.direction === "NORTH_SOUTH" && pending.requested_state === "GREEN" ? "GREEN" : pending.direction === "NORTH_SOUTH" && pending.requested_state === "YELLOW" ? "YELLOW" : "RED",
            SOUTH: pending.direction === "NORTH_SOUTH" && pending.requested_state === "GREEN" ? "GREEN" : pending.direction === "NORTH_SOUTH" && pending.requested_state === "YELLOW" ? "YELLOW" : "RED",
            EAST: pending.direction === "EAST_WEST" && pending.requested_state === "GREEN" ? "GREEN" : pending.direction === "EAST_WEST" && pending.requested_state === "YELLOW" ? "YELLOW" : "RED",
            WEST: pending.direction === "EAST_WEST" && pending.requested_state === "GREEN" ? "GREEN" : pending.direction === "EAST_WEST" && pending.requested_state === "YELLOW" ? "YELLOW" : "RED",
          };
          commandToExecute = {
            command_id: newCommandId,
            junction_id: pending.junction_id,
            phase: (pending.direction as Phase) ?? "NORTH_SOUTH",
            step: (pending.requested_state as PhaseStep) ?? "ALL_RED",
            signals: redSignals,
            issued_at: now,
          };
        } else {
          this.retryCounts.delete(pending.junction_id);
          await updateJunctionState(
            client,
            pending.junction_id,
            "DEGRADED",
            pending.direction ?? junction.current_phase,
            "DEGRADED",
          );
          await appendHistory({
            junctionId: pending.junction_id,
            eventType: "CONTROLLER_RETRIES_EXHAUSTED",
            previousState: junction.mode,
            newState: "DEGRADED",
            details: { retries, maxRetries: this.maxRetries },
          }, client);
          if (junction.mode !== "DEGRADED") {
            await appendHistory({
              junctionId: pending.junction_id,
              eventType: "MODE_CHANGE",
              previousState: junction.mode,
              newState: "DEGRADED",
              details: { reason: "CONTROLLER_RETRIES_EXHAUSTED" },
            }, client);
          }
          shouldDegrade = true;
        }
      });

      if (commandToExecute) {
        void this.execute(commandToExecute);
      }

      if (shouldDegrade) {
        if (service) {
          await service.setDegraded(pending.junction_id, now);
        }

        await this.emitCallback({
          type: "CONTROLLER_ALERT",
          result: "REJECTED",
          details: {
            junctionId: pending.junction_id,
            alert: "RETRIES_EXHAUSTED",
            mode: "DEGRADED",
          },
        });
      }
    }
  }
}

export const persistentCommandService = new PersistentCommandService(
  new RestSimulatorGateway(process.env.CONTROLLER_URL ?? "http://127.0.0.1:6000"),
);