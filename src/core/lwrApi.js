// =============================================================================
// LWR API — apps.marykayintouch.com
//
// Uses CDP Fetch interception to capture the page's OWN natural LWR API call
// (during page load/reload), then replays it with the exact same headers
// to get the Customer List data.
// =============================================================================

const logger = require("../utils/logger");

const APPS_BASE    = process.env.APPS_BASE_URL || "https://apps.marykayintouch.com";
const LWR_ENDPOINT = APPS_BASE + "/webruntime/api/apex/execute?language=en-US&asGuest=false&htmlEncode=false";

function sleep(ms ) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Navigate the appsPage to /customer-list if it's not already there.
 * Returns true if the page is on the customer-list page.
 */
async function ensureOnCustomerList(page) {
  const url = page.url();
  if (url.includes("apps.marykayintouch.com/customer-list")) {
    return true;
  }
  logger.info(`[LWR API] Page is on: ${url.substring(0, 80)} — navigating to customer-list...`);
  try {
    await page.goto(`${APPS_BASE}/customer-list`, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });
    // Wait longer on cloud servers for SSO redirect chain
    await sleep(20000);
    const afterNav = page.url();
    if (afterNav.includes("apps.marykayintouch.com/customer-list")) {
      return true;
    }
    // If on frontdoor.jsp, wait for the redirect
    if (afterNav.includes("frontdoor.jsp")) {
      logger.info(`[LWR API] On frontdoor.jsp — waiting for redirect...`);
      await sleep(20000);
      const afterFront = page.url();
      if (afterFront.includes("apps.marykayintouch.com/customer-list")) {
        return true;
      }
    }
    logger.warn(`[LWR API] After navigation, page is on: ${afterNav.substring(0, 80)}`);
    return false;
  } catch (e) {
    logger.warn(`[LWR API] Navigation error: ${e.message}`);
    return false;
  }
}

/**
 * Call the LWR API by:
 * 1. Ensuring page is on /customer-list
 * 2. Setting up CDP Fetch interception
 * 3. Reloading the page to trigger the natural getRelatedCustomers call
 * 4. Capturing the intercepted request (with all auth headers)
 * 5. Replaying it via page.evaluate()
 */
async function callAppsLwrApi(session, controllerClass, methodName, params, retries = 1) {
  const page = session.appsPage;
  const { consultantNum } = session;

  if (!page) {
    logger.error(`[LWR API] appsPage is not available for ${consultantNum}. Skipping.`);
    return null;
  }

  // ── Step 1: Ensure we're on the right page ──
  let onPage = await ensureOnCustomerList(page);
  if (!onPage) {
    logger.warn(`[LWR API] appsPage not on customer-list for ${consultantNum}. Attempting retry navigation...`);
    try {
      await page.goto(`${APPS_BASE}/customer-list`, {
        waitUntil: "domcontentloaded",
        timeout: 60000
      });
      await sleep(25000);
      onPage = page.url().includes("apps.marykayintouch.com/customer-list");
    } catch (e) {
      logger.warn(`[LWR API] Retry navigation failed: ${e.message}`);
    }
    if (!onPage) {
      logger.error(`[LWR API] Could not get appsPage to customer-list for ${consultantNum}. URL: ${page.url()}`);
      return null;
    }
  }

  const client = await page.target().createCDPSession();
  let capturedRequest = null;
  let captureAttempts = 0;
  const MAX_CAPTURE_ATTEMPTS = 4;

  try {
    while (!capturedRequest && captureAttempts < MAX_CAPTURE_ATTEMPTS) {
      captureAttempts++;
      logger.info(`[LWR API] Capture attempt ${captureAttempts}/${MAX_CAPTURE_ATTEMPTS} for ${consultantNum}`);

      // ── Step 2: Enable CDP Fetch interception ──
      try {
        await client.send("Fetch.disable").catch(() => {});
      } catch (_) {}

      capturedRequest = null;

      await client.send("Fetch.enable", {
        patterns: [{ urlPattern: "*/webruntime/api/apex/*", requestStage: "Request" }]
      });

      // Clear any previous event listeners
      client.removeAllListeners("Fetch.requestPaused");

      client.on("Fetch.requestPaused", async (event) => {
        if (event.request.postData && event.request.postData.includes("getRelatedCustomers")) {
          logger.info(`[LWR API] Intercepted getRelatedCustomers request!`);
          capturedRequest = event.request;
        }
        try {
          await client.send("Fetch.continueRequest", { requestId: event.requestId });
        } catch (_) {}
      });

      // ── Step 3: Reload the page to trigger the natural LWR API call ──
      logger.info(`[LWR API] Reloading page to trigger LWR API call...`);
      await page.reload({ waitUntil: "domcontentloaded", timeout: 45000 }).catch(e => {
        logger.warn(`[LWR API] Reload timeout (non-fatal): ${e.message}`);
      });

      // ── Step 4: Wait for the LWR framework to make its API call ──
      // On cloud servers, the LWR framework needs more time to initialize
      await sleep(15000);

      // Check if LWR framework is loaded
      const lwrReady = await page.evaluate(() => {
        try {
          return typeof window.CLWR !== "undefined" && window.CLWR !== null;
        } catch (e) {
          return false;
        }
      }).catch(() => false);

      logger.info(`[LWR API] LWR framework ready: ${lwrReady}, captured: ${!!capturedRequest}`);

      // If not captured yet, wait more
      if (!capturedRequest) {
        await sleep(15000);
      }

      // If still not captured, try navigating away and back to force a fresh load
      if (!capturedRequest && captureAttempts < MAX_CAPTURE_ATTEMPTS) {
        logger.info(`[LWR API] Not captured yet — navigating away and back to force fresh load...`);
        await page.goto(`${APPS_BASE}/`, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
        await sleep(5000);
        await page.goto(`${APPS_BASE}/customer-list`, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
        await sleep(20000);
      }
    }

    if (!capturedRequest) {
      logger.warn(`[LWR API] Could not capture natural LWR API request for ${consultantNum} after ${MAX_CAPTURE_ATTEMPTS} attempts.`);
      return null;
    }

    logger.info(`[LWR API] Captured request with ${Object.keys(capturedRequest.headers || {}).length} headers, URL: ${capturedRequest.url}`);

    // ── Step 5: Replay the captured request with the EXACT same headers ──
    const replayResult = await page.evaluate(async (requestData) => {
      const resp = await fetch(requestData.url, {
        method: requestData.method,
        credentials: "include",
        headers: requestData.headers,
        body: requestData.body
      });
      const text = await resp.text();
      return {
        statusCode: resp.status,
        bodyLength: text.length,
        text: text.substring(0, 600000)
      };
    }, {
      url: capturedRequest.url,
      method: capturedRequest.method,
      headers: capturedRequest.headers,
      body: capturedRequest.postData
    });

    const { statusCode, bodyLength, text } = replayResult;
    logger.info(`[LWR API] ${controllerClass}.${methodName} → HTTP ${statusCode} (${bodyLength} bytes)`);

    if (statusCode === 401 && retries > 0) {
      logger.warn(`[LWR API] 401 Unauthorized — retrying with fresh session...`);
      return callAppsLwrApi(session, controllerClass, methodName, params, retries - 1);
    }

    if (statusCode !== 200) {
      logger.error(`[LWR API] Unexpected status ${statusCode}. Response: ${text.substring(0, 300)}`);
      return null;
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      logger.error(`[LWR API] Failed to parse JSON response: ${e.message}`);
      return null;
    }

    if (parsed !== null && typeof parsed === "object" && "returnValue" in parsed) {
      return parsed.returnValue;
    }
    return parsed;

  } catch (e) {
    logger.error(`[LWR API] Error calling ${controllerClass}.${methodName}: ${e.message}`);
    return null;
  } finally {
    try { await client.send("Fetch.disable").catch(() => {}); } catch (_) {}
    try { client.removeAllListeners("Fetch.requestPaused"); } catch (_) {}
    try { await client.detach(); } catch (_) {}
  }
}

/**
 * Extract CSRF token from the apps page DOM (for diagnostics).
 */
async function extractCsrfFromPage(page) {
  const token = await page.evaluate(() => {
    for (const s of document.querySelectorAll("script:not([src])")) {
      const t = s.textContent;
      if (t.includes("csrfToken")) {
        const m = t.match(/"csrfToken"\s*:\s*"(eyJ[^"]+)"/);
        if (m && m[1]) return m[1];
      }
    }
    return "";
  });
  return token;
}

/**
 * Get CSRF token for the session (diagnostics only).
 */
async function getCsrfToken(session) {
  const page = session.appsPage;
  if (!page) return "";
  return extractCsrfFromPage(page);
}

module.exports = {
  callAppsLwrApi,
  extractCsrfFromPage,
  getCsrfToken
};
