# Frontend Handover — Elder Labor Assistant

Spec for rebuilding the frontend (in v0, or by hand). Paste the whole document into
v0 as context, then iterate on the visual direction.

The backend does **not** change. Everything here is the contract the new UI must
satisfy.

---

## 1. What this is

A bilingual (Traditional Chinese / English) assistant that answers Taiwan
labor-insurance, pension, and senior-employment questions. Answers are grounded in
official government sources and always show their citations.

**The users are adults aged 60+ in Taiwan**, many with reduced vision, limited touch
precision, and low confidence with chat interfaces. This is a master's thesis
prototype whose research contribution *is* the accessibility. A redesign that looks
better but reads worse for an 80-year-old has destroyed the point of the project.

So: modern and calm, not trendy and dense. Think "government service done well,"
not "AI startup landing page."

---

## 2. Non-negotiable constraints

These are requirements, not preferences.

1. **Minimum 18px body text.** The current default is 17px and that is already the
   floor. Nothing interactive below 16px.
2. **Big-text mode**, toggleable, defaults to **ON**. It currently sets answer text to
   `30px / 2.0` line-height. Keep a toggle that scales answer text to ~30px.
3. **High-contrast mode**, toggleable. Black background, white text, `#ffcc00` links,
   visible borders on every surface.
4. **Touch targets ≥ 44×44px** for every button, including the language switcher and
   the big-text checkbox.
5. **Never rely on color alone.** Recording state, playing state, and errors each need
   a text label, not just a red or green tint.
6. **No `alert()`.** The current build uses browser alerts for mic and TTS errors,
   which is jarring and blocks the page. Use inline, dismissible messages.
7. **Answers must always show their sources.** The citation list is the trust
   mechanism and the thesis argument; it is not optional chrome to be tucked away.
8. **Keep it a single screen.** No onboarding flow, no modal tour, no sign-in.
9. **Print/Save must keep working** (`window.print()`), and the print stylesheet should
   drop the composer and toolbar so a user can hand the answer to family or staff.

### Theming: do this differently than the current code

The existing high-contrast mode works by `!important`-overriding specific Tailwind
class names (`.high-contrast .bg-sky-100 { … }`). It is extremely brittle — **any
redesign that renames a utility class silently breaks it.**

Rebuild it with CSS custom properties instead:

```css
:root {
  --bg: #f8fafc; --surface: #fff; --text: #0f172a;
  --muted: #475569; --border: #cbd5e1; --accent: #0369a1; --link: #0369a1;
}
[data-contrast="high"] {
  --bg: #000; --surface: #000; --text: #fff;
  --muted: #fff; --border: #fff; --accent: #333; --link: #ffcc00;
}
```

Then style everything from those variables. Font scaling should work the same way
(`--answer-size: 18px` → `30px`), set on a wrapper element rather than per-component.

---

## 3. API contract

Base URL comes from `NEXT_PUBLIC_API_URL`. It is inlined at build time, so it must be
present when the app is built, not just at runtime.

### `POST /ask`

```jsonc
// request
{ "q": "勞工保險失能給付有哪些條件？", "lang": "zh" }   // lang: "zh" | "en"
```

```jsonc
// response
{
  "answer": "markdown string",
  "sources": [
    { "title": "給付部分-失能給付",
      "url": "https://www.bli.gov.tw/0016179.html",
      "snippet": "…up to ~120 chars…" }
  ],
  "route": "rag",              // "rag" | "office_lookup" | "disability_standard_lookup"
  "intent": "general",
  "model": "gpt-4o"
}
```

`sources` may be an empty array — for example when the assistant asks the user which
city they mean. Render nothing rather than an empty "Sources" heading.

Rate limited to **10 requests/minute per IP**; on `429` the body is
`{ "error": "rate_limited", "detail": "…" }`. Show that message calmly, do not retry
in a loop.

### `POST /tts`

```jsonc
{ "text": "…", "lang": "zh" }   // → audio/mpeg binary
```

Limited to 10/min. Errors return JSON, not audio.

### `POST /transcribe`

`multipart/form-data`, field name **`audio`**, max 15MB, `audio/webm` or `audio/mp4`.
Returns `{ "text": "…" }`. Limited to 5/min.

### `GET /health`

`{ "ok": true, "collections": [...] }` — useful for a connection indicator.

---

## 4. Screens and components

One page, at `/[locale]` where locale is `zh` or `en`.

### Header
- App title and one-line description.
- Language switcher (中文 / EN) — currently top-right, links to `/zh` and `/en`
  preserving the path.
- Big-text toggle and high-contrast toggle. **Promote these**: they are currently a
  small checkbox in a crowded toolbar, and they are the features the target users need
  most. They should be obvious, labelled, and reachable without scrolling.

### FAQ chips
Five one-tap starter questions. These are the primary entry point — many users will
never type. Make them large, clearly tappable, and readable. Current set:

1. 我幾歲可以領勞保老年年金？ / At what age can I claim labor insurance old-age pension?
2. 勞工保險失能給付有哪些條件？ / What are the conditions for disability benefits?
3. 如何申請遺囑撫恤金？ / How to apply for survivors' benefits?
4. 哪裡可以找到勞保局各地辦事處？ / Where can I find Labor Insurance Bureau branch offices?
5. 失能給付可以領多少？ / How much can I receive for disability benefits?

### Conversation list
Alternating user / assistant messages, scrollable, auto-scrolled to the newest.
Empty state invites the user to tap a question above or type below.

Each **assistant** message contains, in order:
1. The answer body (see §5 — it is markdown).
2. A play/pause button for spoken audio.
3. The source list.

### Sources block
Heading (資料來源 / Sources), then up to 5 entries. Each has a title linking to the
official URL (new tab, `rel="noopener noreferrer"`) and a muted snippet.

Design these to look **trustworthy and official**, not like ad units. They are the
evidence the whole system rests on. Consider numbering them so the answer text can
refer to them.

### Composer (sticky, bottom)
- Auto-growing textarea. Enter sends, Shift+Enter makes a newline.
- Microphone button (see §6).
- Send button, disabled while loading.
- Print/Save button.
- Clear conversation.

### Footer
Disclaimer, always visible: this is a demo, verify with the Bureau of Labor Insurance.

---

## 5. Fix this: answers are markdown but rendered as plain text

**This is the single biggest visual problem with the current UI.**

The backend returns markdown. A real answer looks like this:

```
 摘要
勞工保險失能給付的條件包括永久失能且符合給付標準。

 檢查清單
1. 被保險人需經診斷為永久失能。
2. 失能狀態需符合失能給付標準。

 資料來源
- 給付部分-失能給付 – [連結](https://www.bli.gov.tw/0016179.html)
```

The current frontend renders that with `whitespace-pre-wrap` and a URL-linkifying
regex — so users literally see `[連結](https://…)` and `**bold**` markers on screen.

**Render the markdown properly.** Headings, ordered lists, and links should be real
elements. This alone will make the app look dramatically better before any styling.

Every answer follows the same three-part shape — **Summary → Checklist → Sources** —
so you can style those sections deliberately: the summary as a lead paragraph, the
checklist as clear numbered steps (these are actions an older adult will follow one at
a time), the sources as citations.

### Security requirement when you do this

Answer text is injected into the page. The current code escapes HTML before
linkifying, which closes an XSS hole. **Do not reintroduce raw
`dangerouslySetInnerHTML` on model output.** Use a markdown renderer with HTML
disabled — for example `react-markdown` with default settings (it does not render raw
HTML unless you add `rehype-raw`; don't). If you hand-roll it, escape first, then
linkify.

---

## 6. State machines to preserve

### Text-to-speech, per message
`idle → loading → playing ⇄ paused → idle`

Labels currently used (keep the meaning, restyle freely):

| State | zh | en |
|---|---|---|
| idle | ▶️ 播放 | ▶️ Play |
| loading | ⏳ 生成中… | ⏳ Generating… |
| playing | ⏸ 暫停 | ⏸ Pause |
| paused | ▶️ 繼續 | ▶️ Resume |

Audio is cached per message as a blob URL; revoke the URLs when clearing the
conversation.

### Microphone
`idle → recording → processing → idle`, with a 30-second auto-stop.

| State | zh | en |
|---|---|---|
| idle | 🎙️ 語音 | 🎙️ Speak |
| recording | ⏹ 停止 | ⏹ Stop |
| processing | ⏳ 辨識中… | ⏳ Processing… |

While recording, show something moving — a level meter or pulse — so the user knows
it is listening. Older users often cannot tell whether a recording started.

**Known limitation:** the mic button is currently rendered only when `locale === "zh"`,
and the backend passes `language: "zh"` to Whisper, so English voice input is
unsupported and would transcribe wrongly. Either keep it Chinese-only (and label it),
or ask the backend to accept a language parameter. Do not silently show it in English.

---

## 7. Copy (existing, reuse or improve)

| Key | zh | en |
|---|---|---|
| title | 銀髮勞工小幫手 | Elder Labor Assistant |
| desc | 輸入問題或點選常見問題，系統會用大字與語音回覆。 | Ask about labor insurance, pensions, and services. The assistant replies in large text and with voice. |
| big | 大字模式 | Big text |
| placeholder | 例如：我今年65歲，可以申請勞保老年年金嗎？ | e.g. I am 65 years old. Can I apply for the old-age pension? |
| ask | 查詢 | Ask |
| clear | 清除 | Clear |
| answer | 系統回覆 | Answer |
| sources | 資料來源 | Sources |
| thinking | …回覆中 | …thinking |
| error | 系統連線失敗，請稍後再試。 | Connection failed, please try again later. |
| disclaimer | 此為示範系統，實際資訊請以勞保局官方公告為準。 | This is a demo assistant. Please verify with official labor authorities. |

Strings live in `messages/zh.json` and `messages/en.json`, read through a
`t(locale, key)` helper. Keep that split; don't hardcode Chinese in components.

Note the current FAQ list is hardcoded in the page component while `faq1`–`faq3` sit
unused in the message files. Consolidate into the message files.

`next-intl` is listed as a dependency but is never imported — the app uses its own
`t()` helper. Either adopt `next-intl` properly during the rebuild or drop the package.

---

## 8. Also worth fixing

- **Loading state.** A static "…thinking" line. A skeleton or progress affordance
  would reassure users during the ~1.6s wait.
- **Office answers have duplicated text** — real output reads
  `台中市辦事處辦事處` and `地址：台中市辦事處 台中市西區民權路131號`. That is a
  backend formatting bug, but if the UI renders office results as a structured card
  (address / hours / phone / map link) rather than a text blob, it stops mattering.
- **Office and disability answers are structured data**, not prose (`route` tells you
  which). A card with a phone number as a `tel:` link and a map link would be far more
  useful to an older adult than a paragraph.
- **No keyboard focus styles** are defined. Add visible focus rings.
- **Language switch loses the conversation.** It is a full navigation to `/en`.
  Preserving history across the switch would be an improvement.

---

## 9. Visual direction

Free rein here, within §2. What tends to work for this audience:

- Generous whitespace and a single-column layout; no dense sidebars.
- High baseline contrast even in normal mode (aim for WCAG AAA on body text).
- Few colors, used consistently: one accent for actions, one for "listening/recording",
  neutral surfaces everywhere else.
- Real hierarchy through size and weight rather than through subtle grays.
- Motion kept minimal and respectful of `prefers-reduced-motion`.
- Since it is a Taiwanese government-adjacent service, calm blues/greens read as
  trustworthy; avoid the purple-gradient AI-product look.

---

## 10. Acceptance checklist

- [ ] Body text ≥ 18px; big-text mode scales answers to ~30px
- [ ] High-contrast mode implemented with CSS variables, not class-name overrides
- [ ] All touch targets ≥ 44×44px
- [ ] Markdown in answers renders as real headings, lists, and links
- [ ] No raw HTML from model output reaches the DOM
- [ ] Sources always visible under each answer, linking out in a new tab
- [ ] TTS button cycles idle → loading → playing ⇄ paused with text labels
- [ ] Mic shows a live recording indicator and auto-stops at 30s
- [ ] Errors appear inline; no `alert()`
- [ ] `429` shows a calm "too many requests" message
- [ ] Print stylesheet hides composer and toolbar
- [ ] Works at 320px width and at 200% browser zoom
- [ ] Full keyboard navigation with visible focus rings
- [ ] Both `/zh` and `/en` render correctly

---

## 11. Integration notes

The rebuilt UI must keep:

- Next.js App Router with a `[locale]` segment (`zh` | `en`); `/` redirects to `/zh`
  via `middleware.js`.
- `NEXT_PUBLIC_API_URL` as the only backend config.
- `<html lang="zh-Hant">` or `lang="en"` set from the locale.

Drop the new page into `apps/frontend/app/[locale]/page.js`. If v0 gives you
TypeScript or shadcn/ui components, that is fine — add the dependencies to
`apps/frontend/package.json`, and the existing Docker build will pick them up
unchanged.

Verify with `npm run build` from the repo root before committing.

---

## Status: delivered

The v0 rebuild was integrated on 2026-09-09. What shipped against the checklist above:

Met: CSS custom properties with `[data-contrast='high']`, 18px body / 30px big-text
(default on), 44px+ touch targets, `focus-visible` rings, `prefers-reduced-motion`,
print stylesheet, markdown rendered via `react-markdown` with raw HTML disabled, inline
dismissible errors instead of `alert()`, mic restricted to `zh` with a live countdown,
numbered sources, explicit `429` handling, complete 45-key i18n in both locales, and a
structured office card.

Fixed during integration, on top of what v0 produced:

- The office card read a `data.office` field the API never returned. `/ask` now ships a
  structured `office` object, which also removed the duplicated `台北市辦事處辦事處`
  title and the office name repeated inside the address.
- High contrast was applied to the app shell, but `html` and `body` are its ancestors,
  so the page background stayed light and text rendered white-on-white. The attribute
  now goes on the document root.
- Display preferences are persisted, and the restore runs before anything writes, so the
  mount pass cannot overwrite a saved choice with the defaults.
- Locale was resolved in an effect, so `/en` briefly rendered Chinese and the title was
  set client-side. It now resolves via `use(params)` with `lang` and metadata rendered
  on the server.
- Each answer owns its audio element; starting one pauses the other.
- The language switcher used `<a>`, forcing a full reload on every switch.
- Removed `@vercel/analytics` (third-party tracking), `shadcn` as a runtime dependency,
  and the unused `components/ui/button.tsx`, `lib/utils.ts`, and `components.json`.
  Tailwind was dropped entirely: the design uses semantic CSS, and nothing referenced a
  utility class.

Still open, and worth doing if the frontend is revisited:

- Preferences apply in an effect, so there is a brief flash of the default theme before
  a saved high-contrast setting takes hold. A blocking inline script in the layout would
  remove it.
- Switching language still clears the conversation, since it is a route change.
- English voice input remains unsupported: the mic is hidden outside `zh`, and the API
  passes `language: "zh"` to Whisper.
