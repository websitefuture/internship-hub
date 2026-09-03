// Browser-only persistence for the user's profile and answers. Nothing is sent anywhere;
// this mirrors the prototype's "saved in your browser only" promise.
const PREFIX = "radius:";

export function save<T>(key: string, value: T): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // storage unavailable (private mode, quota) — fail silently like the prototype did
  }
}

export function load<T>(key: string): T | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
