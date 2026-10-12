/**
 * The local demo page served at GET /. Plain HTML and JS, no build step. It
 * talks to the /v1 API with the key passed in the URL fragment
 * (http://localhost:8787/#key=...), which the browser never sends to a server.
 */
export const DEMO_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pre-consultation Agent</title>
<style>
:root {
  --bg: #f3f5f7; --paper: #ffffff; --ink: #17212b; --muted: #5b6874; --line: #d9dfe5;
  --accent: #1f5f8b; --accent-ink: #ffffff; --accent-soft: #e3eef6; --patient: #e9edf1;
  --t1: #b3261e; --t1-bg: #fbe5e3; --t2: #b45309; --t2-bg: #fdecd6;
  --t3: #8a6d00; --t3-bg: #fbf2c9; --t4: #2e7d4f; --t4-bg: #dff1e6;
  --ok: #2e7d4f; --warn: #8a6d00;
  --body: "IBM Plex Sans", "Segoe UI", "PingFang SC", "Microsoft YaHei", "Noto Sans SC", system-ui, sans-serif;
  --mono: "IBM Plex Mono", Consolas, "Microsoft YaHei", ui-monospace, monospace;
}
@media (prefers-color-scheme: dark) { :root {
  --bg: #11171d; --paper: #18212a; --ink: #e4eaf0; --muted: #9aa8b5; --line: #2b3843;
  --accent: #7fb6dc; --accent-ink: #0d1a24; --accent-soft: #1c3346; --patient: #222d38;
  --t1: #f19c95; --t1-bg: #3d1d1b; --t2: #f0b36a; --t2-bg: #3b2a14; --t3: #e3cd6b; --t3-bg: #353016; --t4: #7fcf9e; --t4-bg: #173325;
  --ok: #7fcf9e; --warn: #e3cd6b; color-scheme: dark;
} }
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html, body { height: 100%; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.6 var(--body); display: grid; grid-template-rows: auto 1fr; }
header { display: flex; flex-wrap: wrap; gap: 10px 16px; align-items: center; padding: 12px 20px; border-bottom: 1px solid var(--line); background: var(--paper); }
header h1 { font-size: 1.05rem; margin: 0; font-weight: 600; }
.badge { font-size: 12px; border-radius: 999px; padding: 2px 10px; background: var(--accent-soft); color: var(--accent); font-weight: 600; }
.badge.mock { background: var(--t3-bg); color: var(--t3); }
.spacer { flex: 1; }
button { font: inherit; cursor: pointer; }
.btn { border: 1px solid var(--line); background: var(--paper); color: var(--ink); border-radius: 6px; padding: 5px 12px; }
.btn.primary { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }
.btn:disabled { opacity: .5; cursor: default; }
button:focus-visible, input:focus-visible, textarea:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
main { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr); min-height: 0; }
@media (max-width: 860px) { main { grid-template-columns: minmax(0, 1fr); } aside { border-left: 0; border-top: 1px solid var(--line); } }
.chat { display: grid; grid-template-rows: 1fr auto; min-height: 0; }
.log { overflow-y: auto; padding: 20px; display: flex; flex-direction: column; gap: 14px; }
.msg { max-width: 68ch; border-radius: 10px; padding: 9px 13px; }
.msg.patient { align-self: flex-end; background: var(--patient); }
.msg.agent { align-self: flex-start; background: var(--accent-soft); }
.who { font-size: 11px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
.msg ol { margin: 2px 0 0; padding-left: 1.3em; }
details { font: 12px var(--mono); color: var(--muted); }
details summary { cursor: pointer; }
details div { padding-left: 1em; }
.note { background: var(--paper); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; }
.note.emergency { border-left: 4px solid var(--t2); }
.note pre { margin: 6px 0 0; white-space: pre-wrap; word-break: break-word; font: 13.5px/1.75 var(--mono); }
.hint { color: var(--muted); font-size: 13.5px; }
.err { color: var(--t1); font-size: 13.5px; }
.examples { display: flex; flex-wrap: wrap; gap: 8px; }
.examples button { border: 1px dashed var(--line); background: var(--paper); color: var(--ink); border-radius: 6px; padding: 6px 10px; text-align: left; }
form { display: flex; gap: 8px; padding: 12px 20px; border-top: 1px solid var(--line); background: var(--paper); }
textarea { flex: 1; min-width: 0; resize: none; font: inherit; color: var(--ink); background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 8px 10px; height: 64px; }
aside { border-left: 1px solid var(--line); background: var(--paper); overflow-y: auto; padding: 16px 20px; display: grid; gap: 12px; align-content: start; min-width: 0; }
h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin: 0; font-weight: 600; }
.lvl { display: inline-block; font-weight: 600; font-size: 13px; border-radius: 999px; padding: 2px 12px; }
.l1 { color: var(--t1); background: var(--t1-bg); } .l2 { color: var(--t2); background: var(--t2-bg); }
.l3 { color: var(--t3); background: var(--t3-bg); } .l4 { color: var(--t4); background: var(--t4-bg); }
.counts { font: 12.5px var(--mono); color: var(--muted); }
table { border-collapse: collapse; width: 100%; font-size: 13.5px; }
th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); padding: 4px 6px; border-bottom: 1px solid var(--line); }
td { padding: 6px; border-bottom: 1px solid var(--line); vertical-align: top; }
.kind { font: 11.5px var(--mono); color: var(--muted); }
.kind.redflag { color: var(--t1); }
.st { font-size: 12.5px; font-weight: 600; white-space: nowrap; }
.st.answered { color: var(--ok); } .st.unknown { color: var(--warn); } .st.unasked { color: var(--muted); font-weight: 400; }
.quote { color: var(--muted); font-size: 12.5px; }
.keybox { display: flex; gap: 6px; align-items: center; font-size: 13px; }
.keybox input { font: 13px var(--mono); padding: 4px 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--ink); width: 16em; }
</style>
</head>
<body>
<header>
  <h1>Pre-consultation Agent</h1>
  <span class="badge" id="mode">…</span>
  <span class="spacer"></span>
  <span class="keybox" id="keybox" hidden><label for="key">API key</label><input id="key" type="password" autocomplete="off"></span>
  <button class="btn" id="reset" type="button">New consultation</button>
</header>
<main>
  <section class="chat">
    <div class="log" id="log" aria-live="polite"></div>
    <form id="form">
      <textarea id="text" placeholder="以患者身份描述哪里不舒服，例如：我最近两周老是胸闷。" aria-label="Patient message"></textarea>
      <button class="btn primary" id="send" type="submit">Send</button>
    </form>
  </section>
  <aside>
    <div><h2>Urgency</h2><div id="level" class="hint">Not graded yet</div></div>
    <div><h2>Record table</h2><div id="counts" class="counts"></div></div>
    <div id="table" class="hint">Points appear once the complaint is in. Each answered point keeps the patient's own words.</div>
  </aside>
</main>
<script>
var LEVELS = { "Ⅰ": 1, "Ⅱ": 2, "Ⅲ": 3, "Ⅳ": 4 };
var LEVEL_EN = { 1: "Level Ⅰ · Resuscitation", 2: "Level Ⅱ · Emergent", 3: "Level Ⅲ · Urgent", 4: "Level Ⅳ · Non-urgent" };
var KIND = { redflag: "red flag", required: "required", discriminating: "differentiating", optional: "optional" };
var STATUS = { answered: "Answered", unknown: "Patient unsure", unasked: "Not asked" };
var NODE = { setup: "pick template", understand: "update record", triage: "triage", ask: "plan questions", wait: "patient answered", draft: "draft note", check: "self-check", finalize: "finish", emergency: "emergency stop" };
var EXAMPLES = ["我最近两周老是胸闷，上楼的时候更明显。", "我胸口痛了一个小时，现在全身出大汗。", "咳嗽三天了，昨天开始发烧，最高38.5度。", "肚子疼，拉肚子一天了。"];

var key = "";
var id = null;
var busy = false;
var log = document.getElementById("log");
var text = document.getElementById("text");

function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
function add(html, cls) { var d = document.createElement("div"); if (cls) d.className = cls; d.innerHTML = html; log.appendChild(d); log.scrollTop = log.scrollHeight; return d; }

function loadKey() {
  var m = /key=([^&]+)/.exec(location.hash);
  if (m) { key = decodeURIComponent(m[1]); try { sessionStorage.setItem("apiKey", key); } catch (e) {} history.replaceState(null, "", location.pathname); }
  if (!key) { try { key = sessionStorage.getItem("apiKey") || ""; } catch (e) {} }
  var box = document.getElementById("keybox"), input = document.getElementById("key");
  if (!key) box.hidden = false;
  input.addEventListener("input", function () { key = input.value.trim(); try { sessionStorage.setItem("apiKey", key); } catch (e) {} });
}

function welcome() {
  log.innerHTML = "";
  id = null;
  text.disabled = false; document.getElementById("send").disabled = false;
  var d = add('<p class="hint">Type as the patient, in Chinese. The agent asks up to two questions per round, stops early for danger signs, and ends with a draft note for the doctor. Try one of these:</p><div class="examples"></div>');
  var box = d.querySelector(".examples");
  EXAMPLES.forEach(function (e) {
    var b = document.createElement("button"); b.type = "button"; b.textContent = e;
    b.addEventListener("click", function () { text.value = e; text.focus(); });
    box.appendChild(b);
  });
  document.getElementById("level").innerHTML = "Not graded yet";
  document.getElementById("level").className = "hint";
  document.getElementById("counts").textContent = "";
  document.getElementById("table").innerHTML = "Points appear once the complaint is in. Each answered point keeps the patient's own words.";
  document.getElementById("table").className = "hint";
}

function show(v) {
  var trace = v.trace.map(function (t) { return "<div>" + esc(NODE[t.node] || t.node) + " · " + esc(t.summary) + "</div>"; }).join("");
  if (v.question) {
    var qs = v.question.split(/\\s+/).filter(Boolean).map(function (q) { return "<li>" + esc(q) + "</li>"; }).join("");
    add('<div class="who">Agent</div><ol>' + qs + "</ol>" + (trace ? "<details><summary>What the graph did</summary>" + trace + "</details>" : ""), "msg agent");
  } else if (trace) {
    add("<details open><summary>What the graph did</summary>" + trace + "</details>");
  }
  if (v.output) {
    add('<div class="who">' + (v.status === "emergency" ? "Shown to the patient" : "Draft note for the doctor") + "</div><pre>" + esc(v.output) + "</pre>", "note" + (v.status === "emergency" ? " emergency" : ""));
    text.disabled = true; document.getElementById("send").disabled = true;
    add('<p class="hint">Consultation finished. Press “New consultation” to start another.</p>');
  }
  var n = LEVELS[(v.level || "").charAt(0)];
  var lv = document.getElementById("level");
  lv.className = ""; lv.innerHTML = n ? '<span class="lvl l' + n + '">' + LEVEL_EN[n] + "</span>" : esc(v.level);
  document.getElementById("counts").textContent = v.record.answered + " answered · " + v.record.unknown + " unsure · " + v.record.unasked + " open · round " + v.rounds;
  var rows = (v.table || []).map(function (r) {
    return "<tr><td>" + esc(r.label) + '<div class="kind ' + r.kind + '">' + KIND[r.kind] + '</div></td><td><span class="st ' + r.status + '">' + STATUS[r.status] + "</span>" + (r.quote ? '<div class="quote">“' + esc(r.quote) + "”</div>" : "") + "</td></tr>";
  }).join("");
  var t = document.getElementById("table");
  t.className = ""; t.innerHTML = "<table><thead><tr><th>Point</th><th>Status and patient's words</th></tr></thead><tbody>" + rows + "</tbody></table>";
}

function api(method, path, body) {
  return fetch(path, { method: method, headers: { "authorization": "Bearer " + key, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined })
    .then(function (res) { return res.json().then(function (data) { if (!res.ok) throw new Error(res.status === 401 ? "The API key is missing or wrong. Restart with npm run demo, or paste the key printed in the terminal." : (data.error || "Request failed")); return data; }); });
}

document.getElementById("form").addEventListener("submit", function (e) {
  e.preventDefault();
  var msg = text.value.trim();
  if (!msg || busy) return;
  busy = true; document.getElementById("send").disabled = true;
  if (!id) log.innerHTML = "";
  add('<div class="who">Patient</div>' + esc(msg), "msg patient");
  text.value = "";
  var wait = add('<p class="hint">Working… the model can take 10 to 30 seconds per round.</p>');
  (id ? api("POST", "/v1/consultations/" + id + "/answers", { text: msg }) : api("POST", "/v1/consultations", { complaint: msg }))
    .then(function (v) { id = v.id; wait.remove(); show(v); })
    .catch(function (err) { wait.className = "err"; wait.textContent = err.message; })
    .then(function () { busy = false; if (!text.disabled) { document.getElementById("send").disabled = false; text.focus(); } });
});
text.addEventListener("keydown", function (e) { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); document.getElementById("form").requestSubmit(); } });
document.getElementById("reset").addEventListener("click", welcome);

fetch("/healthz").then(function (r) { return r.json(); }).then(function (h) {
  var b = document.getElementById("mode");
  if (h.model === "bedrock") { b.textContent = "AWS Bedrock"; }
  else { b.textContent = "Offline stand-in model"; b.className = "badge mock"; b.title = "Keyword matching only. Add Bedrock keys to use the real model."; }
});
loadKey();
welcome();
</script>
</body>
</html>`;
