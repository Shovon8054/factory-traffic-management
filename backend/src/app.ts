import express from "express";
import cors from "cors";
import { createApiRouter } from "./routes/api.routes.ts";
import { errorMiddleware } from "./middleware/error.middleware.ts";
import type { ApiControllerDependencies } from "./controllers/api.controller.ts";

let apiReady = true;

export function setApiReady(ready: boolean): void {
  apiReady = ready;
}

export function createApp(dependencies?: ApiControllerDependencies) {
  const app = express();

  app.use(cors());
  app.use(express.json());

  app.get("/", (_req, res) => {
    res.json({
      message: "Factory Traffic Management API is running",
    });
  });

  app.use("/api", (_request, response, next) => {
    if (!apiReady) {
      response.status(503).json({
        error: { code: "SERVER_INITIALIZING", message: "Server startup recovery is in progress" },
      });
      return;
    }
    next();
  });
  app.use("/api", createApiRouter(dependencies));
  app.use(errorMiddleware);

  return app;
}

const app = createApp();

export default app;