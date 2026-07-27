// =============================================================================
// API ROUTES
// HTTP endpoints for triggering syncs, checking status, and managing config.
// All endpoints are protected by the API_SECRET_KEY.
// =============================================================================

const express = require("express");
const { getClients, getClientByNum, reloadConfig, getServerConfig } = require("../core/config");
const { runFullSync, runSingleClientSync, getExecutionState, isRunning } = require("../scheduler/orchestrator");
const { getCacheStatus, getSession, invalidateSession } = require("../sessions/sessionManager");
const { fetchRawData, fetchProcessedContacts, validateAllData, exportAllLists, exportGhlReadyContacts, exportGhlReadyCsv } = require("../processors/diagnostics");
const { startCron, stopCron, restartCron } = require("../scheduler/cron");
const { getProgressStream, subscribeProgress } = require("../scheduler/progress.js");
const fs = require("fs");
const path = require("path");
const logger = require("../utils/logger");

const router = express.Router();

// ── CORS Headers (allow Vercel frontend to access) ──
router.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, x-api-key");
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
});

// ── Authentication Middleware ──
function requireAuth(req, res, next) {
  const apiKey = req.headers["x-api-key"] || req.query.apiKey;
  if (!apiKey || apiKey !== process.env.API_SECRET_KEY) {
    return res.status(401).json({ error: "Invalid or missing API key." });
  }
  next();
}

// ── Health Check (no auth required) ──
router.get("/health", (req, res) => {
  res.json({
    status:  "ok",
    uptime:  process.uptime(),
    clients: getClients().length
  });
});

// ── GET /api/clients — List all configured clients ──
router.get("/api/clients", requireAuth, (req, res) => {
  const clients = getClients();
  res.json({
    count: clients.length,
    clients: clients.map(c => ({
      consultantNum: c.consultantNum,
      clientName:    c.clientName,
      locationId:    c.ghlLocationId
    }))
  });
});

// ── POST /api/sync/all — Trigger full sync for all clients ──
router.post("/api/sync/all", requireAuth, async (req, res) => {
  if (isRunning()) {
    return res.status(409).json({ error: "Sync already in progress." });
  }

  const clients = getClients();
  logger.info("[API] Full sync triggered via API.");

  const syncPromise = runFullSync(clients);
  syncPromise.catch(err => {
    logger.error(`[API] Full sync failed: ${err.message}`);
  });

  res.json({
    status:  "started",
    message: `Full sync initiated for ${clients.length} client(s).`
  });
});

// ── POST /api/sync/:consultantNum — Trigger sync for a single client ──
router.post("/api/sync/:consultantNum", requireAuth, async (req, res) => {
  if (isRunning()) {
    return res.status(409).json({ error: "Sync already in progress." });
  }

  const client = getClientByNum(req.params.consultantNum);
  if (!client) {
    return res.status(404).json({ error: "Client not found." });
  }

  logger.info(`[API] Single client sync triggered: ${client.clientName}`);

  const syncPromise = runSingleClientSync(client);
  syncPromise.catch(err => {
    logger.error(`[API] Single client sync failed: ${err.message}`);
  });

  res.json({
    status:  "started",
    message: `Sync initiated for ${client.clientName} (${client.consultantNum}).`
  });
});

// ── GET /api/status — Get current execution state ──
router.get("/api/status", requireAuth, (req, res) => {
  const state = getExecutionState();
  if (!state) {
    return res.json({ status: "idle", message: "No sync in progress." });
  }
  res.json(state);
});

// ── GET /api/sessions — Get session cache status ──
router.get("/api/sessions", requireAuth, (req, res) => {
  res.json({ sessions: getCacheStatus() });
});

// ── POST /api/sessions/refresh/:consultantNum — Force-refresh a session ──
router.post("/api/sessions/refresh/:consultantNum", requireAuth, async (req, res) => {
  const client = getClientByNum(req.params.consultantNum);
  if (!client) {
    return res.status(404).json({ error: "Client not found." });
  }

  try {
    // invalidateSession is now async (closes the browser)
    await invalidateSession(client.consultantNum);
    const session = await getSession(client.consultantNum, client.password, true);
    res.json({
      status: "refreshed",
      consultantNum: client.consultantNum,
      hasMkPage: !!session.mkPage,
      hasAppsPage: !!session.appsPage,
      mkUrl: session.mkUrl || "",
      appsUrl: session.appsUrl || ""
    });
  } catch (e) {
    res.status(500).json({ error: `Session refresh failed: ${e.message}` });
  }
});

// ── POST /api/config/reload — Reload configuration from disk ──
router.post("/api/config/reload", requireAuth, (req, res) => {
  try {
    const config = reloadConfig();
    res.json({
      status:  "reloaded",
      clients: config.clients.length
    });
  } catch (e) {
    res.status(500).json({ error: `Config reload failed: ${e.message}` });
  }
});

// ── GET /api/config/schedule — Get schedule configuration ──
router.get("/api/config/schedule", requireAuth, (req, res) => {
  const schedule = getServerConfig().schedule || {};
  res.json(schedule);
});

// ── GET /api/diagnostic/raw/:consultantNum — Fetch raw Mary Kay data ──
router.get("/api/diagnostic/raw/:consultantNum", requireAuth, async (req, res) => {
  const client = getClientByNum(req.params.consultantNum);
  if (!client) {
    return res.status(404).json({ error: "Client not found." });
  }

  logger.info(`[API] Diagnostic: Raw data fetch requested for ${client.clientName}`);

  try {
    const data = await fetchRawData(client);
    res.json(data);
  } catch (e) {
    logger.error(`[API] Diagnostic raw fetch failed: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/diagnostic/processed/:consultantNum — Fetch processed GHL-ready contacts ──
router.get("/api/diagnostic/processed/:consultantNum", requireAuth, async (req, res) => {
  const client = getClientByNum(req.params.consultantNum);
  if (!client) {
    return res.status(404).json({ error: "Client not found." });
  }

  logger.info(`[API] Diagnostic: Processed contacts requested for ${client.clientName}`);

  try {
    const data = await fetchProcessedContacts(client);
    res.json(data);
  } catch (e) {
    logger.error(`[API] Diagnostic processed fetch failed: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/diagnostic/validate/:consultantNum — Run full data validation ──
router.get("/api/diagnostic/validate/:consultantNum", requireAuth, async (req, res) => {
  const client = getClientByNum(req.params.consultantNum);
  if (!client) {
    return res.status(404).json({ error: "Client not found." });
  }

  logger.info(`[API] Diagnostic: Validation requested for ${client.clientName}`);

  try {
    const data = await validateAllData(client);
    res.json(data);
  } catch (e) {
    logger.error(`[API] Diagnostic validation failed: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/export/lists/:consultantNum — Export ALL raw lists as JSON ──
router.get("/api/export/lists/:consultantNum", requireAuth, async (req, res) => {
  const client = getClientByNum(req.params.consultantNum);
  if (!client) {
    return res.status(404).json({ error: "Client not found." });
  }

  logger.info(`[API] Export: Raw lists requested for ${client.clientName}`);

  try {
    const data = await exportAllLists(client);
    res.json(data);
  } catch (e) {
    logger.error(`[API] Export lists failed: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/export/ghl-contacts/:consultantNum — Export GHL-ready contacts as JSON ──
router.get("/api/export/ghl-contacts/:consultantNum", requireAuth, async (req, res) => {
  const client = getClientByNum(req.params.consultantNum);
  if (!client) {
    return res.status(404).json({ error: "Client not found." });
  }

  logger.info(`[API] Export: GHL-ready contacts requested for ${client.clientName}`);

  try {
    const data = await exportGhlReadyContacts(client);
    res.json(data);
  } catch (e) {
    logger.error(`[API] Export GHL contacts failed: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/export/ghl-csv/:consultantNum — Export GHL-ready contacts as CSV download ──
router.get("/api/export/ghl-csv/:consultantNum", requireAuth, async (req, res) => {
  const client = getClientByNum(req.params.consultantNum);
  if (!client) {
    return res.status(404).json({ error: "Client not found." });
  }

  logger.info(`[API] Export: CSV download requested for ${client.clientName}`);

  try {
    const csv = await exportGhlReadyCsv(client);
    if (csv.error) {
      return res.status(500).json({ error: csv.error });
    }
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${client.consultantNum}_ghl_contacts.csv"`);
    res.send(csv);
  } catch (e) {
    logger.error(`[API] Export CSV failed: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/logs — Server-Sent Events log stream ──
router.get("/api/logs", (req, res) => {
  // Check API key from query param for SSE
  const apiKey = req.query.apiKey;
  if (!apiKey || apiKey !== process.env.API_SECRET_KEY) {
    return res.status(401).json({ error: "Invalid or missing API key." });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const unsubscribe = logger.subscribeLogStream(res);

  req.on("close", () => {
    unsubscribe();
    logger.info("[API] Log stream subscriber disconnected.");
  });
});

// ── GET /api/schedule — Get current schedule configuration ──
router.get("/api/schedule", requireAuth, (req, res) => {
  try {
    const schedule = getServerConfig().schedule || {};
    res.json({
      cron:       schedule.cron || "30 0 * * *",
      timezone:   schedule.timezone || "America/Chicago",
      enabled:    schedule.enabled !== false,
      clients:    getClients().length
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/schedule — Update schedule configuration ──
router.post("/api/schedule", requireAuth, async (req, res) => {
  try {
    const { cron, timezone, enabled } = req.body;
    const configPath = path.resolve(process.env.CONFIG_PATH ||
      path.join(__dirname, "../../config/clients.json"));
    const raw = fs.readFileSync(configPath, "utf-8");
    const config = JSON.parse(raw);

    if (!config._serverConfig) config._serverConfig = {};
    if (!config._serverConfig.schedule) config._serverConfig.schedule = {};

    if (cron !== undefined) config._serverConfig.schedule.cron = cron;
    if (timezone !== undefined) config._serverConfig.schedule.timezone = timezone;
    if (enabled !== undefined) config._serverConfig.schedule.enabled = enabled;

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    logger.info(`[API] Schedule updated: ${config._serverConfig.schedule.cron} (${config._serverConfig.schedule.timezone}) [enabled: ${config._serverConfig.schedule.enabled}]`);

    // Reload config from disk, then restart cron with new settings
    reloadConfig();
    restartCron();

    res.json({
      status: "updated",
      schedule: config._serverConfig.schedule
    });
  } catch (e) {
    logger.error(`[API] Schedule update failed: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/progress — Server-Sent Events progress stream ──
router.get("/api/progress", (req, res) => {
  const apiKey = req.query.apiKey;
  if (!apiKey || apiKey !== process.env.API_SECRET_KEY) {
    return res.status(401).json({ error: "Invalid or missing API key." });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const unsubscribe = subscribeProgress(res);

  // Send current state immediately
  const current = getProgressStream();
  if (current) {
    try { res.write(`data: ${JSON.stringify(current)}\n\n`); } catch (_) {}
  }

  req.on("close", () => {
    unsubscribe();
  });
});

// ── POST /api/cron/enable — Enable scheduled sync ──
router.post("/api/cron/enable", requireAuth, (req, res) => {
  try {
    const configPath = path.resolve(process.env.CONFIG_PATH ||
      path.join(__dirname, "../../config/clients.json"));
    const raw = fs.readFileSync(configPath, "utf-8");
    const config = JSON.parse(raw);

    if (!config._serverConfig) config._serverConfig = {};
    if (!config._serverConfig.schedule) config._serverConfig.schedule = {};
    config._serverConfig.schedule.enabled = true;

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    startCron();

    res.json({ status: "enabled", message: "Scheduled sync enabled." });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/cron/disable — Disable scheduled sync ──
router.post("/api/cron/disable", requireAuth, (req, res) => {
  try {
    const configPath = path.resolve(process.env.CONFIG_PATH ||
      path.join(__dirname, "../../config/clients.json"));
    const raw = fs.readFileSync(configPath, "utf-8");
    const config = JSON.parse(raw);

    if (!config._serverConfig) config._serverConfig = {};
    if (!config._serverConfig.schedule) config._serverConfig.schedule = {};
    config._serverConfig.schedule.enabled = false;

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    stopCron();

    res.json({ status: "disabled", message: "Scheduled sync disabled." });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/logs/recent — Get recent log entries as JSON ──
router.get("/api/logs/recent", requireAuth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 200, 500);
  const level = req.query.level || "all";

  // Read from log file for persistence across restarts
  const logFile = require("path").join(__dirname, "../../logs",
    `sync-${new Date().toISOString().split("T")[0]}.log`);

  try {
    let content = "";
    try {
      content = require("fs").readFileSync(logFile, "utf-8");
    } catch (_) {
      return res.json({ logs: [] });
    }

    const lines = content.split("\n").filter(l => l.trim());
    const recent = lines.slice(-limit).reverse();

    const parsed = recent.map(line => {
      const match = line.match(/^\[([^\]]+)\]\s*\[(\w+)\]\s*(.*)$/);
      if (match) {
        return { timestamp: match[1], level: match[2].toLowerCase(), message: match[3] };
      }
      return { timestamp: "", level: "info", message: line };
    });

    const filtered = level === "all"
      ? parsed
      : parsed.filter(l => l.level === level);

    res.json({ logs: filtered.reverse(), count: filtered.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/schedule/next — Get next scheduled run time ──
router.get("/api/schedule/next", requireAuth, (req, res) => {
  const cron = require("node-cron");
  try {
    const schedule = getServerConfig().schedule || {};
    if (!schedule.enabled) {
      return res.json({ nextRun: null, message: "Scheduled sync is disabled." });
    }
    const cronExpr = schedule.cron || "30 0 * * *";
    const tz = schedule.timezone || "America/Chicago";

    // Calculate next run time manually
    const now = new Date();
    const [minute, hour] = cronExpr.split(" ");
    const min = parseInt(minute);
    const hr = parseInt(hour);

    // Use a simple calculation for daily schedule
    const nextRun = new Date(now);
    nextRun.setHours(hr, min, 0, 0);
    if (nextRun <= now) {
      nextRun.setDate(nextRun.getDate() + 1);
    }

    // Adjust for timezone (simplified)
    const utcNow = new Date();
    const tzOffset = getTzOffsetMinutes(tz);
    nextRun.setMinutes(nextRun.getMinutes() + tzOffset);

    res.json({
      nextRun: nextRun.toISOString(),
      cron: cronExpr,
      timezone: tz,
      enabled: true
    });
  } catch (e) {
    res.json({ nextRun: null, error: e.message });
  }
});

function getTzOffsetMinutes(tz) {
  const offsets = {
    "America/Chicago": -300,
    "America/New_York": -240,
    "America/Los_Angeles": -420,
    "America/Denver": -360,
    "America/Anchorage": -480,
    "Pacific/Honolulu": -600,
    "Europe/London": 60,
    "Europe/Paris": 120,
    "Asia/Kolkata": 330,
    "Asia/Tokyo": 540
  };
  return offsets[tz] || 0;
}

module.exports = router;
