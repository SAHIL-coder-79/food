import React, { useReducer, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { validateFile, buildResultView } from '../pages/foodQualityView';
import { foodQualityReducer, initialState } from '../pages/foodQualityState';

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      // reader.result looks like "data:image/jpeg;base64,AAAA…" - the API only wants the payload after the comma.
      const commaIndex = String(reader.result).indexOf(',');
      resolve(commaIndex >= 0 ? reader.result.slice(commaIndex + 1) : reader.result);
    };
    reader.onerror = () => reject(new Error('Could not read the selected file.'));
    reader.readAsDataURL(file);
  });
}

// A small, optional decision-support screening tied to the surplus workflow: a kitchen user can check a photo of
// a leftover/surplus item before deciding what to do with it. It never blocks or approves anything by itself.
export default function FoodQualityCheck({ dailyLogOptions = [] }) {
  const { call } = useAuth();
  const [state, dispatch] = useReducer(foodQualityReducer, initialState);
  const [file, setFile] = useState(null);
  const [dailyLogId, setDailyLogId] = useState('');
  const [inputKey, setInputKey] = useState(0);

  const handleFileChange = (e) => {
    const chosen = e.target.files && e.target.files[0];
    const validation = validateFile(chosen);
    if (!validation.ok) {
      setFile(null);
      dispatch({ type: 'FILE_INVALID', message: validation.message });
      return;
    }
    setFile(chosen);
    dispatch({ type: 'FILE_VALID', fileName: chosen.name });
  };

  const reset = () => {
    setFile(null);
    setDailyLogId('');
    setInputKey((k) => k + 1);
    dispatch({ type: 'CLEAR' });
  };

  const submit = async () => {
    if (!file) return;
    dispatch({ type: 'SUBMIT_START' });
    try {
      const imageBase64 = await readFileAsBase64(file);
      const data = await call('/food-quality/check', {
        method: 'POST',
        body: {
          imageBase64,
          mimeType: file.type,
          dailyLogId: dailyLogId ? parseInt(dailyLogId, 10) : undefined,
        },
      });
      dispatch({ type: 'SUBMIT_SUCCESS', data: data.data });
    } catch (err) {
      dispatch({ type: 'SUBMIT_ERROR', message: err.message });
    }
  };

  const view = buildResultView(state.result);
  const loading = state.submitStatus === 'loading';

  return (
    <div className="card">
      <div className="card-header"><h2>Food Quality Check</h2></div>
      <p className="muted">
        Optional visual screening aid: check a photo of a leftover or surplus item for a quick second opinion before
        you decide what to do with it. This is not a food-safety certification and never automatically approves or
        rejects anything on your behalf.
      </p>

      <div className="form-row" style={{ alignItems: 'end' }}>
        <div className="field">
          <label>Photo (JPEG, PNG or WEBP)</label>
          <input key={inputKey} type="file" accept="image/jpeg,image/png,image/webp" onChange={handleFileChange} />
        </div>
        {dailyLogOptions.length > 0 && (
          <div className="field">
            <label>Related Daily Log (optional)</label>
            <select value={dailyLogId} onChange={(e) => setDailyLogId(e.target.value)}>
              <option value="">— none —</option>
              {dailyLogOptions.map((opt) => (
                <option key={opt.id} value={opt.id}>{opt.label}</option>
              ))}
            </select>
          </div>
        )}
        <div className="field" style={{ flex: '0 0 auto' }}>
          <button type="button" className="btn btn-primary" disabled={!state.hasValidFile || loading} onClick={submit}>
            {loading ? 'Analyzing…' : 'Screen Image'}
          </button>
        </div>
        {(state.hasValidFile || state.submitStatus !== 'idle') && (
          <div className="field" style={{ flex: '0 0 auto' }}>
            <button type="button" className="btn btn-outline" onClick={reset}>Reset</button>
          </div>
        )}
      </div>

      {state.fileError && <div className="alert alert-error" style={{ marginTop: 12 }}>{state.fileError}</div>}
      {loading && <p className="muted" style={{ marginTop: 12 }}>Analyzing image…</p>}
      {state.submitStatus === 'error' && (
        <div className="alert alert-error" style={{ marginTop: 12 }}>
          {state.error} <button type="button" className="btn btn-outline btn-sm" onClick={submit} style={{ marginLeft: 8 }}>Retry</button>
        </div>
      )}

      {view && (
        <div style={{ marginTop: 16 }}>
          <div className="card-header">
            <h3 style={{ margin: 0 }}>Result</h3>
            <span className={`badge ${view.badgeClass}`}>{view.classificationLabel}</span>
          </div>

          {view.isUnknown ? (
            <p className="muted">
              The system could not confidently assess this image. Please rely on manual inspection instead.
            </p>
          ) : (
            <div className="grid-2">
              <div className="stat">
                <div className="stat-label">Confidence</div>
                <div className="stat-value">{view.confidencePercent != null ? `${view.confidencePercent}%` : '—'}</div>
              </div>
              <div className="stat">
                <div className="stat-label">Visual Signals</div>
                <div>{view.signals.length > 0 ? view.signals.join(', ') : '—'}</div>
              </div>
            </div>
          )}

          {view.recommendation && <p style={{ marginTop: 10 }}><strong>Suggestion:</strong> {view.recommendation}</p>}

          {view.context && (
            <p className="muted" style={{ fontSize: 12.5 }}>
              Linked to daily log #{view.context.dailyLogId} ({view.context.menuItemName}, {view.context.logDate}).
            </p>
          )}

          <p className="muted" style={{ fontSize: 11.5, marginTop: 10 }}>{view.disclaimer}</p>
        </div>
      )}
    </div>
  );
}
