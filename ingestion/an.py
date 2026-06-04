import json
import csv
import argparse
import statistics
from pathlib import Path

def safe_len(x):
    try:
        return len(x)
    except Exception:
        return None

def bucket(n):
    if n is None:
        return "NA"
    if n == 0:
        return "0"
    if n <= 2:
        return "1-2"
    if n <= 5:
        return "3-5"
    return ">5"

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--jsonl", required=True, help="Path to .jsonl file")
    ap.add_argument("--out_csv", default="jsonl_export.csv", help="Output CSV filename")
    ap.add_argument("--progress_every", type=int, default=200, help="Print progress every N lines")
    args = ap.parse_args()

    jsonl_path = Path(args.jsonl)

    print("=== START ===", flush=True)
    print(f"Reading JSONL: {jsonl_path}", flush=True)

    if not jsonl_path.exists():
        print(f"[ERROR] File not found: {jsonl_path}", flush=True)
        return

    if jsonl_path.stat().st_size == 0:
        print(f"[ERROR] File is empty: {jsonl_path}", flush=True)
        return

    rows = []
    bad_json = 0

    with jsonl_path.open("r", encoding="utf-8") as f:
        for i, line in enumerate(f, start=1):
            line = line.strip()
            if not line:
                continue

            try:
                j = json.loads(line)
            except json.JSONDecodeError:
                bad_json += 1
                continue

            sources = j.get("sources", None)
            retrieved_count = safe_len(sources) if isinstance(sources, (list, tuple)) else None

            q = j.get("q", "")
            ans = j.get("answer", "")
            q_short = (q[:180] + "…") if isinstance(q, str) and len(q) > 180 else q
            ans_short = (ans[:220] + "…") if isinstance(ans, str) and len(ans) > 220 else ans

            rows.append({
                "id": j.get("id", None),
                "lang": j.get("lang", None),
                "ts": j.get("ts", None),
                "ask_url": j.get("ask_url", None),
                "http_ok": j.get("http_ok", None),
                "http_status": j.get("http_status", None),
                "latency_ms": j.get("latency_ms", None),
                "retrieved_count": retrieved_count,
                "retrieval_bucket": bucket(retrieved_count),
                "q_short": q_short,
                "answer_short": ans_short,
            })

            if args.progress_every and (i % args.progress_every == 0):
                print(f"Processed lines: {i} | valid rows: {len(rows)} | bad_json: {bad_json}", flush=True)

    if not rows:
        print("[ERROR] No valid JSON rows parsed. (Maybe lines are not JSON objects?)", flush=True)
        return

    out_path = Path(args.out_csv).resolve()
    with out_path.open("w", newline="", encoding="utf-8") as out:
        w = csv.DictWriter(out, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)

    latencies = [r["latency_ms"] for r in rows if isinstance(r["latency_ms"], (int, float))]
    ok_vals = [r["http_ok"] for r in rows if isinstance(r["http_ok"], bool)]
    retrieved = [r["retrieved_count"] for r in rows if isinstance(r["retrieved_count"], int)]

    print("\n=== SUMMARY ===", flush=True)
    print(f"Rows parsed: {len(rows)}", flush=True)
    print(f"Bad JSON lines skipped: {bad_json}", flush=True)
    print(f"CSV written to: {out_path}", flush=True)

    if ok_vals:
        ok_rate = sum(1 for x in ok_vals if x) / len(ok_vals) * 100
        print(f"http_ok rate: {ok_rate:.1f}% ({sum(1 for x in ok_vals if x)}/{len(ok_vals)})", flush=True)

    if latencies:
        lat_mean = statistics.mean(latencies)
        lat_median = statistics.median(latencies)
        lat_sorted = sorted(latencies)
        lat_p95 = lat_sorted[int(0.95 * (len(lat_sorted) - 1))]
        print(f"Latency ms: mean={lat_mean:.1f}, median={lat_median:.1f}, p95≈{lat_p95:.1f}", flush=True)

    if retrieved:
        buckets = {}
        for r in rows:
            b = r["retrieval_bucket"]
            buckets[b] = buckets.get(b, 0) + 1
        print("retrieval_count buckets:", dict(sorted(buckets.items(), key=lambda x: x[0])), flush=True)

    print("=== DONE ===", flush=True)

if __name__ == "__main__":
    main()
