// =============================================================================
// ORCHESTRATOR
// Coordinates the complete sync workflow across all configured clients.
// Manages state tracking, error aggregation, and progress reporting.
// =============================================================================

const { processClient } = require("../processors/dataProcessor");
const { syncToGhl } = require("../sync/ghlSync");
const { invalidateSession } = require("../sessions/sessionManager");
const { startExecution, updatePhase, updateGhlProgress, completeClient, failClient, completeExecution } = require("./progress.js");
const logger = require("../utils/logger");

// ── Execution State ──
let currentExecution = null;
let isRunning = false;

/**
 * Get the current execution state.
 */
function getExecutionState() {
  if (!currentExecution) return null;
  return {
    status:     isRunning ? "running" : "completed",
    startTime:  currentExecution.startTime,
    clients:    currentExecution.clients.map(c => ({
      name:        c.name,
      status:      c.status,
      stats:       c.stats,
      ghlResult:   c.ghlResult
    }))
  };
}

/**
 * Run the full sync for all configured clients.
 * This is the main entry point for both cron and API-triggered execution.
 *
 * @param {object[]} clients - Array of client config objects
 * @returns {Promise<object>} Final execution summary
 */
async function runFullSync(clients) {
  if (isRunning) {
    logger.warn(`[Orchestrator] Sync already in progress. Ignoring new trigger.`);
    return { status: "already_running" };
  }

  isRunning = true;
  const execStartTime = new Date();

  currentExecution = {
    startTime: execStartTime.toISOString(),
    clients: []
  };

  // Notify frontend that sync has started
  startExecution(clients.length);

  logger.info(`\n═══════════════════════════════════════════════════════`);
  logger.info(`[Orchestrator] Full sync started at ${execStartTime.toISOString()}`);
  logger.info(`[Orchestrator] Processing ${clients.length} client(s)`);
  logger.info(`═══════════════════════════════════════════════════════\n`);

  const results = [];

  for (const client of clients) {
    const clientEntry = {
      name:   client.clientName,
      status: "in_progress",
      stats:  null,
      ghlResult: null
    };

    try {
      // Phase 1: Data Fetch
      updatePhase(client.clientName, "fetching_data", { message: "Fetching Mary Kay data..." });
      logger.info(`\n>>> Phase 1: Data Fetch — ${client.clientName}`);

      const { contacts, stats } = await processClient(client);
      clientEntry.stats = stats;

      // Update progress with data fetch results
      updatePhase(client.clientName, "data_fetched", {
        consultants: stats.consultants,
        customers: stats.customers,
        salesVolume: stats.salesVolume,
        starConsultants: stats.starConsultants,
        totalContacts: contacts.length,
        message: `${contacts.length} contacts ready for GHL sync`
      });

      if (contacts.length === 0) {
        logger.warn(`>>> No contacts to sync for ${client.clientName}. Skipping GHL sync.`);
        clientEntry.status = "no_contacts";
        failClient(client.clientName, "No contacts to sync");
        continue;
      }

      // Phase 2: Sync to GHL
      logger.info(`\n>>> Phase 2: GHL Sync — ${client.clientName}`);
      updatePhase(client.clientName, "ghl_sync", { message: "Syncing contacts to GoHighLevel..." });

      const ghlResult = await syncToGhl(
        {
          apiToken:    client.ghlApiToken,
          locationId:  client.ghlLocationId,
          customFields: client.ghlCustomFields
        },
        contacts,
        client.clientName,
        { onProgress: (progress) => {
          updateGhlProgress(
            client.clientName,
            progress.cursor,
            progress.total,
            progress.synced,
            progress.skipped,
            progress.chunkErrors
          );
        }}
      );

      clientEntry.ghlResult = ghlResult;
      clientEntry.status = "completed";

      // Update stats
      stats.ghlSynced = ghlResult.synced;
      stats.ghlErrors = ghlResult.errors.length;

      completeClient(client.clientName, stats, ghlResult);

      logger.info(`\n>>> ${client.clientName} COMPLETE:`);
      logger.info(`    Contacts: ${contacts.length}`);
      logger.info(`    GHL Synced: ${ghlResult.synced}`);
      logger.info(`    GHL Errors: ${ghlResult.errors.length}`);

    } catch (e) {
      clientEntry.status = "failed";
      clientEntry.error = e.message;
      failClient(client.clientName, e.message);
      logger.error(`>>> ${client.clientName} FAILED: ${e.message}`);
    }

    currentExecution.clients.push(clientEntry);
    results.push(clientEntry);
  }

  const execEndTime = new Date();
  const durationMs = execEndTime - execStartTime;
  const durationMin = Math.round(durationMs / 60000 * 10) / 10;

  logger.info(`\n═══════════════════════════════════════════════════════`);
  logger.info(`[Orchestrator] Full sync completed at ${execEndTime.toISOString()}`);
  logger.info(`[Orchestrator] Duration: ${durationMin} minutes`);

  // Summary
  const successCount = results.filter(r => r.status === "completed").length;
  const failCount    = results.filter(r => r.status === "failed").length;
  logger.info(`[Orchestrator] Results: ${successCount} succeeded, ${failCount} failed`);
  logger.info(`═══════════════════════════════════════════════════════\n`);

  isRunning = false;

  const summary = {
    status:    "completed",
    startTime: execStartTime.toISOString(),
    endTime:   execEndTime.toISOString(),
    durationMs,
    durationMin,
    results
  };

  currentExecution = { ...currentExecution, ...summary };
  completeExecution(summary);

  return summary;
}

/**
 * Run sync for a single client.
 */
async function runSingleClientSync(client) {
  return runFullSync([client]);
}

module.exports = {
  runFullSync,
  runSingleClientSync,
  getExecutionState,
  isRunning: () => isRunning
};
