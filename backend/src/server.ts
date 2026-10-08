import dotenv from "dotenv";
import { createServer } from "node:http";
import { Server as SocketIOServer } from "socket.io";
import app, { setApiReady } from "./app.ts";
import pool from "./config/database.ts";
import { getCommandById } from "./models/command.model.ts";
import { junctionService } from "./services/junction.service.ts";
import { persistentCommandService } from "./services/command.service.ts";
import type { Phase, PhaseStep } from "./services/traffic.service.ts";

dotenv.config();

const PORT = Number(process.env.PORT) || 5000;
const TICK_INTERVAL_MS = Number(process.env.TICK_INTERVAL_MS) || 1_000;
const httpServer = createServer(app);
const io = new SocketIOServer(httpServer, {
  cors: { origin: process.env.FRONTEND_ORIGIN ?? "*" },
});
setApiReady(false);

junctionService.setEmitter((event) => {
  io.emit("junction:update", event);
});

persistentCommandService.setJunctionService(junctionService);

persistentCommandService.setEmitter(async (event) => {
  io.emit("controller:ack", event);
  if (event.type === "CONTROLLER_ALERT") {
    io.emit("controller:alert", event);
    return;
  }
  if (event.result !== "MATCHED" || !event.ack) return;

  const command = await getCommandById(event.ack.commandId);
  const phase = command?.direction;
  const step = command?.requested_state;
  if (
    (phase === "NORTH_SOUTH" || phase === "EAST_WEST") &&
    (step === "GREEN" || step === "YELLOW" || step === "ALL_RED")
  ) {
    await junctionService.confirmControllerState(
      event.ack.junctionId,
      phase as Phase,
      step as PhaseStep,
      Date.now(),
    );
  }
});

const startServer = async () => {
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      httpServer.once("error", onError);
      httpServer.listen(PORT, () => {
        httpServer.off("error", onError);
        httpServer.on("error", (error) => {
          console.error("HTTP server error:", error);
        });
        resolve();
      });
    });
    console.log(`HTTP listener acquired on port ${PORT}`);

    await pool.query("SELECT 1");

    console.log("Database connection successful");

    const recoveredStates = await junctionService.recoverStartup(Date.now());
    const junctionIds = recoveredStates.map((state) => state.junctionId);
    console.log(`Startup recovery completed for ${junctionIds.length} junction(s)`);
    setApiReady(true);

    setInterval(async () => {
      const now = Date.now();
      try {
        await persistentCommandService.checkTimeouts(now, junctionService);
      } catch (error) {
        console.error("Command timeout check failed:", error);
      }
      for (const junctionId of junctionIds) {
        void junctionService.process(junctionId, { type: "TICK" }, now).catch((error: unknown) => {
          console.error(`Junction tick failed for ${junctionId}:`, error);
        });
      }
    }, TICK_INTERVAL_MS);

    console.log(`Server running on http://localhost:${PORT}`);
  } catch (error) {
    const errorCode = (error as NodeJS.ErrnoException).code;
    if (errorCode === "EADDRINUSE") {
      console.error(
        `Port ${PORT} is already in use. Stop the existing backend or set a different PORT in backend/.env. Startup recovery was not run.`,
      );
    } else {
      console.error("Failed to start server:", error);
    }
    setApiReady(false);
    httpServer.close();
    io.close();
    await pool.end();
    process.exit(1);
  }
};

startServer();
