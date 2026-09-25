import { useCallback, useEffect, useState } from 'react';

// Loads one piece of dashboard data and reports its own state, so a card can show a skeleton while it loads and an
// error with a Retry button if it fails, without any other card being affected.
//
//   status: 'loading' | 'ready' | 'error'
//   data:   whatever `loader` resolved with (null until ready)
//
// `enabled: false` keeps the resource in 'loading' without calling the loader (for data that depends on another
// resource). `deps` re-runs the loader when they change.
export function useResource(loader, deps = [], { enabled = true } = {}) {
  const [state, setState] = useState({ status: 'loading', data: null, error: '' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!enabled) return undefined;
    let active = true;
    Promise.resolve()
      .then(loader)
      .then((data) => {
        if (active) setState({ status: 'ready', data, error: '' });
      })
      .catch((err) => {
        if (active) setState({ status: 'error', data: null, error: (err && err.message) || 'Something went wrong' });
      });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, attempt, ...deps]);

  const reload = useCallback(() => {
    setState({ status: 'loading', data: null, error: '' });
    setAttempt((n) => n + 1);
  }, []);

  return { ...state, reload };
}

// Combines several resources into one for a card that needs all of them: it is loading while any is loading, failed
// if any failed (Retry reloads the failed ones), and otherwise ready with `derive(...allData)`.
export function combine(resources, derive) {
  const failed = resources.find((r) => r.status === 'error');
  const reload = () => resources.forEach((r) => (r.status === 'error' ? r.reload() : null));
  if (failed) return { status: 'error', data: null, error: failed.error, reload };
  if (resources.some((r) => r.status === 'loading')) return { status: 'loading', data: null, error: '', reload };
  return { status: 'ready', data: derive(...resources.map((r) => r.data)), error: '', reload };
}
