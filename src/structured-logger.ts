export interface StructuredLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export function createStructuredLogger(options?: {
  write?: (line: string) => void;
  fallbackWrite?: (line: string) => void;
}): StructuredLogger {
  const write = options?.write ?? ((line: string) => process.stderr.write(`${line}\n`));
  const fallbackWrite =
    options?.fallbackWrite ?? ((line: string) => process.stderr.write(`${line}\n`));

  const safeWrite = (line: string) => {
    try {
      write(line);
    } catch (error) {
      try {
        fallbackWrite(
          formatLine("warn", "log sink failure", {
            failed_line: line,
            reason: error instanceof Error ? error.message : String(error)
          })
        );
      } catch {
        // Sink isolation is best-effort only.
      }
    }
  };

  return {
    debug: (message, fields) => safeWrite(formatLine("debug", message, fields)),
    info: (message, fields) => safeWrite(formatLine("info", message, fields)),
    warn: (message, fields) => safeWrite(formatLine("warn", message, fields)),
    error: (message, fields) => safeWrite(formatLine("error", message, fields))
  };
}

function formatLine(level: string, message: string, fields: Record<string, unknown> = {}): string {
  const parts = [`level=${level}`, `msg=${quote(message)}`];

  for (const key of Object.keys(fields).sort()) {
    const value = fields[key];
    if (value == null) {
      continue;
    }
    parts.push(`${key}=${formatValue(value)}`);
  }

  return parts.join(" ");
}

function formatValue(value: unknown): string {
  if (typeof value === "string") {
    return /\s|=|"/.test(value) ? quote(value) : value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return quote(JSON.stringify(value));
}

function quote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}
