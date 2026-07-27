// =============================================================================
// DATA HELPERS
// Phone formatting, date parsing, address extraction, recruiter parsing
// — Exact logic preserved from the Google Apps Script
// =============================================================================

/**
 * Format a phone number to +1XXXXXXXXXX format.
 * Exactly matches the Apps Script formatPhone_() logic.
 */
function formatPhone(phone) {
  if (!phone) return "";
  const digits = String(phone).replace(/\D/g, "");
  if (digits.length === 10) return "+1" + digits;
  if (digits.length === 11 && digits.charAt(0) === "1") return "+" + digits;
  return String(phone);
}

/**
 * Format a date from month + day components, forcing a year.
 * Matches formatInTouchDate_() from Apps Script.
 */
function formatInTouchDate(month, day, forceYear) {
  if (!month || !day) return "";
  const m = String(month).padStart(2, "0");
  const d = String(day).padStart(2, "0");
  return `${m}/${d}/${forceYear || "2000"}`;
}

/**
 * Reformat an ISO date (yyyy-MM-dd) to MM/dd/yyyy.
 * Matches reformatIsoDate_() from Apps Script.
 */
function reformatIsoDate(isoDate, forceYear) {
  if (!isoDate) return "";
  const parts = String(isoDate).split("-");
  if (parts.length !== 3) return String(isoDate);
  return `${parts[1]}/${parts[2]}/${forceYear || parts[0]}`;
}

/**
 * Reformat any date string to MM/dd/yyyy.
 * Matches reformatAnyDate_() from Apps Script.
 */
function reformatAnyDate(dateStr, forceYear) {
  if (!dateStr) return "";
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(dateStr)) {
    if (forceYear) {
      const p = dateStr.split("/");
      return `${p[0]}/${p[1]}/${forceYear}`;
    }
    return dateStr;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    const parts = dateStr.split("-");
    return `${parts[1]}/${parts[2]}/${forceYear || parts[0]}`;
  }
  if (/^\d{1,2}\/\d{1,2}$/.test(dateStr)) {
    const p2 = dateStr.split("/");
    return `${p2[0].padStart(2, "0")}/${p2[1].padStart(2, "0")}/${forceYear || "2000"}`;
  }
  return dateStr;
}

/**
 * Extract mailing address from a contact object.
 * Matches extractAddress_() from Apps Script exactly.
 */
function extractAddress(contact) {
  if (contact.MailingAddress) {
    const ma = contact.MailingAddress;
    return {
      street:  ma.street     || ma.Street     || "",
      city:    ma.city       || ma.City       || "",
      state:   ma.state      || ma.State      || "",
      zip:     ma.postalCode || ma.PostalCode || "",
      country: ma.country    || ma.Country    || ""
    };
  }
  if (contact.MailingStreet || contact.MailingCity || contact.MailingState || contact.MailingPostalCode) {
    return {
      street:  contact.MailingStreet     || "",
      city:    contact.MailingCity       || "",
      state:   contact.MailingState      || "",
      zip:     contact.MailingPostalCode || "",
      country: contact.MailingCountry    || ""
    };
  }
  if (contact.Addresses__r && contact.Addresses__r.length > 0) {
    const addr = contact.Addresses__r[0];
    return {
      street:  addr.Street     || addr.MailingStreet     || "",
      city:    addr.City       || addr.MailingCity       || "",
      state:   addr.State      || addr.MailingState      || "",
      zip:     addr.PostalCode || addr.MailingPostalCode || "",
      country: addr.Country__c || addr.Country           || addr.MailingCountry || ""
    };
  }
  return { street: "", city: "", state: "", zip: "", country: "" };
}

/**
 * Extract email from a contact object's Emails__r sub-object.
 * Matches extractEmail_() from Apps Script.
 */
function extractEmail(contact) {
  if (contact.Emails__r && contact.Emails__r.length > 0) {
    return contact.Emails__r[0].EmailAddress || contact.Emails__r[0].Email || "";
  }
  return "";
}

/**
 * Parse recruiter info from the RecruiterContactInfo_f__c string.
 * Matches parseRecruiterInfo_() from Apps Script exactly.
 */
function parseRecruiterInfo(recruiterStr) {
  if (!recruiterStr) return { firstName: "", lastName: "", consultantNum: "" };
  const afterNameLabel = recruiterStr.replace(/^Name:\s*/i, "").trim();
  if (!afterNameLabel) return { firstName: "", lastName: "", consultantNum: "" };

  if (recruiterStr.indexOf("First Name:") !== -1) {
    const fnMatch = recruiterStr.match(/First Name:\s*([^,]+)/);
    const lnMatch = recruiterStr.match(/Last Name:\s*([^,]+)/);
    return {
      firstName:     fnMatch ? fnMatch[1].trim() : "",
      lastName:      lnMatch ? lnMatch[1].trim() : "",
      consultantNum: ""
    };
  }

  const numMatch      = recruiterStr.match(/\(([^)]+)\)/);
  const consultantNum = numMatch ? numMatch[1] : "";
  const namePart      = recruiterStr.replace(/\([^)]+\)/, "").trim();
  const nameParts     = namePart.split(" ");
  return {
    firstName:     nameParts[0] || "",
    lastName:      nameParts.slice(1).join(" ") || "",
    consultantNum: consultantNum
  };
}

/**
 * Calculate Star Consultant quarter info.
 * Matches getStarConsultantQuarterInfo_() from Apps Script exactly.
 */
function getStarConsultantQuarterInfo(date) {
  const y = date.getFullYear();
  const m = date.getMonth() + 1;
  const d = date.getDate();

  let qStartMonth = m;
  let qStartYear  = y;
  if (d < 16) {
    qStartMonth = m - 1;
    if (qStartMonth <= 0) { qStartMonth += 12; qStartYear -= 1; }
  }

  const qStarts = [1, 4, 7, 10];
  let qStart  = qStarts[0];
  for (let i = qStarts.length - 1; i >= 0; i--) {
    if (qStartMonth >= qStarts[i]) { qStart = qStarts[i]; break; }
  }

  let qYear = qStartYear;
  if (qStart > qStartMonth) { qYear -= 1; }

  const months = [];
  for (let j = 0; j < 4; j++) {
    let mm = qStart + j;
    let yy = qYear;
    if (mm > 12) { mm -= 12; yy += 1; }
    months.push(`${yy}/${mm < 10 ? "0" + mm : mm}`);
  }

  const startMM  = qStart < 10 ? "0" + qStart : "" + qStart;
  const startDate = `${qYear}-${startMM}-16`;

  return { months, startDate };
}

module.exports = {
  formatPhone,
  formatInTouchDate,
  reformatIsoDate,
  reformatAnyDate,
  extractAddress,
  extractEmail,
  parseRecruiterInfo,
  getStarConsultantQuarterInfo
};
