// =============================================================================
// DIAGNOSTICS (Puppeteer-Direct Architecture)
// Raw data export and validation endpoints for Postman testing.
// Allows verification of data accuracy before GHL sync.
// =============================================================================

const { getSession, invalidateSession } = require("../sessions/sessionManager");
const {
  fetchConsultantList,
  fetchSalesVolume,
  fetchStarConsultant,
  fetchCustomerListWithRetry,
  mergeAllData,
  buildGhlContacts
} = require("./dataProcessor");
const logger = require("../utils/logger");

/**
 * Build a session object for data fetching.
 * Single-page model: one page navigates between mk and apps domains.
 */
function buildPageSession(session) {
  return {
    page:            session.page,
    consultantNum:   session.consultantNum,
    auraToken:       session.auraToken || "",
    auraFwuid:       session.auraFwuid || "",
    auraAppVersion:  session.auraAppVersion || ""
  };
}

/**
 * Fetch raw data from all Mary Kay sources without processing.
 * Returns the raw API responses for inspection.
 */
async function fetchRawData(client) {
  logger.info(`[Diagnostics] Fetching raw data for ${client.clientName}`);

  const result = {
    clientName:    client.clientName,
    consultantNum: client.consultantNum,
    timestamp:     new Date().toISOString(),
    lists:         {}
  };

  // Get live session
  let session;
  try {
    session = await getSession(client.consultantNum, client.password, false);
  } catch (e) {
    return {
      error: `Session failed: ${e.message}`,
      ...result
    };
  }

  const pageSession = buildPageSession(session);

  // Fetch each list sequentially (single page bounces between domains)
  const clData = await fetchConsultantList(pageSession, client.consultantNum)
    .catch(e => ({ records: [], contactIdMap: {}, nameMap: {}, error: e.message }));

  const svRecords = await fetchSalesVolume(pageSession, client.consultantNum)
    .catch(e => ({ error: e.message }));

  const scRecords = await fetchStarConsultant(pageSession, client.consultantNum)
    .catch(e => ({ error: e.message }));

  const custRecords = await fetchCustomerListWithRetry(client, pageSession)
    .catch(e => ({ error: e.message }));

  result.lists.consultantList = {
    count:   Array.isArray(clData?.records) ? clData.records.length : 0,
    records: Array.isArray(clData?.records) ? clData.records : []
  };

  result.lists.salesVolume = {
    count:   Array.isArray(svRecords) ? svRecords.length : 0,
    records: Array.isArray(svRecords) ? svRecords : []
  };

  result.lists.starConsultant = {
    count:   Array.isArray(scRecords) ? scRecords.length : 0,
    records: Array.isArray(scRecords) ? scRecords : []
  };

  result.lists.customerList = {
    count:   Array.isArray(custRecords) ? custRecords.length : 0,
    records: Array.isArray(custRecords) ? custRecords : []
  };

  // Add session info for debugging
  result.sessionInfo = {
    mkUrl:     session.mkUrl || "",
    appsUrl:   session.appsUrl || "",
    pageUrl:   session.page ? (() => { try { return session.page.url(); } catch (e) { return "closed"; } })() : "none",
    appsReady: session.appsSessionValid || false,
    fromCache: session.fromCache || false
  };

  return result;
}

/**
 * Fetch processed contacts ready for GHL upload (without actually uploading).
 * This lets you inspect the exact data that would be pushed to GHL.
 */
async function fetchProcessedContacts(client) {
  logger.info(`[Diagnostics] Fetching processed contacts for ${client.clientName}`);

  const result = {
    clientName:    client.clientName,
    consultantNum: client.consultantNum,
    timestamp:     new Date().toISOString(),
    dataFetch:     {},
    mergedContacts: null,
    ghlContacts:   null
  };

  // Get live session
  let session;
  try {
    session = await getSession(client.consultantNum, client.password, false);
  } catch (e) {
    return {
      error: `Session failed: ${e.message}`,
      ...result
    };
  }

  const pageSession = buildPageSession(session);

  // Fetch all lists
  const clData = await fetchConsultantList(pageSession, client.consultantNum)
    .catch(e => ({ records: [], contactIdMap: {}, nameMap: {}, error: e.message }));

  const svRecords = await fetchSalesVolume(pageSession, client.consultantNum)
    .catch(e => ({ error: e.message }));

  const scRecords = await fetchStarConsultant(pageSession, client.consultantNum)
    .catch(e => ({ error: e.message }));

  const custRecords = await fetchCustomerListWithRetry(client, pageSession)
    .catch(e => ({ error: e.message }));

  result.dataFetch = {
    consultantList: Array.isArray(clData?.records) ? clData.records.length : 0,
    salesVolume:    Array.isArray(svRecords) ? svRecords.length : 0,
    starConsultant: Array.isArray(scRecords) ? scRecords.length : 0,
    customerList:   Array.isArray(custRecords) ? custRecords.length : 0,
    errors:         {
      consultantList: clData?.error || null,
      salesVolume:    svRecords?.error || null,
      starConsultant: scRecords?.error || null,
      customerList:   custRecords?.error || null
    }
  };

  // Merge and build contacts
  try {
    const { masterMap, keyOrder } = mergeAllData(
      clData || { records: [], contactIdMap: {}, nameMap: {} },
      Array.isArray(svRecords) ? svRecords : [],
      Array.isArray(scRecords) ? scRecords : [],
      Array.isArray(custRecords) ? custRecords : []
    );

    result.mergedContacts = keyOrder.length;
    result.ghlContacts = buildGhlContacts(masterMap, keyOrder);
  } catch (e) {
    result.error = `Merge failed: ${e.message}`;
  }

  return result;
}

/**
 * Validate all data lists — check counts, sample records, and error rates.
 */
async function validateAllData(client) {
  logger.info(`[Diagnostics] Validating data for ${client.clientName}`);

  const rawData = await fetchRawData(client);

  if (rawData.error) {
    return { error: rawData.error, valid: false };
  }

  const validation = {
    clientName:    client.clientName,
    consultantNum: client.consultantNum,
    timestamp:     new Date().toISOString(),
    valid:         true,
    warnings:      [],
    lists:         {}
  };

  for (const [listName, listData] of Object.entries(rawData.lists)) {
    const count = listData.count;
    const hasRecords = count > 0;

    validation.lists[listName] = {
      count,
      hasData: hasRecords,
      sampleRecords: listData.records.slice(0, 2)
    };

    if (!hasRecords) {
      validation.valid = false;
      validation.warnings.push(`${listName} returned 0 records`);
    }
  }

  // Validate consultant list structure
  const clRecords = rawData.lists.consultantList.records;
  if (clRecords.length > 0) {
    const sample = clRecords[0];
    if (!sample.Id && !sample.Id__c) {
      validation.warnings.push("Consultant List records missing Id field");
    }
  }

  // Validate customer list structure
  const custRecords = rawData.lists.customerList.records;
  if (custRecords.length > 0) {
    const sample = custRecords[0];
    if (!sample.personEmail && !sample.personMobilePhone) {
      validation.warnings.push("Customer List records missing email and phone");
    }
  }

  return validation;
}

/**
 * Export all data lists as raw JSON.
 */
async function exportAllLists(client) {
  return fetchRawData(client);
}

/**
 * Export GHL-ready contacts (merged and formatted).
 */
async function exportGhlReadyContacts(client) {
  return fetchProcessedContacts(client);
}

/**
 * Export GHL-ready contacts as CSV format.
 */
async function exportGhlReadyCsv(client) {
  const processed = await fetchProcessedContacts(client);

  if (processed.error) {
    return { error: processed.error, csv: "" };
  }

  const contacts = processed.ghlContacts || [];
  if (contacts.length === 0) {
    return { csv: "", contactCount: 0 };
  }

  // Build CSV
  const headers = [
    "First Name", "Last Name", "Email", "Phone", "Address",
    "City", "State", "Postal Code", "Country", "Tags",
    "Career Level", "Activity Status", "Consultant Number",
    "Current Wholesale", "Start Date", "Client Last Order"
  ];

  const rows = [headers.join(",")];

  for (const c of contacts) {
    const row = [
      c.firstName || "",
      c.lastName || "",
      c.email || "",
      c.phone || "",
      c.address1 || "",
      c.city || "",
      c.state || "",
      c.postalCode || "",
      c.country || "",
      (c.tags || []).join(";"),
      c.customFields?.["Career Level"] || "",
      c.customFields?.["Activity Status"] || "",
      c.customFields?.["Consultant Number"] || "",
      c.customFields?.["Current Wholesale"] || "",
      c.customFields?.["Start Date"] || "",
      c.customFields?.["Client Last Order"] || ""
    ].map(v => {
      const s = String(v).replace(/"/g, '""');
      return s.includes(",") || s.includes('"') || s.includes("\n") ? `"${s}"` : s;
    });

    rows.push(row.join(","));
  }

  return { csv: rows.join("\n"), contactCount: contacts.length };
}

module.exports = {
  fetchRawData,
  fetchProcessedContacts,
  validateAllData,
  exportAllLists,
  exportGhlReadyContacts,
  exportGhlReadyCsv
};