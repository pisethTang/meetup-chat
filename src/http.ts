export const enc = encodeURIComponent;

/** Fetch JSON, giving up after `ms` milliseconds. */
export async function getJSON<T = any>(url: string, ms = 10000): Promise<T> {
  const c = new AbortController(), t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(url, { signal: c.signal });
    if (!r.ok) throw new Error(String(r.status));
    return await r.json();
  } finally { clearTimeout(t); }
}
