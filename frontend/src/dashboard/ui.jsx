import React from 'react';
import { STAGES } from './stages';

// Building blocks for the dashboard. They only lay out and label what the pages pass in.


export function Skeleton({ lines = 3 }) {
  return (
    <div className="dash-skeleton" role="status" aria-label="Loading">
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} style={{ width: `${92 - i * 18}%` }} />
      ))}
    </div>
  );
}

export function EmptyState({ title, children, actionLabel, onAction, tone = 'neutral' }) {
  return (
    <div className={`dash-empty dash-empty-${tone}`}>
      <strong>{title}</strong>
      {children && <p>{children}</p>}
      {actionLabel && onAction && (
        <button type="button" className="btn btn-outline btn-sm" onClick={onAction}>{actionLabel}</button>
      )}
    </div>
  );
}

// The PREDICT -> EXPLAIN -> PREVENT -> RESCUE -> LEARN story, as a row that scrolls to each section.
// `dimmed` lists stages that this role does not run itself (shown, but muted, so the whole loop stays visible).
export function StageStrip({ dimmed = [] }) {
  const jump = (key) => {
    const el = document.getElementById(`stage-${key}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  return (
    <ol className="dash-flow" aria-label="Platform flow">
      {STAGES.map((stage, i) => (
        <li key={stage.key} className={dimmed.includes(stage.key) ? 'is-dimmed' : ''}>
          <button type="button" onClick={() => jump(stage.key)}>
            <span className="dash-flow-num">{i + 1}</span>
            <span className="dash-flow-text">
              <strong>{stage.label}</strong>
              <small>{stage.blurb}</small>
            </span>
          </button>
        </li>
      ))}
    </ol>
  );
}

export function Stage({ stageKey, title, tagline, action, children }) {
  const index = STAGES.findIndex((s) => s.key === stageKey) + 1;
  return (
    <section id={`stage-${stageKey}`} className={`dash-stage stage-${stageKey}`}>
      <header className="dash-stage-head">
        <span className="dash-stage-num">{index}</span>
        <div className="dash-stage-title">
          <h2>{title}</h2>
          <p className="muted">{tagline}</p>
        </div>
        {action}
      </header>
      <div className="dash-grid">{children}</div>
    </section>
  );
}

// One dashboard card. `resource` is a useResource()/combine() result: the card shows a skeleton while loading, the
// error with a Retry button if it failed, `empty` when `isEmpty(data)` is true, and otherwise `children(data)`.
export function MetricCard({ title, hint, resource, isEmpty, empty, action, wide = false, children }) {
  let body;
  if (resource.status === 'loading') {
    body = <Skeleton />;
  } else if (resource.status === 'error') {
    body = (
      <div className="dash-error" role="alert">
        <span>Could not load this: {resource.error}</span>
        <button type="button" className="btn btn-outline btn-sm" onClick={resource.reload}>Retry</button>
      </div>
    );
  } else if (isEmpty && isEmpty(resource.data)) {
    body = empty;
  } else {
    body = children(resource.data);
  }
  return (
    <article className={`dash-card${wide ? ' dash-wide' : ''}`}>
      <header className="dash-card-head">
        <h3>{title}</h3>
        {action}
      </header>
      {hint && <p className="dash-hint">{hint}</p>}
      {body}
    </article>
  );
}

export function Kpi({ value, unit, caption }) {
  return (
    <div className="dash-kpi">
      <span className="dash-kpi-value">{value}</span>
      {unit && <span className="dash-kpi-unit">{unit}</span>}
      {caption && <div className="dash-kpi-caption">{caption}</div>}
    </div>
  );
}

export function LinkButton({ onClick, children }) {
  if (!onClick) return null;
  return (
    <button type="button" className="dash-link" onClick={onClick}>{children} →</button>
  );
}
