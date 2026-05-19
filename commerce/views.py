import hashlib
import hmac
import json
import mimetypes
import os
import re
import secrets
import threading
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from django.conf import settings
from django.core.signing import BadSignature, TimestampSigner
from django.core.mail import send_mail
from django.http import FileResponse, Http404, HttpResponse, JsonResponse
from django.views.decorators.csrf import csrf_exempt

from .store import BASE_DIR, read_db, read_upload, save_upload, write_db

PUBLIC_DIR = BASE_DIR / "public"
ADMIN_USER = os.environ.get("ADMIN_USER", "admin@basa3d.com")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "admin")
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
OPENAI_INSIGHTS_MODEL = os.environ.get("OPENAI_INSIGHTS_MODEL", "gpt-4.1-mini")
SESSION_SECRET = os.environ.get("SESSION_SECRET") or os.environ.get("DJANGO_SECRET_KEY") or "dev-secret"
SHIPPING_PROVIDER = "melhor-envio"
FREE_SHIPPING_MIN_SUBTOTAL = 100.0
PAYMENT_PROVIDER = os.environ.get("PAYMENT_PROVIDER", "mock").strip().lower()
MERCADO_PAGO_ACCESS_TOKEN = os.environ.get("MERCADO_PAGO_ACCESS_TOKEN", "").strip()
MERCADO_PAGO_WEBHOOK_SECRET = os.environ.get("MERCADO_PAGO_WEBHOOK_SECRET", "").strip()
MERCADO_PAGO_MIN_ORDER_TOTAL = max(0.0, float(os.environ.get("MERCADO_PAGO_MIN_ORDER_TOTAL", "0") or 0))
MERCADO_PAGO_USE_SANDBOX = os.environ.get("MERCADO_PAGO_USE_SANDBOX", "").strip().lower()
PAYMENT_PENDING_TTL_HOURS = max(1.0, float(os.environ.get("PAYMENT_PENDING_TTL_HOURS", "48") or 48))
GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "").strip()
GOOGLE_CLIENT_SECRET = os.environ.get("GOOGLE_CLIENT_SECRET", "").strip()
MELHOR_ENVIO_TOKEN = os.environ.get("MELHOR_ENVIO_TOKEN", "")
MELHOR_ENVIO_API_BASE = os.environ.get("MELHOR_ENVIO_API_BASE", "https://melhorenvio.com.br")
MELHOR_ENVIO_USER_AGENT = os.environ.get("MELHOR_ENVIO_USER_AGENT", "Basa 3D Works (contato@basa3d.com)")
CHAT_INACTIVE_CLOSE_HOURS = max(1.0, float(os.environ.get("CHAT_INACTIVE_CLOSE_HOURS", "24") or 24))
PROFILE_NAME_COOLDOWN_DAYS = 30
PROFILE_NAME_RE = re.compile(r"^[a-z0-9._]{1,15}$")
LOCAL_TZ = ZoneInfo(os.environ.get("TIME_ZONE", "America/Sao_Paulo"))
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


def _number_or_zero(value):
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def _bool_value(value):
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value == 1
    return str(value or "").strip().lower() in {"true", "1", "on", "yes", "sim"}


def _digits(value):
    return re.sub(r"\D", "", str(value or ""))


def _money(value):
    return round(float(value or 0), 2)


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


def _token_hash(token):
    return hashlib.sha256(token.encode()).hexdigest()


def _public_base_url(request):
    return os.environ.get("PUBLIC_BASE_URL") or f"{request.scheme}://{request.get_host()}"


def _parse_dt(value):
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None


def _aware_dt(value):
    parsed = _parse_dt(value)
    if not parsed:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=LOCAL_TZ).astimezone(timezone.utc)
    return parsed.astimezone(timezone.utc)


def _campaign_is_running(campaign, now=None):
    campaign = campaign or {}
    if not campaign.get("active"):
        return False
    now = now or datetime.now(timezone.utc)
    starts_at = _aware_dt(campaign.get("startsAt"))
    ends_at = _aware_dt(campaign.get("endsAt"))
    if starts_at and now < starts_at:
        return False
    if ends_at and now > ends_at:
        return False
    return True


def _campaign_discount_percent(product, now=None):
    campaign = (product or {}).get("campaign") or {}
    if not _campaign_is_running(campaign, now):
        return 0.0
    return max(0.0, min(95.0, _number_or_zero(campaign.get("discountPercent"))))


def _campaign_pricing(product, now=None):
    product = product or {}
    base_price = _money(product.get("price"))
    discount = _campaign_discount_percent(product, now)
    if not discount:
        return {
            "price": base_price,
            "compareAtPrice": _money(product.get("compareAtPrice")),
            "campaignDiscountPercent": 0.0,
        }
    return {
        "price": _money(base_price * (1 - discount / 100)),
        "compareAtPrice": base_price,
        "campaignDiscountPercent": discount,
    }


def _send_email_sync(subject, message, recipient):
    if not recipient:
        return False
    try:
        send_mail(subject, message, settings.DEFAULT_FROM_EMAIL, [recipient], fail_silently=False)
        return True
    except Exception:
        return False


def _send_email(subject, message, recipient):
    if not recipient:
        return False
    if getattr(settings, "EMAIL_SEND_ASYNC", True):
        thread = threading.Thread(target=_send_email_sync, args=(subject, message, recipient), daemon=True)
        thread.start()
        return True
    return _send_email_sync(subject, message, recipient)


def _order_items_text(order):
    return "\n".join(
        f"- {item.get('quantity')}x {item.get('name')} - R$ {float(item.get('total') or 0):.2f}".replace(".", ",")
        for item in order.get("items", [])
    )


def _send_order_email(order, subject, intro, include_payment=True):
    customer = order.get("customer") or {}
    payment_url = _order_payment_url(order)
    lines = [
        f"Ola, {customer.get('name') or 'cliente'}.",
        "",
        intro,
        "",
        f"Pedido: {order.get('id')}",
        f"Status: {order.get('status')}",
        f"Total: R$ {float(order.get('total') or 0):.2f}".replace(".", ","),
        "",
        "Itens:",
        _order_items_text(order) or "- Itens do pedido",
    ]
    if include_payment and payment_url:
        lines.extend(["", "Para concluir o pagamento, acesse:", payment_url])
    if order.get("payment", {}).get("expiresAt"):
        lines.extend(["", f"Link valido ate: {order['payment']['expiresAt']}"])
    lines.extend(["", "Basa 3D Works"])
    return _send_email(subject, "\n".join(lines), customer.get("email"))


def _notify_admin_order(order, subject, intro):
    recipient = os.environ.get("ADMIN_NOTIFY_EMAIL") or os.environ.get("EMAIL_HOST_USER") or os.environ.get("SMTP_USER")
    customer = order.get("customer") or {}
    lines = [
        intro,
        "",
        f"Pedido: {order.get('id')}",
        f"Cliente: {customer.get('name')} <{customer.get('email')}>",
        f"Status: {order.get('status')}",
        f"Total: R$ {float(order.get('total') or 0):.2f}".replace(".", ","),
        "",
        "Itens:",
        _order_items_text(order),
    ]
    return _send_email(subject, "\n".join(lines), recipient)


def _issue_email_verification(account, request):
    token = secrets.token_urlsafe(32)
    account["emailVerified"] = bool(account.get("emailVerified", False))
    account["emailVerification"] = {
        "tokenHash": _token_hash(token),
        "sentAt": _now(),
        "expiresAt": (datetime.now(timezone.utc) + timedelta(hours=24)).isoformat(),
    }
    link = f"{_public_base_url(request)}/verificar-email.html?token={token}"
    email = _customer_email(account)
    name = account.get("customer", {}).get("name") or account.get("username") or "cliente"
    _send_email(
        "Confirme seu cadastro na Basa 3D Works",
        f"Olá, {name}.\n\nConfirme seu e-mail para ativar sua conta na Basa 3D Works:\n{link}\n\nEsse link vence em 24 horas.",
        email,
    )
    return link


def _issue_password_reset(account, request):
    token = secrets.token_urlsafe(32)
    account["passwordReset"] = {
        "tokenHash": _token_hash(token),
        "sentAt": _now(),
        "expiresAt": (datetime.now(timezone.utc) + timedelta(hours=2)).isoformat(),
    }
    link = f"{_public_base_url(request)}/redefinir-senha.html?token={token}"
    email = _customer_email(account)
    name = account.get("customer", {}).get("name") or account.get("username") or "cliente"
    _send_email(
        "Redefina sua senha da Basa 3D Works",
        f"Olá, {name}.\n\nUse o link abaixo para redefinir sua senha:\n{link}\n\nEsse link vence em 2 horas.",
        email,
    )
    return link


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


def _google_oauth_redirect_uri(request):
    return f"{_public_base_url(request).rstrip()}/api/customer/google/callback"


def _google_oauth_enabled():
    return bool(GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET)


def _google_state(next_url):
    return signer.sign(json.dumps({
        "next": next_url if str(next_url or "").startswith("/") else "/conta.html",
        "nonce": secrets.token_urlsafe(12),
        "createdAt": _now(),
    }))


def _google_state_payload(value):
    try:
        raw = signer.unsign(value, max_age=60 * 10)
        return json.loads(raw)
    except Exception:
        return {"next": "/conta.html"}


def _google_token(code, request):
    payload = urllib.parse.urlencode({
        "code": code,
        "client_id": GOOGLE_CLIENT_ID,
        "client_secret": GOOGLE_CLIENT_SECRET,
        "redirect_uri": _google_oauth_redirect_uri(request),
        "grant_type": "authorization_code",
    }).encode("utf-8")
    api_request = urllib.request.Request(
        "https://oauth2.googleapis.com/token",
        data=payload,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    with urllib.request.urlopen(api_request, timeout=18) as response:
        return json.loads(response.read().decode("utf-8"))


def _google_userinfo(access_token):
    api_request = urllib.request.Request(
        "https://www.googleapis.com/oauth2/v3/userinfo",
        headers={"Authorization": f"Bearer {access_token}"},
        method="GET",
    )
    with urllib.request.urlopen(api_request, timeout=18) as response:
        return json.loads(response.read().decode("utf-8"))


def _upsert_google_customer(profile):
    email = str(profile.get("email", "")).strip().lower()
    if not email:
        raise ValueError("Google nao retornou e-mail.")
    suggested_profile_name = _profile_name_suggestion(email.split("@")[0], profile.get("name"), "cliente")
    db = read_db()
    customers = db.setdefault("customers", [])
    customer = next((item for item in customers if _customer_email(item) == email), None)
    if not customer:
        customer = _customer_payload({
            "email": email,
            "name": profile.get("name") or email.split("@")[0],
            "username": email.split("@")[0],
            "displayName": suggested_profile_name,
        })
        customers.append(customer)
    current = customer.setdefault("customer", {})
    current["email"] = email
    current["name"] = current.get("name") or profile.get("name") or email.split("@")[0]
    current["displayName"] = current.get("displayName") or suggested_profile_name
    current["avatarUrl"] = current.get("avatarUrl") or profile.get("picture", "")
    current["profileVerified"] = bool(current.get("profileVerified", False))
    customer["username"] = customer.get("username") or email.split("@")[0]
    customer["emailVerified"] = bool(profile.get("email_verified", True))
    customer["google"] = {
        "sub": profile.get("sub"),
        "picture": profile.get("picture", ""),
        "linkedAt": customer.get("google", {}).get("linkedAt") or _now(),
        "updatedAt": _now(),
    }
    customer["updatedAt"] = _now()
    write_db(db)
    return _safe_customer_account(customer)


def _public_product(product, db):
    orders = db.get("orders", [])
    order_sold = sum(
        int(item.get("quantity") or 0)
        for order in orders
        if order.get("status") in {"paid", "in_production", "shipped", "completed"}
        for item in order.get("items", [])
        if item.get("productId") == product.get("id")
    )
    public_reviews = [
        review for review in product.get("reviews", [])
        if review.get("approved", True) is not False
    ]
    rated_reviews = [review for review in public_reviews if _number_or_zero(review.get("rating")) > 0]
    social_sold = sum(int(float(review.get("soldUnits") or 0)) for review in public_reviews)
    rating_average = (
        round(sum(_number_or_zero(review.get("rating")) for review in rated_reviews) / len(rated_reviews), 1)
        if rated_reviews else 0
    )
    favorite_count = int(product.get("favoriteCount") or 0) + sum(
        1 for customer in db.get("customers", []) if product.get("id") in customer.get("favorites", [])
    )
    pricing = _campaign_pricing(product)
    payload = dict(product)
    payload.update(
        {
            "price": pricing["price"],
            "soldCount": int(float(product.get("soldCount") or 0)) + order_sold + social_sold,
            "favoriteCount": favorite_count,
            "gallery": product.get("gallery") or [product.get("image")],
            "regularPrice": _money(product.get("price")),
            "compareAtPrice": pricing["compareAtPrice"],
            "campaignDiscountPercent": pricing["campaignDiscountPercent"],
            "rating": {"average": rating_average, "count": len(rated_reviews)},
            "publicReviews": [
                {
                    "id": review.get("id"),
                    "customerName": review.get("customerName", "Cliente Basa"),
                    "customerAvatar": review.get("customerAvatar", ""),
                    "profileVerified": bool(review.get("profileVerified", False)),
                    "rating": _number_or_zero(review.get("rating")),
                    "comment": review.get("comment", ""),
                    "photos": review.get("photos", []),
                    "media": review.get("media") or review.get("photos", []),
                    "createdAt": review.get("createdAt"),
                }
                for review in public_reviews
                if review.get("comment") or review.get("photos") or review.get("media") or _number_or_zero(review.get("rating")) > 0
            ],
        }
    )
    return payload


def _safe_customer_account(account):
    if "customer" in account:
        customer = dict(account.get("customer", {}))
        customer.setdefault("displayName", customer.get("name", ""))
        customer.setdefault("avatarUrl", "")
        customer["profileVerified"] = bool(customer.get("profileVerified", False))
        customer["profileNameChangedAt"] = customer.get("profileNameChangedAt", "")
        return {
            "id": account.get("id"),
            "username": account.get("username"),
            "customer": customer,
            "status": account.get("status", "active"),
            "emailVerified": bool(account.get("emailVerified", False)),
            "notes": account.get("notes", ""),
            "createdAt": account.get("createdAt"),
            "updatedAt": account.get("updatedAt"),
        }
    return {
        "id": account.get("id"),
        "username": account.get("username") or str(account.get("email", "")).split("@")[0],
        "customer": {
            "name": account.get("name", ""),
            "displayName": account.get("displayName", account.get("name", "")),
            "avatarUrl": account.get("avatarUrl", ""),
            "profileVerified": bool(account.get("profileVerified", False)),
            "profileNameChangedAt": account.get("profileNameChangedAt", ""),
            "email": account.get("email", ""),
            "phone": account.get("phone", ""),
            "document": account.get("document", ""),
            **account.get("address", {}),
        },
        "status": account.get("status", "active"),
        "emailVerified": bool(account.get("emailVerified", False)),
        "notes": account.get("notes", ""),
        "createdAt": account.get("createdAt"),
        "updatedAt": account.get("updatedAt"),
    }


def _customer_email(account):
    return str(account.get("customer", {}).get("email") or account.get("email") or "").strip().lower()


def _customer_username(account):
    return str(account.get("username") or account.get("customerUsername") or _customer_email(account).split("@")[0]).strip().lower()


def _profile_display_name(value):
    name = str(value or "").strip().lstrip("@").lower()
    if not name:
        raise ValueError("Informe o nome do perfil.")
    if not PROFILE_NAME_RE.fullmatch(name):
        raise ValueError("Use ate 15 caracteres, sem espacos. Permitidos: letras, numeros, ponto e underline.")
    return name


def _profile_name_suggestion(*values):
    for value in values:
        name = re.sub(r"[^a-z0-9._]", "", str(value or "").strip().lstrip("@").lower())[:15]
        if name and PROFILE_NAME_RE.fullmatch(name):
            return name
    return f"cliente{secrets.token_hex(3)}"[:15]


def _sync_customer_public_reviews(db, account):
    email = _customer_email(account)
    if not email:
        return
    public_customer = account.get("customer", {})
    for product in db.get("products", []):
        for review in product.get("reviews", []):
            if str(review.get("customerEmail", "")).strip().lower() != email:
                continue
            review["customerName"] = public_customer.get("displayName") or public_customer.get("name") or "Cliente Basa"
            review["customerAvatar"] = public_customer.get("avatarUrl", "")
            review["profileVerified"] = bool(public_customer.get("profileVerified", False))


def _customer_payload(body, existing=None, allow_profile_verified=False):
    existing = existing or {}
    current = existing.get("customer", {}) if "customer" in existing else existing
    email = str(body.get("email", current.get("email", ""))).strip().lower()
    username = str(body.get("username") or body.get("customerUsername") or existing.get("username") or email.split("@")[0]).strip()
    if not email:
        raise ValueError("Informe o email.")
    display_name = _profile_display_name(body.get("displayName") or body.get("customerUsername") or current.get("displayName") or username)
    profile_verified = bool(current.get("profileVerified", False))
    if allow_profile_verified:
        profile_verified = str(body.get("profileVerified", "")).lower() in {"1", "true", "on", "yes"}
    customer = {
        "name": body.get("name", current.get("name", "")),
        "displayName": display_name,
        "avatarUrl": body.get("avatarUrl", current.get("avatarUrl", "")),
        "profileVerified": profile_verified,
        "profileNameChangedAt": current.get("profileNameChangedAt", ""),
        "email": email,
        "phone": re.sub(r"\D", "", str(body.get("phone", current.get("phone", "")))),
        "document": re.sub(r"\D", "", str(body.get("document", current.get("document", "")))),
        "zipCode": re.sub(r"\D", "", str(body.get("zipCode", current.get("zipCode", "")))),
        "street": body.get("street", current.get("street", "")),
        "number": body.get("number", current.get("number", "")),
        "neighborhood": body.get("neighborhood", current.get("neighborhood", "")),
        "complement": body.get("complement", current.get("complement", "")),
        "city": body.get("city", current.get("city", "")),
        "state": str(body.get("state", current.get("state", ""))).upper()[:2],
        "ibge": re.sub(r"\D", "", str(body.get("ibge", current.get("ibge", "")))),
    }
    account = {
        **existing,
        "id": existing.get("id") or f"cus-{secrets.token_hex(6)}",
        "username": username,
        "customer": customer,
        "status": body.get("status") or existing.get("status") or "active",
        "emailVerified": bool(existing.get("emailVerified", False)),
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


def _product_sku(name, existing=None):
    current = str(existing or "").strip().upper()
    if current:
        return current[:48]
    base = re.sub(r"[^A-Z0-9]+", "-", unicodedata.normalize("NFD", str(name or "BASA")).encode("ascii", "ignore").decode().upper()).strip("-")
    prefix = "-".join(base.split("-")[:3]) or "BASA"
    return f"B3D-{prefix[:18]}-{secrets.token_hex(3).upper()}"


def _product_colors(value, existing=None):
    existing = existing or []
    if value is None:
        value = existing
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            value = parsed
        except json.JSONDecodeError:
            value = _lines(value)
    colors = []
    for item in value or []:
        if isinstance(item, dict):
            name = str(item.get("name") or item.get("label") or "").strip()
            hex_value = str(item.get("hex") or item.get("value") or "#ffffff").strip()
        else:
            raw = str(item or "").strip()
            if "|" in raw:
                name, hex_value = [part.strip() for part in raw.split("|", 1)]
            else:
                name, hex_value = raw, "#ffffff"
        if not name:
            continue
        if not re.match(r"^#[0-9a-fA-F]{6}$", hex_value):
            hex_value = "#ffffff"
        colors.append({"name": name, "hex": hex_value.lower()})
    return colors


def _request_status(value, kind="custom"):
    custom_statuses = {"new", "in_review", "quoted", "approved", "in_production", "shipped", "completed", "canceled"}
    chat_statuses = {"waiting_admin", "answered", "waiting_customer", "closed"}
    if kind == "chat":
        return value if value in chat_statuses else "waiting_admin"
    return value if value in custom_statuses else "new"


def _append_chat_closed_message(item, reason="manual"):
    text = (
        "Conversa encerrada por inatividade. Se precisar de ajuda novamente, envie uma nova mensagem por aqui."
        if reason == "inactive"
        else "Conversa encerrada. Se precisar de ajuda novamente, envie uma nova mensagem por aqui."
    )
    messages = item.setdefault("messages", [])
    if any(message.get("author") == "admin" and message.get("text") == text for message in messages):
        return False
    messages.append({"id": f"msg-{secrets.token_hex(6)}", "author": "admin", "text": text, "createdAt": _now()})
    return True


def _close_inactive_chats(db):
    changed = False
    threshold = datetime.now(timezone.utc) - timedelta(hours=CHAT_INACTIVE_CLOSE_HOURS)
    for item in db.get("customRequests", []):
        kind = item.get("kind") or ("chat" if str(item.get("title", "")).startswith("Atendimento") else "custom")
        if kind != "chat" or item.get("status") == "closed":
            continue
        last_update = _parse_dt(item.get("updatedAt") or item.get("createdAt"))
        if last_update and last_update < threshold:
            item["kind"] = "chat"
            item["status"] = "closed"
            _append_chat_closed_message(item, "inactive")
            item["updatedAt"] = _now()
            changed = True
    return changed


UPLOAD_LIMITS = {
    "image": 6 * 1024 * 1024,
    "video": 45 * 1024 * 1024,
}


def _upload_limit_label(bytes_value):
    return f"{round(bytes_value / 1024 / 1024)} MB"


def _upload_kind(file_obj):
    content_type = str(getattr(file_obj, "content_type", "") or "")
    extension = Path(file_obj.name).suffix.lower()
    if content_type.startswith("video/") or extension in {".mp4", ".webm", ".mov", ".m4v"}:
        return "video"
    return "image"


def _save_upload(file_obj, folder):
    if not file_obj:
        return ""
    kind = _upload_kind(file_obj)
    limit = UPLOAD_LIMITS[kind]
    if getattr(file_obj, "size", 0) > limit:
        raise ValueError(f"{file_obj.name} esta muito pesado. Limite: {_upload_limit_label(limit)} para {'video' if kind == 'video' else 'imagem'}.")
    upload_dir = PUBLIC_DIR / "uploads" / folder
    upload_dir.mkdir(parents=True, exist_ok=True)
    extension = Path(file_obj.name).suffix.lower() or ".bin"
    name = f"{secrets.token_hex(12)}{extension}"
    target = upload_dir / name
    chunks = []
    with target.open("wb") as handle:
        for chunk in file_obj.chunks():
            chunks.append(chunk)
            handle.write(chunk)
    upload_path = f"/uploads/{folder}/{name}"
    save_upload(upload_path, b"".join(chunks), getattr(file_obj, "content_type", "") or mimetypes.guess_type(name)[0] or "application/octet-stream")
    return upload_path


def _social_post_payload(post, existing=None, photos=None, media=None):
    existing = existing or {}
    photos = photos if photos is not None else existing.get("photos", [])
    media = media if media is not None else existing.get("media") or photos
    rating = max(0, min(5, _number_or_zero(post.get("rating", existing.get("rating", 0)))))
    sold_units = max(0, int(float(post.get("soldUnits", existing.get("soldUnits", 0)) or 0)))
    approved_value = post.get("approved", existing.get("approved", True))
    approved = approved_value if isinstance(approved_value, bool) else str(approved_value).lower() not in {"false", "0", "off", "no"}
    customer_name = str(post.get("customerName", existing.get("customerName", "Cliente Basa"))).strip() or "Cliente Basa"
    return {
        **existing,
        "id": existing.get("id") or f"rev-{secrets.token_hex(6)}",
        "createdAt": existing.get("createdAt") or _now(),
        "updatedAt": _now(),
        "customerName": customer_name,
        "rating": rating,
        "soldUnits": sold_units,
        "comment": str(post.get("comment", existing.get("comment", ""))).strip(),
        "photos": photos,
        "media": media,
        "approved": approved,
    }


def _product_post_payload(request, existing=None):
    body = request.POST.dict() if request.content_type and "multipart/form-data" in request.content_type else _json_body(request)
    existing = existing or {}
    image_url = _save_upload(request.FILES.get("imageFile"), "products") if hasattr(request, "FILES") else ""
    video_url = _save_upload(request.FILES.get("videoFile"), "products") if hasattr(request, "FILES") else ""
    gallery_uploads = []
    if hasattr(request, "FILES"):
        gallery_uploads = [_save_upload(file_obj, "products") for file_obj in request.FILES.getlist("galleryFiles")]
    if image_url:
        body["image"] = image_url
    elif existing.get("image"):
        body["image"] = existing.get("image")
    if video_url:
        body["videoUrl"] = video_url
    elif existing.get("videoUrl"):
        body["videoUrl"] = existing.get("videoUrl")
    if image_url or gallery_uploads:
        gallery = [body.get("image") or existing.get("image", "")]
        gallery.extend([url for url in gallery_uploads if url])
    else:
        gallery = existing.get("gallery") or [body.get("image") or existing.get("image", "")]
    body["gallery"] = [url for url in gallery if url]
    return _product_payload(body, existing)


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


def _production_days_from_product(product):
    candidates = [
        product.get("productionDays"),
        product.get("leadTimeDays"),
        product.get("shipping", {}).get("productionDays"),
    ]
    specs = product.get("specs") or {}
    if isinstance(specs, dict):
        for key, value in specs.items():
            if "prazo" in str(key).lower() or "produc" in str(key).lower():
                candidates.append(value)
    for candidate in candidates:
        if candidate in {None, ""}:
            continue
        numbers = re.findall(r"\d+", str(candidate))
        if numbers:
            return max(0, max(int(number) for number in numbers))
    return int(float(os.environ.get("DEFAULT_PRODUCTION_DAYS", "3") or 3))


def _cart_totals(db, items, shipping_option=None, coupon=None, zip_code=""):
    products = {product.get("id"): product for product in db.get("products", [])}
    lines = []
    subtotal = 0.0
    item_count = 0
    all_items_seller_paid = True
    for item in items:
        product = products.get(item.get("productId"))
        if not product:
            continue
        quantity = max(1, int(float(item.get("quantity") or 1)))
        pricing = _campaign_pricing(product)
        unit_price = pricing["price"]
        total = round(unit_price * quantity, 2)
        item_count += quantity
        subtotal += total
        product_shipping = product.get("shipping", {})
        all_items_seller_paid = all_items_seller_paid and bool(product_shipping.get("sellerPaysShipping"))
        lines.append({
            "productId": product.get("id"),
            "slug": product.get("slug"),
            "name": product.get("name"),
            "image": product.get("image") or (product.get("gallery") or [""])[0],
            "category": product.get("category"),
            "quantity": quantity,
            "unitPrice": unit_price,
            "regularUnitPrice": _money(product.get("price")),
            "campaignDiscountPercent": pricing["campaignDiscountPercent"],
            "total": total,
            "variant": item.get("variant") or {},
            "productionDays": _production_days_from_product(product),
        })
    subtotal = round(subtotal, 2)
    all_items_seller_paid = bool(lines) and all_items_seller_paid
    discount = 0.0
    free_shipping_by_coupon = False
    if coupon:
        eligible, _ = _coupon_eligibility(coupon, item_count, subtotal)
        if eligible:
            if coupon.get("type") == "free_shipping":
                free_shipping_by_coupon = True
            elif coupon.get("type") == "percent":
                discount = round(subtotal * float(coupon.get("value") or 0) / 100, 2)
            else:
                discount = min(subtotal, round(float(coupon.get("value") or 0), 2))
    base_shipping = round(float((shipping_option or {}).get("price") or 0), 2)
    free_shipping_by_subtotal = subtotal >= FREE_SHIPPING_MIN_SUBTOTAL
    free_shipping = free_shipping_by_coupon or free_shipping_by_subtotal or all_items_seller_paid
    shipping = 0.0 if free_shipping else base_shipping
    total = round(max(0, subtotal - discount) + shipping, 2)
    reason = (
        "coupon" if free_shipping_by_coupon else
        "subtotal" if free_shipping_by_subtotal else
        "seller_pays_shipping" if all_items_seller_paid else
        None
    )
    message = "Calcule a entrega para ver o valor do frete."
    if reason == "coupon":
        message = "Frete Gratis liberado por cupom."
    elif reason == "subtotal":
        message = "Frete gratis acima de R$ 100 liberado."
    elif reason == "seller_pays_shipping":
        message = "Frete Gratis liberado."
    shipping_benefit = {
        "zipCode": re.sub(r"\D", "", str(zip_code or "")),
        "baseShipping": base_shipping,
        "shippingCharged": shipping,
        "freeShipping": free_shipping,
        "freeShippingMinSubtotal": FREE_SHIPPING_MIN_SUBTOTAL,
        "reason": reason,
        "itemCount": item_count,
        "subtotal": subtotal,
        "message": message,
    }
    return lines, subtotal, discount, shipping, total, free_shipping, shipping_benefit


def _product_payload(body, existing=None):
    existing = existing or {}
    name = body.get("name") or existing.get("name") or "Produto"
    price = round(float(body.get("price") or existing.get("price") or 0), 2)
    sku = _product_sku(name, body.get("sku") or existing.get("sku"))
    raw_tags = body.get("tags", existing.get("tags", []))
    if isinstance(raw_tags, list):
        tags = [str(tag).strip() for tag in raw_tags if str(tag).strip()]
    else:
        tags = [tag.strip() for tag in re.split(r"[,;\n]+", str(raw_tags or "")) if tag.strip()]
    return {
        **existing,
        "id": existing.get("id") or f"prod-{secrets.token_hex(6)}",
        "createdAt": existing.get("createdAt") or _now(),
        "sku": sku,
        "name": name,
        "slug": body.get("slug") or existing.get("slug") or _slug(name),
        "description": body.get("description", existing.get("description", "")),
        "longDescription": body.get("longDescription") or body.get("description") or existing.get("longDescription", ""),
        "tags": tags,
        "highlights": body.get("highlights") if isinstance(body.get("highlights"), list) else (json.loads(body.get("highlights")) if str(body.get("highlights", "")).strip().startswith("[") else _lines(body.get("highlights", "\n".join(existing.get("highlights", []))))),
        "specs": body.get("specs") if isinstance(body.get("specs"), dict) else (json.loads(body.get("specs")) if str(body.get("specs", "")).strip().startswith("{") else existing.get("specs", {})),
        "variants": {
            "bundleType": "kit" if body.get("bundleType") == "kit" else "single",
            "colors": _product_colors(body.get("colors"), existing.get("variants", {}).get("colors", [])),
            "piecesIncluded": max(1, int(float(body.get("piecesIncluded") or existing.get("variants", {}).get("piecesIncluded") or 1))),
        },
        "videoUrl": body.get("videoUrl", existing.get("videoUrl", "")),
        "gallery": body.get("gallery") if isinstance(body.get("gallery"), list) else existing.get("gallery", [body.get("image") or existing.get("image", "")]),
        "price": price,
        "compareAtPrice": round(float(body.get("compareAtPrice") or existing.get("compareAtPrice") or 0), 2),
        "affiliateCommissionPercent": max(0, min(100, float(body.get("affiliateCommissionPercent") or existing.get("affiliateCommissionPercent") or 0))),
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
            "sellerPaysShipping": _bool_value(body.get("sellerPaysShipping", existing.get("shipping", {}).get("sellerPaysShipping", False))),
            "freeShippingMinQuantity": int(float(body.get("freeShippingMinQuantity") or existing.get("shipping", {}).get("freeShippingMinQuantity") or 0)),
        },
        "campaign": existing.get("campaign"),
    }


def _better_envio_product(line, product):
    shipping = product.get("shipping", {})
    quantity = max(1, int(float(line.get("quantity") or 1)))
    return {
        "id": str(product.get("sku") or product.get("id") or line.get("productId")),
        "width": float(shipping.get("widthCm") or 12),
        "height": float(shipping.get("heightCm") or 8),
        "length": float(shipping.get("lengthCm") or 18),
        "weight": float(shipping.get("weightKg") or 0.3),
        "insurance_value": _money(product.get("price")),
        "quantity": quantity,
    }


def _shipping_text(value):
    normalized = unicodedata.normalize("NFD", str(value or ""))
    ascii_text = "".join(ch for ch in normalized if unicodedata.category(ch) != "Mn")
    return re.sub(r"[^a-z0-9]+", " ", ascii_text.lower()).strip()


def _shipping_quote_brand(quote):
    carrier = _shipping_text(quote.get("carrier"))
    service = _shipping_text(quote.get("service"))
    compact_carrier = carrier.replace(" ", "")
    if (
        ("jt" in compact_carrier or "jet" in compact_carrier or "j t" in carrier)
        and any(term in service for term in {"standard", "standart", "padrao", "expresso"})
    ):
        return {
            "code": "jet-standard",
            "label": "J&T Standard",
            "logo": "/uploads/assets/JET-Express.png",
            "rank": 0,
        }
    if "correios" in carrier and "sedex" in service:
        return {
            "code": "correios-sedex",
            "label": "Correios Sedex",
            "logo": "/uploads/assets/Sedex_logo.png",
            "rank": 1,
        }
    return None


def _normalize_melhor_envio_quotes(data):
    quotes = []
    for item in data if isinstance(data, list) else []:
        if item.get("error") or not item.get("price"):
            continue
        company = item.get("company") or {}
        quote = {
            "id": str(item.get("id") or f"{company.get('name', '')}-{item.get('name', '')}"),
            "provider": SHIPPING_PROVIDER,
            "carrier": company.get("name") or "Melhor Envio",
            "service": item.get("name") or "Entrega",
            "price": _money(item.get("custom_price") or item.get("price")),
            "originalPrice": _money(item.get("price")),
            "deliveryDays": int(float(item.get("custom_delivery_time") or item.get("delivery_time") or 0)),
        }
        brand = _shipping_quote_brand(quote)
        if not brand:
            continue
        quote.update({
            "methodCode": brand["code"],
            "displayName": brand["label"],
            "logo": brand["logo"],
            "_rank": brand["rank"],
        })
        quotes.append(quote)
    return [
        {key: value for key, value in quote.items() if key != "_rank"}
        for quote in sorted(quotes, key=lambda quote: (quote["_rank"], quote["price"]))
    ]


def _quote_melhor_envio(db, lines):
    if not MELHOR_ENVIO_TOKEN:
        raise ValueError("Token do Melhor Envio nao configurado.")
    products_by_id = {product.get("id"): product for product in db.get("products", [])}
    products = [
        _better_envio_product(line, products_by_id.get(line.get("productId"), {}))
        for line in lines
    ]
    payload = {
        "from": {"postal_code": _digits(db.get("settings", {}).get("originZipCode"))},
        "to": {"postal_code": lines[0].get("zipCode")},
        "products": products,
        "options": {
            "receipt": False,
            "own_hand": False,
            "insurance_value": sum(item["insurance_value"] * item["quantity"] for item in products),
            "reverse": False,
            "non_commercial": False,
        },
    }
    request = urllib.request.Request(
        f"{MELHOR_ENVIO_API_BASE.rstrip('/')}/api/v2/me/shipment/calculate",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {MELHOR_ENVIO_TOKEN}",
            "Accept": "application/json",
            "Content-Type": "application/json",
            "User-Agent": MELHOR_ENVIO_USER_AGENT,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=18) as response:
            return _normalize_melhor_envio_quotes(json.loads(response.read().decode("utf-8")))
    except urllib.error.HTTPError as error:
        try:
            data = json.loads(error.read().decode("utf-8"))
        except Exception:
            data = {}
        raise ValueError(data.get("message") or "Nao foi possivel cotar frete no Melhor Envio.") from error


def _order_status_from_payment_status(status):
    status = str(status or "").lower()
    if status in {"approved", "authorized", "paid"}:
        return "paid"
    if status in {"pending", "in_process", "in_mediation"}:
        return "awaiting_payment"
    if status in {"rejected", "cancelled", "canceled", "refunded", "charged_back"}:
        return "canceled"
    return "awaiting_payment"


def _should_use_mercado_pago_sandbox(access_token):
    if MERCADO_PAGO_USE_SANDBOX in {"1", "true", "yes", "sim"}:
        return True
    if MERCADO_PAGO_USE_SANDBOX in {"0", "false", "no", "nao", "não"}:
        return False
    return str(access_token or "").startswith("TEST-")


def _create_mercado_pago_preference(order, request):
    if not MERCADO_PAGO_ACCESS_TOKEN:
        raise ValueError("Configure MERCADO_PAGO_ACCESS_TOKEN na Railway.")
    origin = _public_base_url(request).rstrip("/")
    customer = order.get("customer", {})
    document = _digits(customer.get("document"))
    preference = {
        "external_reference": order.get("id"),
        "statement_descriptor": "BASA 3D WORKS",
        "items": [{
            "id": item.get("productId"),
            "title": item.get("name") or "Produto Basa 3D",
            "quantity": int(item.get("quantity") or 1),
            "unit_price": _money(item.get("unitPrice")),
            "currency_id": order.get("currency") or "BRL",
        } for item in order.get("items", [])],
        "shipments": {
            "cost": _money(order.get("shipping")),
            "mode": "not_specified",
        },
        "payer": {
            "name": customer.get("name", ""),
            "email": customer.get("email", ""),
            "phone": {"number": _digits(customer.get("phone"))},
            "identification": {
                "type": "CNPJ" if len(document) > 11 else "CPF",
                "number": document,
            },
            "address": {
                "zip_code": _digits(customer.get("zipCode")),
                "street_name": customer.get("street", ""),
                "street_number": str(customer.get("number") or ""),
            },
        },
        "back_urls": {
            "success": f"{origin}/obrigado.html?pedido={order.get('id')}&status=approved",
            "pending": f"{origin}/obrigado.html?pedido={order.get('id')}&status=pending",
            "failure": f"{origin}/obrigado.html?pedido={order.get('id')}&status=failure",
        },
        "metadata": {
            "order_id": order.get("id"),
            "shipping_provider": (order.get("shippingOption") or {}).get("provider") or "none",
            "shipping_service": (order.get("shippingOption") or {}).get("service") or "none",
            "free_shipping_reason": (order.get("shippingBenefit") or {}).get("reason") or "none",
        },
        "notification_url": f"{origin}/api/webhooks/mercado-pago?source_news=webhooks",
    }
    request_data = json.dumps(preference).encode("utf-8")
    api_request = urllib.request.Request(
        "https://api.mercadopago.com/checkout/preferences",
        data=request_data,
        headers={
            "Authorization": f"Bearer {MERCADO_PAGO_ACCESS_TOKEN}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(api_request, timeout=20) as response:
            data = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="ignore")
        try:
            payload = json.loads(detail)
        except ValueError:
            payload = {}
        raise ValueError(payload.get("message") or "Nao foi possivel criar o checkout no Mercado Pago.") from error
    use_sandbox = _should_use_mercado_pago_sandbox(MERCADO_PAGO_ACCESS_TOKEN)
    return {
        "provider": "mercado-pago",
        "status": "pending_payment",
        "paymentId": data.get("id"),
        "checkoutUrl": (data.get("sandbox_init_point") if use_sandbox else data.get("init_point")) or data.get("init_point") or data.get("sandbox_init_point") or "",
        "initPoint": data.get("init_point", ""),
        "sandboxInitPoint": data.get("sandbox_init_point", ""),
        "environment": "sandbox" if use_sandbox else "production",
        "preference": {"id": data.get("id")},
        "expiresAt": _payment_expires_at(),
        "updatedAt": _now(),
    }


def _create_payment(order, request):
    if PAYMENT_PROVIDER == "mercado-pago":
        if order.get("total", 0) < MERCADO_PAGO_MIN_ORDER_TOTAL:
            amount = f"{MERCADO_PAGO_MIN_ORDER_TOTAL:.2f}".replace(".", ",")
            raise ValueError(f"Pedido precisa ter pelo menos R$ {amount} para pagamento real no Mercado Pago.")
        return _create_mercado_pago_preference(order, request)
    return {
        "provider": "mock",
        "status": "approved",
        "paymentId": f"mock_{order.get('id')}",
        "checkoutUrl": f"/obrigado.html?pedido={order.get('id')}",
        "updatedAt": _now(),
    }


def _mercado_pago_signature_parts(header):
    parts = {}
    for part in str(header or "").split(","):
        key, _, value = part.partition("=")
        if key and value:
            parts[key.strip()] = value.strip()
    return parts


def _verify_mercado_pago_webhook(request, data_id):
    if not MERCADO_PAGO_WEBHOOK_SECRET:
        return True
    signature = _mercado_pago_signature_parts(request.headers.get("x-signature", ""))
    request_id = request.headers.get("x-request-id", "")
    if not signature.get("ts") or not signature.get("v1") or not request_id:
        return False
    manifest = ""
    if data_id:
        manifest += f"id:{str(data_id).lower()};"
    manifest += f"request-id:{request_id};ts:{signature['ts']};"
    expected = hmac.new(MERCADO_PAGO_WEBHOOK_SECRET.encode(), manifest.encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature["v1"])


def _get_mercado_pago_payment(payment_id):
    if not payment_id or not MERCADO_PAGO_ACCESS_TOKEN:
        return None
    api_request = urllib.request.Request(
        f"https://api.mercadopago.com/v1/payments/{payment_id}",
        headers={"Authorization": f"Bearer {MERCADO_PAGO_ACCESS_TOKEN}"},
        method="GET",
    )
    try:
        with urllib.request.urlopen(api_request, timeout=18) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return None
        raise


def _append_order_history(order, history_type, source, to_status=None, note="", from_status=None):
    order.setdefault("history", []).append({
        "id": f"hist-{secrets.token_hex(6)}",
        "createdAt": _now(),
        "type": history_type,
        "source": source,
        "from": from_status,
        "to": to_status,
        "note": note,
    })


def _payment_expires_at():
    return (datetime.now(timezone.utc) + timedelta(hours=PAYMENT_PENDING_TTL_HOURS)).isoformat()


def _order_payment_url(order):
    payment = order.get("payment") or {}
    return payment.get("checkoutUrl") or payment.get("initPoint") or payment.get("sandboxInitPoint") or ""


def _order_cart_signature(items):
    signature = []
    for item in items or []:
        signature.append((
            str(item.get("productId") or item.get("id") or ""),
            str(item.get("color") or ""),
            json.dumps(item.get("variant") or {}, sort_keys=True, ensure_ascii=True),
            int(item.get("quantity") or 0),
        ))
    return sorted(signature)


def _recent_pending_checkout(db, email, lines, total):
    if not email:
        return None
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=3)
    signature = _order_cart_signature(lines)
    for order in db.get("orders", []):
        if order.get("status") != "awaiting_payment" or not _order_payment_url(order):
            continue
        if str(order.get("customer", {}).get("email", "")).strip().lower() != email:
            continue
        created_at = _parse_dt(order.get("createdAt"))
        if not created_at or created_at < cutoff:
            continue
        if abs(float(order.get("total") or 0) - float(total or 0)) > 0.01:
            continue
        if _order_cart_signature(order.get("items", [])) == signature:
            return order
    return None


def _expire_pending_orders(db):
    changed = False
    now = datetime.now(timezone.utc)
    for order in db.get("orders", []):
        if order.get("status") != "awaiting_payment":
            continue
        payment = order.get("payment") or {}
        expires_at = _parse_dt(payment.get("expiresAt"))
        if not expires_at:
            created_at = _parse_dt(order.get("createdAt")) or now
            expires_at = created_at + timedelta(hours=PAYMENT_PENDING_TTL_HOURS)
            payment["expiresAt"] = expires_at.isoformat()
            order["payment"] = payment
            changed = True
        if not expires_at or expires_at > now:
            continue
        previous_status = order.get("status")
        order["status"] = "canceled"
        order["updatedAt"] = _now()
        payment["status"] = "expired"
        payment["updatedAt"] = _now()
        order["payment"] = payment
        _append_order_history(
            order,
            "payment",
            "system",
            "canceled",
            f"Pedido cancelado automaticamente apos {PAYMENT_PENDING_TTL_HOURS:g} horas sem confirmacao de pagamento.",
            previous_status,
        )
        _send_order_email(order, f"Pedido cancelado - {order['id']}", "O prazo para pagamento expirou e o pedido foi cancelado.", include_payment=False)
        _notify_admin_order(order, f"Pedido expirado {order['id']}", "Um pedido pendente expirou automaticamente.")
        changed = True
    return changed


def _apply_paid_order_stock(db, order, source="system"):
    paid_statuses = {"paid", "in_production", "shipped", "completed"}
    if order.get("status") not in paid_statuses:
        return False
    inventory = order.setdefault("inventory", {})
    if inventory.get("stockAppliedAt"):
        return False
    products = db.setdefault("products", [])
    products_by_id = {product.get("id"): product for product in products}
    movements = []
    for item in order.get("items", []):
        product = products_by_id.get(item.get("productId"))
        quantity = max(0, int(float(item.get("quantity") or 0)))
        if not product or not quantity:
            continue
        before = max(0, int(float(product.get("stock") or 0)))
        after = max(0, before - quantity)
        product["stock"] = after
        product["updatedAt"] = _now()
        movements.append({
            "productId": product.get("id"),
            "name": item.get("name") or product.get("name"),
            "quantity": quantity,
            "before": before,
            "after": after,
        })
    if not movements:
        return False
    inventory.update({
        "stockAppliedAt": _now(),
        "source": source,
        "movements": movements,
    })
    _append_order_history(order, "inventory", source, order.get("status"), "Estoque baixado automaticamente apos confirmacao de pagamento.")
    return True


def _public_order(order):
    payment = order.get("payment") or {}
    return {
        **order,
        "payment": {
            "provider": payment.get("provider"),
            "status": payment.get("status"),
            "method": payment.get("method"),
            "type": payment.get("type"),
            "checkoutUrl": _order_payment_url(order),
            "expiresAt": payment.get("expiresAt"),
            "environment": payment.get("environment"),
        },
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
    request_path = "/" + "/".join(safe_parts)
    if not file_path.exists() or not file_path.is_file():
        if safe_parts and safe_parts[0] == "uploads":
            upload = read_upload(request_path)
            if upload:
                return HttpResponse(upload["content"], content_type=upload["content_type"])
            placeholder = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 800"><rect width="800" height="800" fill="#f7faf7"/><rect x="72" y="72" width="656" height="656" rx="28" fill="#fff" stroke="#dfe8e2" stroke-width="8"/><path d="M210 560h380L478 408l-82 96-54-64-132 120Z" fill="#dfe8e2"/><circle cx="300" cy="292" r="54" fill="#dfe8e2"/><text x="400" y="666" text-anchor="middle" font-family="Arial, sans-serif" font-size="34" font-weight="700" fill="#63716c">Reenvie a imagem</text></svg>"""
            return HttpResponse(placeholder, content_type="image/svg+xml; charset=utf-8")
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


def _fetch_cep_json(url):
    request = urllib.request.Request(url, headers={
        "Accept": "application/json",
        "User-Agent": "Basa3DWorks/1.0",
    })
    with urllib.request.urlopen(request, timeout=8) as response:
        return json.loads(response.read().decode("utf-8"))


def _cep_payload_from_viacep(digits):
    data = _fetch_cep_json(f"https://viacep.com.br/ws/{digits}/json/")
    if data.get("erro"):
        return None
    return {
        "cep": digits,
        "zipCode": digits,
        "street": data.get("logradouro", ""),
        "neighborhood": data.get("bairro", ""),
        "city": data.get("localidade", ""),
        "state": data.get("uf", ""),
        "ibge": data.get("ibge", ""),
    }


def _cep_payload_from_brasilapi(digits):
    data = _fetch_cep_json(f"https://brasilapi.com.br/api/cep/v2/{digits}")
    return {
        "cep": digits,
        "zipCode": re.sub(r"\D", "", str(data.get("cep") or digits)),
        "street": data.get("street", ""),
        "neighborhood": data.get("neighborhood", ""),
        "city": data.get("city", ""),
        "state": data.get("state", ""),
        "ibge": str(data.get("city_ibge") or data.get("ibge") or ""),
    }


def api_cep(request, cep):
    digits = re.sub(r"\D", "", cep)
    if len(digits) != 8:
        return JsonResponse({"error": "CEP invalido."}, status=400)
    errors = []
    for lookup in (_cep_payload_from_viacep, _cep_payload_from_brasilapi):
        try:
            payload = lookup(digits)
            if payload:
                return JsonResponse(payload)
        except urllib.error.HTTPError as error:
            if error.code == 404:
                errors.append("not_found")
            else:
                errors.append(str(error))
        except Exception as error:
            errors.append(str(error))
    if "not_found" in errors:
        return JsonResponse({"error": "CEP nao encontrado."}, status=404)
    return JsonResponse({"error": "Nao foi possivel consultar o CEP."}, status=502)



@csrf_exempt
def api_shipping_quote(request):
    body = _json_body(request)
    db = read_db()
    items = body.get("items", [])
    zip_code = _digits(body.get("zipCode"))
    if len(zip_code) != 8:
        return JsonResponse({"error": "Informe um CEP valido para cotar o frete.", "quotes": []}, status=400)
    lines, subtotal, _discount, _shipping, _total, free_shipping, shipping_benefit = _cart_totals(db, items, None, zip_code=zip_code)
    if not lines:
        return JsonResponse({"quotes": [], "error": "Adicione produtos ao carrinho."}, status=400)
    for line in lines:
        line["zipCode"] = zip_code
    if free_shipping:
        try:
            quotes = _quote_melhor_envio(db, lines)
        except ValueError:
            quotes = []
        if quotes:
            free_quotes = [
                {
                    **quote,
                    "price": 0,
                    "originalPrice": quote.get("price"),
                    "freeShipping": True,
                    "note": "Frete gratis aplicado. Prazo calculado pelo Melhor Envio.",
                }
                for quote in quotes
            ]
            return JsonResponse({"quotes": free_quotes, "subtotal": subtotal, "shippingBenefit": shipping_benefit})
        return JsonResponse({
            "quotes": [{"id": "free-shipping", "provider": "basa", "carrier": "Basa 3D Works", "service": "Frete Grátis", "price": 0, "deliveryDays": 0}],
            "subtotal": subtotal,
            "shippingBenefit": shipping_benefit,
        })
    for line in lines:
        line["zipCode"] = zip_code
    try:
        quotes = _quote_melhor_envio(db, lines)
    except ValueError as error:
        return JsonResponse({"error": str(error), "quotes": [], "subtotal": subtotal, "shippingBenefit": shipping_benefit}, status=400)
    return JsonResponse({"quotes": quotes, "subtotal": subtotal, "shippingBenefit": shipping_benefit})


@csrf_exempt
def api_coupons_validate(request):
    body = _json_body(request)
    db = read_db()
    code = str(body.get("code", "")).strip().upper()
    coupon = next((item for item in db.get("coupons", []) if str(item.get("code", "")).upper() == code), None)
    if not coupon:
        return JsonResponse({"valid": False, "error": "Cupom nao encontrado."}, status=404)
    lines, subtotal, _discount, _shipping, _total, _free_shipping, _shipping_benefit = _cart_totals(db, body.get("items", []))
    item_count = sum(line["quantity"] for line in lines)
    valid, reason = _coupon_eligibility(coupon, item_count, subtotal)
    return JsonResponse({"valid": valid, "reason": reason, "coupon": coupon})


@csrf_exempt
def api_checkout(request):
    body = _json_body(request)
    if not body.get("customerLoggedIn"):
        return JsonResponse({"error": "Cliente precisa estar logado para finalizar a compra."}, status=401)
    db = read_db()
    if _expire_pending_orders(db):
        write_db(db)
    coupon = None
    coupon_code = body.get("coupon", {}).get("code") if isinstance(body.get("coupon"), dict) else body.get("coupon")
    if coupon_code:
        coupon = next((item for item in db.get("coupons", []) if str(item.get("code", "")).upper() == str(coupon_code).upper()), None)
    shipping_option = body.get("shippingOption") or {}
    lines, subtotal, discount, shipping, total, free_shipping, shipping_benefit = _cart_totals(
        db,
        body.get("items", []),
        shipping_option,
        coupon,
        zip_code=body.get("customer", {}).get("zipCode", "") or body.get("zipCode", ""),
    )
    if not lines:
        return JsonResponse({"error": "Carrinho vazio."}, status=400)
    if shipping > 0 and not shipping_option:
        return JsonResponse({"error": "Calcule e selecione uma opcao de entrega antes de finalizar o pedido."}, status=400)
    customer_email = str(body.get("customer", {}).get("email", "")).strip().lower()
    recent_order = _recent_pending_checkout(db, customer_email, lines, total)
    if recent_order:
        public_order = _public_order(recent_order)
        return JsonResponse({"order": public_order, "payment": public_order.get("payment"), "reused": True})
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
        "shippingBenefit": shipping_benefit,
        "shippingOption": shipping_option or None,
        "payment": None,
        "history": [],
    }
    try:
        payment = _create_payment(order, request)
    except ValueError as error:
        return JsonResponse({"error": str(error)}, status=502)
    order["payment"] = payment
    order["status"] = "paid" if payment.get("status") in {"approved", "paid", "authorized"} else "awaiting_payment"
    _append_order_history(order, "order", "django", order["status"], f"Pedido criado. {shipping_benefit.get('message', '')}".strip())
    _append_order_history(
        order,
        "payment",
        payment.get("provider") or PAYMENT_PROVIDER,
        order["status"],
        "Pagamento aprovado na criacao do pedido." if order["status"] == "paid" else "Pedido aguardando confirmacao automatica do pagamento.",
    )
    _apply_paid_order_stock(db, order, payment.get("provider") or PAYMENT_PROVIDER)
    db.setdefault("orders", []).insert(0, order)
    write_db(db)
    if order["status"] == "awaiting_payment":
        _send_order_email(
            order,
            f"Pedido {order['id']} aguardando pagamento",
            "Recebemos seu pedido e ele esta aguardando pagamento.",
        )
    else:
        _send_order_email(
            order,
            f"Pedido {order['id']} confirmado",
            "Recebemos seu pedido e o pagamento ja aparece como confirmado.",
            include_payment=False,
        )
    _notify_admin_order(order, f"Novo pedido {order['id']}", "Um novo pedido entrou na loja.")
    return JsonResponse({"order": order, "payment": order["payment"]}, status=201)


@csrf_exempt
def api_mercado_pago_webhook(request):
    body = _json_body(request)
    body_data = body.get("data") if isinstance(body.get("data"), dict) else {}
    data_id = str(
        request.GET.get("data.id")
        or body_data.get("id")
        or body.get("data.id")
        or body.get("id")
        or ""
    ).strip()
    if not _verify_mercado_pago_webhook(request, request.GET.get("data.id") or data_id):
        return JsonResponse({"received": False, "error": "Assinatura Mercado Pago invalida."}, status=401)
    payment_data = _get_mercado_pago_payment(data_id)
    order_id = str(
        (payment_data or {}).get("external_reference")
        or (payment_data or {}).get("metadata", {}).get("order_id")
        or body.get("external_reference")
        or body.get("orderId")
        or ""
    )
    db = read_db()
    expired_changed = _expire_pending_orders(db)
    order = next((item for item in db.get("orders", []) if item.get("id") == order_id), None)
    if not order:
        if expired_changed:
            write_db(db)
        return JsonResponse({"received": True, "orderUpdated": False})
    previous_status = order.get("status")
    payment_status = (payment_data or {}).get("status") or body.get("status") or order.get("payment", {}).get("status") or "pending"
    order["payment"] = {
        **(order.get("payment") or {}),
        "provider": "mercado-pago",
        "paymentId": data_id or order.get("payment", {}).get("paymentId"),
        "status": payment_status,
        "statusDetail": (payment_data or {}).get("status_detail") or body.get("statusDetail") or "",
        "method": (payment_data or {}).get("payment_method_id") or order.get("payment", {}).get("method") or "",
        "type": (payment_data or {}).get("payment_type_id") or order.get("payment", {}).get("type") or "",
        "updatedAt": _now(),
    }
    next_status = _order_status_from_payment_status(payment_status)
    status_changed = next_status != previous_status
    if next_status != previous_status:
        order["status"] = next_status
    order["updatedAt"] = _now()
    status_detail_note = f" ({order['payment'].get('statusDetail')})" if order["payment"].get("statusDetail") else ""
    _append_order_history(
        order,
        "payment",
        "mercado-pago",
        order.get("status"),
        f"Pagamento Mercado Pago: {order['payment'].get('status')}{status_detail_note}.",
        previous_status,
    )
    _apply_paid_order_stock(db, order, "mercado-pago")
    write_db(db)
    if status_changed and order.get("status") == "paid":
        _send_order_email(order, f"Pagamento confirmado - {order['id']}", "Seu pagamento foi confirmado. Vamos preparar seu pedido.", include_payment=False)
        _notify_admin_order(order, f"Pagamento confirmado {order['id']}", "O Mercado Pago confirmou o pagamento deste pedido.")
    elif status_changed and order.get("status") == "canceled":
        _send_order_email(order, f"Pedido cancelado - {order['id']}", "O pagamento nao foi concluido e o pedido foi cancelado.", include_payment=False)
        _notify_admin_order(order, f"Pedido cancelado {order['id']}", "O Mercado Pago marcou este pedido como cancelado/rejeitado.")
    return JsonResponse({"received": True, "orderUpdated": True, "orderId": order.get("id"), "status": order.get("status")})


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
    created = False
    if body.get("loginOnly"):
        if not customer or (customer.get("passwordHash") and not _verify_password(password, customer.get("passwordHash"))):
            return JsonResponse({"error": "Conta nao encontrada ou senha invalida."}, status=404)
    if not customer:
        customer = _customer_payload({**body, "email": email, "username": body.get("username") or email.split("@")[0]})
        customers.append(customer)
        created = True
    if password:
        if len(password) < 6:
            return JsonResponse({"error": "A senha precisa ter pelo menos 6 caracteres."}, status=400)
        customer["passwordHash"] = _hash_password(password)
    verification_link = ""
    if created and not customer.get("emailVerified"):
        verification_link = _issue_email_verification(customer, request)
    customer["updatedAt"] = _now()
    write_db(db)
    account = _safe_customer_account(customer)
    return JsonResponse({
        "account": account,
        "customer": account,
        "created": created,
        "emailVerificationRequired": not account.get("emailVerified"),
        "verificationPreviewUrl": verification_link if settings.EMAIL_BACKEND.endswith("console.EmailBackend") else "",
    }, status=201 if created else 200)


@csrf_exempt
def api_customer_profile(request):
    if request.method not in {"POST", "PATCH"}:
        return JsonResponse({"error": "Metodo nao permitido."}, status=405)
    body = request.POST if request.content_type and "multipart/form-data" in request.content_type else _json_body(request)
    email = str(body.get("email", "")).strip().lower()
    if not email:
        return JsonResponse({"error": "Informe o email."}, status=400)
    db = read_db()
    account = next((item for item in db.get("customers", []) if _customer_email(item) == email), None)
    if not account:
        return JsonResponse({"error": "Conta nao encontrada."}, status=404)
    customer = account.setdefault("customer", {})
    try:
        display_name = _profile_display_name(body.get("displayName") or customer.get("displayName") or account.get("username") or "")
    except ValueError as error:
        return JsonResponse({"error": str(error)}, status=400)
    try:
        current_display_name = _profile_display_name(customer.get("displayName") or account.get("username") or display_name)
    except ValueError:
        current_display_name = _profile_display_name(account.get("username") or display_name)
    name_changed = display_name != current_display_name
    if name_changed:
        if bool(customer.get("profileVerified", False)):
            return JsonResponse({
                "error": "Perfil verificado nao pode alterar o nome. Fale com o admin para solicitar a troca.",
            }, status=403)
        changed_at = _parse_dt(customer.get("profileNameChangedAt"))
        if changed_at:
            next_allowed = changed_at + timedelta(days=PROFILE_NAME_COOLDOWN_DAYS)
            if next_allowed > datetime.now(timezone.utc):
                return JsonResponse({
                    "error": f"Voce podera trocar o nome novamente em {next_allowed.strftime('%d/%m/%Y')}.",
                    "nextProfileNameChangeAt": next_allowed.isoformat(),
                }, status=429)
        customer["displayName"] = display_name
        customer["profileNameChangedAt"] = _now()
    avatar_file = request.FILES.get("avatar") if hasattr(request, "FILES") else None
    if avatar_file:
        if not str(getattr(avatar_file, "content_type", "")).startswith("image/"):
            return JsonResponse({"error": "Envie uma imagem para a foto de perfil."}, status=400)
        try:
            customer["avatarUrl"] = _save_upload(avatar_file, "customers")
        except ValueError as error:
            return JsonResponse({"error": str(error)}, status=400)
    editable_fields = ["name", "phone", "document", "zipCode", "street", "number", "neighborhood", "complement", "city", "state", "ibge"]
    for field in editable_fields:
        if field not in body:
            continue
        value = body.get(field, "")
        if field in {"phone", "document", "zipCode", "ibge"}:
            value = re.sub(r"\D", "", str(value))
        if field == "state":
            value = str(value).upper()[:2]
        customer[field] = value
    customer["profileVerified"] = bool(customer.get("profileVerified", False))
    account["updatedAt"] = _now()
    _sync_customer_public_reviews(db, account)
    write_db(db)
    return JsonResponse({"account": _safe_customer_account(account)})


def api_customer_google_start(request):
    if not _google_oauth_enabled():
        return JsonResponse({"error": "Login com Google ainda nao configurado."}, status=503)
    next_url = request.GET.get("next") or "/conta.html"
    params = urllib.parse.urlencode({
        "client_id": GOOGLE_CLIENT_ID,
        "redirect_uri": _google_oauth_redirect_uri(request),
        "response_type": "code",
        "scope": "openid email profile",
        "state": _google_state(next_url),
        "access_type": "online",
        "prompt": "select_account",
    })
    return HttpResponse(status=302, headers={"Location": f"https://accounts.google.com/o/oauth2/v2/auth?{params}"})


def api_customer_google_callback(request):
    code = request.GET.get("code", "")
    state_payload = _google_state_payload(request.GET.get("state", ""))
    next_url = state_payload.get("next") or "/conta.html"
    if not code:
        return HttpResponse(status=302, headers={"Location": f"{next_url}?google=error"})
    try:
        token = _google_token(code, request)
        profile = _google_userinfo(token.get("access_token"))
        account = _upsert_google_customer(profile)
    except Exception:
        return HttpResponse(status=302, headers={"Location": f"{next_url}?google=error"})
    session = {
        "loggedIn": True,
        "username": account.get("username"),
        "customer": account.get("customer"),
        "emailVerified": bool(account.get("emailVerified")),
        "provider": "google",
        "updatedAt": _now(),
    }
    target = json.dumps(next_url)
    session_json = json.dumps(session, ensure_ascii=False)
    return HttpResponse(f"""
<!doctype html>
<html lang="pt-BR">
  <head><meta charset="utf-8"><title>Entrando...</title></head>
  <body>
    <script>
      localStorage.setItem("basa_customer_session", {json.dumps(session_json)});
      location.replace({target});
    </script>
  </body>
</html>
""", content_type="text/html; charset=utf-8")


@csrf_exempt
def api_customer_resend_verification(request):
    body = _json_body(request)
    email = str(body.get("email", "")).strip().lower()
    db = read_db()
    account = next((item for item in db.get("customers", []) if _customer_email(item) == email), None)
    if not account:
        return JsonResponse({"ok": True})
    if account.get("emailVerified"):
        return JsonResponse({"ok": True, "alreadyVerified": True})
    verification_link = _issue_email_verification(account, request)
    account["updatedAt"] = _now()
    write_db(db)
    return JsonResponse({
        "ok": True,
        "verificationPreviewUrl": verification_link if settings.EMAIL_BACKEND.endswith("console.EmailBackend") else "",
    })


def api_customer_verify_email(request):
    token = str(request.GET.get("token", "")).strip()
    if not token:
        return JsonResponse({"verified": False, "error": "Token ausente."}, status=400)
    token_hash = _token_hash(token)
    db = read_db()
    account = next((item for item in db.get("customers", []) if item.get("emailVerification", {}).get("tokenHash") == token_hash), None)
    if not account:
        return JsonResponse({"verified": False, "error": "Link invalido ou ja usado."}, status=404)
    expires_at = _parse_dt(account.get("emailVerification", {}).get("expiresAt"))
    if expires_at and expires_at < datetime.now(timezone.utc):
        return JsonResponse({"verified": False, "error": "Link expirado. Solicite um novo e-mail."}, status=400)
    account["emailVerified"] = True
    account["emailVerifiedAt"] = _now()
    account.pop("emailVerification", None)
    account["updatedAt"] = _now()
    write_db(db)
    return JsonResponse({"verified": True, "account": _safe_customer_account(account)})


@csrf_exempt
def api_customer_password_reset_request(request):
    body = _json_body(request)
    email = str(body.get("email", "")).strip().lower()
    db = read_db()
    account = next((item for item in db.get("customers", []) if _customer_email(item) == email), None)
    preview_link = ""
    if account:
        preview_link = _issue_password_reset(account, request)
        account["updatedAt"] = _now()
        write_db(db)
    return JsonResponse({
        "ok": True,
        "message": "Se este e-mail estiver cadastrado, enviaremos um link de recuperacao.",
        "resetPreviewUrl": preview_link if preview_link and settings.EMAIL_BACKEND.endswith("console.EmailBackend") else "",
    })


@csrf_exempt
def api_customer_password_reset_confirm(request):
    body = _json_body(request)
    token = str(body.get("token", "")).strip()
    password = str(body.get("password", "")).strip()
    if len(password) < 6:
        return JsonResponse({"error": "A senha precisa ter pelo menos 6 caracteres."}, status=400)
    token_hash = _token_hash(token)
    db = read_db()
    account = next((item for item in db.get("customers", []) if item.get("passwordReset", {}).get("tokenHash") == token_hash), None)
    if not account:
        return JsonResponse({"error": "Link invalido ou ja usado."}, status=404)
    expires_at = _parse_dt(account.get("passwordReset", {}).get("expiresAt"))
    if expires_at and expires_at < datetime.now(timezone.utc):
        return JsonResponse({"error": "Link expirado. Solicite uma nova recuperacao."}, status=400)
    account["passwordHash"] = _hash_password(password)
    account.pop("passwordReset", None)
    account["updatedAt"] = _now()
    write_db(db)
    return JsonResponse({"ok": True})


def api_customer_orders(request):
    email = str(request.GET.get("email", "")).strip().lower()
    db = read_db()
    if _expire_pending_orders(db):
        write_db(db)
    orders = [order for order in db.get("orders", []) if str(order.get("customer", {}).get("email", "")).lower() == email]
    account = next((item for item in db.get("customers", []) if _customer_email(item) == email), None)
    return JsonResponse({
        "orders": [_public_order(order) for order in orders],
        "account": _safe_customer_account(account) if account else None,
    })


@csrf_exempt
def api_customer_order_detail(request, order_id):
    body = _json_body(request)
    email = str(body.get("email") or request.GET.get("email", "")).strip().lower()
    db = read_db()
    if _expire_pending_orders(db):
        write_db(db)
    order = next((item for item in db.get("orders", []) if item.get("id") == order_id and str(item.get("customer", {}).get("email", "")).lower() == email), None)
    if not order:
        return JsonResponse({"error": "Pedido nao encontrado."}, status=404)
    if request.method != "PATCH":
        return JsonResponse({"order": _public_order(order)})
    if body.get("action") != "cancel_payment":
        return JsonResponse({"error": "Acao invalida."}, status=400)
    if order.get("status") != "awaiting_payment":
        return JsonResponse({"error": "Este pedido nao pode mais ser cancelado por aqui."}, status=400)
    previous_status = order.get("status")
    order["status"] = "canceled"
    order.setdefault("payment", {})["status"] = "canceled_by_customer"
    order["payment"]["updatedAt"] = _now()
    order["updatedAt"] = _now()
    _append_order_history(order, "payment", "customer", "canceled", "Cliente desistiu da compra antes do pagamento.", previous_status)
    write_db(db)
    _send_order_email(order, f"Pedido cancelado - {order['id']}", "Voce cancelou este pedido antes do pagamento.", include_payment=False)
    _notify_admin_order(order, f"Cliente cancelou {order['id']}", "O cliente cancelou um pedido antes do pagamento.")
    return JsonResponse({"order": _public_order(order)})


@csrf_exempt
def api_customer_product_reviews(request, product_id):
    if request.method != "POST":
        return JsonResponse({"error": "Metodo nao permitido."}, status=405)
    email = str(request.POST.get("email", "")).strip().lower()
    order_id = str(request.POST.get("orderId", "")).strip()
    if not email or not order_id:
        return JsonResponse({"error": "Cliente e pedido sao obrigatorios."}, status=400)
    db = read_db()
    product = next((item for item in db.get("products", []) if item.get("id") == product_id), None)
    if not product:
        return JsonResponse({"error": "Produto nao encontrado."}, status=404)
    paid_statuses = {"paid", "in_production", "shipped", "completed"}
    order = next((
        item for item in db.get("orders", [])
        if item.get("id") == order_id
        and str(item.get("customer", {}).get("email", "")).lower() == email
        and item.get("status") in paid_statuses
        and any(line.get("productId") == product_id for line in item.get("items", []))
    ), None)
    if not order:
        return JsonResponse({"error": "Avaliacao disponivel apenas para produto comprado e pago."}, status=403)

    upload_files = request.FILES.getlist("mediaFiles") or request.FILES.getlist("photos")
    try:
        saved_media = [_save_upload(file_obj, "reviews") for file_obj in upload_files]
    except ValueError as error:
        return JsonResponse({"error": str(error)}, status=400)
    media = [item for item in saved_media if item]
    photos = [
        url for url, file_obj in zip(media, upload_files)
        if str(getattr(file_obj, "content_type", "")).startswith("image/")
    ]
    reviews = product.setdefault("reviews", [])
    existing = next((
        item for item in reviews
        if item.get("source") == "customer"
        and item.get("orderId") == order_id
        and item.get("productId") == product_id
        and str(item.get("customerEmail", "")).lower() == email
    ), None)
    next_media = [*(existing or {}).get("media", []), *media] if existing else media
    next_photos = [*(existing or {}).get("photos", []), *photos] if existing else photos
    payload = request.POST.copy()
    account = next((item for item in db.get("customers", []) if _customer_email(item) == email), None)
    public_customer = account.get("customer", {}) if account else order.get("customer", {})
    payload["customerName"] = public_customer.get("displayName") or public_customer.get("name") or "Cliente Basa"
    payload["approved"] = "true"
    review = _social_post_payload(payload, existing, next_photos, next_media)
    review.update({
        "source": "customer",
        "orderId": order_id,
        "productId": product_id,
        "customerEmail": email,
        "customerAvatar": public_customer.get("avatarUrl", ""),
        "profileVerified": bool(public_customer.get("profileVerified", False)),
    })
    if not existing:
        reviews.insert(0, review)
    write_db(db)
    return JsonResponse({"review": review, "product": _public_product(product, db)}, status=201)


@csrf_exempt
def api_custom_requests(request):
    db = read_db()
    if _close_inactive_chats(db):
        write_db(db)
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
    kind = "chat" if body.get("kind") == "chat" or str(body.get("title", "")).startswith("Atendimento") else "custom"
    item = {
        "id": f"ENC-{int(datetime.now().timestamp() * 1000)}",
        "createdAt": _now(),
        "updatedAt": _now(),
        "kind": kind,
        "status": _request_status(body.get("status"), kind),
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
    if item.get("kind") == "chat":
        item["status"] = "waiting_admin"
    item["updatedAt"] = _now()
    write_db(db)
    return JsonResponse({"request": item})


def api_admin_dashboard(request):
    error = _require_admin(request)
    if error:
        return error
    db = read_db()
    if _expire_pending_orders(db) or _close_inactive_chats(db):
        write_db(db)
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


def _paid_orders(db):
    paid_statuses = {"paid", "in_production", "shipped", "completed"}
    return [order for order in db.get("orders", []) if order.get("status") in paid_statuses]


def _admin_insight_context(db):
    orders = _paid_orders(db)
    products = db.get("products", [])
    requests = db.get("customRequests", [])
    coupons = db.get("coupons", [])
    revenue = round(sum(float(order.get("total") or 0) for order in orders), 2)
    units = sum(sum(int(float(item.get("quantity") or 0)) for item in order.get("items", [])) for order in orders)
    shipping_revenue = round(sum(float(order.get("shipping") or 0) for order in orders), 2)
    free_shipping_orders = len([order for order in orders if float(order.get("shipping") or 0) == 0])
    product_rows = []
    for product in products:
        product_id = product.get("id")
        lines = [line for order in orders for line in order.get("items", []) if line.get("productId") == product_id]
        sold = sum(int(float(line.get("quantity") or 0)) for line in lines)
        product_rows.append({
            "name": product.get("name"),
            "category": product.get("category"),
            "price": product.get("price"),
            "stock": product.get("stock"),
            "soldUnits": sold,
            "revenue": round(sum(float(line.get("total") or 0) for line in lines), 2),
            "campaign": product.get("campaign") or None,
            "sellerPaysShipping": bool(product.get("shipping", {}).get("sellerPaysShipping")),
        })
    product_rows.sort(key=lambda item: item["revenue"], reverse=True)
    return {
        "store": db.get("settings", {}).get("storeName", "Basa 3D Works"),
        "summary": {
            "activeProducts": len([product for product in products if product.get("status", "active") == "active"]),
            "paidOrders": len(orders),
            "revenue": revenue,
            "units": units,
            "averageTicket": round(revenue / len(orders), 2) if orders else 0,
            "shippingRevenue": shipping_revenue,
            "freeShippingOrders": free_shipping_orders,
            "openQuotes": len([item for item in requests if item.get("status") not in {"completed", "canceled"}]),
            "activeCoupons": len([coupon for coupon in coupons if coupon.get("active") is not False]),
        },
        "topProducts": product_rows[:8],
        "productsWithoutSales": [item for item in product_rows if item["soldUnits"] == 0][:8],
        "recentOrders": [{
            "id": order.get("id"),
            "status": order.get("status"),
            "total": order.get("total"),
            "shipping": order.get("shipping"),
            "createdAt": order.get("createdAt"),
            "items": [item.get("name") for item in order.get("items", [])],
        } for order in db.get("orders", [])[:8]],
        "campaigns": [product.get("campaign") for product in products if product.get("campaign")],
    }


def _fallback_insights(context):
    summary = context["summary"]
    top_product = context["topProducts"][0] if context["topProducts"] else None
    weak_product = context["productsWithoutSales"][0] if context["productsWithoutSales"] else None
    lines = [
        "Prioridade 1: cadastrar e revisar produtos reais com fotos fortes, preço final e estoque correto antes de impulsionar tráfego.",
        f"Pedidos pagos: {summary['paidOrders']} | receita: R$ {summary['revenue']:.2f} | ticket médio: R$ {summary['averageTicket']:.2f}.",
    ]
    if top_product:
        lines.append(f"Produto para campanha: {top_product['name']} concentra melhor sinal de venda. Use oferta curta, story de produção e cupom de carrinho.")
    if weak_product:
        lines.append(f"Produto para revisar: {weak_product['name']} ainda não vendeu. Verifique foto, nome, preço antigo, benefício e categoria.")
    if summary["openQuotes"]:
        lines.append(f"Sob medida: existem {summary['openQuotes']} orçamento(s) aberto(s). Priorize resposta rápida, porque esse cliente já levantou a mão.")
    lines.append("IA externa ainda não configurada. Defina OPENAI_API_KEY na Railway para receber uma análise gerada pela API.")
    return "\n".join(lines)


def _extract_openai_text(payload):
    if payload.get("output_text"):
        return payload["output_text"]
    chunks = []
    for item in payload.get("output", []):
        for content in item.get("content", []):
            if content.get("type") in {"output_text", "text"} and content.get("text"):
                chunks.append(content["text"])
    return "\n".join(chunks).strip()


@csrf_exempt
def api_admin_ai_insights(request):
    error = _require_admin(request)
    if error:
        return error
    db = read_db()
    context = _admin_insight_context(db)
    if not OPENAI_API_KEY:
        return JsonResponse({"source": "local", "context": context, "insight": _fallback_insights(context)})

    prompt = (
        "Você é um consultor comercial para um ecommerce brasileiro de impressão 3D chamado Basa 3D Works. "
        "Analise os dados e entregue recomendações práticas, curtas e priorizadas. "
        "Fale em português do Brasil. Não invente dados ausentes. "
        "Responda com: Diagnóstico, Próximas ações, Produtos para impulsionar, Riscos e Experimentos da semana.\n\n"
        f"Dados:\n{json.dumps(context, ensure_ascii=False)}"
    )
    request_data = json.dumps({
        "model": OPENAI_INSIGHTS_MODEL,
        "input": prompt,
        "max_output_tokens": 900,
    }).encode("utf-8")
    api_request = urllib.request.Request(
        "https://api.openai.com/v1/responses",
        data=request_data,
        headers={
            "Authorization": f"Bearer {OPENAI_API_KEY}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(api_request, timeout=35) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="ignore")
        if exc.code == 429:
            return JsonResponse({
                "source": "local",
                "warning": "A OpenAI recusou a chamada por limite, cota ou billing da conta. Usando análise local por enquanto.",
                "context": context,
                "insight": _fallback_insights(context),
            })
        return JsonResponse({"error": f"OpenAI retornou erro {exc.code}.", "detail": detail}, status=502)
    except Exception as exc:
        return JsonResponse({"error": f"Não foi possível gerar insights agora: {exc}"}, status=502)

    text = _extract_openai_text(payload)
    return JsonResponse({"source": "openai", "model": OPENAI_INSIGHTS_MODEL, "context": context, "insight": text or _fallback_insights(context)})


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
    if "theme" in body:
        settings["theme"] = body.get("theme") or settings.get("theme") or "atelier"
    if "originZipCode" in body:
        settings["originZipCode"] = _digits(body.get("originZipCode"))
    settings.pop("shippingFlatRate", None)
    settings["shippingProvider"] = SHIPPING_PROVIDER
    if "displaySalesCount" in body:
        settings["displaySalesCount"] = bool(body.get("displaySalesCount"))
    if "displayFavoriteCount" in body:
        settings["displayFavoriteCount"] = bool(body.get("displayFavoriteCount"))
    if "displayRating" in body:
        settings["displayRating"] = bool(body.get("displayRating"))
    settings["promotions"] = promotions

    sender_fields = {
        "senderName": ("name", str),
        "senderEmail": ("email", str),
        "senderPhone": ("phone", lambda value: re.sub(r"\D", "", str(value))),
        "senderDocument": ("document", lambda value: re.sub(r"\D", "", str(value))),
        "senderCompanyDocument": ("companyDocument", lambda value: re.sub(r"\D", "", str(value))),
        "senderZipCode": ("zipCode", lambda value: re.sub(r"\D", "", str(value))),
        "senderAddress": ("address", str),
        "senderNumber": ("number", str),
        "senderComplement": ("complement", str),
        "senderNeighborhood": ("neighborhood", str),
        "senderCity": ("city", str),
        "senderState": ("state", lambda value: str(value).upper()[:2]),
    }
    if any(key in body for key in sender_fields):
        sender = {**settings.get("sender", {})}
        for form_key, (sender_key, sanitizer) in sender_fields.items():
            if form_key in body:
                sender[sender_key] = sanitizer(body.get(form_key, ""))
        settings["sender"] = sender
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
    try:
        product = _product_post_payload(request)
    except ValueError as error:
        return JsonResponse({"error": str(error)}, status=400)
    db.setdefault("products", []).insert(0, product)
    write_db(db)
    return JsonResponse({"product": product}, status=201)


def _save_person(collection_name, body, item_id=None, kind="customer"):
    db = read_db()
    collection = db.setdefault(collection_name, [])
    index = next((idx for idx, item in enumerate(collection) if item.get("id") == item_id), -1) if item_id else -1
    existing = collection[index] if index >= 0 else {}
    try:
        item = _customer_payload(body, existing, allow_profile_verified=True) if kind == "customer" else _partner_payload(body, existing, kind)
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
    if kind == "customer":
        _sync_customer_public_reviews(db, item)
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
    if request.method not in {"POST", "PUT", "PATCH"}:
        return JsonResponse({"error": "Metodo nao permitido."}, status=405)
    try:
        products[index] = _product_post_payload(request, products[index])
    except ValueError as error:
        return JsonResponse({"error": str(error)}, status=400)
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
def api_admin_product_social_posts(request, product_id):
    error = _require_admin(request)
    if error:
        return error
    db = read_db()
    product = next((item for item in db.get("products", []) if item.get("id") == product_id), None)
    if not product:
        return JsonResponse({"error": "Produto nao encontrado."}, status=404)
    if request.method == "GET":
        return JsonResponse({"product": product, "reviews": product.get("reviews", []), "products": db.get("products", [])})
    upload_files = request.FILES.getlist("mediaFiles") or request.FILES.getlist("photos")
    saved_media = [_save_upload(file_obj, "reviews") for file_obj in upload_files]
    media = [item for item in saved_media if item]
    photos = [
        url for url, file_obj in zip(media, upload_files)
        if str(getattr(file_obj, "content_type", "")).startswith("image/")
    ]
    review = _social_post_payload(request.POST, photos=photos, media=media)
    product.setdefault("reviews", []).insert(0, review)
    write_db(db)
    return JsonResponse({"product": product, "review": review, "reviews": product.get("reviews", []), "products": db.get("products", [])}, status=201)


@csrf_exempt
def api_admin_product_social_post_detail(request, product_id, review_id):
    error = _require_admin(request)
    if error:
        return error
    db = read_db()
    product = next((item for item in db.get("products", []) if item.get("id") == product_id), None)
    if not product:
        return JsonResponse({"error": "Produto nao encontrado."}, status=404)
    reviews = product.setdefault("reviews", [])
    index = next((idx for idx, item in enumerate(reviews) if item.get("id") == review_id), -1)
    if index < 0:
        return JsonResponse({"error": "Review nao encontrada."}, status=404)
    if request.method == "DELETE":
        review = reviews.pop(index)
        write_db(db)
        return JsonResponse({"product": product, "review": review, "reviews": reviews, "products": db.get("products", [])})
    upload_files = request.FILES.getlist("mediaFiles") or request.FILES.getlist("photos")
    saved_media = [_save_upload(file_obj, "reviews") for file_obj in upload_files]
    media = [item for item in saved_media if item]
    photos = [
        url for url, file_obj in zip(media, upload_files)
        if str(getattr(file_obj, "content_type", "")).startswith("image/")
    ]
    next_media = media or reviews[index].get("media") or reviews[index].get("photos", [])
    next_photos = photos or reviews[index].get("photos", [])
    reviews[index] = _social_post_payload(request.POST, reviews[index], next_photos, next_media)
    write_db(db)
    return JsonResponse({"product": product, "review": reviews[index], "reviews": reviews, "products": db.get("products", [])})


@csrf_exempt
def api_admin_order_detail(request, order_id):
    error = _require_admin(request)
    if error:
        return error
    db = read_db()
    orders = db.setdefault("orders", [])
    index = next((idx for idx, item in enumerate(orders) if item.get("id") == order_id), -1)
    if index < 0:
        return JsonResponse({"error": "Pedido nao encontrado."}, status=404)
    if request.method == "DELETE":
        order = orders.pop(index)
        write_db(db)
        return JsonResponse({"order": order, "orders": orders})
    body = _json_body(request)
    order = orders[index]
    action = body.get("action")
    if action == "cancel_payment":
        previous_status = order.get("status")
        order["status"] = "canceled"
        order.setdefault("payment", {})["status"] = "canceled"
        order["payment"]["updatedAt"] = _now()
        order["updatedAt"] = _now()
        _append_order_history(order, "payment", "admin", "canceled", body.get("note") or "Pedido cancelado manualmente no painel.", previous_status)
        write_db(db)
        return JsonResponse({"order": order})
    if action == "resend_payment":
        if order.get("status") != "awaiting_payment" or not _order_payment_url(order):
            return JsonResponse({"error": "Este pedido nao possui pagamento pendente com link ativo."}, status=400)
        order.setdefault("payment", {})["lastReminderAt"] = _now()
        order["updatedAt"] = _now()
        _append_order_history(order, "payment", "admin", "awaiting_payment", body.get("note") or "Link de pagamento marcado para reenvio manual.")
        _send_order_email(order, f"Link de pagamento - {order['id']}", "Seu pedido ainda esta aguardando pagamento. Use o link abaixo para concluir.", include_payment=True)
        write_db(db)
        return JsonResponse({"order": order, "checkoutUrl": _order_payment_url(order)})
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
        status_messages = {
            "paid": ("Pagamento confirmado", "Seu pagamento foi confirmado. Vamos preparar seu pedido."),
            "in_production": ("Pedido em producao", "Seu pedido entrou em producao."),
            "shipped": ("Pedido enviado", "Seu pedido foi enviado."),
            "completed": ("Pedido concluido", "Seu pedido foi concluido. Obrigado por comprar com a Basa 3D Works."),
            "canceled": ("Pedido cancelado", "Seu pedido foi cancelado."),
        }
        if next_status in status_messages:
            subject_prefix, intro = status_messages[next_status]
            _send_order_email(order, f"{subject_prefix} - {order['id']}", intro, include_payment=next_status == "awaiting_payment")
        _apply_paid_order_stock(db, order, "admin")
    order["updatedAt"] = _now()
    write_db(db)
    return JsonResponse({"order": order})


@csrf_exempt
def api_admin_chats(request):
    error = _require_admin(request)
    if error:
        return error
    if request.method != "POST":
        return JsonResponse({"error": "Metodo nao permitido."}, status=405)
    body = _json_body(request)
    message = str(body.get("message", "")).strip()
    if not message:
        return JsonResponse({"error": "Escreva a primeira mensagem."}, status=400)
    customer_id = str(body.get("customerId", "")).strip()
    email = str(body.get("email", "")).strip().lower()
    db = read_db()
    account = next((
        item for item in db.get("customers", [])
        if (customer_id and item.get("id") == customer_id) or (email and _customer_email(item) == email)
    ), None)
    if not account:
        return JsonResponse({"error": "Cliente nao encontrado."}, status=404)
    customer = _safe_customer_account(account).get("customer", {})
    email = str(customer.get("email", "")).strip().lower()
    if not email:
        return JsonResponse({"error": "Cliente sem e-mail cadastrado."}, status=400)
    chats = [
        item for item in db.setdefault("customRequests", [])
        if (item.get("kind") == "chat" or str(item.get("title", "")).startswith("Atendimento"))
        and str(item.get("customer", {}).get("email", "")).strip().lower() == email
    ]
    chat = next((item for item in chats if item.get("status") != "closed"), None)
    if chat:
        chat["kind"] = "chat"
        chat.setdefault("messages", []).append({"id": f"msg-{secrets.token_hex(6)}", "author": "admin", "text": message, "createdAt": _now()})
        chat["status"] = "waiting_customer"
        chat["updatedAt"] = _now()
    else:
        chat = {
            "id": f"ENC-{int(datetime.now().timestamp() * 1000)}",
            "createdAt": _now(),
            "updatedAt": _now(),
            "kind": "chat",
            "status": "waiting_customer",
            "title": "Atendimento pelo chat",
            "idea": message,
            "budget": "",
            "deadline": "",
            "customer": customer,
            "attachment": None,
            "messages": [{"id": f"msg-{secrets.token_hex(6)}", "author": "admin", "text": message, "createdAt": _now()}],
        }
        db.setdefault("customRequests", []).insert(0, chat)
    write_db(db)
    return JsonResponse({"request": chat, "customRequests": db.get("customRequests", [])}, status=201)


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
    kind = item.get("kind") or ("chat" if str(item.get("title", "")).startswith("Atendimento") else "custom")
    item["kind"] = kind
    previous_status = item.get("status")
    item["status"] = _request_status(body.get("status") or item.get("status"), kind)
    item["updatedAt"] = _now()
    message = str(body.get("message", "")).strip()
    if message:
        item.setdefault("messages", []).append({"id": f"msg-{secrets.token_hex(6)}", "author": "admin", "text": message, "createdAt": _now()})
        if kind == "chat" and not body.get("status"):
            item["status"] = "answered"
    if kind == "chat" and item.get("status") == "closed" and previous_status != "closed":
        _append_chat_closed_message(item, "manual")
    write_db(db)
    return JsonResponse({"request": item, "customRequests": db.get("customRequests", [])})
