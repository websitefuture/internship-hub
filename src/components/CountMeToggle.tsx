"use client";

import { useSyncExternalStore } from "react";
import { DONT_COUNT_KEY } from "@/components/ViewTracker";

// Lets the site owner stop counting their own visits on this device. Stored in this browser
// only, so it has to be switched on once per device (phone, laptop, each browser).

const listeners = new Set<() => void>();
function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
function read(): boolean {
  try {
    return localStorage.getItem(DONT_COUNT_KEY) === "1";
  } catch {
    return false;
  }
}

export default function CountMeToggle() {
  // null on the server, where there is no browser storage to read.
  const ignored = useSyncExternalStore<boolean | null>(subscribe, read, () => null);
  if (ignored === null) return null;

  const toggle = () => {
    try {
      if (ignored) localStorage.removeItem(DONT_COUNT_KEY);
      else localStorage.setItem(DONT_COUNT_KEY, "1");
    } catch {
      // storage blocked; nothing to change
    }
    listeners.forEach((l) => l());
  };

  return (
    <p className="st-note">
      {ignored ? "Your visits on this device are not counted. " : "Your visits on this device are counted. "}
      <button type="button" className="st-link" onClick={toggle}>
        {ignored ? "Count them again" : "Don't count my visits on this device"}
      </button>
    </p>
  );
}
