import React, { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { formatDateTime, formatNumber } from '../format';
import FoodQualityCheck from '../components/FoodQualityCheck';
import DonationIntegrity from '../components/DonationIntegrity';
import RescueRouteBuilder from '../components/RescueRouteBuilder';

const STATUS_BADGE = {
  Available: 'badge-info',
  Claimed: 'badge-warning',
  Collected: 'badge-success',
  Expired: 'badge-neutral',
};

// A <input type="datetime-local"> value is interpreted as LOCAL time by the browser, but toISOString()
// returns UTC - mixing the two silently shifts the default by the local UTC offset (e.g. in IST, UTC+5:30,
// "4 hours from now" was landing about 1.5 hours in the PAST once re-parsed, causing a spurious "must be in
// the future" validation error). Building the string from local date/time components instead keeps the
// pre-filled value an honest "h hours from now" in whatever timezone the browser is actually running in.
function inHours(h) {
  const d = new Date(Date.now() + h * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function KitchenSurplus() {
  const { call } = useAuth();
  const [logs, setLogs] = useState([]);
  const [listings, setListings] = useState([]);
  const [form, setForm] = useState({ dailyLogId: '', quantity: '', foodType: '', safeUntilTime: inHours(4) });
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [matches, setMatches] = useState(null);
  const [matchesFor, setMatchesFor] = useState(null);
  const [integrityFor, setIntegrityFor] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    try {
      const [logsData, listingsData] = await Promise.all([call('/daily-logs'), call('/surplus-listings')]);
      setLogs(logsData.logs.filter((l) => Number(l.quantity_leftover || 0) > 0));
      setListings(listingsData.listings);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setMessage('');
    try {
      await call('/surplus-listings', {
        method: 'POST',
        body: {
          dailyLogId: form.dailyLogId ? parseInt(form.dailyLogId, 10) : undefined,
          quantity: parseFloat(form.quantity),
          foodType: form.foodType,
          safeUntilTime: new Date(form.safeUntilTime).toISOString(),
        },
      });
      setMessage('Surplus listed. Nearby verified NGOs have been notified.');
      setForm({ dailyLogId: '', quantity: '', foodType: '', safeUntilTime: inHours(4) });
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const confirmPickup = async (id) => {
    setError('');
    setMessage('');
    try {
      await call(`/surplus-listings/${id}/confirm-pickup`, {
        method: 'PATCH',
        body: { confirmedPickupTime: new Date(Date.now() + 3600 * 1000).toISOString() },
      });
      setMessage(`Pickup confirmed for listing #${id}. The NGO has been notified.`);
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const collect = async (id, quantity) => {
    setError('');
    setMessage('');
    try {
      await call(`/surplus-listings/${id}/collect`, { method: 'PATCH', body: { quantityCollected: quantity } });
      setMessage(`Listing #${id} marked collected.`);
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const viewMatches = async (id) => {
    setError('');
    setMatches(null);
    setMatchesFor(id);
    try {
      const data = await call(`/surplus-listings/${id}/ngo-matches`);
      setMatches(data.matches);
    } catch (err) {
      setError(err.message);
    }
  };

  const notifyMatchedNgos = async (id) => {
    setError('');
    setMessage('');
    try {
      const data = await call(`/communications/rescue/${id}/notify`, { method: 'POST' });
      const providerLabel = data.data.provider === 'mock' ? 'Demo / Mock' : data.data.provider;
      if (data.data.recipientCount === 0) {
        setMessage(`No well-matched NGOs to notify right now for listing #${id}.`);
      } else {
        setMessage(`Notification sent for listing #${id}. Provider: ${providerLabel}. Recipients: ${data.data.recipientCount}.`);
      }
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div>
      <div className="card">
        <div className="card-header"><h2>List Surplus Food</h2></div>
        {error && <div className="alert alert-error">{error}</div>}
        {message && <div className="alert alert-success">{message}</div>}
        <form onSubmit={submit} className="form-row" style={{ alignItems: 'end' }}>
          <div className="field">
            <label>Linked Daily Log (optional)</label>
            <select value={form.dailyLogId} onChange={(e) => setForm({ ...form, dailyLogId: e.target.value })}>
              <option value="">— none —</option>
              {logs.map((l) => (
                <option key={l.id} value={l.id}>#{l.id} {l.menu_item_name} ({l.quantity_leftover} leftover)</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Food Type</label>
            <input required value={form.foodType} onChange={(e) => setForm({ ...form, foodType: e.target.value })} placeholder="Rice, Curry…" />
          </div>
          <div className="field">
            <label>Quantity (kg)</label>
            <input type="number" required min="0.1" step="0.1" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} />
          </div>
          <div className="field">
            <label>Safe Until</label>
            <input type="datetime-local" required value={form.safeUntilTime} onChange={(e) => setForm({ ...form, safeUntilTime: e.target.value })} />
          </div>
          <div className="field" style={{ flex: '0 0 auto' }}>
            <button className="btn btn-primary">Publish Listing</button>
          </div>
        </form>
      </div>

      <FoodQualityCheck
        dailyLogOptions={logs.map((l) => ({ id: l.id, label: `#${l.id} ${l.menu_item_name} (${l.quantity_leftover} leftover)` }))}
      />

      <div className="card">
        <div className="card-header"><h2>My Listings ({listings.length})</h2></div>
        {loading ? (
          <p className="muted">Loading…</p>
        ) : listings.length === 0 ? (
          <p className="muted">No listings yet.</p>
        ) : (
          <table>
            <thead><tr><th>ID</th><th>Food</th><th>Qty</th><th>Safe Until</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
              {listings.map((l) => (
                <React.Fragment key={l.id}>
                  <tr>
                    <td>#{l.id}</td>
                    <td>{l.food_type}</td>
                    <td>{formatNumber(l.quantity)} kg</td>
                    <td>{formatDateTime(l.safe_until_time)}</td>
                    <td><span className={`badge ${STATUS_BADGE[l.status] || 'badge-neutral'}`}>{l.status}</span></td>
                    <td style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {l.status === 'Available' && (
                        <button className="btn btn-outline btn-sm" onClick={() => viewMatches(l.id)}>NGO Matches</button>
                      )}
                      {l.status === 'Available' && (
                        <button className="btn btn-outline btn-sm" onClick={() => notifyMatchedNgos(l.id)}>Notify Matched NGOs</button>
                      )}
                      {l.status === 'Claimed' && !l.confirmed_pickup_time && (
                        <button className="btn btn-outline btn-sm" onClick={() => confirmPickup(l.id)}>Confirm Pickup</button>
                      )}
                      {l.status === 'Claimed' && (
                        <button className="btn btn-success btn-sm" onClick={() => collect(l.id, l.quantity)}>Mark Collected</button>
                      )}
                      <button className="btn btn-outline btn-sm" onClick={() => setIntegrityFor(integrityFor === l.id ? null : l.id)}>
                        {integrityFor === l.id ? 'Hide Integrity' : 'Donation Integrity'}
                      </button>
                    </td>
                  </tr>
                  {integrityFor === l.id && (
                    <tr>
                      <td colSpan={6}>
                        <DonationIntegrity listingId={l.id} listingStatus={l.status} />
                      </td>
                    </tr>
                  )}
                  {matchesFor === l.id && matches && (
                    <tr>
                      <td colSpan={6}>
                        <strong>Ranked NGO Matches</strong>
                        {matches.length === 0 ? (
                          <p className="muted">No eligible verified NGOs in range yet.</p>
                        ) : (
                          <table>
                            <thead><tr><th>NGO</th><th>Score</th><th>Level</th><th>Distance</th><th>Why</th></tr></thead>
                            <tbody>
                              {matches.map((m) => (
                                <tr key={m.ngoOrgId}>
                                  <td>{m.ngoName}</td>
                                  <td>{m.matchScore != null ? formatNumber(m.matchScore) : '—'}</td>
                                  <td><span className="badge badge-info">{m.matchLevel}</span></td>
                                  <td>{m.distanceKm != null ? `${formatNumber(m.distanceKm)} km` : '—'}</td>
                                  <td className="muted">{m.reason}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function NgoSurplus() {
  const { call } = useAuth();
  const [feed, setFeed] = useState([]);
  const [claimed, setClaimed] = useState([]);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [pickupTimes, setPickupTimes] = useState({});
  const [integrityFor, setIntegrityFor] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setError('');
    try {
      const data = await call('/surplus-listings/feed');
      setFeed(data.listings);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const claim = async (id) => {
    setError('');
    setMessage('');
    try {
      const proposedPickupTime = pickupTimes[id] || inHours(1);
      const data = await call(`/surplus-listings/${id}/claim`, {
        method: 'POST',
        body: { proposedPickupTime: new Date(proposedPickupTime).toISOString() },
      });
      setClaimed((c) => [data.listing, ...c.filter((x) => x.id !== data.listing.id)]);
      setMessage(`Claimed listing #${id}. Coordinate pickup with the kitchen, then mark it collected below once received.`);
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const collect = async (id, quantity) => {
    setError('');
    setMessage('');
    try {
      await call(`/surplus-listings/${id}/collect`, { method: 'PATCH', body: { quantityCollected: quantity } });
      setClaimed((c) => c.map((x) => (x.id === id ? { ...x, status: 'Collected' } : x)));
      setMessage(`Listing #${id} marked collected. Thank you for completing the rescue.`);
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div>
      {error && <div className="alert alert-error">{error}</div>}
      {message && <div className="alert alert-success">{message}</div>}

      <div className="card">
        <div className="card-header"><h2>Available Surplus Feed ({feed.length})</h2></div>
        {loading ? (
          <p className="muted">Loading…</p>
        ) : feed.length === 0 ? (
          <p className="muted">No surplus available right now — check back soon, or your organization may still be pending verification.</p>
        ) : (
          <table>
            <thead><tr><th>Kitchen</th><th>Food</th><th>Qty</th><th>Distance</th><th>Safe Until</th><th>Pickup Time</th><th></th></tr></thead>
            <tbody>
              {feed.map((l) => (
                <tr key={l.id}>
                  <td>{l.kitchen_name}</td>
                  <td>{l.food_type}</td>
                  <td>{formatNumber(l.quantity)} kg</td>
                  <td>{l.distance_km != null ? `${formatNumber(l.distance_km)} km` : '—'}</td>
                  <td>{formatDateTime(l.safe_until_time)}</td>
                  <td>
                    <input
                      type="datetime-local"
                      value={pickupTimes[l.id] || inHours(1)}
                      onChange={(e) => setPickupTimes({ ...pickupTimes, [l.id]: e.target.value })}
                    />
                  </td>
                  <td><button className="btn btn-primary btn-sm" onClick={() => claim(l.id)}>Claim</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <div className="card-header"><h2>Claimed This Session</h2></div>
        {claimed.length === 0 ? (
          <p className="muted">Listings you claim will appear here so you can mark them collected once picked up.</p>
        ) : (
          <table>
            <thead><tr><th>ID</th><th>Food</th><th>Qty</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {claimed.map((l) => (
                <React.Fragment key={l.id}>
                  <tr>
                    <td>#{l.id}</td>
                    <td>{l.food_type}</td>
                    <td>{formatNumber(l.quantity)} kg</td>
                    <td><span className={`badge ${STATUS_BADGE[l.status] || 'badge-neutral'}`}>{l.status}</span></td>
                    <td style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {l.status === 'Claimed' && (
                        <button className="btn btn-success btn-sm" onClick={() => collect(l.id, l.quantity)}>Mark Collected</button>
                      )}
                      <button className="btn btn-outline btn-sm" onClick={() => setIntegrityFor(integrityFor === l.id ? null : l.id)}>
                        {integrityFor === l.id ? 'Hide Integrity' : 'Donation Integrity'}
                      </button>
                    </td>
                  </tr>
                  {integrityFor === l.id && (
                    <tr>
                      <td colSpan={5}>
                        <DonationIntegrity listingId={l.id} listingStatus={l.status} />
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <RescueRouteBuilder eligibleListings={claimed} />
    </div>
  );
}

export default function SurplusPage() {
  const { user } = useAuth();
  const isNgo = user?.role === 'NGO_COORDINATOR' || user?.role === 'NGO_ADMIN';

  return (
    <div>
      <h1>Surplus &amp; Redistribution</h1>
      <p className="muted">
        {isNgo
          ? 'Browse surplus currently available from verified kitchens in your service area, claim it, and confirm collection.'
          : 'Publish leftover food as a surplus listing so nearby verified NGOs can be matched and claim it.'}
      </p>
      {isNgo ? <NgoSurplus /> : <KitchenSurplus />}
    </div>
  );
}
