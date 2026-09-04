"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { signIn, signOut, useSession } from "next-auth/react";
import Dial, { type DialPoint } from "@/components/Dial";
import { bearing, miles } from "@/lib/geo";
import { QUESTIONS } from "@/lib/questions";
import { load, save } from "@/lib/storage";
import type { Answers, Company, GeoResult, Question, ScoredListing, UserProfile } from "@/lib/types";

type View = "landing" | "auth" | "q" | "res";

const STRONG: Record<string, (d: number | null) => string> = {
  Commute: (d) => (d === null ? "remote, so distance is not a factor" : `${Math.round(d)} miles away`),
  "Role fit": () => "the listing matches what you asked for",
  Pay: () => "it looks like a paid role",
  Mode: () => "the in-person/remote setup is what you wanted",
};
const WEAK: Record<string, (d: number | null) => string> = {
  Commute: (d) => (d === null ? "fully remote" : `${Math.round(d!)} miles is a long way`),
  "Role fit": () => "the listing is further from what you asked for",
  Pay: () => "pay isn't confirmed, or doesn't look paid",
  Mode: () => "the in-person/remote setup isn't quite what you wanted",
};

function why(c: ScoredListing): string {
  const s = STRONG[c.best[0]](c.d);
  const w = WEAK[c.worst[0]](c.d);
  return c.best[1] - c.worst[1] < 0.25 ? `Solid on everything: ${s}.` : `Ranks here because ${s}, despite ${w}.`;
}

function band(d: number | null, lim: number): "near" | "mid" | "far" | null {
  if (d === null || d === undefined) return null;
  return d <= lim ? "near" : d <= lim * 2 ? "mid" : "far";
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

function payLabel(c: ScoredListing): string {
  if (c.salaryMin || c.salaryMax) {
    const lo = c.salaryMin ? Math.round(c.salaryMin).toLocaleString() : null;
    const hi = c.salaryMax ? Math.round(c.salaryMax).toLocaleString() : null;
    const range = lo && hi && lo !== hi ? `${lo}–${hi}` : lo || hi;
    return `${c.salaryIsPredicted ? "Est. " : ""}${range}/yr`;
  }
  return c.unpaidMentioned ? "Unpaid" : "Pay not listed";
}

function csvDownload(res: ScoredListing[]) {
  const rows: (string | number)[][] = [["Rank", "Title", "Company", "Miles", "Location", "Score", "Listing"]];
  res.slice(0, 50).forEach((c, i) => {
    rows.push([i + 1, c.title, c.company, c.d === null ? "Remote" : Math.round(c.d), c.locationLabel, c.s, c.url || ""]);
  });
  const csv = rows.map((r) => r.map((x) => `"${String(x).replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "internship-shortlist.csv";
  a.click();
}

function isAnswerEmpty(q: Question, answers: Answers): boolean {
  const v = answers[q.k];
  if (q.type === "many") return !(Array.isArray(v) && v.length);
  return !v;
}

const HERO_ORIGIN = { lat: 37.2872, lng: -121.95 }; // Campbell — matches the prototype's hero demo

export default function HomeClient({ companies }: { companies: Company[] }) {
  const { data: session, status } = useSession();
  const [view, setView] = useState<View>("landing");
  const [user, setUser] = useState<UserProfile | null>(null);
  const [answers, setAnswers] = useState<Answers>({});
  const [qIndex, setQIndex] = useState(0);
  const [qHint, setQHint] = useState("");
  const [tab, setTab] = useState(0);
  const [results, setResults] = useState<ScoredListing[] | null>(null);
  const [coverage, setCoverage] = useState(true);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [locMsg, setLocMsg] = useState<{ text: string; err?: boolean } | null>(null);
  const [geoBusy, setGeoBusy] = useState(false);
  const [computing, setComputing] = useState(false);
  const [progressMsg, setProgressMsg] = useState("");
  const [dialSize, setDialSize] = useState(360);
  const [resDialSize, setResDialSize] = useState(360);
  const [citySearch, setCitySearch] = useState("");
  const [cityResults, setCityResults] = useState<GeoResult[]>([]);
  const [cityLoading, setCityLoading] = useState(false);
  const cityDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const resize = () => {
      setDialSize(Math.max(200, Math.min(360, window.innerWidth - 70)));
      setResDialSize(Math.max(200, Math.min(360, window.innerWidth - 70)));
    };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  useEffect(() => {
    if (status === "loading") return;
    if (status === "authenticated" && session.user) {
      const sessionUser = session.user;
      const syncUser = () =>
        setUser((prev) => ({ name: sessionUser.name ?? "You", email: sessionUser.email ?? "", lat: prev?.lat, lng: prev?.lng }));
      fetch("/api/user-data")
        .then((r) => r.json())
        .then((data) => {
          syncUser();
          if (data.answers) setAnswers(data.answers);
        })
        .catch(syncUser);
    } else {
      Promise.resolve().then(() => {
        const p = load<UserProfile>("profile");
        if (p) setUser(p);
        const a = load<Answers>("answers");
        if (a) setAnswers(a);
      });
    }
  }, [status, session]);

  const heroDial: DialPoint[] = useMemo(() => {
    const demo: DialPoint[] = companies
      .filter((c) => c.lat !== null)
      .map((c) => ({
        label: c.n,
        d: miles(HERO_ORIGIN.lat, HERO_ORIGIN.lng, c.lat!, c.lng!),
        b: bearing(HERO_ORIGIN.lat, HERO_ORIGIN.lng, c.lat!, c.lng!),
        lim: 15,
      }));
    demo.slice(0, 20).forEach((c) => (c.top = true));
    return demo;
  }, [companies]);

  async function handleSignOut() {
    if (status === "authenticated") await signOut({ redirect: false });
    setUser(null);
    setAnswers({});
    setResults(null);
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
      setLocMsg({ text: "This browser can't share a location. Search for a city instead.", err: true });
      return;
    }
    setGeoBusy(true);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setGeoBusy(false);
        setAnswer("loc", { lat: p.coords.latitude, lng: p.coords.longitude, label: "your current location", exact: true });
        setCitySearch("");
        setCityResults([]);
        setLocMsg({ text: "Using your current location." });
      },
      (e) => {
        setGeoBusy(false);
        const m =
          e.code === 1
            ? "You blocked location access. Search for a city below instead, it works just as well."
            : "Couldn't get a location. Search for a city below.";
        setLocMsg({ text: m, err: true });
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 },
    );
  }

  function onCityInput(v: string) {
    setCitySearch(v);
    if (cityDebounceRef.current) clearTimeout(cityDebounceRef.current);
    if (v.trim().length < 3) {
      setCityResults([]);
      return;
    }
    cityDebounceRef.current = setTimeout(() => {
      setCityLoading(true);
      fetch(`/api/geocode?q=${encodeURIComponent(v)}`)
        .then((r) => r.json())
        .then((data) => setCityResults(data.results || []))
        .catch(() => setCityResults([]))
        .finally(() => setCityLoading(false));
    }, 400);
  }

  function pickPlace(g: GeoResult) {
    setAnswer("loc", { lat: g.lat, lng: g.lng, label: g.label, exact: false });
    setLocMsg({ text: `Using ${g.fullLabel}.` });
    setCitySearch(g.label);
    setCityResults([]);
  }

  async function goNext() {
    const q = currentQ;
    if (isAnswerEmpty(q, answers)) {
      setQHint(q.type === "loc" ? "Choose a location to continue." : "Pick at least one.");
      return;
    }
    setQHint("");
    if (qIndex < QUESTIONS.length - 1) {
      setQIndex((i) => i + 1);
      return;
    }

    const loc = answers.loc!;
    const finalUser: UserProfile = { ...user!, lat: loc.lat, lng: loc.lng };
    setUser(finalUser);
    setComputing(true);

    const stages = [
      "Searching real internship listings near you…",
      "Checking real distances…",
      "Matching against what you want to do…",
      "Ranking your shortlist…",
    ];
    let stage = 0;
    setProgressMsg(stages[0]);
    const stageTimer = setInterval(() => {
      stage = Math.min(stage + 1, stages.length - 1);
      setProgressMsg(stages[stage]);
    }, 3500);

    try {
      const res = await fetch("/api/search-live", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answers, loc }),
      });
      const data = await res.json();
      const computed: ScoredListing[] = data.results || [];
      setResults(computed);
      setCoverage(data.coverage !== false);
      setTab(0);
      setView("res");
      if (status === "authenticated") {
        fetch("/api/user-data", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ answers, results: computed }),
        }).catch(() => {});
      } else {
        save("answers", answers);
      }
    } catch {
      setQHint("Search failed — check your connection and try again.");
    } finally {
      clearInterval(stageTimer);
      setComputing(false);
      setProgressMsg("");
    }
  }

  function goBack() {
    if (qIndex > 0) {
      setQHint("");
      setQIndex((i) => i - 1);
    }
  }

  const resDial: DialPoint[] = useMemo(() => {
    if (!results || !user?.lat) return [];
    const lim = parseFloat(answers.max || "30");
    const withB: DialPoint[] = results.map((c) => ({
      label: c.title,
      d: c.d,
      b: c.lat === null || c.lng === null ? 0 : bearing(user.lat!, user.lng!, c.lat, c.lng),
      lim,
    }));
    withB.slice(0, 25).forEach((c) => (c.top = true));
    return withB;
  }, [results, user, answers.max]);

  const sortedList = useMemo(() => {
    if (!results) return [];
    const list = [...results];
    if (tab === 1) list.sort((a, b) => (a.d === null ? 1e9 : a.d) - (b.d === null ? 1e9 : b.d));
    if (tab === 2) list.sort((a, b) => new Date(b.created ?? 0).getTime() - new Date(a.created ?? 0).getTime());
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
                <button className="linkbtn" onClick={handleSignOut}>
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
            <div className="hero-text">
              <div className="kicker">For students looking for their first internship</div>
              <h1>
                Internships you can
                <br />
                actually <span className="accent-text">get to.</span>
              </h1>
              <button className="btn" onClick={() => setView(user ? "q" : "auth")}>
                Get started
              </button>
            </div>
            <div className="dial-wrap">
              <Dial list={heroDial} size={dialSize} />
            </div>
          </section>

          <div className="fact-list">
            <div>
              <h3>Nine questions</h3>
              <p>Where you are, how far you&apos;ll go, how you get there, and what you want to do. Two minutes.</p>
            </div>
            <div>
              <h3>Distance first</h3>
              <p>Your browser can share your location, or search any city in the world. Sign in to save it, or skip the account entirely.</p>
            </div>
            <div>
              <h3>Live, worldwide</h3>
              <p>The moment you finish, we search real internship listings near you and rank them by distance and fit.</p>
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

              <button className="gbtn" onClick={() => signIn("google")}>
                <svg width="17" height="17" viewBox="0 0 48 48" aria-hidden="true">
                  <path fill="#4285F4" d="M45 24c0-1.6-.1-2.7-.4-4H24v8h12c-.2 2-1.5 5-4.4 7l6.7 5.2C42.2 36.3 45 30.7 45 24z" />
                  <path fill="#34A853" d="M24 46c5.9 0 10.9-2 14.5-5.3l-6.9-5.4C29.7 36.6 27.1 37.4 24 37.4c-5.7 0-10.6-3.8-12.3-9.1l-7.1 5.5C8.1 41.3 15.4 46 24 46z" />
                  <path fill="#FBBC05" d="M11.7 28.3c-.5-1.4-.7-2.8-.7-4.3s.3-2.9.7-4.3l-7.1-5.5C3 17.1 2 20.4 2 24s1 6.9 2.6 9.8l7.1-5.5z" />
                  <path fill="#EA4335" d="M24 10.6c3.2 0 6.1 1.1 8.4 3.3l6.3-6.3C34.9 4 29.9 2 24 2 15.4 2 8.1 6.7 4.6 14.2l7.1 5.5C13.4 14.4 18.3 10.6 24 10.6z" />
                </svg>
                Continue with Google
              </button>
              <p className="note" style={{ marginTop: 10 }}>
                Saves your answers and shortlist to your account, so they&apos;re here next time you sign in.
              </p>

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
                Continue without an account
              </button>
              <p className="note" style={{ marginTop: 14 }}>
                Saved in this browser only — not tied to an account, and won&apos;t follow you to another device.
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
                <label htmlFor="citysearch">Or search any city, anywhere</label>
                <div className="citysearch">
                  <input
                    id="citysearch"
                    type="text"
                    placeholder="Search for a city, e.g. Austin, TX"
                    autoComplete="off"
                    value={citySearch}
                    onChange={(e) => onCityInput(e.target.value)}
                  />
                  {cityLoading && <div className="cityhint">Searching…</div>}
                  {cityResults.length > 0 && (
                    <ul className="cityresults">
                      {cityResults.map((g, idx) => (
                        <li key={idx}>
                          <button type="button" onClick={() => pickPlace(g)}>
                            {g.fullLabel}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
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
              <button className="btn ghost" style={{ visibility: qIndex === 0 ? "hidden" : "visible" }} onClick={goBack} disabled={computing}>
                Back
              </button>
              <button className="btn" onClick={goNext} disabled={computing || isAnswerEmpty(currentQ, answers)}>
                {computing ? progressMsg || "Working…" : qIndex === QUESTIONS.length - 1 ? "See my shortlist" : "Next"}
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
                  {coverage
                    ? `${results.length} live listings ranked from ${answers.loc!.label}.`
                    : `We don't have live coverage for ${answers.loc!.label} yet — coverage today is the US, UK, Canada, Australia, and about a dozen more countries, mostly in Europe.`}
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

            {results.length > 0 && (
              <>
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
                  {["Best matches", "Closest first", "Most recent"].map((t, i) => (
                    <button key={t} className={`tab${i === tab ? " on" : ""}`} onClick={() => setTab(i)}>
                      {t}
                    </button>
                  ))}
                </div>
              </>
            )}

            <div className="list">
              {sortedList.length ? (
                sortedList.map((c, i) => {
                  const b = band(c.d, parseFloat(answers.max || "30"));
                  return (
                    <div key={c.id} className={`row${i < 3 && tab === 0 ? " lead" : ""}${b ? ` band-${b}` : ""}`}>
                      <div className="rank">{i + 1}</div>
                      <div>
                        <h3>{c.title}</h3>
                        <div className="meta">
                          <Pill d={c.d} lim={parseFloat(answers.max || "30")} /> &nbsp;{c.company} · {c.locationLabel}
                        </div>
                        <p className="desc">{c.description ? `${c.description.slice(0, 220)}${c.description.length > 220 ? "…" : ""}` : ""}</p>
                        <p className="desc" style={{ color: "var(--ink-3)" }}>
                          {payLabel(c)} · {c.remoteGuess === "remote" ? "Remote" : c.remoteGuess === "hybrid" ? "Hybrid" : "In person"}
                        </p>
                        <p className="why">{why(c)}</p>
                      </div>
                      <div className="score">
                        <b>{c.s}</b>
                        <span>of 100</span>
                      </div>
                    </div>
                  );
                })
              ) : (
                <div className="empty">
                  {coverage
                    ? "Nothing matched. Try widening the distance on question 2, or a bigger nearby city."
                    : "Try a city in a country we have live coverage for."}
                </div>
              )}
            </div>
          </div>
        </main>
      )}

      <footer>
        <div className="wrap">
          Listings come from a live jobs-search API and are re-fetched every time you run the questionnaire — not a
          static dataset. Distance uses the listing&apos;s stated location, with a real driving route where we could
          get one and a straight-line estimate otherwise. &quot;Remote / hybrid / in person&quot; and pay are read
          from the listing text automatically and can be wrong — check the actual posting before you apply. Live
          coverage is currently limited to a set of countries, mostly the US, UK, Canada, Australia, and Western
          Europe.
        </div>
      </footer>
    </>
  );
}

function ResultsStats({ results, lim }: { results: ScoredListing[]; lim: number }) {
  const near = results.filter((c) => c.d !== null && c.d <= lim).length;
  const mid = results.filter((c) => c.d !== null && c.d > lim && c.d <= lim * 2).length;
  const far = results.filter((c) => c.d !== null && c.d > lim * 2).length;
  const rem = results.filter((c) => c.d === null).length;
  const total = Math.max(1, near + mid + far);
  return (
    <div className="distbar-wrap">
      <div className="distbar">
        <span style={{ flexBasis: `${(near / total) * 100}%`, background: "var(--near)" }} />
        <span style={{ flexBasis: `${(mid / total) * 100}%`, background: "var(--mid)" }} />
        <span style={{ flexBasis: `${(far / total) * 100}%`, background: "var(--far)" }} />
      </div>
      <div className="distbar-key">
        <div>
          <b>{near}</b>
          <span>within {lim} miles</span>
        </div>
        <div>
          <b>{mid}</b>
          <span>
            a stretch, {lim}–{lim * 2} miles
          </span>
        </div>
        <div>
          <b>{far}</b>
          <span>too far to commute</span>
        </div>
      </div>
      {rem > 0 && <p className="readout">{rem} are fully remote.</p>}
    </div>
  );
}
