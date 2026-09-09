// Pure retrieval and formatting logic, kept free of Express, OpenAI and Qdrant
// so it can be unit tested. index.js wires these into the HTTP routes.

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

const OFFICE_SUFFIX = /(辦事處|分局|服務據點)/;

// offices.csv stores the office name in its "city" column, so payload.city reads
// like 台北市辦事處 and the title arrives doubled (台北市辦事處辦事處).
function normalizeOfficeName(title) {
  return String(title || "").replace(/(辦事處|分局|服務據點)\1+$/, "$1").trim();
}

// Never fold the office name back into the address; only real location parts.
function buildOfficeAddress({ zip, city, district, address } = {}) {
  const cityIsOfficeName = OFFICE_SUFFIX.test(String(city || "")) &&
    new RegExp(`${OFFICE_SUFFIX.source}$`).test(String(city || ""));
  return [zip, cityIsOfficeName ? "" : city, district, address]
    .filter(Boolean)
    .join(" ")
    .trim();
}

export {
  dedupBy,
  simpleMMR,
  normPlace,
  CITY_ALIASES,
  detectCityKey,
  googleMapsUrl,
  DISABILITY_DAYS,
  extractDisabilityLevels,
  buildDisabilityStandardPayload,
  pickBestOffice,
  extractFromText,
  normalizeOfficeName,
  buildOfficeAddress,
};
