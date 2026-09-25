import React, { useReducer } from 'react';
import { useAuth } from '../context/AuthContext';
import { formatDateTime, formatInr, formatNumber } from '../format';
import { buildLedgerSummary, buildCertificateView, buildCertificateHtml } from '../pages/donationLedgerView';
import { donationIntegrityReducer, initialState } from '../pages/donationIntegrityState';

// A small, read-only "Donation Integrity" panel for one surplus listing: shows the hash-chained ledger's
// event count and verification status, and (once collected) lets the user generate a lightweight Impact
// Certificate. Never blocks or changes the donation itself - purely informational.
export default function DonationIntegrity({ listingId, listingStatus }) {
  const { call } = useAuth();
  const [state, dispatch] = useReducer(donationIntegrityReducer, initialState);

  const loadLedger = async () => {
    dispatch({ type: 'LEDGER_LOADING' });
    try {
      const data = await call(`/donations/${listingId}/ledger`);
      dispatch({ type: 'LEDGER_SUCCESS', data: data.data });
    } catch (err) {
      dispatch({ type: 'LEDGER_ERROR', message: err.message });
    }
  };

  const loadCertificate = async () => {
    dispatch({ type: 'CERTIFICATE_LOADING' });
    try {
      const data = await call(`/donations/${listingId}/certificate`);
      dispatch({ type: 'CERTIFICATE_SUCCESS', data: data.data });
    } catch (err) {
      dispatch({ type: 'CERTIFICATE_ERROR', message: err.message });
    }
  };

  const downloadCertificate = () => {
    const view = buildCertificateView(state.certificate);
    const html = buildCertificateHtml(view);
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `foodshare-certificate-${view.certificateId}.html`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const summary = buildLedgerSummary(state.ledger);
  const certificateView = buildCertificateView(state.certificate);

  return (
    <div style={{ marginTop: 6 }}>
      <strong>Donation Integrity</strong>
      {state.ledgerStatus === 'idle' && (
        <div><button type="button" className="btn btn-outline btn-sm" onClick={loadLedger}>Check Integrity</button></div>
      )}
      {state.ledgerStatus === 'loading' && <p className="muted">Checking ledger…</p>}
      {state.ledgerStatus === 'error' && (
        <div className="alert alert-error" style={{ marginTop: 6 }}>
          {state.ledgerError} <button type="button" className="btn btn-outline btn-sm" onClick={loadLedger} style={{ marginLeft: 8 }}>Retry</button>
        </div>
      )}

      {summary && (
        <div className="grid-2" style={{ marginTop: 6 }}>
          <div className="stat">
            <div className="stat-label">Ledger Events</div>
            <div className="stat-value">{summary.eventCount}</div>
          </div>
          <div className="stat">
            <div className="stat-label">Hash-Chain Status</div>
            <span className={`badge ${summary.verified ? 'badge-success' : 'badge-danger'}`}>
              {summary.verified ? 'Verified' : 'Verification Failed'}
            </span>
            {!summary.verified && summary.reason && <div className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>{summary.reason}</div>}
          </div>
          <div className="stat">
            <div className="stat-label">Latest Event</div>
            <div>{summary.latestEvent ? `${summary.latestEvent.label} (${formatDateTime(summary.latestEvent.timestamp)})` : '—'}</div>
          </div>
          <div className="stat">
            <div className="stat-label">Chain Fingerprint</div>
            <div className="muted" style={{ fontSize: 11.5 }}>{summary.firstHashShort} → {summary.lastHashShort}</div>
          </div>
        </div>
      )}

      {summary && listingStatus === 'Collected' && (
        <div style={{ marginTop: 10 }}>
          {state.certificateStatus === 'idle' && (
            <button type="button" className="btn btn-primary btn-sm" onClick={loadCertificate}>Generate Impact Certificate</button>
          )}
          {state.certificateStatus === 'loading' && <p className="muted">Generating certificate…</p>}
          {state.certificateStatus === 'error' && (
            <div className="alert alert-error" style={{ marginTop: 6 }}>
              {state.certificateError} <button type="button" className="btn btn-outline btn-sm" onClick={loadCertificate} style={{ marginLeft: 8 }}>Retry</button>
            </div>
          )}
          {certificateView && (
            <div className="card" style={{ marginTop: 10, background: '#fafafa' }}>
              <div className="card-header"><h4 style={{ margin: 0 }}>Impact Certificate</h4></div>
              <p><strong>Certificate ID:</strong> {certificateView.certificateId}</p>
              <p><strong>Donor:</strong> {certificateView.donorName} &rarr; <strong>Received by:</strong> {certificateView.receivingName}</p>
              <p><strong>Quantity Collected:</strong> {formatNumber(certificateView.quantityCollected)} kg on {formatDateTime(certificateView.collectedAt)}</p>
              <p>
                <strong>Financial Value:</strong>{' '}
                {certificateView.financialAvailable ? formatInr(certificateView.financialValueInr) : 'Not available (no linked daily log)'}
              </p>
              <p><strong>Estimated CO2e Avoided:</strong> {formatNumber(certificateView.co2eAvoidedKg)} kg &nbsp;|&nbsp; <strong>Meal Equivalents:</strong> {certificateView.mealEquivalents}</p>
              <p><strong>Ledger Verification:</strong> {certificateView.ledgerValid ? 'Valid' : 'Invalid'} ({certificateView.ledgerEventCount} events)</p>
              <button type="button" className="btn btn-outline btn-sm" onClick={downloadCertificate}>Download Certificate</button>
              <p className="muted" style={{ fontSize: 11, marginTop: 10 }}>{certificateView.disclaimer}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
