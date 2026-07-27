// =============================================================================
// CONFIGURATION LOADER
// Loads and validates the multi-client configuration from clients.json
// =============================================================================

const fs = require("fs");
const path = require("path");

let config = null;
let configPath = null;

/**
 * Load the clients configuration from the JSON file.
 * Can be called at startup or on-demand for hot-reload.
 */
function loadConfig() {
  const configPathEnv = process.env.CONFIG_PATH || path.join(__dirname, "../../config/clients.json");
  const absolutePath = path.resolve(configPathEnv);

  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Configuration file not found: ${absolutePath}`);
  }

  const raw = fs.readFileSync(absolutePath, "utf-8");
  const parsed = JSON.parse(raw);

  if (!parsed.clients || !Array.isArray(parsed.clients) || parsed.clients.length === 0) {
    throw new Error("Configuration must contain a non-empty 'clients' array.");
  }

  // Validate each client entry
  const requiredFields = [
    "consultantNum", "password", "clientName",
    "ghlApiToken", "ghlLocationId", "ghlCustomFields"
  ];

  for (const client of parsed.clients) {
    for (const field of requiredFields) {
      if (!client[field]) {
        throw new Error(`Client "${client.clientName || "unknown"}" is missing required field: ${field}`);
      }
    }
    if (typeof client.ghlCustomFields !== "object") {
      throw new Error(`Client "${client.clientName}" ghlCustomFields must be an object.`);
    }
  }

  config = {
    clients: parsed.clients,
    server: parsed._serverConfig || {},
    rawPath: absolutePath
  };

  configPath = absolutePath;
  console.log(`[Config] Loaded ${config.clients.length} client(s): ${config.clients.map(c => c.clientName).join(", ")}`);

  return config;
}

/**
 * Reload configuration from disk (useful for admin endpoint).
 */
function reloadConfig() {
  console.log("[Config] Reloading configuration...");
  return loadConfig();
}

/**
 * Get all configured clients.
 */
function getClients() {
  if (!config) loadConfig();
  return config.clients;
}

/**
 * Get a single client by consultant number.
 */
function getClientByNum(consultantNum) {
  if (!config) loadConfig();
  return config.clients.find(c =>
    c.consultantNum.toUpperCase() === consultantNum.toUpperCase()
  );
}

/**
 * Get server configuration.
 */
function getServerConfig() {
  if (!config) loadConfig();
  return config.server;
}

/**
 * Get the config file path.
 */
function getConfigPath() {
  return configPath || path.resolve(process.env.CONFIG_PATH || path.join(__dirname, "../../config/clients.json"));
}

module.exports = {
  loadConfig,
  reloadConfig,
  getClients,
  getClientByNum,
  getServerConfig,
  getConfigPath
};
