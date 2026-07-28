// =============================================================================
// LWR API — apps.marykayintouch.com
//
// Uses CDP Fetch interception to capture the page's OWN natural LWR API call
// (during page load/reload), then replays it with the exact same headers
// to get the Customer List data.
//
// Single-page model: the same page navigates between mk and apps domains.
// Both share cookies via the same browser session.
// =============================================================================

const logger = require("../utils/logger");

const APPS_BASE    = process.env.APPS_BASE_URL || "https://apps.marykayintouch.com";

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Ensure the page is on the apps customer-list page.
 * If not, navigate there and wait for the page to load.
 */
async function ensureOnCustomerList(page) {
  const url = page.url();
  if (url.includes("apps.marykayintouch.com/customer-list")) {
    return true;
  }

  logger.info(`[LWR API] Page is on: ${url.substring(0, 100)} — navigating to customer-list...`);

  try {
    await page.goto(`${APPS_BASE}/customer-list`, {
      waitUntil: "domcontentloaded",
      timeout: 90000
    });
  } catch (e) {
    logger.warn(`[LWR API] Navigation timeout: ${e.message}`);
  }

  // Wait for SSO redirect chain
  await sleep(15000);

  // Wait for URL to stabilize
  for (let i = 0; i < 30; i++) {
    const u1 = page.url();
    await sleep(2000);
    const u2 = page.url();
    if (u1 === u2) break;
  }

  const finalUrl = page.url();
  if (finalUrl.includes("apps.marykayintouch.com/customer-list")) {
    return true;
  }

  logger.warn(`[LWR API] After navigation, page is on: ${finalUrl.substring(0, 100)}`);

  // If stuck on loginFlowOnly, try navigating again
  if (finalUrl.includes("loginFlowOnly") || finalUrl.includes("LoginIntouchFlow")) {
    logger.info(`[LWR API] Stuck on auth flow page — waiting 20s then retrying...`);
    await sleep(20000);
    const retryUrl = page.url();
    if (retryUrl.includes("apps.marykayintouch.com/customer-list")) {
      return true;
    }
    // Try one more navigation
    try {
      await page.goto(`${APPS_BASE}/customer-list`, {
        waitUntil: "domcontentloaded",
        timeout: 90000
      });
      await sleep(20000);
      return page.url().includes("apps.marykayintouch.com/customer-list");
    } catch (e) {
      logger.warn(`[LWR API] Retry navigation failed: ${e.message}`);
      return false;
    }
  }

  return false;
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
  const page = session.page;
  const { consultantNum } = session;

  if (!page) {
    logger.error(`[LWR API] Page is not available for ${consultantNum}. Skipping.`);
    return null;
  }

  // ── Step 1: Ensure we're on the right page ──
  let onPage = await ensureOnCustomerList(page);
  if (!onPage) {
    logger.error(`[LWR API] Could not get page to customer-list for ${consultantNum}. URL: ${page.url().substring(0, 100)}`);
    return null;
  }

  const client = await page.target().createCDPSession();
  let capturedRequest = null;
  const MAX_CAPTURE_ATTEMPTS = 4;

  try {
    for (let attempt = 1; attempt <= MAX_CAPTURE_ATTEMPTS; attempt++) {
      logger.info(`[LWR API] Capture attempt ${attempt}/${MAX_CAPTURE_ATTEMPTS} for ${consultantNum}`);

      // ── Step 2: Enable CDP Fetch interception ──
      try {
        await client.send("Fetch.disable").catch(() => {});
      } catch (_) {}

      capturedRequest = null;

      await client.send("Fetch.enable", {
        patterns: [{ urlPattern: "*/webruntime/api/apex/*", requestStage: "Request" }]
      });

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
      await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 }).catch(e => {
        logger.warn(`[LWR API] Reload timeout (non-fatal): ${e.message}`);
      });

      // ── Step 4: Wait for the LWR framework to make its API call ──
      await sleep(12000);

      // Check if LWR framework is loaded
      const lwrReady = await page.evaluate(() => {
        try {
          return typeof window.CLWR !== "undefined" && window.CLWR !== null;
        } catch (e) {
          return false;
        }
      }).catch(() => false);

      logger.info(`[LWR API] LWR framework ready: ${lwrReady}, captured: ${!!capturedRequest}`);

      if (capturedRequest) break;

      // Wait more
      await sleep(8000);
      if (capturedRequest) break;

      // If not captured, navigate away and back
      if (attempt < MAX_CAPTURE_ATTEMPTS) {
        logger.info(`[LWR API] Not captured — navigating away and back...`);
        await page.goto(`${APPS_BASE}/`, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
        await sleep(5000);
        await page.goto(`${APPS_BASE}/customer-list`, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
        await sleep(15000);
      }
    }

    if (!capturedRequest) {
      logger.error(`[LWR API] Could not capture natural LWR API request for ${consultantNum} after ${MAX_CAPTURE_ATTEMPTS} attempts.`);
      return null;
    }

    logger.info(`[LWR API] Captured request with ${Object.keys(capturedRequest.headers || {}).length} headers`);

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
        text: text.substring(0, 2000000)
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
      logger.warn(`[LWR API] 401 Unauthorized — retrying...`);
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

async function getCsrfToken(session) {
  const page = session.page;
  if (!page) return "";
  return extractCsrfFromPage(page);
}

module.exports = {
  callAppsLwrApi,
  extractCsrfFromPage,
  getCsrfToken
};
