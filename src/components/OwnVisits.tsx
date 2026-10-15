"use client";

import { useEffect, useState } from "react";
import { DEVICE_KEY, DONT_COUNT_KEY } from "@/components/ViewTracker";

// The visitor list on /admin/stats. Opening the page on a device marks that device as the
// owner's: it is never counted again, and everything it was counted for before is deleted on the
// spot. Any other visitor (a robot, say) can be removed with its own Remove button.
//
// After a deletion the page reloads in full so the graph and totals show the new numbers.
// (Next.js's in-place refresh, router.refresh(), came back as a 503 from Netlify, which left the
// old graph on screen as though nothing had been removed.)
const FLASH_KEY = "nest-stats-flash";

function reloadWith(message: string) {
  try {
    sessionStorage.setItem(FLASH_KEY, message);
  } catch {
    // storage blocked; the reload still shows the new numbers
  }
  window.location.reload();
}

export type VisitorRow = {
  id: string;
  views: number;
  device: string;
  browser: string | null;
  oldSite: boolean | null;
  country: string;
  source: string;
  when: string;
  pages: string[];
};

async function call(body: object): Promise<{ removed?: number; error?: string }> {
  const res = await fetch("/api/admin/visits", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as { removed?: number; error?: string };
  if (!res.ok) throw new Error(json.error ?? `status ${res.status}`);
  return json;
}

const views = (n: number) => `${n} page view${n === 1 ? "" : "s"}`;
const SHOW = 25;

export default function OwnVisits({ rows, rangeLabel }: { rows: VisitorRow[]; rangeLabel: string }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [all, setAll] = useState(false);

  useEffect(() => {
    let flash: string | null = null;
    try {
      flash = sessionStorage.getItem(FLASH_KEY);
      sessionStorage.removeItem(FLASH_KEY);
      localStorage.setItem(DONT_COUNT_KEY, "1");
    } catch {
      // storage blocked; the signed-in check on the server still skips the owner
    }
    if (flash) void Promise.resolve(flash).then(setMessage);

    let device: string | null = null;
    try {
      device = localStorage.getItem(DEVICE_KEY);
    } catch {
      // no stored device id; the server still matches this browser's older visits
    }
    call({ action: "remove-mine", device })
      .then((r) => {
        const n = r.removed ?? 0;
        if (n) reloadWith(`Removed ${views(n)} made from this device. It won't be counted again.`);
      })
      .catch(() => {});
  }, []);

  const removeOne = async (row: VisitorRow) => {
    setBusy(row.id);
    setMessage("");
    try {
      const r = await call({ action: "remove", visitor: row.id });
      reloadWith(`Removed ${views(r.removed ?? 0)} (${row.device}, ${row.country}). The graph and numbers above are updated.`);
    } catch (e) {
      setMessage(`Couldn't remove it: ${(e as Error).message}`);
      setBusy(null);
    }
  };

  const shown = all ? rows : rows.slice(0, SHOW);

  return (
    <section className="st-card st-own">
      <h2>
        Who visited, {rangeLabel.toLowerCase()} ({rows.length})
      </h2>
      <p className="st-note st-own-intro">
        Your own visits are taken out automatically from every device you open this page on, so open it once on your
        phone too. Press Remove on anything else that isn&apos;t a real visitor, like a robot.
      </p>
      {message && <p className="st-msg" role="status">{message}</p>}

      {rows.length === 0 ? (
        <p className="st-empty">No visits counted in this period.</p>
      ) : (
        <ul className="st-visitors">
          {shown.map((r) => (
            <li key={r.id}>
              <div className="st-vinfo">
                <div className="st-vline">
                  <strong>{r.device}</strong>
                  {r.browser && ` · ${r.browser}`} · {r.country} · {r.source}
                  {r.oldSite !== null && <span className="st-site">{r.oldSite ? "old vercel.app link" : "internshipnest.com"}</span>}
                </div>
                <div className="st-note">
                  {views(r.views)} · {r.when} · {r.pages.join(", ")}
                </div>
              </div>
              <button type="button" className="st-btn st-btn-quiet" onClick={() => removeOne(r)} disabled={busy !== null}>
                {busy === r.id ? "Removing..." : "Remove"}
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
    </section>
  );
}
