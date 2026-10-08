import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { ApiController, type ApiControllerDependencies } from "../controllers/api.controller.ts";

const directionSchema = z.enum(["NORTH", "SOUTH", "EAST", "WEST"]);
const phaseSchema = z.enum(["NORTH_SOUTH", "EAST_WEST"]);
const vehicleTypeSchema = z.enum([
  "CAR",
  "MOTORCYCLE",
  "BUS",
  "TRUCK",
  "EMERGENCY",
  "EMPLOYEE_VEHICLE",
]);
const limitSchema = z.coerce.number().int().min(1).max(500).default(100);

const sensorEventSchema = z.object({
  eventId: z.string().trim().min(1).max(100),
  junctionId: z.string().trim().min(1).max(50),
  direction: directionSchema,
  eventType: z.enum(["ARRIVED", "CLEARED", "VEHICLE_ARRIVED", "VEHICLE_CLEARED"]),
  vehicleId: z.string().trim().min(1).max(100),
  vehicleType: vehicleTypeSchema.nullable().optional(),
  sequenceNo: z.number().int().nonnegative().nullable().optional(),
  sensorTimestamp: z.coerce.date(),
});

const commandSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("TARGET_PHASE_REQUEST"),
    junctionId: z.string().trim().min(1).max(50),
    phase: phaseSchema,
  }),
  z.object({
    type: z.literal("MANUAL_MODE_REQUEST"),
    junctionId: z.string().trim().min(1).max(50),
    phase: phaseSchema,
  }),
  z.object({
    type: z.literal("EMERGENCY_REQUEST"),
    junctionId: z.string().trim().min(1).max(50),
    emergencyId: z.string().trim().min(1).max(100),
    phase: phaseSchema,
    occurredAt: z.coerce.number().finite(),
  }),
  z.object({
    type: z.literal("RETURN_TO_AUTOMATIC"),
    junctionId: z.string().trim().min(1).max(50),
  }),
]);

const controllerAckSchema = z.object({
  commandId: z.string().trim().min(1).max(100),
  junctionId: z.string().trim().min(1).max(50),
  status: z.enum(["ACKNOWLEDGED", "FAILED", "TIMED_OUT"]),
  actualState: z.string().trim().min(1).max(20).nullable().optional(),
});

function asyncHandler(handler: RequestHandler): RequestHandler {
  return (request, response, next) => {
    Promise.resolve(handler(request, response, next)).catch(next);
  };
}

function sendResult(response: Parameters<RequestHandler>[1], result: { status: number; body: unknown }): void {
  response.status(result.status).json(result.body);
}

export function createApiRouter(dependencies?: ApiControllerDependencies): Router {
  const router = Router();
  const controller = new ApiController(dependencies);

  router.get("/junctions", asyncHandler(async (_request, response) => {
    sendResult(response, await controller.junctions());
  }));

  router.get("/junctions/:junctionId/status", asyncHandler(async (request, response) => {
    const junctionId = z.string().trim().min(1).max(50).parse(request.params.junctionId);
    sendResult(response, await controller.junctionStatus(junctionId));
  }));

  router.post("/sensor-events", asyncHandler(async (request, response) => {
    const parsed = sensorEventSchema.parse(request.body);
    const event = {
      eventId: parsed.eventId,
      junctionId: parsed.junctionId,
      direction: parsed.direction,
      eventType: parsed.eventType,
      vehicleId: parsed.vehicleId,
      sensorTimestamp: parsed.sensorTimestamp,
      ...(parsed.vehicleType !== undefined ? { vehicleType: parsed.vehicleType } : {}),
      ...(parsed.sequenceNo !== undefined ? { sequenceNo: parsed.sequenceNo } : {}),
    };
    sendResult(response, await controller.sensorEvent(event, Date.now()));
  }));

  router.post("/commands", asyncHandler(async (request, response) => {
    const input = commandSchema.parse(request.body);
    sendResult(response, await controller.command(input, Date.now()));
  }));

  router.get("/commands/:commandId", asyncHandler(async (request, response) => {
    const commandId = z.string().trim().min(1).max(100).parse(request.params.commandId);
    sendResult(response, await controller.commandById(commandId));
  }));

  router.get("/commands", asyncHandler(async (request, response) => {
    const query = z.object({
      junctionId: z.string().trim().min(1).max(50),
      limit: limitSchema,
    }).parse(request.query);
    sendResult(response, await controller.commands(query.junctionId, query.limit));
  }));

  router.post("/controller-events", asyncHandler(async (request, response) => {
    const ack = controllerAckSchema.parse(request.body);
    sendResult(response, await controller.controllerAck({
      ...ack,
      actualState: ack.actualState ?? null,
    }, Date.now()));
  }));

  router.get("/controller-events", asyncHandler(async (request, response) => {
    const query = z.object({
      junctionId: z.string().trim().min(1).max(50),
      limit: limitSchema,
    }).parse(request.query);
    sendResult(response, await controller.controllerEvents(query.junctionId, query.limit));
  }));

  router.get("/history", asyncHandler(async (request, response) => {
    const query = z.object({
      junctionId: z.string().trim().min(1).max(50),
      limit: limitSchema,
    }).parse(request.query);
    sendResult(response, await controller.history(query.junctionId, query.limit));
  }));

  return router;
}