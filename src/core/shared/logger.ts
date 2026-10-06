import { redactSecrets } from './secrets.js';

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

export interface LogRecord {
  at: string;
  level: LogLevel;
  scope: string;
  message: string;
  data?: Record<string, unknown>;
}

type Sink = (record: LogRecord) => void;

const sinks: Sink[] = [];
const buffer: LogRecord[] = [];
const MAX_BUFFER = 2000;

export function addLogSink(sink: Sink): () => void {
  sinks.push(sink);
  return () => {
    const i = sinks.indexOf(sink);
    if (i >= 0) sinks.splice(i, 1);
  };
}

export function recentLogs(limit = 200): LogRecord[] {
  return buffer.slice(-limit);
}

function emit(level: LogLevel, scope: string, message: string, data?: Record<string, unknown>) {
  const record: LogRecord = {
    at: new Date().toISOString(),
    level,
    scope,
    message: redactSecrets(message),
    data: data ? JSON.parse(redactSecrets(JSON.stringify(data))) : undefined
  };
  buffer.push(record);
  if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER);
  for (const sink of sinks) {
    try {
      sink(record);
    } catch {
      /* a failing sink must never break the app */
    }
  }
}

export interface Logger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (m, d) => emit('DEBUG', scope, m, d),
    info: (m, d) => emit('INFO', scope, m, d),
    warn: (m, d) => emit('WARN', scope, m, d),
    error: (m, d) => emit('ERROR', scope, m, d)
  };
}
