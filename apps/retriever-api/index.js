import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import OpenAI from 'openai';
import { QdrantClient } from '@qdrant/js-client-rest';
import fetch from 'node-fetch';
import multer from "multer";
import { toFile } from "openai/uploads";

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));


const uploadsDir = path.join(process.cwd(), "uploads");
try { fs.mkdirSync(uploadsDir, { recursive: true }); } catch {}

const upload = multer({
  dest: uploadsDir,
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB
  fileFilter: (_req, file, cb) => {
    const ok = [
      "audio/webm", "audio/ogg", "audio/oga", "audio/wav",
      "audio/mpeg", "audio/mp3", "audio/mp4", "audio/x-m4a", "audio/flac"
    ].includes(file.mimetype);
    if (!ok) return cb(new Error("Unsupported audio type"));
    cb(null, true);
  },
});
// env
const PORT = process.env.PORT || 8000;
const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6333';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const COLLECTION = process.env.COLLECTION || 'labor_assistant_v1';

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const qdrant = new QdrantClient({
  url: process.env.QDRANT_URL,
  apiKey: process.env.QDRANT_API_KEY,
  checkCompatibility: false,
});

//  tiny LRU cache 
const CACHE = new Map();
const CACHE_MAX = 50;
function getCache(key) { return CACHE.get(key); }
function setCache(key, val) {
  CACHE.set(key, val);
  if (CACHE.size > CACHE_MAX) {
    const firstKey = CACHE.keys().next().value;
    CACHE.delete(firstKey);
  }
}
//audio cache
const AUDIO_CACHE = new Map(); // key -> Buffer
const AUDIO_CACHE_MAX = 30;
function getAudioCache(key) { return AUDIO_CACHE.get(key); }
function setAudioCache(key, buf) {
  AUDIO_CACHE.set(key, buf);
  if (AUDIO_CACHE.size > AUDIO_CACHE_MAX) {
    const firstKey = AUDIO_CACHE.keys().next().value;
    AUDIO_CACHE.delete(firstKey);
  }
}
//helpers 
async function ensureCollection() {
  const cols = await qdrant.getCollections();
  const exists = cols.collections?.some((c) => c.name === COLLECTION);
  if (!exists) {
    await qdrant.createCollection(COLLECTION, { vectors: { size: 3072, distance: 'Cosine' } });
    console.log('Created collection:', COLLECTION);
  }
  await qdrant.createPayloadIndex(COLLECTION, {
    field_name: "type",
    field_schema: "keyword",
  }).catch(() => {});
}

async function embed(text) {
  const r = await openai.embeddings.create({
    model: 'text-embedding-3-large',
    input: text
  });
  return r.data[0].embedding;
}

function dedupBy(arr, keyFn) {
  const seen = new Set();
  return arr.filter((x) => {
    const k = keyFn(x);
    if (!k) return true;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function simpleMMR(hits, lambda = 0.8) {

  //score-based spread + source/url diversity.
  if (!Array.isArray(hits) || hits.length <= 2) return hits;
  const out = [];
  const pool = [...hits];
  // pick best first
  pool.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  out.push(pool.shift());
  while (pool.length && out.length < 5) {
    let best = null;
    let bestVal = -1e9;
    for (const h of pool) {
      const rel = h.score ?? 0;
      // diversity penalty
      const sameSrc = out.some(o =>
        (o.payload?.url && h.payload?.url && o.payload.url === h.payload.url) ||
        (o.payload?.title && h.payload?.title && o.payload.title === h.payload.title)
      );
      const diversityPenalty = sameSrc ? 0.5 : 0.0; // penalize duplicates
      const val = lambda * rel - (1 - lambda) * diversityPenalty;
      if (val > bestVal) { bestVal = val; best = h; }
    }
    out.push(best);
    const idx = pool.indexOf(best);
    if (idx >= 0) pool.splice(idx, 1);
  }
  return out;
}

function buildPrompt({ q, lang, contexts }) {
    const srcList = contexts.map((c, i) => {
      const title = c.payload?.title || '';
      const url = c.payload?.url || '';
      const head = [title, url].filter(Boolean).join(' — ');
      const chunk = (c.payload?.text || '').slice(0, 1800);
      return `【${i + 1}】${head}\n${chunk}`;
    }).join('\n\n\n\n');
  
    if (lang === 'en') {
      return {
        system: [
          "You are a calm, patient assistant for older adults in Taiwan.",
          "If a rule has numeric details (years, levels, days), keep those numbers exact.",
          "Use ONLY the passages in <context>. If they are insufficient, say so and suggest an official source to check.",
          "Never invent facts. If unsure, say you're unsure.",
          "Style guide:",
          "- Short, plain sentences. Avoid jargon. One idea per sentence.",
          "- Prefer bullets and numbers. Max 5 checklist items.",
          "- Use reassuring tone (\"You can…\", \"Please bring…\").",
          "Output format (markdown):",
          " Summary",
          "- 1–3 short sentences (<= 60 words total).",
          " Checklist",
          "1. Step …",
          "2. Step …",
          " Sources",
          "- Title – URL",
          "Add this footer line automatically:",
          "Note: This is general guidance, not legal advice. Please verify with the Bureau of Labor Insurance (BLI)."
        ].join("\n"),
        user: [
          `Question: ${q}`,
          "",
          "<context>",
          srcList || "(no context)",
          "</context>",
          "",
          "Write the answer now in English, following the exact format and limits above."
        ].join("\n")
      };
    }
  
    // default zh 
    return {
      system: [
        "你是耐心、清楚的長者助理。",
        "若規定中包含數字細節（例如年、等級、天數），請確實保留這些數字。",
        "回答時「只使用」<context> 內的內容；若資訊不足，請直說不足，並建議到官方來源查詢。",
        "不要編造。不確定就說不確定。",
        "寫作規則：",
        "- 句子短、用詞簡單（避免專有名詞）。每句只說一件事。",
        "- 優先使用條列與編號，檢查清單最多 5 點。",
        "- 口吻溫和：如「您可以…」、「請準備…」。",
        "輸出格式（markdown）：",
        " 摘要",
        "- 1–3 句短句（總長 ≤ 60 字）。",
        " 檢查清單",
        "1. 步驟…",
        "2. 步驟…",
        " 資料來源",
        "- 標題 – 連結",
        "並在文末自動加入這行：",
        "註：本服務提供一般性說明，非法律意見；請以勞保局公告為準。"
      ].join("\n"),
      user: [
        `使用者問題：${q}`,
        "",
        "<context>",
        srcList || "(無可用資料)",
        "</context>",
        "",
        "請用繁體中文，依上述格式與限制輸出答案。"
      ].join("\n")
    };
  }
  

//  endpoints 
app.get('/health', async (_req, res) => {
  try {
    const info = await qdrant.getCollections();
    res.json({ ok: true, collections: info.collections?.map(c => c.name) || [] });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

function normPlace(s = "") {
  return String(s)
    .toLowerCase()
    .replace(/[臺]/g, "台")
    .replace(/(縣|市|區|鄉|鎮|里|村|辦事處|分局|服務據點|勞保局|辦公室|office|branch|location|address|hours|phone)/gi, "")
    .replace(/\s+/g, "");
}

const CITY_ALIASES = [
  { key: "基隆", aliases: ["基隆", "keelung"] },
  { key: "台北", aliases: ["台北", "臺北", "taipei"] },
  { key: "新北", aliases: ["新北", "newtaipei"] },
  { key: "桃園", aliases: ["桃園", "taoyuan"] },
  { key: "新竹", aliases: ["新竹", "hsinchu"] },
  { key: "苗栗", aliases: ["苗栗", "miaoli"] },
  { key: "台中", aliases: ["台中", "臺中", "taichung"] },
  { key: "彰化", aliases: ["彰化", "changhua"] },
  { key: "南投", aliases: ["南投", "nantou"] },
  { key: "雲林", aliases: ["雲林", "yunlin"] },
  { key: "嘉義", aliases: ["嘉義", "chiayi"] },
  { key: "台南", aliases: ["台南", "臺南", "tainan"] },
  { key: "高雄", aliases: ["高雄", "kaohsiung"] },
  { key: "屏東", aliases: ["屏東", "pingtung"] },
  { key: "宜蘭", aliases: ["宜蘭", "yilan"] },
  { key: "花蓮", aliases: ["花蓮", "hualien"] },
  { key: "台東", aliases: ["台東", "臺東", "taitung"] },
  { key: "澎湖", aliases: ["澎湖", "penghu"] },
  { key: "金門", aliases: ["金門", "kinmen"] },
  { key: "連江", aliases: ["連江", "馬祖", "lienchiang"] },
];

function detectCityKey(q) {
  const nq = normPlace(q);
  for (const c of CITY_ALIASES) {
    for (const a of c.aliases) {
      if (nq.includes(normPlace(a))) return c.key;
    }
  }
  return null;
}

function googleMapsUrl({ lat, lng, address }) {
  if (lat != null && lng != null && String(lat) !== "" && String(lng) !== "") {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${lat},${lng}`)}`;
  }
  if (address) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
  }
  return "";
}

const DISABILITY_DAYS = {
  1: { ordinary: "1200日", occupational: "1800日" },
  2: { ordinary: "1000日", occupational: "1500日" },
  3: { ordinary: "840日", occupational: "1260日" },
  4: { ordinary: "740日", occupational: "1110日" },
  5: { ordinary: "640日", occupational: "960日" },
  6: { ordinary: "540日", occupational: "810日" },
  7: { ordinary: "440日", occupational: "660日" },
  8: { ordinary: "360日", occupational: "540日" },
  9: { ordinary: "280日", occupational: "420日" },
  10: { ordinary: "220日", occupational: "330日" },
  11: { ordinary: "160日", occupational: "240日" },
  12: { ordinary: "100日", occupational: "150日" },
  13: { ordinary: "60日", occupational: "90日" },
  14: { ordinary: "40日", occupational: "60日" },
  15: { ordinary: "30日", occupational: "45日" },
};

function extractDisabilityLevels(q) {
  const levels = new Set();
  const patterns = [
    /第\s*(\d{1,2})\s*級/g,
    /grade\s*(\d{1,2})/gi,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(q)) !== null) {
      const level = Number(match[1]);
      if (DISABILITY_DAYS[level]) levels.add(level);
    }
  }

  return [...levels].sort((a, b) => a - b);
}

function buildDisabilityStandardPayload(levels, lang, mode) {
  const source = {
    title: "各失能等級之給付標準",
    url: "",
    snippet: "失能等級、普通傷病失能補助費給付標準、職業傷病失能補償費給付標準",
  };

  if (lang === "en") {
    const rows = levels.map((level) => {
      const d = DISABILITY_DAYS[level];
      return `- Grade ${level}: ordinary injury ${d.ordinary}; occupational injury ${d.occupational}.`;
    });
    return {
      answer: [
        "Summary",
        `- The disability payment days are available for ${levels.length === 1 ? "the requested grade" : "the requested grades"}.`,
        "",
        "Checklist",
        ...rows.map((row, i) => `${i + 1}. ${row.slice(2)}`),
        "",
        "Sources",
        "- Disability benefit payment days table",
        "",
        "Note: This is general guidance, not legal advice. Please verify with the Bureau of Labor Insurance (BLI).",
      ].join("\n"),
      sources: [source],
      mode,
      route: "disability_standard_lookup",
      intent: "disability_standard",
    };
  }

  const rows = levels.map((level) => {
    const d = DISABILITY_DAYS[level];
    return `${level}級：普通傷病 ${d.ordinary}；職業傷病 ${d.occupational}`;
  });

  return {
    answer: [
      "摘要",
      `- 已查到您詢問的失能等級給付日數。`,
      "",
      "檢查清單",
      ...rows.map((row, i) => `${i + 1}. 第${row}`),
      "",
      "資料來源",
      "- 各失能等級之給付標準",
      "",
      "註：本服務提供一般性說明，非法律意見；請以勞保局公告為準。",
    ].join("\n"),
    sources: [source],
    mode,
    route: "disability_standard_lookup",
    intent: "disability_standard",
  };
}

app.post('/ask', async (req, res) => {
  try {
    const OFFICE_REGEX = /(辦事處|分局|服務據點|地址|地點|位置|電話|開放時間|服務時間|office|branch|location|address|hours|phone)/i;
    

    const q = String(req.body?.q || '').slice(0, 2000);
    const lang = req.body?.lang === 'en' ? 'en' : 'zh';
    const mode = req.body?.mode === 'llm_only' ? 'llm_only' : 'rag';
    if (!q.trim()) return res.json({ answer: '', sources: [] });

    // cache
    const key = crypto.createHash('sha1').update(`${mode}::${lang}::${q}`).digest('hex');
    const cached = getCache(key);
    if (cached) return res.json(cached);

    const disabilityLevels = extractDisabilityLevels(q);
    const isDisabilityStandardQuestion = disabilityLevels.length > 0 &&
      /(失能|disability|grade)/i.test(q) &&
      /(給付日數|日數|days|paid)/i.test(q);

    if (mode === "rag" && isDisabilityStandardQuestion) {
      const payload = buildDisabilityStandardPayload(disabilityLevels, lang, mode);
      setCache(key, payload);
      return res.json(payload);
    }

    if (mode === 'llm_only') {
      const baselinePrompt = lang === 'en'
        ? {
            system: [
              "You are a helpful assistant for older adults in Taiwan.",
              "Answer using only your general knowledge and the user's question. Do not browse or claim to have checked official sources.",
              "If you are unsure about a detail, say so briefly.",
              "Use markdown with the same high-level structure as the main system:",
              " Summary",
              "- 1–3 short sentences.",
              " Checklist",
              "1. Step ...",
              " Sources",
              "- No retrieved source (LLM-only baseline).",
              "Add this footer line automatically:",
              "Note: This baseline answer is not grounded in retrieved official sources."
            ].join('\n'),
            user: `Question: ${q}\n\nWrite the answer now in English.`
          }
        : {
            system: [
              "你是提供一般性說明的助理。",
              "只根據你本身的一般知識與使用者問題作答；不要聲稱你已查核官方來源。",
              "若不確定細節，請簡短說明不確定。",
              "請使用與主系統相同的大致格式輸出：",
              " 摘要",
              "- 1–3 句短句。",
              " 檢查清單",
              "1. 步驟…",
              " 資料來源",
              "- 無檢索來源（LLM-only baseline）。",
              "並在文末加入這行：",
              "註：此基線回答未使用檢索到的官方資料。"
            ].join('\n'),
            user: `使用者問題：${q}\n\n請用繁體中文作答。`
          };

      const chat = await openai.chat.completions.create({
        model: 'gpt-4o',
        temperature: 0.2,
        messages: [
          { role: 'system', content: baselinePrompt.system },
          { role: 'user', content: baselinePrompt.user }
        ]
      });

      const payload = {
        answer: chat.choices?.[0]?.message?.content || '',
        sources: [],
        mode,
        model: 'gpt-4o',
        policy: 'llm_only_baseline'
      };
      setCache(key, payload);
      return res.json(payload);
    }

    await ensureCollection();

    // embed query
    const vector = await embed(q);

    // optional office filter
    let filter;
    if (OFFICE_REGEX.test(q)) {
      filter = { must: [{ key: 'type', match: { value: 'office' } }] };
    }

    // qdrant search
    let results = await qdrant.search(COLLECTION, {
      vector,
      limit: filter ? 8 : 12,
      with_payload: true,
      with_vectors: false,
      filter,
      search_params: { hnsw_ef: 256, exact: false }
    });
    results = Array.isArray(results) ? results : [];

    //path for offices
    const officeHits = (results || []).filter(h => h?.payload?.type === 'office');

    function pickBestOffice(hits, q) {
      if (!hits.length) return null;
      const qLower = q.toLowerCase();
      const score = (p) => {
        let s = 0;
        const add = (v, w = 1) => { if (v && qLower.includes(String(v).toLowerCase())) s += w; };
        add(p.city, 2); add(p.district, 1.5); add(p.title, 1.5); add(p.address, 1);
        return s + (p.phone ? 0.3 : 0) + (p.hours ? 0.3 : 0);
      };
      let best = hits[0], bestScore = -1;
      for (const h of hits) {
        const sc = score(h.payload || {});
        if (sc > bestScore) { best = h; bestScore = sc; }
      }
      return best?.payload || null;
    }

    function extractFromText(txt) {
      const out = {};
      const mAddr = txt.match(/地址[:：]\s*(.+)/);
      const mPhone = txt.match(/電話[:：]\s*([0-9\-（）()轉extx]+.*)/);
      const mHours = txt.match(/(服務時間|洽辦時間|開放時間)[:：]\s*(.+)/);
      if (mAddr) out.address = mAddr[1].trim();
      if (mPhone) out.phone = mPhone[1].trim();
      if (mHours) out.hours = mHours[2]?.trim() || mHours[1]?.trim();
      return out;
    }

    if (OFFICE_REGEX.test(q) && officeHits.length) {
      // If user didn't mention a specific city/district, guide them with examples
      const NEEDS_CITY = !/(台北|臺北|新北|基隆|桃園|新竹|苗栗|台中|臺中|彰化|南投|雲林|嘉義|台南|臺南|高雄|屏東|宜蘭|花蓮|台東|臺東|澎湖|金門|連江|馬祖|Kaohsiung|Taipei|Taichung|Tainan|Hsinchu|Keelung|Yilan|Hualien|Taitung|Pingtung|Changhua|Miaoli|Nantou|Yunlin|Chiayi|Penghu|Kinmen|Lienchiang|Matsu)/i.test(q);
    
      if (NEEDS_CITY) {
        // Build a few friendly examples from the data we already have
        const sampleCities = Array.from(
          new Set(
            officeHits
              .map(h => h?.payload?.city)
              .filter(Boolean)
          )
        ).slice(0, 6);
    
        const examplesZh = sampleCities.length
          ? sampleCities.map(c => `- ${c}辦事處`).join('\n')
          : `- 台北辦事處\n- 台中辦事處\n- 高雄分局`;
    
        const examplesEn = sampleCities.length
          ? sampleCities.map(c => `- ${c} office`).join('\n')
          : `- Taipei office\n- Taichung office\n- Kaohsiung branch`;
    
        return res.json({
          answer: lang === 'zh'
            ? `請告訴我您要查詢的縣市或區域，例如：\n${examplesZh}\n\n或直接輸入附近地名關鍵字（如「鳳山」、「新店」）。`
            : `Please tell me which city or district you want, for example:\n${examplesEn}\n\nOr type a nearby place (e.g., "Fengshan", "Xindian").`,
          sources: []
        });
      }
    
      // Otherwise, pick the best-matching office and return details (unchanged)
      const cityKey = detectCityKey(q);

      let candidates = officeHits;
      if (cityKey) {
        const nCityKey = normPlace(cityKey);
        const filtered = officeHits.filter(h => {
          const p = h.payload || {};
          return normPlace(p.city).includes(nCityKey)
            || normPlace(p.title).includes(nCityKey)
            || normPlace(p.address).includes(nCityKey);
        });
        if (filtered.length) candidates = filtered;
      }

      const top = pickBestOffice(candidates, q);

      if (top) {
        const addr = [top.zip, top.city, top.district, top.address].filter(Boolean).join(' ');
        const fallback = extractFromText(top.text || '');
        const finalAddr  = addr || fallback.address || '';
        const finalPhone = top.phone || fallback.phone || '';
        const finalHours = top.hours || fallback.hours || '';
    
        const answerZh = [
          `**${top.title || '辦事處'}**`,
          finalAddr  ? `- 地址：${finalAddr}` : null,
          finalHours ? `- 服務時間：${finalHours}` : null,
          finalPhone ? `- 電話：${finalPhone}` : null,
          top.fax    ? `- 傳真：${top.fax}` : null,
          top.url    ? `- 官方連結：${top.url}` : null,
          '',
          '小提醒：建議先電話確認是否需預約與攜帶文件。'
        ].filter(Boolean).join('\n');
    
        const answerEn = [
          `**${top.title || 'Branch Office'}**`,
          finalAddr  ? `- Address: ${finalAddr}` : null,
          finalHours ? `- Hours: ${finalHours}` : null,
          finalPhone ? `- Phone: ${finalPhone}` : null,
          top.fax    ? `- Fax: ${top.fax}` : null,
          top.url    ? `- Official link: ${top.url}` : null,
          '',
          'Tip: Call ahead to confirm whether an appointment or documents are required.'
        ].filter(Boolean).join('\n');
    
        const payload = {
          answer: lang === 'en' ? answerEn : answerZh,
          mode,
          route: 'office_lookup',
          intent: 'office',
          sources: [{
            title: top.title || (lang === 'zh' ? '無標題' : 'Untitled'),
            url: top.url || '',
            snippet: (top.text || '').slice(0, 160)
          }]
        };
        setCache(key, payload);
        return res.json(payload);
      }
    }

    // normal RAG path laws/regs
    const deduped = dedupBy(results, (h) => (h?.payload?.url || h?.payload?.title || '').trim());
    const picked = simpleMMR(deduped).slice(0, 5);

    const { system, user } = buildPrompt({ q, lang, contexts: picked });

    const chat = await openai.chat.completions.create({
      model: 'gpt-4o', //gpt-4o gpt-4o-mini
      temperature: 0.2,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ]
    });

    const answer = chat.choices?.[0]?.message?.content || '';

    const sources = picked.map((h) => ({
      title: h.payload?.title || (lang === 'zh' ? '無標題' : 'Untitled'),
      url: h.payload?.url || '',
      snippet: (h.payload?.text || '').slice(0, 120) + ((h.payload?.text || '').length > 120 ? '…' : '')
    }));

    const payload = { answer, sources, mode, route: 'rag', intent: 'general', model: 'gpt-4o' };
    setCache(key, payload);

    try {
      const logDir = path.join(process.cwd(), 'logs');
      fs.mkdirSync(logDir, { recursive: true });
      fs.appendFileSync(
        path.join(logDir, 'rag.log'),
        JSON.stringify({ ts: new Date().toISOString(), q, lang, mode, sources: sources.slice(0, 3) }) + '\n',
        'utf8'
      );
    } catch {}

    return res.json(payload);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'server_error', detail: String(e) });
  }
});

// look at few points
app.get('/debug/scroll', async (_req, res) => {
  try {
    const r = await qdrant.scroll(COLLECTION, { with_payload: true, limit: 3 });
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// tts 
app.post('/tts', async (req, res) => {
    try {
      const text = String(req.body?.text || '').trim().slice(0, 1200); // keep short for latency
      const lang = req.body?.lang === 'en' ? 'en' : 'zh';
  
      if (!text) return res.status(400).json({ error: 'missing text' });
  
      const apiKey = process.env.ELEVENLABS_API_KEY;
      if (!apiKey) return res.status(500).json({ error: 'no_elevenlabs_key' });
  
      // choose voice by language
      const voiceId = (lang === 'en'
        ? process.env.TTS_VOICE_EN
        : process.env.TTS_VOICE_ZH) || process.env.TTS_VOICE_EN || process.env.TTS_VOICE_ZH;
  
      if (!voiceId) {
        return res.status(500).json({ error: 'no_voice_config', hint: 'Set TTS_VOICE_ZH / TTS_VOICE_EN in .env' });
      }
  
      const model = process.env.TTS_MODEL || 'eleven_multilingual_v2';
      const key = crypto.createHash('sha1').update(`${voiceId}::${model}::${lang}::${text}`).digest('hex');
  
      const cached = getAudioCache(key);
      if (cached) {
        res.setHeader('Content-Type', 'audio/mpeg');
        return res.send(cached);
      }
  
      const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;
      const r = await fetch(url, {
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
          'Accept': 'audio/mpeg'
        },
        body: JSON.stringify({
          text,
          model_id: model,
          voice_settings: {
            stability: 0.45,
            similarity_boost: 0.7,
            style: 0.15,
            use_speaker_boost: true
          }
        })
      });
  
      if (!r.ok) {
        const errTxt = await r.text().catch(() => '');
        return res.status(500).json({ error: 'tts_failed', detail: errTxt.slice(0, 500) });
      }
  
      const buf = Buffer.from(await r.arrayBuffer());
      setAudioCache(key, buf);
      res.setHeader('Content-Type', 'audio/mpeg');
      return res.send(buf);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'server_error', detail: String(e) });
    }
  });

  // POST /transcribe whisper
  const EXT = {
    "audio/webm": "webm",
    "audio/ogg": "ogg",
    "audio/oga": "oga",
    "audio/wav": "wav",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/mp4": "m4a",
    "audio/x-m4a": "m4a",
    "audio/flac": "flac",
  };


app.post("/transcribe", upload.single("audio"), async (req, res) => {
  let tmpPath;
  try {
    if (!req.file) {
      return res.status(400).json({ error: "no_audio", detail: "Field 'audio' is required" });
    }

    tmpPath = req.file.path;
    const mime = req.file.mimetype || "audio/webm";
    const ext = EXT[mime] || "webm";
    const filename = `speech.${ext}`;

    // Wrap the file with a proper filename so OpenAI can recognize the format
    const fileForOpenAI = await toFile(fs.createReadStream(tmpPath), filename, {
      // optional, but helps
      contentType: mime,
    });

    const tr = await openai.audio.transcriptions.create({
      model: "whisper-1",
      file: fileForOpenAI,
      language: "zh",          // keep Chinese
      response_format: "text", // return plain string
      // prompt: "勞保, 退休金, 銀髮就業, 申請, 文件, 補助" // optional bias
    });

    const text = (typeof tr === "string" ? tr : tr?.text || "").trim();
    return res.json({ text });

  } catch (err) {
    console.error("Transcription failed:", err);
    return res.status(500).json({ error: "transcription_failed", detail: String(err?.message || err) });
  } finally {
    try { if (tmpPath) fs.unlinkSync(tmpPath); } catch {}
  }
});

app.listen(PORT, () => console.log(`retriever-api on :${PORT}`));
