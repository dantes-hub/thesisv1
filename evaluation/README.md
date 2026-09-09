# Evaluation

Frozen artifacts from the evaluation of the Elder Labor Assistant against an
LLM-only baseline. Every number in the tables below is recomputable from the raw
run files in this directory — see [Reproducing these numbers](#reproducing-these-numbers).

## Design

A fixed set of 50 questions (45 Traditional Chinese, 5 English) covering office
lookup, benefit guidance, insurance coverage, premiums, disability standards,
penalties, and boundary cases where the correct behavior is to decline.

Both conditions use the same model (`gpt-4o`), the same temperature (0.2), and the
same question set. They differ in exactly one thing: the baseline runs with
`mode=llm_only`, which disables retrieval and asks the model to answer from general
knowledge. This isolates the contribution of retrieval rather than of the model.

Source corpora: labor-insurance laws and administrative interpretations, Bureau of
Labor Insurance office records, and the government disability-benefit payment-day
table.

## Automatic results

| Metric | RAG system | LLM-only baseline |
|---|---:|---:|
| Queries | 50 | 50 |
| HTTP success rate | 50/50 (100%) | 50/50 (100%) |
| Mean latency | 1592.5 ms | 1750.4 ms |
| Median latency | 1644.0 ms | 1627.5 ms |
| Avg. retrieved sources | 3.46 | 0 |
| Answers with zero sources | 0/50 | 50/50 |
| Expected source retrieved | 47/50 (94%) | N/A |
| Expected source ranked first | 38/50 (76%) | N/A |

### Which path answered each question

The system routes around the language model when it can. Of the 50 questions:

| Route | Count | Behavior |
|---|---:|---|
| `rag` | 37 | Retrieve, re-rank, generate a grounded answer |
| `office_lookup` | 9 | Return a structured office record; no generation |
| `disability_standard_lookup` | 4 | Return the exact benefit-day figure from a fixed table |

The 13 non-generative answers are the ones where a hallucinated address or day count
would do real harm, so they are served deterministically.

## Human comparison

Two separate exercises, reported separately because they measure different things.

**Single-rater side-by-side, Q1–Q12.** The RAG answer was judged better in 12/12
cases on the combined criteria of source visibility, domain specificity, and safe
handling of incomplete evidence. See `baseline_12q_summary.txt`.

**Two-rater comparison, all 50 questions** (`human_rating_two_raters.csv`):

| | Prefers RAG | Prefers LLM-only | Tie | Cannot judge |
|---|---:|---:|---:|---:|
| Rater 1 | 34 | 12 | 3 | 1 |
| Rater 2 | 45 | 1 | 2 | 2 |

Raw agreement 33/50 (66%), but **Cohen's κ = 0.105** — only slight agreement once
chance is corrected for, because both raters chose "RAG" often enough that most of
their agreement is explainable by chance alone.

**This is a weak result and should be read as one.** The two raters disagree on a
third of the items, and they disagree in a specific direction: Rater 1 preferred the
baseline on 12 questions where Rater 2 preferred RAG on all but one. The honest
conclusion is that the human preference data does not establish much on its own, and
the retrieval metrics above — which are objective and reproducible — carry the
argument. A larger rater pool and a written rubric would be needed to make the
subjective comparison meaningful.

## Known limitations

- Relevant sources are sometimes retrieved but not ranked first (12/50), typically
  when statute pages and administrative interpretations of the same provision
  compete semantically.
- English retrieval is weaker than Chinese; the corpus is predominantly Chinese.
- Boundary and safety questions are poorly served by expected-source matching, since
  the correct behavior is often to decline rather than to retrieve a specific page.
- Latency was measured against a local Qdrant instance on one machine, so the
  absolute figures are not deployment numbers. The RAG/baseline comparison is still
  meaningful because both ran under identical conditions.
- Single run per condition; no variance across repeated runs is reported.

## Files

| File | Contents |
|---|---|
| `questions_50.csv` | The 50-question set: id, language, question, expected source |
| `runs/rag_50.jsonl` | Raw RAG run: answer, sources, route, latency, HTTP status per query |
| `runs/llm_only_50.jsonl` | Raw baseline run, same schema |
| `comparison_50.csv` | Side-by-side of both conditions per question |
| `source_check_50.csv` | Per-question retrieval scoring (`match_top`, `match_any`, route) |
| `human_rating_two_raters.csv` | Per-question outcome from each rater |
| `results_summary.md` | Original write-up of the 50-query evaluation |
| `baseline_12q_summary.txt` | Original write-up of the 12-question comparison |

Raw Turnitin reports and the unaggregated rating sheet are deliberately not included.

## Reproducing these numbers

The headline metrics are derived from the raw runs, not transcribed by hand:

```bash
python - <<'PY'
import json, io, statistics as st
for name, f in [("RAG", "runs/rag_50.jsonl"), ("LLM-only", "runs/llm_only_50.jsonl")]:
    rows = [json.loads(l) for l in io.open(f, encoding="utf-8") if l.strip()]
    lat = [r["latency_ms"] for r in rows]
    src = [r.get("retrieved_count", 0) for r in rows]
    print(f"{name}: n={len(rows)} ok={sum(1 for r in rows if r['http_ok'])}/{len(rows)} "
          f"mean={st.mean(lat):.1f}ms median={st.median(lat):.1f}ms "
          f"avg_sources={st.mean(src):.2f} zero={sum(1 for s in src if s == 0)}")
PY
```

To re-run the evaluation end to end against a live instance, see the
"Reproducing the evaluation" section of the root README.
