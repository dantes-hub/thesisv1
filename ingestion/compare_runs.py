import json
import csv
import argparse
from pathlib import Path


def load_jsonl(path):
    rows = {}
    with Path(path).open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            obj = json.loads(line)
            rows[obj.get("id")] = obj
    return rows


def short(text, limit=220):
    if not isinstance(text, str):
        return ""
    return text if len(text) <= limit else text[:limit] + "…"


def top_title(row):
    sources = row.get("sources") or []
    if not sources:
      return ""
    first = sources[0] or {}
    return first.get("title") or ""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rag", required=True, help="Path to the RAG jsonl run")
    ap.add_argument("--baseline", required=True, help="Path to the baseline jsonl run")
    ap.add_argument("--out_csv", default="run_comparison.csv", help="Output CSV filename")
    args = ap.parse_args()

    rag_rows = load_jsonl(args.rag)
    base_rows = load_jsonl(args.baseline)
    ids = sorted(set(rag_rows.keys()) | set(base_rows.keys()))

    fieldnames = [
        "id",
        "lang",
        "query",
        "rag_http_ok",
        "baseline_http_ok",
        "rag_latency_ms",
        "baseline_latency_ms",
        "rag_retrieved_count",
        "baseline_retrieved_count",
        "rag_top_source",
        "baseline_top_source",
        "rag_answer_short",
        "baseline_answer_short",
        "manual_better",
        "manual_note",
    ]

    out_path = Path(args.out_csv)
    with out_path.open("w", newline="", encoding="utf-8") as out:
        writer = csv.DictWriter(out, fieldnames=fieldnames)
        writer.writeheader()

        for case_id in ids:
            rag = rag_rows.get(case_id, {})
            base = base_rows.get(case_id, {})
            writer.writerow({
                "id": case_id,
                "lang": rag.get("lang") or base.get("lang") or "",
                "query": rag.get("q") or base.get("q") or "",
                "rag_http_ok": rag.get("http_ok"),
                "baseline_http_ok": base.get("http_ok"),
                "rag_latency_ms": rag.get("latency_ms"),
                "baseline_latency_ms": base.get("latency_ms"),
                "rag_retrieved_count": rag.get("retrieved_count"),
                "baseline_retrieved_count": base.get("retrieved_count"),
                "rag_top_source": top_title(rag),
                "baseline_top_source": top_title(base),
                "rag_answer_short": short(rag.get("answer", "")),
                "baseline_answer_short": short(base.get("answer", "")),
                "manual_better": "",
                "manual_note": "",
            })

    print(f"Wrote comparison CSV: {out_path.resolve()}")


if __name__ == "__main__":
    main()
