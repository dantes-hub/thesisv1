# Evaluation Summary: 50-Query RAG vs LLM-Only Baseline

## Setup

- Query set: 50 fixed questions (`Q1-Q50`) from `evaluation_questions_50.csv`.
- Languages: 45 Traditional Chinese questions and 5 English questions.
- Data sources:
  - `law_regulations.csv`: labor insurance laws, regulations, and administrative interpretations.
  - `offices.csv`: Bureau of Labor Insurance office locations, phone numbers, and service hours.
  - `A17000000J-030152-gJm.csv`: disability benefit payment-day standards by disability grade.
- RAG condition: retrieval enabled using the `labor_assistant_v1` Qdrant collection.
- Baseline condition: `mode=llm_only`, retrieval disabled, same question set.

## Quantitative Results

| Metric | RAG system | LLM-only baseline |
|---|---:|---:|
| Number of queries | 50 | 50 |
| HTTP success rate | 50/50 (100%) | 50/50 (100%) |
| Mean latency | 1592.5 ms | 1750.4 ms |
| Median latency | 1644.0 ms | 1627.5 ms |
| Average retrieved sources | 3.46 | 0 |
| Zero-source answers | 0/50 | 50/50 |
| Expected source found in retrieved sources | 47/50 | N/A |
| Expected source ranked first | 38/50 | N/A |

## Observed Pattern

The RAG system successfully answered all 50 queries and returned at least one retrieved source for every query. In 47 out of 50 cases, the expected source appeared somewhere in the retrieved source list, and in 38 cases it was ranked as the top source. The LLM-only baseline also completed all 50 queries, but returned no retrieved sources by design, so its answers lacked evidence traceability.

The difference is most visible in office-location and exact-table questions. For example, RAG returned exact BLI office addresses, phone numbers, service hours, and official links. It also handled disability-grade payment-day questions through the indexed government table. The baseline often provided generic guidance or suggested checking official websites without supplying a verifiable retrieved source.

## Remaining Limitations

- Some relevant sources were retrieved but not ranked first, especially when law/regulation pages and administrative interpretation pages overlapped semantically.
- English retrieval remained weaker in some cases, such as the laid-off worker continuation question.
- Boundary/safety questions are harder to evaluate by expected-source matching because the correct behavior is often refusing to speculate or advising official verification rather than retrieving one specific page.

## Thesis-Ready Paragraph

To evaluate the prototype, this study used a fixed set of 50 test questions derived from three government-source datasets: labor insurance laws and administrative interpretations, Bureau of Labor Insurance office information, and disability benefit payment-day standards. The test set included 45 Traditional Chinese questions and 5 English questions, covering office lookup, benefit guidance, insurance coverage, premium handling, disability standards, penalties, and boundary cases. The proposed RAG system was compared with an LLM-only baseline using the same questions and model setting, but with retrieval disabled. Both systems achieved a 100% HTTP success rate. The RAG system had a mean latency of 1592.5 ms, compared with 1750.4 ms for the baseline. More importantly, the RAG system returned retrieved sources for all 50 questions, with the expected source appearing in 47 out of 50 cases and appearing as the top source in 38 cases. By contrast, the LLM-only baseline returned no retrieved sources for any query. These results suggest that the RAG design improves evidence traceability and domain specificity while maintaining acceptable response latency for a prototype system.
