import { randomUUID } from "node:crypto";
import {
  decide,
  type JunctionState,
  type Phase,
  type PhaseStep,
  type SignalState,
  type TrafficEffect,
  type TrafficInput,
} from "./traffic.service.ts";
import type { PoolClient } from "pg";
import { withTransaction } from "../config/database.ts";
import {
  createCommand,
  getCommandById,
  updateCommandStatus,
} from "../models/command.model.ts";
import { createControllerEvent } from "../models/controller-event.model.ts";
import { appendHistory } from "../models/history.model.ts";
import { lockJunction, updateJunctionState } from "../models/junction.model.ts";

export const ACK_TIMEOUT_MS = 5_000;
export const MAX_RETRIES = 3;

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

export type AckResult = "MATCHED" | "DUPLICATE" | "UNKNOWN" | "LATE" | "REJECTED";

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
  private queuedEffect: TrafficEffect | null = null;
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
    effect: TrafficEffect,
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
  effect: TrafficEffect,
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
    type: "CONTROLLER_ACK";
    result: AckResult;
    ack: ControllerAck;
  }) => void | Promise<void>;

  constructor(
    private readonly gateway: ControllerGateway,
    emit: (event: {
      type: "CONTROLLER_ACK";
      result: AckResult;
      ack: ControllerAck;
    }) => void | Promise<void> = () => undefined,
    private readonly transact: typeof withTransaction = withTransaction,
  ) {
    this.emitCallback = emit;
  }

  setEmitter(emit: (event: {
    type: "CONTROLLER_ACK";
    result: AckResult;
    ack: ControllerAck;
  }) => void | Promise<void>): void {
    this.emitCallback = emit;
  }

  async execute(command: PersistedControllerCommand): Promise<void> {
    try {
      await this.gateway.sendCommand(command);
    } catch {
      // Command remains PENDING for the retry worker or a later reconnect.
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
      if (command === undefined || command.junction_id !== ack.junctionId) return "UNKNOWN" as const;
      const junction = await lockJunction(client, ack.junctionId);
      if (junction === undefined) return "UNKNOWN" as const;
      command = await getCommandById(ack.commandId, client);
      if (command === undefined) return "UNKNOWN" as const;
      if (command.status === "ACKNOWLEDGED") return "DUPLICATE" as const;
      if (command.status === "TIMED_OUT" || command.status === "FAILED") return "LATE" as const;
      if (ack.status !== "ACKNOWLEDGED") {
        await updateCommandStatus(ack.commandId, ack.status, false, client);
        await createControllerEvent({
          commandId: ack.commandId,
          junctionId: ack.junctionId,
          status: ack.status,
          actualState: ack.actualState,
        }, client);
        return "REJECTED" as const;
      }

      await updateCommandStatus(ack.commandId, "ACKNOWLEDGED", true, client);
      await updateJunctionState(
        client,
        ack.junctionId,
        junction.mode,
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
      return "MATCHED" as const;
    });

    await this.emitCallback({ type: "CONTROLLER_ACK", result, ack });
    return result;
  }
}

export const persistentCommandService = new PersistentCommandService(
  new RestSimulatorGateway(process.env.CONTROLLER_URL ?? "http://127.0.0.1:6000"),
);