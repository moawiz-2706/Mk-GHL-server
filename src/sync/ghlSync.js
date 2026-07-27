// =============================================================================
// GHL SYNC — Chunked / Resumable GoHighLevel Contact Sync
// Exact logic preserved from the Google Apps Script:
// - Duplicate search before upsert
// - Tag merging with existing contacts
// - Custom field mapping
// - Chunked processing with cursor tracking
// - 500ms delay between contacts to respect rate limits
// =============================================================================

const axios = require("axios");
const logger = require("../utils/logger");

const GHL_API_BASE = "https://services.leadconnectorhq.com";
const CHUNK_SIZE = parseInt(process.env.GHL_CHUNK_SIZE) || 50;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Build the customFields array for GHL from the contact's customFields object.
 */
function buildCustomFieldsPayload(contact, customFieldMap) {
  const payload = [];
  for (const fieldName in contact.customFields) {
    if (!contact.customFields.hasOwnProperty(fieldName)) continue;
    const fieldId  = customFieldMap[fieldName];
    const fieldVal = contact.customFields[fieldName];
    if (fieldId && fieldVal !== "" && fieldVal !== null && fieldVal !== undefined) {
      payload.push({ id: fieldId, field_value: String(fieldVal) });
    }
  }
  return payload;
}

/**
 * Search for an existing GHL contact by email or phone.
 */
async function searchDuplicate(apiToken, locationId, contact) {
  const url = `${GHL_API_BASE}/contacts/search/duplicate?locationId=${locationId}`
    + (contact.email ? `&email=${encodeURIComponent(contact.email)}` : "")
    + (!contact.email && contact.phone ? `&phone=${encodeURIComponent(contact.phone)}` : "");

  try {
    const resp = await axios.get(url, {
      headers: {
        "Authorization": `Bearer ${apiToken}`,
        "Version":       "2021-07-28"
      },
      timeout: 15000,
      validateStatus: () => true
    });

    if (resp.status === 200) {
      const data = resp.data;
      return data.contact || null;
    }
  } catch (e) {
    logger.debug(`[GHL] Duplicate search failed: ${e.message}`);
  }
  return null;
}

/**
 * Upsert a contact in GHL.
 */
async function upsertContact(apiToken, locationId, contact) {
  const payload = {
    firstName:   contact.firstName   || "",
    lastName:    contact.lastName    || "",
    name:        contact.name        || "",
    phone:       contact.phone       || "",
    address1:    contact.address1    || "",
    city:        contact.city        || "",
    state:       contact.state       || "",
    postalCode:  contact.postalCode  || "",
    country:     contact.country     || "US",
    dateOfBirth: contact.dateOfBirth || "",
    tags:        contact.tags,
    locationId:  locationId,
    customFields: contact.customFields || []
  };

  if (contact.email) payload.email = contact.email;

  const resp = await axios.post(
    `${GHL_API_BASE}/contacts/upsert`,
    payload,
    {
      headers: {
        "Authorization": `Bearer ${apiToken}`,
        "Version":       "2021-07-28",
        "Content-Type":  "application/json"
      },
      timeout: 30000,
      validateStatus: () => true
    }
  );

  return {
    statusCode: resp.status,
    data: resp.data,
    contactId: (resp.data && resp.data.contact && resp.data.contact.id) ? resp.data.contact.id : ""
  };
}

/**
 * Process a single contact: search for existing, merge tags, upsert.
 */
async function processSingleContact(apiToken, locationId, contact, customFieldMap) {
  if (!contact.email && !contact.phone) {
    return { skipped: true };
  }

  // 1. Search for existing contact
  const existingContact = await searchDuplicate(apiToken, locationId, contact);
  let mergedTags = contact.tags || [];

  if (existingContact && Array.isArray(existingContact.tags)) {
    const tagSet = {};
    for (const t of existingContact.tags) tagSet[t] = true;
    for (const t of contact.tags)         tagSet[t] = true;
    mergedTags = Object.keys(tagSet);
  }

  // 2. Build custom fields
  const customFieldsPayload = buildCustomFieldsPayload(
    { ...contact, tags: mergedTags },
    customFieldMap
  );

  // 3. Upsert
  const result = await upsertContact(apiToken, locationId, {
    ...contact,
    tags:         mergedTags,
    customFields: customFieldsPayload
  });

  return {
    skipped: false,
    success: (result.statusCode === 200 || result.statusCode === 201),
    contactId: result.contactId,
    statusCode: result.statusCode,
    error: (result.statusCode !== 200 && result.statusCode !== 201)
      ? result.data
      : null
  };
}

/**
 * Sync a batch of contacts to GHL in chunks.
 *
 * @param {object} ghlConfig - { apiToken, locationId, customFields }
 * @param {Array} contacts - Array of contact objects to sync
 * @param {string} listName - Name for logging purposes
 * @param {object} options - { onProgress: function, resumeFrom: number }
 * @returns {Promise<object>} { synced, skipped, errors, total }
 */
async function syncToGhl(ghlConfig, contacts, listName, options = {}) {
  const { apiToken, locationId, customFields } = ghlConfig;
  const { onProgress, resumeFrom = 0 } = options;

  if (!contacts || contacts.length === 0) {
    logger.info(`[GHL Sync] No contacts to sync.`);
    return { synced: 0, skipped: 0, errors: [], total: 0 };
  }

  const total = contacts.length;
  let cursor = resumeFrom;
  const allErrors = [];

  logger.info(`[GHL Sync] Queuing ${total} contacts for chunked sync...`);

  while (cursor < total) {
    const chunkEnd = Math.min(cursor + CHUNK_SIZE, total);
    let successCount = 0;
    let skippedCount = 0;

    logger.info(`[GHL Sync] Processing chunk: contacts ${cursor + 1} to ${chunkEnd} of ${total}...`);

    for (let i = cursor; i < chunkEnd; i++) {
      const contact = contacts[i];

      try {
        const result = await processSingleContact(apiToken, locationId, contact, customFields);

        if (result.skipped) {
          skippedCount++;
        } else if (result.success) {
          successCount++;
        } else {
          allErrors.push({
            index:       i + 1,
            firstName:   contact.firstName || "",
            lastName:    contact.lastName  || "",
            email:       contact.email     || "",
            phone:       contact.phone     || "",
            statusCode:  result.statusCode,
            contactId:   result.contactId,
            error:       JSON.stringify(result.error || ""),
            payload:     JSON.stringify(contact)
          });
        }
      } catch (e) {
        allErrors.push({
          index:       i + 1,
          firstName:   contact.firstName || "",
          lastName:    contact.lastName  || "",
          email:       contact.email     || "",
          phone:       contact.phone     || "",
          statusCode:  "EXCEPTION",
          contactId:   "",
          error:       e.message,
          payload:     JSON.stringify(contact)
        });
      }

      // Rate limit delay between contacts (same as Apps Script)
      await sleep(500);
    }

    const chunkErrors = allErrors.length - (chunkEnd > cursor ? 0 : 0);

    logger.info(`[GHL Sync] Chunk done. Processed ${chunkEnd - cursor} contacts ` +
      `(${successCount} ok, ${skippedCount} skipped, ${chunkErrors} errors). ` +
      `Total progress: ${chunkEnd}/${total}`);

    cursor = chunkEnd;

    // Report progress
    if (onProgress) {
      onProgress({
        cursor,
        total,
        synced: successCount,
        skipped: skippedCount,
        chunkErrors
      });
    }

    // If more chunks remain, delay before next chunk (simulates the 60s trigger in Apps Script)
    if (cursor < total) {
      await sleep(2000);
    }
  }

  logger.info(`[GHL Sync] All ${total} contacts processed. Errors: ${allErrors.length}`);

  if (allErrors.length > 0) {
    logger.warn(`[GHL Sync] Error summary:`);
    for (const err of allErrors) {
      logger.warn(`  Contact #${err.index}: ${err.firstName} ${err.lastName} — ${err.statusCode} — ${err.error}`);
    }
  } else {
    logger.info(`[GHL Sync] All records synced successfully — no errors.`);
  }

  return {
    synced:   total - allErrors.length,
    skipped:  contacts.filter(c => !c.email && !c.phone).length,
    errors:   allErrors,
    total
  };
}

module.exports = {
  syncToGhl,
  processSingleContact,
  searchDuplicate,
  upsertContact,
  buildCustomFieldsPayload
};
