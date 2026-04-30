import { promises as fs } from "node:fs";
import path from "node:path";

const dbPath = path.resolve("data", "db.json");
let writeQueue = Promise.resolve();

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function readDb() {
  let lastError;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const raw = await fs.readFile(dbPath, "utf8");
      return JSON.parse(raw.replace(/^\uFEFF/, ""));
    } catch (error) {
      lastError = error;
      if (!["EBUSY", "EPERM"].includes(error.code) && !(error instanceof SyntaxError)) throw error;
      await wait(60 * (attempt + 1));
    }
  }
  throw lastError;
}

export async function writeDb(db) {
  writeQueue = writeQueue.then(async () => {
    const tmp = `${dbPath}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(db, null, 2));
    let lastError;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        await fs.copyFile(tmp, dbPath);
        await fs.unlink(tmp).catch(() => {});
        return;
      } catch (error) {
        lastError = error;
        if (!["EBUSY", "EPERM"].includes(error.code)) throw error;
        await wait(80 * (attempt + 1));
      }
    }
    throw lastError;
  });
  return writeQueue;
}

function paidOrderStatuses() {
  return new Set(["paid", "in_production", "shipped", "completed"]);
}

function dynamicSoldCount(product, orders = []) {
  return orders
    .filter((order) => paidOrderStatuses().has(order.status))
    .flatMap((order) => order.items || [])
    .filter((item) => item.productId === product.id)
    .reduce((sum, item) => sum + Number(item.quantity || 0), 0);
}

function dynamicRating(product) {
  const reviews = (product.reviews || []).filter((review) => review.approved !== false && Number(review.rating || 0) > 0);
  if (!reviews.length) return { average: 0, count: 0 };
  const average = reviews.reduce((sum, review) => sum + Number(review.rating || 0), 0) / reviews.length;
  return { average: Math.round(average * 10) / 10, count: reviews.length };
}

function isRecentlyPosted(product, now = Date.now()) {
  const createdAt = new Date(product.createdAt || 0).getTime();
  if (!Number.isFinite(createdAt) || !createdAt) return false;
  const thirtyDays = 30 * 24 * 60 * 60 * 1000;
  return now - createdAt <= thirtyDays;
}

function campaignIsRunning(campaign, now = Date.now()) {
  if (!campaign?.active) return false;
  const startsAt = campaign.startsAt ? new Date(campaign.startsAt).getTime() : 0;
  const endsAt = campaign.endsAt ? new Date(campaign.endsAt).getTime() : Infinity;
  return now >= startsAt && now <= endsAt;
}

function campaignDiscountPercent(product, now = Date.now()) {
  if (!campaignIsRunning(product.campaign, now)) return 0;
  return Math.max(0, Math.min(95, Number(product.campaign?.discountPercent || 0)));
}

function campaignPrice(product, now = Date.now()) {
  const discount = campaignDiscountPercent(product, now);
  const basePrice = Number(product.price || 0);
  if (!discount) {
    return {
      price: basePrice,
      compareAtPrice: product.compareAtPrice
    };
  }

  return {
    price: Math.round(basePrice * (1 - discount / 100) * 100) / 100,
    compareAtPrice: basePrice,
    campaignDiscountPercent: discount
  };
}

export function publicProduct(product, db = {}) {
  const soldCount = Number(product.soldCount || 0) || dynamicSoldCount(product, db.orders || []);
  const rating = product.rating?.count ? product.rating : dynamicRating(product);
  const pricing = campaignPrice(product);
  return {
    id: product.id,
    createdAt: product.createdAt || "",
    name: product.name,
    slug: product.slug,
    description: product.description,
    longDescription: product.longDescription,
    highlights: product.highlights || [],
    specs: product.specs || {},
    variants: product.variants || { bundleType: "single", colors: [], piecesIncluded: 1 },
    videoUrl: product.videoUrl,
    gallery: product.gallery || [product.image],
    price: pricing.price,
    regularPrice: product.price,
    compareAtPrice: pricing.compareAtPrice,
    campaignDiscountPercent: pricing.campaignDiscountPercent || 0,
    isNew: isRecentlyPosted(product),
    soldCount,
    rating,
    campaign: product.campaign || null,
    shipping: product.shipping || {},
    stock: product.stock,
    status: product.status,
    category: product.category,
    image: product.image
  };
}

export function publicStory(story, products = []) {
  const product = products.find((item) => item.id === story.productId);
  return {
    id: story.id,
    title: story.title || "",
    caption: story.caption || "",
    mediaType: story.mediaType || "image",
    mediaUrl: story.mediaUrl || product?.image || "",
    active: story.active !== false,
    createdAt: story.createdAt,
    product: product ? {
      id: product.id,
      name: product.name,
      slug: product.slug
    } : null
  };
}

function onlyDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function normalizeCustomer(customer = {}) {
  return {
    name: customer.name || "",
    document: onlyDigits(customer.document),
    email: customer.email || "",
    phone: onlyDigits(customer.phone),
    address: {
      zipCode: onlyDigits(customer.zipCode),
      street: customer.street || "",
      number: customer.number || "",
      complement: customer.complement || "",
      neighborhood: customer.neighborhood || "",
      city: customer.city || "",
      state: String(customer.state || "").toUpperCase(),
      ibge: customer.ibge || ""
    }
  };
}

export function findCoupon(db, code) {
  const normalized = String(code || "").trim().toUpperCase();
  if (!normalized) return null;
  return (db.coupons || []).find((coupon) => coupon.active !== false && String(coupon.code || "").toUpperCase() === normalized) || null;
}

export function couponExpired(coupon, now = Date.now()) {
  if (!coupon?.expiresAt) return false;
  const expiresAt = new Date(coupon.expiresAt).getTime();
  return Number.isFinite(expiresAt) && expiresAt <= now;
}

export function couponEligibility({ coupon, itemCount, subtotal }) {
  if (!coupon) return { eligible: false, reason: null };
  if (couponExpired(coupon)) return { eligible: false, reason: "expired" };
  if (itemCount < Number(coupon.minItems || 1)) return { eligible: false, reason: "minItems" };
  if (subtotal < Number(coupon.minSubtotal || 0)) return { eligible: false, reason: "minSubtotal" };
  return { eligible: true, reason: "coupon" };
}

export function orderFromCart({ db, customer, items, shippingOption, coupon }) {
  const productsById = new Map(db.products.map((product) => [product.id, product]));
  const lines = items.map((item) => {
    const product = productsById.get(item.productId);
    if (!product || product.status !== "active") {
      throw Object.assign(new Error("Produto indisponivel."), { status: 400 });
    }

    const quantity = Math.max(1, Math.min(Number(item.quantity || 1), product.stock));
    const pricing = campaignPrice(product);
    return {
      productId: product.id,
      name: product.name,
      variant: {
        color: item.color || ""
      },
      quantity,
      unitPrice: pricing.price,
      regularUnitPrice: product.price,
      campaignDiscountPercent: pricing.campaignDiscountPercent || 0,
      total: Math.round(pricing.price * quantity * 100) / 100
    };
  });

  if (!lines.length) {
    throw Object.assign(new Error("Carrinho vazio."), { status: 400 });
  }

  const subtotal = Math.round(lines.reduce((sum, line) => sum + line.total, 0) * 100) / 100;
  const itemCount = lines.reduce((sum, line) => sum + line.quantity, 0);
  const allItemsFreeShipping = lines.every((line) => productsById.get(line.productId)?.shipping?.sellerPaysShipping);
  const productQuantityFreeShipping = lines.some((line) => {
    const minQuantity = Number(productsById.get(line.productId)?.shipping?.freeShippingMinQuantity || 0);
    return minQuantity > 0 && line.quantity >= minQuantity;
  });
  const promotions = db.settings.promotions || {};
  const normalizedCoupon = String(coupon || "").trim().toUpperCase();
  const couponRecord = findCoupon(db, normalizedCoupon);
  const couponStatus = couponEligibility({ coupon: couponRecord, itemCount, subtotal });
  const freeShippingByCoupon = couponStatus.eligible && couponRecord?.type === "free_shipping";
  const freeShippingByCombo = itemCount >= Number(promotions.freeShippingMinItems || Infinity);
  const baseShipping = shippingOption ? Math.max(0, Number(shippingOption.price || 0)) : db.settings.shippingFlatRate;
  const shipping = freeShippingByCoupon || freeShippingByCombo || allItemsFreeShipping || productQuantityFreeShipping ? 0 : baseShipping;
  const total = Math.round((subtotal + shipping) * 100) / 100;
  const seller = db.products.find((product) => product.id === lines[0].productId).seller;

  return {
    id: `BASA-${Date.now()}`,
    createdAt: new Date().toISOString(),
    status: "created",
    customer: normalizeCustomer(customer),
    items: lines,
    subtotal,
    shipping,
    shippingOption: shippingOption ? {
      id: shippingOption.id,
      provider: shippingOption.provider || "mock",
      carrier: shippingOption.carrier,
      service: shippingOption.service,
      price: shipping,
      originalPrice: baseShipping,
      deliveryDays: Number(shippingOption.deliveryDays || 0)
    } : null,
    promotion: {
      coupon: normalizedCoupon,
      couponId: couponRecord?.id || null,
      freeShipping: freeShippingByCoupon || freeShippingByCombo || allItemsFreeShipping || productQuantityFreeShipping,
      reason: freeShippingByCoupon ? "coupon" : freeShippingByCombo ? "combo" : allItemsFreeShipping ? "seller_pays_shipping" : productQuantityFreeShipping ? "product_quantity" : null
    },
    total,
    seller
  };
}
