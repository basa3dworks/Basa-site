import os
from pathlib import Path

import dj_database_url

BASE_DIR = Path(__file__).resolve().parent.parent


def load_local_env():
    env_path = BASE_DIR / ".env"
    if not env_path.exists():
        return
    for raw_line in env_path.read_text(encoding="utf-8-sig").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


load_local_env()

SECRET_KEY = os.environ.get("DJANGO_SECRET_KEY") or os.environ.get("SESSION_SECRET") or "dev-secret"
DEBUG = os.environ.get("DJANGO_DEBUG", "").lower() in {"1", "true", "yes"}
ALLOWED_HOSTS = [host.strip() for host in os.environ.get("DJANGO_ALLOWED_HOSTS", "*").split(",") if host.strip()]

INSTALLED_APPS = [
    "django.contrib.staticfiles",
    "commerce",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "whitenoise.middleware.WhiteNoiseMiddleware",
    "django.middleware.common.CommonMiddleware",
]

ROOT_URLCONF = "basa_django.urls"
TEMPLATES = []
WSGI_APPLICATION = "basa_django.wsgi.application"
ASGI_APPLICATION = "basa_django.asgi.application"

DATABASE_URL = os.environ.get("DATABASE_URL") or os.environ.get("POSTGRES_URL")
DATABASES = {
    "default": dj_database_url.parse(DATABASE_URL) if DATABASE_URL else {"ENGINE": "django.db.backends.sqlite3", "NAME": BASE_DIR / "django.sqlite3"}
}

LANGUAGE_CODE = "pt-br"
TIME_ZONE = "America/Sao_Paulo"
USE_I18N = True
USE_TZ = True

STATIC_URL = "/"
STATICFILES_DIRS = [BASE_DIR / "public"]
STATIC_ROOT = BASE_DIR / "staticfiles"
STORAGES = {
    "staticfiles": {
        "BACKEND": "whitenoise.storage.CompressedManifestStaticFilesStorage",
    },
}

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

EMAIL_HOST = os.environ.get("EMAIL_HOST") or os.environ.get("SMTP_HOST", "")
EMAIL_PORT = int(os.environ.get("EMAIL_PORT") or os.environ.get("SMTP_PORT", "587"))
EMAIL_HOST_USER = os.environ.get("EMAIL_HOST_USER") or os.environ.get("SMTP_USER", "")
EMAIL_HOST_PASSWORD = os.environ.get("EMAIL_HOST_PASSWORD") or os.environ.get("SMTP_PASSWORD", "")
EMAIL_USE_TLS = (os.environ.get("EMAIL_USE_TLS") or os.environ.get("SMTP_USE_TLS", "true")).lower() in {"1", "true", "yes"}
EMAIL_USE_SSL = (os.environ.get("EMAIL_USE_SSL") or os.environ.get("SMTP_USE_SSL", "")).lower() in {"1", "true", "yes"}
DEFAULT_FROM_EMAIL = os.environ.get("DEFAULT_FROM_EMAIL") or os.environ.get("SMTP_FROM", "Basa 3D Works <no-reply@basa3d.com>")
EMAIL_BACKEND = "django.core.mail.backends.smtp.EmailBackend" if EMAIL_HOST else "django.core.mail.backends.console.EmailBackend"
EMAIL_TIMEOUT = int(os.environ.get("EMAIL_TIMEOUT", "6") or 6)
EMAIL_SEND_ASYNC = (os.environ.get("EMAIL_SEND_ASYNC", "true")).lower() in {"1", "true", "yes"}
