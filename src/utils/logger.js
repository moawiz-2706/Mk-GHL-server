// =============================================================================
// LOGGER
// Structured logging with timestamps and levels.
// Also maintains an in-memory buffer for real-time streaming to frontend.
// =============================================================================

const fs = require("fs");
const path = require("path");

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = LEVELS[process.env.LOG_LEVEL || "info"];

const logDir = path.join(__dirname, "../../logs");
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

const logFile = path.join(logDir, `sync-${new Date().toISOString().split("T")[0]}.log`);

// In-memory log buffer for real-time streaming
const logBuffer = [];
const MAX_BUFFER_SIZE = 5000;
let logSubscribers = [];

function log(level, message) {
  if (LEVELS[level] < currentLevel) return;

  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [${level.toUpperCase()}] ${message}`;
  console.log(line);

  // Append to log file
  try {
    fs.appendFileSync(logFile, line + "\n");
  } catch (_) {}

  // Store in memory buffer for frontend streaming
  const entry = { timestamp, level, message };
  logBuffer.push(entry);
  if (logBuffer.length > MAX_BUFFER_SIZE) {
    logBuffer.shift();
  }

  // Notify subscribers (Server-Sent Events)
  for (const sub of logSubscribers) {
    try { sub.write(`data: ${JSON.stringify(entry)}\n\n`); } catch (_) {}
  }
}

/**
 * Subscribe to real-time log events.
 * Returns an unsubscribe function.
 */
function subscribeLogStream(res) {
  logSubscribers.push(res);
  // Send the last 100 log entries as initial state
  for (const entry of logBuffer.slice(-100)) {
    try { res.write(`data: ${JSON.stringify(entry)}\n\n`); } catch (_) {}
  }
  return () => {
    logSubscribers = logSubscribers.filter(s => s !== res);
  };
}

module.exports = {
  debug: (msg) => log("debug", msg),
  info:  (msg) => log("info", msg),
  warn:  (msg) => log("warn", msg),
  error: (msg) => log("error", msg),
  subscribeLogStream
};
