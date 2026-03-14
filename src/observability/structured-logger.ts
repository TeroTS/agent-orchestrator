export interface StructuredLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export type StructuredLogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVEL_ORDER: Record<StructuredLogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export function resolveStructuredLogLevel(
  value: string | null | undefined,
): StructuredLogLevel {
  switch (value?.trim().toLowerCase()) {
    case "debug":
    case "info":
    case "warn":
    case "error":
      return value.trim().toLowerCase() as StructuredLogLevel;
    default:
      return "info";
  }
}

export function createStructuredLogger(options?: {
  level?: StructuredLogLevel;
  write?: (line: string) => void;
  fallbackWrite?: (line: string) => void;
}): StructuredLogger {
  const write =
    options?.write ?? ((line: string) => process.stderr.write(`${line}\n`));
  const fallbackWrite =
    options?.fallbackWrite ??
    ((line: string) => process.stderr.write(`${line}\n`));
  const minLevel = options?.level ?? "info";

  const safeWrite = (line: string) => {
    try {
      write(line);
    } catch (error) {
      try {
        fallbackWrite(
          formatLine("warn", "log sink failure", {
            failed_line: line,
            reason: error instanceof Error ? error.message : String(error),
          }),
        );
      } catch {
        // Sink isolation is best-effort only.
      }
    }
  };

  const shouldLog = (level: StructuredLogLevel): boolean =>
    LOG_LEVEL_ORDER[level] >= LOG_LEVEL_ORDER[minLevel];

  return {
    debug: (message, fields) => {
      if (shouldLog("debug")) {
        safeWrite(formatLine("debug", message, fields));
      }
    },
    info: (message, fields) => {
      if (shouldLog("info")) {
        safeWrite(formatLine("info", message, fields));
      }
    },
    warn: (message, fields) => {
      if (shouldLog("warn")) {
        safeWrite(formatLine("warn", message, fields));
      }
    },
    error: (message, fields) => {
      if (shouldLog("error")) {
        safeWrite(formatLine("error", message, fields));
      }
    },
  };
}

function formatLine(
  level: string,
  message: string,
  fields: Record<string, unknown> = {},
): string {
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
