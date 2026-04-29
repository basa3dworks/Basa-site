import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { loadEnv } from "./env.mjs";
import { createPaymentIntent } from "./payment/split.mjs";
import { addOrderToBetterEnvioCart, checkoutBetterEnvioShipment, generateBetterEnvioLabel, printBetterEnvioLabel, quoteOrderShipping, quoteShipping } from "./shipping.mjs";
import { couponEligibility, couponExpired, findCoupon, orderFromCart, publicProduct, publicStory, readDb, writeDb } from "./store.mjs";

loadEnv();

const port = Number(process.env.PORT || 3000);
const publicDir = path.resolve("public");
const adminUser = process.env.ADMIN_USER || "admin@basa3dworks.com";
const adminPassword = process.env.ADMIN_PASSWORD || "admin";
const sessionSecret = process.env.SESSION_SECRET || "dev-secret";
const paymentProvider = process.env.PAYMENT_PROVIDER || "mock";
const publicBaseUrl = process.env.PUBLIC_BASE_URL || `http://localhost:${port}`;
const shippingProvider = process.env.SHIPPING_PROVIDER || "mock";
const melhorEnvioToken = process.env.MELHOR_ENVIO_TOKEN || "";
const melhorEnvioApiBase = process.env.MELHOR_ENVIO_API_BASE || "https://sandbox.melhorenvio.com.br";
const melhorEnvioUserAgent = process.env.MELHOR_ENVIO_USER_AGENT || "Basa 3D Works (contato@basa3dworks.com)";

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime"
};

function send(res, status, body, headers = {}) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "content-type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
    ...headers
  });
  res.end(payload);
}

function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || "").split(";").filter(Boolean).map((item) => {
    const [key, ...value] = item.trim().split("=");
    return [key, decodeURIComponent(value.join("="))];
  }));
}

function sign(value) {
  return crypto.createHmac("sha256", sessionSecret).update(value).digest("hex");
}

function lines(value) {
  return String(value || "").split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
}

function specs(value) {
  return Object.fromEntries(lines(value).map((line) => {
    const [key, ...rest] = line.split(":");
    return [key.trim(), rest.join(":").trim()];
  }).filter(([key, val]) => key && val));
}

function extractShipmentId(data) {
  if (!data || typeof data !== "object") return "";
  return String(data.id || data.order_id || data.protocol || data.data?.id || data.purchase?.id || data.orders?.[0]?.id || "");
}

function findShipmentPrintUrl(data) {
  if (!data || typeof data !== "object") return "";
  return data.url || data.link || data.print_url || data.data?.url || data.data?.link || data.data?.print_url || "";
}

function addOrderHistory(order, entry = {}) {
  order.history ||= [];
  order.history.push({
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    ...entry
  });
}

function setOrderStatus(order, nextStatus, { source = "manual", note = "" } = {}) {
  if (!nextStatus || nextStatus === order.status) return false;
  addOrderHistory(order, {
    type: "status",
    source,
    from: order.status,
    to: nextStatus,
    note
  });
  order.status = nextStatus;
  order.updatedAt = new Date().toISOString();
  return true;
}

function orderStatusFromPaymentStatus(status) {
  const normalized = String(status || "").toLowerCase();
  if (["approved", "paid", "authorized"].includes(normalized)) return "paid";
  if (["pending", "in_process", "in_mediation"].includes(normalized)) return "awaiting_payment";
  if (["rejected", "cancelled", "canceled", "refunded", "charged_back"].includes(normalized)) return "canceled";
  return "";
}

function orderStatusFromShippingStatus(status) {
  const normalized = String(status || "").toLowerCase();
  if (["posted", "in_transit", "shipped", "released", "printed"].includes(normalized)) return "shipped";
  if (["delivered", "completed"].includes(normalized)) return "completed";
  if (["canceled", "cancelled"].includes(normalized)) return "canceled";
  return "";
}

async function getMercadoPagoPayment(paymentId) {
  const accessToken = process.env.MERCADO_PAGO_ACCESS_TOKEN;
  if (!paymentId || !accessToken) return null;
  const response = await fetch(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(paymentId)}`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const data = await response.json();
  if (!response.ok) {
    throw Object.assign(new Error(data.message || "Nao foi possivel consultar o pagamento no Mercado Pago."), {
      status: response.status,
      details: data
    });
  }
  return data;
}

function productPayload(body, existing = {}, settings = {}) {
  const name = body.name ?? existing.name;
  const sellerPaysShipping = Boolean(body.sellerPaysShipping);
  const basePrice = Number(body.price ?? existing.shipping?.basePrice ?? existing.price ?? 0);
  const compareAtBasePrice = Number(body.compareAtPrice || 0);
  const embeddedShippingReserve = sellerPaysShipping ? Number(settings.shippingFlatRate || 0) : 0;
  const finalPrice = sellerPaysShipping ? basePrice + embeddedShippingReserve : basePrice;
  const finalCompareAtPrice = sellerPaysShipping && compareAtBasePrice > 0 ? compareAtBasePrice + embeddedShippingReserve : compareAtBasePrice;
  return {
    ...existing,
    name,
    slug: body.slug || existing.slug || name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, ""),
    description: body.description ?? existing.description,
    longDescription: body.longDescription || body.description || existing.longDescription || existing.description,
    highlights: Array.isArray(body.highlights) ? body.highlights : body.highlights !== undefined ? lines(body.highlights) : existing.highlights || [],
    specs: typeof body.specs === "object" && body.specs !== null ? body.specs : body.specs !== undefined ? specs(body.specs) : existing.specs || {},
    variants: {
      bundleType: body.bundleType === "kit" ? "kit" : "single",
      colors: Array.isArray(body.colors) ? body.colors.map((item) => String(item).trim()).filter(Boolean) : body.colors !== undefined ? lines(body.colors) : existing.variants?.colors || [],
      piecesIncluded: Math.max(1, Number(body.piecesIncluded ?? existing.variants?.piecesIncluded ?? 1))
    },
    videoUrl: body.videoUrl ?? existing.videoUrl ?? "",
    gallery: Array.isArray(body.gallery) ? body.gallery : body.gallery !== undefined ? [body.image || existing.image, ...lines(body.gallery)].filter(Boolean) : existing.gallery || [body.image || existing.image].filter(Boolean),
    price: Math.round(finalPrice * 100) / 100,
    compareAtPrice: Math.round(finalCompareAtPrice * 100) / 100,
    createdAt: existing.createdAt || new Date().toISOString(),
    shipping: {
      weightKg: Number(body.weightKg ?? existing.shipping?.weightKg ?? 0.3),
      widthCm: Number(body.widthCm ?? existing.shipping?.widthCm ?? 12),
      heightCm: Number(body.heightCm ?? existing.shipping?.heightCm ?? 8),
      lengthCm: Number(body.lengthCm ?? existing.shipping?.lengthCm ?? 18),
      sellerPaysShipping,
      freeShippingMinQuantity: Math.max(0, Number(body.freeShippingMinQuantity ?? existing.shipping?.freeShippingMinQuantity ?? 0)),
      basePrice: Math.round(basePrice * 100) / 100,
      compareAtBasePrice: Math.round(compareAtBasePrice * 100) / 100,
      embeddedShippingReserve: Math.round(embeddedShippingReserve * 100) / 100
    },
    stock: Number(body.stock ?? existing.stock ?? 0),
    status: body.status || existing.status || "active",
    category: body.category || existing.category || "Geral",
    image: body.image || existing.image,
    campaign: existing.campaign || null,
    seller: body.seller || existing.seller || { id: "basa-studio", name: "Basa Studio", paymentAccountId: "acct_basa_studio" }
  };
}

function campaignPayload(body = {}) {
  const type = ["featured", "flash", "clearance", "launch"].includes(body.type) ? body.type : "featured";
  return {
    active: Boolean(body.active),
    type,
    label: String(body.label || "").trim(),
    discountPercent: Math.max(0, Math.min(95, Number(body.discountPercent || 0))),
    priority: Math.max(0, Math.min(100, Number(body.priority || 0))),
    startsAt: body.startsAt || "",
    endsAt: body.endsAt || "",
    updatedAt: new Date().toISOString()
  };
}

function publicCustomRequest(request) {
  return {
    id: request.id,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
    status: request.status,
    title: request.title,
    idea: request.idea,
    budget: request.budget,
    deadline: request.deadline,
    attachment: request.attachment || null,
    messages: request.messages || []
  };
}

function requestStatus(value) {
  return ["new", "in_review", "quoted", "approved", "in_production", "shipped", "completed", "canceled"].includes(value) ? value : "new";
}

function createSession(user) {
  const payload = Buffer.from(JSON.stringify({ user, exp: Date.now() + 1000 * 60 * 60 * 8 })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

function getSession(req) {
  const token = parseCookies(req).basa_admin;
  if (!token) return null;
  const [payload, signature] = token.split(".");
  if (!payload || signature !== sign(payload)) return null;
  const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  return data.exp > Date.now() ? data : null;
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  const contentType = req.headers["content-type"] || "";
  if (contentType.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(raw));
  }
  return JSON.parse(raw);
}

function idFromResource(value) {
  const match = String(value || "").match(/\/(\d+)(?:\?.*)?$/);
  return match?.[1] || "";
}

async function readMultipart(req) {
  const contentType = req.headers["content-type"] || "";
  const boundary = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/)?.[1] || contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/)?.[2];
  if (!boundary) throw Object.assign(new Error("Formulario de upload invalido."), { status: 400 });
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  const marker = Buffer.from(`--${boundary}`);
  const fields = {};
  const files = {};
  let start = body.indexOf(marker);

  while (start !== -1) {
    start += marker.length;
    if (body[start] === 45 && body[start + 1] === 45) break;
    if (body[start] === 13 && body[start + 1] === 10) start += 2;
    const headerEnd = body.indexOf(Buffer.from("\r\n\r\n"), start);
    if (headerEnd === -1) break;
    const header = body.slice(start, headerEnd).toString("utf8");
    const next = body.indexOf(marker, headerEnd + 4);
    if (next === -1) break;
    let value = body.slice(headerEnd + 4, next);
    if (value.at(-2) === 13 && value.at(-1) === 10) value = value.slice(0, -2);

    const name = header.match(/name="([^"]+)"/)?.[1];
    const filename = header.match(/filename="([^"]*)"/)?.[1];
    const type = header.match(/Content-Type:\s*([^\r\n]+)/i)?.[1] || "application/octet-stream";
    if (name && filename) files[name] = { filename, type, buffer: value };
    else if (name) fields[name] = value.toString("utf8");
    start = next;
  }

  return { fields, files };
}

function safeUploadName(filename) {
  const ext = path.extname(filename || "").toLowerCase();
  const allowed = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".mp4", ".webm", ".mov"]);
  if (!allowed.has(ext)) throw Object.assign(new Error("Use imagem ou video em jpg, png, webp, gif, mp4, webm ou mov."), { status: 400 });
  return `${Date.now()}-${crypto.randomUUID()}${ext}`;
}

async function saveStoryUpload(upload) {
  if (!upload?.buffer?.length) return null;
  const mediaType = upload.type.startsWith("video/") ? "video" : "image";
  const filename = safeUploadName(upload.filename);
  const uploadDir = path.join(publicDir, "uploads", "stories");
  await fs.mkdir(uploadDir, { recursive: true });
  await fs.writeFile(path.join(uploadDir, filename), upload.buffer);
  return { mediaType, mediaUrl: `/uploads/stories/${filename}` };
}

async function saveHeroSlideUpload(upload) {
  if (!upload?.buffer?.length) return null;
  if (!upload.type.startsWith("image/")) {
    throw Object.assign(new Error("Selecione uma imagem para a seção principal."), { status: 400 });
  }
  const filename = safeUploadName(upload.filename);
  const uploadDir = path.join(publicDir, "uploads", "hero");
  await fs.mkdir(uploadDir, { recursive: true });
  await fs.writeFile(path.join(uploadDir, filename), upload.buffer);
  return `/uploads/hero/${filename}`;
}

async function saveCustomRequestUpload(upload) {
  if (!upload?.buffer?.length) return null;
  if (!upload.type.startsWith("image/")) {
    throw Object.assign(new Error("Use uma imagem em jpg, png, webp ou gif."), { status: 400 });
  }
  const filename = safeUploadName(upload.filename);
  const uploadDir = path.join(publicDir, "uploads", "custom-requests");
  await fs.mkdir(uploadDir, { recursive: true });
  await fs.writeFile(path.join(uploadDir, filename), upload.buffer);
  return {
    filename: upload.filename || filename,
    type: upload.type,
    url: `/uploads/custom-requests/${filename}`
  };
}

async function removeHeroSlideUpload(imageUrl) {
  if (!imageUrl || !imageUrl.startsWith("/uploads/hero/")) return;
  const resolved = path.resolve(publicDir, imageUrl.slice(1));
  const uploadRoot = path.resolve(publicDir, "uploads", "hero");
  if (!resolved.startsWith(uploadRoot)) return;
  await fs.unlink(resolved).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
}

async function removeStoryUpload(mediaUrl) {
  if (!mediaUrl || !mediaUrl.startsWith("/uploads/stories/")) return;
  const resolved = path.resolve(publicDir, mediaUrl.slice(1));
  const uploadRoot = path.resolve(publicDir, "uploads", "stories");
  if (!resolved.startsWith(uploadRoot)) return;
  await fs.unlink(resolved).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
}

function storyPayload(fields, existing = {}, media = null) {
  return {
    ...existing,
    title: String(fields.title ?? existing.title ?? "").trim() || "Bastidor Basa",
    caption: String(fields.caption ?? existing.caption ?? "").trim(),
    productId: fields.productId ?? existing.productId ?? "",
    active: fields.active === undefined ? existing.active !== false : fields.active !== "false",
    mediaType: media?.mediaType || existing.mediaType,
    mediaUrl: media?.mediaUrl || existing.mediaUrl,
    updatedAt: new Date().toISOString()
  };
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const resolved = path.resolve(publicDir, file);
  if (!resolved.startsWith(publicDir)) return send(res, 403, "Acesso negado");

  try {
    const data = await fs.readFile(resolved);
    res.writeHead(200, { "content-type": mime[path.extname(resolved)] || "application/octet-stream" });
    res.end(data);
  } catch {
    send(res, 404, "Pagina nao encontrada");
  }
}

async function router(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (url.pathname === "/api/session" && req.method === "GET") {
      return send(res, 200, { authenticated: Boolean(getSession(req)), user: getSession(req)?.user || null });
    }

    if (url.pathname === "/api/login" && req.method === "POST") {
      const body = await readJson(req);
      if (body.email === adminUser && body.password === adminPassword) {
        return send(res, 200, { ok: true }, { "set-cookie": `basa_admin=${createSession(body.email)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800` });
      }
      return send(res, 401, { error: "Credenciais invalidas." });
    }

    if (url.pathname === "/api/logout" && req.method === "POST") {
      return send(res, 200, { ok: true }, { "set-cookie": "basa_admin=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0" });
    }

    if (url.pathname === "/api/products" && req.method === "GET") {
      const db = await readDb();
      const products = db.products.filter((product) => product.status === "active").map((product) => publicProduct(product, db));
      const stories = (db.stories || [])
        .filter((story) => story.active !== false)
        .map((story) => publicStory(story, db.products))
        .filter((story) => story.mediaUrl);
      const publicCoupons = (db.coupons || []).filter((coupon) => coupon.active !== false && !couponExpired(coupon)).map((coupon) => ({
        code: coupon.code,
        type: coupon.type,
        value: coupon.value,
        minItems: coupon.minItems,
        minSubtotal: coupon.minSubtotal,
        expiresAt: coupon.expiresAt || ""
      }));
      return send(res, 200, { settings: { ...db.settings, publicBaseUrl, coupons: publicCoupons }, products, stories });
    }

    if (url.pathname.match(/^\/api\/cep\/\d{8}$/) && req.method === "GET") {
      const cep = url.pathname.split("/").pop();
      const cepResponse = await fetch(`https://viacep.com.br/ws/${cep}/json/`);
      const cepData = await cepResponse.json();
      if (!cepResponse.ok || cepData.erro) return send(res, 404, { error: "CEP nao encontrado." });
      return send(res, 200, {
        zipCode: cepData.cep,
        street: cepData.logradouro,
        neighborhood: cepData.bairro,
        city: cepData.localidade,
        state: cepData.uf,
        ibge: cepData.ibge
      });
    }

    if (url.pathname === "/api/shipping/quote" && req.method === "POST") {
      const db = await readDb();
      const body = await readJson(req);
      const quote = await quoteShipping({
        db,
        items: body.items || [],
        zipCode: body.zipCode,
        provider: db.settings.shippingProvider || shippingProvider,
        token: melhorEnvioToken,
        apiBase: melhorEnvioApiBase,
        userAgent: melhorEnvioUserAgent
      });
      return send(res, 200, quote);
    }

    if (url.pathname === "/api/coupons/validate" && req.method === "POST") {
      const db = await readDb();
      const body = await readJson(req);
      const coupon = findCoupon(db, body.code);
      if (!coupon) return send(res, 404, { valid: false, error: "Cupom nao encontrado." });
      const productsById = new Map(db.products.map((product) => [product.id, product]));
      const lines = (body.items || []).map((item) => {
        const product = productsById.get(item.productId);
        const quantity = Math.max(1, Number(item.quantity || 1));
        return product ? { quantity, total: product.price * quantity } : null;
      }).filter(Boolean);
      const itemCount = lines.reduce((sum, line) => sum + line.quantity, 0);
      const subtotal = Math.round(lines.reduce((sum, line) => sum + line.total, 0) * 100) / 100;
      const eligibility = couponEligibility({ coupon, itemCount, subtotal });
      return send(res, 200, { valid: eligibility.eligible, reason: eligibility.reason, coupon });
    }

    if (url.pathname === "/api/custom-requests" && req.method === "GET") {
      const db = await readDb();
      const email = String(url.searchParams.get("email") || "").trim().toLowerCase();
      if (!email) return send(res, 400, { error: "Informe o email do cliente." });
      const requests = (db.customRequests || [])
        .filter((request) => String(request.customer?.email || "").toLowerCase() === email)
        .map(publicCustomRequest);
      return send(res, 200, { requests });
    }

    if (url.pathname === "/api/custom-requests" && req.method === "POST") {
      const db = await readDb();
      const isMultipart = String(req.headers["content-type"] || "").includes("multipart/form-data");
      const parsed = isMultipart ? await readMultipart(req) : { fields: await readJson(req), files: {} };
      const body = parsed.fields;
      const customer = typeof body.customer === "string" ? JSON.parse(body.customer || "{}") : body.customer;
      const attachment = await saveCustomRequestUpload(parsed.files.referenceImage);
      const email = String(customer?.email || "").trim().toLowerCase();
      if (!email) return send(res, 400, { error: "Entre com seu cadastro antes de enviar uma encomenda." });
      const request = {
        id: `ENC-${Date.now()}`,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: "new",
        title: String(body.title || "").trim() || "Encomenda sob medida",
        idea: String(body.idea || "").trim(),
        budget: String(body.budget || "").trim(),
        deadline: String(body.deadline || "").trim(),
        customer,
        attachment,
        messages: [{
          id: crypto.randomUUID(),
          author: "customer",
          text: String(body.idea || "").trim(),
          createdAt: new Date().toISOString()
        }]
      };
      if (!request.idea) return send(res, 400, { error: "Descreva sua ideia para pedirmos orçamento." });
      db.customRequests ||= [];
      db.customRequests.unshift(request);
      await writeDb(db);
      return send(res, 201, { request: publicCustomRequest(request) });
    }

    if (url.pathname.match(/^\/api\/custom-requests\/[^/]+\/messages$/) && req.method === "POST") {
      const db = await readDb();
      const id = decodeURIComponent(url.pathname.split("/").at(-2));
      const body = await readJson(req);
      const email = String(body.email || "").trim().toLowerCase();
      const request = (db.customRequests || []).find((item) => item.id === id && String(item.customer?.email || "").toLowerCase() === email);
      if (!request) return send(res, 404, { error: "Encomenda nao encontrada." });
      const text = String(body.text || "").trim();
      if (!text) return send(res, 400, { error: "Escreva uma mensagem." });
      request.messages ||= [];
      request.messages.push({ id: crypto.randomUUID(), author: "customer", text, createdAt: new Date().toISOString() });
      request.updatedAt = new Date().toISOString();
      await writeDb(db);
      return send(res, 200, { request: publicCustomRequest(request) });
    }

    if (url.pathname === "/api/checkout" && req.method === "POST") {
      const db = await readDb();
      const body = await readJson(req);
      if (!body.customerLoggedIn) return send(res, 401, { error: "Cliente precisa estar logado para finalizar a compra." });
      const order = orderFromCart({ db, customer: body.customer, items: body.items || [], shippingOption: body.shippingOption, coupon: body.coupon });
      const payment = await createPaymentIntent({ provider: paymentProvider, order, settings: db.settings, baseUrl: publicBaseUrl });
      order.payment = payment;
      order.status = payment.status === "approved" ? "paid" : "awaiting_payment";
      addOrderHistory(order, {
        type: "payment",
        source: payment.provider || paymentProvider,
        to: order.status,
        note: payment.status === "approved" ? "Pagamento aprovado na criação do pedido." : "Pedido aguardando confirmação automática do pagamento."
      });
      db.orders.unshift(order);
      await writeDb(db);
      return send(res, 201, { order, payment });
    }

    if (url.pathname === "/api/webhooks/mercado-pago" && req.method === "POST") {
      const db = await readDb();
      const body = await readJson(req);
      const paymentId = String(
        body.data?.id ||
        body["data.id"] ||
        body.id ||
        url.searchParams.get("data.id") ||
        url.searchParams.get("id") ||
        idFromResource(body.resource || url.searchParams.get("resource")) ||
        ""
      ).trim();
      const paymentData = await getMercadoPagoPayment(paymentId);
      const orderId = String(
        paymentData?.external_reference ||
        paymentData?.metadata?.order_id ||
        body.external_reference ||
        body.orderId ||
        ""
      );
      const order = db.orders.find((item) => item.id === orderId);
      if (!order) return send(res, 200, { received: true, orderUpdated: false });

      order.payment ||= {};
      order.payment.provider = "mercado-pago";
      order.payment.paymentId = paymentId || order.payment.paymentId;
      order.payment.status = paymentData?.status || body.status || order.payment.status || "pending";
      order.payment.statusDetail = paymentData?.status_detail || body.statusDetail || order.payment.statusDetail || "";
      order.payment.updatedAt = new Date().toISOString();

      const nextStatus = orderStatusFromPaymentStatus(order.payment.status);
      setOrderStatus(order, nextStatus, {
        source: "mercado-pago",
        note: `Pagamento Mercado Pago: ${order.payment.status}${order.payment.statusDetail ? ` (${order.payment.statusDetail})` : ""}.`
      });
      await writeDb(db);
      return send(res, 200, { received: true, orderUpdated: true, orderId: order.id, status: order.status });
    }

    if (url.pathname === "/api/webhooks/melhor-envio" && req.method === "POST") {
      const db = await readDb();
      const body = await readJson(req);
      const shipmentId = String(body.id || body.order_id || body.orderId || body.data?.id || "");
      const orderId = String(body.external_reference || body.reference || body.orderReference || body.data?.external_reference || "");
      const order = db.orders.find((item) => (
        (orderId && item.id === orderId) ||
        (shipmentId && String(item.shippingWorkflow?.melhorEnvioOrderId || "") === shipmentId)
      ));
      if (!order) return send(res, 200, { received: true, orderUpdated: false });

      const status = String(body.status || body.event || body.data?.status || "");
      order.shippingWorkflow ||= {};
      order.shippingWorkflow.tracking = {
        ...(order.shippingWorkflow.tracking || {}),
        status,
        code: body.tracking || body.tracking_code || body.data?.tracking || order.shippingWorkflow.tracking?.code || "",
        updatedAt: new Date().toISOString(),
        lastPayload: body
      };

      const nextStatus = orderStatusFromShippingStatus(status);
      setOrderStatus(order, nextStatus, {
        source: "melhor-envio",
        note: `Atualização de envio: ${status || "evento recebido"}.`
      });
      await writeDb(db);
      return send(res, 200, { received: true, orderUpdated: true, orderId: order.id, status: order.status });
    }

    if (url.pathname.startsWith("/api/admin")) {
      if (!getSession(req)) return send(res, 401, { error: "Login necessario." });
      const db = await readDb();

      if (url.pathname === "/api/admin/dashboard" && req.method === "GET") {
        const revenue = db.orders.reduce((sum, order) => sum + order.total, 0);
        return send(res, 200, {
          settings: db.settings,
          stats: {
            products: db.products.length,
            orders: db.orders.length,
            revenue: Math.round(revenue * 100) / 100
          },
          products: db.products,
          stories: db.stories || [],
          orders: db.orders,
          coupons: db.coupons || [],
          customRequests: db.customRequests || []
        });
      }

      if (url.pathname === "/api/admin/settings" && req.method === "PATCH") {
        const body = await readJson(req);
        const promotions = {
          ...(db.settings.promotions || {})
        };
        if (body.freeShippingMinItems !== undefined) {
          promotions.freeShippingMinItems = Math.max(1, Number(body.freeShippingMinItems || promotions.freeShippingMinItems || 3));
        }
        db.settings = {
          ...db.settings,
          theme: body.theme || db.settings.theme || "atelier",
          originZipCode: body.originZipCode !== undefined ? String(body.originZipCode || "").replace(/\D/g, "") : db.settings.originZipCode,
          shippingFlatRate: body.shippingFlatRate !== undefined ? Math.max(0, Number(body.shippingFlatRate || 0)) : db.settings.shippingFlatRate,
          shippingProvider: body.shippingProvider || db.settings.shippingProvider || "melhor-envio",
          promotions,
          sender: {
            ...(db.settings.sender || {}),
            name: body.senderName !== undefined ? body.senderName : db.settings.sender?.name,
            email: body.senderEmail !== undefined ? body.senderEmail : db.settings.sender?.email,
            phone: body.senderPhone !== undefined ? String(body.senderPhone || "").replace(/\D/g, "") : db.settings.sender?.phone,
            document: body.senderDocument !== undefined ? String(body.senderDocument || "").replace(/\D/g, "") : db.settings.sender?.document,
            companyDocument: body.senderCompanyDocument !== undefined ? String(body.senderCompanyDocument || "").replace(/\D/g, "") : db.settings.sender?.companyDocument,
            zipCode: body.senderZipCode !== undefined ? String(body.senderZipCode || "").replace(/\D/g, "") : db.settings.sender?.zipCode,
            address: body.senderAddress !== undefined ? body.senderAddress : db.settings.sender?.address,
            number: body.senderNumber !== undefined ? body.senderNumber : db.settings.sender?.number,
            complement: body.senderComplement !== undefined ? body.senderComplement : db.settings.sender?.complement,
            neighborhood: body.senderNeighborhood !== undefined ? body.senderNeighborhood : db.settings.sender?.neighborhood,
            city: body.senderCity !== undefined ? body.senderCity : db.settings.sender?.city,
            state: body.senderState !== undefined ? String(body.senderState || "").toUpperCase().slice(0, 2) : db.settings.sender?.state
          }
        };
        await writeDb(db);
        return send(res, 200, { settings: db.settings });
      }

      if (url.pathname === "/api/admin/hero-slides" && req.method === "POST") {
        const { fields, files } = await readMultipart(req);
        const imageUrl = await saveHeroSlideUpload(files.image);
        if (!imageUrl) return send(res, 400, { error: "Selecione uma imagem." });
        const slide = {
          id: crypto.randomUUID(),
          title: String(fields.title || "").trim() || "Imagem inicial",
          imageUrl,
          createdAt: new Date().toISOString()
        };
        db.settings.heroSlides ||= [];
        db.settings.heroSlides.push(slide);
        await writeDb(db);
        return send(res, 201, { slide, settings: db.settings });
      }

      if (url.pathname.match(/^\/api\/admin\/hero-slides\/[^/]+$/) && req.method === "DELETE") {
        const id = decodeURIComponent(url.pathname.split("/").pop());
        db.settings.heroSlides ||= [];
        const index = db.settings.heroSlides.findIndex((slide) => slide.id === id);
        if (index === -1) return send(res, 404, { error: "Imagem nao encontrada." });
        const [slide] = db.settings.heroSlides.splice(index, 1);
        await removeHeroSlideUpload(slide.imageUrl);
        await writeDb(db);
        return send(res, 200, { slide, settings: db.settings });
      }

      if (url.pathname.match(/^\/api\/admin\/orders\/[^/]+\/shipping\/[^/]+$/) && req.method === "POST") {
        const parts = url.pathname.split("/");
        const id = decodeURIComponent(parts[4]);
        const action = parts[6];
        const body = await readJson(req);
        const order = db.orders.find((item) => item.id === id);
        if (!order) return send(res, 404, { error: "Pedido nao encontrado." });
        order.shippingWorkflow ||= {};

        if (action === "quote") {
          const quote = await quoteOrderShipping({
            db,
            order,
            provider: db.settings.shippingProvider || shippingProvider,
            token: melhorEnvioToken,
            apiBase: melhorEnvioApiBase,
            userAgent: melhorEnvioUserAgent
          });
          order.shippingWorkflow.quotes = quote.quotes || [];
          order.shippingWorkflow.quotedAt = new Date().toISOString();
          await writeDb(db);
          return send(res, 200, { order, quotes: order.shippingWorkflow.quotes });
        }

        if (action === "cart") {
          const quoteId = String(body.quoteId || order.shippingOption?.id || "");
          const quote = (order.shippingWorkflow.quotes || []).find((item) => String(item.id) === quoteId) || order.shippingOption;
          const result = await addOrderToBetterEnvioCart({
            db,
            order,
            quote,
            token: melhorEnvioToken,
            apiBase: melhorEnvioApiBase,
            userAgent: melhorEnvioUserAgent
          });
          order.shippingOption ||= quote ? {
            id: quote.id,
            provider: quote.provider || "melhor-envio",
            carrier: quote.carrier,
            service: quote.service,
            price: Number(order.shipping || quote.price || 0),
            originalPrice: Number(quote.price || order.shipping || 0),
            deliveryDays: Number(quote.deliveryDays || 0)
          } : null;
          order.shippingWorkflow.melhorEnvioOrderId = extractShipmentId(result);
          order.shippingWorkflow.cart = { status: "created", createdAt: new Date().toISOString(), response: result };
          if (order.status !== "awaiting_payment") {
            setOrderStatus(order, "in_production", {
              source: "melhor-envio",
              note: "Etiqueta enviada para o carrinho do Melhor Envio. Pedido liberado para produção."
            });
          }
          await writeDb(db);
          return send(res, 200, { order, result });
        }

        if (action === "checkout") {
          const shipmentOrderId = order.shippingWorkflow.melhorEnvioOrderId;
          if (!shipmentOrderId) return send(res, 400, { error: "Envie a etiqueta para o carrinho do Melhor Envio antes de comprar." });
          const result = await checkoutBetterEnvioShipment({
            shipmentOrderId,
            token: melhorEnvioToken,
            apiBase: melhorEnvioApiBase,
            userAgent: melhorEnvioUserAgent
          });
          order.shippingWorkflow.checkout = { status: "paid", paidAt: new Date().toISOString(), response: result };
          addOrderHistory(order, {
            type: "shipping",
            source: "melhor-envio",
            note: "Etiqueta comprada no Melhor Envio."
          });
          await writeDb(db);
          return send(res, 200, { order, result });
        }

        if (action === "generate") {
          const shipmentOrderId = order.shippingWorkflow.melhorEnvioOrderId;
          if (!shipmentOrderId) return send(res, 400, { error: "Compre a etiqueta antes de gerar." });
          const result = await generateBetterEnvioLabel({
            shipmentOrderId,
            token: melhorEnvioToken,
            apiBase: melhorEnvioApiBase,
            userAgent: melhorEnvioUserAgent
          });
          order.shippingWorkflow.label = { status: "generated", generatedAt: new Date().toISOString(), response: result };
          addOrderHistory(order, {
            type: "shipping",
            source: "melhor-envio",
            note: "Etiqueta gerada e pronta para impressão."
          });
          await writeDb(db);
          return send(res, 200, { order, result });
        }

        if (action === "print") {
          const shipmentOrderId = order.shippingWorkflow.melhorEnvioOrderId;
          if (!shipmentOrderId) return send(res, 400, { error: "Gere a etiqueta antes de imprimir." });
          const result = await printBetterEnvioLabel({
            shipmentOrderId,
            token: melhorEnvioToken,
            apiBase: melhorEnvioApiBase,
            userAgent: melhorEnvioUserAgent
          });
          order.shippingWorkflow.print = { status: "ready", printedAt: new Date().toISOString(), url: findShipmentPrintUrl(result), response: result };
          addOrderHistory(order, {
            type: "shipping",
            source: "melhor-envio",
            note: "Etiqueta impressa ou disponibilizada para impressão."
          });
          await writeDb(db);
          return send(res, 200, { order, result, url: order.shippingWorkflow.print.url });
        }

        return send(res, 404, { error: "Acao de envio nao encontrada." });
      }

      if (url.pathname === "/api/admin/coupons" && req.method === "POST") {
        const body = await readJson(req);
        const code = String(body.code || "").trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "");
        if (!code) return send(res, 400, { error: "Informe um codigo valido." });
        db.coupons ||= [];
        if (db.coupons.some((coupon) => String(coupon.code).toUpperCase() === code)) {
          return send(res, 409, { error: "Ja existe um cupom com esse codigo." });
        }
        const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
        if (expiresAt && Number.isNaN(expiresAt.getTime())) {
          return send(res, 400, { error: "Informe uma data de expiracao valida." });
        }
        const coupon = {
          id: crypto.randomUUID(),
          code,
          type: body.type || "free_shipping",
          value: Number(body.value || 0),
          minItems: Number(body.minItems || 1),
          minSubtotal: Number(body.minSubtotal || 0),
          expiresAt: expiresAt ? expiresAt.toISOString() : "",
          active: true,
          createdAt: new Date().toISOString()
        };
        db.coupons.unshift(coupon);
        await writeDb(db);
        return send(res, 201, { coupon, coupons: db.coupons });
      }

      if (url.pathname === "/api/admin/stories" && req.method === "POST") {
        const { fields, files } = await readMultipart(req);
        const media = await saveStoryUpload(files.media);
        if (!media) return send(res, 400, { error: "Selecione uma foto ou video." });
        const story = storyPayload(fields, {
          id: crypto.randomUUID(),
          createdAt: new Date().toISOString()
        }, media);
        db.stories ||= [];
        db.stories.unshift(story);
        await writeDb(db);
        return send(res, 201, { story, stories: db.stories });
      }

      if (url.pathname.match(/^\/api\/admin\/stories\/[^/]+$/) && req.method === "PUT") {
        const id = decodeURIComponent(url.pathname.split("/").pop());
        const { fields, files } = await readMultipart(req);
        db.stories ||= [];
        const index = db.stories.findIndex((story) => story.id === id);
        if (index === -1) return send(res, 404, { error: "Story nao encontrado." });
        const media = await saveStoryUpload(files.media);
        if (media) await removeStoryUpload(db.stories[index].mediaUrl);
        db.stories[index] = storyPayload(fields, db.stories[index], media);
        await writeDb(db);
        return send(res, 200, { story: db.stories[index], stories: db.stories });
      }

      if (url.pathname.match(/^\/api\/admin\/stories\/[^/]+$/) && req.method === "DELETE") {
        const id = decodeURIComponent(url.pathname.split("/").pop());
        db.stories ||= [];
        const index = db.stories.findIndex((story) => story.id === id);
        if (index === -1) return send(res, 404, { error: "Story nao encontrado." });
        const [story] = db.stories.splice(index, 1);
        await removeStoryUpload(story.mediaUrl);
        await writeDb(db);
        return send(res, 200, { story, stories: db.stories });
      }

      if (url.pathname === "/api/admin/products" && req.method === "POST") {
        const body = await readJson(req);
        const product = productPayload(body, { id: body.id || crypto.randomUUID() }, db.settings);
        db.products.unshift(product);
        await writeDb(db);
        return send(res, 201, { product });
      }

      if (url.pathname.match(/^\/api\/admin\/products\/[^/]+$/) && req.method === "PUT") {
        const id = decodeURIComponent(url.pathname.split("/").pop());
        const body = await readJson(req);
        const index = db.products.findIndex((product) => product.id === id);
        if (index === -1) return send(res, 404, { error: "Produto nao encontrado." });
        db.products[index] = productPayload(body, db.products[index], db.settings);
        await writeDb(db);
        return send(res, 200, { product: db.products[index] });
      }

      if (url.pathname.match(/^\/api\/admin\/products\/[^/]+\/campaign$/) && req.method === "PATCH") {
        const id = decodeURIComponent(url.pathname.split("/").at(-2));
        const body = await readJson(req);
        const product = db.products.find((item) => item.id === id);
        if (!product) return send(res, 404, { error: "Produto nao encontrado." });
        product.campaign = body.clear ? null : campaignPayload(body);
        await writeDb(db);
        return send(res, 200, { product, products: db.products });
      }

      if (url.pathname.match(/^\/api\/admin\/orders\/[^/]+$/) && req.method === "PATCH") {
        const id = decodeURIComponent(url.pathname.split("/").pop());
        const body = await readJson(req);
        const order = db.orders.find((item) => item.id === id);
        if (!order) return send(res, 404, { error: "Pedido nao encontrado." });
        const nextStatus = body.status || order.status;
        setOrderStatus(order, nextStatus, { source: "admin", note: body.note || "" });
        await writeDb(db);
        return send(res, 200, { order });
      }

      if (url.pathname.match(/^\/api\/admin\/custom-requests\/[^/]+$/) && req.method === "PATCH") {
        const id = decodeURIComponent(url.pathname.split("/").pop());
        const body = await readJson(req);
        const request = (db.customRequests || []).find((item) => item.id === id);
        if (!request) return send(res, 404, { error: "Encomenda nao encontrada." });
        request.status = requestStatus(body.status || request.status);
        request.updatedAt = new Date().toISOString();
        const message = String(body.message || "").trim();
        if (message) {
          request.messages ||= [];
          request.messages.push({ id: crypto.randomUUID(), author: "admin", text: message, createdAt: new Date().toISOString() });
        }
        await writeDb(db);
        return send(res, 200, { request, customRequests: db.customRequests || [] });
      }
    }

    return serveStatic(req, res);
  } catch (error) {
    const status = error.status || 500;
    console.error(error);
    return send(res, status, {
      error: error.message || "Erro interno.",
      details: process.env.NODE_ENV === "production" ? undefined : error.details
    });
  }
}

http.createServer(router).listen(port, () => {
  console.log(`Basa 3D Works rodando em http://localhost:${port}`);
});
