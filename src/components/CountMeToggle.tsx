"use client";

import { useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { DEVICE_KEY, DONT_COUNT_KEY } from "@/components/ViewTracker";

// Lets the site owner stop counting their own visits on this device, and removes this device's
// past visits from the stats when switched on. Stored in this browser only, so it has to be
// switched on once per device (phone, laptop, each browser).

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
  const router = useRouter();
  // null on the server, where there is no browser storage to read.
  const ignored = useSyncExternalStore<boolean | null>(subscribe, read, () => null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  if (ignored === null) return null;

  const stopCounting = async () => {
    setBusy(true);
    try {
      localStorage.setItem(DONT_COUNT_KEY, "1");
      listeners.forEach((l) => l());
      await forget();
    } catch {
      setMessage("Couldn't save the setting in this browser.");
    } finally {
      setBusy(false);
    }
  };

  // Deletes this device's past views from the stats, then reloads the numbers.
  const forgetPast = async () => {
    setBusy(true);
    try {
      await forget();
    } finally {
      setBusy(false);
    }
  };

  const forget = async () => {
    try {
      const device = localStorage.getItem(DEVICE_KEY);
      if (!device) {
        setMessage("Done. This device had no counted visits to remove.");
      } else {
        const res = await fetch("/api/admin/forget-device", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ device }),
        });
        const body = (await res.json().catch(() => ({}))) as { removed?: number; error?: string };
        if (!res.ok) {
          setMessage(`Future visits won't count, but past ones couldn't be removed: ${body.error ?? res.status}`);
        } else {
          const n = body.removed ?? 0;
          setMessage(n ? `Done. Removed ${n} past visit${n === 1 ? "" : "s"} from this device, and new ones won't count.` : "Done. New visits from this device won't count.");
        }
      }
      router.refresh(); // reload the numbers above without a full page reload
    } catch {
      setMessage("Couldn't reach the site to remove past visits. Try again.");
    }
  };

  const countAgain = () => {
    try {
      localStorage.removeItem(DONT_COUNT_KEY);
    } catch {
      // storage blocked; nothing to change
    }
    listeners.forEach((l) => l());
    setMessage("Visits from this device will be counted again.");
  };

  return (
    <div className="st-countme">
      <p className="st-note">
        {ignored ? "Your visits on this device are not counted. " : "Your visits on this device are counted. "}
        <button type="button" className="st-link" onClick={ignored ? countAgain : stopCounting} disabled={busy}>
          {busy ? "Working..." : ignored ? "Count them again" : "Don't count my visits on this device"}
        </button>
        {ignored && !busy && (
          <>
            {" · "}
            <button type="button" className="st-link" onClick={forgetPast}>
              Remove this device&apos;s past visits
            </button>
          </>
        )}
      </p>
      {message && <p className="st-note st-msg" role="status">{message}</p>}
    </div>
  );
}
