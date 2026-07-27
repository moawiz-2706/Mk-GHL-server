// =============================================================================
// PROGRESS BROADCAST
// Real-time sync progress tracking and Server-Sent Events broadcasting.
// =============================================================================

const logger = require("../utils/logger");

// Current progress state
let progressState = null;
let progressSubscribers = [];

/**
 * Get the current progress state (for immediate SSE response).
 */
function getProgressStream() {
  return progressState;
}

/**
 * Subscribe to progress updates via SSE.
 * Returns an unsubscribe function.
 */
function subscribeProgress(res) {
  progressSubscribers.push(res);
  return () => {
    progressSubscribers = progressSubscribers.filter(s => s !== res);
  };
}

/**
 * Broadcast a progress update to all SSE subscribers.
 */
function broadcastProgress(data) {
  progressState = data;
  for (const sub of progressSubscribers) {
    try {
      sub.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch (_) {}
  }
}

/**
 * Update progress state with phase information.
 */
function updatePhase(clientName, phase, details) {
  if (!progressState || progressState.currentClient !== clientName) {
    progressState = {
      currentClient: clientName,
      startTime: progressState?.startTime || new Date().toISOString(),
      clients: [],
      totalClients: 0
    };
  }

  // Find or create client entry
  let clientEntry = progressState.clients.find(c => c.name === clientName);
  if (!clientEntry) {
    clientEntry = { name: clientName, phase: "idle", progress: {} };
    progressState.clients.push(clientEntry);
  }

  clientEntry.phase = phase;
  clientEntry.progress = { ...clientEntry.progress, ...details };

  broadcastProgress(progressState);
}

/**
 * Update GHL sync progress for a specific client.
 */
function updateGhlProgress(clientName, cursor, total, synced, skipped, errors) {
  const clientEntry = progressState?.clients.find(c => c.name === clientName);
  if (clientEntry) {
    clientEntry.phase = "ghl_sync";
    clientEntry.progress = {
      ...clientEntry.progress,
      cursor,
      total,
      synced,
      skipped,
      errors,
      percentage: total > 0 ? Math.round((cursor / total) * 100) : 0
    };

    broadcastProgress(progressState);
  }
}

/**
 * Mark a client as completed.
 */
function completeClient(clientName, stats, ghlResult) {
  const clientEntry = progressState?.clients.find(c => c.name === clientName);
  if (clientEntry) {
    clientEntry.phase = "completed";
    clientEntry.progress = {
      ...clientEntry.progress,
      stats,
      ghlResult
    };
    broadcastProgress(progressState);
  }
}

/**
 * Mark a client as failed.
 */
function failClient(clientName, error) {
  const clientEntry = progressState?.clients.find(c => c.name === clientName);
  if (clientEntry) {
    clientEntry.phase = "failed";
    clientEntry.error = error;
    broadcastProgress(progressState);
  }
}

/**
 * Start a new sync execution.
 */
function startExecution(totalClients) {
  progressState = {
    currentClient: null,
    startTime: new Date().toISOString(),
    clients: [],
    totalClients,
    status: "running"
  };
  broadcastProgress(progressState);
}

/**
 * Mark the entire execution as completed.
 */
function completeExecution(summary) {
  if (progressState) {
    progressState.status = "completed";
    progressState.endTime = new Date().toISOString();
    progressState.summary = summary;
    broadcastProgress(progressState);
  }
}

// Export for use in orchestrator
module.exports = {
  getProgressStream,
  subscribeProgress,
  updatePhase,
  updateGhlProgress,
  completeClient,
  failClient,
  startExecution,
  completeExecution
};
