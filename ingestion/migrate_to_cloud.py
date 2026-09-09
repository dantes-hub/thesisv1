"""Copy an existing Qdrant collection to another cluster, vectors included.

Re-running the ingestion scripts against Qdrant Cloud would re-embed every chunk
and cost money. The vectors already exist locally, so this copies them verbatim.

    python migrate_to_cloud.py \
        --target-url https://xyz.cloud.qdrant.io:6333 \
        --target-api-key "$QDRANT_CLOUD_KEY"

Source defaults to the local Docker instance. Pass --dry-run to inspect first.
"""

import argparse
import os
import sys

from qdrant_client import QdrantClient
from qdrant_client.http import models as qm

DEFAULT_COLLECTION = "labor_assistant_v1"
BATCH = 128


def parse_args():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--source-url", default=os.getenv("QDRANT_URL", "http://localhost:6333"))
    ap.add_argument("--source-api-key", default=os.getenv("QDRANT_API_KEY") or None)
    ap.add_argument("--target-url", required=True)
    ap.add_argument("--target-api-key", default=os.getenv("QDRANT_CLOUD_API_KEY") or None)
    ap.add_argument("--collection", default=os.getenv("COLLECTION", DEFAULT_COLLECTION))
    ap.add_argument("--target-collection", default=None, help="Defaults to --collection")
    ap.add_argument("--dry-run", action="store_true", help="Report what would be copied, write nothing")
    return ap.parse_args()


def main():
    args = parse_args()
    target_collection = args.target_collection or args.collection

    source = QdrantClient(url=args.source_url, api_key=args.source_api_key, check_compatibility=False)
    target = QdrantClient(url=args.target_url, api_key=args.target_api_key, check_compatibility=False)

    try:
        info = source.get_collection(args.collection)
    except Exception as exc:
        sys.exit(f"[error] cannot read source collection {args.collection!r}: {exc}")

    vectors = info.config.params.vectors
    total = info.points_count
    print(f"source : {args.source_url} / {args.collection}")
    print(f"target : {args.target_url} / {target_collection}")
    print(f"points : {total}  (size={vectors.size}, distance={vectors.distance})")

    if args.dry_run:
        print("\n[dry-run] nothing written.")
        return

    existing = {c.name for c in target.get_collections().collections}
    if target_collection in existing:
        count = target.count(target_collection, exact=True).count
        if count:
            sys.exit(
                f"[error] target collection {target_collection!r} already holds {count} points. "
                "Delete it first, or pass --target-collection to write elsewhere."
            )
    else:
        target.create_collection(
            collection_name=target_collection,
            vectors_config=qm.VectorParams(size=vectors.size, distance=vectors.distance),
        )
        print(f"created collection {target_collection!r}")

    # The API filters office lookups on this payload field.
    target.create_payload_index(
        collection_name=target_collection,
        field_name="type",
        field_schema=qm.PayloadSchemaType.KEYWORD,
    )

    copied, offset = 0, None
    while True:
        points, offset = source.scroll(
            collection_name=args.collection,
            limit=BATCH,
            offset=offset,
            with_payload=True,
            with_vectors=True,
        )
        if not points:
            break
        target.upsert(
            collection_name=target_collection,
            points=[qm.PointStruct(id=p.id, vector=p.vector, payload=p.payload) for p in points],
            wait=True,
        )
        copied += len(points)
        print(f"  copied {copied}/{total}", end="\r", flush=True)
        if offset is None:
            break

    final = target.count(target_collection, exact=True).count
    print(f"\ndone: {copied} copied, target now holds {final} points")
    if final != total:
        sys.exit(f"[warn] count mismatch: source {total}, target {final}")


if __name__ == "__main__":
    main()
