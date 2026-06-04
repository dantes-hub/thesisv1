import csv
import json, time, os, argparse
import requests
from datetime import datetime
from pathlib import Path

ASK_URL = os.getenv("ASK_URL", "http://localhost:8000/ask")  # can override: ASK_URL=... python run.py

DEFAULT_QUESTIONS_CSV = Path(__file__).with_name("evaluation_questions_50.csv")

FALLBACK_QUESTIONS = [
  {"id":"Q1","lang":"zh","q":"台中勞保局在哪裡？地址跟電話是什麼？"},
  {"id":"Q2","lang":"zh","q":"台北勞保局的服務時間？櫃台幾點到幾點？"},
  {"id":"Q3","lang":"zh","q":"勞保失能給付第 1 級與第 15 級的給付日數是多少？"},
  {"id":"Q4","lang":"zh","q":"勞工保險失能給付有哪些條件？"},
  {"id":"Q5","lang":"zh","q":"申請勞保傷病給付需要準備什麼資料？"},
  {"id":"Q6","lang":"zh","q":"勞保老年給付有哪些種類？"},
  {"id":"Q7","lang":"zh","q":"勞保生育給付有哪些規定？"},
  {"id":"Q8","lang":"zh","q":"勞工保險條例第54條之2第2項無謀生能力的範圍是什麼？"},
  {"id":"Q9","lang":"zh","q":"勞保保險費怎麼計算？投保薪資跟保險費有什麼關係？"},
  {"id":"Q10","lang":"zh","q":"勞工保險條例罰鍰應行注意事項有哪些重點？"},
  {"id":"Q11","lang":"zh","q":"我想知道我個人的勞保能領多少，幫我直接算出來。"},
  {"id":"Q12","lang":"en","q":"Where is the Taichung BLI office and what are its phone number and hours?"},
]

def load_questions(path):
    path = Path(path)
    if not path.exists():
        print(f"[WARN] Question CSV not found: {path}. Using 12-question fallback.")
        return FALLBACK_QUESTIONS

    with path.open("r", encoding="utf-8-sig", newline="") as f:
        rows = []
        for row in csv.DictReader(f):
            q = (row.get("q") or "").strip()
            if not q:
                continue
            rows.append({
                **row,
                "id": (row.get("id") or f"Q{len(rows) + 1}").strip(),
                "lang": "en" if row.get("lang") == "en" else "zh",
                "q": q,
            })

    if not rows:
        raise ValueError(f"No valid questions found in {path}")
    return rows

def safe_json(resp: requests.Response):
    try:
        return resp.json(), None
    except Exception as e:
        return None, f"json_parse_error: {e}; raw={resp.text[:800]}"

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["rag", "llm_only"], default=os.getenv("ASK_MODE", "rag"))
    ap.add_argument("--out", default=None, help="Optional explicit output filename")
    ap.add_argument("--questions", default=str(DEFAULT_QUESTIONS_CSV), help="CSV containing id, lang, q columns")
    args = ap.parse_args()

    questions = load_questions(args.questions)
    out = args.out or f"ask_runs_{args.mode}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.jsonl"
    session = requests.Session()

    with open(out, "w", encoding="utf-8") as f:
        for item in questions:
            t0 = time.time()
            ts = datetime.now().isoformat(timespec="seconds")

            payload = {"q": item["q"], "lang": item["lang"], "mode": args.mode}

            row = {**item, "ts": ts, "ask_url": ASK_URL, "mode": args.mode}

            try:
                r = session.post(ASK_URL, json=payload, timeout=120)
                row["http_status"] = r.status_code
                row["http_ok"] = r.ok
                row["latency_ms"] = int((time.time() - t0) * 1000)

                data, err = safe_json(r)
                if err:
                    row["error"] = err
                    row["answer"] = ""
                    row["sources"] = []
                    row["retrieved_count"] = 0
                else:
                    sources = data.get("sources") or data.get("hits") or []
                    row["answer"] = data.get("answer", "")
                    row["sources"] = sources
                    row["retrieved_count"] = len(sources)

                    for k in ["mode", "route", "intent", "model", "policy", "topk", "collection"]:
                        if k in data:
                            row[k] = data.get(k)

            except Exception as e:
                row["latency_ms"] = int((time.time() - t0) * 1000)
                row["http_status"] = None
                row["http_ok"] = False
                row["error"] = f"request_error: {repr(e)}"
                row["answer"] = ""
                row["sources"] = []
                row["retrieved_count"] = 0

            f.write(json.dumps(row, ensure_ascii=False) + "\n")
            time.sleep(0.15)

    print("Saved:", out)


if __name__ == "__main__":
    main()
