"use client";

import { useEffect, useMemo, useState } from "react";
import Dial from "@/components/Dial";
import { COMPANIES } from "@/lib/companies";
import { bearing, miles } from "@/lib/geo";
import { CITIES, QUESTIONS } from "@/lib/questions";
import { score } from "@/lib/scoring";
import { load, save } from "@/lib/storage";
import type { Answers, PlottedCompany, ScoredCompany, UserProfile } from "@/lib/types";

type View = "landing" | "auth" | "q" | "res";

const STRONG: Record<string, (d: number | null) => string> = {
  Commute: (d) => (d === null ? "remote, so distance is not a factor" : `${Math.round(d)} miles away`),
  "Role fit": () => "the work is close to what you asked for",
  "Team size": () => "the team size is what you wanted",
  Growth: () => "growing quickly right now",
  Reach: () => "a named founder you can actually reach",
};
const WEAK: Record<string, (d: number | null) => string> = {
  Commute: (d) => (d === null ? "fully remote" : `${Math.round(d!)} miles is a long way`),
  "Role fit": () => "the work is further from what you asked for",
  "Team size": () => "the team size is not what you asked for",
  Growth: () => "early and unproven",
  Reach: () => "no easy way to reach a person",
};

function why(c: ScoredCompany): string {
  const s = STRONG[c.best[0]](c.d);
  const w = WEAK[c.worst[0]](c.d);
  return c.best[1] - c.worst[1] < 0.25 ? `Solid on everything: ${s}.` : `Ranks here because ${s}, despite ${w}.`;
}

function Pill({ d, lim }: { d: number | null; lim: number }) {
  if (d === null || d === undefined) return <span className="pill" style={{ background: "#3A4B46" }}>Remote</span>;
  const col = d <= lim ? "var(--near)" : d <= lim * 2 ? "var(--mid)" : "var(--far)";
  return (
    <span className="pill" style={{ background: col }}>
      {Math.round(d)} mi
    </span>
  );
}

function csvDownload(res: ScoredCompany[]) {
  const rows: (string | number)[][] = [["Rank", "Company", "Miles", "City", "Industry", "People", "Score", "Website"]];
  res.slice(0, 50).forEach((c, i) => {
    rows.push([i + 1, c.n, c.d === null ? "Remote" : Math.round(c.d), c.c, c.i, c.e || "unknown", c.s, c.w || ""]);
  });
  const csv = rows.map((r) => r.map((x) => `"${String(x).replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "radius-shortlist.csv";
  a.click();
}

const HERO_ORIGIN = { lat: 37.2872, lng: -121.95 }; // Campbell — matches the prototype's hero demo

export default function Home() {
  const [view, setView] = useState<View>("landing");
  const [user, setUser] = useState<UserProfile | null>(null);
  const [answers, setAnswers] = useState<Answers>({});
  const [qIndex, setQIndex] = useState(0);
  const [qHint, setQHint] = useState("");
  const [tab, setTab] = useState(0);
  const [results, setResults] = useState<ScoredCompany[] | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [showGoogleNote, setShowGoogleNote] = useState(false);
  const [locMsg, setLocMsg] = useState<{ text: string; err?: boolean } | null>(null);
  const [geoBusy, setGeoBusy] = useState(false);
  const [dialSize, setDialSize] = useState(400);
  const [resDialSize, setResDialSize] = useState(360);

  useEffect(() => {
    const p = load<UserProfile>("profile");
    if (p) setUser(p);
    const a = load<Answers>("answers");
    if (a) setAnswers(a);
    const resize = () => {
      setDialSize(Math.max(200, Math.min(400, window.innerWidth - 70)));
      setResDialSize(Math.max(200, Math.min(360, window.innerWidth - 70)));
    };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  const heroDial: PlottedCompany[] = useMemo(() => {
    const demo = COMPANIES.filter((c) => c.lat !== null).map((c) => {
      const d = miles(HERO_ORIGIN.lat, HERO_ORIGIN.lng, c.lat!, c.lng!);
      const b = bearing(HERO_ORIGIN.lat, HERO_ORIGIN.lng, c.lat!, c.lng!);
      return { ...c, d, b, s: 0, parts: {} as never, best: ["", 0] as [string, number], worst: ["", 0] as [string, number], lim: 15 } as PlottedCompany;
    });
    demo.slice(0, 20).forEach((c) => (c.top = true));
    return demo;
  }, []);

  function signOut() {
    setUser(null);
    setAnswers({});
    save("profile", null);
    save("answers", null);
    setView("landing");
  }

  function createProfile() {
    const n = name.trim();
    if (!n) return;
    const u: UserProfile = { name: n, email: email.trim() };
    setUser(u);
    save("profile", u);
    setQIndex(0);
    setView("q");
  }

  const currentQ = QUESTIONS[qIndex];

  function setAnswer<K extends keyof Answers>(key: K, value: Answers[K]) {
    setAnswers((prev) => ({ ...prev, [key]: value }));
  }

  function toggleMany(key: keyof Answers, value: string, max?: number) {
    setAnswers((prev) => {
      const cur = (prev[key] as string[] | undefined) || [];
      let next: string[];
      if (cur.includes(value)) next = cur.filter((x) => x !== value);
      else {
        next = max && cur.length >= max ? cur.slice(1).concat(value) : cur.concat(value);
      }
      return { ...prev, [key]: next };
    });
  }

  function useGeolocation() {
    if (!navigator.geolocation) {
      setLocMsg({ text: "This browser can't share a location. Pick a city instead.", err: true });
      return;
    }
    setGeoBusy(true);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setGeoBusy(false);
        setAnswer("loc", { lat: p.coords.latitude, lng: p.coords.longitude, label: "your current location", exact: true });
        setLocMsg({ text: "Using your current location." });
      },
      (e) => {
        setGeoBusy(false);
        const m =
          e.code === 1
            ? "You blocked location access. Pick a city below instead, it works just as well."
            : "Couldn't get a location. Pick a city below.";
        setLocMsg({ text: m, err: true });
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 },
    );
  }

  function pickCity(cityName: string) {
    const c = CITIES.find((x) => x[0] === cityName);
    if (!c) return;
    setAnswer("loc", { lat: c[1], lng: c[2], label: c[0], exact: false });
    setLocMsg({ text: `Using ${c[0]}. City centre.` });
  }

  function goNext() {
    const q = currentQ;
    const v = answers[q.k];
    const empty = q.type === "loc" ? !v : q.type === "many" ? !(Array.isArray(v) && v.length) : !v;
    if (empty) {
      setQHint(q.type === "loc" ? "Choose a location to continue." : "Pick at least one.");
      return;
    }
    setQHint("");
    if (qIndex < QUESTIONS.length - 1) {
      setQIndex((i) => i + 1);
    } else {
      save("answers", answers);
      const loc = answers.loc!;
      const finalUser: UserProfile = { ...user!, lat: loc.lat, lng: loc.lng };
      setUser(finalUser);
      setResults(score(answers, finalUser));
      setTab(0);
      setView("res");
    }
  }

  function goBack() {
    if (qIndex > 0) {
      setQHint("");
      setQIndex((i) => i - 1);
    }
  }

  const resDial: PlottedCompany[] = useMemo(() => {
    if (!results || !user?.lat) return [];
    const lim = parseFloat(answers.max || "30");
    const withB = results.map((c) => ({
      ...c,
      b: c.lat === null ? 0 : bearing(user.lat!, user.lng!, c.lat, c.lng!),
      lim,
    })) as PlottedCompany[];
    withB.slice(0, 25).forEach((c) => (c.top = true));
    return withB;
  }, [results, user, answers.max]);

  const sortedList = useMemo(() => {
    if (!results) return [];
    let list = [...results];
    if (tab === 1) list.sort((a, b) => (a.d === null ? 1e9 : a.d) - (b.d === null ? 1e9 : b.d));
    if (tab === 2) list.sort((a, b) => b.x - a.x || b.s - a.s);
    return list.slice(0, 30);
  }, [results, tab]);

  return (
    <>
      <header className="bar">
        <div className="wrap">
          <div className="brand">
            <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
              <circle cx="11" cy="11" r="9.5" fill="none" stroke="#DCE3DF" strokeWidth="1" />
              <circle cx="11" cy="11" r="5.5" fill="none" stroke="#DCE3DF" strokeWidth="1" />
              <circle cx="11" cy="11" r="2" fill="#101F1B" />
              <circle cx="17.4" cy="6.6" r="2" fill="#9E2B3E" />
              <circle cx="6.2" cy="14.4" r="2" fill="#0E7C66" />
            </svg>
            Internship Hub
          </div>
          <div className="who">
            {user ? (
              <>
                {user.name}{" "}
                <button className="linkbtn" onClick={signOut}>
                  Sign out
                </button>
              </>
            ) : null}
          </div>
        </div>
      </header>

      {view === "landing" && (
        <main className="wrap">
          <section className="hero">
            <div className="kicker">For students looking for their first internship</div>
            <h1>Most internship lists ignore the only thing you can&apos;t change.</h1>
            <p className="lede">
              You can learn a new skill. You can rewrite your resume. You cannot move a company closer to your
              house, and at sixteen you probably can&apos;t drive to it either. Internship Hub ranks startups by how far
              they actually are from you, then by everything else.
            </p>
            <div className="dial-wrap">
              <Dial list={heroDial} size={dialSize} />
            </div>
            <button className="btn" onClick={() => setView(user ? "q" : "auth")}>
              Get started
            </button>
          </section>

          <div className="landing-grid">
            <div>
              <h3>Ten questions</h3>
              <p>Where you are, how far you&apos;ll go, how you get there, and what you want to do. Two minutes.</p>
            </div>
            <div>
              <h3>Distance first</h3>
              <p>Your browser can share your location, or you can pick a city. Nothing is stored on a server.</p>
            </div>
            <div>
              <h3>175 companies</h3>
              <p>Bay Area startups, each scored on commute, role fit, team size, growth and how reachable they are.</p>
            </div>
          </div>
        </main>
      )}

      {view === "auth" && (
        <main className="wrap">
          <div className="auth">
            <div className="panel">
              <h2 style={{ marginBottom: 6 }}>Create your profile</h2>
              <p className="note" style={{ marginBottom: 20 }}>
                So your answers and shortlist are here when you come back.
              </p>

              <button className="gbtn" onClick={() => setShowGoogleNote(true)}>
                <svg width="17" height="17" viewBox="0 0 48 48" aria-hidden="true">
                  <path fill="#4285F4" d="M45 24c0-1.6-.1-2.7-.4-4H24v8h12c-.2 2-1.5 5-4.4 7l6.7 5.2C42.2 36.3 45 30.7 45 24z" />
                  <path fill="#34A853" d="M24 46c5.9 0 10.9-2 14.5-5.3l-6.9-5.4C29.7 36.6 27.1 37.4 24 37.4c-5.7 0-10.6-3.8-12.3-9.1l-7.1 5.5C8.1 41.3 15.4 46 24 46z" />
                  <path fill="#FBBC05" d="M11.7 28.3c-.5-1.4-.7-2.8-.7-4.3s.3-2.9.7-4.3l-7.1-5.5C3 17.1 2 20.4 2 24s1 6.9 2.6 9.8l7.1-5.5z" />
                  <path fill="#EA4335" d="M24 10.6c3.2 0 6.1 1.1 8.4 3.3l6.3-6.3C34.9 4 29.9 2 24 2 15.4 2 8.1 6.7 4.6 14.2l7.1 5.5C13.4 14.4 18.3 10.6 24 10.6z" />
                </svg>
                Continue with Google
              </button>
              {showGoogleNote && (
                <div className="note warn">
                  Google sign-in needs a server to hold the OAuth secret, and this version runs entirely in your
                  browser. Use your name and email below instead. It works the same way here.
                </div>
              )}

              <div className="divider">or</div>

              <div className="field">
                <label htmlFor="nm">Your name</label>
                <input id="nm" type="text" placeholder="Ibrahim Battisha" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="em">Email</label>
                <input id="em" type="email" placeholder="you@example.com" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
              </div>
              <button className="btn" style={{ width: "100%" }} onClick={createProfile}>
                Create profile
              </button>
              <p className="note" style={{ marginTop: 14 }}>
                Saved in your browser only. No account server, no email sent, nothing shared.
              </p>
            </div>
          </div>
        </main>
      )}

      {view === "q" && (
        <main className="wrap">
          <div className="q">
            <div className="prog">
              {QUESTIONS.map((_, i) => (
                <i key={i} className={i <= qIndex ? "on" : ""} />
              ))}
            </div>
            <div className="qnum">
              Question {qIndex + 1} of {QUESTIONS.length}
            </div>
            <div className="qtitle">{currentQ.t}</div>
            {currentQ.s && <div className="qsub">{currentQ.s}</div>}

            {currentQ.type === "loc" ? (
              <div>
                <div className="geo">
                  <button className="btn ghost" onClick={useGeolocation}>
                    {geoBusy ? "Waiting for permission…" : "Use my current location"}
                  </button>
                </div>
                <div>
                  {(locMsg || answers.loc) && (
                    <div className={`locstate${locMsg?.err ? " err" : ""}`}>
                      {locMsg
                        ? locMsg.text
                        : `Using ${answers.loc!.label}. ${answers.loc!.exact ? "From your device." : "City centre."}`}
                    </div>
                  )}
                </div>
                <label htmlFor="citysel">Or pick the closest city</label>
                <select
                  id="citysel"
                  style={{ width: "100%", padding: "11px 13px", border: "1px solid var(--line)", borderRadius: 8, fontFamily: "inherit", fontSize: 15, background: "#fff" }}
                  value={answers.loc && !answers.loc.exact ? answers.loc.label : ""}
                  onChange={(e) => pickCity(e.target.value)}
                >
                  <option value="">Choose a city</option>
                  {CITIES.map((c) => (
                    <option key={c[0]} value={c[0]}>
                      {c[0]}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <div className="opts">
                {currentQ.o!.map((o) => {
                  const sel = answers[currentQ.k];
                  const on = currentQ.type === "many" ? ((sel as string[] | undefined) || []).includes(o[0]) : sel === o[0];
                  return (
                    <button
                      key={o[0]}
                      className={`opt${on ? " sel" : ""}`}
                      onClick={() => {
                        if (currentQ.type === "many") toggleMany(currentQ.k, o[0], currentQ.max);
                        else setAnswer(currentQ.k, o[0] as never);
                      }}
                    >
                      <span className="tick" />
                      <span>
                        {o[1]}
                        {o[2] && <small>{o[2]}</small>}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}

            <div className="nav">
              <button className="btn ghost" style={{ visibility: qIndex === 0 ? "hidden" : "visible" }} onClick={goBack}>
                Back
              </button>
              <button className="btn" onClick={goNext}>
                {qIndex === QUESTIONS.length - 1 ? "See my shortlist" : "Next"}
              </button>
              <span className="note">{qHint}</span>
            </div>
          </div>
        </main>
      )}

      {view === "res" && results && user?.lat !== undefined && (
        <main className="wrap">
          <div className="res">
            <div className="reshead">
              <div>
                <h2>Your shortlist</h2>
                <p className="note" style={{ marginTop: 6 }}>
                  {results.length} companies ranked from {answers.loc!.label}.
                </p>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  className="btn ghost sm"
                  onClick={() => {
                    setQIndex(0);
                    setView("q");
                  }}
                >
                  Change answers
                </button>
                <button className="btn ghost sm" onClick={() => csvDownload(results)}>
                  Download CSV
                </button>
              </div>
            </div>

            <ResultsStats results={results} lim={parseFloat(answers.max || "30")} />

            <div className="dialrow">
              <Dial list={resDial} size={resDialSize} />
            </div>

            <div className="legend">
              <span>
                <i className="dot" style={{ background: "var(--near)" }} /> within your range
              </span>
              <span>
                <i className="dot" style={{ background: "var(--mid)" }} /> a stretch
              </span>
              <span>
                <i className="dot" style={{ background: "var(--far)" }} /> too far to commute
              </span>
              <span>each ring is a distance band from where you are</span>
            </div>

            <div className="tabs">
              {["Best matches", "Closest first", "Easiest to contact"].map((t, i) => (
                <button key={t} className={`tab${i === tab ? " on" : ""}`} onClick={() => setTab(i)}>
                  {t}
                </button>
              ))}
            </div>

            <div className="list">
              {sortedList.length ? (
                sortedList.map((c, i) => (
                  <div key={c.n} className={`row${i < 3 && tab === 0 ? " lead" : ""}`}>
                    <div className="rank">{i + 1}</div>
                    <div>
                      <h3>{c.n}</h3>
                      <div className="meta">
                        <Pill d={c.d} lim={parseFloat(answers.max || "30")} /> &nbsp;{c.c} · {c.i}
                        {c.e ? ` · ${c.e} people` : " · size unknown"}
                      </div>
                      <p className="desc">{c.desc || ""}</p>
                      {c.k && (
                        <p className="desc" style={{ color: "var(--ink-3)" }}>
                          {c.k}
                        </p>
                      )}
                      <p className="why">{why(c)}</p>
                    </div>
                    <div className="score">
                      <b>{c.s}</b>
                      <span>of 100</span>
                    </div>
                  </div>
                ))
              ) : (
                <div className="empty">Nothing matched. Try widening the distance on question 2.</div>
              )}
            </div>
          </div>
        </main>
      )}

      <footer>
        <div className="wrap">
          Company data compiled September 2026 and not re-verified since. Distances are straight-line estimates
          between city centres, not driving routes. Check that a company still exists and that the contact still
          works there before you email them.
        </div>
      </footer>
    </>
  );
}

function ResultsStats({ results, lim }: { results: ScoredCompany[]; lim: number }) {
  const near = results.filter((c) => c.d !== null && c.d <= lim).length;
  const mid = results.filter((c) => c.d !== null && c.d > lim && c.d <= lim * 2).length;
  const far = results.filter((c) => c.d !== null && c.d > lim * 2).length;
  const rem = results.filter((c) => c.d === null).length;
  const cityCounts: Record<string, number> = {};
  results.forEach((c) => {
    if (c.d !== null && c.d > lim * 2) cityCounts[c.c] = (cityCounts[c.c] || 0) + 1;
  });
  const bigCity = Object.entries(cityCounts).sort((a, b) => b[1] - a[1])[0];
  return (
    <div>
      <div className="stat near">
        <b>{near}</b>
        <span>within {lim} miles of you</span>
      </div>
      <div className="stat mid">
        <b>{mid}</b>
        <span>
          a stretch, {lim} to {lim * 2} miles
        </span>
      </div>
      <div className="stat far">
        <b>{far}</b>
        <span>too far for a regular commute</span>
      </div>
      {bigCity && (
        <p className="readout">
          {bigCity[1]} of those are in {bigCity[0]}. That cluster is the shape of the startup world, not the shape
          of your options.
        </p>
      )}
      {rem > 0 && <p className="readout">{rem} are fully remote.</p>}
    </div>
  );
}
