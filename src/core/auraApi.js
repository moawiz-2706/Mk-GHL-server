// =============================================================================
// AURA API — mk.marykayintouch.com
//
// Uses page.evaluate() on the mkPage tab to make fetch() calls.
// The mkPage tab stays on mk.marykayintouch.com — no domain bouncing.
//
// This exactly replicates the Apps Script's UrlFetchApp.fetch() call:
//   POST to /s/sfsites/aura?r=1
//   Content-Type: application/x-www-form-urlencoded
//   Body: message=...&aura.context=...&aura.pageURI=...&aura.token=...
//
// The browser automatically sends cookies for the mk domain.
// =============================================================================

const logger = require("../utils/logger");

const INTOUCH_BASE = process.env.MK_BASE_URL || "https://mk.marykayintouch.com";
const INTOUCH_AURA = INTOUCH_BASE + "/s/sfsites/aura?r=1";

// Cached Aura metadata — keyed by consultantNum
const metadataCache = {};

const FALLBACK_FWUID       = "cmpKNldRZXRSMkdjemxQdjBkbl9uQWtVMjdnTGFERUU2S3FfSVdrcU92bkExNC4xOTIuODM4ODYwOA";
const FALLBACK_APP_VERSION = "1652_0AZaOQosL4m3Y8qAPe3Wrw";

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Extract fwuid and appVersion from the mk page's DOM.
 * The mkPage tab should always be on mk.marykayintouch.com.
 */
async function extractMetadataFromMkPage(page) {
  return page.evaluate(() => {
    let fwuid = "";
    let appVersion = "";

    // 1. Extract fwuid from script tags
    const scripts = document.querySelectorAll("script[src]");
    for (const s of scripts) {
      const src = s.src || "";
      if (src.includes("/auraFW/javascript/")) {
        const fwMatch = src.match(/\/auraFW\/javascript\/([^\/]+)\//);
        if (fwMatch) fwuid = fwMatch[1];
      }
    }

    // 2. Extract appVersion from inline script tags
    const inlineScripts = document.querySelectorAll("script:not([src])");
    for (const s of inlineScripts) {
      const t = s.textContent || "";
      if (t.includes("communityApp")) {
        const m = t.match(/siteforce:communityApp['":]\s*['"]?([^'"\\,\s\}]+)/);
        if (m) appVersion = m[1];
        if (appVersion) break;
      }
    }

    // 3. Also try from $A.clientService.getContext() if available
    if (!fwuid || !appVersion) {
      try {
        if (typeof $A !== "undefined" && $A.clientService) {
          const ctx = $A.clientService.getContext();
          if (ctx) {
            if (!fwuid && ctx.fwuid) fwuid = ctx.fwuid;
            if (!appVersion && ctx.loaded) {
              for (const [key, val] of Object.entries(ctx.loaded)) {
                if (key.includes("communityApp") && val) appVersion = val;
              }
            }
          }
        }
      } catch (e) {}
    }

    return { fwuid, appVersion };
  });
}

/**
 * Fetch Aura metadata — use pre-extracted values from login, or extract from page.
 */
async function fetchAuraMetadata(session, consultantNum) {
  const key = consultantNum.toUpperCase();

  // If session has pre-extracted values from login, use them
  if (session.auraFwuid && session.auraAppVersion) {
    const result = {
      fwuid:      session.auraFwuid,
      appVersion: session.auraAppVersion,
      fetchedAt:  Date.now(),
      source:     "login-extracted"
    };
    metadataCache[key] = result;
    return result;
  }

  // Check cache
  if (metadataCache[key] && (Date.now() - metadataCache[key].fetchedAt < 30 * 60 * 1000)) {
    logger.info(`[Aura] Using cached metadata for ${key} (age: ${Math.round((Date.now() - metadataCache[key].fetchedAt) / 60000)} min)`);
    return metadataCache[key];
  }

  // Extract from mk page
  const page = session.mkPage || session.page;
  if (page) {
    try {
      const meta = await extractMetadataFromMkPage(page);

      if (meta.fwuid && meta.appVersion) {
        const result = {
          fwuid: meta.fwuid,
          appVersion: meta.appVersion,
          fetchedAt: Date.now(),
          source: "page-extracted"
        };
        metadataCache[key] = result;
        logger.info(`[Aura] Extracted metadata for ${key}: fwuid=${meta.fwuid.substring(0,20)}..., appVersion=${meta.appVersion}`);
        return result;
      }

      logger.warn(`[Aura] Partial metadata from page: fwuid=${!!meta.fwuid}, appVersion=${!!meta.appVersion}`);
      if (meta.fwuid) {
        const partial = {
          fwuid: meta.fwuid,
          appVersion: FALLBACK_APP_VERSION,
          fetchedAt: Date.now(),
          source: "partial"
        };
        metadataCache[key] = partial;
        return partial;
      }
    } catch (e) {
      logger.warn(`[Aura] Failed to extract metadata from page: ${e.message}`);
    }
  }

  // Fallback
  const result = {
    fwuid: FALLBACK_FWUID,
    appVersion: FALLBACK_APP_VERSION,
    fetchedAt: Date.now(),
    source: "fallback"
  };
  metadataCache[key] = result;
  logger.warn(`[Aura] Using fallback metadata for ${key}`);
  return result;
}

function resetAuraMetadata(consultantNum) {
  if (consultantNum) {
    delete metadataCache[consultantNum.toUpperCase()];
    logger.info(`[Aura] Cleared metadata cache for ${consultantNum}`);
  } else {
    Object.keys(metadataCache).forEach(k => delete metadataCache[k]);
    logger.info(`[Aura] Cleared all metadata caches.`);
  }
}

/**
 * Make an Aura API call using page.evaluate() — runs INSIDE the authenticated browser.
 *
 * Uses the mkPage tab which stays on mk.marykayintouch.com.
 * The auraToken is passed in the body as aura.token.
 *
 * EXACTLY matches the Apps Script callAuraApi_ function.
 */
async function callAuraApi(session, controllerClass, methodName, params, pageUri, retries = 1) {
  const page = session.mkPage || session.page;
  const { consultantNum } = session;

  // Get metadata (fwuid + appVersion)
  const meta = await fetchAuraMetadata(session, consultantNum);

  // Get the aura token from the session (extracted during login)
  const auraToken = session.auraToken || session.mkAuraToken || "";

  // Build the aura context — matches the Apps Script exactly
  const auraContext = {
    mode:    "PROD",
    fwuid:   meta.fwuid,
    app:     "siteforce:communityApp",
    loaded:  { "APPLICATION@markup://siteforce:communityApp": meta.appVersion },
    dn:      [],
    globals: {},
    uad:     true
  };

  // Build the message — matches the Apps Script exactly
  const message = {
    actions: [{
      id:                "1;a",
      descriptor:        `apex://${controllerClass}/ACTION$${methodName}`,
      callingDescriptor: "UNKNOWN",
      params:            params
    }]
  };

  // Build the form-encoded body — matches the Apps Script exactly
  const body = "message="       + encodeURIComponent(JSON.stringify(message))
             + "&aura.context=" + encodeURIComponent(JSON.stringify(auraContext))
             + "&aura.pageURI=" + encodeURIComponent(pageUri || "/s/")
             + "&aura.token="   + encodeURIComponent(auraToken);

  try {
    // Execute the Aura API call INSIDE the browser context
    // The mkPage tab is on mk.marykayintouch.com, so fetch() is same-origin.
    // Cookies are sent automatically by the browser.
    const result = await page.evaluate(async (context) => {
      const resp = await fetch(context.auraEndpoint, {
        method:      "POST",
        credentials: "include",
        headers:     {
          "Content-Type":     "application/x-www-form-urlencoded",
          "Accept":           "*/*",
          "X-Requested-With": "XMLHttpRequest"
        },
        body: context.body
      });

      const text = await resp.text();
      const statusCode = resp.status;

      return { statusCode, bodyLength: text.length, text };

    }, {
      auraEndpoint: INTOUCH_AURA,
      body: body
    });

    const { statusCode, bodyLength, text } = result;

    logger.info(`[Aura] ${controllerClass}.${methodName} → HTTP ${statusCode} (${bodyLength} bytes)`);

    // Check for session errors
    if (text.includes("aura:invalidSession")) {
      throw new Error(`Aura session expired for ${consultantNum}`);
    }

    // Check for client out of sync
    if (text.includes("aura:clientOutOfSync")) {
      logger.warn(`[Aura] clientOutOfSync for ${controllerClass}.${methodName} — clearing cache and retrying...`);
      resetAuraMetadata(consultantNum);

      if (retries > 0) {
        await sleep(1000);
        return callAuraApi(session, controllerClass, methodName, params, pageUri, retries - 1);
      }

      logger.error(`[Aura] clientOutOfSync after retry for ${controllerClass}.${methodName}`);
      return null;
    }

    // Parse the JSON response — handle the */prefix that Aura sometimes adds
    // Use the full response text (no truncation for parsing)
    let cleanText = text;
    if (cleanText.indexOf("*/") === 0) cleanText = cleanText.substring(2);
    // Remove trailing ERROR marker if present
    if (cleanText.endsWith("/*ERROR*/")) {
      cleanText = cleanText.replace(/\/*ERROR\*\/$/, "").trim();
    }

    let parsed;
    try {
      parsed = JSON.parse(cleanText);
    } catch (e) {
      logger.error(`[Aura] Failed to parse response from ${controllerClass}.${methodName}`);
      logger.warn(`[Aura] Response preview: ${cleanText.substring(0, 200)}`);
      return null;
    }

    // Validate response structure
    if (!parsed.actions || parsed.actions.length === 0) {
      logger.warn(`[Aura] No actions in response from ${controllerClass}.${methodName}`);
      return null;
    }

    const action = parsed.actions[0];
    if (action.state !== "SUCCESS") {
      logger.warn(`[Aura] Action state: ${action.state} for ${controllerClass}.${methodName}`);
      if (action.error) {
        logger.warn(`[Aura] Error details: ${JSON.stringify(action.error).substring(0, 200)}`);
      }
      return null;
    }

    return action.returnValue;

  } catch (e) {
    if (e.message.includes("Aura session expired")) {
      throw e;
    }
    logger.error(`[Aura] Error calling ${controllerClass}.${methodName}: ${e.message}`);
    return null;
  }
}

module.exports = {
  callAuraApi,
  resetAuraMetadata,
  fetchAuraMetadata,
  extractMetadataFromMkPage
};
