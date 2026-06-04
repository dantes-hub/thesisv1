import os, re, sys, uuid, pathlib, time
import pandas as pd
from dotenv import load_dotenv

from langchain_openai import OpenAIEmbeddings
from qdrant_client import QdrantClient
from qdrant_client.http import models as qm

# congif
EMBED_MODEL = "text-embedding-3-large" 
EMBED_DIM   = 3072
DEFAULT_COLLECTION = "labor_assistant_v1"

load_dotenv()
QDRANT_URL = os.getenv("QDRANT_URL", "http://localhost:6333")
COLLECTION = os.getenv("COLLECTION", DEFAULT_COLLECTION)
OFFICE_INDEX_URL = "https://www.bli.gov.tw/0009139.html"  

# io helper
def try_read_table(path: str) -> pd.DataFrame:
    ext = pathlib.Path(path).suffix.lower()
    if ext in (".xlsx", ".xls"):
        return pd.read_excel(path, dtype=str, engine="openpyxl")
    try:
        return pd.read_csv(path, dtype=str, encoding="utf-8")
    except UnicodeDecodeError:
        return pd.read_csv(path, dtype=str, encoding="big5")

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

def norm_key(k: str) -> str:
    k = (k or "").strip().lower()
    mapping = {
        # names
        "機關名稱":"name","單位名稱":"name","辦事處名稱":"name","服務據點":"name",
        "分局名稱":"name","名稱":"name","name":"name","title":"name",

        # office dataset variants
        "縣市別":"city",
        "辦事處地址":"address",
        "辦事處電話":"phone",
        "櫃台服務時間":"hours",
        "電話服務時間":"phone_hours",

        # address
        "地址":"address","地址(含郵遞區號)":"address","地址（含郵遞區號）":"address",
        "location":"address","address":"address",

        # zip/city/district
        "郵遞區號":"zip","郵遞區號(郵編)":"zip","zip":"zip",
        "城市":"city","縣市":"city","city":"city",
        "鄉鎮市區":"district","行政區":"district","區":"district","district":"district",

        # phone/fax
        "電話":"phone","聯絡電話":"phone","tel":"phone",
        "電話(總機)":"phone","電話（總機）":"phone",
        "傳真":"fax","fax":"fax",

        # hours general
        "服務時間":"hours","洽辦時間":"hours","開放時間":"hours",
        "辦理時間":"hours","上班時間":"hours","hours":"hours",

        # coords
        "經度":"lng","緯度":"lat",
        "longitude":"lng","latitude":"lat","lon":"lng","lng":"lng","lat":"lat",

        # url
        "網址":"url","連結":"url","url":"url","link":"url",

        # misc
        "備註":"note","備考":"note","note":"note",
    }
    return mapping.get(k, k)

def pick(d: dict, *keys):
    for k in keys:
        v = d.get(k)
        if v and str(v).strip():
            return str(v).strip()
    return ""

def compact_lines(lines):
    return "\n".join([ln for ln in [x.strip() for x in lines] if ln])

def build_office_text(row):
    """Make a single, elder-friendly paragraph per office."""
    name    = pick(row, "name")
    address = pick(row, "address")
    phone   = pick(row, "phone")
    hours   = pick(row, "hours")
    fax     = pick(row, "fax")
    url     = OFFICE_INDEX_URL
    zipc    = pick(row, "zip")
    city    = pick(row, "city")
    dist    = pick(row, "district")

    head = f"{name}" if name else "辦事處"
    addr_line = f"地址：{zipc} {city or ''}{dist or ''}{address}".strip()
    tel_line  = f"電話：{phone}" if phone else ""
    fax_line  = f"傳真：{fax}" if fax else ""
    hours_ln  = f"服務時間：{hours}" if hours else ""
    url_line = f"官方連結：{url}"

    return compact_lines([
        head,
        addr_line,
        tel_line,
        fax_line,
        hours_ln,
        url_line
    ])

def main(in_path="data/offices.csv"):
    if not os.path.exists(in_path):
        print("file not found:", in_path)
        sys.exit(1)

    print("reading:", in_path)
    df = try_read_table(in_path).fillna("")
    print("   rows:", len(df))

    # normalize columns
    df.columns = [norm_key(c) for c in df.columns]

    client = QdrantClient(
    url=QDRANT_URL,
    api_key=os.getenv("QDRANT_API_KEY"),
    timeout=60.0,
    prefer_grpc=False,
    check_compatibility=False)
    ensure_collection(client, COLLECTION)
    embedder = OpenAIEmbeddings(model=EMBED_MODEL)

    batch_ids, batch_vecs, batch_payloads = [], [], []
    total = 0

    for i, row in df.iterrows():
        rd = {k: str(v) for k, v in row.items()}
        text = build_office_text(rd)
        if not text.strip():
            continue

        vec = embedder.embed_query(text)

        pid = str(uuid.uuid4())
        payload = {
            "dataset": os.path.basename(in_path),
            "type": "office",
            "title": pick(rd, "name") or f"{rd.get('city','')}辦事處",
            "url": OFFICE_INDEX_URL,
            "city": pick(rd, "city"),
            "district": pick(rd, "district"),
            "zip": pick(rd, "zip"),
            "address": pick(rd, "address"),
            "phone": pick(rd, "phone"),
            "hours": pick(rd, "hours"),
            "fax": pick(rd, "fax"),
            "lat": pick(rd, "lat"),
            "lng": pick(rd, "lng"),
            "text": text,
        }

        batch_ids.append(pid)
        batch_vecs.append(vec)
        batch_payloads.append(payload)
        total += 1

        if len(batch_ids) >= 200:
            client.upsert(
                collection_name=COLLECTION,
                points=qm.Batch(ids=batch_ids, vectors=batch_vecs, payloads=batch_payloads)
            )
            batch_ids, batch_vecs, batch_payloads = [], [], []

        time.sleep(0.01)

    if batch_ids:
        client.upsert(
            collection_name=COLLECTION,
            points=qm.Batch(ids=batch_ids, vectors=batch_vecs, payloads=batch_payloads)
        )

    print(f"upserted {total} offices into `{COLLECTION}`")

if __name__ == "__main__":
    in_path = sys.argv[1] if len(sys.argv) > 1 else "data/offices.csv"
    main(in_path)
