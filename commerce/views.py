import hashlib
import hmac
import json
import mimetypes
import os
import re
import secrets
import unicodedata
import urllib.request
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


def _safe_customer_account(account):
    if "customer" in account:
        return {
            "id": account.get("id"),
            "username": account.get("username"),
            "customer": account.get("customer", {}),
            "status": account.get("status", "active"),
            "notes": account.get("notes", ""),
            "createdAt": account.get("createdAt"),
            "updatedAt": account.get("updatedAt"),
        }
    return {
        "id": account.get("id"),
        "username": account.get("username") or str(account.get("email", "")).split("@")[0],
        "customer": {
            "name": account.get("name", ""),
            "email": account.get("email", ""),
            "phone": account.get("phone", ""),
            "document": account.get("document", ""),
            **account.get("address", {}),
        },
        "status": account.get("status", "active"),
        "notes": account.get("notes", ""),
        "createdAt": account.get("createdAt"),
        "updatedAt": account.get("updatedAt"),
    }


def _customer_email(account):
    return str(account.get("customer", {}).get("email") or account.get("email") or "").strip().lower()


def _customer_username(account):
    return str(account.get("username") or account.get("customerUsername") or _customer_email(account).split("@")[0]).strip().lower()


def _customer_payload(body, existing=None):
    existing = existing or {}
    current = existing.get("customer", {}) if "customer" in existing else existing
    email = str(body.get("email", current.get("email", ""))).strip().lower()
    username = str(body.get("username") or body.get("customerUsername") or existing.get("username") or email.split("@")[0]).strip()
    if not email:
        raise ValueError("Informe o email.")
    customer = {
        "name": body.get("name", current.get("name", "")),
        "email": email,
        "phone": re.sub(r"\D", "", str(body.get("phone", current.get("phone", "")))),
        "document": re.sub(r"\D", "", str(body.get("document", current.get("document", "")))),
        "zipCode": re.sub(r"\D", "", str(body.get("zipCode", current.get("zipCode", "")))),
        "street": body.get("street", current.get("street", "")),
        "number": body.get("number", current.get("number", "")),
        "neighborhood": body.get("neighborhood", current.get("neighborhood", "")),
        "city": body.get("city", current.get("city", "")),
        "state": str(body.get("state", current.get("state", ""))).upper()[:2],
    }
    account = {
        **existing,
        "id": existing.get("id") or f"cus-{secrets.token_hex(6)}",
        "username": username,
        "customer": customer,
        "status": body.get("status") or existing.get("status") or "active",
        "notes": body.get("notes", existing.get("notes", "")),
        "favorites": existing.get("favorites", []),
        "createdAt": existing.get("createdAt") or _now(),
        "updatedAt": _now(),
    }
    password = str(body.get("customerPassword") or body.get("password") or "")
    if password:
        if len(password) < 6:
            raise ValueError("A senha precisa ter pelo menos 6 caracteres.")
        account["passwordHash"] = _hash_password(password)
    elif existing.get("passwordHash"):
        account["passwordHash"] = existing["passwordHash"]
    return account


def _partner_payload(body, existing=None, kind="affiliate"):
    existing = existing or {}
    name = str(body.get("name", existing.get("name", ""))).strip()
    email = str(body.get("email", existing.get("email", ""))).strip().lower()
    if not name:
        raise ValueError("Informe o nome.")
    if not email:
        raise ValueError("Informe o email.")
    code_base = body.get("brandName") or body.get("code") or existing.get("code") or name
    code = re.sub(r"(^-|-$)", "", re.sub(r"[^a-z0-9._-]+", "-", unicodedata.normalize("NFD", code_base).encode("ascii", "ignore").decode().lower()))[:40]
    return {
        **existing,
        "id": existing.get("id") or f"{kind}-{secrets.token_hex(6)}",
        "type": kind,
        "code": code,
        "name": name,
        "brandName": body.get("brandName", existing.get("brandName", "")),
        "email": email,
        "phone": re.sub(r"\D", "", str(body.get("phone", existing.get("phone", "")))),
        "document": re.sub(r"\D", "", str(body.get("document", existing.get("document", "")))),
        "status": body.get("status") or existing.get("status") or "lead",
        "commissionPercent": max(0, float(body.get("commissionPercent") or existing.get("commissionPercent") or 0)),
        "paymentAccountId": body.get("paymentAccountId", existing.get("paymentAccountId", "")),
        "notes": body.get("notes", existing.get("notes", "")),
        "createdAt": existing.get("createdAt") or _now(),
        "updatedAt": _now(),
    }


def _campaign_payload(body):
    return {
        "active": bool(body.get("active")),
        "type": body.get("type") if body.get("type") in {"featured", "flash", "clearance", "launch"} else "featured",
        "label": str(body.get("label", "")).strip(),
        "discountPercent": max(0, min(95, float(body.get("discountPercent") or 0))),
        "priority": max(0, min(100, float(body.get("priority") or 0))),
        "startsAt": body.get("startsAt", ""),
        "endsAt": body.get("endsAt", ""),
        "updatedAt": _now(),
    }


def _request_status(value):
    return value if value in {"new", "in_review", "quoted", "approved", "in_production", "shipped", "completed", "canceled"} else "new"


def _save_upload(file_obj, folder):
    if not file_obj:
        return ""
    upload_dir = PUBLIC_DIR / "uploads" / folder
    upload_dir.mkdir(parents=True, exist_ok=True)
    extension = Path(file_obj.name).suffix.lower() or ".bin"
    name = f"{secrets.token_hex(12)}{extension}"
    target = upload_dir / name
    with target.open("wb") as handle:
        for chunk in file_obj.chunks():
            handle.write(chunk)
    return f"/uploads/{folder}/{name}"


def _coupon_is_expired(coupon):
    expires_at = coupon.get("expiresAt")
    if not expires_at:
        return False
    try:
        return datetime.fromisoformat(str(expires_at).replace("Z", "+00:00")) < datetime.now(timezone.utc)
    except ValueError:
        return False


def _coupon_eligibility(coupon, item_count, subtotal):
    if not coupon or coupon.get("active") is False:
        return False, "Cupom inativo."
    if _coupon_is_expired(coupon):
        return False, "Cupom expirado."
    if item_count < int(float(coupon.get("minItems") or 1)):
        return False, f"Adicione mais {int(float(coupon.get('minItems') or 1)) - item_count} item(ns)."
    if subtotal < float(coupon.get("minSubtotal") or 0):
        return False, "Subtotal abaixo do minimo do cupom."
    return True, ""


def _cart_totals(db, items, shipping_option=None, coupon=None):
    products = {product.get("id"): product for product in db.get("products", [])}
    lines = []
    subtotal = 0.0
    item_count = 0
    seller_pays_shipping = False
    for item in items:
        product = products.get(item.get("productId"))
        if not product:
            continue
        quantity = max(1, int(float(item.get("quantity") or 1)))
        unit_price = float(product.get("price") or 0)
        total = round(unit_price * quantity, 2)
        item_count += quantity
        subtotal += total
        seller_pays_shipping = seller_pays_shipping or bool(product.get("shipping", {}).get("sellerPaysShipping"))
        lines.append({
            "productId": product.get("id"),
            "name": product.get("name"),
            "quantity": quantity,
            "unitPrice": unit_price,
            "total": total,
            "variant": item.get("variant") or {},
        })
    subtotal = round(subtotal, 2)
    free_shipping = seller_pays_shipping
    discount = 0.0
    if coupon:
        eligible, _ = _coupon_eligibility(coupon, item_count, subtotal)
        if eligible:
            if coupon.get("type") == "free_shipping":
                free_shipping = True
            elif coupon.get("type") == "percent":
                discount = round(subtotal * float(coupon.get("value") or 0) / 100, 2)
            else:
                discount = min(subtotal, round(float(coupon.get("value") or 0), 2))
    shipping = 0.0 if free_shipping else round(float((shipping_option or {}).get("price") or 0), 2)
    total = round(max(0, subtotal - discount) + shipping, 2)
    return lines, subtotal, discount, shipping, total, free_shipping


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


def public_asset(request, asset_path):
    safe_parts = [part for part in Path(asset_path).parts if part not in {"", ".", ".."}]
    file_path = (PUBLIC_DIR / Path(*safe_parts)).resolve()
    public_root = PUBLIC_DIR.resolve()
    if public_root not in file_path.parents and file_path != public_root:
        raise Http404()
    if not file_path.exists() or not file_path.is_file():
        raise Http404()
    content_type = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
    if file_path.suffix in {".css", ".js", ".json"}:
        content_type = {
            ".css": "text/css; charset=utf-8",
            ".js": "application/javascript; charset=utf-8",
            ".json": "application/json; charset=utf-8",
        }[file_path.suffix]
    return FileResponse(file_path.open("rb"), content_type=content_type)


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


def api_cep(request, cep):
    digits = re.sub(r"\D", "", cep)
    if len(digits) != 8:
        return JsonResponse({"error": "CEP invalido."}, status=400)
    try:
        with urllib.request.urlopen(f"https://viacep.com.br/ws/{digits}/json/", timeout=8) as response:
            data = json.loads(response.read().decode("utf-8"))
    except Exception:
        return JsonResponse({"error": "Nao foi possivel consultar o CEP."}, status=502)
    if data.get("erro"):
        return JsonResponse({"error": "CEP nao encontrado."}, status=404)
    return JsonResponse({
        "cep": digits,
        "street": data.get("logradouro", ""),
        "neighborhood": data.get("bairro", ""),
        "city": data.get("localidade", ""),
        "state": data.get("uf", ""),
    })


@csrf_exempt
def api_shipping_quote(request):
    body = _json_body(request)
    db = read_db()
    items = body.get("items", [])
    lines, subtotal, _discount, _shipping, _total, free_shipping = _cart_totals(db, items)
    if not lines:
        return JsonResponse({"quotes": [], "error": "Adicione produtos ao carrinho."}, status=400)
    if free_shipping:
        return JsonResponse({"quotes": [{"id": "free-shipping", "provider": "basa", "carrier": "Basa 3D Works", "service": "Frete Gratis", "price": 0, "deliveryDays": 0}]})
    flat_rate = float(db.get("settings", {}).get("shippingFlatRate") or 24.9)
    quotes = [{
        "id": "jt-standard",
        "provider": "django-mock",
        "carrier": "J&T Express",
        "service": "Entrega economica",
        "price": round(flat_rate, 2),
        "originalPrice": round(flat_rate, 2),
        "deliveryDays": 5,
    }]
    return JsonResponse({"quotes": quotes, "subtotal": subtotal})


@csrf_exempt
def api_coupons_validate(request):
    body = _json_body(request)
    db = read_db()
    code = str(body.get("code", "")).strip().upper()
    coupon = next((item for item in db.get("coupons", []) if str(item.get("code", "")).upper() == code), None)
    if not coupon:
        return JsonResponse({"valid": False, "error": "Cupom nao encontrado."}, status=404)
    lines, subtotal, _discount, _shipping, _total, _free_shipping = _cart_totals(db, body.get("items", []))
    item_count = sum(line["quantity"] for line in lines)
    valid, reason = _coupon_eligibility(coupon, item_count, subtotal)
    return JsonResponse({"valid": valid, "reason": reason, "coupon": coupon})


@csrf_exempt
def api_checkout(request):
    body = _json_body(request)
    if not body.get("customerLoggedIn"):
        return JsonResponse({"error": "Cliente precisa estar logado para finalizar a compra."}, status=401)
    db = read_db()
    coupon = None
    coupon_code = body.get("coupon", {}).get("code") if isinstance(body.get("coupon"), dict) else body.get("coupon")
    if coupon_code:
        coupon = next((item for item in db.get("coupons", []) if str(item.get("code", "")).upper() == str(coupon_code).upper()), None)
    shipping_option = body.get("shippingOption") or {}
    lines, subtotal, discount, shipping, total, free_shipping = _cart_totals(db, body.get("items", []), shipping_option, coupon)
    if not lines:
        return JsonResponse({"error": "Carrinho vazio."}, status=400)
    if shipping > 0 and not shipping_option:
        return JsonResponse({"error": "Calcule e selecione uma opcao de entrega antes de finalizar o pedido."}, status=400)
    order = {
        "id": f"PED-{int(datetime.now().timestamp() * 1000)}",
        "createdAt": _now(),
        "updatedAt": _now(),
        "status": "awaiting_payment",
        "customer": body.get("customer", {}),
        "items": lines,
        "subtotal": subtotal,
        "discount": discount,
        "shipping": shipping,
        "total": total,
        "freeShipping": free_shipping,
        "shippingOption": shipping_option or None,
        "payment": {"provider": "mock", "status": "pending", "checkoutUrl": ""},
        "history": [{"id": f"hist-{secrets.token_hex(6)}", "createdAt": _now(), "type": "order", "source": "django", "note": "Pedido criado."}],
    }
    db.setdefault("orders", []).insert(0, order)
    write_db(db)
    return JsonResponse({"order": order, "payment": order["payment"]}, status=201)


@csrf_exempt
def api_customer_access(request):
    body = _json_body(request)
    email = str(body.get("email", "")).strip().lower()
    password = str(body.get("password", ""))
    if not email:
        return JsonResponse({"error": "Informe o email."}, status=400)
    db = read_db()
    customers = db.setdefault("customers", [])
    customer = next((item for item in customers if _customer_email(item) == email), None)
    if body.get("loginOnly"):
        if not customer or (customer.get("passwordHash") and not _verify_password(password, customer.get("passwordHash"))):
            return JsonResponse({"error": "Conta nao encontrada ou senha invalida."}, status=404)
    if not customer:
        customer = _customer_payload({**body, "email": email, "username": body.get("username") or email.split("@")[0]})
        customers.append(customer)
    if password:
        if len(password) < 6:
            return JsonResponse({"error": "A senha precisa ter pelo menos 6 caracteres."}, status=400)
        customer["passwordHash"] = _hash_password(password)
    customer["updatedAt"] = _now()
    write_db(db)
    account = _safe_customer_account(customer)
    return JsonResponse({"account": account, "customer": account})


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
    if request.content_type and "multipart/form-data" in request.content_type:
        body = request.POST
        try:
            customer = json.loads(body.get("customer") or "{}")
        except json.JSONDecodeError:
            customer = {}
        attachment = _save_upload(request.FILES.get("referenceImage"), "custom-requests")
    else:
        body = _json_body(request)
        customer = body.get("customer", {})
        attachment = ""
    email = str(customer.get("email", "")).strip().lower()
    if not email:
        return JsonResponse({"error": "Entre com seu cadastro antes de enviar uma encomenda."}, status=400)
    idea = str(body.get("idea", "")).strip()
    if not idea:
        return JsonResponse({"error": "Descreva sua ideia para pedirmos orcamento."}, status=400)
    item = {
        "id": f"ENC-{int(datetime.now().timestamp() * 1000)}",
        "createdAt": _now(),
        "updatedAt": _now(),
        "status": "new",
        "title": body.get("title") or "Encomenda sob medida",
        "idea": idea,
        "budget": body.get("budget", ""),
        "deadline": body.get("deadline", ""),
        "customer": customer,
        "attachment": attachment or None,
        "messages": [{"id": f"msg-{secrets.token_hex(6)}", "author": "customer", "text": idea, "createdAt": _now()}],
    }
    db.setdefault("customRequests", []).insert(0, item)
    write_db(db)
    return JsonResponse({"request": item}, status=201)


@csrf_exempt
def api_custom_request_messages(request, request_id):
    body = _json_body(request)
    email = str(body.get("email", "")).strip().lower()
    text = str(body.get("text", "")).strip()
    if not text:
        return JsonResponse({"error": "Escreva uma mensagem."}, status=400)
    db = read_db()
    item = next((request_item for request_item in db.get("customRequests", []) if request_item.get("id") == request_id and str(request_item.get("customer", {}).get("email", "")).lower() == email), None)
    if not item:
        return JsonResponse({"error": "Encomenda nao encontrada."}, status=404)
    item.setdefault("messages", []).append({"id": f"msg-{secrets.token_hex(6)}", "author": "customer", "text": text, "createdAt": _now()})
    item["updatedAt"] = _now()
    write_db(db)
    return JsonResponse({"request": item})


def api_admin_dashboard(request):
    error = _require_admin(request)
    if error:
        return error
    db = read_db()
    revenue = round(sum(float(order.get("total") or 0) for order in db.get("orders", [])), 2)
    customers = [_safe_customer_account(customer) for customer in db.get("customers", [])]
    return JsonResponse({
        "settings": db.get("settings", {}),
        "stats": {
            "products": len(db.get("products", [])),
            "orders": len(db.get("orders", [])),
            "revenue": revenue,
        },
        "products": db.get("products", []),
        "stories": db.get("stories", []),
        "orders": db.get("orders", []),
        "coupons": db.get("coupons", []),
        "customRequests": db.get("customRequests", []),
        "customers": customers,
        "affiliates": db.get("affiliates", []),
        "sellers": db.get("sellers", []),
    })


@csrf_exempt
def api_admin_settings(request):
    error = _require_admin(request)
    if error:
        return error
    body = _json_body(request)
    db = read_db()
    settings = db.setdefault("settings", {})
    promotions = {**settings.get("promotions", {})}
    if "freeShippingMinItems" in body:
        promotions["freeShippingMinItems"] = max(1, int(float(body.get("freeShippingMinItems") or promotions.get("freeShippingMinItems") or 3)))
    settings.update({
        "theme": body.get("theme") or settings.get("theme") or "atelier",
        "originZipCode": re.sub(r"\D", "", str(body.get("originZipCode", settings.get("originZipCode", "")))),
        "shippingFlatRate": max(0, float(body.get("shippingFlatRate", settings.get("shippingFlatRate", 0)) or 0)),
        "shippingProvider": body.get("shippingProvider") or settings.get("shippingProvider") or "melhor-envio",
        "displaySalesCount": bool(body.get("displaySalesCount", settings.get("displaySalesCount", False))),
        "displayFavoriteCount": bool(body.get("displayFavoriteCount", settings.get("displayFavoriteCount", False))),
        "displayRating": bool(body.get("displayRating", settings.get("displayRating", False))),
        "promotions": promotions,
        "sender": {
            **settings.get("sender", {}),
            "name": body.get("senderName", settings.get("sender", {}).get("name", "")),
            "email": body.get("senderEmail", settings.get("sender", {}).get("email", "")),
            "phone": re.sub(r"\D", "", str(body.get("senderPhone", settings.get("sender", {}).get("phone", "")))),
            "document": re.sub(r"\D", "", str(body.get("senderDocument", settings.get("sender", {}).get("document", "")))),
            "companyDocument": re.sub(r"\D", "", str(body.get("senderCompanyDocument", settings.get("sender", {}).get("companyDocument", "")))),
            "zipCode": re.sub(r"\D", "", str(body.get("senderZipCode", settings.get("sender", {}).get("zipCode", "")))),
            "address": body.get("senderAddress", settings.get("sender", {}).get("address", "")),
            "number": body.get("senderNumber", settings.get("sender", {}).get("number", "")),
            "complement": body.get("senderComplement", settings.get("sender", {}).get("complement", "")),
            "neighborhood": body.get("senderNeighborhood", settings.get("sender", {}).get("neighborhood", "")),
            "city": body.get("senderCity", settings.get("sender", {}).get("city", "")),
            "state": str(body.get("senderState", settings.get("sender", {}).get("state", ""))).upper()[:2],
        },
    })
    write_db(db)
    return JsonResponse({"settings": settings})


@csrf_exempt
def api_admin_hero_slides(request):
    error = _require_admin(request)
    if error:
        return error
    db = read_db()
    image_url = _save_upload(request.FILES.get("image"), "hero")
    if not image_url:
        return JsonResponse({"error": "Selecione uma imagem."}, status=400)
    slide = {"id": f"hero-{secrets.token_hex(6)}", "title": request.POST.get("title") or "Imagem inicial", "imageUrl": image_url, "createdAt": _now()}
    db.setdefault("settings", {}).setdefault("heroSlides", []).append(slide)
    write_db(db)
    return JsonResponse({"slide": slide, "settings": db["settings"]}, status=201)


@csrf_exempt
def api_admin_hero_slide_detail(request, slide_id):
    error = _require_admin(request)
    if error:
        return error
    db = read_db()
    slides = db.setdefault("settings", {}).setdefault("heroSlides", [])
    index = next((idx for idx, slide in enumerate(slides) if slide.get("id") == slide_id), -1)
    if index < 0:
        return JsonResponse({"error": "Imagem nao encontrada."}, status=404)
    slide = slides.pop(index)
    write_db(db)
    return JsonResponse({"slide": slide, "settings": db["settings"]})


@csrf_exempt
def api_admin_coupons(request):
    error = _require_admin(request)
    if error:
        return error
    body = _json_body(request)
    code = re.sub(r"[^A-Z0-9_-]", "", str(body.get("code", "")).strip().upper())
    if not code:
        return JsonResponse({"error": "Informe um codigo valido."}, status=400)
    db = read_db()
    coupons = db.setdefault("coupons", [])
    if any(str(coupon.get("code", "")).upper() == code for coupon in coupons):
        return JsonResponse({"error": "Ja existe um cupom com esse codigo."}, status=409)
    coupon = {
        "id": f"cup-{secrets.token_hex(6)}",
        "code": code,
        "type": body.get("type", "free_shipping"),
        "value": float(body.get("value") or 0),
        "minItems": int(float(body.get("minItems") or 1)),
        "minSubtotal": float(body.get("minSubtotal") or 0),
        "expiresAt": body.get("expiresAt", ""),
        "active": True,
        "createdAt": _now(),
    }
    coupons.insert(0, coupon)
    write_db(db)
    return JsonResponse({"coupon": coupon, "coupons": coupons}, status=201)


def _story_payload(post, existing=None, media_url=""):
    existing = existing or {}
    return {
        **existing,
        "id": existing.get("id") or f"story-{secrets.token_hex(6)}",
        "createdAt": existing.get("createdAt") or _now(),
        "title": str(post.get("title") or existing.get("title") or "Bastidor Basa").strip(),
        "caption": str(post.get("caption") or existing.get("caption") or "").strip(),
        "productId": post.get("productId", existing.get("productId", "")),
        "active": post.get("active", "true") != "false",
        "mediaType": "video" if (media_url or existing.get("mediaUrl", "")).lower().endswith((".mp4", ".webm", ".mov")) else "image",
        "mediaUrl": media_url or existing.get("mediaUrl", ""),
        "updatedAt": _now(),
    }


@csrf_exempt
def api_admin_stories(request):
    error = _require_admin(request)
    if error:
        return error
    db = read_db()
    media_url = _save_upload(request.FILES.get("media"), "stories")
    if not media_url:
        return JsonResponse({"error": "Selecione uma foto ou video."}, status=400)
    story = _story_payload(request.POST, media_url=media_url)
    db.setdefault("stories", []).insert(0, story)
    write_db(db)
    return JsonResponse({"story": story, "stories": db["stories"]}, status=201)


@csrf_exempt
def api_admin_story_detail(request, story_id):
    error = _require_admin(request)
    if error:
        return error
    db = read_db()
    stories = db.setdefault("stories", [])
    index = next((idx for idx, story in enumerate(stories) if story.get("id") == story_id), -1)
    if index < 0:
        return JsonResponse({"error": "Story nao encontrado."}, status=404)
    if request.method == "DELETE":
        story = stories.pop(index)
        write_db(db)
        return JsonResponse({"story": story, "stories": stories})
    media_url = _save_upload(request.FILES.get("media"), "stories")
    stories[index] = _story_payload(request.POST, stories[index], media_url)
    write_db(db)
    return JsonResponse({"story": stories[index], "stories": stories})


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


def _save_person(collection_name, body, item_id=None, kind="customer"):
    db = read_db()
    collection = db.setdefault(collection_name, [])
    index = next((idx for idx, item in enumerate(collection) if item.get("id") == item_id), -1) if item_id else -1
    existing = collection[index] if index >= 0 else {}
    try:
        item = _customer_payload(body, existing) if kind == "customer" else _partner_payload(body, existing, kind)
    except ValueError as error:
        return None, JsonResponse({"error": str(error)}, status=400)
    if kind == "customer":
        duplicate = next((candidate for candidate in collection if candidate.get("id") != item.get("id") and (_customer_email(candidate) == _customer_email(item) or _customer_username(candidate) == _customer_username(item))), None)
        if duplicate:
            return None, JsonResponse({"error": "Cliente ou nome de usuario ja cadastrado."}, status=409)
    if index >= 0:
        collection[index] = item
    else:
        collection.insert(0, item)
    write_db(db)
    return db, None


@csrf_exempt
def api_admin_customers(request):
    error = _require_admin(request)
    if error:
        return error
    db, response = _save_person("customers", _json_body(request), kind="customer")
    if response:
        return response
    customers = [_safe_customer_account(item) for item in db.get("customers", [])]
    return JsonResponse({"customer": customers[0] if customers else None, "customers": customers}, status=201)


@csrf_exempt
def api_admin_customer_detail(request, customer_id):
    error = _require_admin(request)
    if error:
        return error
    db = read_db()
    customers = db.setdefault("customers", [])
    index = next((idx for idx, item in enumerate(customers) if item.get("id") == customer_id), -1)
    if index < 0:
        return JsonResponse({"error": "Cliente nao encontrado."}, status=404)
    if request.method == "DELETE":
        account = customers.pop(index)
        write_db(db)
        return JsonResponse({"customer": _safe_customer_account(account), "customers": [_safe_customer_account(item) for item in customers]})
    db, response = _save_person("customers", _json_body(request), customer_id, "customer")
    if response:
        return response
    customers = [_safe_customer_account(item) for item in db.get("customers", [])]
    customer = next((item for item in customers if item.get("id") == customer_id), None)
    return JsonResponse({"customer": customer, "customers": customers})


@csrf_exempt
def api_admin_affiliates(request):
    error = _require_admin(request)
    if error:
        return error
    db, response = _save_person("affiliates", _json_body(request), kind="affiliate")
    if response:
        return response
    return JsonResponse({"affiliate": db.get("affiliates", [None])[0], "affiliates": db.get("affiliates", [])}, status=201)


@csrf_exempt
def api_admin_affiliate_detail(request, affiliate_id):
    return _partner_detail(request, "affiliates", affiliate_id, "affiliate", "Afiliado nao encontrado.")


@csrf_exempt
def api_admin_sellers(request):
    error = _require_admin(request)
    if error:
        return error
    db, response = _save_person("sellers", _json_body(request), kind="seller")
    if response:
        return response
    return JsonResponse({"seller": db.get("sellers", [None])[0], "sellers": db.get("sellers", [])}, status=201)


@csrf_exempt
def api_admin_seller_detail(request, seller_id):
    return _partner_detail(request, "sellers", seller_id, "seller", "Vendedor nao encontrado.")


def _partner_detail(request, collection_name, item_id, kind, missing_message):
    error = _require_admin(request)
    if error:
        return error
    db = read_db()
    collection = db.setdefault(collection_name, [])
    index = next((idx for idx, item in enumerate(collection) if item.get("id") == item_id), -1)
    if index < 0:
        return JsonResponse({"error": missing_message}, status=404)
    if request.method == "DELETE":
        item = collection.pop(index)
        write_db(db)
        return JsonResponse({kind: item, collection_name: collection})
    db, response = _save_person(collection_name, _json_body(request), item_id, kind)
    if response:
        return response
    item = next((candidate for candidate in db.get(collection_name, []) if candidate.get("id") == item_id), None)
    return JsonResponse({kind: item, collection_name: db.get(collection_name, [])})


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


@csrf_exempt
def api_admin_product_campaign(request, product_id):
    error = _require_admin(request)
    if error:
        return error
    db = read_db()
    product = next((item for item in db.get("products", []) if item.get("id") == product_id), None)
    if not product:
        return JsonResponse({"error": "Produto nao encontrado."}, status=404)
    body = _json_body(request)
    product["campaign"] = None if body.get("clear") else _campaign_payload(body)
    write_db(db)
    return JsonResponse({"product": product, "products": db.get("products", [])})


@csrf_exempt
def api_admin_order_detail(request, order_id):
    error = _require_admin(request)
    if error:
        return error
    body = _json_body(request)
    db = read_db()
    order = next((item for item in db.get("orders", []) if item.get("id") == order_id), None)
    if not order:
        return JsonResponse({"error": "Pedido nao encontrado."}, status=404)
    next_status = body.get("status") or order.get("status")
    if next_status != order.get("status"):
        order.setdefault("history", []).append({
            "id": f"hist-{secrets.token_hex(6)}",
            "createdAt": _now(),
            "type": "status",
            "source": "admin",
            "from": order.get("status"),
            "to": next_status,
            "note": body.get("note", ""),
        })
        order["status"] = next_status
    order["updatedAt"] = _now()
    write_db(db)
    return JsonResponse({"order": order})


@csrf_exempt
def api_admin_custom_request_detail(request, request_id):
    error = _require_admin(request)
    if error:
        return error
    body = _json_body(request)
    db = read_db()
    item = next((request_item for request_item in db.get("customRequests", []) if request_item.get("id") == request_id), None)
    if not item:
        return JsonResponse({"error": "Encomenda nao encontrada."}, status=404)
    item["status"] = _request_status(body.get("status") or item.get("status"))
    item["updatedAt"] = _now()
    message = str(body.get("message", "")).strip()
    if message:
        item.setdefault("messages", []).append({"id": f"msg-{secrets.token_hex(6)}", "author": "admin", "text": message, "createdAt": _now()})
    write_db(db)
    return JsonResponse({"request": item, "customRequests": db.get("customRequests", [])})
