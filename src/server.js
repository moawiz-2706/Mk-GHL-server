// =============================================================================
// Mary Kay InTouch — GoHighLevel Sync Server (Puppeteer-Direct Architecture)
// Entry Point
// =============================================================================

require("dotenv").config();

const express = require("express");
const { loadConfig } = require("./core/config");
const { startCron } = require("./scheduler/cron");
const { closeAllSessions } = require("./sessions/sessionManager");
const routes = require("./api/routes");
const logger = require("./utils/logger");

const PORT = process.env.PORT || 3000;

// ── Initialize ──
logger.info("═══════════════════════════════════════════════════════");
logger.info("  Mary Kay InTouch — GoHighLevel Sync Server");
logger.info("  Version 2.0.0 (Puppeteer-Direct Architecture)");
logger.info("═══════════════════════════════════════════════════════");

// Load configuration
try {
  loadConfig();
} catch (e) {
  logger.error(`Configuration error: ${e.message}`);
  process.exit(1);
}

// Create Express app
const app = express();
app.use(express.json());

// Mount routes
app.use("/", routes);

// ── Start Server ──
app.listen(PORT, () => {
  logger.info(`[Server] Listening on port ${PORT}`);

  // Start cron scheduler if configured
  startCron();

  logger.info("[Server] Ready.");
  logger.info(`[Server] Health check: http://localhost:${PORT}/health`);
  logger.info("[Server] Architecture: Puppeteer-Direct (browser stays alive for API calls)");
});

// Graceful shutdown — close all browser sessions
process.on("SIGTERM", async () => {
  logger.info("[Server] SIGTERM received. Shutting down gracefully...");
  await closeAllSessions();
  process.exit(0);
});

process.on("SIGINT", async () => {
  logger.info("[Server] SIGINT received. Shutting down gracefully...");
  await closeAllSessions();
  process.exit(0);
});

module.exports = app;
