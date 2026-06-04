# Reference Audit Summary

Document checked: `Thesis_proposal_last_defence.docx`

## Scope

- Extracted 56 reference entries from the `References` section.
- Checked URL/DOI reachability where links were present.
- Checked consistency issues such as missing URLs, missing access dates for web references, inconsistent DOI formatting, and missing year markers.

## Overall Result

Most references appear to be real and relevant. The main problems are formatting and completeness, not widespread fake references.

## Items That Need Cleanup

### Missing URL or DOI

These entries are real-looking but incomplete for verification because they do not include a URL, DOI, or arXiv link in clickable form:

- TruthfulQA: Measuring How Models Mimic Human Falsehoods
- Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks
- Lost in the Middle: How Language Models Use Long Contexts
- Labor Standards Act
- Senior Citizens Welfare Act
- Benchmarking retrieval-augmented generation for medicine
- Fine-tuning or retrieval? Comparing knowledge injection in large language models
- Mix-of-granularity
- RE-FIN
- LegalBench-RAG
- RAGE-KG legal-document benchmark

### Inconsistent DOI Formatting

Some references use `DOI:` while others use `https://doi.org/...`. Pick one style. For thesis readability, `https://doi.org/...` is clearer and clickable.

Affected examples:

- RAGTruth
- SelfCheckGPT
- BM25 and Beyond
- ColBERT
- Reciprocal Rank Fusion
- MMR
- Chain-of-Verification
- Government Information Quarterly chatbot/e-government references
- Survey of Hallucination in Natural Language Generation

### Official Web References Missing Year Marker

Some institutional web references have no `(n.d.)` or publication/update year:

- National Development Council population projections
- Qdrant Documentation: Indexing
- Qdrant Documentation: Collections
- Qdrant Course/Guide: Combining Vector Search and Filtering
- Labor Insurance Disability Benefit Standards dataset

### Legal Reference Clarification

- `Labor Standards Act` is missing a URL.
- `Senior Citizens Welfare Act` is missing a URL.
- The Senior Citizens Welfare Act citation says amended date `2025-08-01`. This appears plausible for the Chinese law amendment, but the English MOHW page found during checking still shows `2020-05-27`. The citation should clarify whether it is citing the Chinese current law, the English translation, or the amendment notice.

## URL/DOI Reachability Notes

Many DOI checks returned `403` from publisher sites such as ACM, Taylor & Francis, Emerald, or OECD. This does not mean the references are fake; it usually means the publisher blocks automated requests.

The following were externally verified as real during checking:

- TruthfulQA, ACL 2022.
- Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks, arXiv/NeurIPS 2020.
- Lost in the Middle, TACL 2024, DOI `10.1162/tacl_a_00638`.
- Labor Standards Act, modified `2024-07-31`.
- Data.gov.tw dataset 45748, disability benefit standards.
- NDC population projections page.

## Recommended Fixes

1. Add missing URLs/DOIs/arXiv links.
2. Convert all `DOI:` labels to `https://doi.org/...`.
3. Add `(n.d.)` to documentation/web pages without a publication year.
4. Add access dates to all official web references.
5. Clarify Senior Citizens Welfare Act source/date.
6. Keep publisher-blocked DOI links; they are still valid if the DOI resolves in a browser.

