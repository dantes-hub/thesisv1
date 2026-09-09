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
import time

from qdrant_client import QdrantClient
from qdrant_client.http import models as qm

DEFAULT_COLLECTION = "labor_assistant_v1"
# 3072-dim vectors serialised as JSON are ~60KB each, so a batch of 128 is ~8MB
# per request. That is fine to localhost and times out over a long-haul upload.
DEFAULT_BATCH = 32
DEFAULT_TIMEOUT = 120


def parse_args():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--source-url", default=os.getenv("QDRANT_URL", "http://localhost:6333"))
    ap.add_argument("--source-api-key", default=os.getenv("QDRANT_API_KEY") or None)
    ap.add_argument("--target-url", required=True)
    ap.add_argument("--target-api-key", default=os.getenv("QDRANT_CLOUD_API_KEY") or None)
    ap.add_argument("--collection", default=os.getenv("COLLECTION", DEFAULT_COLLECTION))
    ap.add_argument("--target-collection", default=None, help="Defaults to --collection")
    ap.add_argument("--dry-run", action="store_true", help="Report what would be copied, write nothing")
    ap.add_argument("--batch", type=int, default=DEFAULT_BATCH,
                    help=f"Points per upload request (default {DEFAULT_BATCH}). Lower it on a slow link.")
    ap.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT,
                    help=f"Per-request timeout in seconds (default {DEFAULT_TIMEOUT}).")
    ap.add_argument("--recreate", action="store_true",
                    help="Delete the target collection first. Use to restart after a failed run.")
    return ap.parse_args()


def main():
    args = parse_args()
    target_collection = args.target_collection or args.collection

    source = QdrantClient(url=args.source_url, api_key=args.source_api_key,
                          check_compatibility=False, timeout=args.timeout)
    target = QdrantClient(url=args.target_url, api_key=args.target_api_key,
                          check_compatibility=False, timeout=args.timeout)

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

    if args.recreate:
        try:
            target.delete_collection(target_collection)
            print(f"deleted existing collection {target_collection!r}")
        except Exception:
            pass

    existing = {c.name for c in target.get_collections().collections}
    if target_collection in existing:
        count = target.count(target_collection, exact=True).count
        if count:
            sys.exit(
                f"[error] target collection {target_collection!r} already holds {count} points. "
                "Pass --recreate to start over, or --target-collection to write elsewhere."
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
            limit=args.batch,
            offset=offset,
            with_payload=True,
            with_vectors=True,
        )
        if not points:
            break

        batch = [qm.PointStruct(id=p.id, vector=p.vector, payload=p.payload) for p in points]
        # Upserts are keyed by point id, so retrying a batch is safe.
        for attempt in range(1, 6):
            try:
                target.upsert(collection_name=target_collection, points=batch, wait=True)
                break
            except Exception as exc:
                if attempt == 5:
                    print(f"\n[error] batch failed after 5 attempts: {exc}")
                    print(f"[hint] {copied} points uploaded so far. Re-run with "
                          f"--recreate, and add --batch 8 if the link is slow.")
                    raise
                wait = 2 ** attempt
                print(f"\n  upload failed ({type(exc).__name__}), retrying in {wait}s "
                      f"[{attempt}/5]", flush=True)
                time.sleep(wait)
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
