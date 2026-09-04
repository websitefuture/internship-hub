"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { signIn, signOut, useSession } from "next-auth/react";
import Dial, { type DialPoint } from "@/components/Dial";
import { bearing } from "@/lib/geo";
import { QUESTIONS } from "@/lib/questions";
import { radiusMilesForAnswers } from "@/lib/localBusinesses";
import { load, save } from "@/lib/storage";
import type { Answers, GeoResult, LocationAnswer, Question, ScoredListing, UserProfile } from "@/lib/types";

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
  if (d === null || d === undefined) return <span className="pill pill-muted">Remote</span>;
  const cls = d <= lim ? "pill-near" : d <= lim * 2 ? "pill-mid" : "pill-far";
  return <span className={`pill ${cls}`}>{Math.round(d)} mi</span>;
}

// Deterministic pastel avatar (color + initial) for a company/business name — same palette
// family as the near/mid/far distance colors plus two extras so cards don't all look alike.
const AVATAR_PALETTE = [
  { bg: "#FFE4D6", fg: "#E0400F" },
  { bg: "#ECFFAD", fg: "#4A5C00" },
  { bg: "#DFF3E8", fg: "#0E7C66" },
  { bg: "#FFE9A8", fg: "#8A6D14" },
  { bg: "#E1E9FF", fg: "#2E4E9C" },
  { bg: "#F1E1FF", fg: "#6B3FA0" },
];
function avatarStyle(name: string): { background: string; color: string } {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const c = AVATAR_PALETTE[h % AVATAR_PALETTE.length];
  return { background: c.bg, color: c.fg };
}
function initial(name: string): string {
  const m = name.trim().match(/[A-Za-z0-9]/);
  return m ? m[0].toUpperCase() : "?";
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

function draftEmail(c: ScoredListing): { subject: string; body: string } {
  if (c.coldOutreach) {
    return {
      subject: `Local student interested in ${c.company}`,
      body: `Hi ${c.company} team,

My name is [Your Name], a [grade] student at [Your School]. I came across ${c.company} while looking for ${c.category.toLowerCase()} opportunities near ${c.locationLabel}, and I'd love the chance to intern, shadow, or help out — even informally, part-time, or unpaid to start.

[A sentence or two on why this business specifically interests you, and any relevant skills or coursework — personalize this before sending.]

Would you be open to a short conversation about whether there's any way I could help out? I'm available [your availability] and can come by in person if that's easier.

Thank you for your time,
[Your Name]
[Your phone or email]`,
    };
  }
  return {
    subject: `Application: ${c.title}`,
    body: `Hi ${c.company} team,

My name is [Your Name], and I'm interested in the ${c.title} role near ${c.locationLabel}.

[A sentence or two on why you're a good fit — personalize this before sending.]

I've attached my resume for your review. Please let me know if you need anything else from me.

Thank you for your time,
[Your Name]
[Your phone or email]`,
  };
}

function ContactModal({ listing, onClose }: { listing: ScoredListing; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const { subject, body } = draftEmail(listing);
  const fullText = `Subject: ${subject}\n\n${body}`;
  const mailHref = listing.contactEmail
    ? `mailto:${listing.contactEmail}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
    : null;

  function copyEmail() {
    navigator.clipboard
      .writeText(fullText)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {});
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="Close">
          ×
        </button>
        <h2 style={{ marginBottom: 4 }}>{listing.title}</h2>
        <p className="note" style={{ marginBottom: 16 }}>
          {listing.company} · {listing.locationLabel}
          {listing.category ? ` · ${listing.category}` : ""}
        </p>
        <p className="desc">{listing.description}</p>
        <p className="desc" style={{ color: "var(--ink-3)" }}>
          {payLabel(listing)} · {listing.remoteGuess === "remote" ? "Remote" : listing.remoteGuess === "hybrid" ? "Hybrid" : "In person"}
        </p>

        <div className="contact-block">
          <h3>Contact</h3>
          {listing.coldOutreach ? (
            <>
              <p className="note" style={{ marginBottom: 8 }}>
                {listing.company} has no posted opening — this is a business we think fits what you&apos;re looking
                for, not a confirmed job. Reach out directly using whichever of these they have:
              </p>
              <p className="desc">
                {listing.contactEmail && (
                  <>
                    Email: <a href={`mailto:${listing.contactEmail}`}>{listing.contactEmail}</a>
                    <br />
                  </>
                )}
                {listing.phone && (
                  <>
                    Phone: <a href={`tel:${listing.phone}`}>{listing.phone}</a>
                    <br />
                  </>
                )}
                {listing.websiteUrl && (
                  <>
                    Website:{" "}
                    <a href={listing.websiteUrl.startsWith("http") ? listing.websiteUrl : `https://${listing.websiteUrl}`} target="_blank" rel="noopener noreferrer">
                      {listing.websiteUrl}
                    </a>
                    <br />
                  </>
                )}
                {!listing.contactEmail && !listing.phone && !listing.websiteUrl && (
                  <>No phone, website, or email on file — try visiting in person or searching for {listing.company} online.</>
                )}
              </p>
            </>
          ) : listing.contactEmail ? (
            <p className="desc">
              Found in this listing: <a href={`mailto:${listing.contactEmail}`}>{listing.contactEmail}</a>
            </p>
          ) : (
            <p className="note">
              This listing doesn&apos;t include a direct apply link or a contact email — we&apos;re not going to
              guess one. Try searching for {listing.company}&apos;s own careers page or LinkedIn.
            </p>
          )}
        </div>

        <div className="contact-block">
          <h3>Sample email</h3>
          <p className="note" style={{ marginBottom: 8 }}>
            A starting point — personalize it before sending.
          </p>
          <pre className="email-draft">{fullText}</pre>
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            {mailHref && (
              <a className="btn ghost sm" href={mailHref}>
                Open in email app
              </a>
            )}
            <button className="btn ghost sm" onClick={copyEmail}>
              {copied ? "Copied!" : "Copy text"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ResultRow({
  c,
  rank,
  lead,
  band: bandClass,
  lim,
  onContact,
}: {
  c: ScoredListing;
  rank: number;
  lead: boolean;
  band: "near" | "mid" | "far" | null;
  lim: number;
  onContact: (c: ScoredListing) => void;
}) {
  const className = `row${lead ? " lead" : ""}${bandClass ? ` band-${bandClass}` : ""}`;
  const inner = (
    <>
      <div className="rank">{rank}</div>
      <div className="avatar-sq" style={avatarStyle(c.company)} aria-hidden="true">
        {initial(c.company)}
      </div>
      <div>
        <h3>{c.title}</h3>
        <div className="meta">
          <Pill d={c.d} lim={lim} /> &nbsp;{c.company} · {c.locationLabel}
          {c.coldOutreach && (
            <>
              {" "}
              <span className="pill pill-mid">No listed opening</span>
            </>
          )}
        </div>
        <p className="desc">{c.description ? `${c.description.slice(0, 220)}${c.description.length > 220 ? "…" : ""}` : ""}</p>
        {!c.coldOutreach && (
          <p className="desc" style={{ color: "var(--ink-3)" }}>
            {payLabel(c)} · {c.remoteGuess === "remote" ? "Remote" : c.remoteGuess === "hybrid" ? "Hybrid" : "In person"}
          </p>
        )}
        <p className="why">{why(c)}</p>
      </div>
      <div className="score">
        <b>{c.s}</b>
        <span>of 100</span>
        <span className="applyhint">{c.url ? "Apply ↗" : c.coldOutreach ? "Pitch →" : "Contact →"}</span>
      </div>
    </>
  );

  if (c.url) {
    return (
      <a className={className} href={c.url} target="_blank" rel="noopener noreferrer">
        {inner}
      </a>
    );
  }

  return (
    <div
      className={className}
      role="button"
      tabIndex={0}
      onClick={() => onContact(c)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onContact(c);
        }
      }}
    >
      {inner}
    </div>
  );
}

export default function HomeClient() {
  const { data: session, status } = useSession();
  const [view, setView] = useState<View>("landing");
  const [user, setUser] = useState<UserProfile | null>(null);
  const [answers, setAnswers] = useState<Answers>({});
  const [qIndex, setQIndex] = useState(0);
  const [qHint, setQHint] = useState("");
  const [tab, setTab] = useState(0);
  const [results, setResults] = useState<ScoredListing[] | null>(null);
  const [coverage, setCoverage] = useState(true);
  const [hsRadiusMiles, setHsRadiusMiles] = useState(0);
  const [hsCity, setHsCity] = useState("");
  const [contactFor, setContactFor] = useState<ScoredListing | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [locMsg, setLocMsg] = useState<{ text: string; err?: boolean } | null>(null);
  const [geoBusy, setGeoBusy] = useState(false);
  const [computing, setComputing] = useState(false);
  const [progressMsg, setProgressMsg] = useState("");
  const [resDialSize, setResDialSize] = useState(360);
  const [citySearch, setCitySearch] = useState("");
  const [cityResults, setCityResults] = useState<GeoResult[]>([]);
  const [cityLoading, setCityLoading] = useState(false);
  const cityDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Real browser history: every navigation (question step, view change) is a real entry, so
  // the back/forward buttons and the browser's back gesture work like on any other site,
  // instead of the whole app being invisible to history because it's one client-rendered page.
  const skipPushRef = useRef(false);
  function go(nextView: View, nextQIndex = 0) {
    setView(nextView);
    if (nextView === "q") setQIndex(nextQIndex);
    if (!skipPushRef.current) {
      window.history.pushState({ view: nextView, qIndex: nextQIndex }, "");
    }
    skipPushRef.current = false;
  }

  useEffect(() => {
    window.history.replaceState({ view: "landing", qIndex: 0 }, "");
    const onPop = (e: PopStateEvent) => {
      const s = (e.state as { view: View; qIndex: number } | null) || { view: "landing", qIndex: 0 };
      skipPushRef.current = true;
      setView(s.view);
      setQIndex(s.qIndex);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    const resize = () => setResDialSize(Math.max(200, Math.min(360, window.innerWidth - 70)));
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  useEffect(() => {
    if (status === "loading") return;
    if (status === "authenticated" && session.user) {
      const sessionUser = session.user;
      const syncUser = (loc?: LocationAnswer | null) =>
        setUser((prev) => ({
          name: sessionUser.name ?? "You",
          email: sessionUser.email ?? "",
          lat: loc?.lat ?? prev?.lat,
          lng: loc?.lng ?? prev?.lng,
        }));
      fetch("/api/user-data")
        .then((r) => r.json())
        .then((data: { answers?: Answers | null; results?: ScoredListing[] | null }) => {
          syncUser(data.answers?.loc);
          if (data.answers) setAnswers(data.answers);
          // Restore straight to the shortlist instead of making a returning user click
          // through all nine questions again just to see the answers they already gave.
          if (data.results && data.results.length) {
            setResults(data.results);
            setCoverage(true);
            if (data.answers?.stage === "hs" && data.answers.loc) {
              setHsRadiusMiles(radiusMilesForAnswers(data.answers.max));
              setHsCity(data.answers.loc.label);
            }
            setTab(0);
            go("res");
          }
        })
        .catch(() => syncUser());
    } else {
      Promise.resolve().then(() => {
        const p = load<UserProfile>("profile");
        const a = load<Answers>("answers");
        if (p) setUser(a?.loc ? { ...p, lat: a.loc.lat, lng: a.loc.lng } : p);
        if (a) setAnswers(a);
        const r = load<ScoredListing[]>("results");
        if (r && r.length && a?.loc) {
          setResults(r);
          setCoverage(true);
          if (a.stage === "hs") {
            setHsRadiusMiles(radiusMilesForAnswers(a.max));
            setHsCity(a.loc.label);
          }
          setTab(0);
          go("res");
        }
      });
    }
  }, [status, session]);

  async function handleSignOut() {
    if (status === "authenticated") await signOut({ redirect: false });
    setUser(null);
    setAnswers({});
    setResults(null);
    save("profile", null);
    save("answers", null);
    go("landing");
  }

  function createProfile() {
    const n = name.trim();
    if (!n) return;
    const u: UserProfile = { name: n, email: email.trim() };
    setUser(u);
    save("profile", u);
    go("q", 0);
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
      go("q", qIndex + 1);
      return;
    }

    const loc = answers.loc!;
    const finalUser: UserProfile = { ...user!, lat: loc.lat, lng: loc.lng };
    setUser(finalUser);
    setComputing(true);

    const stages =
      answers.stage === "hs"
        ? [
            "Finding real local businesses near you…",
            "Checking real distances…",
            "Matching against what you want to do…",
            "Drafting cold-pitch angles…",
          ]
        : [
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
      setHsRadiusMiles(data.hsRadiusMiles || 0);
      setHsCity(data.hsCity || "");
      setTab(0);
      go("res");
      if (status === "authenticated") {
        fetch("/api/user-data", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ answers, results: computed }),
        }).catch(() => {});
      } else {
        save("profile", finalUser);
        save("answers", answers);
        save("results", computed);
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
      go("q", qIndex - 1);
    }
  }

  // High-school results are capped to a much tighter real search radius (see
  // radiusMilesForAnswers) than the raw "how far will you travel" answer, which is also used
  // to weight commute scoring for regular listings — so distance bands/rings need this instead
  // of the raw answer, or a "within 30 miles" stat card would be shown when every result is
  // actually within 10.
  const effectiveLim =
    answers.stage === "hs" ? hsRadiusMiles || radiusMilesForAnswers(answers.max) : parseFloat(answers.max || "30");

  const resDial: DialPoint[] = useMemo(() => {
    if (!results || !user?.lat) return [];
    const lim = effectiveLim;
    const withB: DialPoint[] = results.map((c) => ({
      label: c.title,
      d: c.d,
      b: c.lat === null || c.lng === null ? 0 : bearing(user.lat!, user.lng!, c.lat, c.lng),
      lim,
    }));
    withB.slice(0, 25).forEach((c) => (c.top = true));
    return withB;
  }, [results, user, effectiveLim]);

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
          <button className="brand" onClick={() => go("landing")} aria-label="Internship Hub home">
            {/* A location pin, not an abstract mark — the whole product is "find internships
                near you," so the logo doubles as a tiny map pin with a glowing waypoint. */}
            <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M12 2C7.86 2 4.5 5.36 4.5 9.5c0 5.25 6.18 11.28 6.98 12.02a.78.78 0 0 0 1.04 0C13.32 20.78 19.5 14.75 19.5 9.5 19.5 5.36 16.14 2 12 2z"
                fill="var(--accent)"
              />
              <circle cx="12" cy="9.5" r="3.3" fill="var(--paper)" />
              <circle cx="12" cy="9.5" r="1.4" fill="var(--lime)" />
            </svg>
            Internship Hub
          </button>
          {user && (
            <div className="who">
              <span className="avatar" style={avatarStyle(user.name)} aria-hidden="true">
                {initial(user.name)}
              </span>
              <span className="who-name">{user.name}</span>
              <button className="linkbtn" onClick={handleSignOut}>
                Sign out
              </button>
            </div>
          )}
        </div>
      </header>

      {view === "landing" && (
        <main className="wrap">
          <section className="hero">
            <div className="hero-text">
              <div className="kicker">
                <span className="dotpulse" /> For students looking for their first internship
              </div>
              <h1>
                Internships you can
                <br />
                actually <span className="accent-text">get to.</span>
              </h1>
              <p className="hero-sub">
                Nine quick questions. We search real, live listings worldwide — or, for high schoolers, real nearby
                businesses worth a cold pitch — and rank everything by how you&apos;d actually get there.
              </p>
              <button className="btn" onClick={() => go(user ? "q" : "auth")}>
                Get started
              </button>
              <div className="hero-note">Free. Two minutes. No internship experience required.</div>
            </div>

            <div className="role-strip">
              {["Marketing", "Engineering", "Design", "Data", "Trades", "Healthcare", "Hospitality", "Retail"].map((r) => (
                <span key={r} className="role-chip">
                  {r}
                </span>
              ))}
            </div>

            <div className="hero-mockup-wrap">
              <div className="mockup-card" aria-hidden="true">
                <div className="mockup-titlebar">
                  <span className="mockup-dot" style={{ background: "#ff8577" }} />
                  <span className="mockup-dot" style={{ background: "#ffcf6b" }} />
                  <span className="mockup-dot" style={{ background: "#7ee2a8" }} />
                  <span className="mockup-titletext">Your shortlist</span>
                </div>
                <div className="mockup-body">
                  <div className="mockup-stats">
                    <div className="mockup-stat">
                      <b>34</b>
                      <span>Total matches</span>
                    </div>
                    <div className="mockup-stat">
                      <b>21</b>
                      <span>Within range</span>
                    </div>
                    <div className="mockup-stat">
                      <b>6</b>
                      <span>A stretch</span>
                    </div>
                    <div className="mockup-stat pop">
                      <b>92</b>
                      <span>Best score</span>
                    </div>
                  </div>
                  {[
                    { n: "Nova Robotics", role: "Engineering intern", d: "2 mi", s: 92 },
                    { n: "Fernview Studio", role: "Marketing intern", d: "4 mi", s: 89 },
                    { n: "BrightPath Clinic", role: "Healthcare intern", d: "1 mi", s: 85 },
                  ].map((r) => (
                    <div className="mockup-row" key={r.n}>
                      <span className="mockup-avatar" style={avatarStyle(r.n)}>
                        {initial(r.n)}
                      </span>
                      <span className="mockup-row-text">
                        <b>{r.role}</b>
                        <span>
                          {r.n} · {r.d}
                        </span>
                      </span>
                      <span className="mockup-score">{r.s}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="float-badge a">📍 Ranked by real distance</div>
              <div className="float-badge b">✉️ Ready-to-send outreach email</div>
            </div>
          </section>

          <div className="steps">
            <div className="steps-head">
              <h2>How it works</h2>
              <p>No login required to try it, no recruiter spam after.</p>
            </div>
            <div className="step-grid">
              <div className="step-card">
                <div className="step-num">STEP 01</div>
                <div className="ficon" style={{ background: "var(--accent-soft)" }}>
                  <svg width="17" height="17" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                    <path d="M4 6h12M4 10h12M4 14h8" stroke="var(--accent-2)" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                </div>
                <h3>Answer nine quick questions</h3>
                <p>Where you are, how far you&apos;ll go, how you get there, and what you want to do. Two minutes.</p>
              </div>
              <div className="step-card">
                <div className="step-num">STEP 02</div>
                <div className="ficon" style={{ background: "var(--lime-soft)" }}>
                  <svg width="17" height="17" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                    <circle cx="10" cy="10" r="7.5" stroke="var(--lime-ink)" strokeWidth="2" />
                    <path d="M2.5 10h15M10 2.5c2.5 2 2.5 13 0 15M10 2.5c-2.5 2-2.5 13 0 15" stroke="var(--lime-ink)" strokeWidth="1.4" />
                  </svg>
                </div>
                <h3>We search live, worldwide</h3>
                <p>Real internship listings ranked by distance and fit — or, for high schoolers, real nearby businesses worth pitching.</p>
              </div>
              <div className="step-card">
                <div className="step-num">STEP 03</div>
                <div className="ficon" style={{ background: "var(--line-2)" }}>
                  <svg width="17" height="17" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                    <path
                      d="M10 18s6-5.2 6-9.6A6 6 0 0 0 4 8.4C4 12.8 10 18 10 18Z"
                      stroke="var(--ink-2)"
                      strokeWidth="2"
                      strokeLinejoin="round"
                    />
                    <circle cx="10" cy="8.4" r="2" stroke="var(--ink-2)" strokeWidth="2" />
                  </svg>
                </div>
                <h3>Get a ranked shortlist</h3>
                <p>Apply directly, or use a ready-to-personalize outreach email for businesses with no posted opening.</p>
              </div>
            </div>
          </div>
        </main>
      )}

      {view === "auth" && (
        <main className="wrap">
          <div className="auth">
            <div className="auth-split">
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
                  <input id="nm" type="text" placeholder="Jordan Lee" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
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

              <div className="auth-side">
                <h3>What you get</h3>
                <ul className="check-list">
                  <li>
                    <span className="checkdot">✓</span>
                    Real, live listings searched worldwide the moment you finish — not a stale database.
                  </li>
                  <li>
                    <span className="checkdot">✓</span>
                    Everything ranked by how you&apos;d actually get there: drive, ride, transit, or remote.
                  </li>
                  <li>
                    <span className="checkdot">✓</span>
                    High schoolers get real nearby businesses to cold-pitch, with a ready-to-send email — not fake
                    listings that require a college degree.
                  </li>
                  <li>
                    <span className="checkdot">✓</span>
                    One click to apply, or a drafted email when there&apos;s no application link.
                  </li>
                </ul>
              </div>
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
                <h2>{answers.stage === "hs" ? "Businesses worth pitching" : "Your shortlist"}</h2>
                <p className="note" style={{ marginTop: 6 }}>
                  {answers.stage === "hs"
                    ? `${results.length} real businesses within ${effectiveLim} miles of ${hsCity || answers.loc!.label}.`
                    : coverage
                      ? `${results.length} live listings ranked from ${answers.loc!.label}.`
                      : `We don't have live coverage for ${answers.loc!.label} yet — coverage today is the US, UK, Canada, Australia, and about a dozen more countries, mostly in Europe.`}
                </p>
                {answers.stage === "hs" && (
                  <p className="note" style={{ marginTop: 4 }}>
                    Real internships open to high schoolers are almost nonexistent as formal job postings, so instead
                    of listings, these are actual nearby businesses matched to what you&apos;re interested in. None
                    of them have a posted opening — tap one for the full pitch and a sample cold email.
                  </p>
                )}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="btn ghost sm" onClick={() => go("q", 0)}>
                  Change answers
                </button>
                <button className="btn ghost sm" onClick={() => csvDownload(results)}>
                  Download CSV
                </button>
              </div>
            </div>

            {results.length > 0 ? (
              <div className="res-grid">
                <aside className="res-side">
                  <ResultsStats results={results} lim={effectiveLim} />

                  <div className="dialrow">
                    <Dial list={resDial} size={Math.min(resDialSize, 240)} />
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
                </aside>

                <div className="list">
                  {sortedList.map((c, i) => (
                    <ResultRow
                      key={c.id}
                      c={c}
                      rank={i + 1}
                      lead={i < 3 && tab === 0}
                      band={band(c.d, effectiveLim)}
                      lim={effectiveLim}
                      onContact={setContactFor}
                    />
                  ))}
                </div>
              </div>
            ) : (
              <div className="list">
                <div className="empty">
                  {answers.stage === "hs"
                    ? "Couldn't find nearby businesses matching this — try widening the distance on question 2, or a bigger nearby city."
                    : !coverage
                      ? "Try a city in a country we have live coverage for."
                      : "Nothing matched. Try widening the distance on question 2, or a bigger nearby city."}
                </div>
              </div>
            )}
          </div>
        </main>
      )}

      {view === "res" && (
        <footer>
        <div className="wrap">
          {answers.stage === "hs" ? (
            <>
              High-school results come from OpenStreetMap&apos;s real, open business data, re-fetched every time you
              run the questionnaire — not a static dataset. None of these businesses posted an opening; every one is
              a suggested cold-outreach target based on distance and your stated interests, not a confirmed job.
              Contact details (phone, website, email) are whatever that business has published publicly and may be
              out of date — double-check before reaching out.
            </>
          ) : (
            <>
              Listings come from a live jobs-search API and are re-fetched every time you run the questionnaire — not
              a static dataset. Distance uses the listing&apos;s stated location, with a real driving route where we
              could get one and a straight-line estimate otherwise. &quot;Remote / hybrid / in person&quot; and pay
              are read from the listing text automatically and can be wrong — check the actual posting before you
              apply. Live coverage is currently limited to a set of countries, mostly the US, UK, Canada, Australia,
              and Western Europe.
            </>
          )}
        </div>
        </footer>
      )}

      {contactFor && <ContactModal listing={contactFor} onClose={() => setContactFor(null)} />}
    </>
  );
}

function StatCard({ icon, iconBg, value, label }: { icon: ReactNode; iconBg: string; value: number | string; label: string }) {
  return (
    <div className="statcard">
      <div className="icon" style={{ background: iconBg }}>
        {icon}
      </div>
      <b>{value}</b>
      <span>{label}</span>
    </div>
  );
}

function ResultsStats({ results, lim }: { results: ScoredListing[]; lim: number }) {
  const near = results.filter((c) => c.d !== null && c.d <= lim).length;
  const mid = results.filter((c) => c.d !== null && c.d > lim && c.d <= lim * 2).length;
  const rem = results.filter((c) => c.d === null).length;
  const best = results.length ? results[0].s : 0;
  return (
    <div className="statcards">
      <StatCard
        iconBg="var(--line-2)"
        icon={
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <rect x="3" y="6" width="14" height="10" rx="2" stroke="var(--ink-2)" strokeWidth="1.8" />
            <path d="M7 6V5a3 3 0 0 1 6 0v1" stroke="var(--ink-2)" strokeWidth="1.8" />
          </svg>
        }
        value={results.length}
        label="Total matches"
      />
      <StatCard
        iconBg="var(--accent-soft)"
        icon={
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path
              d="M10 18s6-5.2 6-9.6A6 6 0 0 0 4 8.4C4 12.8 10 18 10 18Z"
              stroke="var(--accent-2)"
              strokeWidth="1.8"
              strokeLinejoin="round"
            />
            <circle cx="10" cy="8.4" r="1.8" stroke="var(--accent-2)" strokeWidth="1.8" />
          </svg>
        }
        value={near}
        label={`Within ${lim} miles`}
      />
      <StatCard
        iconBg="var(--line-2)"
        icon={
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <circle cx="10" cy="10" r="7" stroke="var(--ink-2)" strokeWidth="1.8" />
            <path d="M10 6v4l3 2" stroke="var(--ink-2)" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        }
        value={mid + rem}
        label={rem > 0 ? "A stretch or remote" : "A stretch"}
      />
      <StatCard
        iconBg="var(--lime-soft)"
        icon={
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path
              d="M10 2.5l2.2 4.6 5 .7-3.6 3.6.9 5-4.5-2.4-4.5 2.4.9-5-3.6-3.6 5-.7L10 2.5Z"
              stroke="var(--lime-ink)"
              strokeWidth="1.6"
              strokeLinejoin="round"
            />
          </svg>
        }
        value={best}
        label="Best score"
      />
    </div>
  );
}
