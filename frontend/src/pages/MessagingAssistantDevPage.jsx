import React, { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';

function newMessageId() {
  return `dev-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
}

// A development/testing console for the FoodShare Conversational Assistant - NOT a WhatsApp clone. It sends
// messages through the same processing path the real webhook would (POST /api/messaging/test/inbound, which
// is refused outright in production), so it is a genuine way to exercise the assistant without needing a
// real WhatsApp/Meta account. Production delivery would be real WhatsApp; this page will not exist there.
export default function MessagingAssistantDevPage() {
  const { call } = useAuth();
  const [providerStatus, setProviderStatus] = useState(null);
  const [identities, setIdentities] = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [newNumber, setNewNumber] = useState('');
  const [text, setText] = useState('');
  const [transcript, setTranscript] = useState([]);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);

  const load = async () => {
    try {
      const [statusRes, data] = await Promise.all([call('/messaging/status'), call('/messaging/identities/me')]);
      setProviderStatus(statusRes.data);
      setIdentities(data.data);
      if (data.data.length > 0 && !selectedId) setSelectedId(data.data[0].externalUserId);
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

  const linkNumber = async (e) => {
    e.preventDefault();
    setError('');
    setMessage('');
    try {
      await call('/messaging/identities', {
        method: 'POST',
        body: { provider: 'mock', channel: 'whatsapp', externalUserId: newNumber },
      });
      setMessage(`Linked ${newNumber} to your FoodShare account.`);
      setNewNumber('');
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const sendMessage = async (e) => {
    e.preventDefault();
    if (!selectedId || !text.trim()) return;
    setError('');
    const outgoing = { role: 'user', text };
    setTranscript((t) => [...t, outgoing]);
    const sentText = text;
    setText('');
    setSending(true);
    try {
      const data = await call('/messaging/test/inbound', {
        method: 'POST',
        body: {
          provider: 'mock',
          channel: 'whatsapp',
          sender: { externalId: selectedId },
          message: { id: newMessageId(), text: sentText },
          timestamp: new Date().toISOString(),
        },
      });
      const reply = data.data.duplicate ? '(duplicate message ignored)' : data.data.reply;
      setTranscript((t) => [...t, { role: 'bot', text: reply }]);
    } catch (err) {
      setError(err.message);
      setTranscript((t) => [...t, { role: 'bot', text: `[error] ${err.message}` }]);
    } finally {
      setSending(false);
    }
  };

  return (
    <div>
      <h1>WhatsApp Assistant — Development Simulator</h1>
      <p className="muted">
        Provider: Demo / Mock. This simulates the FoodShare Conversational Assistant without a real WhatsApp
        account, using the same processing path a real provider's webhook would use. It is a development/testing
        tool only and is disabled outside development.
        {providerStatus && (
          <> {' '}Server-configured provider: <strong>{providerStatus.provider === 'meta' ? 'Meta WhatsApp Cloud API' : 'Demo / Mock'}</strong> ({providerStatus.enabled ? 'enabled' : 'disabled'}). This simulator always uses the mock provider regardless.</>
        )}
      </p>

      {error && <div className="alert alert-error">{error}</div>}
      {message && <div className="alert alert-success">{message}</div>}

      <div className="card">
        <div className="card-header"><h2>Link a Test WhatsApp Number</h2></div>
        <form onSubmit={linkNumber} className="form-row" style={{ alignItems: 'end' }}>
          <div className="field">
            <label>Test Number / Contact ID</label>
            <input required value={newNumber} onChange={(e) => setNewNumber(e.target.value)} placeholder="+911234500000" />
          </div>
          <div className="field" style={{ flex: '0 0 auto' }}>
            <button className="btn btn-primary">Link to My Account</button>
          </div>
        </form>
      </div>

      <div className="card">
        <div className="card-header"><h2>Sender Identity</h2></div>
        {loading ? (
          <p className="muted">Loading…</p>
        ) : identities.length === 0 ? (
          <p className="muted">No linked numbers yet. Link one above to start testing.</p>
        ) : (
          <div className="field">
            <label>Send as</label>
            <select value={selectedId} onChange={(e) => setSelectedId(e.target.value)}>
              {identities.map((id) => (
                <option key={id.id} value={id.externalUserId}>{id.externalUserId}</option>
              ))}
            </select>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-header"><h2>Conversation</h2></div>
        {transcript.length === 0 ? (
          <p className="muted">Try: "We have 4 boxes of rice meals left, good for 2 hours"</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
            {transcript.map((entry, i) => (
              entry.role === 'user' ? (
                <div key={i} style={{ whiteSpace: 'pre-wrap' }}><strong>You:</strong> {entry.text}</div>
              ) : (
                <div key={i} className="alert alert-success" style={{ whiteSpace: 'pre-wrap' }}>
                  <strong>Assistant:</strong> {entry.text}
                </div>
              )
            ))}
          </div>
        )}
        <form onSubmit={sendMessage} className="form-row" style={{ alignItems: 'end' }}>
          <div className="field" style={{ flex: 1 }}>
            <label>Message</label>
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="We have 4 boxes of rice meals left, good for 2 hours"
              disabled={identities.length === 0}
            />
          </div>
          <div className="field" style={{ flex: '0 0 auto' }}>
            <button className="btn btn-primary" disabled={identities.length === 0 || sending}>
              {sending ? 'Sending…' : 'Send'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
