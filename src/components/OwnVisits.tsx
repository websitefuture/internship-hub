"use client";

import { useEffect, useState } from "react";
import { DEVICE_KEY, DONT_COUNT_KEY } from "@/components/ViewTracker";

// The visitor list on /admin/stats. Opening the page on a device marks that device as the
// owner's: it is never counted again, and everything it was counted for before is deleted on the
// spot. Any other visitor (a robot, say) can be removed with its own Remove button. Removed
// visitors are handed to onRemoved, which takes them out of the graph and totals in the browser
// straight away, without reloading the page.

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

async function call(body: object): Promise<{ removed?: number; ids?: string[]; error?: string }> {
  const res = await fetch("/api/admin/visits", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as { removed?: number; ids?: string[]; error?: string };
  if (!res.ok) throw new Error(json.error ?? `status ${res.status}`);
  return json;
}

const views = (n: number) => `${n} page view${n === 1 ? "" : "s"}`;
const SHOW = 25;

export default function OwnVisits({
  rows,
  rangeLabel,
  onRemoved,
}: {
  rows: VisitorRow[];
  rangeLabel: string;
  onRemoved: (visitorIds: string[]) => void;
}) {
  const [message, setMessage] = useState("");
  const [all, setAll] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem(DONT_COUNT_KEY, "1");
    } catch {
      // storage blocked; the signed-in check on the server still skips the owner
    }

    let device: string | null = null;
    try {
      device = localStorage.getItem(DEVICE_KEY);
    } catch {
      // no stored device id; the server still matches this browser's older visits
    }
    call({ action: "remove-mine", device })
      .then((r) => {
        const n = r.removed ?? 0;
        if (n) {
          onRemoved(r.ids ?? []);
          setMessage(`Removed ${views(n)} made from this device. It won't be counted again.`);
        }
      })
      .catch(() => {});
    // Once per page load; onRemoved only filters the parent's data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The row and the numbers update the moment Remove is pressed; the delete finishes in the
  // background. If it fails, say so: a reload would show the visit again.
  const removeOne = (row: VisitorRow) => {
    onRemoved([row.id]);
    setMessage(`Removed ${views(row.views)} (${row.device}, ${row.country}).`);
    call({ action: "remove", visitor: row.id }).catch((e: Error) =>
      setMessage(`Couldn't remove the ${row.device}, ${row.country} visit on the server (${e.message}). Reload and try again.`),
    );
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
              <button type="button" className="st-btn st-btn-quiet" onClick={() => removeOne(r)}>
                Remove
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
