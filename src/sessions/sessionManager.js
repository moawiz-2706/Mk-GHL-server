// =============================================================================
// SESSION MANAGER — Puppeteer-Direct Architecture (Two-Tab Model)
//
// Two tabs in the same browser:
//   - mkPage: stays on mk.marykayintouch.com for Aura API calls
//   - appsPage: navigates to apps.marykayintouch.com for LWR API calls
//
// Both tabs share cookies (same browser), so authentication persists.
// The mkPage extracts the auraToken before navigating to apps.
// =============================================================================

"use strict";

const puppeteer = require("puppeteer");
const logger = require("../utils/logger");

const INTOUCH_BASE = process.env.MK_BASE_URL || "https://mk.marykayintouch.com";
const APPS_BASE    = process.env.APPS_BASE_URL || "https://apps.marykayintouch.com";
const LOGIN_URL    = `${INTOUCH_BASE}/s/login/?language=en_US`;

const SESSION_TTL_MS = (parseInt(process.env.SESSION_TTL_HOURS ) || 23) * 60 * 60 * 1000;
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

// Pages that indicate SSO is still in progress (not yet at the target page)
const SSO_INTERMEDIATE_URLS = [
  "/idp/login",
  "/loginFlowOnly",
  "/frontdoor.jsp",
  "/login",
  "LoginIntouchFlow"
];

function isAppsPageReady(url) {
  if (!url.includes("apps.marykayintouch.com")) return false;
  for (const intermediate of SSO_INTERMEDIATE_URLS) {
    if (url.includes(intermediate)) return false;
  }
  return true;
}

function isOnCustomerList(url) {
  return url.includes("apps.marykayintouch.com/customer-list");
}

// =============================================================================
// PUPPETEER LOGIN — Two-tab model
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

  // ── Tab 1: Login on mk domain ──
  const mkPage = await browser.newPage();
  await mkPage.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
  );

  try {
    // ── STEP 1: Navigate to login page ──
    logger.info(`[Login] Navigating to login page...`);
    await mkPage.goto(LOGIN_URL, {
      waitUntil: "networkidle2",
      timeout:   60000
    });

    // ── STEP 2: Fill credentials ──
    logger.info(`[Login] Filling credentials...`);
    await mkPage.waitForSelector('input[type="text"]',     { timeout: 30000 });
    await mkPage.waitForSelector('input[type="password"]', { timeout: 30000 });
    await mkPage.type('input[type="text"]',     consultantNum, { delay: 60 });
    await mkPage.type('input[type="password"]', password,      { delay: 60 });

    // ── STEP 3: Submit login ──
    logger.info(`[Login] Submitting login form...`);
    try {
      await Promise.all([
        mkPage.waitForNavigation({ waitUntil: "networkidle2", timeout: 60000 }),
        mkPage.keyboard.press("Enter")
      ]);
    } catch (e) {
      logger.warn(`[Login] Navigation timeout (ignored): ${e.message}`);
      await sleep(3000);
    }

    await sleep(3000);

    const postLoginUrl = mkPage.url();
    logger.info(`[Login] Post-login URL: ${postLoginUrl}`);

    if (postLoginUrl.includes("/login")) {
      throw new Error("Login failed — still on login page. Check credentials.");
    }

    // ── STEP 4: Wait for Aura framework ──
    logger.info(`[Login] Waiting for Aura framework...`);
    try {
      await mkPage.waitForFunction(
        () => typeof $A !== "undefined" && $A.clientService,
        { timeout: 20000 }
      );
      logger.info(`[Login] Aura framework ready.`);
    } catch (e) {
      logger.warn(`[Login] Aura framework not ready — continuing anyway.`);
    }

    // ── STEP 5: Extract Aura metadata and token FROM mk page ──
    logger.info(`[Login] Extracting Aura metadata from mk page...`);

    const auraData = await mkPage.evaluate(() => {
      const result = {
        fwuid: "",
        appVersion: "",
        auraToken: ""
      };

      const scripts = document.querySelectorAll("script[src]");
      for (const s of scripts) {
        const src = s.src || "";
        if (src.includes("/auraFW/javascript/")) {
          const m = src.match(/\/auraFW\/javascript\/([^\/]+)\//);
          if (m) result.fwuid = m[1];
        }
      }

      const inlineScripts = document.querySelectorAll("script:not([src])");
      for (const s of inlineScripts) {
        const t = s.textContent || "";
        if (t.includes("communityApp")) {
          const m = t.match(/siteforce:communityApp['":]\s*['"]?([^'"\\,\s\}]+)/);
          if (m) result.appVersion = m[1];
          if (result.appVersion) break;
        }
      }

      try {
        if (typeof $A !== "undefined" && $A.clientService) {
          result.auraToken = $A.clientService.Cc || "";
          if (!result.auraToken && $A.clientService.token) {
            result.auraToken = $A.clientService.token;
          }
        }
      } catch (e) {}

      return result;
    });

    logger.info(`[Login] auraToken length: ${auraData.auraToken.length}`);
    logger.info(`[Login] fwuid: ${auraData.fwuid ? auraData.fwuid.substring(0, 20) + "..." : "MISSING"}`);
    logger.info(`[Login] appVersion: ${auraData.appVersion || "MISSING"}`);

    // ── STEP 6: Create apps tab (Tab 2) and navigate to apps domain ──
    logger.info(`[Login] Creating apps page (new tab in same browser)...`);
    const appsPage = await browser.newPage();
    await appsPage.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    );

    let appsPageReady = false;
    const maxSsoRetries = 5;

    for (let ssoAttempt = 1; ssoAttempt <= maxSsoRetries; ssoAttempt++) {
      try {
        logger.info(`[Login] SSO attempt ${ssoAttempt}: Navigating to apps domain...`);
        await appsPage.goto(`${APPS_BASE}/customer-list`, {
          waitUntil: "domcontentloaded",
          timeout:   60000
        });
      } catch (e) {
        logger.warn(`[Login] Navigation to apps domain timed out (attempt ${ssoAttempt}/${maxSsoRetries}): ${e.message}`);
      }

      // Wait for SSO redirect chain to complete
      await sleep(15000);

      // Wait until the URL stabilizes
      for (let stabWait = 0; stabWait < 60000; stabWait += 2000) {
        const url1 = appsPage.url();
        await sleep(2000);
        const url2 = appsPage.url();
        if (url1 === url2) break;
      }

      const currentUrl = appsPage.url();
      logger.info(`[Login] SSO attempt ${ssoAttempt}: Current URL = ${currentUrl.substring(0, 120)}`);

      // Check if we're on the target page
      if (isOnCustomerList(currentUrl)) {
        appsPageReady = true;
        logger.info(`[Login] Apps page ready at: ${currentUrl.substring(0, 80)}`);
        break;
      }

      // Check if we're on a non-intermediate apps page
      if (isAppsPageReady(currentUrl)) {
        appsPageReady = true;
        logger.info(`[Login] Apps page loaded (non-customer-list): ${currentUrl.substring(0, 80)}`);
        break;
      }

      // We're on an intermediate SSO page — handle it
      logger.warn(`[Login] SSO redirect on intermediate page. Handling...`);

      // frontdoor.jsp — SAML assertion exchange, wait for redirect
      if (currentUrl.includes("frontdoor.jsp")) {
        logger.info(`[Login] On frontdoor.jsp — waiting for redirect...`);
        await sleep(20000);
        const afterWaitUrl = appsPage.url();
        logger.info(`[Login] After frontdoor wait: ${afterWaitUrl.substring(0, 120)}`);
        if (isOnCustomerList(afterWaitUrl)) {
          appsPageReady = true;
          break;
        }
        if (isAppsPageReady(afterWaitUrl)) {
          appsPageReady = true;
          break;
        }
        // If still on an intermediate page, continue the loop to retry
        continue;
      }

      // loginFlowOnly — try clicking submit
      if (currentUrl.includes("loginFlowOnly")) {
        try {
          const submitBtn = await appsPage.$('input[type="submit"], button[type="submit"], .login-submit');
          if (submitBtn) {
            logger.info(`[Login] Clicking submit on loginFlowOnly...`);
            await submitBtn.click();
            await sleep(15000);
          }
        } catch (e) {
          logger.warn(`[Login] Could not click submit: ${e.message}`);
        }
        // Check URL after click
        const afterClickUrl = appsPage.url();
        if (isOnCustomerList(afterClickUrl) || isAppsPageReady(afterClickUrl)) {
          appsPageReady = true;
          break;
        }
        continue;
      }

      // idp/login — SAML redirect, wait for it
      if (currentUrl.includes("/idp/login")) {
        logger.info(`[Login] On idp/login — waiting for SAML redirect...`);
        await sleep(15000);
        const afterSamlUrl = appsPage.url();
        if (isOnCustomerList(afterSamlUrl) || isAppsPageReady(afterSamlUrl)) {
          appsPageReady = true;
          break;
        }
        continue;
      }

      // Unknown intermediate — just continue retrying
      continue;
    }

    if (!appsPageReady) {
      logger.warn(`[Login] Warning: Apps page may not have loaded correctly after ${maxSsoRetries} attempts.`);
      logger.info(`[Login] Final apps URL: ${appsPage.url().substring(0, 120)}`);
    }

    const finalAppsUrl = appsPage.url();
    logger.info(`[Login] Final apps URL: ${finalAppsUrl.substring(0, 100)}`);

    // ── STEP 7: Wait for LWR framework to fully load (longer on cloud) ──
    let appsCsrfToken = "";
    if (appsPageReady && isOnCustomerList(finalAppsUrl)) {
      logger.info(`[Login] Waiting for LWR framework to initialize...`);
      try {
        await appsPage.waitForFunction(
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
    if (appsPageReady) {
      try {
        appsCsrfToken = await appsPage.evaluate(() => {
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

    logger.info(`[Login] ═══ Login successful ═══`);

    return {
      consultantNum:   consultantNum,
      mkPage:          mkPage,
      appsPage:        appsPage,
      browser:         browser,
      mkUrl:           postLoginUrl,
      appsUrl:         finalAppsUrl,
      auraToken:       auraData.auraToken,
      auraFwuid:       auraData.fwuid,
      auraAppVersion:  auraData.appVersion,
      appsCsrfToken:   appsCsrfToken,
      appsSessionValid: appsPageReady,
      fetchedAt:       new Date().toISOString()
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
    try {
      await entry.mkPage.title();
      return { ...entry.session, fromCache: true };
    } catch (e) {
      logger.warn(`[Session] Cached pages appear to be closed. Refreshing...`);
      entry.valid = false;
    }
  }

  logger.info(`[Session] Cache miss — logging in for ${key}...`);

  for (let retry = 1; retry <= LOGIN_MAX_RETRIES; retry++) {
    try {
      const session = await loginAndGetSession(key, password);
      sessionCache[key] = {
        session,
        mkPage:    session.mkPage,
        appsPage:  session.appsPage,
        browser:   session.browser,
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
        mkPageUrl: entry.mkPage ? (() => { try { return entry.mkPage.url(); } catch (e) { return "closed"; } })() : "none",
        appsPageUrl: entry.appsPage ? (() => { try { return entry.appsPage.url(); } catch (e) { return "closed"; } })() : "none"
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
