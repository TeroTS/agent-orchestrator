import { runCli } from "./cli.js";
import { createService } from "./service.js";

const exitCode = await runCli(process.argv.slice(2), {
  cwd: process.cwd(),
  createService
});

process.exitCode = exitCode;
