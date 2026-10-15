"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { DEVICE_KEY, DONT_COUNT_KEY } from "@/components/ViewTracker";

// "Your own visits" on /admin/stats: lists every visitor in the chosen range so the owner can
// take their own visits out of the graph and every number, one visitor at a time or everything
// this browser ever sent at once. Deleting is permanent; the numbers reload right after.

export type VisitorRow = {
  id: string;
  views: number;
  device: string;
  country: string;
  source: string;
  when: string;
  pages: string[];
};

const listeners = new Set<() => void>();
const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};
function readIgnored(): boolean {
  try {
    return localStorage.getItem(DONT_COUNT_KEY) === "1";
  } catch {
    return false;
  }
}
function readDevice(): string | null {
  try {
    return localStorage.getItem(DEVICE_KEY);
  } catch {
    return null;
  }
}

async function call(body: object): Promise<{ ids?: string[]; removed?: number; error?: string }> {
  const res = await fetch("/api/admin/visits", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as { ids?: string[]; removed?: number; error?: string };
  if (!res.ok) throw new Error(json.error ?? `status ${res.status}`);
  return json;
}

const SHOW = 25;

export default function OwnVisits({ rows, rangeLabel }: { rows: VisitorRow[]; rangeLabel: string }) {
  const router = useRouter();
  const ignored = useSyncExternalStore<boolean | null>(subscribe, readIgnored, () => null);
  const [mine, setMine] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [all, setAll] = useState(false);

  // Ask the server which listed visitors are this browser, to tag them.
  useEffect(() => {
    call({ action: "mine", device: readDevice() })
      .then((r) => setMine(new Set(r.ids ?? [])))
      .catch(() => {});
  }, []);

  const setIgnored = (on: boolean) => {
    try {
      if (on) localStorage.setItem(DONT_COUNT_KEY, "1");
      else localStorage.removeItem(DONT_COUNT_KEY);
    } catch {
      // storage blocked; the signed-in check on the server still skips the owner
    }
    listeners.forEach((l) => l());
  };

  const views = (n: number) => `${n} page view${n === 1 ? "" : "s"}`;

  const removeMine = async () => {
    setBusy("all");
    setMessage("");
    try {
      setIgnored(true);
      const r = await call({ action: "remove-mine", device: readDevice() });
      const n = r.removed ?? 0;
      setMessage(
        n
          ? `Removed ${views(n)} made from this browser. The graph and numbers above are updated.`
          : "Nothing from this browser is left to remove. Any of your visits still in the list came from another device or network: press \"This was me\" on those.",
      );
      setMine(new Set());
      router.refresh();
    } catch (e) {
      setMessage(`Couldn't remove them: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const removeOne = async (row: VisitorRow) => {
    setBusy(row.id);
    setMessage("");
    try {
      const r = await call({ action: "remove", visitor: row.id });
      setMessage(`Removed ${views(r.removed ?? 0)} (${row.device}, ${row.country}). The graph and numbers above are updated.`);
      router.refresh();
    } catch (e) {
      setMessage(`Couldn't remove it: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  // This browser's visitors first, then the rest as given (most page views first).
  const sorted = [...rows].sort((a, b) => Number(mine.has(b.id)) - Number(mine.has(a.id)));
  const shown = all ? sorted : sorted.slice(0, SHOW);

  return (
    <section className="st-card st-own">
      <div className="st-own-head">
        <div>
          <h2>Your own visits</h2>
          <p className="st-note">
            Take your visits out of the graph and every number on this page. While you are signed in here, new visits
            from you are not counted on any device.
          </p>
        </div>
        <button type="button" className="st-btn" onClick={removeMine} disabled={busy !== null}>
          {busy === "all" ? "Removing..." : "Remove all my visits from this browser"}
        </button>
      </div>
      {message && <p className="st-msg" role="status">{message}</p>}

      <h3 className="st-own-sub">
        Everyone who visited, {rangeLabel.toLowerCase()} ({rows.length})
      </h3>
      {rows.length === 0 ? (
        <p className="st-empty">No visits counted in this period.</p>
      ) : (
        <ul className="st-visitors">
          {shown.map((r) => (
            <li key={r.id} className={mine.has(r.id) ? "st-me" : ""}>
              <div className="st-vinfo">
                <div className="st-vline">
                  <strong>{r.device}</strong> · {r.country} · {r.source}
                  {mine.has(r.id) && <span className="st-tag">This browser</span>}
                </div>
                <div className="st-note">
                  {views(r.views)} · {r.when} · {r.pages.join(", ")}
                </div>
              </div>
              <button type="button" className="st-btn st-btn-quiet" onClick={() => removeOne(r)} disabled={busy !== null}>
                {busy === r.id ? "Removing..." : "This was me"}
              </button>
            </li>
          ))}
        </ul>
      )}
      {!all && rows.length > SHOW && (
        <button type="button" className="st-link st-more" onClick={() => setAll(true)}>
          Show all {rows.length}
        </button>
      )}

      {ignored !== null && (
        <p className="st-note st-own-foot">
          {ignored
            ? "This browser is never counted, even when you are signed out. "
            : "This browser is counted when you are signed out. "}
          <button type="button" className="st-link" onClick={() => setIgnored(!ignored)}>
            {ignored ? "Count it again when signed out" : "Never count this browser"}
          </button>
        </p>
      )}
    </section>
  );
}
