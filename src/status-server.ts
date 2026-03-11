import { createServer, type Server } from "node:http";

export interface StatusServerHandle {
  baseUrl: string;
  stop(): Promise<void>;
}

export async function startStatusServer(options: {
  port: number;
  snapshot: () => unknown;
  refresh?: () => Promise<unknown> | unknown;
}): Promise<StatusServerHandle> {
  const server = createServer(async (request, response) => {
    const url = request.url ?? "/";

    if (url === "/api/v1/state") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(options.snapshot()));
      return;
    }

    if (url === "/api/v1/refresh") {
      const payload = options.refresh ? await options.refresh() : options.snapshot();
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(payload));
      return;
    }

    if (url.startsWith("/api/v1/") && url !== "/api/v1/state" && url !== "/api/v1/refresh") {
      const identifier = decodeURIComponent(url.slice("/api/v1/".length));
      const snapshot = options.snapshot() as {
        running?: Array<{ identifier: string }>;
        retries?: Array<{ identifier: string }>;
        completedIssueIds?: string[];
      };
      const running =
        snapshot.running?.find((entry) => entry.identifier === identifier) ?? null;
      const retry =
        snapshot.retries?.find((entry) => entry.identifier === identifier) ?? null;
      const completed = snapshot.completedIssueIds?.includes(identifier) ?? false;

      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ running, retry, completed }));
      return;
    }

    if (url === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(renderHtml(options.snapshot()));
      return;
    }

    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not Found");
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
    stop: () => stopServer(server)
  };
}

function renderHtml(snapshot: unknown): string {
  const escaped = JSON.stringify(snapshot, null, 2)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Symphony Status</title>
  </head>
  <body>
    <h1>Symphony Status</h1>
    <pre>${escaped}</pre>
  </body>
</html>`;
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
