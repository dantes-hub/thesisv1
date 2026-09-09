import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import OpenAI from 'openai';
import { QdrantClient } from '@qdrant/js-client-rest';
import fetch from 'node-fetch';
import multer from "multer";
import { toFile } from "openai/uploads";
import {
  dedupBy,
  simpleMMR,
  normPlace,
  detectCityKey,
  googleMapsUrl,
  extractDisabilityLevels,
  buildDisabilityStandardPayload,
  pickBestOffice,
  extractFromText,
  normalizeOfficeName,
  buildOfficeAddress,
} from './lib/retrieval.js';

const app = express();

const IS_PROD = process.env.NODE_ENV === 'production';

// Behind a single reverse proxy (Render/Fly/Nginx) so rate limiting sees the
// real client IP instead of the proxy's.
app.set('trust proxy', 1);

// CORS: only the origins we ship. Every endpoint below spends OpenAI /
// ElevenLabs credits per call, so a wildcard origin is a billing hole.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, cb) {
    // No Origin header: curl, health checks, server-to-server. Allowed.
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error('origin_not_allowed'));
  },
}));

app.use(express.json({ limit: '1mb' }));

// Rate limits, per IP. The paid endpoints get tighter budgets than the rest.
const limiter = (windowMs, max, message) => rateLimit({
  windowMs,
  max,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limited', detail: message },
});

// Configurable so a local evaluation batch can raise them; the defaults are
// what a deployed instance should run with.
const perMin = (name, fallback) => Number(process.env[name]) || fallback;

const askLimiter = limiter(60 * 1000, perMin('RATE_LIMIT_ASK', 10), 'Too many questions. Wait a minute and try again.');
const ttsLimiter = limiter(60 * 1000, perMin('RATE_LIMIT_TTS', 10), 'Too many speech requests. Wait a minute and try again.');
const transcribeLimiter = limiter(60 * 1000, perMin('RATE_LIMIT_TRANSCRIBE', 5), 'Too many recordings. Wait a minute and try again.');
// Blanket ceiling so no single IP can hammer the process.
app.use(limiter(60 * 1000, perMin('RATE_LIMIT_GLOBAL', 60), 'Too many requests.'));
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
// gpt-4o is the model the thesis evaluation was run against, so it stays the
// default. A public demo can set CHAT_MODEL=gpt-4o-mini to cut cost ~17x.
const CHAT_MODEL = process.env.CHAT_MODEL || 'gpt-4o';
const CHAT_TEMPERATURE = Number(process.env.CHAT_TEMPERATURE ?? 0.2);
const EMBED_MODEL = process.env.EMBED_MODEL || 'text-embedding-3-large';

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
    model: EMBED_MODEL,
    input: text
  });
  return r.data[0].embedding;
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
  


// Exception text can carry keys, hostnames, and stack detail, so only
// non-production callers see it. Everything is logged server-side regardless.
function safeDetail(e) {
  return IS_PROD ? undefined : String(e?.message || e);
}

//  endpoints 
app.get('/health', async (_req, res) => {
  try {
    const info = await qdrant.getCollections();
    res.json({ ok: true, collections: info.collections?.map(c => c.name) || [] });
  } catch (e) {
    console.error('health check failed:', e);
    res.status(500).json({ ok: false, error: 'qdrant_unreachable', detail: safeDetail(e) });
  }
});

app.post('/ask', askLimiter, async (req, res) => {
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
        model: CHAT_MODEL,
        temperature: CHAT_TEMPERATURE,
        messages: [
          { role: 'system', content: baselinePrompt.system },
          { role: 'user', content: baselinePrompt.user }
        ]
      });

      const payload = {
        answer: chat.choices?.[0]?.message?.content || '',
        sources: [],
        mode,
        model: CHAT_MODEL,
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
        const fallback = extractFromText(top.text || '');

        // The source dataset puts the office name in its "city" column, so the
        // payload's city is really a name like 台北市辦事處 and the title ends up
        // doubled (台北市辦事處辦事處). Normalise both rather than concatenating
        // the name back into the address.
        const officeName = normalizeOfficeName(top.title);
        const addr = buildOfficeAddress(top);

        const finalAddr  = addr || fallback.address || '';
        const finalPhone = top.phone || fallback.phone || '';
        const finalHours = top.hours || fallback.hours || '';
        const mapUrl = googleMapsUrl({ lat: top.lat, lng: top.lng, address: finalAddr });
    
        const answerZh = [
          `**${officeName || '辦事處'}**`,
          finalAddr  ? `- 地址：${finalAddr}` : null,
          finalHours ? `- 服務時間：${finalHours}` : null,
          finalPhone ? `- 電話：${finalPhone}` : null,
          top.fax    ? `- 傳真：${top.fax}` : null,
          top.url    ? `- 官方連結：${top.url}` : null,
          '',
          '小提醒：建議先電話確認是否需預約與攜帶文件。'
        ].filter(Boolean).join('\n');
    
        const answerEn = [
          `**${officeName || 'Branch Office'}**`,
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
          office: {
            name: officeName || (lang === 'zh' ? '辦事處' : 'Branch Office'),
            address: finalAddr,
            phone: finalPhone,
            hours: finalHours,
            fax: top.fax || '',
            url: top.url || '',
            map_url: mapUrl,
          },
          sources: [{
            title: officeName || (lang === 'zh' ? '無標題' : 'Untitled'),
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
      model: CHAT_MODEL,
      temperature: CHAT_TEMPERATURE,
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

    const payload = { answer, sources, mode, route: 'rag', intent: 'general', model: CHAT_MODEL };
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
    return res.status(500).json({ error: 'server_error', detail: safeDetail(e) });
  }
});

// Dumps raw indexed payloads, so it stays off in production.
if (!IS_PROD) {
  app.get('/debug/scroll', async (_req, res) => {
    try {
      const r = await qdrant.scroll(COLLECTION, { with_payload: true, limit: 3 });
      res.json(r);
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });
}

// tts 
app.post('/tts', ttsLimiter, async (req, res) => {
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
      return res.status(500).json({ error: 'server_error', detail: safeDetail(e) });
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


app.post("/transcribe", transcribeLimiter, upload.single("audio"), async (req, res) => {
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
    return res.status(500).json({ error: "transcription_failed", detail: safeDetail(err) });
  } finally {
    try { if (tmpPath) fs.unlinkSync(tmpPath); } catch {}
  }
});

// Terminal error handler: CORS rejections and multer upload failures land here
// and would otherwise render an HTML stack trace.
app.use((err, _req, res, _next) => {
  if (err?.message === 'origin_not_allowed') {
    return res.status(403).json({ error: 'origin_not_allowed' });
  }
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'file_too_large', detail: 'Audio must be under 15MB.' });
  }
  if (err?.message === 'Unsupported audio type') {
    return res.status(415).json({ error: 'unsupported_audio_type' });
  }
  console.error('unhandled error:', err);
  return res.status(500).json({ error: 'server_error', detail: safeDetail(err) });
});

app.listen(PORT, () => {
  console.log(`retriever-api on :${PORT}`);
  console.log(`CORS allowed origins: ${ALLOWED_ORIGINS.join(', ')}`);
});
