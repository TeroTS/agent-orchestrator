import { createServer, type Server } from "node:http";

import {
  createStructuredLogger,
  type StructuredLogger,
} from "./structured-logger.js";
import { handleStatusRequest } from "./status-handler.js";

export interface StatusServerHandle {
  baseUrl: string;
  stop(): Promise<void>;
}

export async function startStatusServer(options: {
  port: number;
  snapshot: () => unknown;
  refresh?: () => Promise<unknown> | unknown;
  logger?: StructuredLogger;
}): Promise<StatusServerHandle> {
  const logger = options.logger ?? createStructuredLogger();

  const server = createServer(async (request, response) => {
    const result = await handleStatusRequest({
      method: request.method,
      url: request.url,
      snapshot: options.snapshot,
      refresh: options.refresh,
      logger,
    });
    response.writeHead(result.statusCode, {
      "content-type": result.contentType,
    });
    response.end(result.body);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to determine status server address.");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    stop: () => stopServer(server),
  };
}

function stopServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
