# -*- coding: utf-8 -*-
import os, re, uuid, sys, time, pathlib
import pandas as pd
from dotenv import load_dotenv

import tiktoken
from langchain_openai import OpenAIEmbeddings
from qdrant_client import QdrantClient
from qdrant_client.http import models as qm

# config
EMBED_MODEL = "text-embedding-3-large" 
EMBED_DIM   = 3072
DEFAULT_COLLECTION = "labor_assistant_v1"
DATASET_TITLE = "各失能等級之給付標準"
CATEGORY      = "Disability benefits"

# load env
load_dotenv()
QDRANT_URL = os.getenv("QDRANT_URL", "http://localhost:6333")
COLLECTION = os.getenv("COLLECTION", DEFAULT_COLLECTION)

# tokenizer
enc = tiktoken.get_encoding("cl100k_base")

def ensure_collection(client: QdrantClient, name: str):
    exists = any(c.name == name for c in client.get_collections().collections)
    if not exists:
        client.create_collection(
            collection_name=name,
            vectors_config=qm.VectorParams(size=EMBED_DIM, distance=qm.Distance.COSINE)
        )
        print(f"created collection: {name}")
    else:
        print(f"collection exists: {name}")

def chunk_text(text: str, max_tokens=350, overlap=40):
    toks = enc.encode(text or "")
    i, out = 0, []
    while i < len(toks):
        j = min(i + max_tokens, len(toks))
        out.append(enc.decode(toks[i:j]))
        if j >= len(toks): break
        i = max(0, j - overlap)
    return out

def try_read_table(path: str) -> pd.DataFrame:
    ext = pathlib.Path(path).suffix.lower()
    if ext in (".xlsx", ".xls"):
        return pd.read_excel(path, dtype=str, engine="openpyxl")
    try:
        return pd.read_csv(path, dtype=str, encoding="utf-8")
    except UnicodeDecodeError:
        return pd.read_csv(path, dtype=str, encoding="big5")

def pick(d: dict, names: list[str], default=""):
    for n in names:
        if n in d and str(d[n]).strip():
            return str(d[n]).strip()
    return default

def build_row_text(row: dict) -> str:
    """
    Turn one CSV row into a compact, elder-friendly fact block.
    We map common column variants → normalized fields.
    """
    level   = pick(row, ["失能等級","等級","等別","等第","level"])
    item    = pick(row, ["給付項目","項目","benefit_item"])
    basis   = pick(row, ["給付標準","標準","計算公式","formula","benefit_standard"])
    cond    = pick(row, ["條件","要件","申請條件","conditions"])
    remark  = pick(row, ["備註","說明","備考","remark","note"])

    # build a readable paragraph 
    lines = []
    if level: lines.append(f"失能等級：{level}")
    if item:  lines.append(f"給付項目：{item}")
    if basis: lines.append(f"給付標準／公式：{basis}")
    if cond:  lines.append(f"申請條件：{cond}")
    if remark:lines.append(f"備註：{remark}")

    # if the CSV has other useful columns
    extras = []
    for k, v in row.items():
        if v and k not in ("",) and k not in ["失能等級","等級","等別","等第","level",
                                              "給付項目","項目","benefit_item",
                                              "給付標準","標準","計算公式","formula","benefit_standard",
                                              "條件","要件","申請條件","conditions",
                                              "備註","說明","備考","remark","note"]:
            sv = str(v).strip()
            if sv and len(sv) <= 120:
                extras.append(f"{k}：{sv}")
    if extras:
        lines.append("其他： " + "；".join(extras))

    return "\n".join(lines).strip()

def main(in_path="data/A17000000J-030152-gJm.csv"):
    if not os.path.exists(in_path):
        print("file not found:", in_path)
        sys.exit(1)

    print("reading:", in_path)
    df = try_read_table(in_path).fillna("")
    print("   rows:", len(df))

    client = QdrantClient(
    url=QDRANT_URL,
    api_key=os.getenv("QDRANT_API_KEY"),
    timeout=60.0,
    prefer_grpc=False,
    check_compatibility=False)
    ensure_collection(client, COLLECTION)
    embedder = OpenAIEmbeddings(model=EMBED_MODEL)

    batch_ids, batch_vecs, batch_payloads = [], [], []
    total_chunks = 0

    for i, s in df.iterrows():
        row = {k: (str(v).strip() if v is not None else "") for k, v in s.items()}
        text = build_row_text(row)
        if not text:
            continue

        # chunk
        chunks = chunk_text(text, max_tokens=350, overlap=40)
        vecs = embedder.embed_documents(chunks)

        for j, (ch, vec) in enumerate(zip(chunks, vecs)):
            pid = str(uuid.uuid4())
            payload = {
                "dataset": os.path.basename(in_path),
                "title": DATASET_TITLE,    
                "category": CATEGORY,
                "row_index": i,
                "part": j,
                "text": ch,               # keep chunk text for UI display
            }
            batch_ids.append(pid)
            batch_vecs.append(vec)
            batch_payloads.append(payload)

        total_chunks += len(chunks)

        # upsert in safe batches
        if len(batch_ids) >= 200:
            client.upsert(
                collection_name=COLLECTION,
                points=qm.Batch(ids=batch_ids, vectors=batch_vecs, payloads=batch_payloads)
            )
            batch_ids, batch_vecs, batch_payloads = [], [], []

    # final flush
    if batch_ids:
        client.upsert(
            collection_name=COLLECTION,
            points=qm.Batch(ids=batch_ids, vectors=batch_vecs, payloads=batch_payloads)
        )

    print(f"upserted {total_chunks} chunks into `{COLLECTION}`")

if __name__ == "__main__":
    in_path = sys.argv[1] if len(sys.argv) > 1 else "data/A17000000J-030152-gJm.csv"
    main(in_path)
