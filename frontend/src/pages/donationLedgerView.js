// Pure helpers for the "Donation Integrity" ledger/certificate UI: shaping the backend's ledger, verify and
// certificate responses for display, and building a small downloadable HTML certificate document. No React,
// no DOM dependency beyond string-building, so this is testable with plain node:test.

const EVENT_LABELS = {
  SURPLUS_CREATED: 'Posted',
  SURPLUS_CLAIMED: 'Claimed',
  PICKUP_CONFIRMED: 'Pickup confirmed',
  SURPLUS_COLLECTED: 'Collected',
  SURPLUS_EXPIRED: 'Expired',
};

export function eventLabel(eventType) {
  return EVENT_LABELS[eventType] || eventType;
}

export function shortHash(hash) {
  if (!hash) return '—';
  return `${hash.slice(0, 10)}…`;
}

// Shapes GET /api/donations/:id/ledger's { events, eventCount, firstHash, lastHash, chainVerification } into a
// compact summary: event count, verification status, the latest event, and a short hash-chain fingerprint.
export function buildLedgerSummary(ledger) {
  if (!ledger) return null;
  const events = Array.isArray(ledger.events) ? ledger.events : [];
  const latest = events.length > 0 ? events[events.length - 1] : null;
  const verification = ledger.chainVerification || { valid: null };

  return {
    eventCount: ledger.eventCount ?? events.length,
    verified: verification.valid,
    reason: verification.valid === false ? verification.reason : null,
    latestEvent: latest ? { type: latest.eventType, label: eventLabel(latest.eventType), timestamp: latest.eventTimestamp } : null,
    firstHashShort: shortHash(ledger.firstHash),
    lastHashShort: shortHash(ledger.lastHash),
  };
}

// Shapes GET /api/donations/:id/certificate's response into a display-ready object. Never invents a value:
// an unavailable financial impact stays unavailable.
export function buildCertificateView(cert) {
  if (!cert) return null;
  return {
    certificateId: cert.certificateId,
    listingId: cert.listingId,
    foodType: cert.foodType,
    donorName: cert.donorOrganization ? cert.donorOrganization.name : '—',
    receivingName: cert.receivingOrganization ? cert.receivingOrganization.name : '—',
    quantityCollected: cert.quantityCollected,
    collectedAt: cert.collectedAt,
    financialAvailable: Boolean(cert.financialImpact && cert.financialImpact.available),
    financialValueInr: cert.financialImpact && cert.financialImpact.available ? cert.financialImpact.valueInr : null,
    co2eAvoidedKg: cert.environmentalImpact ? cert.environmentalImpact.co2eAvoidedKg : null,
    mealEquivalents: cert.environmentalImpact ? cert.environmentalImpact.mealEquivalents : null,
    ledgerValid: cert.ledgerVerification ? cert.ledgerVerification.valid : null,
    ledgerEventCount: cert.ledgerVerification ? cert.ledgerVerification.eventCount : null,
    generatedAt: cert.generatedAt,
    disclaimer: cert.disclaimer,
  };
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

// A small, self-contained, print-friendly HTML document for the certificate - no PDF library dependency.
// The user can open/print it (e.g. "Print to PDF") from their browser if they want a PDF file.
export function buildCertificateHtml(view) {
  const financialLine = view.financialAvailable
    ? `<p><strong>Estimated financial value:</strong> Rs. ${escapeHtml(view.financialValueInr)}</p>`
    : `<p><strong>Estimated financial value:</strong> not available for this donation</p>`;

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>FoodShare AI Impact Certificate ${escapeHtml(view.certificateId)}</title>
<style>
  body { font-family: Georgia, 'Times New Roman', serif; max-width: 720px; margin: 40px auto; color: #1f2a24; }
  .banner { text-align: center; border-bottom: 3px solid #2f7a4d; padding-bottom: 16px; margin-bottom: 24px; }
  .banner h1 { margin: 0; color: #2f7a4d; }
  .banner p { margin: 4px 0 0; color: #556; font-size: 13px; letter-spacing: 0.5px; text-transform: uppercase; }
  .row { display: flex; justify-content: space-between; margin: 10px 0; border-bottom: 1px solid #eee; padding-bottom: 8px; }
  .label { color: #667; }
  .value { font-weight: bold; }
  .disclaimer { margin-top: 30px; font-size: 12px; color: #778; border-top: 1px solid #eee; padding-top: 12px; }
  .cert-id { text-align: center; font-family: monospace; margin-top: 20px; color: #556; }
</style>
</head>
<body>
  <div class="banner">
    <h1>Impact Certificate</h1>
    <p>FoodShare AI Prototype</p>
  </div>
  <div class="row"><span class="label">Donation / Listing ID</span><span class="value">#${escapeHtml(view.listingId)}</span></div>
  <div class="row"><span class="label">Food Item</span><span class="value">${escapeHtml(view.foodType)}</span></div>
  <div class="row"><span class="label">Donor Organization</span><span class="value">${escapeHtml(view.donorName)}</span></div>
  <div class="row"><span class="label">Receiving NGO</span><span class="value">${escapeHtml(view.receivingName)}</span></div>
  <div class="row"><span class="label">Quantity Collected</span><span class="value">${escapeHtml(view.quantityCollected)} kg</span></div>
  <div class="row"><span class="label">Collected At</span><span class="value">${escapeHtml(view.collectedAt)}</span></div>
  ${financialLine}
  <div class="row"><span class="label">Estimated CO2e Avoided</span><span class="value">${escapeHtml(view.co2eAvoidedKg)} kg</span></div>
  <div class="row"><span class="label">Meal Equivalents</span><span class="value">${escapeHtml(view.mealEquivalents)}</span></div>
  <div class="row"><span class="label">Ledger Verification</span><span class="value">${view.ledgerValid ? 'Valid' : 'Invalid'} (${escapeHtml(view.ledgerEventCount)} events)</span></div>
  <p class="cert-id">Certificate ID: ${escapeHtml(view.certificateId)}</p>
  <p class="disclaimer">${escapeHtml(view.disclaimer)}</p>
</body>
</html>`;
}
