import { createServer, type Server } from "node:http";

export interface StatusServerHandle {
  baseUrl: string;
  stop(): Promise<void>;
}

export async function startStatusServer(options: {
  port: number;
  snapshot: () => unknown;
}): Promise<StatusServerHandle> {
  const server = createServer((request, response) => {
    const url = request.url ?? "/";

    if (url === "/api/v1/state") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(options.snapshot()));
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
