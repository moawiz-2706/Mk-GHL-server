// =============================================================================
// DATA PROCESSOR (Puppeteer-Direct Architecture)
// Fetches all Mary Kay data lists, processes them, and merges into
// unified contact records — EXACT logic preserved from Apps Script.
// 
// Now uses LIVE Puppeteer page objects instead of extracted cookies.
// All API calls happen INSIDE the browser via page.evaluate().
// =============================================================================

const { callAuraApi } = require("../core/auraApi");
const { callAppsLwrApi } = require("../core/lwrApi");
const { getSession, invalidateSession } = require("../sessions/sessionManager");
const logger = require("../utils/logger");
const {
  formatPhone,
  formatInTouchDate,
  reformatIsoDate,
  reformatAnyDate,
  extractAddress,
  extractEmail,
  parseRecruiterInfo,
  getStarConsultantQuarterInfo
} = require("../utils/dataHelpers");

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// =============================================================================
// FETCH: Consultant List (mk domain, Aura API)
// =============================================================================

/**
 * Fetch Consultant List using the live Puppeteer page.
 * @param {object} pageSession - Session object with page, consultantNum
 */
async function fetchConsultantList(pageSession, consultantNum) {
  logger.info(`[Consultant List] Starting for ${consultantNum}`);

  const pageSize = 200;
  let offset = 0;
  let total = null;
  const allRecords = [];

  do {
    const result = await callAuraApi(
      pageSession,
      "CMT_ConsultantListController",
      "getConsultantList",
      { listType: "unit", pageSize, offset },
      "/s/consultant-list"
    );

    if (!result) {
      logger.warn(`[Consultant List] No result returned.`);
      break;
    }

    let records = result.contactList || result.records || (Array.isArray(result) ? result : null);
    if (!records || records.length === 0) break;

    if (total === null) {
      total = result.totalCount || result.total || records.length;
    }

    allRecords.push(...records);
    offset += pageSize;
    await sleep(1000);

  } while (offset < total);

  logger.info(`[Consultant List] Total records: ${allRecords.length}`);

  if (allRecords.length === 0) return { records: [], contactIdMap: {}, nameMap: {} };

  // Build lookup maps
  const contactIdToConsultantNum = {};
  const nameToConsultantNum = {};

  for (const nr of allRecords) {
    const nId = nr.Id || "";
    const nCn = nr.ConsultantNumber__c || nr.consultantNumber || "";
    const nFn = (nr.FirstName || "").toLowerCase().replace(/^\s+|\s+$/g, "");
    const nLn = (nr.LastName  || "").toLowerCase().replace(/^\s+|\s+$/g, "");
    if (nId && nCn)        contactIdToConsultantNum[nId] = nCn;
    if (nFn && nLn && nCn) nameToConsultantNum[`${nFn} ${nLn}`] = nCn;
  }

  // Resolve outside recruiters
  const outsideRecruiterIds = {};
  for (const nr of allRecords) {
    const rid = nr.RecruiterContactId_lr__c || "";
    if (rid && !contactIdToConsultantNum[rid]) outsideRecruiterIds[rid] = true;
  }

  const outsideIds = Object.keys(outsideRecruiterIds);
  for (const rid of outsideIds) {
    try {
      const profileResult = await callAuraApi(
        pageSession,
        "CMT_ConsultantProfileController",
        "getConsultantProfile",
        { contactId: rid },
        "/s/consultant-profile"
      );
      let rCnum = "";
      if (profileResult) {
        rCnum = profileResult.ConsultantNumber__c
             || (profileResult.contact && profileResult.contact.ConsultantNumber__c)
             || (profileResult.Contact && profileResult.Contact.ConsultantNumber__c)
             || "";
      }
      if (rCnum) contactIdToConsultantNum[rid] = rCnum;
    } catch (e) {
      // continue
    }
    await sleep(500);
  }

  return { records: allRecords, contactIdMap: contactIdToConsultantNum, nameMap: nameToConsultantNum };
}

// =============================================================================
// FETCH: Sales Volume (mk domain, Aura API)
// =============================================================================

async function fetchSalesVolume(pageSession, consultantNum) {
  logger.info(`[Sales Volume] Starting for ${consultantNum}`);

  const result = await callAuraApi(
    pageSession,
    "CMT_ProductionListController",
    "getProductionListData",
    {
      accountId: "", careerLevelId: "", listType: "unit",
      sectionSettingName: "Prod-unit-SalesVolume",
      applyCurrentMonthFilter: false, countryName: "", isUnaffiliated: "null",
      includeZeroValueOrders: false, bcAccountId: "", newAgreementOrderType: "7",
      enablePIIMaskingForUnaffiliatedSummaryOnly: false, linNumberAndDrillDownCount: null,
      fourPlusRankField: "UnitWholesaleAmount_cr__c",
      excludeCosmeticOrdersWithZeroProductionValue: true
    },
    "/s/production"
  );

  if (!result) {
    logger.warn(`[Sales Volume] No result returned.`);
    return [];
  }

  let records = Array.isArray(result) ? result : null;
  if (!records) {
    const keys = Object.keys(result);
    for (const k of keys) {
      if (Array.isArray(result[k])) { records = result[k]; break; }
    }
  }
  if (!records || records.length === 0) {
    logger.warn(`[Sales Volume] No records in response.`);
    return [];
  }

  logger.info(`[Sales Volume] Building data with ${records.length} records...`);
  return records;
}

// =============================================================================
// FETCH: Star Consultant (mk domain, Aura API)
// =============================================================================

async function fetchStarConsultant(pageSession, consultantNum) {
  logger.info(`[Star Consultant] Starting for ${consultantNum}`);

  const result = await callAuraApi(
    pageSession,
    "CMT_ProductionListController",
    "getProductionListData",
    {
      accountId: "", careerLevelId: "", listType: "unit",
      sectionSettingName: "Prod-unit-StarConsultantTracking",
      applyCurrentMonthFilter: false, countryName: "", isUnaffiliated: "null",
      includeZeroValueOrders: false, bcAccountId: "", newAgreementOrderType: "7",
      enablePIIMaskingForUnaffiliatedSummaryOnly: false, linNumberAndDrillDownCount: null,
      fourPlusRankField: "UnitWholesaleAmount_cr__c",
      excludeCosmeticOrdersWithZeroProductionValue: true
    },
    "/s/production"
  );

  if (!result) {
    logger.warn(`[Star Consultant] No result returned.`);
    return [];
  }

  let records = Array.isArray(result) ? result : null;
  if (!records) {
    const keys = Object.keys(result);
    for (const k of keys) {
      if (Array.isArray(result[k])) { records = result[k]; break; }
    }
  }
  if (!records || records.length === 0) {
    logger.warn(`[Star Consultant] No records in response.`);
    return [];
  }

  logger.info(`[Star Consultant] Processing ${records.length} records...`);
  return records;
}

// =============================================================================
// FETCH: Customer List (apps domain, LWR API)
// =============================================================================

/**
 * Fetch customer list using the live Puppeteer page on apps domain.
 */
async function fetchCustomerList(pageSession, consultantNum) {
  logger.info(`[Customer List] Starting for ${consultantNum}`);

  const result = await callAppsLwrApi(
    pageSession,
    "CMT_CustomerListController",
    "getRelatedCustomers",
    {}
  );

  if (!result) {
    logger.warn(`[Customer List] No result returned on first attempt.`);
    return [];
  }

  const allRecords = Array.isArray(result) ? result
    : (result.customerList || result.contactList || result.customers || result.records || []);

  logger.info(`[Customer List] Total records: ${allRecords.length}`);
  return allRecords;
}

/**
 * Fetch customer list with retry logic.
 * Accepts an existing session object to avoid re-logging in.
 * On failure, invalidates session and retries with a fresh login.
 * Includes navigation retry: if appsPage isn't on customer-list, try navigating there directly.
 */
async function fetchCustomerListWithRetry(client, existingSession) {
  logger.info(`[Customer List] Starting for ${client.clientName}`);

  // Use existing session if provided, otherwise get one
  let pageSession = existingSession || await getSession(client.consultantNum, client.password, false);

  // First attempt
  let result = await fetchCustomerList(pageSession, client.consultantNum);

  if (result.length > 0) {
    return result;
  }

  // First attempt failed — try navigating the page to customer-list directly
  logger.warn(`[Customer List] First attempt returned empty. Trying direct navigation...`);
  try {
    const APPS_BASE = process.env.APPS_BASE_URL || "https://apps.marykayintouch.com";
    const page = pageSession.page;
    if (page) {
      await page.goto(`${APPS_BASE}/customer-list`, {
        waitUntil: "domcontentloaded",
        timeout: 60000
      }).catch(e => logger.warn(`[Customer List] Navigation error: ${e.message}`));
      await sleep(20000);
      const newUrl = page.url();
      logger.info(`[Customer List] After navigation: ${newUrl.substring(0, 100)}`);
      if (newUrl.includes("customer-list")) {
        result = await fetchCustomerList(pageSession, client.consultantNum);
        if (result.length > 0) return result;
      }
    }
  } catch (e) {
    logger.warn(`[Customer List] Direct navigation retry failed: ${e.message}`);
  }

  // Invalidate session and retry with fresh login
  logger.warn(`[Customer List] Forcing session refresh...`);
  await invalidateSession(client.consultantNum);

  pageSession = await getSession(client.consultantNum, client.password, true);
  const apiSession = {
    page:            pageSession.page,
    consultantNum:   client.consultantNum,
    auraToken:       pageSession.auraToken || "",
    auraFwuid:       pageSession.auraFwuid || "",
    auraAppVersion:  pageSession.auraAppVersion || ""
  };
  result = await fetchCustomerList(apiSession, client.consultantNum);

  if (result.length > 0) {
    return result;
  }

  // Third attempt — one more full session refresh
  logger.warn(`[Customer List] Second attempt failed. Full session refresh...`);
  await invalidateSession(client.consultantNum);

  pageSession = await getSession(client.consultantNum, client.password, true);
  const apiSession2 = {
    page:            pageSession.page,
    consultantNum:   client.consultantNum,
    auraToken:       pageSession.auraToken || "",
    auraFwuid:       pageSession.auraFwuid || "",
    auraAppVersion:  pageSession.auraAppVersion || ""
  };
  result = await fetchCustomerList(apiSession2, client.consultantNum);

  if (result.length > 0) {
    return result;
  }

  logger.error(`[Customer List] All retry attempts exhausted. Skipping.`);
  return [];
}

// =============================================================================
// MERGE: Combine all data into master contact records
// =============================================================================

/**
 * Process all lists and merge into unified contact records.
 * Returns the masterMap (keyed by phone or email) and keyOrder array.
 *
 * This is the EXACT same merge logic as the Apps Script.
 */
function mergeAllData(clData, svRecords, scRecords, custRecords) {
  // ── Build phone/wholesale map from Sales Volume ──
  const phoneToWholesale = {};
  for (const svr of svRecords) {
    const svPhone = formatPhone(
      ((svr.Contact || {}).MobilePhone) || ((svr.Contact || {}).Phone) || ""
    );
    if (!svPhone) continue;
    let wsSum = 0;
    const orders = svr.OrderHeaders || [];
    for (const o of orders) wsSum += parseFloat(o.Wholesale_cr__c || 0);
    wsSum = Math.round(wsSum * 100) / 100;
    phoneToWholesale[svPhone] = wsSum;
  }

  // ── Build phone/tier map from Star Consultant ──
  const acctToScContact = {};
  let allNewOrders = [];
  for (const rec of scRecords) {
    const acctId = ((rec.Account_mdr__r || {}).Id) || "";
    if (acctId) acctToScContact[acctId] = rec.Contact || {};
    const hdrs = rec.newOrderHeaderList || [];
    if (hdrs.length > 0 && allNewOrders.length === 0) allNewOrders = hdrs;
  }

  const acctWsMap = {};
  for (const order of allNewOrders) {
    const aId = order.Account_mdr__c || "";
    acctWsMap[aId] = (acctWsMap[aId] || 0) + parseFloat(order.Wholesale_cr__c || 0);
  }

  const phoneToStarTiers = {};
  for (const aId in acctWsMap) {
    if (!acctWsMap.hasOwnProperty(aId)) continue;
    const scContact = acctToScContact[aId] || {};
    const scPhone = formatPhone(scContact.MobilePhone || scContact.Phone || "");
    if (!scPhone) continue;
    const ws = Math.round(acctWsMap[aId] * 100) / 100;
    phoneToStarTiers[scPhone] = {
      sapphire: Math.max(0, Math.round((1800 - ws) * 100) / 100),
      ruby:     Math.max(0, Math.round((2400 - ws) * 100) / 100),
      diamond:  Math.max(0, Math.round((3000 - ws) * 100) / 100),
      emerald:  Math.max(0, Math.round((3600 - ws) * 100) / 100),
      pearl:    Math.max(0, Math.round((4800 - ws) * 100) / 100)
    };
  }

  // ── Star Consultant tier calculations by quarter ──
  const today = new Date();
  const qInfo = getStarConsultantQuarterInfo(today);
  const qMonths = qInfo.months;
  const currentMonthKey = `${today.getFullYear()}/${String(today.getMonth() + 1).padStart(2, "0")}`;

  const acctToRecord = {};
  const acctToContact = {};
  for (const rec of scRecords) {
    const acctId = ((rec.Account_mdr__r || {}).Id) || "";
    if (acctId) {
      acctToContact[acctId] = rec.Contact || {};
      acctToRecord[acctId] = rec;
    }
  }

  const starDataByPhone = {};
  for (const aId in acctWsMap) {
    if (!acctWsMap.hasOwnProperty(aId)) continue;
    const wsSum = Math.round(acctWsMap[aId] * 100) / 100;
    const contact = acctToContact[aId] || {};
    const rec = acctToRecord[aId] || {};
    const phone = formatPhone(contact.MobilePhone || contact.Phone || "");
    if (!phone) continue;

    const m0 = (currentMonthKey === qMonths[0]) ? wsSum : "";
    const m1 = (currentMonthKey === qMonths[1]) ? wsSum : "";
    const m2 = (currentMonthKey === qMonths[2]) ? wsSum : "";
    const m3 = (currentMonthKey === qMonths[3]) ? wsSum : "";
    const totalWS = Math.round((wsSum + parseFloat(rec.teamWholeSaleSum || 0)) * 100) / 100;

    starDataByPhone[phone] = {
      newMembers:    rec.NewUnitMemberCount_n__c || "",
      totalStarQtrs: ((rec.Account_mdr__r || {}).TotalCareerStarQuarters__c) || "",
      teamCredit:    parseFloat(rec.teamWholeSaleSum || 0),
      m0, m1, m2, m3,
      totalWS,
      sapphire: Math.max(0, Math.round((1800 - wsSum) * 100) / 100),
      ruby:     Math.max(0, Math.round((2400 - wsSum) * 100) / 100),
      diamond:  Math.max(0, Math.round((3000 - wsSum) * 100) / 100),
      emerald:  Math.max(0, Math.round((3600 - wsSum) * 100) / 100),
      pearl:    Math.max(0, Math.round((4800 - wsSum) * 100) / 100)
    };
  }

  // ── Build Master Map ──
  const masterMap = {};
  const keyOrder = [];

  function makeKey(phone, email) {
    if (phone) return phone;
    if (email) return email.toLowerCase().trim();
    return null;
  }

  function getOrCreate(key, defaults) {
    if (!masterMap[key]) {
      masterMap[key] = {
        firstName: "", lastName: "", email: "", phone: "", additionalPhone: "",
        street: "", city: "", state: "", postalCode: "", country: "", dob: "",
        consultantNum: "", careerLevel: "", activityStatus: "", langPref: "",
        recruiterFirst: "", recruiterLast: "", recruiterNum: "",
        startDate: "", currentWholesale: "",
        sapphire: "", ruby: "", diamond: "", emerald: "", pearl: "",
        clientLastOrder: "", aptSuiteUnit: "", tags: []
      };
      for (const k in defaults) masterMap[key][k] = defaults[k];
      keyOrder.push(key);
    }
    return masterMap[key];
  }

  // Process Consultant List records
  const { records: clRecords, contactIdMap, nameMap } = clData;
  for (const c of clRecords) {
    const mobile = formatPhone(c.MobilePhone || c.mobilePhone || c.Phone || c.phone || "");
    const home   = formatPhone(c.HomePhone   || c.homePhone   || c.OtherPhone || c.otherPhone || "");
    const email  = c.Email || c.email || extractEmail(c) || "";
    const key    = makeKey(mobile, email);
    if (!key) continue;

    const addr     = extractAddress(c);
    const cl_      = c.CareerLevelShortDescription_p__c || c.CareerLevel__c    || c.career_level_   || c.careerLevel    || "";
    const as_      = c.ActivityStatusCode_p__c          || c.ActivityStatus__c || c.status          || c.activityStatus || "";
    const lp       = c.LanguagePreference__c || c.language_preference || c.languagePreference || "";

    let dob = "";
    if (c.BirthMonth_t__c && c.BirthDay_t__c) {
      dob = formatInTouchDate(c.BirthMonth_t__c, c.BirthDay_t__c, "2000");
    } else if (c.Birthdate_d__c) {
      dob = reformatIsoDate(c.Birthdate_d__c, "2000");
    } else if (c.dateOfBirth || c.DateOfBirth) {
      dob = reformatAnyDate(c.dateOfBirth || c.DateOfBirth, "2000");
    }

    let startDate = "";
    if (c.Account && c.Account.StartDate__c) {
      startDate = reformatAnyDate(c.Account.StartDate__c, null);
    } else {
      startDate = c.StartDate__c || c.startDate || c.StartDate || "";
      if (startDate) startDate = reformatAnyDate(startDate, null);
    }

    const recruiter = parseRecruiterInfo(c.RecruiterContactInfo_f__c || c.Recruiter__c || c.recruiter || "");
    if (recruiter.firstName && !recruiter.consultantNum) {
      const rContactId = c.RecruiterContactId_lr__c
                      || (c.RecruiterContactId_lr__r && c.RecruiterContactId_lr__r.Id)
                      || "";
      if (rContactId) {
        recruiter.consultantNum = contactIdMap[rContactId] || "";
      }
      if (!recruiter.consultantNum && recruiter.lastName) {
        const lookupKey = recruiter.firstName.toLowerCase().replace(/^\s+|\s+$/g, "")
                        + " "
                        + recruiter.lastName.toLowerCase().replace(/^\s+|\s+$/g, "");
        recruiter.consultantNum = nameMap[lookupKey] || "";
      }
    }

    const row = getOrCreate(key, {});
    row.firstName       = c.FirstName  || c.firstName  || row.firstName;
    row.lastName        = c.LastName   || c.lastName   || row.lastName;
    row.email           = email        || row.email;
    row.phone           = mobile       || row.phone;
    row.additionalPhone = home         || row.additionalPhone;
    row.street          = addr.street  || row.street;
    row.city            = addr.city    || row.city;
    row.state           = addr.state   || row.state;
    row.postalCode      = addr.zip     || row.postalCode;
    row.country         = addr.country || row.country;
    row.dob             = dob          || row.dob;
    row.consultantNum   = (c.ConsultantNumber__c || c.consultantNumber || "") || row.consultantNum;
    row.careerLevel     = cl_          || row.careerLevel;
    row.activityStatus  = as_          || row.activityStatus;
    row.langPref        = lp           || row.langPref;
    row.recruiterFirst  = recruiter.firstName     || row.recruiterFirst;
    row.recruiterLast   = recruiter.lastName      || row.recruiterLast;
    row.recruiterNum    = recruiter.consultantNum || row.recruiterNum;
    row.startDate       = startDate    || row.startDate;
    if (!row.tags.includes("Consultant")) row.tags.push("Consultant");
  }

  // Merge wholesale data
  for (const phone in phoneToWholesale) {
    if (!phoneToWholesale.hasOwnProperty(phone)) continue;
    const row = masterMap[phone];
    if (row) {
      row.currentWholesale = phoneToWholesale[phone];
    } else {
      const stub = getOrCreate(phone, { phone });
      stub.currentWholesale = phoneToWholesale[phone];
    }
  }

  // Merge star tier data
  for (const phone in phoneToStarTiers) {
    if (!phoneToStarTiers.hasOwnProperty(phone)) continue;
    const row = masterMap[phone];
    if (row) {
      row.sapphire = phoneToStarTiers[phone].sapphire;
      row.ruby     = phoneToStarTiers[phone].ruby;
      row.diamond  = phoneToStarTiers[phone].diamond;
      row.emerald  = phoneToStarTiers[phone].emerald;
      row.pearl    = phoneToStarTiers[phone].pearl;
    } else {
      const stub = getOrCreate(phone, { phone });
      stub.sapphire = phoneToStarTiers[phone].sapphire;
      stub.ruby     = phoneToStarTiers[phone].ruby;
      stub.diamond  = phoneToStarTiers[phone].diamond;
      stub.emerald  = phoneToStarTiers[phone].emerald;
      stub.pearl    = phoneToStarTiers[phone].pearl;
    }
  }

  // Process Customer List records
  for (const c of custRecords) {
    const mobile = formatPhone(c.personMobilePhone || "");
    const email  = c.personEmail || "";
    const key    = makeKey(mobile, email);
    if (!key) continue;

    let dob = "";
    if (c.birthday) {
      const bStr = c.birthday.trim();
      if (bStr.length === 5 && bStr.charAt(2) === "-") {
        dob = bStr.substring(0, 2) + "/" + bStr.substring(3, 5) + "/2000";
      } else if (bStr.length >= 10) {
        dob = reformatIsoDate(bStr.substring(0, 10), "2000");
      }
    }

    let lastOrder = "";
    if (c.lastOrder && c.lastOrder.length >= 10) {
      lastOrder = reformatIsoDate(c.lastOrder.substring(0, 10), null);
    }

    const row = getOrCreate(key, {});
    row.firstName       = c.firstName               || row.firstName;
    row.lastName        = c.lastName                || row.lastName;
    row.email           = email                     || row.email;
    row.phone           = mobile                    || row.phone;
    row.street          = c.personMailingStreet     || row.street;
    row.city            = c.personMailingCity       || row.city;
    row.state           = c.personMailingState      || row.state;
    row.postalCode      = c.personMailingPostalCode || row.postalCode;
    row.country         = c.personMailingCountry    || row.country;
    row.dob             = dob                       || row.dob;
    row.clientLastOrder = lastOrder                 || row.clientLastOrder;
    row.aptSuiteUnit    = c.personMailingStreet2    || row.aptSuiteUnit;
    if (!row.tags.includes("Client")) row.tags.push("Client");
  }

  return { masterMap, keyOrder };
}

// =============================================================================
// BUILD GHL CONTACTS
// =============================================================================

/**
 * Convert master map records into GHL-compatible contact objects.
 */
function buildGhlContacts(masterMap, keyOrder) {
  const contacts = [];

  for (const key of keyOrder) {
    const r = masterMap[key];

    const ghlEmail = r.email ? r.email.trim() : null;

    contacts.push({
      firstName:    r.firstName,
      lastName:     r.lastName,
      name:         ((r.firstName || "") + " " + (r.lastName || "")).trim(),
      email:        ghlEmail,
      phone:        r.phone,
      address1:     r.street,
      city:         r.city,
      state:        r.state,
      postalCode:   r.postalCode,
      country:      r.country,
      dateOfBirth:  r.dob,
      tags:         r.tags,
      customFields: {
        "Career Level":                r.careerLevel,
        "Activity Status":             r.activityStatus,
        "Consultant Number":           r.consultantNum,
        "Language Preference":         r.langPref,
        "Additional Phone":            r.additionalPhone,
        "Recruiter First Name":        r.recruiterFirst,
        "Recruiter Last Name":         r.recruiterLast,
        "Recruiter Consultant Number": r.recruiterNum,
        "Start Date":                  r.startDate,
        "Current Wholesale":           r.currentWholesale,
        "Needed for Sapphire":         r.sapphire,
        "Needed for Ruby":             r.ruby,
        "Needed for Diamond":          r.diamond,
        "Needed for Emerald":          r.emerald,
        "Needed for Pearl":            r.pearl,
        "Client Last Order":           r.clientLastOrder,
        "Apt/Suite/Unit":              r.aptSuiteUnit
      }
    });
  }

  return contacts;
}

// =============================================================================
// MAIN ORCHESTRATOR — Run all exports for one client
// =============================================================================

/**
 * Run the complete data fetch and merge for a single client.
 * @param {object} client - Client configuration object
 * @returns {Promise<object>} { contacts, stats }
 */
async function processClient(client) {
  logger.info(`\n--- Processing: ${client.clientName} ---`);

  const execStart = new Date();
  const stats = {
    startTime:     execStart.toISOString(),
    clientName:    client.clientName,
    consultantNum: client.consultantNum,
    consultantListCount: 0,
    salesVolumeCount:    0,
    starConsultantCount: 0,
    customerListCount:   0,
    mergedContacts:      0,
    ghlSynced:           0,
    ghlErrors:           0,
    errors:              []
  };

  // 1. Get live session (Puppeteer page)
  let pageSession;
  try {
    pageSession = await getSession(client.consultantNum, client.password, false);
  } catch (e) {
    stats.errors.push(`Session failed: ${e.message}`);
    logger.error(`ERROR: Could not obtain session for ${client.clientName}. Skipping.`);
    return { contacts: [], stats };
  }

  // Build the session object used by auraApi and lwrApi.
  // Single-page model: one page navigates between mk and apps domains.
  const pageApiSession = {
    page:            pageSession.page,
    consultantNum:   client.consultantNum,
    auraToken:       pageSession.auraToken || "",
    auraFwuid:       pageSession.auraFwuid || "",
    auraAppVersion:  pageSession.auraAppVersion || ""
  };

  // 2. Fetch Consultant List (Aura API via page.evaluate)
  let clData = { records: [], contactIdMap: {}, nameMap: {} };
  try {
    clData = await fetchConsultantList(pageApiSession, client.consultantNum);
    stats.consultantListCount = clData.records.length;
  } catch (e) {
    logger.error(`[Consultant List] Error: ${e.message}`);
    stats.errors.push(`Consultant List failed: ${e.message}`);
  }

  // 3. Fetch Sales Volume (Aura API via page.evaluate)
  let svRecords = [];
  try {
    svRecords = await fetchSalesVolume(pageApiSession, client.consultantNum);
    stats.salesVolumeCount = svRecords.length;
  } catch (e) {
    logger.error(`[Sales Volume] Error: ${e.message}`);
    stats.errors.push(`Sales Volume failed: ${e.message}`);
  }

  // 4. Fetch Star Consultant (Aura API via page.evaluate)
  let scRecords = [];
  try {
    scRecords = await fetchStarConsultant(pageApiSession, client.consultantNum);
    stats.starConsultantCount = scRecords.length;
  } catch (e) {
    logger.error(`[Star Consultant] Error: ${e.message}`);
    stats.errors.push(`Star Consultant failed: ${e.message}`);
  }

  // 5. Fetch Customer List (LWR API via page.evaluate, with retry)
  let custRecords = [];
  try {
    custRecords = await fetchCustomerListWithRetry(client, pageApiSession);
    stats.customerListCount = custRecords.length;
  } catch (e) {
    logger.error(`[Customer List] Error: ${e.message}`);
    stats.errors.push(`Customer List failed: ${e.message}`);
  }

  // 6. Merge all data
  logger.info(`[Master Import] Merging all data sources...`);
  const { masterMap, keyOrder } = mergeAllData(clData, svRecords, scRecords, custRecords);
  stats.mergedContacts = keyOrder.length;
  logger.info(`[Master Import] Total combined unique records: ${keyOrder.length}`);

  // 7. Build GHL contacts
  const contacts = buildGhlContacts(masterMap, keyOrder);

  logger.info(`Client ${client.clientName} exports COMPLETE.`);
  return { contacts, stats };
}

module.exports = {
  processClient,
  fetchConsultantList,
  fetchSalesVolume,
  fetchStarConsultant,
  fetchCustomerList,
  fetchCustomerListWithRetry,
  mergeAllData,
  buildGhlContacts
};