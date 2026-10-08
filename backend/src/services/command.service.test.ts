import { describe, expect, it } from "vitest";
import {
  MAX_RETRIES,
  CommandService,
  type ControllerCommand,
  type ControllerGateway,
} from "./command.service.ts";
import {
  DEFAULT_JUNCTION_CONFIG,
  type JunctionState,
  type SignalState,
} from "./traffic.service.ts";

class MockGateway implements ControllerGateway {
  readonly commands: ControllerCommand[] = [];
  reconnectCount = 0;

  async sendCommand(command: ControllerCommand): Promise<void> {
    this.commands.push(command);
  }

  async reconnect(): Promise<void> {
    this.reconnectCount += 1;
  }
}

function createState(): JunctionState {
  const signals: Record<"NORTH" | "SOUTH" | "EAST" | "WEST", SignalState> = {
    NORTH: "GREEN",
    SOUTH: "GREEN",
    EAST: "RED",
    WEST: "RED",
  };

  return {
    junctionId: "A",
    mode: "AUTOMATIC",
    config: {
      ...DEFAULT_JUNCTION_CONFIG,
      durations: { ...DEFAULT_JUNCTION_CONFIG.durations, ALL_RED: 1_000 },
    },
    pendingPhase: null,
    emergencyRequests: [],
    manualOverride: null,
    desired: { phase: "NORTH_SOUTH", step: "GREEN", signals: { ...signals } },
    actual: {
      phase: "NORTH_SOUTH",
      step: "GREEN",
      signals: { ...signals },
      confirmedAt: 0,
    },
    queues: { NORTH: [], SOUTH: [], EAST: [], WEST: [] },
    queueCounts: { NORTH: 0, SOUTH: 0, EAST: 0, WEST: 0 },
  };
}

async function transitionToYellow(service: CommandService): Promise<ControllerCommand> {
  await service.dispatch({ type: "TARGET_PHASE_REQUEST", phase: "EAST_WEST" }, 0);
  const command = service.snapshot().pendingCommand;
  if (command === null) throw new Error("Expected a yellow command to be pending");
  return command;
}

async function timeOutInitialCommand(service: CommandService): Promise<void> {
  for (const now of [5_000, 10_000, 15_000, 20_000]) {
    await service.dispatch({ type: "TICK" }, now);
  }
}

describe("CommandService", () => {
  it("does not advance to GREEN when the ALL_RED command receives no ACK", async () => {
    const gateway = new MockGateway();
    const service = new CommandService(createState(), gateway);
    const yellowCommand = await transitionToYellow(service);
    expect(service.handleAck(yellowCommand.command_id, 100)).toBe("MATCHED");
    await service.dispatch({ type: "TICK" }, 3_100);
    const allRedCommand = service.snapshot().pendingCommand;
    expect(allRedCommand?.step).toBe("ALL_RED");

    for (const now of [8_100, 13_100, 18_100, 23_100]) {
      await service.dispatch({ type: "TICK" }, now);
    }

    const snapshot = service.snapshot();
    expect(snapshot.state.mode).toBe("DEGRADED");
    expect(snapshot.state.desired.step).toBe("ALL_RED");
    expect(snapshot.state.desired.signals).toEqual({
      NORTH: "RED",
      SOUTH: "RED",
      EAST: "RED",
      WEST: "RED",
    });
    expect(snapshot.state.actual.step).toBe("YELLOW");
    expect(snapshot.pendingCommand?.step).toBe("ALL_RED");
    expect(snapshot.state.desired.step).not.toBe("GREEN");
    expect(gateway.commands.filter((command) => command.command_id === allRedCommand?.command_id))
      .toHaveLength(MAX_RETRIES + 1);
  });

  it("handles matching, duplicate, unknown, and late acknowledgements", async () => {
    const gateway = new MockGateway();
    const service = new CommandService(createState(), gateway);
    const command = await transitionToYellow(service);

    expect(service.handleAck("unknown-command", 10)).toBe("UNKNOWN");
    expect(service.handleAck(command.command_id, 100)).toBe("MATCHED");
    expect(service.snapshot().state.actual.step).toBe("YELLOW");
    expect(service.snapshot().state.actual.confirmedAt).toBe(100);
    expect(service.handleAck(command.command_id, 110)).toBe("DUPLICATE");

    const lateGateway = new MockGateway();
    const lateService = new CommandService(createState(), lateGateway);
    const timedOutCommand = await transitionToYellow(lateService);
    await timeOutInitialCommand(lateService);
    expect(lateService.handleAck(timedOutCommand.command_id, 21_000)).toBe("LATE");
    expect(lateService.snapshot().state.actual.step).toBe("GREEN");
  });

  it("reconnects from DEGRADED by resynchronizing all-red before resuming", async () => {
    const gateway = new MockGateway();
    const service = new CommandService(createState(), gateway);
    await transitionToYellow(service);
    await timeOutInitialCommand(service);

    const reconnected = await service.reconnect(21_000);
    expect(reconnected).toBe(true);
    expect(gateway.reconnectCount).toBe(1);
    expect(service.snapshot().state.mode).toBe("AUTOMATIC");
    expect(service.snapshot().state.desired.step).toBe("ALL_RED");

    const syncCommand = service.snapshot().pendingCommand;
    expect(syncCommand?.step).toBe("ALL_RED");
    expect(syncCommand?.signals.EAST).toBe("RED");
    expect(service.handleAck(syncCommand!.command_id, 21_100)).toBe("MATCHED");

    await service.dispatch({ type: "TICK" }, 22_100);
    expect(service.snapshot().state.desired.phase).toBe("EAST_WEST");
    expect(service.snapshot().state.desired.step).toBe("GREEN");
    expect(service.snapshot().pendingCommand?.step).toBe("GREEN");
  });
});