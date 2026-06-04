"use client";

import { useState, useRef, useEffect, use } from "react";
import axios from "axios";
import { t } from "../../lib/i18n";

function hashKey(text, lang) {
  return `${lang}::${text.slice(0, 500)}`;
}

export default function Page({ params }) {
  const { locale: rawLocale } = use(params);
  const locale = rawLocale === "en" ? "en" : "zh";

  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [big, setBig] = useState(true);
  const [highContrast, setHighContrast] = useState(false);
  const [loading, setLoading] = useState(false);
  const ttsPlaying = useRef(new Map());
  const listRef = useRef(null);

// TTS ui states
const ttsBlobUrlCache = useRef(new Map());
const ttsLoading = useRef(new Map());
const [ttsStatus, setTtsStatus] = useState({});    
const [ttsCache, setTtsCache] = useState({});       
const ttsAudioRef = useRef(new Map());             

const setStatus = (i, s) => setTtsStatus(prev => ({ ...prev, [i]: s }));

  //voice record
  const [micState, setMicState] = useState('idle'); 
  const mediaStreamRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, loading]);

  // high contrast toggle 
  useEffect(() => {
    const root = document.documentElement;
    if (highContrast) root.classList.add("high-contrast");
    else root.classList.remove("high-contrast");
  }, [highContrast]);

  const faqList = [
    { zh: "我幾歲可以領勞保老年年金？", en: "At what age can I claim labor insurance old-age pension?" },
    { zh: "勞工保險失能給付有哪些條件？", en: "What are the conditions for disability benefits?" },
    { zh: "如何申請遺囑撫恤金？", en: "How to apply for survivors’ benefits?" },
    { zh: "哪裡可以找到勞保局各地辦事處？", en: "Where can I find Labor Insurance Bureau branch offices?" },
    { zh: "失能給付可以領多少？", en: "How much can I receive for disability benefits?" }
  ];

  async function send(inputText) {
    const text = (inputText ?? input).trim();
    if (!text) return;

    const userMsg = { role: "user", content: text };
    setMessages((m) => [...m, userMsg]);
    setInput("");
    setLoading(true);

    try {
      const r = await axios.post(`${process.env.NEXT_PUBLIC_API_URL}/ask`, { q: text, lang: locale });
      let sources = [];

      // preferred: backend returns pre-formatted sources
      if (Array.isArray(r.data?.sources)) {
        sources = r.data.sources;
      
      // backward-compat: if backend returns raw qdrant hits
      } else if (Array.isArray(r.data?.hits)) {
        sources = r.data.hits.map((h) => ({
          title: h?.payload?.title || (locale === "zh" ? "無標題" : "Untitled"),
          url: h?.payload?.url || "",
          snippet:
            (h?.payload?.text || "").slice(0, 100) +
            ((h?.payload?.text || "").length > 100 ? "…" : ""),
        }));
      }
      const botMsg = { role: "assistant", content: r.data?.answer || "", sources };
      setMessages((m) => [...m, botMsg]);
    } catch {
      const errMsg = locale === "zh" ? "系統連線失敗，請稍後再試。" : "Connection failed, try again later.";
      setMessages((m) => [...m, { role: "assistant", content: errMsg }]);
    } finally {
      setLoading(false);
    }
  }
  // record 
  function stopRecording() {
    const rec = mediaRecorderRef.current;
    if (rec && rec.state === "recording") {
      rec.stop(); // onstop will handle processing 
    }
  }
  
  async function startRecording() {
    if (micState !== 'idle') return;         // guard againnst sending twice
    try {
      setMicState('recording');
  
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;
  
      const mime = MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : MediaRecorder.isTypeSupported("audio/mp4")
        ? "audio/mp4"
        : "";
  
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      mediaRecorderRef.current = rec;
      chunksRef.current = [];
  
      rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunksRef.current.push(e.data); };
  
      rec.onstop = async () => {
        //  now upload transcribe
        setMicState('processing');
        try {
          const blobType = mime || (chunksRef.current[0]?.type || "audio/webm");
          const blob = new Blob(chunksRef.current, { type: blobType });
  
          const fd = new FormData();
          fd.append("audio", blob, blob.type.includes("mp4") ? "speech.m4a" : "speech.webm");
  
          const resp = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/transcribe`, { method: "POST", body: fd });
          if (!resp.ok) throw new Error("Transcription failed");
          const data = await resp.json();
          const text = (data?.text || "").trim();
  
          if (text) {
            await send(text); // send
          } else {
            alert(locale === "zh" ? "我沒有聽清楚，請再說一次。" : "I couldn’t catch that—please try again.");
          }
        } catch (err) {
          console.error(err);
          alert(locale === "zh" ? "語音辨識發生錯誤" : "Voice transcription error");
        } finally {
          try { if (mediaStreamRef.current) mediaStreamRef.current.getTracks().forEach(t => t.stop()); } catch {}
          mediaStreamRef.current = null;
          mediaRecorderRef.current = null;
          setMicState('idle'); 
        }
      };
  
      rec.start();
      // optional: auto stop after 30s
      setTimeout(() => { if (rec.state === "recording") stopRecording(); }, 30000);
    } catch (err) {
      console.error(err);
      alert(locale === "zh" ? "麥克風權限被拒絕" : "Microphone permission denied");
      setMicState('idle');
    }
  }
  
  
  
  function onKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  function newChat() {
    for (const audio of ttsAudioRef.current.values()) {
      try { audio.pause(); } catch {}
    }
    for (const url of ttsBlobUrlCache.current.values()) {
      URL.revokeObjectURL(url);
    }
    ttsAudioRef.current.clear();
    ttsBlobUrlCache.current.clear();
    ttsLoading.current.clear();
    ttsPlaying.current.clear();
    setMessages([]);
    setInput("");
  }

  async function ensureAudioForMessage(idx, text, lang) {
    const key = hashKey(text, lang);
    let blobUrl = ttsCache[key];
  
    if (!blobUrl) {
      setStatus(idx, 'loading');
      const r = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, lang }),
      });
      if (!r.ok) { setStatus(idx, 'idle'); throw new Error("TTS error"); }
      const blob = await r.blob();
      blobUrl = URL.createObjectURL(blob);
      setTtsCache(prev => ({ ...prev, [key]: blobUrl }));
      // status will flip to 'paused' when we attach and not playing yet
    }
  
    let audio = ttsAudioRef.current.get(idx);
    if (!audio) {
      audio = new Audio();
      ttsAudioRef.current.set(idx, audio);
      audio.addEventListener("play",  () => setStatus(idx, 'playing'));
      audio.addEventListener("pause", () => setStatus(idx, 'paused'));
      audio.addEventListener("ended", () => setStatus(idx, 'idle'));
    }
  
    audio.src = blobUrl;
    if (audio.paused) setStatus(idx, 'paused'); // ready to play
    return audio;
  }
  
  

  async function handleTTS(idx, text, lang) {
    try {
      const audio = await ensureAudioForMessage(idx, text, lang);
      if (!audio) return;
  
      if (audio.paused) {
        await audio.play();   // will set 'playing' via event
      } else {
        audio.pause();        // will set 'paused' via event
      }
    } catch (e) {
      console.error(e);
      alert(lang === "zh" ? "語音服務發生錯誤" : "TTS error");
      setStatus(idx, 'idle');
    }
  }
  
  return (
    <div className="w-full">
      {/* Title */}
      <header className="text-center mb-3">
        <h1 className="text-4xl md:text-5xl font-extrabold tracking-tight text-slate-900">
          {t(locale, "title")}
        </h1>
        <p className="mt-1 text-base md:text-lg text-slate-700">
          {t(locale, "desc")}
        </p>
      </header>

      {/*  toolbar */}
      <div className="mx-auto max-w-4xl mb-3">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
          {/* FAQ chips */}
          <div className="flex flex-wrap gap-2">
            {faqList.map((f, idx) => (
              <button
                key={idx}
                onClick={() => send(locale === "zh" ? f.zh : f.en)}
                className="rounded-full border border-slate-300 bg-white px-4 py-2 text-sm md:text-base text-slate-900 hover:bg-slate-50 shadow-sm"
              >
                {locale === "zh" ? f.zh : f.en}
              </button>
            ))}
          </div>

          {/* new chat */}
          <div className="flex flex-wrap items-center gap-3">
            <label className="inline-flex items-center gap-2 text-sm md:text-base text-slate-900">
              <input
                type="checkbox"
                className="h-6 w-6"
                checked={big}
                onChange={(e) => setBig(e.target.checked)}
              />
              {t(locale, "big")}
            </label>
            <label className="inline-flex items-center gap-2 text-sm md:text-base text-slate-900">
              <input
                type="checkbox"
                className="h-6 w-6"
                checked={highContrast}
                onChange={(e) => setHighContrast(e.target.checked)}
              />
              {locale === "zh" ? "高對比" : "High contrast"}
            </label>
            <button
              onClick={newChat}
              className="rounded-xl bg-sky-600 text-white px-4 py-2 text-sm md:text-base font-semibold hover:bg-sky-700 shadow"
            >
              {locale === "zh" ? "新對話" : "New chat"}
            </button>
          </div>
        </div>
      </div>

      {/* chat area */}
      <section
        ref={listRef}
        className="mx-auto max-w-4xl h-[48vh] md:h-[58vh] overflow-y-auto rounded-2xl border border-slate-200 bg-white p-3 space-y-3"
      >
        {messages.length === 0 && (
          <div className="h-full w-full flex items-center justify-center">
            <div className="text-center">
              <div className="text-2xl font-semibold text-slate-800 mb-1">
                {locale === "zh" ? "開始提問吧" : "Ask anything"}
              </div>
              <div className="text-slate-500 text-sm md:text-base">
                {locale === "zh" ? "可點選上方常見問題或在下方輸入問題" : "Tap a sample above or type below"}
              </div>
            </div>
          </div>
        )}

        {messages.map((m, i) => {
          const isUser = m.role === "user";
          const status = ttsStatus[i] || 'idle';
          return (
            <div key={i} className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
              <div
                className={`max-w-[82%] rounded-2xl px-4 py-3 leading-relaxed text-[17px] shadow-sm
                  ${isUser ? "bg-sky-100 text-slate-900" : "bg-slate-50 text-slate-900 border border-slate-200"}`}
              >
                  <div
                        className={`${big ? "big-text" : ""} whitespace-pre-wrap`}
                        dangerouslySetInnerHTML={{
                          __html: m.content.replace(
                            /(https?:\/\/[^\s]+)/g,
                            '<a href="$1" target="_blank" rel="noopener noreferrer" class="underline text-sky-400 hover:text-sky-300">$1</a>'
                          ),
                        }}
                      />

                {!isUser && (
                  <div className="mt-2 flex flex-col gap-2 text-sm">
                  <button
                    className={`self-start rounded-full px-3 py-1 border ${
                      status === 'loading'
                        ? "bg-white text-slate-400 border-slate-200 cursor-wait"
                        : status === 'playing'
                        ? "bg-emerald-50 text-emerald-800 border-emerald-200 hover:bg-emerald-100"
                        : "bg-white text-sky-800 border-sky-200 hover:bg-sky-50"
                    }`}
                    disabled={status === 'loading'}
                    onClick={() => handleTTS(i, m.content, locale)}
                  >
                    {status === 'loading'
                      ? (locale === "zh" ? "⏳ 生成中…" : "⏳ Generating…")
                      : status === 'playing'
                      ? (locale === "zh" ? "⏸ 暫停" : "⏸ Pause")
                      : status === 'paused'
                      ? (locale === "zh" ? "▶️ 繼續" : "▶️ Resume")
                      : (locale === "zh" ? "▶️ 播放" : "▶️ Play")}
                  </button>

                    {m.sources && m.sources.length > 0 && (
                      <div>
                        <div className="font-semibold text-slate-700 mb-1">
                          {locale === "zh" ? "資料來源" : "Sources"}
                        </div>
                        <ul className="space-y-1">
                          {m.sources.slice(0, 5).map((s, idx) => (
                            <li key={idx} className="text-slate-700">
                              {s.url ? (
                                <a
                                  className="underline underline-offset-2 hover:text-sky-700"
                                  href={s.url}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  {s.title || s.url}
                                </a>
                              ) : (
                                <span>{s.title}</span>
                              )}
                              {s.snippet ? (
                                <span className="ml-2 text-slate-500">{s.snippet}</span>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}

        {loading && (
          <div className="flex justify-start">
            <div className="max-w-[82%] rounded-2xl px-4 py-3 bg-slate-50 text-slate-500 shadow-sm border border-slate-200">
              {locale === "zh" ? "…回覆中" : "…thinking"}
            </div>
          </div>
        )}
      </section>

      {/* sticky composer*/}
      <div className="mx-auto max-w-3xl mt-3 sticky bottom-3">
        <div className="rounded-full shadow-md border border-slate-200 bg-white px-4 py-3 flex items-center gap-2">
          <textarea
            className="flex-1 resize-none px-2 py-1 outline-none text-[16px] placeholder:text-slate-400"
            rows={1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t(locale, "placeholder")}
            aria-label={t(locale, "yourQuestion")}
          />
          {locale === "zh" && (         
            <button
              onClick={() => (micState === 'recording' ? stopRecording() : startRecording())}
              disabled={loading || micState === 'processing'}  // 
              className={`rounded-full px-4 py-2 text-lg font-semibold shadow
                ${micState === 'recording'
                  ? "bg-rose-600 text-white hover:bg-rose-700"
                  : micState === 'processing'
                  ? "bg-gray-300 text-gray-700 cursor-wait"
                  : "bg-emerald-600 text-white hover:bg-emerald-700"}`}
            >
              {micState === 'processing'
                ? (locale === "zh" ? "⏳ 辨識中…" : "⏳ Processing…")
                : micState === 'recording'
                ? (locale === "zh" ? "⏹ 停止" : "⏹ Stop")
                : (locale === "zh" ? "🎙️ 語音" : "🎙️ Speak")}
            </button>) 
          }
          
          <button
            onClick={() => send()}
            disabled={loading}
            className="rounded-xl bg-sky-600 text-white px-4 py-2 text-sm md:text-base font-semibold hover:bg-sky-700 disabled:opacity-50"
          >
            {loading ? (locale === "zh" ? "送出中…" : "Sending…") : t(locale, "ask")}
          </button>
        </div>
        <div className="mt-2 flex justify-end">
          <button
            onClick={() => window.print()}
            className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs md:text-sm text-slate-700 hover:bg-slate-50"
          >
            {locale === "zh" ? "列印/儲存" : "Print/Save"}
          </button>
        </div>
      </div>

      {/* disclaimer */}
      <footer className="mt-3 text-center text-[11px] md:text-xs text-slate-500 italic">
        {t(locale, "disclaimer")}
      </footer>
    </div>
  );
}
