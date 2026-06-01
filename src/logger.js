import { config } from './config.js';

function redact(value) {
  if (value == null) return value;
  if (typeof value !== 'string') return value;
  if (value.startsWith('sk-ant-')) return `sk-ant-...${value.slice(-6)}`;
  return value;
}

function serializeError(err) {
  if (!err) return null;
  return {
    name: err.name,
    message: err.message,
    code: err.code,
    status: err.status || err.statusCode || null,
    stack: err.stack,
  };
}

function normalizeFields(fields = {}) {
  const out = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value instanceof Error) out[key] = serializeError(value);
    else if (typeof value === 'string') out[key] = redact(value);
    else out[key] = value;
  }
  return out;
}

function emit(level, message, fields = {}) {
  const payload = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...normalizeFields(fields),
  };

  if (config.logFormat === 'pretty') {
    const rest = { ...payload };
    delete rest.ts;
    delete rest.level;
    delete rest.msg;
    const method = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    method(`[${payload.ts}] ${level.toUpperCase()} ${message}`, rest);
    return;
  }

  const line = JSON.stringify(payload);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const logger = {
  info(message, fields) {
    emit('info', message, fields);
  },
  warn(message, fields) {
    emit('warn', message, fields);
  },
  error(message, fields) {
    emit('error', message, fields);
  },
};
