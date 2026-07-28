// =============================================================================
// SESSION MANAGER — Puppeteer-Direct Architecture (Single-Page Model)
//
// Uses a SINGLE browser tab that navigates between mk and apps domains.
// Both domains share the same browser cookies, so authentication persists.
// The page stays on mk domain for Aura calls, navigates to apps for LWR calls.
//
// This avoids the SSO redirect chain issues that occur when creating a new tab
// for the apps domain (the new tab must re-do SAML authentication).
// =============================================================================

"use strict";

const puppeteer = require("puppeteer");
const logger = require("../utils/logger");

const INTOUCH_BASE = process.env.MK_BASE_URL || "https://mk.marykayintouch.com";
const APPS_BASE    = process.env.APPS_BASE_URL || "https://apps.marykayintouch.com";
const LOGIN_URL    = `${INTOUCH_BASE}/s/login/?language=en_US`;

const SESSION_TTL_MS = (parseInt(process.env.SESSION_TTL_HOURS) || 23) * 60 * 60 * 1000;
const LOGIN_MAX_RETRIES = 3;
const LOGIN_RETRY_DELAY_MS = 5000;

// In-memory session cache
const sessionCache = {};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isCacheValid(consultantNum) {
  const entry = sessionCache[consultantNum];
  if (!entry || !entry.valid) return false;
  return (Date.now() - entry.fetchedAt) < SESSION_TTL_MS;
}

// =============================================================================
// PUPPETEER LOGIN — Single-page model
// =============================================================================

async function loginAndGetSession(consultantNum, password) {
  logger.info(`[Login] Starting Puppeteer login for: ${consultantNum}`);

  const launchOptions = {
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-zygote",
      "--single-process"
    ]
  };

  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    logger.info(`[Login] Using Chromium at: ${process.env.PUPPETEER_EXECUTABLE_PATH}`);
  }

  const browser = await puppeteer.launch(launchOptions);
  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
  );

  try {
    // ── STEP 1: Navigate to login page ──
    logger.info(`[Login] Navigating to login page...`);
    await page.goto(LOGIN_URL, {
      waitUntil: "networkidle2",
      timeout: 90000
    });

    // ── STEP 2: Fill credentials ──
    logger.info(`[Login] Filling credentials...`);
    await page.waitForSelector('input[type="text"]',     { timeout: 30000 });
    await page.waitForSelector('input[type="password"]', { timeout: 30000 });
    await page.type('input[type="text"]',     consultantNum, { delay: 60 });
    await page.type('input[type="password"]', password,      { delay: 60 });

    // ── STEP 3: Submit login ──
    logger.info(`[Login] Submitting login form...`);
    try {
      await Promise.all([
        page.waitForNavigation({ waitUntil: "networkidle2", timeout: 60000 }),
        page.keyboard.press("Enter")
      ]);
    } catch (e) {
      logger.warn(`[Login] Navigation timeout (ignored): ${e.message}`);
      await sleep(3000);
    }

    await sleep(3000);

    const postLoginUrl = page.url();
    logger.info(`[Login] Post-login URL: ${postLoginUrl}`);

    if (postLoginUrl.includes("/login")) {
      throw new Error("Login failed — still on login page. Check credentials.");
    }

    // ── STEP 4: Wait for Aura framework ──
    logger.info(`[Login] Waiting for Aura framework...`);
    try {
      await page.waitForFunction(
        () => typeof $A !== "undefined" && $A.clientService,
        { timeout: 20000 }
      );
      logger.info(`[Login] Aura framework ready.`);
    } catch (e) {
      logger.warn(`[Login] Aura framework not ready — continuing anyway.`);
    }

    // ── STEP 5: Extract Aura metadata and token ──
    logger.info(`[Login] Extracting Aura metadata from mk page...`);

    const auraData = await page.evaluate(() => {
      const result = {
        fwuid: "",
        appVersion: "",
        auraToken: ""
      };

      // Extract fwuid from script tags
      const scripts = document.querySelectorAll("script[src]");
      for (const s of scripts) {
        const src = s.src || "";
        if (src.includes("/auraFW/javascript/")) {
          const m = src.match(/\/auraFW\/javascript\/([^\/]+)\//);
          if (m) result.fwuid = m[1];
        }
      }

      // Extract appVersion from inline scripts
      const inlineScripts = document.querySelectorAll("script:not([src])");
      for (const s of inlineScripts) {
        const t = s.textContent || "";
        if (t.includes("communityApp")) {
          const m = t.match(/siteforce:communityApp['":]\s*['"]?([^'"\\,\s\}]+)/);
          if (m) result.appVersion = m[1];
          if (result.appVersion) break;
        }
      }

      // Extract aura token
      try {
        if (typeof $A !== "undefined" && $A.clientService) {
          result.auraToken = $A.clientService.Cc || "";
          if (!result.auraToken && $A.clientService.token) {
            result.auraToken = $A.clientService.token;
          }
        }
      } catch (e) {
        // Non-fatal
      }

      return result;
    });

    logger.info(`[Login] auraToken length: ${auraData.auraToken.length}`);
    logger.info(`[Login] fwuid: ${auraData.fwuid ? auraData.fwuid.substring(0, 20) + "..." : "MISSING"}`);
    logger.info(`[Login] appVersion: ${auraData.appVersion || "MISSING"}`);

    // ── STEP 6: Navigate to apps domain (SSO happens naturally with same cookies) ──
    logger.info(`[Login] Navigating to apps domain for Customer List...`);
    let appsSessionValid = false;

    try {
      await page.goto(`${APPS_BASE}/customer-list`, {
        waitUntil: "domcontentloaded",
        timeout: 90000
      });
    } catch (e) {
      logger.warn(`[Login] Apps navigation timeout (non-fatal): ${e.message}`);
    }

    // Wait for SSO redirect chain to complete
    await sleep(15000);

    // Wait until URL stabilizes
    let urlStable = false;
    for (let stabWait = 0; stabWait < 60000; stabWait += 2000) {
      const url1 = page.url();
      await sleep(2000);
      const url2 = page.url();
      if (url1 === url2) {
        urlStable = true;
        break;
      }
    }

    const appsUrl = page.url();
    logger.info(`[Login] Apps URL after wait: ${appsUrl.substring(0, 120)}`);

    if (appsUrl.includes("apps.marykayintouch.com/customer-list")) {
      appsSessionValid = true;
      logger.info(`[Login] Apps page ready at: ${appsUrl.substring(0, 80)}`);
    } else if (appsUrl.includes("apps.marykayintouch.com")) {
      // We're on apps domain but not on customer-list — might be a redirect page
      logger.info(`[Login] On apps domain but not customer-list: ${appsUrl.substring(0, 100)}`);
      // Try navigating to customer-list directly
      try {
        await page.goto(`${APPS_BASE}/customer-list`, {
          waitUntil: "domcontentloaded",
          timeout: 60000
        });
        await sleep(15000);
        const finalUrl = page.url();
        if (finalUrl.includes("apps.marykayintouch.com/customer-list")) {
          appsSessionValid = true;
          logger.info(`[Login] Apps page reached on second try: ${finalUrl.substring(0, 80)}`);
        }
      } catch (e) {
        logger.warn(`[Login] Second navigation attempt failed: ${e.message}`);
      }
    } else {
      // Still on mk domain (SSO redirect back to mk)
      logger.warn(`[Login] SSO redirected back to mk domain: ${appsUrl.substring(0, 100)}`);
      // Try one more time with longer wait
      await sleep(10000);
      try {
        await page.goto(`${APPS_BASE}/customer-list`, {
          waitUntil: "domcontentloaded",
          timeout: 90000
        });
        await sleep(20000);
        const retryUrl = page.url();
        if (retryUrl.includes("apps.marykayintouch.com/customer-list")) {
          appsSessionValid = true;
          logger.info(`[Login] Apps page reached on third try: ${retryUrl.substring(0, 80)}`);
        }
      } catch (e) {
        logger.warn(`[Login] Third navigation attempt failed: ${e.message}`);
      }
    }

    if (!appsSessionValid) {
      logger.warn(`[Login] Warning: Apps page may not have loaded correctly.`);
    }

    // ── STEP 7: Wait for LWR framework to load ──
    if (appsSessionValid) {
      logger.info(`[Login] Waiting for LWR framework to initialize...`);
      try {
        await page.waitForFunction(
          () => {
            try {
              return typeof window.CLWR !== "undefined" &&
                     window.CLWR.serverData !== undefined &&
                     window.CLWR.serverData !== null;
            } catch (e) {
              return false;
            }
          },
          { timeout: 30000 }
        );
        logger.info(`[Login] LWR framework initialized.`);
      } catch (e) {
        logger.warn(`[Login] LWR framework not fully initialized — continuing anyway.`);
      }
    }

    // ── STEP 8: Extract CSRF token from apps page ──
    let appsCsrfToken = "";
    if (appsSessionValid) {
      try {
        appsCsrfToken = await page.evaluate(() => {
          for (const s of document.querySelectorAll("script:not([src])")) {
            const t = s.textContent;
            if (!t.includes("csrfToken")) continue;
            const m = t.match(/"csrfToken"\s*:\s*"(eyJ[^"]+)"/);
            if (m && m[1]) return m[1];
          }
          try {
            if (window.CLWR && window.CLWR.serverData && window.CLWR.serverData.csrfToken)
              return window.CLWR.serverData.csrfToken;
          } catch (e) {}
          return "";
        });
      } catch (e) {}
      logger.info(`[Login] CSRF from DOM: ${appsCsrfToken ? appsCsrfToken.substring(0, 30) + "..." : "MISSING"}`);
    }

    // ── Return session ──
    logger.info(`[Login] ═══ Login successful ═══`);

    return {
      consultantNum:    consultantNum,
      page:             page,       // Single page used for both mk and apps domains
      browser:          browser,
      mkUrl:            postLoginUrl,
      appsUrl:          page.url(),
      auraToken:        auraData.auraToken,
      auraFwuid:        auraData.fwuid,
      auraAppVersion:   auraData.appVersion,
      appsCsrfToken:    appsCsrfToken,
      appsSessionValid: appsSessionValid,
      fetchedAt:        new Date().toISOString()
    };

  } catch (err) {
    await browser.close();
    throw err;
  }
}

// =============================================================================
// PUBLIC API
// =============================================================================

async function getSession(consultantNum, password, forceRefresh = false) {
  const key = consultantNum.toUpperCase();

  if (!forceRefresh && isCacheValid(key)) {
    const entry = sessionCache[key];
    logger.info(`[Session] Using cached session for ${key} (age: ${Math.round((Date.now() - entry.fetchedAt) / 60000)} min)`);

    // Verify page is still alive
    try {
      await entry.page.title();
      return { ...entry.session, fromCache: true };
    } catch (e) {
      logger.warn(`[Session] Cached page appears to be closed. Refreshing...`);
      entry.valid = false;
    }
  }

  logger.info(`[Session] Cache miss — logging in for ${key}...`);

  for (let retry = 1; retry <= LOGIN_MAX_RETRIES; retry++) {
    try {
      const session = await loginAndGetSession(key, password);
      sessionCache[key] = {
        session,
        page:    session.page,
        browser: session.browser,
        fetchedAt: Date.now(),
        valid: true
      };
      logger.info(`[Session] Successfully obtained fresh session for ${key}`);
      return { ...session, fromCache: false };
    } catch (err) {
      logger.error(`[Session] Login attempt ${retry}/${LOGIN_MAX_RETRIES} failed for ${key}: ${err.message}`);
      if (retry < LOGIN_MAX_RETRIES) {
        logger.info(`[Session] Retrying in ${LOGIN_RETRY_DELAY_MS / 1000}s...`);
        await sleep(LOGIN_RETRY_DELAY_MS);
      }
    }
  }

  throw new Error(`Login failed for ${key} after ${LOGIN_MAX_RETRIES} attempts.`);
}

async function invalidateSession(consultantNum) {
  const key = consultantNum.toUpperCase();
  logger.info(`[Session] Invalidating session for ${key}`);

  const entry = sessionCache[key];
  if (entry) {
    if (entry.browser) {
      try {
        await entry.browser.close();
        logger.info(`[Session] Browser closed for ${key}`);
      } catch (e) {
        logger.warn(`[Session] Browser close error for ${key}: ${e.message}`);
      }
    }
    entry.valid = false;
    delete sessionCache[key];
  }
}

async function closeAllSessions() {
  logger.info(`[Session] Closing all sessions...`);
  for (const key of Object.keys(sessionCache)) {
    const entry = sessionCache[key];
    if (entry && entry.browser) {
      try {
        await entry.browser.close();
        logger.info(`[Session] Closed browser for ${key}`);
      } catch (e) {
        logger.warn(`[Session] Browser close error for ${key}: ${e.message}`);
      }
    }
    entry.valid = false;
  }
  Object.keys(sessionCache).forEach(k => delete sessionCache[k]);
  logger.info(`[Session] All sessions closed.`);
}

function getCacheStatus() {
  const status = {};
  for (const key of Object.keys(sessionCache)) {
    const entry = sessionCache[key];
    if (entry && entry.valid) {
      status[key] = {
        fetchedAt: new Date(entry.fetchedAt).toISOString(),
        ageMin: Math.round((Date.now() - entry.fetchedAt) / 60000),
        ttlHours: parseInt(process.env.SESSION_TTL_HOURS) || 23,
        appsSessionValid: entry.session.appsSessionValid,
        pageUrl: entry.page ? (() => { try { return entry.page.url(); } catch (e) { return "closed"; } })() : "none"
      };
    }
  }
  return status;
}

module.exports = {
  getSession,
  invalidateSession,
  closeAllSessions,
  getCacheStatus
};
