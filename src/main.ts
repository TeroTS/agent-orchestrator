import { runHost } from "./host.js";
import { createService } from "./service.js";

const exitCode = await runHost(process.argv.slice(2), {
  cwd: process.cwd(),
  createService
});

process.exitCode = exitCode;
