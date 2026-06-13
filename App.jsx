import { useState, useEffect, useMemo, useRef } from "react";

// ---------------- Storage keys (shared across the whole friend group) ----------------
const K_PLAYERS = "wcpg:players";
const K_MATCHES = "wcpg:matches";
const K_SYNC = "wcpg:lastsync";
const PRED_PREFIX = "wcpg:pred:";

const uid = () => Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);

const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const norm = (s) =>
  (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z]/g, "");


// ---------------- Browser storage polyfill ----------------
// Claude Artifacts provides window.storage. Normal web hosting does not.
// This fallback uses localStorage so the app can run online as a static app.
// Note: localStorage is per browser/device, not shared across all friends.
if (typeof window !== "undefined" && !window.storage) {
  window.storage = {
    async get(key) {
      const value = window.localStorage.getItem(key);
      return value == null ? null : { value };
    },
    async set(key, value) {
      window.localStorage.setItem(key, value);
      return true;
    },
    async delete(key) {
      window.localStorage.removeItem(key);
      return true;
    },
    async list(prefix = "") {
      const keys = [];
      for (let i = 0; i < window.localStorage.length; i++) {
        const key = window.localStorage.key(i);
        if (key && key.startsWith(prefix)) keys.push(key);
      }
      return { keys };
    },
  };
}

// ---------------- Scoring: exact = 3 pts, outcome = 1 pt ----------------
const outcome = (h, a) => (h > a ? "H" : a > h ? "A" : "D");
function scorePrediction(pred, match) {
  if (!match.finished || pred == null || pred.h === "" || pred.a === "") return null;
  const ph = +pred.h, pa = +pred.a, mh = +match.homeScore, ma = +match.awayScore;
  if (ph === mh && pa === ma) return 3;
  if (outcome(ph, pa) === outcome(mh, ma)) return 1;
  return 0;
}

// ---------------- Storage helpers ----------------
async function loadJSON(key, fallback) {
  try {
    const r = await window.storage.get(key, true);
    return r ? JSON.parse(r.value) : fallback;
  } catch { return fallback; }
}
async function saveJSON(key, value) {
  try { await window.storage.set(key, JSON.stringify(value), true); return true; }
  catch { return false; }
}

// ---------------- OpenAI API helper ----------------
async function askAI(prompt, { search = false } = {}) {
  const res = await fetch("/api/ai", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, search }),
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(data.error || "AI request failed");
  }

  return data.text;
}
function parseJSONReply(text) {
  const clean = text.replace(/```json|```/g, "").trim();
  const start = Math.min(...["[", "{"].map((c) => { const i = clean.indexOf(c); return i === -1 ? Infinity : i; }));
  if (start === Infinity) throw new Error("No JSON in reply");
  return JSON.parse(clean.slice(start));
}

// ---------------- Image resize (square avatar, ~96px JPEG) ----------------
function resizePhoto(file, size = 96) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = c.height = size;
      const ctx = c.getContext("2d");
      const s = Math.min(img.width, img.height);
      ctx.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL("image/jpeg", 0.82));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Couldn't read image")); };
    img.src = url;
  });
}
function fileToBase64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result.split(",")[1]);
    r.onerror = () => rej(new Error("Read failed"));
    r.readAsDataURL(file);
  });
}

// =======================================================================
export default function PredictionGame() {
  const [tab, setTab] = useState("today");
  const [players, setPlayers] = useState([]);
  const [matches, setMatches] = useState([]);
  const [preds, setPreds] = useState({});
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState("");
  const [syncState, setSyncState] = useState({ running: false, last: null, msg: "" });
  const syncedOnce = useRef(false);

  const flash = (msg) => { setToast(msg); setTimeout(() => setToast(""), 3000); };

  // ---------- Initial load ----------
  useEffect(() => {
    (async () => {
      const [pl, ma, sync] = await Promise.all([
        loadJSON(K_PLAYERS, []),
        loadJSON(K_MATCHES, []),
        loadJSON(K_SYNC, null),
      ]);
      setPlayers(pl);
      setMatches(ma);
      setSyncState((s) => ({ ...s, last: sync }));
      const all = {};
      try {
        const listed = await window.storage.list(PRED_PREFIX, true);
        const keys = (listed?.keys || []).map((k) => (typeof k === "string" ? k : k.key));
        await Promise.all(keys.map(async (k) => {
          try {
            const r = await window.storage.get(k, true);
            if (r) all[k.slice(PRED_PREFIX.length)] = JSON.parse(r.value);
          } catch {}
        }));
      } catch {}
      setPreds(all);
      setLoading(false);
    })();
  }, []);

  // ---------- Auto result sync on open (if stale > 60 min & pending matches) ----------
  useEffect(() => {
    if (loading || syncedOnce.current) return;
    syncedOnce.current = true;
    const pending = matches.filter((m) => !m.finished && m.date && m.date <= todayStr());
    const stale = !syncState.last || Date.now() - syncState.last > 60 * 60 * 1000;
    if (pending.length && stale) syncResults(matches);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  // ---------- Mutations ----------
  const savePlayers = async (next, msg) => {
    setPlayers(next);
    const ok = await saveJSON(K_PLAYERS, next);
    if (msg) flash(ok ? msg : "Couldn't save — try again");
  };
  const saveMatches = async (next, msg) => {
    setMatches(next);
    const ok = await saveJSON(K_MATCHES, next);
    if (msg) flash(ok ? msg : "Couldn't save — try again");
  };
  const savePredsFor = async (playerId, map, msg = "Predictions saved") => {
    const np = { ...preds, [playerId]: map };
    setPreds(np);
    const ok = await saveJSON(PRED_PREFIX + playerId, map);
    flash(ok ? msg : "Couldn't save — try again");
  };
  const removePlayer = async (id) => {
    await savePlayers(players.filter((p) => p.id !== id), "Player removed");
    try { await window.storage.delete(PRED_PREFIX + id, true); } catch {}
    const np = { ...preds }; delete np[id]; setPreds(np);
  };

  // ---------- Auto result sync via Claude + web search ----------
  async function syncResults(currentMatches = matches) {
    const pending = currentMatches.filter((m) => !m.finished && m.date && m.date <= todayStr());
    if (!pending.length) { setSyncState((s) => ({ ...s, msg: "No pending matches to score" })); return; }
    setSyncState((s) => ({ ...s, running: true, msg: "Checking latest results…" }));
    try {
      const list = pending.slice(0, 25).map((m) => `{"id":"${m.id}","match":"${m.home} vs ${m.away}","date":"${m.date}"}`).join("\n");
      const prompt =
        `Today is ${todayStr()}. Search the web for the FINAL scores of these FIFA World Cup 2026 matches:\n${list}\n\n` +
        `Respond ONLY with a JSON array, no other text, no markdown. Format: [{"id":"...","h":2,"a":1}] ` +
        `where h is the home team's final score and a is the away team's. ` +
        `Include ONLY matches that are fully finished with a confirmed final score from a reliable source. ` +
        `If none have finished, respond with [].`;
      const reply = await askClaude(prompt, { search: true });
      const results = parseJSONReply(reply);
      let updated = 0;
      const next = currentMatches.map((m) => {
        const r = Array.isArray(results) && results.find((x) => x.id === m.id);
        if (r && Number.isInteger(r.h) && Number.isInteger(r.a) && !m.finished) {
          updated++;
          return { ...m, homeScore: String(r.h), awayScore: String(r.a), finished: true, auto: true };
        }
        return m;
      });
      const now = Date.now();
      await saveJSON(K_SYNC, now);
      if (updated) {
        await saveMatches(next, `${updated} result${updated > 1 ? "s" : ""} updated — leaderboard recalculated`);
      }
      setSyncState({ running: false, last: now, msg: updated ? `${updated} new result${updated > 1 ? "s" : ""}` : "No new finished matches yet" });
    } catch (e) {
      setSyncState((s) => ({ ...s, running: false, msg: "Sync failed — tap refresh to retry" }));
    }
  }

  // ---------- Import upcoming official fixtures via Claude + web search ----------
  async function importSchedule() {
    setSyncState((s) => ({ ...s, running: true, msg: "Fetching official fixtures…" }));
    try {
      const prompt =
        `Today is ${todayStr()}. Search the web for the official FIFA World Cup 2026 match schedule for the next 7 days (${todayStr()} onward). ` +
        `Respond ONLY with a JSON array, no other text, no markdown. Format: ` +
        `[{"home":"Team","away":"Team","date":"YYYY-MM-DD","time":"HH:MM","stage":"Group"}]. ` +
        `Times in US Eastern Time, 24h format. Use a reliable source like fifa.com. Max 25 matches.`;
      const reply = await askClaude(prompt, { search: true });
      const list = parseJSONReply(reply);
      const existing = new Set(matches.map((m) => norm(m.home) + norm(m.away) + m.date));
      const added = (Array.isArray(list) ? list : [])
        .filter((f) => f.home && f.away && f.date && !existing.has(norm(f.home) + norm(f.away) + f.date))
        .map((f) => ({ id: uid(), home: f.home, away: f.away, date: f.date, time: f.time || "", stage: f.stage || "Group", homeScore: "", awayScore: "", finished: false }));
      if (added.length) await saveMatches([...matches, ...added], `${added.length} fixtures imported`);
      setSyncState((s) => ({ ...s, running: false, msg: added.length ? `${added.length} fixtures added` : "No new fixtures found" }));
    } catch {
      setSyncState((s) => ({ ...s, running: false, msg: "Import failed — try again" }));
    }
  }

  // ---------- Leaderboard ----------
  const board = useMemo(() => {
    const rows = players.map((p) => {
      let pts = 0, exact = 0, outcomeHits = 0;
      for (const m of matches) {
        const s = scorePrediction(preds[p.id]?.[m.id], m);
        if (s === null) continue;
        pts += s;
        if (s === 3) exact++; else if (s === 1) outcomeHits++;
      }
      return { ...p, pts, exact, outcomeHits };
    });
    rows.sort((a, b) => b.pts - a.pts || b.exact - a.exact || a.name.localeCompare(b.name));
    let rank = 0, lp = null, le = null;
    rows.forEach((r, i) => {
      if (r.pts !== lp || r.exact !== le) { rank = i + 1; lp = r.pts; le = r.exact; }
      r.rank = rank;
    });
    return rows;
  }, [players, matches, preds]);

  const sortedMatches = useMemo(
    () => [...matches].sort((a, b) => ((a.date || "") + (a.time || "")).localeCompare((b.date || "") + (b.time || ""))),
    [matches]
  );
  const todays = useMemo(() => sortedMatches.filter((m) => m.date === todayStr()), [sortedMatches]);

  if (loading) {
    return (
      <div className="wcpg wcpg-loading"><Style /><div className="loadbox">LOADING THE PITCH…</div></div>
    );
  }

  return (
    <div className="wcpg">
      <Style />
      <header className="hero">
        <div className="hero-eyebrow">WORLD CUP 2026 · FRIENDS LEAGUE</div>
        <h1 className="hero-title">PREDICTION<span className="gold"> GAME</span></h1>
        <div className="syncline">
          <span className={"dot" + (syncState.running ? " spin" : "")} />
          <span>{syncState.running ? syncState.msg : syncState.last ? `Results checked ${timeAgo(syncState.last)}` : "Results not synced yet"}</span>
          <button className="linklike" disabled={syncState.running} onClick={() => syncResults()}>Refresh</button>
        </div>
      </header>

      <nav className="tabs">
        {[["today", "Today's Matches"], ["table", "Leaderboard"], ["matches", "Matches"], ["pdf", "Upload PDF"], ["squad", "Players"]].map(([id, label]) => (
          <button key={id} className={"tab" + (tab === id ? " on" : "")} onClick={() => setTab(id)}>{label}</button>
        ))}
      </nav>

      <main className="panel">
        {tab === "today" && <Today todays={todays} players={players} preds={preds} goMatches={() => setTab("matches")} />}
        {tab === "table" && <Leaderboard board={board} matches={matches} />}
        {tab === "matches" && (
          <Matches matches={sortedMatches} onSave={saveMatches} onImport={importSchedule} busy={syncState.running} />
        )}
        {tab === "pdf" && (
          <PdfUpload players={players} matches={sortedMatches} preds={preds} onSave={savePredsFor} />
        )}
        {tab === "squad" && <Squad players={players} onSave={savePlayers} onRemove={removePlayer} />}
      </main>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function timeAgo(ts) {
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

// =================== Avatar ===================
function Avatar({ player, size = 36 }) {
  const initials = (player.name || "?").split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
  return player.photo ? (
    <img className="avatar" src={player.photo} alt={player.name} style={{ width: size, height: size }} />
  ) : (
    <span className="avatar fallback" style={{ width: size, height: size, fontSize: size * 0.38 }}>{initials}</span>
  );
}

// =================== Today's Matches ===================
function Today({ todays, players, preds, goMatches }) {
  if (todays.length === 0)
    return <Empty title="No matches today" body="Nothing scheduled for today. Add fixtures (or import the official schedule) on the Matches tab." action={<button className="btn gold-btn" onClick={goMatches}>Go to Matches</button>} />;
  return (
    <div className="fixtures">
      {todays.map((m) => (
        <div key={m.id} className={"fixture today-card" + (m.finished ? " done" : "")}>
          <div className="fx-meta">
            <span className="fx-stage">{m.stage}</span>
            {m.time && <span className="fx-time">⏱ {m.time}</span>}
            {m.finished && <span className="pill p3">FINAL</span>}
          </div>
          <div className="fx-line big">
            <span className="fx-team h">{m.home}</span>
            <span className="fx-vs">{m.finished ? `${m.homeScore}–${m.awayScore}` : "vs"}</span>
            <span className="fx-team a">{m.away}</span>
          </div>
          <div className="guesses">
            <div className="guesses-title">Our guesses</div>
            {players.length === 0 && <div className="hint">No players yet — add them on the Players tab.</div>}
            <div className="guess-grid">
              {players.map((p) => {
                const pr = preds[p.id]?.[m.id];
                const pts = scorePrediction(pr, m);
                const cls = pts === 3 ? "g3" : pts === 1 ? "g1" : pts === 0 ? "g0" : "";
                return (
                  <div key={p.id} className={"guess " + cls}>
                    <Avatar player={p} size={28} />
                    <span className="guess-name">{p.name.split(" ")[0]}</span>
                    <span className="guess-score">{pr && pr.h !== "" && pr.a !== "" ? `${pr.h}–${pr.a}` : "—"}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// =================== Leaderboard ===================
function Leaderboard({ board, matches }) {
  const played = matches.filter((m) => m.finished).length;
  if (board.length === 0)
    return <Empty title="No players yet" body="Create the profiles on the Players tab, then upload everyone's PDF." />;
  return (
    <div>
      <div className="section-note">{played} of {matches.length} matches scored · Exact score 3 pts · Correct outcome 1 pt</div>
      <div className="scoreboard">
        <div className="sb-row sb-head"><span>#</span><span>Player</span><span>Exact</span><span>Outcome</span><span>PTS</span></div>
        {board.map((r) => (
          <div key={r.id} className={"sb-row" + (r.rank === 1 && r.pts > 0 ? " leader" : "")}>
            <span className="sb-rank">{r.rank}</span>
            <span className="sb-name"><Avatar player={r} size={34} /><span>{r.name}{r.rank === 1 && r.pts > 0 ? " 🏆" : ""}</span></span>
            <span className="sb-num">{r.exact}</span>
            <span className="sb-num">{r.outcomeHits}</span>
            <span className="sb-pts">{r.pts}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// =================== Matches ===================
function Matches({ matches, onSave, onImport, busy }) {
  const [home, setHome] = useState(""); const [away, setAway] = useState("");
  const [date, setDate] = useState(""); const [time, setTime] = useState("");
  const [stage, setStage] = useState("Group");
  const [scoreDraft, setScoreDraft] = useState({});

  const add = () => {
    if (!home.trim() || !away.trim()) return;
    onSave([...matches, { id: uid(), home: home.trim(), away: away.trim(), date, time, stage, homeScore: "", awayScore: "", finished: false }],
      `${home.trim()} vs ${away.trim()} added`);
    setHome(""); setAway(""); setDate(""); setTime("");
  };
  const draftFor = (m) => scoreDraft[m.id] ?? { h: m.homeScore, a: m.awayScore };
  const setResult = (id, side, value) =>
    setScoreDraft((d) => {
      const m = matches.find((x) => x.id === id);
      const cur = d[id] ?? { h: m.homeScore, a: m.awayScore };
      return { ...d, [id]: { ...cur, [side]: value } };
    });
  const toggleFinal = (m) => {
    const d = draftFor(m);
    if (!m.finished && (d.h === "" || d.a === "")) return;
    onSave(matches.map((x) => x.id === m.id ? { ...x, homeScore: d.h, awayScore: d.a, finished: !m.finished, auto: false } : x),
      m.finished ? "Result reopened" : "Result locked in — leaderboard updated");
  };
  const remove = (id) => onSave(matches.filter((m) => m.id !== id), "Match removed");

  return (
    <div>
      <div className="card form">
        <div className="card-title">Official schedule</div>
        <p className="hint" style={{ marginTop: 0 }}>Pulls the next 7 days of World Cup fixtures from the web (US Eastern times). Run it weekly.</p>
        <button className="btn gold-btn" onClick={onImport} disabled={busy}>{busy ? "Working…" : "Import upcoming fixtures"}</button>
      </div>

      <div className="card form">
        <div className="card-title">Add a match manually</div>
        <div className="form-grid">
          <input placeholder="Home team" value={home} onChange={(e) => setHome(e.target.value)} />
          <input placeholder="Away team" value={away} onChange={(e) => setAway(e.target.value)} />
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          <select value={stage} onChange={(e) => setStage(e.target.value)}>
            {["Group", "Round of 32", "Round of 16", "Quarter-final", "Semi-final", "Third place", "Final"].map((s) => <option key={s}>{s}</option>)}
          </select>
          <button className="btn gold-btn" onClick={add}>Add</button>
        </div>
      </div>

      {matches.length === 0 ? (
        <Empty title="No matches yet" body="Import the official fixtures above, or add matches manually." />
      ) : (
        <div className="fixtures">
          {matches.map((m) => {
            const d = draftFor(m);
            return (
              <div key={m.id} className={"fixture" + (m.finished ? " done" : "")}>
                <div className="fx-meta">
                  <span className="fx-stage">{m.stage}</span>
                  {m.date && <span className="fx-date">{m.date}{m.time ? ` · ${m.time}` : ""}</span>}
                  {m.finished && m.auto && <span className="pill px">auto result</span>}
                </div>
                <div className="fx-line">
                  <span className="fx-team h">{m.home}</span>
                  <span className="fx-score">
                    <input type="number" min="0" inputMode="numeric" value={m.finished ? m.homeScore : d.h}
                      disabled={m.finished} onChange={(e) => setResult(m.id, "h", e.target.value)} />
                    <em>–</em>
                    <input type="number" min="0" inputMode="numeric" value={m.finished ? m.awayScore : d.a}
                      disabled={m.finished} onChange={(e) => setResult(m.id, "a", e.target.value)} />
                  </span>
                  <span className="fx-team a">{m.away}</span>
                </div>
                <div className="fx-actions">
                  <button className={"btn small " + (m.finished ? "" : "gold-btn")} onClick={() => toggleFinal(m)}
                    disabled={!m.finished && (d.h === "" || d.a === "")}>
                    {m.finished ? "Reopen" : "Mark final"}
                  </button>
                  <button className="btn small danger" onClick={() => remove(m.id)}>Remove</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// =================== PDF Upload ===================
function PdfUpload({ players, matches, preds, onSave }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null); // { detectedName, picks: [{id,h,a}] }
  const [who, setWho] = useState("");
  const fileRef = useRef();

  const open = matches.length > 0;

  async function handleFile(file) {
    if (!file) return;
    setBusy(true); setError(""); setResult(null);
    try {
      const b64 = await fileToBase64(file);
      const matchList = matches.map((m) => `{"id":"${m.id}","home":"${m.home}","away":"${m.away}","date":"${m.date || ""}"}`).join("\n");
      const reply = await askClaude([
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } },
        { type: "text", text:
          `This PDF is a friend's World Cup prediction sheet. Here is our official match list:\n${matchList}\n\n` +
          `Extract the person's name (if written) and their predicted score for each match you can match to the list. ` +
          `Match teams even if spelled slightly differently or in another language. ` +
          `Respond ONLY with JSON, no other text, no markdown: ` +
          `{"name":"detected name or empty string","picks":[{"id":"match id from the list","h":home goals,"a":away goals}]}` },
      ]);
      const parsed = parseJSONReply(reply);
      const valid = (parsed.picks || []).filter((p) => matches.some((m) => m.id === p.id) && Number.isInteger(p.h) && Number.isInteger(p.a));
      if (!valid.length) throw new Error("No predictions matched our fixture list. Check that the matches exist on the Matches tab.");
      setResult({ detectedName: parsed.name || "", picks: valid });
      // auto-select the player if the detected name matches
      const hit = players.find((pl) => norm(pl.name).includes(norm(parsed.name)) || norm(parsed.name).includes(norm(pl.name)));
      setWho(hit ? hit.id : "");
    } catch (e) {
      setError(e.message || "Couldn't read that PDF — try again.");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function confirm() {
    if (!who || !result) return;
    const map = { ...(preds[who] || {}) };
    for (const p of result.picks) map[p.id] = { h: String(p.h), a: String(p.a) };
    await onSave(who, map, `${result.picks.length} predictions saved for ${players.find((x) => x.id === who)?.name}`);
    setResult(null); setWho("");
  }

  return (
    <div>
      <div className="card form">
        <div className="card-title">Upload a prediction PDF</div>
        {!open ? (
          <p className="hint" style={{ margin: 0 }}>Add the fixtures first (Matches tab) so the predictions have something to attach to.</p>
        ) : (
          <>
            <p className="hint" style={{ marginTop: 0 }}>
              Upload one filled PDF at a time. The sheet is read automatically and each guess is matched to a fixture — you confirm before anything is saved.
            </p>
            <input ref={fileRef} type="file" accept="application/pdf" disabled={busy}
              onChange={(e) => handleFile(e.target.files?.[0])} />
            {busy && <div className="hint">Reading the PDF and matching predictions… this takes a few seconds.</div>}
            {error && <div className="error">{error}</div>}
          </>
        )}
      </div>

      {result && (
        <div className="card">
          <div className="card-title">Review before saving</div>
          <div className="form-grid two" style={{ marginBottom: 12 }}>
            <select value={who} onChange={(e) => setWho(e.target.value)}>
              <option value="">— whose predictions are these? —</option>
              {players.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <button className="btn gold-btn" onClick={confirm} disabled={!who}>Save {result.picks.length} picks</button>
          </div>
          {result.detectedName && <div className="hint">Name on the sheet: <b>{result.detectedName}</b></div>}
          <div className="preview">
            {result.picks.map((p) => {
              const m = matches.find((x) => x.id === p.id);
              return <div key={p.id} className="preview-row"><span>{m.home} v {m.away}</span><b>{p.h}–{p.a}</b></div>;
            })}
          </div>
        </div>
      )}

      {players.length > 0 && matches.length > 0 && (
        <div className="card">
          <div className="card-title">Everyone's picks so far</div>
          <div className="compare-wrap">
            <table className="compare">
              <thead>
                <tr><th className="sticky">Match</th>{players.map((p) => <th key={p.id}>{p.name.split(" ")[0]}</th>)}<th>Final</th></tr>
              </thead>
              <tbody>
                {matches.map((m) => (
                  <tr key={m.id}>
                    <td className="sticky match-cell"><span>{m.home} v {m.away}</span>{m.date && <small>{m.date}</small>}</td>
                    {players.map((p) => {
                      const pr = preds[p.id]?.[m.id];
                      const pts = scorePrediction(pr, m);
                      const cls = pts === 3 ? "c3" : pts === 1 ? "c1" : pts === 0 ? "c0" : "";
                      return <td key={p.id} className={cls}>{pr && pr.h !== "" && pr.a !== "" ? `${pr.h}–${pr.a}` : "·"}</td>;
                    })}
                    <td className="final-cell">{m.finished ? `${m.homeScore}–${m.awayScore}` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// =================== Players ===================
function Squad({ players, onSave, onRemove }) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [photo, setPhoto] = useState("");
  const [err, setErr] = useState("");
  const photoRef = useRef();

  async function pickPhoto(file) {
    if (!file) return;
    try { setPhoto(await resizePhoto(file)); setErr(""); }
    catch { setErr("Couldn't read that photo — try a different image."); }
  }

  const add = () => {
    const clean = name.trim();
    if (!clean) return;
    if (players.some((p) => p.name.toLowerCase() === clean.toLowerCase())) { setErr("That name is already on the roster"); return; }
    onSave([...players, { id: uid(), name: clean, phone: phone.trim(), photo }], `${clean} joined the game`);
    setName(""); setPhone(""); setPhoto(""); setErr("");
    if (photoRef.current) photoRef.current.value = "";
  };

  async function changePhoto(playerId, file) {
    if (!file) return;
    try {
      const data = await resizePhoto(file);
      onSave(players.map((p) => (p.id === playerId ? { ...p, photo: data } : p)), "Photo updated");
    } catch { setErr("Couldn't read that photo"); }
  }

  return (
    <div>
      <div className="card form">
        <div className="card-title">Create a player profile</div>
        <p className="hint" style={{ marginTop: 0 }}>Heads up: profiles (including phone numbers) are visible to everyone who has the app link.</p>
        <div className="form-grid three">
          <input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
          <input placeholder="Phone (optional)" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
          <label className="filebtn">
            {photo ? <img src={photo} alt="preview" className="avatar" style={{ width: 28, height: 28 }} /> : "📷"} Photo
            <input ref={photoRef} type="file" accept="image/*" hidden onChange={(e) => pickPhoto(e.target.files?.[0])} />
          </label>
          <button className="btn gold-btn" onClick={add}>Add player</button>
        </div>
        {err && <div className="error">{err}</div>}
      </div>

      {players.length === 0 ? (
        <Empty title="Empty roster" body="Create each friend's profile — name, phone, and a photo for the leaderboard." />
      ) : (
        <div className="roster">
          {players.map((p) => (
            <div key={p.id} className="roster-row">
              <Avatar player={p} size={42} />
              <div className="roster-info">
                <span className="roster-name">{p.name}</span>
                {p.phone && <a className="roster-phone" href={`tel:${p.phone}`}>{p.phone}</a>}
              </div>
              <label className="btn small filelabel">
                {p.photo ? "Change photo" : "Add photo"}
                <input type="file" accept="image/*" hidden onChange={(e) => changePhoto(p.id, e.target.files?.[0])} />
              </label>
              <button className="btn small danger" onClick={() => { if (confirm(`Remove ${p.name} and all their predictions?`)) onRemove(p.id); }}>Remove</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Empty({ title, body, action }) {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      <div className="empty-body">{body}</div>
      {action && <div style={{ marginTop: 14 }}>{action}</div>}
    </div>
  );
}

// =================== Styles ===================
function Style() {
  return (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Archivo+Black&family=Archivo:wght@400;600;700&display=swap');

      .wcpg {
        --pitch: #0B5237; --pitch-deep: #073A27; --chalk: #FFFFFF;
        --gold: #E8B23A; --ink: #122019; --red: #C8401F; --net: rgba(255,255,255,0.08);
        min-height: 100vh;
        background:
          repeating-linear-gradient(90deg, transparent 0 72px, rgba(255,255,255,0.03) 72px 144px),
          linear-gradient(180deg, var(--pitch-deep), var(--pitch) 320px);
        font-family: 'Archivo', system-ui, sans-serif;
        color: var(--chalk); padding: 28px 16px 64px;
      }
      .wcpg * { box-sizing: border-box; }
      .wcpg-loading { display:flex; align-items:center; justify-content:center; }
      .loadbox { font-family:'Archivo Black', Impact, sans-serif; letter-spacing:3px; opacity:.85; }

      .hero { max-width: 920px; margin: 0 auto 20px; text-align:center; }
      .hero-eyebrow { font-size:11px; letter-spacing:4px; opacity:.75; margin-bottom:8px; }
      .hero-title { font-family:'Archivo Black', Impact, sans-serif; font-size: clamp(32px, 7vw, 60px); line-height:.95; margin:0; text-shadow: 0 3px 0 rgba(0,0,0,.25); }
      .gold { color: var(--gold); }
      .syncline { margin-top:12px; display:flex; gap:8px; align-items:center; justify-content:center; font-size:12px; opacity:.85; }
      .dot { width:8px; height:8px; border-radius:50%; background: var(--gold); display:inline-block; }
      @media (prefers-reduced-motion: no-preference) {
        .dot.spin { animation: pulse 1s infinite alternate; }
        @keyframes pulse { from { opacity:.3 } to { opacity:1 } }
      }

      .tabs { max-width:920px; margin:0 auto 18px; display:flex; gap:6px; flex-wrap:wrap; justify-content:center; }
      .tab { background: var(--net); color: var(--chalk); border:1px solid rgba(255,255,255,.18); padding:9px 15px; border-radius:999px; font:600 13px 'Archivo', sans-serif; cursor:pointer; }
      .tab.on { background: var(--gold); color: var(--ink); border-color: var(--gold); }
      .tab:focus-visible, .btn:focus-visible, .linklike:focus-visible { outline:2px solid var(--gold); outline-offset:2px; }

      .panel { max-width:920px; margin:0 auto; }
      .section-note { text-align:center; font-size:12px; opacity:.75; margin-bottom:12px; letter-spacing:.5px; }

      .avatar { border-radius:50%; object-fit:cover; border:2px solid rgba(232,178,58,.7); flex-shrink:0; }
      .avatar.fallback { display:inline-flex; align-items:center; justify-content:center; background: rgba(255,255,255,.15); font-weight:700; color: var(--chalk); }

      .scoreboard { background: var(--ink); border-radius:14px; overflow:hidden; border:2px solid rgba(232,178,58,.5); box-shadow: 0 12px 30px rgba(0,0,0,.35); }
      .sb-row { display:grid; grid-template-columns: 42px 1fr 64px 76px 76px; align-items:center; padding:11px 16px; border-bottom:1px solid rgba(255,255,255,.07); font-variant-numeric: tabular-nums; }
      .sb-head { font-size:10px; letter-spacing:2px; opacity:.6; text-transform:uppercase; padding:10px 16px; }
      .sb-rank { font-family:'Archivo Black', sans-serif; opacity:.6; }
      .sb-name { font-weight:700; font-size:15px; display:flex; align-items:center; gap:10px; }
      .sb-num { text-align:center; opacity:.85; }
      .sb-pts { text-align:right; font-family:'Archivo Black', sans-serif; font-size:22px; color: var(--gold); }
      .sb-row.leader { background: linear-gradient(90deg, rgba(232,178,58,.18), transparent 70%); }
      @media (max-width: 560px) { .sb-row { grid-template-columns: 30px 1fr 44px 52px 56px; padding:10px 10px; } .sb-name { font-size:13px; gap:8px; } }

      .card { background: rgba(255,255,255,.06); border:1px solid rgba(255,255,255,.14); border-radius:14px; padding:16px; margin-bottom:16px; }
      .card-title { font-family:'Archivo Black', sans-serif; font-size:13px; letter-spacing:1.5px; text-transform:uppercase; margin-bottom:12px; opacity:.9; }
      .form-grid { display:grid; grid-template-columns: 1fr 1fr 140px 110px 150px auto; gap:8px; }
      .form-grid.two { grid-template-columns: 1fr auto; }
      .form-grid.three { grid-template-columns: 1fr 1fr auto auto; }
      @media (max-width: 760px) { .form-grid, .form-grid.three { grid-template-columns: 1fr 1fr; } .form-grid .btn { grid-column: 1 / -1; } }
      .wcpg input, .wcpg select, .wcpg textarea { background: rgba(0,0,0,.3); border:1px solid rgba(255,255,255,.2); color: var(--chalk); border-radius:8px; padding:10px 12px; font:400 14px 'Archivo', sans-serif; width:100%; }
      .wcpg input:focus-visible, .wcpg select:focus-visible { outline:2px solid var(--gold); outline-offset:1px; }
      .wcpg select option { color: var(--ink); }
      .wcpg input[type=file] { padding:8px; }
      .hint { font-size:12px; opacity:.7; margin-top:8px; line-height:1.5; }
      .error { margin-top:10px; font-size:13px; color:#FFB4A0; background:rgba(200,64,31,.18); border:1px solid rgba(200,64,31,.5); border-radius:8px; padding:8px 12px; }
      .linklike { background:none; border:none; color: var(--gold); font:600 12px 'Archivo'; cursor:pointer; padding:0; text-decoration:underline; }
      .linklike:disabled { opacity:.4; cursor:wait; }

      .btn { background: rgba(255,255,255,.12); color: var(--chalk); border:1px solid rgba(255,255,255,.25); border-radius:8px; padding:10px 16px; font:700 13px 'Archivo'; cursor:pointer; }
      .btn.gold-btn { background: var(--gold); color: var(--ink); border-color: var(--gold); }
      .btn.small { padding:6px 12px; font-size:12px; }
      .btn.danger { color:#FFB4A0; border-color: rgba(200,64,31,.6); background: rgba(200,64,31,.15); }
      .btn:disabled { opacity:.4; cursor:not-allowed; }
      .filebtn { display:inline-flex; align-items:center; gap:8px; background: rgba(255,255,255,.12); border:1px solid rgba(255,255,255,.25); border-radius:8px; padding:10px 16px; font:700 13px 'Archivo'; cursor:pointer; }
      .filelabel { display:inline-flex; align-items:center; cursor:pointer; }

      .fixtures { display:grid; gap:10px; }
      .fixture { background: rgba(255,255,255,.07); border:1px solid rgba(255,255,255,.14); border-radius:12px; padding:12px 14px; }
      .fixture.done { border-color: rgba(232,178,58,.55); }
      .today-card { padding:16px; }
      .fx-meta { display:flex; gap:10px; align-items:center; font-size:11px; letter-spacing:1px; text-transform:uppercase; opacity:.8; margin-bottom:8px; }
      .fx-stage { color: var(--gold); font-weight:700; }
      .fx-time { font-weight:700; }
      .fx-line { display:grid; grid-template-columns: 1fr auto 1fr; align-items:center; gap:10px; }
      .fx-line.big .fx-team { font-size:18px; }
      .fx-vs { font-family:'Archivo Black'; font-size:20px; color: var(--gold); padding:0 6px; }
      .fx-team { font-weight:700; font-size:15px; }
      .fx-team.h { text-align:right; }
      .fx-score { display:flex; align-items:center; gap:6px; }
      .fx-score input { width:52px; text-align:center; font-family:'Archivo Black'; font-size:17px; padding:7px 4px; -moz-appearance:textfield; }
      .fx-score input::-webkit-outer-spin-button, .fx-score input::-webkit-inner-spin-button { -webkit-appearance:none; }
      .fx-score em { font-style:normal; opacity:.6; }
      .fx-actions { display:flex; gap:8px; justify-content:flex-end; margin-top:10px; }
      @media (max-width: 480px) { .fx-team { font-size:13px; } .fx-line.big .fx-team { font-size:15px; } }

      .guesses { margin-top:14px; border-top:1px dashed rgba(255,255,255,.18); padding-top:10px; }
      .guesses-title { font-size:10px; letter-spacing:2px; text-transform:uppercase; opacity:.6; margin-bottom:8px; }
      .guess-grid { display:flex; flex-wrap:wrap; gap:8px; }
      .guess { display:flex; align-items:center; gap:7px; background: rgba(0,0,0,.25); border:1px solid rgba(255,255,255,.14); border-radius:999px; padding:5px 12px 5px 5px; font-size:13px; }
      .guess-name { font-weight:600; }
      .guess-score { font-family:'Archivo Black'; font-variant-numeric: tabular-nums; }
      .guess.g3 { border-color: var(--gold); background: rgba(232,178,58,.25); }
      .guess.g1 { background: rgba(255,255,255,.16); }
      .guess.g0 { opacity:.65; }

      .pill { border-radius:999px; padding:2px 9px; font-size:10px; font-weight:700; letter-spacing:.5px; }
      .pill.p3 { background: var(--gold); color: var(--ink); }
      .pill.px { background: rgba(255,255,255,.14); opacity:.8; }

      .preview { margin-top:12px; max-height:300px; overflow-y:auto; border:1px solid rgba(255,255,255,.12); border-radius:10px; }
      .preview-row { display:flex; justify-content:space-between; padding:8px 12px; font-size:13px; border-bottom:1px solid rgba(255,255,255,.07); font-variant-numeric: tabular-nums; }

      .compare-wrap { overflow-x:auto; border-radius:12px; border:1px solid rgba(255,255,255,.14); }
      .compare { border-collapse:collapse; width:100%; min-width:560px; background: rgba(0,0,0,.2); font-variant-numeric: tabular-nums; }
      .compare th, .compare td { padding:8px 11px; text-align:center; font-size:13px; border-bottom:1px solid rgba(255,255,255,.08); }
      .compare th { font-size:11px; letter-spacing:1px; text-transform:uppercase; opacity:.7; background: rgba(0,0,0,.35); }
      .compare .sticky { position:sticky; left:0; background: var(--pitch-deep); text-align:left; z-index:1; }
      .match-cell small { display:block; opacity:.55; font-size:10px; }
      .compare .c3 { background: rgba(232,178,58,.3); font-weight:700; }
      .compare .c1 { background: rgba(255,255,255,.12); }
      .compare .c0 { background: rgba(200,64,31,.18); opacity:.8; }
      .final-cell { font-weight:700; color: var(--gold); }

      .roster { display:grid; gap:8px; }
      .roster-row { display:flex; align-items:center; gap:12px; background: rgba(255,255,255,.07); border:1px solid rgba(255,255,255,.14); border-radius:10px; padding:10px 14px; }
      .roster-info { flex:1; display:flex; flex-direction:column; }
      .roster-name { font-weight:700; }
      .roster-phone { font-size:12px; color: var(--gold); text-decoration:none; }

      .empty { text-align:center; padding:48px 20px; opacity:.9; }
      .empty-title { font-family:'Archivo Black'; font-size:18px; margin-bottom:6px; }
      .empty-body { font-size:13px; opacity:.8; max-width:400px; margin:0 auto; line-height:1.5; }

      .toast { position:fixed; bottom:24px; left:50%; transform:translateX(-50%); background: var(--ink); color: var(--chalk); border:1px solid var(--gold); padding:10px 20px; border-radius:999px; font:600 13px 'Archivo'; z-index:50; box-shadow: 0 10px 30px rgba(0,0,0,.5); max-width:90vw; text-align:center; }
      @media (prefers-reduced-motion: no-preference) {
        .toast { animation: pop .18s ease-out; }
        @keyframes pop { from { transform:translate(-50%, 8px); opacity:0; } }
      }
    `}</style>
  );
}
