'use client'

import { use, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import ReactMarkdown from 'react-markdown'
import { BookOpen, Check, ChevronRight, CircleAlert, Headphones, Mic, Pause, Play, Printer, RotateCcw, Send, ShieldCheck, Square, Volume2, X } from 'lucide-react'
import zh from '../../messages/zh.json'
import en from '../../messages/en.json'

type Locale = 'zh' | 'en'
type Source = { title: string; url: string; snippet?: string }
type Message = { id: string; role: 'user' | 'assistant'; content: string; sources?: Source[]; route?: string; office?: { name?: string; address?: string; phone?: string; hours?: string; map_url?: string } }
type SpeechState = 'idle' | 'loading' | 'playing' | 'paused'
type MicState = 'idle' | 'recording' | 'processing'

const copy = { zh, en } as const
const faqs = ['faq1', 'faq2', 'faq3', 'faq4', 'faq5'] as const

function t(locale: Locale, key: string) {
  return (copy[locale] as Record<string, string>)[key] ?? key
}

function AssistantMessage({ message, locale, speech, onSpeak, canSpeak }: { message: Message; locale: Locale; speech: SpeechState; onSpeak: () => void; canSpeak: boolean }) {
  const isOffice = message.route === 'office_lookup' && message.office
  return <article className="assistant-message">
    <div className="message-kicker"><ShieldCheck size={18} aria-hidden="true" /> {t(locale, 'answer')}</div>
    <div className="answer-markdown"><ReactMarkdown>{message.content}</ReactMarkdown></div>
    {isOffice && <div className="info-card"><div><span>{t(locale, 'office')}</span><strong>{message.office?.name}</strong></div>{message.office?.address && <div><span>{t(locale, 'address')}</span><strong>{message.office.address}</strong></div>}{message.office?.hours && <div><span>{t(locale, 'hours')}</span><strong>{message.office.hours}</strong></div>}{message.office?.phone && <div><span>{t(locale, 'phone')}</span><a href={`tel:${message.office.phone}`}>{message.office.phone}</a></div>}{message.office?.map_url && <a className="map-link" href={message.office.map_url} target="_blank" rel="noopener noreferrer">{t(locale, 'map')} <ChevronRight size={18} /></a>}</div>}
    {canSpeak && <button className="speech-button" type="button" onClick={onSpeak} aria-label={`${t(locale, 'speechLabel')}: ${speech === 'playing' ? t(locale, 'pause') : t(locale, 'play')}`} disabled={speech === 'loading'}>{speech === 'loading' ? <Volume2 className="spin" size={20} /> : speech === 'playing' ? <Pause size={20} /> : <Play size={20} />}<span>{speech === 'loading' ? t(locale, 'generating') : speech === 'playing' ? t(locale, 'pause') : speech === 'paused' ? t(locale, 'resume') : t(locale, 'play')}</span></button>}
    {message.sources && message.sources.length > 0 && <section className="sources" aria-label={t(locale, 'sources')}><h3><BookOpen size={18} /> {t(locale, 'sources')}</h3>{message.sources.slice(0, 5).map((source, index) => <div className="source-item" key={`${source.url}-${index}`}><span className="source-number">{index + 1}</span><div><a href={source.url} target="_blank" rel="noopener noreferrer">{source.title}</a>{source.snippet && <p>{source.snippet}</p>}</div></div>)}</section>}
  </article>
}

export default function LocalePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale: rawLocale } = use(params)
  const locale: Locale = rawLocale === 'en' ? 'en' : 'zh'
  const [messages, setMessages] = useState<Message[]>([])
  const [question, setQuestion] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [faqOpen, setFaqOpen] = useState(false)
  const [canSpeak, setCanSpeak] = useState(true)
  const [bigText, setBigText] = useState(true)
  const [contrast, setContrast] = useState(false)
  const [mic, setMic] = useState<MicState>('idle')
  const [recordingSeconds, setRecordingSeconds] = useState(0)
  const [speechStates, setSpeechStates] = useState<Record<string, SpeechState>>({})
  const [audioUrls, setAudioUrls] = useState<Record<string, string>>({})
  const audioRef = useRef<Record<string, HTMLAudioElement>>({})
  const playingRef = useRef<string | null>(null)
  const conversationRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const apiUrl = process.env.NEXT_PUBLIC_API_URL || ''
  const text = useMemo(() => copy[locale], [locale])

  // Ask the API whether speech is configured. Offering a Play button that is
  // certain to fail is worse for this audience than not offering one.
  useEffect(() => {
    let cancelled = false
    fetch(`${apiUrl}/health`)
      .then((r) => r.json())
      .then((d) => { if (!cancelled && d && d.tts === false) setCanSpeak(false) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [apiUrl])

  // Restore saved preferences before anything persists, so the mount pass of the
  // effects below cannot overwrite them with the defaults.
  const hydrated = useRef(false)
  useEffect(() => {
    // localStorage does not exist during server rendering, so saved preferences
    // can only be applied after mount. This is the documented exception to the
    // set-state-in-effect rule: syncing state from an external store.
    /* eslint-disable react-hooks/set-state-in-effect */
    try {
      const savedContrast = localStorage.getItem('contrast')
      if (savedContrast) setContrast(savedContrast === 'high')
      const savedBig = localStorage.getItem('bigText')
      if (savedBig !== null) setBigText(savedBig === '1')
    } catch {}
    /* eslint-enable react-hooks/set-state-in-effect */
    hydrated.current = true
  }, [])

  // The theme variables must be set on the document root: html and body are
  // ancestors of the app shell, so an attribute on the shell leaves the page
  // background light while its descendants go dark.
  useEffect(() => {
    document.documentElement.dataset.contrast = contrast ? 'high' : 'normal'
  }, [contrast])

  const skipFirstPersist = useRef(true)
  useEffect(() => {
    if (skipFirstPersist.current) { skipFirstPersist.current = false; return }
    try {
      localStorage.setItem('contrast', contrast ? 'high' : 'normal')
      localStorage.setItem('bigText', bigText ? '1' : '0')
    } catch {}
  }, [contrast, bigText])

  // The conversation is no longer its own scroll container, so bring the newest
  // message to the top of the viewport where it can actually be read.
  useEffect(() => {
    conversationRef.current?.lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [messages, loading])
  useEffect(() => () => { Object.values(audioRef.current).forEach((a) => a.pause()) }, [])

  const resize = () => { const el = textareaRef.current; if (el) { el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 180)}px` } }
  const ask = async (value = question) => {
    const q = value.trim(); if (!q || loading) return
    setError(''); setQuestion(''); setFaqOpen(false); if (textareaRef.current) textareaRef.current.style.height = 'auto'
    setMessages((current) => [...current, { id: crypto.randomUUID(), role: 'user', content: q }]); setLoading(true)
    try {
      const response = await fetch(`${apiUrl}/ask`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ q, lang: locale }) })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(response.status === 429 ? t(locale, 'rateLimited') : data.detail || t(locale, 'error'))
      setMessages((current) => [...current, { id: crypto.randomUUID(), role: 'assistant', content: data.answer || t(locale, 'error'), sources: data.sources || [], route: data.route, office: data.office }])
    } catch (err) { setError(err instanceof Error ? err.message : t(locale, 'error')) } finally { setLoading(false) }
  }
  const stopOthers = (exceptId: string) => {
    const current = playingRef.current
    if (!current || current === exceptId) return
    audioRef.current[current]?.pause()
    setSpeechStates((s) => ({ ...s, [current]: 'paused' }))
  }

  const speak = async (message: Message) => {
    const state = speechStates[message.id] || 'idle'
    const existing = audioRef.current[message.id]

    if (state === 'playing' && existing) {
      existing.pause()
      playingRef.current = null
      setSpeechStates((s) => ({ ...s, [message.id]: 'paused' }))
      return
    }

    // Resume from where this message left off, after silencing any other one.
    if (existing) {
      stopOthers(message.id)
      await existing.play()
      playingRef.current = message.id
      setSpeechStates((s) => ({ ...s, [message.id]: 'playing' }))
      return
    }

    setSpeechStates((s) => ({ ...s, [message.id]: 'loading' }))
    try {
      let url = audioUrls[message.id]
      if (!url) {
        const response = await fetch(`${apiUrl}/tts`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: message.content, lang: locale }),
        })
        if (!response.ok) throw new Error(response.status === 429 ? t(locale, 'rateLimited') : t(locale, 'ttsError'))
        url = URL.createObjectURL(await response.blob())
        setAudioUrls((u) => ({ ...u, [message.id]: url as string }))
      }
      const audio = new Audio(url)
      audio.onended = () => {
        playingRef.current = null
        setSpeechStates((s) => ({ ...s, [message.id]: 'idle' }))
      }
      audioRef.current[message.id] = audio
      stopOthers(message.id)
      await audio.play()
      playingRef.current = message.id
      setSpeechStates((s) => ({ ...s, [message.id]: 'playing' }))
    } catch (err) {
      setSpeechStates((s) => ({ ...s, [message.id]: 'idle' }))
      // A key that is missing, invalid or out of quota fails for every message,
      // so stop offering it rather than letting the user hit the same error.
      setCanSpeak(false)
      setError(err instanceof Error ? err.message : t(locale, 'ttsError'))
    }
  }
  const stopRecording = () => { recorderRef.current?.stop() }
  const startRecording = async () => {
    if (mic === 'recording') return stopRecording(); if (mic === 'processing') return
    try { const stream = await navigator.mediaDevices.getUserMedia({ audio: true }); const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' }); recorderRef.current = recorder; chunksRef.current = []; recorder.ondataavailable = (event) => chunksRef.current.push(event.data); recorder.onstop = async () => { stream.getTracks().forEach((track) => track.stop()); setMic('processing'); try { const form = new FormData(); form.append('audio', new Blob(chunksRef.current, { type: 'audio/webm' }), 'recording.webm'); const response = await fetch(`${apiUrl}/transcribe`, { method: 'POST', body: form }); const data = await response.json(); if (!response.ok) throw new Error(data.detail || t(locale, 'micError')); setQuestion(data.text || ''); setTimeout(resize, 0) } catch (err) { setError(err instanceof Error ? err.message : t(locale, 'micError')) } finally { setMic('idle') } }; recorder.start(); setRecordingSeconds(0); setMic('recording') } catch { setError(t(locale, 'micPermission')) }
  }
  useEffect(() => { if (mic !== 'recording') return; const interval = window.setInterval(() => setRecordingSeconds((seconds) => { if (seconds >= 29) { stopRecording(); return 30 } return seconds + 1 }), 1000); return () => window.clearInterval(interval) }, [mic])
  const clear = () => {
    Object.values(audioRef.current).forEach((a) => a.pause())
    Object.values(audioUrls).forEach(URL.revokeObjectURL)
    audioRef.current = {}
    playingRef.current = null
    setAudioUrls({})
    setSpeechStates({})
    setMessages([])
    setError('')
  }
  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); ask() } }

  return <main className={`app-shell ${bigText ? 'big-text' : ''} ${messages.length > 0 && !faqOpen ? 'has-messages' : ''}`}>
    <div className="topbar"><Link className="brand" href={`/${locale}`}><span className="brand-mark"><Headphones size={24} /></span><span><strong>{text.title}</strong><small>{text.subtitle}</small></span></Link><nav className="controls" aria-label={t(locale, 'settings')}><div className="language-switcher"><Link className={locale === 'zh' ? 'active' : ''} href="/zh">中文</Link><Link className={locale === 'en' ? 'active' : ''} href="/en">EN</Link></div><label className="toggle"><input type="checkbox" checked={bigText} onChange={(e) => setBigText(e.target.checked)} /><span className="checkmark"><Check size={16} /></span>{text.big}</label><label className="toggle"><input type="checkbox" checked={contrast} onChange={(e) => setContrast(e.target.checked)} /><span className="checkmark"><Check size={16} /></span>{text.contrast}</label></nav></div>
    <section className="hero"><div className="eyebrow"><span className="status-dot" /> {text.official}</div><h1>{text.title}</h1><p>{text.desc}</p></section>
    <section className="faq-section"><div className="section-heading"><span>{text.quickStart}</span><small>{text.quickStartHint}</small></div><div className="faq-grid">{faqs.map((key) => <button className="faq-chip" type="button" key={key} onClick={() => ask(t(locale, key))}>{t(locale, key)}<ChevronRight size={19} /></button>)}</div></section>
    {error && <div className="inline-alert" role="alert"><CircleAlert size={20} /><span>{error}</span><button type="button" onClick={() => setError('')} aria-label={t(locale, 'dismiss')}><X size={20} /></button></div>}
    {messages.length > 0 && !faqOpen && <button className="faq-reopen" type="button" onClick={() => setFaqOpen(true)}>{t(locale, 'quickStart')} <ChevronRight size={18} /></button>}<section className="conversation" ref={conversationRef} aria-live="polite">{messages.length === 0 && !loading && <div className="empty-state"><div className="empty-icon"><BookOpen size={30} /></div><h2>{text.emptyTitle}</h2><p>{text.emptyText}</p></div>}{messages.map((message) => message.role === 'user' ? <div className="user-message" key={message.id}><span>{text.you}</span><p>{message.content}</p></div> : <AssistantMessage key={message.id} message={message} locale={locale} speech={speechStates[message.id] || 'idle'} onSpeak={() => speak(message)} canSpeak={canSpeak} />)}{loading && <div className="assistant-message loading-card"><div className="message-kicker"><ShieldCheck size={18} /> {text.answer}</div><div className="loading-lines"><span /><span /><span /></div><p>{text.thinking}</p></div>}</section>
    <section className="composer-wrap"><div className="composer"><textarea ref={textareaRef} value={question} onChange={(e) => { setQuestion(e.target.value); resize() }} onKeyDown={onKeyDown} placeholder={text.placeholder} rows={1} aria-label={text.placeholder} /><div className="composer-actions"><div className="left-actions">{locale === 'zh' && <button className={`icon-button mic-button ${mic === 'recording' ? 'recording' : ''}`} type="button" onClick={startRecording} disabled={mic === 'processing'} aria-label={mic === 'recording' ? text.stop : mic === 'processing' ? text.processing : text.speak}>{mic === 'recording' ? <Square size={21} /> : mic === 'processing' ? <RotateCcw className="spin" size={21} /> : <Mic size={21} />}<span>{mic === 'recording' ? `${text.stop} ${recordingSeconds}s` : mic === 'processing' ? text.processing : text.speak}</span>{mic === 'recording' && <i className="meter" aria-hidden="true" />}</button>}<button className="secondary-button" type="button" onClick={() => window.print()}><Printer size={19} /> {text.print}</button><button className="secondary-button clear-button" type="button" onClick={clear} disabled={messages.length === 0}><RotateCcw size={19} /> {text.clear}</button></div><button className="send-button" type="button" onClick={() => ask()} disabled={loading || !question.trim()}>{text.ask}<Send size={19} /></button></div></div><p className="composer-hint">{text.enterHint}</p></section>
    <footer>{text.disclaimer}</footer>
  </main>
}
