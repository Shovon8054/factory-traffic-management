import {
  getJunctionById,
  getQueues,
  listJunctions,
} from "../models/junction.model.ts";
import { getCommandById, listCommands } from "../models/command.model.ts";
import { listControllerEvents } from "../models/controller-event.model.ts";
import { getHistory } from "../models/history.model.ts";
import { junctionService, type JunctionService } from "../services/junction.service.ts";
import {
  persistentCommandService,
  type PersistentCommandService,
} from "../services/command.service.ts";
import {
  sensorService,
  type SensorService,
  type SensorEvent,
} from "../services/sensor.service.ts";
import type { TrafficInput } from "../services/traffic.service.ts";
import { ApiError } from "../middleware/error.middleware.ts";

export interface ApiControllerDependencies {
  junctionService: Pick<JunctionService, "process" | "getState">;
  sensorService: Pick<SensorService, "handle">;
  commandService: Pick<PersistentCommandService, "handleAck">;
  listJunctions: typeof listJunctions;
  getJunctionById: typeof getJunctionById;
  getQueues: typeof getQueues;
  getCommandById: typeof getCommandById;
  listCommands: typeof listCommands;
  listControllerEvents: typeof listControllerEvents;
  getHistory: typeof getHistory;
}

export interface HttpResult {
  status: number;
  body: unknown;
}

const defaultDependencies: ApiControllerDependencies = {
  junctionService,
  sensorService,
  commandService: persistentCommandService,
  listJunctions,
  getJunctionById,
  getQueues,
  getCommandById,
  listCommands,
  listControllerEvents,
  getHistory,
};

export class ApiController {
  constructor(private readonly dependencies: ApiControllerDependencies = defaultDependencies) {}

  async junctions(): Promise<HttpResult> {
    return { status: 200, body: { junctions: await this.dependencies.listJunctions() } };
  }

  async junctionStatus(junctionId: string): Promise<HttpResult> {
    const junction = await this.dependencies.getJunctionById(junctionId);
    if (junction === undefined) throw new ApiError(404, "JUNCTION_NOT_FOUND", "Junction not found");
    const queues = await this.dependencies.getQueues(junctionId);
    const state = await this.dependencies.junctionService.getState(junctionId);
    return { status: 200, body: { junction, queues, state } };
  }

  async sensorEvent(event: SensorEvent, now: number): Promise<HttpResult> {
    const junction = await this.dependencies.getJunctionById(event.junctionId);
    if (junction === undefined) throw new ApiError(404, "JUNCTION_NOT_FOUND", "Junction not found");
    const result = await this.dependencies.sensorService.handle(event, now);
    if (result.status === "ACCEPTED") return { status: 201, body: result };
    if (result.status === "DUPLICATE") return { status: 200, body: result };
    if (result.status === "INVALID") {
      throw new ApiError(400, "INVALID_SENSOR_EVENT", result.reason);
    }
    throw new ApiError(409, result.status, result.reason);
  }

  async command(input: TrafficInput & { junctionId: string }, now: number): Promise<HttpResult> {
    const junction = await this.dependencies.getJunctionById(input.junctionId);
    if (junction === undefined) throw new ApiError(404, "JUNCTION_NOT_FOUND", "Junction not found");
    const { junctionId, ...trafficInput } = input;
    const state = await this.dependencies.junctionService.process(junctionId, trafficInput, now);
    return { status: 201, body: { junctionId, state } };
  }

  async commandById(commandId: string): Promise<HttpResult> {
    const command = await this.dependencies.getCommandById(commandId);
    if (command === undefined) throw new ApiError(404, "COMMAND_NOT_FOUND", "Command not found");
    return { status: 200, body: { command } };
  }

  async commands(junctionId: string, limit: number): Promise<HttpResult> {
    const junction = await this.dependencies.getJunctionById(junctionId);
    if (junction === undefined) throw new ApiError(404, "JUNCTION_NOT_FOUND", "Junction not found");
    return {
      status: 200,
      body: { commands: await this.dependencies.listCommands(junctionId, limit) },
    };
  }

  async controllerAck(ack: {
    commandId: string;
    junctionId: string;
    status: string;
    actualState: string | null;
  }, now: number): Promise<HttpResult> {
    const junction = await this.dependencies.getJunctionById(ack.junctionId);
    if (junction === undefined) throw new ApiError(404, "JUNCTION_NOT_FOUND", "Junction not found");
    const result = await this.dependencies.commandService.handleAck(ack, now);
    if (result === "UNKNOWN") throw new ApiError(404, "COMMAND_NOT_FOUND", "Controller command not found");
    if (result === "LATE") throw new ApiError(409, "LATE_ACK", "Acknowledgement arrived after command expiry");
    return { status: result === "DUPLICATE" ? 200 : 201, body: { result, commandId: ack.commandId } };
  }

  async controllerEvents(junctionId: string, limit: number): Promise<HttpResult> {
    const junction = await this.dependencies.getJunctionById(junctionId);
    if (junction === undefined) throw new ApiError(404, "JUNCTION_NOT_FOUND", "Junction not found");
    return {
      status: 200,
      body: { events: await this.dependencies.listControllerEvents(junctionId, limit) },
    };
  }

  async history(junctionId: string, limit: number): Promise<HttpResult> {
    const junction = await this.dependencies.getJunctionById(junctionId);
    if (junction === undefined) throw new ApiError(404, "JUNCTION_NOT_FOUND", "Junction not found");
    return { status: 200, body: { history: await this.dependencies.getHistory(junctionId, limit) } };
  }
}