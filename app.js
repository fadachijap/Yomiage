// よみあげアプリ (YomiScript prototype)
// Pipeline: text -> (LLM as Yomite) -> YomiScript -> (ja-accent: accent/pitch) -> (Kokoro Katarite in a worker) -> audio.
// The Speaker/Voice/Reader classes and the model cache follow demo/ys_web of the YomiScript project (Apache-2.0).
import { DICT_URL, loadFrontend, loadPitchModel, PITCH_URL, pitchOrAccentYomite } from "@yomiscript/ja-accent";

// ---- model cache (from demo/ys_web/web/model_cache.js) ----
const MODEL_CACHE = "yomiscript-models";
const OLD_CACHES = ["yomiscript-models-1"];
const HF = "https://huggingface.co/",
  RESOLVE = "/resolve/";
const COMMIT = /^[0-9a-f]{40}$/;
const revisionApiUrl = (base) => {
  const at = base.indexOf(RESOLVE);
  if (!base.startsWith(HF) || at <= HF.length || !base.endsWith("/")) return null;
  const rest = base.slice(at + RESOLVE.length),
    revision = rest.slice(0, rest.indexOf("/"));
  return revision ? `${HF}api/models/${base.slice(HF.length, at)}/revision/${revision}` : null;
};
const pinnedBase = (base, sha) => base.replace(/\/resolve\/[^/]+\//, `/resolve/${sha}/`);
const resolveCommit = async (base) => {
  const api = revisionApiUrl(base);
  if (!api) return null;
  try {
    const r = await fetch(api, { cache: "no-cache" });
    const sha = r.ok ? (await r.json()).sha : null;
    return COMMIT.test(sha) ? sha : null;
  } catch {
    return null;
  }
};
const openCache = async () => {
  try {
    return await caches.open(MODEL_CACHE);
  } catch {
    return null;
  }
};
const dropOldCaches = async () => {
  try {
    await Promise.all(OLD_CACHES.map((name) => caches.delete(name)));
  } catch {}
};
const dropOtherCommits = async (cache, base, sha) => {
  try {
    const repository = base.slice(0, base.indexOf(RESOLVE) + RESOLVE.length),
      current = `${repository}${sha}/`;
    const stale = (await cache.keys()).filter((q) => q.url.startsWith(repository) && !q.url.startsWith(current));
    await Promise.all(stale.map((q) => cache.delete(q)));
  } catch {}
};
async function modelFetcher(base) {
  await dropOldCaches();
  const sha = await resolveCommit(base);
  const cache = sha && (await openCache());
  if (!cache) return (path) => fetch(base + path);
  const pinned = pinnedBase(base, sha);
  await dropOtherCommits(cache, base, sha);
  return async (path) => {
    const url = pinned + path;
    const hit = await cache.match(url).catch(() => undefined);
    if (hit) return hit;
    const r = await fetch(url);
    if (r.ok) cache.put(url, r.clone()).catch(() => {});
    return r;
  };
}
const modelBytes = (fetchModel) => async (path) => {
  const r = await fetchModel(path);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
};

// ---- small helpers ----
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => Object.assign(document.createElement(tag), cls ? { className: cls } : {}, text != null ? { textContent: text } : {});
const status = (text, error = false) => {
  $("status").textContent = text;
  $("status").classList.toggle("err", error);
};
const convStatus = (text, error = false) => {
  $("convStatus").textContent = text;
  $("convStatus").classList.toggle("err", error);
};

// ---- settings ----
const DEFAULT_MODELS = { gemini: "gemini-3.8-flash", claude: "claude-sonnet-4-5" };
function loadSettings() {
  const provider = localStorage.getItem("yomiage_provider") || "gemini";
  $("provider").value = provider;
  $("apikey").value = localStorage.getItem("yomiage_key_" + provider) || "";
  $("model").value = localStorage.getItem("yomiage_model_" + provider) || DEFAULT_MODELS[provider];
  refreshConvHint();
}
function currentSettings() {
  return { provider: $("provider").value, key: $("apikey").value.trim(), model: $("model").value.trim() };
}
function refreshConvHint() {
  const { key } = currentSettings();
  convStatus(key ? "変換できます。" : "APIキーの設定が必要です（上の「設定」から）。", false);
}
$("provider").addEventListener("change", () => {
  const provider = $("provider").value;
  $("apikey").value = localStorage.getItem("yomiage_key_" + provider) || "";
  $("model").value = localStorage.getItem("yomiage_model_" + provider) || DEFAULT_MODELS[provider];
  refreshConvHint();
});
$("saveSettings").addEventListener("click", () => {
  const { provider, key, model } = currentSettings();
  localStorage.setItem("yomiage_provider", provider);
  localStorage.setItem("yomiage_key_" + provider, key);
  localStorage.setItem("yomiage_model_" + provider, model || DEFAULT_MODELS[provider]);
  refreshConvHint();
  convStatus("保存しました。");
});

// ---- sentence splitting ----
function splitSentences(text) {
  const out = [];
  for (const para of text.replace(/\r\n?/g, "\n").split(/\n+/)) {
    const p = para.trim();
    if (!p) continue;
    const parts = p.match(/[^。！？!?]+[。！？!?]*[」』）)】》”’"']*/g) || [p];
    const cleaned = parts.map((s) => s.trim()).filter(Boolean);
    cleaned.forEach((s, i) => out.push({ text: s, ys: null, last: i === cleaned.length - 1 }));
  }
  return out;
}

// ---- the Yomite prompt (subset of the YomiScript spec as measured in the project's eval) ----
const SYSTEM_PROMPT = `You are acting as a **Yomite**: you write YomiScript, a language-neutral pronunciation notation that a speech synthesizer (the Katarite, here Kokoro-82M) reads. Do not use any tools; answer directly.

## YomiScript (the subset this synthesizer uses)

- One utterance per item: \`<lang> /… ↘/\` for a statement, \`<lang> /… ↗/\` for a question. \`<lang>\` is a BCP 47 language tag (\`ja\`, \`en-US\`).
- The pronunciation is IPA, written as the words are actually spoken: numbers, dates, symbols and abbreviations spelled out, and each word read the way it is meant in its context.
  - Japanese: phonemic IPA, mora by mora. Rows: a i ɯ e o; ka ki kɯ ke ko (kʲa kʲɯ kʲo); sa ɕi sɯ se so (ɕa ɕɯ ɕo); dza dʑi dzɯ dze dzo; ta tɕi tsɯ te to (tɕa tɕɯ tɕo); da de do; na ɲi nɯ ne no (ɲa ɲɯ ɲo); ha çi ɸɯ he ho (ça çɯ ço); ba bi bɯ be bo; pa pi pɯ pe po; ma mi mɯ me mo (mʲa…); ja jɯ jo; wa; ɾa ɾi ɾɯ ɾe ɾo (ɾʲa…). Loanword sounds: ti di tɯ ɸa ɸi ɸe ɸo wi we wo tsa va. Particles: は \`wa\`, へ \`e\`, を \`o\`. Long vowel \`ː\` as pronounced (先生 \`seːseː\`). Geminate: double the next consonant (\`kitte\`; before tɕ / ts write \`t\`: \`mattɕi\`), \`ʔ\` before a vowel or at the end. ン: \`m\` before p b m, \`n\` before t d n ɾ dz, \`ɲ\` before tɕ dʑ ɲ, \`ŋ\` before k ɡ, \`ɴ\` otherwise. Latin letters and symbols as a Japanese speaker says them (iPhone \`aiɸoɴ\`). Separate words with spaces.
  - English: IPA with \`ˈ\` / \`ˌ\` stress at the start of the syllable, \`.\` between syllables, spaces between words.
- \` ‖ \` marks a pause (a comma).
- No pitch values and no accent marks: the synthesizer makes the prosody.
- After each word, write the text it reads in \`<t:…>\`, so that joining them gives back the input text exactly: punctuation goes with the word before it (\`desɯ<t:です。>\`) or in its own \`<t:…>\` where nothing is spoken (\`‖<t:、>\`); in English write the spaces too (\`ˈwɝld<t: world.>\`).

Examples:
ja /ɕɯːmatsɯ<t:週末> wa<t:は> ‖<t:、> tomodatɕi<t:友達> to<t:と> kʲoːto<t:京都> e<t:へ> ikɯ<t:行く> joteː<t:予定> desɯ<t:です。> ↘/
ja /tsɯitatɕi<t:一日> kaɾa<t:から> mikka<t:三日> made<t:まで> jasɯmi<t:休み> desɯ<t:です。> ↘/

## Task

For each item in the JSON object the user sends, write its YomiScript (language: ja unless the text is clearly another language).
Return **only** a JSON object mapping each item name to its YomiScript string, with no other text:
{"s0": "<YomiScript>", "s1": "<YomiScript>"}`;

async function callLLM(userText) {
  const { provider, key, model } = currentSettings();
  if (!key) throw new Error("APIキーが設定されていません");
  if (provider === "gemini") {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: "user", parts: [{ text: userText }] }],
        generationConfig: { temperature: 0.1, responseMimeType: "application/json" },
      }),
    });
    if (!r.ok) throw new Error(`Gemini API: ${r.status} ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    return (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
  }
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model,
      max_tokens: 8192,
      temperature: 0.1,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userText }],
    }),
  });
  if (!r.ok) throw new Error(`Claude API: ${r.status} ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  return (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
}

const YS_OK = /^(ja|en[\w-]*)\s+\/.*\/\s*$/s;
function parseMapping(raw) {
  const t = raw.replace(/```(?:json)?/g, "");
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try {
    return JSON.parse(t.slice(a, b + 1));
  } catch {
    return null;
  }
}

async function convertBatch(items) {
  // items: [{name, text}] -> Map name -> ys|null
  const payload = {};
  for (const it of items) payload[it.name] = it.text;
  const raw = await callLLM("Items (JSON):\n" + JSON.stringify(payload));
  const map = parseMapping(raw);
  const out = new Map();
  for (const it of items) {
    const ys = map && typeof map[it.name] === "string" ? map[it.name].trim() : null;
    out.set(it.name, ys && YS_OK.test(ys) ? ys : null);
  }
  return out;
}

async function convertAll(sentences) {
  const BATCH = 6;
  let done = 0, failed = 0;
  for (let i = 0; i < sentences.length; i += BATCH) {
    const slice = sentences.slice(i, i + BATCH);
    const items = slice.map((s, k) => ({ name: "s" + k, text: s.text }));
    convStatus(`変換中… ${done} / ${sentences.length} 文`);
    let map = null;
    try {
      map = await convertBatch(items);
    } catch (e) {
      map = null;
      if (i === 0) throw e; // a settings/auth error: stop early with the message
    }
    for (let k = 0; k < slice.length; k++) {
      let ys = map?.get("s" + k) ?? null;
      if (!ys) {
        try {
          const single = await convertBatch([{ name: "s0", text: slice[k].text }]);
          ys = single.get("s0");
        } catch {
          ys = null;
        }
      }
      slice[k].ys = ys;
      if (!ys) failed++;
      done++;
    }
  }
  return failed;
}

// ---- Katarite (worker) + accent, following the project's aozora demo ----
class Speaker {
  constructor() {
    const src = $("worker-src").textContent;
    const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
    Object.assign(this, { worker: new Worker(url, { type: "module" }), waiting: new Map(), next: 0 });
    this.worker.onmessage = ({ data }) => {
      const w = this.waiting.get(data.id);
      if (!w) return;
      this.waiting.delete(data.id);
      if (data.error) w.reject(new Error(data.error));
      else w.resolve(data);
    };
    this.worker.onerror = (e) => {
      for (const { reject } of this.waiting.values()) reject(new Error(e.message || "worker error"));
      this.waiting.clear();
    };
  }
  speak(ys) {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.worker.postMessage({ id, ys });
    });
  }
}

async function startAccent() {
  const a = await loadFrontend(modelBytes(await modelFetcher(DICT_URL)));
  return pitchOrAccentYomite(
    a,
    async () => loadPitchModel(modelBytes(await modelFetcher(PITCH_URL))),
    (e) => console.warn("no pitch model, the dictionary accent is used:", e),
  );
}

class Voice {
  constructor(speaker, accent, sentences) {
    Object.assign(this, { speaker, accent, sentences, made: new Map(), running: Promise.resolve() });
  }
  get(i) {
    if (!this.made.has(i)) {
      const work = (this.running = this.running.catch(() => {}).then(() => this.produce(i)));
      this.made.set(i, work);
      work.catch(() => this.made.delete(i));
    }
    return this.made.get(i);
  }
  async produce(i) {
    const t0 = performance.now(),
      { blob, seconds } = await this.speaker.speak(this.accent(this.sentences[i].ys)),
      ms = performance.now() - t0;
    return { blob, ms, seconds };
  }
}

const GAP_MS = 250,
  PARAGRAPH_GAP_MS = 550;

class Reader {
  constructor(sentences, voice) {
    Object.assign(this, { sentences, voice, at: 0, playing: false, turn: 0, player: new Audio(), url: null, gap: 0 });
    this.player.onended = () => this.finished();
    this.player.onerror = () => this.fail(this.player.error?.message ?? "audio");
  }
  show(i) {
    this.sentences[this.at].node?.classList.remove("now");
    this.at = i;
    const { node, ys } = this.sentences[i];
    node?.classList.add("now");
    node?.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    $("ys").textContent = ys || "";
    $("progress").value = (i + 1) / this.sentences.length;
    $("prev").disabled = i === 0;
    $("next").disabled = i === this.sentences.length - 1;
  }
  async play(i) {
    while (i < this.sentences.length && !this.sentences[i].ys) i++;
    if (i >= this.sentences.length) {
      this.stop();
      status("おしまい");
      return;
    }
    const turn = ++this.turn;
    clearTimeout(this.gap);
    this.player.pause();
    this.playing = true;
    $("play").textContent = "一時停止";
    this.show(i);
    status(`${i + 1} / ${this.sentences.length} 文目を準備しています…`);
    let got;
    try {
      got = await this.voice.get(i);
    } catch (e) {
      if (turn === this.turn) this.fail(e);
      return;
    }
    if (turn !== this.turn) return;
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = URL.createObjectURL(got.blob);
    this.player.src = this.url;
    try {
      await this.player.play();
    } catch (e) {
      if (turn === this.turn) this.fail(e);
      return;
    }
    status(`${i + 1} / ${this.sentences.length} 文目（生成 ${(got.ms / 1000).toFixed(1)} 秒 ／ 音声 ${got.seconds.toFixed(1)} 秒）`);
    if (i + 1 < this.sentences.length && this.sentences[i + 1].ys) this.voice.get(i + 1).catch(() => {});
  }
  finished() {
    const i = this.at;
    if (i + 1 >= this.sentences.length) {
      this.stop();
      status("おしまい");
      return;
    }
    const turn = this.turn;
    this.gap = setTimeout(() => turn === this.turn && this.play(i + 1), this.sentences[i].last ? PARAGRAPH_GAP_MS : GAP_MS);
  }
  stop() {
    this.turn++;
    clearTimeout(this.gap);
    this.player.pause();
    this.playing = false;
    $("play").textContent = "再生";
  }
  fail(e) {
    this.stop();
    status(`音声を作れませんでした：${e?.message || e}`, true);
  }
  toggle() {
    if (this.playing) {
      this.stop();
      status("一時停止しました");
    } else if (this.player.src && this.player.currentTime > 0 && !this.player.ended) {
      this.playing = true;
      $("play").textContent = "一時停止";
      this.player.play().catch((e) => this.fail(e));
    } else {
      this.play(this.at);
    }
  }
}

// ---- audio engine startup (lazy, shared) ----
let audioReady = null;
function ensureAudio() {
  if (!audioReady) {
    audioReady = (async () => {
      status("音声モデルと辞書を読み込んでいます…（初回は約200MB）");
      const speaker = new Speaker();
      const [accent] = await Promise.all([startAccent(), speaker.speak()]);
      return { speaker, accent };
    })();
    audioReady.catch(() => (audioReady = null));
  }
  return audioReady;
}

let reader = null;
async function setSentences(sentences) {
  reader?.stop();
  reader = null;
  const story = $("story");
  story.textContent = "";
  let currentP = null;
  sentences.forEach((s, i) => {
    if (!currentP || sentences[i - 1]?.last) {
      currentP = el("p");
      story.append(currentP);
    }
    const span = el("span", s.ys ? "s" : "s failed", s.text);
    span.dataset.i = i;
    s.node = span;
    currentP.append(span);
  });
  $("play").disabled = true;
  $("prev").disabled = true;
  $("next").disabled = true;
  if (!sentences.some((s) => s.ys)) {
    status("再生できる文がありません。", true);
    return;
  }
  const { speaker, accent } = await ensureAudio();
  const voice = new Voice(speaker, accent, sentences);
  reader = new Reader(sentences, voice);
  const first = sentences.findIndex((s) => s.ys);
  reader.show(first);
  status("最初の文を準備しています…");
  await voice.get(first);
  $("play").disabled = false;
  status("準備ができました");
}

// ---- UI wiring ----
$("story").addEventListener("click", (e) => {
  const node = e.target.closest(".s");
  if (node && reader) reader.play(Number(node.dataset.i));
});
$("play").addEventListener("click", () => reader?.toggle());
$("prev").addEventListener("click", () => reader && reader.play(reader.at - 1));
$("next").addEventListener("click", () => reader && reader.play(reader.at + 1));

const SAMPLE_TEXT =
  "今日は一日から三日まで、東京は雨の予報です。彼はピアノが上手で、昨日の演奏会では皆を驚かせました。帰りに銀行へ寄って、一万円を引き出す予定です。";
$("sample").addEventListener("click", () => {
  $("input").value = SAMPLE_TEXT;
});
$("openFile").addEventListener("click", () => $("file").click());
$("file").addEventListener("change", async () => {
  const f = $("file").files?.[0];
  if (f) $("input").value = await f.text();
});
$("fetchUrl").addEventListener("click", async () => {
  const url = $("url").value.trim();
  if (!url) return;
  convStatus("取得しています…");
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error("HTTP " + r.status);
    const html = await r.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    doc.querySelectorAll("script, style, nav, header, footer, aside").forEach((n) => n.remove());
    const main = doc.querySelector("article") || doc.body;
    const text = (main?.innerText || "").replace(/\n{3,}/g, "\n\n").trim();
    if (!text) throw new Error("本文を取り出せませんでした");
    $("input").value = text;
    convStatus(`取得しました（${text.length}文字）。`);
  } catch (e) {
    convStatus(`取得できませんでした（${e.message}）。本文をコピーして貼り付けてください。`, true);
  }
});

$("convert").addEventListener("click", async () => {
  const text = $("input").value.trim();
  if (!text) {
    convStatus("文章が入っていません。", true);
    return;
  }
  const { key } = currentSettings();
  if (!key) {
    convStatus("先に「設定」でAPIキーを保存してください。", true);
    $("settingsBox").open = true;
    return;
  }
  $("convert").disabled = true;
  try {
    ensureAudio(); // warm up the speech engine while converting
    const sentences = splitSentences(text);
    if (!sentences.length) throw new Error("文を取り出せませんでした");
    const failed = await convertAll(sentences);
    convStatus(failed ? `変換できました（${failed}文は変換できず、再生時に飛ばします）。` : "変換できました。");
    await setSentences(sentences);
  } catch (e) {
    convStatus(`変換できませんでした：${e.message}`, true);
  } finally {
    $("convert").disabled = false;
  }
});

const SAMPLE_YS =
  "ja /ɸɯtaɾi<t:二人> no<t:の> wakai<t:若い> ɕiɴɕi<t:紳士> ɡa<t:が> ‖<t:、> sɯkkaɾi<t:すっかり> iɡiɾisɯ<t:イギリス> no<t:の> heːtai<t:兵隊> no<t:の> katatɕi<t:かたち> o<t:を> ɕite<t:して> ‖<t:、> pikapika<t:ぴかぴか> sɯɾɯ<t:する> teppoː<t:鉄砲> o<t:を> katsɯide<t:かついで> ‖<t:、> ɕiɾokɯma<t:白熊> no<t:の> joːna<t:ような> inɯ<t:犬> o<t:を> ɲiçiki<t:二疋> tsɯɾete<t:つれて> ‖<t:、> daibɯ<t:だいぶ> jamaokɯ<t:山奥> no<t:の> ‖<t:、> ki<t:木> no<t:の> ha<t:葉> no<t:の> kasakasa<t:かさかさ> ɕita<t:した> toko<t:とこ> o<t:を> ‖<t:、> konna<t:こんな> koto<t:こと> o<t:を> ii<t:云い> naɡaɾa<t:ながら> ‖<t:、> aɾɯite<t:あるいて> oɾimaɕita<t:おりました。> ↘/";
$("ysInput").value = SAMPLE_YS;

function textFromYs(ys) {
  const parts = [...ys.matchAll(/<t:([^>]*)>/g)].map((m) => m[1]);
  return parts.length ? parts.join("") : ys;
}
$("playYs").addEventListener("click", async () => {
  const lines = $("ysInput").value.split(/\n+/).map((s) => s.trim()).filter((s) => YS_OK.test(s));
  if (!lines.length) {
    status("YomiScriptの行が見つかりません。", true);
    return;
  }
  const sentences = lines.map((ys, i) => ({ text: textFromYs(ys), ys, last: i === lines.length - 1 }));
  try {
    await setSentences(sentences);
    reader?.play(sentences.findIndex((s) => s.ys));
  } catch (e) {
    status(`読み込めませんでした：${e.message}`, true);
  }
});

loadSettings();
