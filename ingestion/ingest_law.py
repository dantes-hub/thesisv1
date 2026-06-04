import os, re, uuid, time, sys, pathlib
import pandas as pd
from bs4 import BeautifulSoup
import requests
from dotenv import load_dotenv

import tiktoken
from langchain_openai import OpenAIEmbeddings
from qdrant_client import QdrantClient
from qdrant_client.http import models as qm

# config
EMBED_MODEL = "text-embedding-3-large" 
EMBED_DIM   = 3072
ROC_BASE    = 1911                        
DEFAULT_COLLECTION = "labor_assistant_v1"

load_dotenv()
QDRANT_URL = os.getenv("QDRANT_URL", "http://localhost:6333")
COLLECTION = os.getenv("COLLECTION", DEFAULT_COLLECTION)

enc = tiktoken.get_encoding("cl100k_base")

def ensure_collection(client: QdrantClient, name: str):
    exists = any(c.name == name for c in client.get_collections().collections)
    if not exists:
        client.create_collection(
            collection_name=name,
            vectors_config=qm.VectorParams(size=EMBED_DIM, distance=qm.Distance.COSINE)
        )
        print(f"Created collection: {name}")
    else:
        print(f"Collection exists: {name}")

def chunk_text(text: str, max_tokens=450, overlap=60):
    toks = enc.encode(text or "")
    i, out = 0, []
    while i < len(toks):
        j = min(i + max_tokens, len(toks))
        out.append(enc.decode(toks[i:j]))
        if j >= len(toks): break
        i = max(0, j - overlap)
    return out

def roc_to_iso(s):
    """11307 -> 2024-07 ; 1130705 -> 2024-07-05 ; graceful fallback."""
    if not s: return ""
    s = re.sub(r"\D","", str(s))
    if len(s) == 5:  # yyyMM
        y, m = int(s[:3]) + ROC_BASE, int(s[3:5])
        return f"{y:04d}-{m:02d}"
    if len(s) == 7:  # yyyMMdd
        y, m, d = int(s[:3]) + ROC_BASE, int(s[3:5]), int(s[5:7])
        return f"{y:04d}-{m:02d}-{d:02d}"
    return s

def try_read_table(path: str) -> pd.DataFrame:
    ext = pathlib.Path(path).suffix.lower()
    if ext in (".xlsx", ".xls"):
        return pd.read_excel(path, dtype=str, engine="openpyxl")
    # csv utf-8 then big5
    try:
        return pd.read_csv(path, dtype=str, encoding="utf-8")
    except UnicodeDecodeError:
        return pd.read_csv(path, dtype=str, encoding="big5")

def fetch_page_text(url: str) -> str:
    """Fetch visible text from the URL; safe to fail."""
    try:
        r = requests.get(url, timeout=20)
        r.raise_for_status()
        soup = BeautifulSoup(r.text, "html.parser")
        for tag in soup(["script","style","nav","footer","header"]): tag.decompose()
        nodes = soup.select("main, article")
        if not nodes: nodes = [soup.body or soup]
        text = "\n".join(n.get_text(" ", strip=True) for n in nodes)
        text = re.sub(r"\n{2,}", "\n\n", text)
        return text.strip()
    except Exception as e:
        print("   ⚠️ fetch failed:", url, e)
        return ""

def pick(r, *keys):
    for k in keys:
        if k in r and str(r[k]).strip():
            return str(r[k]).strip()
    return ""

def main(in_path="data/law_regulations.csv"):
    if not os.path.exists(in_path):
        print("file not found:", in_path)
        sys.exit(1)

    print("reading:", in_path)
    df = try_read_table(in_path).fillna("")
    print("   rows:", len(df))

    # common column
    title_cols = ["法規名稱", "標題", "title", "名稱"]
    url_cols   = ["網址", "連結", "url", "link"]
    cat_cols   = ["法規類別", "類別", "category"]
    date_cols  = ["日期（民國年月）", "日期", "date"]

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

    for idx, row in df.iterrows():
        r = {k: str(v) for k, v in row.items()}  # normalize

        title = pick(r, *title_cols)
        url   = pick(r, *url_cols)
        cat   = pick(r, *cat_cols)
        date  = roc_to_iso(pick(r, *date_cols))

        # if URL exists, fetch page text.
        # else concatenate all columns for this row.
        raw_text = ""
        if url:
            print(f"🔎 [{idx+1}/{len(df)}] fetch: {title or '(no title)'} | {url}")
            raw_text = fetch_page_text(url)

        if not raw_text:
            #stringify the row
            parts = [f"{k}: {v}" for k, v in r.items() if v and k not in ("",)]
            raw_text = " · ".join(parts)

        if not raw_text.strip():
            continue

        chunks = chunk_text(raw_text, max_tokens=450, overlap=60)
        vecs = embedder.embed_documents(chunks)

        for part_i, (ch, vec) in enumerate(zip(chunks, vecs)):
            pid = str(uuid.uuid4())
            meta = {
                "dataset": os.path.basename(in_path),
                "title": title,
                "url": url,
                "category": cat,
                "date": date,
                "part": part_i,
                "text": ch,          # keep chunk text in payload for display
            }
            batch_ids.append(pid)
            batch_vecs.append(vec)
            batch_payloads.append(meta)

        total_chunks += len(chunks)

        # upsert in batches to avoid giant requests
        if len(batch_ids) >= 50:
            client.upsert(
                collection_name=COLLECTION,
                points=qm.Batch(ids=batch_ids, vectors=batch_vecs, payloads=batch_payloads)
            )
            batch_ids, batch_vecs, batch_payloads = [], [], []

        
        if url:
            time.sleep(0.6)

    # final 
    if batch_ids:
        client.upsert(
            collection_name=COLLECTION,
            points=qm.Batch(ids=batch_ids, vectors=batch_vecs, payloads=batch_payloads)
        )

    print(f"upserted {total_chunks} chunks into `{COLLECTION}`")

if __name__ == "__main__":
    in_path = sys.argv[1] if len(sys.argv) > 1 else "data/law_regulations.csv"
    main(in_path)
