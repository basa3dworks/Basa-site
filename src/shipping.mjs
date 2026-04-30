import { money } from "./payment/split.mjs";

function onlyDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function normalizeState(value) {
  return String(value || "").trim().toUpperCase().slice(0, 2);
}

function cartProducts({ db, items }) {
  const productsById = new Map(db.products.map((product) => [product.id, product]));
  return items.map((item) => {
    const product = productsById.get(item.productId);
    if (!product || product.status !== "active") {
      throw Object.assign(new Error("Produto indisponivel para frete."), { status: 400 });
    }

    return {
      product,
      quantity: Math.max(1, Number(item.quantity || 1))
    };
  });
}

function betterShippingProduct({ product, quantity }) {
  const shipping = product.shipping || {};
  return {
    id: product.id,
    width: Number(shipping.widthCm || 12),
    height: Number(shipping.heightCm || 8),
    length: Number(shipping.lengthCm || 18),
    weight: Number(shipping.weightKg || 0.3),
    insurance_value: Number(product.price || 0),
    quantity
  };
}

function authHeaders({ token, userAgent }) {
  return {
    "Accept": "application/json",
    "Authorization": `Bearer ${token}`,
    "Content-Type": "application/json",
    "User-Agent": userAgent || "Basa 3D Works (contato@basa3dworks.com)"
  };
}

async function betterEnvioRequest({ apiBase, token, userAgent, path, method = "POST", body }) {
  if (!token) {
    throw Object.assign(new Error("Token do Melhor Envio nao configurado."), { status: 400 });
  }

  const response = await fetch(`${apiBase.replace(/\/$/, "")}${path}`, {
    method,
    headers: authHeaders({ token, userAgent }),
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw Object.assign(new Error(data.message || data.error || "Erro na integracao com Melhor Envio."), {
      status: response.status,
      details: data
    });
  }
  return data;
}

function senderFromSettings(settings = {}) {
  const sender = settings.sender || {};
  const data = {
    name: sender.name || settings.storeName || "Basa 3D Works",
    phone: onlyDigits(sender.phone),
    email: sender.email || "",
    document: onlyDigits(sender.document),
    company_document: onlyDigits(sender.companyDocument || sender.document),
    address: sender.address || "",
    complement: sender.complement || "",
    number: sender.number || "",
    district: sender.neighborhood || "",
    city: sender.city || "",
    state_abbr: normalizeState(sender.state),
    country_id: "BR",
    postal_code: onlyDigits(sender.zipCode || settings.originZipCode)
  };
  const missing = ["phone", "email", "document", "address", "number", "district", "city", "state_abbr", "postal_code"].filter((key) => !data[key]);
  if (missing.length) {
    throw Object.assign(new Error("Complete os dados do remetente na aba Envio antes de gerar etiqueta."), { status: 400, details: { missing } });
  }
  return data;
}

function recipientFromOrder(order) {
  const address = order.customer?.address || {};
  return {
    name: order.customer?.name || "",
    phone: onlyDigits(order.customer?.phone),
    email: order.customer?.email || "",
    document: onlyDigits(order.customer?.document),
    address: address.street || "",
    complement: address.complement || "",
    number: address.number || "",
    district: address.neighborhood || "",
    city: address.city || "",
    state_abbr: normalizeState(address.state),
    country_id: "BR",
    postal_code: onlyDigits(address.zipCode)
  };
}

function volumeFromOrder({ db, order }) {
  const productsById = new Map(db.products.map((product) => [product.id, product]));
  const lines = (order.items || []).map((item) => ({
    item,
    product: productsById.get(item.productId)
  })).filter((line) => line.product);
  return {
    height: Math.max(...lines.map((line) => Number(line.product.shipping?.heightCm || 8)), 8),
    width: Math.max(...lines.map((line) => Number(line.product.shipping?.widthCm || 12)), 12),
    length: Math.max(...lines.map((line) => Number(line.product.shipping?.lengthCm || 18)), 18),
    weight: Math.max(lines.reduce((sum, line) => sum + Number(line.product.shipping?.weightKg || 0.3) * Number(line.item.quantity || 1), 0), 0.1)
  };
}

function declarationProducts(order) {
  return (order.items || []).map((item) => ({
    name: item.name,
    quantity: Number(item.quantity || 1),
    unitary_value: Number(item.unitPrice || 0)
  }));
}

function isJtExpressQuote(quote) {
  const carrier = String(quote.carrier || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  return carrier.includes("j&t") || carrier.includes("j t") || carrier.includes("jt express");
}

function mockQuotes({ db, items, zipCode }) {
  const lines = cartProducts({ db, items });
  const weight = lines.reduce((sum, line) => sum + Number(line.product.shipping?.weightKg || 0.3) * line.quantity, 0);
  const cepNumber = Number(onlyDigits(zipCode).slice(0, 5) || 0);
  const distanceFactor = Math.min(32, Math.max(0, cepNumber / 2600));
  const base = Math.max(db.settings.shippingFlatRate || 24.9, 15 + weight * 10 + distanceFactor);

  return [
    {
      id: "mock-jt-express",
      provider: "mock",
      carrier: "J&T Express",
      service: "Entrega padrão",
      price: money(base),
      deliveryDays: Math.max(4, Math.round(3 + distanceFactor / 4)),
      note: "Cotacao temporaria da J&T Express ate conectar o Melhor Envio."
    }
  ];
}

function normalizeBetterEnvioResponse(data) {
  return (Array.isArray(data) ? data : []).filter((item) => !item.error && item.price).map((item) => ({
    id: String(item.id || `${item.company?.name}-${item.name}`),
    provider: "melhor-envio",
    carrier: item.company?.name || "Transportadora",
    service: item.name || "Entrega",
    price: Number(item.custom_price || item.price),
    deliveryDays: Number(item.custom_delivery_time || item.delivery_time || 0),
    packages: item.packages || []
  }));
}

export async function quoteShipping({ db, items, zipCode, provider = "mock", token = "", apiBase = "https://sandbox.melhorenvio.com.br", userAgent = "" }) {
  const destinationZip = onlyDigits(zipCode);
  if (destinationZip.length !== 8) {
    throw Object.assign(new Error("Informe um CEP valido para cotar o frete."), { status: 400 });
  }

  if (provider !== "melhor-envio" || !token) {
    return {
      provider: "mock",
      originZipCode: db.settings.originZipCode,
      destinationZipCode: destinationZip,
      quotes: mockQuotes({ db, items, zipCode: destinationZip })
    };
  }

  const products = cartProducts({ db, items }).map(betterShippingProduct);
  const response = await fetch(`${apiBase.replace(/\/$/, "")}/api/v2/me/shipment/calculate`, {
    method: "POST",
    headers: authHeaders({ token, userAgent }),
    body: JSON.stringify({
      from: { postal_code: onlyDigits(db.settings.originZipCode) },
      to: { postal_code: destinationZip },
      products,
      options: {
        receipt: false,
        own_hand: false,
        insurance_value: products.reduce((sum, item) => sum + item.insurance_value * item.quantity, 0),
        reverse: false,
        non_commercial: false
      }
    })
  });

  const data = await response.json();
  if (!response.ok) {
    throw Object.assign(new Error(data.message || "Nao foi possivel cotar frete no Melhor Envio."), { status: response.status });
  }

  return {
    provider: "melhor-envio",
    originZipCode: db.settings.originZipCode,
    destinationZipCode: destinationZip,
    quotes: (() => {
      const quotes = normalizeBetterEnvioResponse(data);
      const jtQuotes = quotes.filter(isJtExpressQuote);
      return jtQuotes.length ? jtQuotes : quotes;
    })()
  };
}

export async function quoteOrderShipping({ db, order, provider = "mock", token = "", apiBase = "https://sandbox.melhorenvio.com.br", userAgent = "" }) {
  const items = (order.items || []).map((item) => ({ productId: item.productId, quantity: item.quantity }));
  return quoteShipping({
    db,
    items,
    zipCode: order.customer?.address?.zipCode,
    provider,
    token,
    apiBase,
    userAgent
  });
}

export async function addOrderToBetterEnvioCart({ db, order, quote, token = "", apiBase = "https://sandbox.melhorenvio.com.br", userAgent = "" }) {
  const selectedQuote = quote || order.shippingOption;
  if (!selectedQuote?.id) {
    throw Object.assign(new Error("Cote e selecione um servico de envio antes de criar a etiqueta."), { status: 400 });
  }

  const volume = volumeFromOrder({ db, order });
  const products = declarationProducts(order);
  const insuranceValue = products.reduce((sum, item) => sum + Number(item.unitary_value || 0) * Number(item.quantity || 1), 0);
  const body = {
    service: Number(selectedQuote.id),
    agency: selectedQuote.agency ? Number(selectedQuote.agency) : undefined,
    from: senderFromSettings(db.settings),
    to: recipientFromOrder(order),
    products,
    volumes: [{
      height: volume.height,
      width: volume.width,
      length: volume.length,
      weight: volume.weight
    }],
    options: {
      receipt: false,
      own_hand: false,
      insurance_value: insuranceValue,
      reverse: false,
      non_commercial: true,
      platform: db.settings.storeName || "Basa 3D Works",
      tags: [{ tag: order.id, url: "" }]
    }
  };

  return betterEnvioRequest({
    apiBase,
    token,
    userAgent,
    path: "/api/v2/me/cart",
    body
  });
}

export async function checkoutBetterEnvioShipment({ shipmentOrderId, token = "", apiBase = "https://sandbox.melhorenvio.com.br", userAgent = "" }) {
  return betterEnvioRequest({
    apiBase,
    token,
    userAgent,
    path: "/api/v2/me/shipment/checkout",
    body: { orders: [shipmentOrderId] }
  });
}

export async function generateBetterEnvioLabel({ shipmentOrderId, token = "", apiBase = "https://sandbox.melhorenvio.com.br", userAgent = "" }) {
  return betterEnvioRequest({
    apiBase,
    token,
    userAgent,
    path: "/api/v2/me/shipment/generate",
    body: { orders: [shipmentOrderId] }
  });
}

export async function printBetterEnvioLabel({ shipmentOrderId, token = "", apiBase = "https://sandbox.melhorenvio.com.br", userAgent = "" }) {
  return betterEnvioRequest({
    apiBase,
    token,
    userAgent,
    path: "/api/v2/me/shipment/print",
    body: { mode: "public", orders: [shipmentOrderId] }
  });
}
