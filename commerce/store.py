import json
import os
from copy import deepcopy
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
DB_PATH = BASE_DIR / "data" / "db.json"


def _empty_db():
    return {
        "settings": {},
        "products": [],
        "stories": [],
        "orders": [],
        "coupons": [],
        "customers": [],
        "affiliates": [],
        "sellers": [],
        "customRequests": [],
    }


def _database_url():
    return os.environ.get("DATABASE_URL") or os.environ.get("POSTGRES_URL")


def _use_postgres():
    return bool(_database_url())


def _pg_connect():
    import psycopg

    kwargs = {}
    url = _database_url()
    if os.environ.get("PGSSLMODE", "").lower() == "require" or "sslmode=require" in url:
        kwargs["sslmode"] = "require"
    return psycopg.connect(url, **kwargs)


def _read_file_db():
    if not DB_PATH.exists():
        return _empty_db()
    raw = DB_PATH.read_text(encoding="utf-8-sig")
    return json.loads(raw) if raw.strip() else _empty_db()


def _write_file_db(db):
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = DB_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(db, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(DB_PATH)


def _ensure_pg_store():
    with _pg_connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                create table if not exists basa_store (
                  key text primary key,
                  value jsonb not null,
                  updated_at timestamptz not null default now()
                )
                """
                )
            cur.execute("select 1 from basa_store where key = %s", ("db",))
            if not cur.fetchone():
                cur.execute(
                    "insert into basa_store (key, value, updated_at) values (%s, %s::jsonb, now())",
                    ("db", json.dumps(_read_file_db())),
                )
            cur.execute(
                """
                create table if not exists basa_uploads (
                  path text primary key,
                  content bytea not null,
                  content_type text not null default 'application/octet-stream',
                  updated_at timestamptz not null default now()
                )
                """
            )


def read_db():
    if not _use_postgres():
        return _read_file_db()
    _ensure_pg_store()
    with _pg_connect() as conn:
        with conn.cursor() as cur:
            cur.execute("select value from basa_store where key = %s", ("db",))
            row = cur.fetchone()
            return deepcopy(row[0]) if row else _empty_db()


def write_db(db):
    if not _use_postgres():
        _write_file_db(db)
        return
    _ensure_pg_store()
    with _pg_connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                insert into basa_store (key, value, updated_at)
                values (%s, %s::jsonb, now())
                on conflict (key) do update set value = excluded.value, updated_at = now()
                """,
                ("db", json.dumps(db)),
            )


def save_upload(path_value, content, content_type="application/octet-stream"):
    normalized = "/" + str(path_value or "").lstrip("/")
    if not _use_postgres():
        target = (BASE_DIR / "public" / normalized.lstrip("/")).resolve()
        public_root = (BASE_DIR / "public").resolve()
        if public_root not in target.parents:
            raise ValueError("Caminho de upload invalido.")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
        return
    _ensure_pg_store()
    with _pg_connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                insert into basa_uploads (path, content, content_type, updated_at)
                values (%s, %s, %s, now())
                on conflict (path) do update
                set content = excluded.content,
                    content_type = excluded.content_type,
                    updated_at = now()
                """,
                (normalized, bytes(content), content_type or "application/octet-stream"),
            )


def read_upload(path_value):
    normalized = "/" + str(path_value or "").lstrip("/")
    if not _use_postgres():
        target = (BASE_DIR / "public" / normalized.lstrip("/")).resolve()
        public_root = (BASE_DIR / "public").resolve()
        if public_root not in target.parents or not target.exists():
            return None
        return {"content": target.read_bytes(), "content_type": "application/octet-stream"}
    _ensure_pg_store()
    with _pg_connect() as conn:
        with conn.cursor() as cur:
            cur.execute("select content, content_type from basa_uploads where path = %s", (normalized,))
            row = cur.fetchone()
            if not row:
                return None
            return {"content": bytes(row[0]), "content_type": row[1] or "application/octet-stream"}
