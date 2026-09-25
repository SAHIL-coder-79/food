export const API_BASE = 'http://localhost:5000/api';

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export async function apiFetch(path, { method = 'GET', body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const isJson = res.headers.get('content-type')?.includes('application/json');
  const data = isJson ? await res.json().catch(() => null) : null;

  if (!res.ok) {
    // Validation failures carry the specific reason per field: show it instead of a bare "Validation failed".
    const detail = Array.isArray(data?.details) && typeof data.details[0]?.message === 'string' ? data.details[0].message : null;
    const message =
      detail ||
      data?.message ||
      data?.error ||
      (Array.isArray(data?.errors) && data.errors[0]?.msg) ||
      `Request failed (${res.status})`;
    throw new ApiError(message, res.status);
  }

  return data;
}
