import hashlib
import hmac
import json
import os
import re
import secrets
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

from django.core.signing import BadSignature, TimestampSigner
from django.http import FileResponse, Http404, JsonResponse
from django.views.decorators.csrf import csrf_exempt

from .store import BASE_DIR, read_db, write_db

PUBLIC_DIR = BASE_DIR / "public"
ADMIN_USER = os.environ.get("ADMIN_USER", "admin@basa3dworks.com")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "admin")
SESSION_SECRET = os.environ.get("SESSION_SECRET") or os.environ.get("DJANGO_SECRET_KEY") or "dev-secret"
signer = TimestampSigner(key=SESSION_SECRET, salt="basa-admin")


def _now():
    return datetime.now(timezone.utc).isoformat()


def _json_body(request):
    if not request.body:
        return {}
    return json.loads(request.body.decode("utf-8"))


def _slug(value):
    normalized = unicodedata.normalize("NFD", value or "")
    ascii_text = "".join(ch for ch in normalized if unicodedata.category(ch) != "Mn")
    return re.sub(r"(^-|-$)", "", re.sub(r"[^a-z0-9]+", "-", ascii_text.lower()))


def _lines(value):
    return [line.strip() for line in str(value or "").splitlines() if line.strip()]


def _admin_ok(request):
    token = request.COOKIES.get("basa_admin", "")
    try:
        return signer.unsign(token, max_age=60 * 60 * 12) == "ok"
    except BadSignature:
        return False


def _require_admin(request):
    if not _admin_ok(request):
        return JsonResponse({"error": "Nao autenticado."}, status=401)
    return None


def _hash_password(password):
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 120000).hex()
    return f"pbkdf2$120000${salt}${digest}"


def _verify_password(password, stored):
    if not stored:
        return False
    try:
        method, iterations, salt, expected = stored.split("$", 3)
        if method != "pbkdf2":
            return False
        digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), int(iterations)).hex()
        return hmac.compare_digest(digest, expected)
    except ValueError:
        return False


def _public_product(product, db):
    orders = db.get("orders", [])
    sold = sum(
        int(item.get("quantity") or 0)
        for order in orders
        if order.get("status") in {"paid", "in_production", "shipped", "completed"}
        for item in order.get("items", [])
        if item.get("productId") == product.get("id")
    )
    favorite_count = int(product.get("favoriteCount") or 0) + sum(
        1 for customer in db.get("customers", []) if product.get("id") in customer.get("favorites", [])
    )
    payload = dict(product)
    payload.update(
        {
            "soldCount": int(product.get("soldCount") or 0) or sold,
            "favoriteCount": favorite_count,
            "gallery": product.get("gallery") or [product.get("image")],
            "regularPrice": product.get("price"),
        }
    )
    return payload


def _product_payload(body, existing=None):
    existing = existing or {}
    name = body.get("name") or existing.get("name") or "Produto"
    price = round(float(body.get("price") or existing.get("price") or 0), 2)
    return {
        **existing,
        "id": existing.get("id") or f"prod-{secrets.token_hex(6)}",
        "createdAt": existing.get("createdAt") or _now(),
        "name": name,
        "slug": body.get("slug") or existing.get("slug") or _slug(name),
        "description": body.get("description", existing.get("description", "")),
        "longDescription": body.get("longDescription") or body.get("description") or existing.get("longDescription", ""),
        "highlights": body.get("highlights") if isinstance(body.get("highlights"), list) else _lines(body.get("highlights", "\n".join(existing.get("highlights", [])))),
        "specs": body.get("specs") if isinstance(body.get("specs"), dict) else existing.get("specs", {}),
        "variants": {
            "bundleType": "kit" if body.get("bundleType") == "kit" else "single",
            "colors": body.get("colors") if isinstance(body.get("colors"), list) else _lines(body.get("colors", "")),
            "piecesIncluded": max(1, int(float(body.get("piecesIncluded") or existing.get("variants", {}).get("piecesIncluded") or 1))),
        },
        "videoUrl": body.get("videoUrl", existing.get("videoUrl", "")),
        "gallery": body.get("gallery") if isinstance(body.get("gallery"), list) else [body.get("image") or existing.get("image", "")],
        "price": price,
        "compareAtPrice": round(float(body.get("compareAtPrice") or existing.get("compareAtPrice") or 0), 2),
        "stock": int(float(body.get("stock") or existing.get("stock") or 0)),
        "status": body.get("status") or existing.get("status") or "active",
        "category": body.get("category") or existing.get("category") or "Geral",
        "image": body.get("image") or existing.get("image", ""),
        "shipping": {
            **existing.get("shipping", {}),
            "weightKg": float(body.get("weightKg") or existing.get("shipping", {}).get("weightKg") or 0.3),
            "widthCm": float(body.get("widthCm") or existing.get("shipping", {}).get("widthCm") or 12),
            "heightCm": float(body.get("heightCm") or existing.get("shipping", {}).get("heightCm") or 8),
            "lengthCm": float(body.get("lengthCm") or existing.get("shipping", {}).get("lengthCm") or 18),
            "sellerPaysShipping": bool(body.get("sellerPaysShipping", existing.get("shipping", {}).get("sellerPaysShipping", False))),
            "freeShippingMinQuantity": int(float(body.get("freeShippingMinQuantity") or existing.get("shipping", {}).get("freeShippingMinQuantity") or 0)),
        },
        "campaign": existing.get("campaign"),
    }


def public_page(request, page="index.html"):
    safe_page = Path(page).name
    if Path(safe_page).suffix != ".html":
        safe_page = f"{safe_page}.html"
    file_path = PUBLIC_DIR / safe_page
    if not file_path.exists() or file_path.suffix != ".html":
        raise Http404()
    return FileResponse(file_path.open("rb"), content_type="text/html; charset=utf-8")


def api_session(request):
    return JsonResponse({"authenticated": _admin_ok(request)})


@csrf_exempt
def api_login(request):
    body = _json_body(request)
    ok = body.get("email") == ADMIN_USER and body.get("password") == ADMIN_PASSWORD
    if not ok:
        return JsonResponse({"error": "Credenciais invalidas."}, status=401)
    response = JsonResponse({"ok": True})
    response.set_cookie("basa_admin", signer.sign("ok"), httponly=True, samesite="Lax")
    return response


@csrf_exempt
def api_logout(request):
    response = JsonResponse({"ok": True})
    response.delete_cookie("basa_admin")
    return response


def api_products(request):
    db = read_db()
    products = [_public_product(product, db) for product in db.get("products", []) if product.get("status") != "inactive"]
    stories = [story for story in db.get("stories", []) if story.get("active") is not False]
    return JsonResponse({"settings": db.get("settings", {}), "products": products, "stories": stories, "coupons": db.get("coupons", [])})


@csrf_exempt
def api_customer_access(request):
    body = _json_body(request)
    email = str(body.get("email", "")).strip().lower()
    password = str(body.get("password", ""))
    if not email:
        return JsonResponse({"error": "Informe o email."}, status=400)
    db = read_db()
    customers = db.setdefault("customers", [])
    customer = next((item for item in customers if str(item.get("email", "")).lower() == email), None)
    if body.get("loginOnly"):
        if not customer or (customer.get("passwordHash") and not _verify_password(password, customer.get("passwordHash"))):
            return JsonResponse({"error": "Conta nao encontrada ou senha invalida."}, status=404)
    if not customer:
        customer = {
            "id": f"cus-{secrets.token_hex(6)}",
            "createdAt": _now(),
            "name": body.get("name") or email.split("@")[0],
            "email": email,
            "phone": body.get("phone", ""),
            "document": body.get("document", ""),
            "favorites": [],
        }
        customers.append(customer)
    if password:
        customer["passwordHash"] = _hash_password(password)
    customer["updatedAt"] = _now()
    write_db(db)
    safe_customer = {key: value for key, value in customer.items() if key != "passwordHash"}
    return JsonResponse({"customer": safe_customer})


def api_customer_orders(request):
    email = str(request.GET.get("email", "")).strip().lower()
    db = read_db()
    orders = [order for order in db.get("orders", []) if str(order.get("customer", {}).get("email", "")).lower() == email]
    return JsonResponse({"orders": orders})


@csrf_exempt
def api_custom_requests(request):
    db = read_db()
    if request.method == "GET":
        email = str(request.GET.get("email", "")).strip().lower()
        requests = db.get("customRequests", [])
        if email:
            requests = [item for item in requests if str(item.get("customer", {}).get("email", "")).lower() == email]
        return JsonResponse({"requests": requests})
    body = _json_body(request)
    item = {
        "id": f"req-{secrets.token_hex(6)}",
        "createdAt": _now(),
        "updatedAt": _now(),
        "status": "open",
        "title": body.get("title", "Orcamento sob medida"),
        "idea": body.get("idea", ""),
        "budget": body.get("budget", ""),
        "deadline": body.get("deadline", ""),
        "customer": body.get("customer", {}),
        "messages": [],
    }
    db.setdefault("customRequests", []).insert(0, item)
    write_db(db)
    return JsonResponse({"request": item}, status=201)


def api_admin_dashboard(request):
    error = _require_admin(request)
    if error:
        return error
    db = read_db()
    return JsonResponse({**db, "products": [_public_product(product, db) for product in db.get("products", [])]})


@csrf_exempt
def api_admin_products(request):
    error = _require_admin(request)
    if error:
        return error
    db = read_db()
    if request.method == "GET":
        return JsonResponse({"products": db.get("products", [])})
    body = _json_body(request)
    product = _product_payload(body)
    db.setdefault("products", []).insert(0, product)
    write_db(db)
    return JsonResponse({"product": product}, status=201)


@csrf_exempt
def api_admin_product_detail(request, product_id):
    error = _require_admin(request)
    if error:
        return error
    db = read_db()
    products = db.setdefault("products", [])
    index = next((idx for idx, item in enumerate(products) if item.get("id") == product_id), -1)
    if index < 0:
        return JsonResponse({"error": "Produto nao encontrado."}, status=404)
    if request.method == "DELETE":
        removed = products.pop(index)
        write_db(db)
        return JsonResponse({"product": removed})
    body = _json_body(request)
    products[index] = _product_payload(body, products[index])
    write_db(db)
    return JsonResponse({"product": products[index]})
