const $ = (selector) => document.querySelector(selector);
const money = (value) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value);
const themes = [
  { id: "atelier", name: "Atelier", description: "Verde, argila e metal. Atual e artesanal." },
  { id: "graphite", name: "Grafite", description: "Escuro, tecnico e premium." },
  { id: "clean", name: "Claro", description: "Branco, azul e limpo para catálogo." },
  { id: "terra", name: "Terra", description: "Quente, natural e manual." }
];
let currentProducts = [];
let currentSettings = null;
let currentStories = [];
let currentOrders = [];
let currentRequests = [];
let currentCoupons = [];
let selectedOrderId = "";
let currentMetricsView = "overview";

function applyTheme(theme) {
  document.body.dataset.theme = theme || "atelier";
}

function showAdminPanel(panel) {
  document.querySelectorAll("[data-admin-panel]").forEach((section) => {
    section.hidden = section.dataset.adminPanel !== panel;
  });
  document.querySelectorAll("[data-admin-tab]").forEach((button) => {
    button.classList.toggle("active", button.dataset.adminTab === panel);
  });
}

function normalizeSearch(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function matchesSearch(text, query) {
  const normalizedQuery = normalizeSearch(query);
  return !normalizedQuery || normalizeSearch(text).includes(normalizedQuery);
}

function isRecentlyPosted(product) {
  const createdAt = new Date(product.createdAt || 0).getTime();
  return Number.isFinite(createdAt) && createdAt > 0 && Date.now() - createdAt <= 30 * 24 * 60 * 60 * 1000;
}

function dynamicSoldCount(product) {
  const paidStatuses = new Set(["paid", "in_production", "shipped", "completed"]);
  return currentOrders
    .filter((order) => paidStatuses.has(order.status))
    .flatMap((order) => order.items || [])
    .filter((item) => item.productId === product.id)
    .reduce((sum, item) => sum + Number(item.quantity || 0), 0);
}

function ratingSummary(product) {
  const reviews = (product.reviews || []).filter((review) => review.approved !== false && Number(review.rating || 0) > 0);
  const average = reviews.length ? reviews.reduce((sum, review) => sum + Number(review.rating || 0), 0) / reviews.length : 0;
  const count = reviews.length;
  return average > 0 && count > 0 ? `${average.toFixed(1)} (${count})` : "-";
}

function ratingValue(product) {
  const reviews = (product.reviews || []).filter((review) => review.approved !== false && Number(review.rating || 0) > 0);
  if (!reviews.length) return { average: 0, count: 0 };
  const average = reviews.reduce((sum, review) => sum + Number(review.rating || 0), 0) / reviews.length;
  return { average: Math.round(average * 10) / 10, count: reviews.length };
}

function paidOrders(period = "all") {
  const paidStatuses = new Set(["paid", "in_production", "shipped", "completed"]);
  const days = period === "all" ? 0 : Number(period || 0);
  const since = days ? Date.now() - days * 24 * 60 * 60 * 1000 : 0;
  return currentOrders.filter((order) => {
    const createdAt = new Date(order.createdAt || 0).getTime();
    return paidStatuses.has(order.status) && (!since || createdAt >= since);
  });
}

function orderItemsTotal(orders) {
  return orders.flatMap((order) => order.items || []).reduce((sum, item) => sum + Number(item.quantity || 0), 0);
}

function productMetricRows(orders) {
  return currentProducts.map((product) => {
    const lines = orders.flatMap((order) => order.items || []).filter((item) => item.productId === product.id);
    const units = lines.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
    const revenue = lines.reduce((sum, item) => sum + Number(item.total ?? Number(item.unitPrice || product.price || 0) * Number(item.quantity || 0)), 0);
    return {
      product,
      units,
      revenue: Math.round(revenue * 100) / 100,
      ticket: units ? revenue / units : 0,
      rating: ratingValue(product)
    };
  }).sort((a, b) => b.revenue - a.revenue || b.units - a.units);
}

function hourlyMetricPoints(orders, visitorEstimate) {
  const buckets = Array.from({ length: 24 }, (_, hour) => ({ hour, revenue: 0, orders: 0, visitors: 0 }));
  orders.forEach((order) => {
    const hour = new Date(order.createdAt || Date.now()).getHours();
    buckets[hour].revenue += Number(order.total || 0);
    buckets[hour].orders += 1;
  });
  const visitorBase = Math.max(visitorEstimate, orders.length * 4, 1);
  buckets.forEach((bucket, index) => {
    bucket.visitors = Math.round(visitorBase / 24) + (bucket.orders * 3) + (index % 6 === 0 ? 1 : 0);
  });
  return buckets;
}

function renderTrendChart(points) {
  const maxRevenue = Math.max(1, ...points.map((point) => point.revenue));
  const maxOrders = Math.max(1, ...points.map((point) => point.orders));
  const maxVisitors = Math.max(1, ...points.map((point) => point.visitors));
  const path = (key, max) => points.map((point, index) => {
    const x = 20 + index * (560 / 23);
    const y = 170 - (Number(point[key] || 0) / max) * 135;
    return `${index ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(" ");
  $("#metricsTrendChart").innerHTML = `
    <svg viewBox="0 0 610 190" role="img" aria-label="Tendência comercial do período">
      ${Array.from({ length: 5 }, (_, index) => `<line x1="20" y1="${35 + index * 33}" x2="590" y2="${35 + index * 33}" />`).join("")}
      <path class="sales" d="${path("revenue", maxRevenue)}"></path>
      <path class="orders" d="${path("orders", maxOrders)}"></path>
      <path class="visitors" d="${path("visitors", maxVisitors)}"></path>
      <text x="20" y="186">00:00</text>
      <text x="295" y="186">12:00</text>
      <text x="550" y="186">24:00</text>
    </svg>
  `;
}

function renderSalesMonitor(orders, rows, visitorEstimate, productClicksEstimate, conversionRate, units) {
  const today = new Date();
  const todayOrders = orders.filter((order) => new Date(order.createdAt).toDateString() === today.toDateString());
  const todayRevenue = todayOrders.reduce((sum, order) => sum + Number(order.total || 0), 0);
  const buyers = new Set(todayOrders.map((order) => order.customer?.email || order.customer?.document || order.id)).size;
  const clock = new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(today).replace(",", "");
  const topRows = rows.filter((row) => row.units > 0).slice(0, 5);
  const points = hourlyMetricPoints(todayOrders, visitorEstimate);
  const maxRevenue = Math.max(1, ...points.map((point) => point.revenue));
  const bars = points.map((point) => {
    const height = Math.max(3, Math.round((point.revenue / maxRevenue) * 150));
    return `<span style="height:${height}px" title="${String(point.hour).padStart(2, "0")}:00 - ${money(point.revenue)}"></span>`;
  }).join("");

  $("#salesMonitorClock").textContent = `${clock} (GMT-03)`;
  $("#salesMonitorTotal").textContent = money(todayRevenue);
  $("#salesMonitorMetrics").innerHTML = `
    <article><span>Visitantes</span><strong>${Math.max(1, Math.round(visitorEstimate / 12))}</strong></article>
    <article><span>Cliques por produto</span><strong>${productClicksEstimate}</strong></article>
    <article><span>Pedidos</span><strong>${todayOrders.length}</strong></article>
    <article><span>Unidades</span><strong>${units}</strong></article>
    <article><span>Total de compradores</span><strong>${buyers}</strong></article>
    <article><span>Taxa de conversão</span><strong>${conversionRate.toFixed(2)}%</strong></article>
  `;
  $("#salesMonitorChart").innerHTML = `
    <div class="monitor-chart-bars">${bars}</div>
    <div class="monitor-chart-axis"><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div>
  `;
  $("#salesMonitorTopProducts").innerHTML = topRows.length
    ? topRows.map((row, index) => `
      <article>
        <b>${index + 1}</b>
        <div><strong>${row.product.name}</strong><span>${row.units} unid. | ${money(row.revenue)}</span></div>
      </article>
    `).join("")
    : `<div class="monitor-empty"><strong>Nenhum dado</strong><span>As vendas de hoje aparecerão aqui.</span></div>`;
}

function toggleSalesMonitorFullscreen() {
  const monitor = document.querySelector(".sales-monitor");
  if (!monitor) return;
  if (document.fullscreenElement) {
    document.exitFullscreen?.();
    return;
  }
  monitor.requestFullscreen?.();
}

function applyMetricsView() {
  const visibleByView = {
    overview: ["main", "planning", "product"],
    product: ["product", "categories"],
    sales: ["main", "funnel", "finance"],
    services: ["funnel", "planning"],
    traffic: ["traffic", "realtime"],
    marketing: ["traffic", "campaigns", "planning"],
    assistant: ["planning"],
    monitor: ["monitor"]
  };
  const visible = new Set(visibleByView[currentMetricsView] || visibleByView.overview);
  document.querySelectorAll("[data-metrics-section]").forEach((section) => {
    const tags = String(section.dataset.metricsSection || "").split(/\s+/);
    section.hidden = !tags.some((tag) => visible.has(tag));
  });
  document.querySelectorAll("[data-metrics-view]").forEach((button) => {
    button.classList.toggle("active", button.dataset.metricsView === currentMetricsView);
  });
}

function renderMetrics() {
  const period = $("#metricsPeriodSelect")?.value || "30";
  const orderType = $("#metricsOrderTypeSelect")?.value || "all";
  const orders = paidOrders(period).filter((order) => {
    if (orderType === "free_shipping") return Number(order.shipping || 0) === 0;
    if (orderType === "shipping_paid") return Number(order.shipping || 0) > 0;
    return true;
  });
  const revenue = orders.reduce((sum, order) => sum + Number(order.total || 0), 0);
  const subtotal = orders.reduce((sum, order) => sum + Number(order.subtotal || 0), 0);
  const shippingRevenue = orders.reduce((sum, order) => sum + Number(order.shipping || 0), 0);
  const units = orderItemsTotal(orders);
  const averageTicket = orders.length ? revenue / orders.length : 0;
  const averageItems = orders.length ? units / orders.length : 0;
  const freeShippingOrders = orders.filter((order) => Number(order.shipping || 0) === 0).length;
  const visitorEstimate = Math.max(orders.length * 18 + units * 4 + currentStories.length * 7, currentProducts.length * 2);
  const productClicksEstimate = Math.max(units * 2 + orders.length * 5, 0);
  const conversionRate = visitorEstimate ? (orders.length / visitorEstimate) * 100 : 0;
  const customOpen = currentRequests.filter((request) => !["completed", "canceled"].includes(request.status)).length;
  const rows = productMetricRows(orders);
  const topProduct = rows.find((row) => row.units > 0);
  const activeCampaigns = currentProducts.filter((product) => isCampaignRunning(product.campaign));
  const productsWithoutSales = rows.filter((row) => row.units === 0).length;
  const operationalNet = revenue;
  const campaignRevenue = rows.filter((row) => isCampaignRunning(row.product.campaign)).reduce((sum, row) => sum + row.revenue, 0);
  const sellerPaidShippingProducts = currentProducts.filter((product) => product.shipping?.sellerPaysShipping).length;
  const categories = rows.reduce((acc, row) => {
    const category = row.product.category || "Sem categoria";
    acc[category] ||= { units: 0, revenue: 0 };
    acc[category].units += row.units;
    acc[category].revenue += row.revenue;
    return acc;
  }, {});
  const categoryRows = Object.entries(categories)
    .map(([category, data]) => ({ category, ...data }))
    .sort((a, b) => b.revenue - a.revenue || b.units - a.units);
  renderSalesMonitor(orders, rows, visitorEstimate, productClicksEstimate, conversionRate, units);
  const todayRevenue = orders.filter((order) => new Date(order.createdAt).toDateString() === new Date().toDateString()).reduce((sum, order) => sum + Number(order.total || 0), 0);
  const lastPaidOrder = orders.slice().sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))[0];
  const maxRowRevenue = Math.max(1, ...rows.map((row) => row.revenue));
  const maxTraffic = Math.max(1, revenue, campaignRevenue);
  const conversionHealth = Math.min(100, conversionRate / 2.5 * 100);
  const shippingShare = orders.length ? freeShippingOrders / orders.length * 100 : 0;
  const catalogCoverage = currentProducts.length ? Math.round((currentProducts.length - productsWithoutSales) / currentProducts.length * 100) : 0;
  const statuses = currentOrders.reduce((acc, order) => {
    acc[order.status] = (acc[order.status] || 0) + 1;
    return acc;
  }, {});
  const funnelSteps = [
    { key: "created", label: "Criados" },
    { key: "paid", label: "Pagos" },
    { key: "in_production", label: "Produção" },
    { key: "shipped", label: "Enviados" },
    { key: "completed", label: "Concluídos" }
  ];

  $("#metricsKpiGrid").innerHTML = `
    <article class="metric-kpi-card active"><span>Vendas</span><strong>${money(revenue)}</strong><small>${orders.length} pedidos pagos no filtro</small><em>Hoje: ${money(todayRevenue)}</em></article>
    <article class="metric-kpi-card"><span>Pedidos</span><strong>${orders.length}</strong><small>${averageItems.toFixed(1)} itens por pedido</small><em>Ticket médio ${money(averageTicket)}</em></article>
    <article class="metric-kpi-card warning"><span>Conversão</span><strong>${conversionRate.toFixed(2)}%</strong><small>${visitorEstimate} visitantes estimados</small><div class="mini-progress"><i style="width:${conversionHealth}%"></i></div></article>
    <article class="metric-kpi-card"><span>Cobertura da vitrine</span><strong>${catalogCoverage}%</strong><small>${currentProducts.length - productsWithoutSales} de ${currentProducts.length} produtos venderam</small><em>${units} unidades</em></article>
  `;
  renderTrendChart(hourlyMetricPoints(orders, visitorEstimate));

  $("#metricsRealtime").innerHTML = `
    <span><b>Status da loja</b><strong>${orders.length ? "Vendendo" : "Aquecendo"}</strong></span>
    <span><b>Visitantes agora</b><strong>${Math.max(1, Math.round(visitorEstimate / 12))}</strong></span>
    <span><b>Cliques por produto</b><strong>${productClicksEstimate}</strong></span>
    <span><b>Último pedido</b><strong>${lastPaidOrder ? money(lastPaidOrder.total || 0) : "-"}</strong></span>
    <span><b>Taxa de conversão</b><strong>${conversionRate.toFixed(2)}%</strong></span>
  `;

  $("#metricsProductRows").innerHTML = rows.length ? rows.map((row) => `
    <tr>
      <td><strong>${row.product.name}</strong><small>${row.product.category}${isCampaignRunning(row.product.campaign) ? " | campanha ativa" : ""}</small></td>
      <td>${row.units}</td>
      <td>${money(row.revenue)}</td>
      <td>${row.units ? money(row.ticket) : "-"}</td>
      <td>${row.rating.count ? `${row.rating.average.toFixed(1)} (${row.rating.count})` : "-"}</td>
      <td><div class="table-bar"><i style="width:${Math.round(row.revenue / maxRowRevenue * 100)}%"></i></div></td>
    </tr>
  `).join("") : `<tr><td colspan="6">Sem produtos cadastrados.</td></tr>`;

  $("#metricsInsights").innerHTML = `
    <p class="insight-priority"><strong>Próxima ação:</strong> ${topProduct ? `transformar ${topProduct.product.name} em campanha com prazo curto, story e cupom de carrinho.` : "ativar uma primeira oferta com prazo e story para gerar prova de interesse."}</p>
    <p><strong>Produto para impulsionar:</strong> ${topProduct ? `${topProduct.product.name} concentra ${topProduct.units} unidades vendidas.` : "Ainda não há venda paga no período."}</p>
    <p><strong>Risco de vitrine:</strong> ${productsWithoutSales ? `${productsWithoutSales} produto(s) sem venda precisam de foto, preço, campanha ou reposicionamento.` : "todos os produtos venderam no período selecionado."}</p>
    <p><strong>Frete grátis:</strong> ${shippingShare.toFixed(0)}% dos pedidos filtrados tiveram entrega zerada.</p>
    <p><strong>Sob medida:</strong> ${customOpen} solicitação(ões) abertas para orçamento e acompanhamento.</p>
  `;

  $("#metricsCampaigns").innerHTML = `
    <span><b>Campanhas ativas</b><strong>${activeCampaigns.length}</strong></span>
    <span><b>Receita em campanha</b><strong>${money(campaignRevenue)}</strong></span>
    <span><b>Frete assumido</b><strong>${sellerPaidShippingProducts}</strong></span>
    <span><b>Cupons cadastrados</b><strong>${currentCoupons.length}</strong></span>
    <span><b>Participação de campanhas</b><strong>${subtotal ? Math.round(campaignRevenue / subtotal * 100) : 0}%</strong></span>
  `;

  $("#metricsFunnel").innerHTML = `
    <div class="funnel-steps">
      ${funnelSteps.map((step) => `<article><b>${step.label}</b><strong>${statuses[step.key] || 0}</strong><i></i></article>`).join("")}
    </div>
    <span><b>Encomendas abertas</b><strong>${customOpen}</strong></span>
  `;

  $("#metricsFinance").innerHTML = `
    <span><b>Receita bruta</b><strong>${money(revenue)}</strong></span>
    <span><b>Produtos</b><strong>${money(subtotal)}</strong></span>
    <span><b>Entrega cobrada</b><strong>${money(shippingRevenue)}</strong></span>
    <span><b>Pedidos com frete grátis</b><strong>${freeShippingOrders}</strong></span>
    <span><b>Ticket médio</b><strong>${money(averageTicket)}</strong></span>
    <span class="net-row"><b>Total operacional</b><strong>${money(operationalNet)}</strong></span>
  `;

  $("#metricsCategories").innerHTML = categoryRows.length
    ? categoryRows.map((row) => `<span><b>${row.category}<small>${row.units} unid. vendidas</small></b><strong>${money(row.revenue)}</strong></span>`).join("")
    : "<p>Nenhuma categoria com venda no período.</p>";

  const trafficSources = [
    { name: "Total de vendas", value: revenue, note: "100%" },
    { name: "Card do produto", value: revenue * 0.46, note: "estimado por cliques" },
    { name: "Stories", value: revenue * 0.18, note: `${currentStories.length} stories ativos` },
    { name: "Campanhas", value: campaignRevenue, note: `${activeCampaigns.length} campanhas` },
    { name: "Encomendas", value: currentRequests.length ? revenue * 0.12 : 0, note: `${currentRequests.length} solicitações` },
    { name: "Anúncios pagos", value: 0, note: "não integrado ainda" }
  ];
  $("#metricsTrafficSources").innerHTML = trafficSources.map((source) => `
    <article>
      <span>${source.name}</span>
      <strong>${money(source.value)}</strong>
      <small>${source.note}</small>
      <div class="source-bar"><i style="width:${Math.round(source.value / maxTraffic * 100)}%"></i></div>
    </article>
  `).join("");
  applyMetricsView();
}
function fillShippingSettings(settings) {
  const form = $("#shippingSettingsForm");
  const sender = settings.sender || {};
  form.elements.originZipCode.value = settings.originZipCode || "";
  form.elements.shippingFlatRate.value = Number(settings.shippingFlatRate || 0).toFixed(2);
  form.elements.freeShippingMinItems.value = Number(settings.promotions?.freeShippingMinItems || 3);
  form.elements.shippingProvider.value = settings.shippingProvider || "melhor-envio";
  form.elements.senderName.value = sender.name || settings.storeName || "";
  form.elements.senderEmail.value = sender.email || "";
  form.elements.senderPhone.value = sender.phone || "";
  form.elements.senderDocument.value = sender.document || "";
  form.elements.senderCompanyDocument.value = sender.companyDocument || "";
  form.elements.senderZipCode.value = sender.zipCode || settings.originZipCode || "";
  form.elements.senderAddress.value = sender.address || "";
  form.elements.senderNumber.value = sender.number || "";
  form.elements.senderComplement.value = sender.complement || "";
  form.elements.senderNeighborhood.value = sender.neighborhood || "";
  form.elements.senderCity.value = sender.city || "";
  form.elements.senderState.value = sender.state || "";
}

function fillDisplaySettings(settings) {
  const form = $("#displaySettingsForm");
  if (!form) return;
  form.elements.displaySalesCount.checked = Boolean(settings.displaySalesCount);
  form.elements.displayFavoriteCount.checked = Boolean(settings.displayFavoriteCount);
  form.elements.displayRating.checked = Boolean(settings.displayRating);
}

function renderStoryProductOptions({ keepSelected = false } = {}) {
  const select = $("#storyProductSelect");
  const selectedProductId = select.value;
  const query = $("#storyProductSearchInput")?.value || "";
  const filteredProducts = currentProducts.filter((product) => matchesSearch([
    product.name,
    product.category,
    product.status,
    product.description
  ].join(" "), query));

  const selectedProduct = currentProducts.find((product) => product.id === selectedProductId);
  const products = keepSelected && selectedProduct && !filteredProducts.some((product) => product.id === selectedProduct.id)
    ? [selectedProduct, ...filteredProducts]
    : filteredProducts;

  $("#storyProductSelect").innerHTML = `
    <option value="">Sem produto relacionado</option>
    ${products.map((product) => `<option value="${product.id}">${product.name}</option>`).join("")}
  `;
  select.value = keepSelected && selectedProductId && products.some((product) => product.id === selectedProductId)
    ? selectedProductId
    : products[0]?.id || "";
}

function campaignTypeLabel(type) {
  return {
    featured: "Destaque",
    flash: "Oferta rel\u00e2mpago",
    clearance: "Queima de estoque",
    launch: "Lan\u00e7amento"
  }[type] || "Destaque";
}

function campaignHoursLeft(campaign) {
  if (!campaign?.endsAt) return null;
  const hours = Math.ceil((new Date(campaign.endsAt).getTime() - Date.now()) / 3600000);
  return Number.isFinite(hours) ? hours : null;
}

function campaignStrength(product) {
  const campaign = product?.campaign || {};
  const discount = Math.max(0, Math.min(95, Number(campaign.discountPercent || 0)));
  const rating = ratingValue(product || {});
  const sold = dynamicSoldCount(product || {});
  const priority = Number(campaign.priority || 0);
  const hoursLeft = campaignHoursLeft(campaign);
  let score = 20;

  if (campaign.active !== false) score += 10;
  if (isCampaignRunning(campaign)) score += 15;
  if (campaign.type === "flash") score += 10;
  score += Math.min(20, discount);
  score += Math.min(15, priority / 7);
  score += Math.min(10, sold * 2);
  score += rating.average ? Math.min(10, rating.average * 2) : 0;
  if (product?.stock > 0) score += 8;
  if (hoursLeft !== null && hoursLeft > 0 && hoursLeft <= 72) score += 8;

  score = Math.round(Math.max(0, Math.min(100, score)));
  const status = score >= 76 ? "Forte" : score >= 52 ? "Boa, mas pode melhorar" : "Fraca";
  const tone = score >= 76 ? "strong" : score >= 52 ? "medium" : "weak";
  return { score, status, tone, discount, sold, rating, priority, hoursLeft };
}

function campaignPreviewPrice(product) {
  const discount = Math.max(0, Math.min(95, Number(product?.campaign?.discountPercent || 0)));
  const price = Number(product?.price || 0);
  if (!discount) return price;
  return Math.round(price * (1 - discount / 100) * 100) / 100;
}

function campaignRecommendations(product) {
  const campaign = product?.campaign || {};
  const data = campaignStrength(product);
  const tips = [];

  if (campaign.type === "flash" && data.discount < 10) {
    tips.push("Para oferta rel\u00e2mpago, use desconto de campanha de pelo menos 10%. O pre\u00e7o volta sozinho quando terminar.");
  } else if (data.discount > 0) {
    tips.push(`Desconto de campanha de ${data.discount}% ativo no c\u00e1lculo tempor\u00e1rio.`);
  } else {
    tips.push("Sem desconto de campanha: use como destaque de vitrine, lan\u00e7amento ou campanha de interesse.");
  }

  if (!campaign.endsAt) {
    tips.push("Defina data final para criar urg\u00eancia e permitir contador.");
  } else if (data.hoursLeft <= 0) {
    tips.push("A campanha passou do prazo. Atualize o fim ou pause para n\u00e3o perder for\u00e7a.");
  } else if (data.hoursLeft > 72 && campaign.type === "flash") {
    tips.push("Oferta rel\u00e2mpago funciona melhor com prazo curto, entre 24h e 72h.");
  } else {
    tips.push(`Prazo restante: ${data.hoursLeft}h. Bom para trabalhar urg\u00eancia.`);
  }

  if (Number(product?.stock || 0) <= 0) {
    tips.push("Produto sem estoque: pause a campanha ou atualize o estoque antes de impulsionar.");
  } else if (Number(product.stock) <= 5) {
    tips.push("Estoque baixo: use chamada de escassez ou reserve para produto sob demanda.");
  } else {
    tips.push(`Estoque com ${product.stock} unidades permite campanha sem risco imediato.`);
  }

  if (data.priority < 60) {
    tips.push("Aumente a prioridade para 70 ou mais se quiser aparecer mais em Para voc\u00ea e Tend\u00eancia.");
  } else {
    tips.push(`Prioridade ${data.priority}: boa for\u00e7a de destaque no cat\u00e1logo.`);
  }

  if (!data.rating.count) {
    tips.push("Sem avalia\u00e7\u00f5es ainda: use fotos, v\u00eddeo e stories para compensar prova social.");
  } else {
    tips.push(`Prova social: ${data.rating.average.toFixed(1)} com ${data.rating.count} avalia\u00e7\u00e3o(\u00f5es).`);
  }

  return tips;
}

function isCampaignRunning(campaign) {
  if (!campaign?.active) return false;
  const now = Date.now();
  const startsAt = campaign.startsAt ? new Date(campaign.startsAt).getTime() : 0;
  const endsAt = campaign.endsAt ? new Date(campaign.endsAt).getTime() : Infinity;
  return now >= startsAt && now <= endsAt;
}

function localDateTimeValue(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const offsetDate = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return offsetDate.toISOString().slice(0, 16);
}

function renderCampaignProductOptions({ keepSelected = false } = {}) {
  const select = $("#campaignProductSelect");
  const selectedProductId = select.value || currentProducts[0]?.id || "";
  const query = $("#campaignProductSearchInput")?.value || "";
  const filteredProducts = currentProducts.filter((product) => matchesSearch([
    product.name,
    product.category,
    product.status,
    isRecentlyPosted(product) ? "novo" : "",
    dynamicSoldCount(product) ? `${dynamicSoldCount(product)} vendidos` : "",
    ratingSummary(product),
    product.description,
    product.campaign?.label,
    campaignTypeLabel(product.campaign?.type)
  ].join(" "), query));
  const selectedProduct = currentProducts.find((product) => product.id === selectedProductId);
  const products = keepSelected && selectedProduct && !filteredProducts.some((product) => product.id === selectedProduct.id)
    ? [selectedProduct, ...filteredProducts]
    : filteredProducts;

  select.innerHTML = products.length
    ? products.map((product) => `<option value="${product.id}">${product.name}</option>`).join("")
    : `<option value="">Nenhum produto encontrado</option>`;
  select.value = keepSelected && selectedProductId && products.some((product) => product.id === selectedProductId) ? selectedProductId : products[0]?.id || "";
  fillCampaignFormFromSelected.formDirty = false;
  fillCampaignFormFromSelected();
}

function fillCampaignFormFromSelected() {
  const form = $("#campaignForm");
  const product = currentProducts.find((item) => item.id === form.elements.productId.value);
  if (document.activeElement === form.elements.productId || !fillCampaignFormFromSelected.formDirty) {
    const campaign = product?.campaign || {};
    form.elements.type.value = campaign.type || "featured";
    form.elements.label.value = campaign.label || "";
    form.elements.discountPercent.value = Number(campaign.discountPercent || 0);
    form.elements.priority.value = Number(campaign.priority ?? 50);
    form.elements.startsAt.value = localDateTimeValue(campaign.startsAt);
    form.elements.endsAt.value = localDateTimeValue(campaign.endsAt);
    form.elements.active.checked = campaign.active !== false;
    fillCampaignFormFromSelected.formDirty = false;
  }

  const campaign = {
    ...(product?.campaign || {}),
    type: form.elements.type.value,
    label: form.elements.label.value,
    discountPercent: Number(form.elements.discountPercent.value || 0),
    priority: Number(form.elements.priority.value || 0),
    startsAt: form.elements.startsAt.value ? new Date(form.elements.startsAt.value).toISOString() : product?.campaign?.startsAt,
    endsAt: form.elements.endsAt.value ? new Date(form.elements.endsAt.value).toISOString() : product?.campaign?.endsAt,
    active: form.elements.active.checked
  };
  const productForInsight = product ? { ...product, campaign } : null;

  const strength = productForInsight ? campaignStrength(productForInsight) : null;
  const recommendations = productForInsight ? campaignRecommendations(productForInsight) : [];
  $("#campaignProductSummary").innerHTML = productForInsight ? `
    <article class="campaign-summary-card campaign-insight-card ${strength.tone}">
      <div class="campaign-insight-head">
        <div>
          <strong>${productForInsight.name}</strong>
          <span>${productForInsight.category} | normal ${money(productForInsight.price)} | campanha ${money(campaignPreviewPrice(productForInsight))} | ${productForInsight.stock} unidades</span>
        </div>
        <small>${isCampaignRunning(productForInsight.campaign) ? "Rodando agora" : productForInsight.campaign ? "Configurada" : "Sem campanha"}</small>
      </div>
      <div class="campaign-strength">
        <div>
          <b>Leitura comercial</b>
          <strong>${strength.status}</strong>
        </div>
        <span>${strength.score}/100</span>
      </div>
      <div class="campaign-insight-grid">
        <span><b>Desconto</b>${strength.discount || 0}%</span>
        <span><b>Preço campanha</b>${money(campaignPreviewPrice(productForInsight))}</span>
        <span><b>Prioridade</b>${strength.priority}</span>
        <span><b>Vendas</b>${strength.sold}</span>
        <span><b>Prazo</b>${strength.hoursLeft === null ? "sem fim" : `${strength.hoursLeft}h`}</span>
      </div>
      <ul class="campaign-recommendations">
        ${recommendations.map((tip) => `<li>${tip}</li>`).join("")}
      </ul>
    </article>
  ` : "";
}

function renderCampaignList() {
  const products = currentProducts
    .filter((product) => product.campaign)
    .sort((a, b) => Number(b.campaign?.priority || 0) - Number(a.campaign?.priority || 0));

  $("#campaignList").innerHTML = products.length ? products.map((product) => `
    <article class="campaign-card">
      <div>
        <strong>${product.name}</strong>
        <span>${campaignTypeLabel(product.campaign.type)} | Prioridade ${product.campaign.priority || 0}${product.campaign.label ? ` | ${product.campaign.label}` : ""}</span>
      </div>
      <small>${isCampaignRunning(product.campaign) ? "Rodando" : product.campaign.active ? "Agendada/fora do periodo" : "Pausada"}</small>
    </article>
  `).join("") : "<p>Nenhuma campanha configurada ainda.</p>";
}

function renderStoryAdminList() {
  const query = $("#storySearchInput")?.value || "";
  const filteredStories = currentStories.filter((story) => {
    const product = currentProducts.find((item) => item.id === story.productId);
    return matchesSearch([
      story.title,
      story.caption,
      story.mediaType,
      product?.name,
      product?.category
    ].join(" "), query);
  });

  $("#storyAdminList").innerHTML = filteredStories.length ? filteredStories.map((story) => {
    const product = currentProducts.find((item) => item.id === story.productId);
    return `
      <article class="story-admin-card">
        <div class="story-admin-media">
          ${story.mediaType === "video" ? `<video src="${story.mediaUrl}" muted playsinline></video>` : `<img src="${story.mediaUrl}" alt="${story.title}">`}
        </div>
        <div>
          <strong>${story.title}</strong>
          <span>${story.caption || "Sem legenda"}</span>
          <small>${story.mediaType === "video" ? "Video" : "Foto"}${product ? ` | Produto: ${product.name}` : ""}${story.active === false ? " | Inativo" : ""}</small>
          <div class="story-admin-actions">
            <button class="ghost-button table-action" type="button" data-edit-story="${story.id}">Editar</button>
            <button class="ghost-button table-action" type="button" data-delete-story="${story.id}">Excluir</button>
          </div>
        </div>
      </article>
    `;
  }).join("") : (currentStories.length ? "<p>Nenhum story encontrado.</p>" : "<p>Nenhum story publicado ainda.</p>");

  document.querySelectorAll("[data-edit-story]").forEach((button) => {
    button.addEventListener("click", () => editStory(button.dataset.editStory));
  });
  document.querySelectorAll("[data-delete-story]").forEach((button) => {
    button.addEventListener("click", () => deleteStory(button.dataset.deleteStory));
  });
}

function formatAddress(customer) {
  const address = customer.address;
  if (!address) return customer.address || "Endereço não informado";
  return [
    `${address.street}, ${address.number}`,
    address.complement,
    address.neighborhood,
    `${address.city}/${address.state}`,
    `CEP ${address.zipCode}`
  ].filter(Boolean).join(" - ");
}

function formatShipping(order) {
  if (!order.shippingOption) {
    if (order.promotion?.reason === "seller_pays_shipping") return "Frete gratis assumido pela loja. Envio definido internamente.";
    return `Entrega: ${money(order.shipping || 0)}`;
  }
  const option = order.shippingOption;
  return `${option.carrier} - ${option.service} | ${money(option.price)}${option.deliveryDays ? ` | ${option.deliveryDays} dias uteis` : ""}`;
}

function orderStatusLabel(status) {
  return {
    created: "Criado",
    awaiting_payment: "Aguardando pagamento",
    paid: "Pago",
    in_production: "Em produção",
    shipped: "Enviado",
    completed: "Concluído",
    canceled: "Cancelado"
  }[status] || status;
}

function orderStageClass(order) {
  if (order.status === "canceled") return "danger";
  if (["paid", "in_production", "shipped", "completed"].includes(order.status)) return "ok";
  return "pending";
}

function integrationStatus(order) {
  const payment = order.payment || {};
  const flow = order.shippingWorkflow || {};
  return [
    {
      label: "Mercado Pago",
      status: payment.provider === "mercado-pago" ? payment.status || "aguardando webhook" : payment.provider ? `via ${payment.provider}` : "não iniciado",
      active: ["approved", "paid", "authorized"].includes(String(payment.status || "").toLowerCase()) || ["paid", "in_production", "shipped", "completed"].includes(order.status)
    },
    {
      label: "Melhor Envio",
      status: flow.tracking?.status || flow.print?.status || flow.label?.status || flow.checkout?.status || flow.cart?.status || "etiqueta pendente",
      active: Boolean(flow.print || flow.label || flow.tracking)
    },
    {
      label: "Produção",
      status: ["in_production", "shipped", "completed"].includes(order.status) ? orderStatusLabel(order.status) : "manual",
      active: ["in_production", "shipped", "completed"].includes(order.status)
    }
  ];
}

function shippingActionLabel(order) {
  if (order.promotion?.reason === "seller_pays_shipping") return "Escolher transportadora e gerar etiqueta";
  if (order.shippingOption) return "Gerar etiqueta";
  return "Definir envio";
}

function orderItems(order) {
  return (order.items || []).map((item) => `
    <li>
      <span>${item.quantity}x ${item.name}${item.variant?.color ? ` | Cor: ${item.variant.color}` : ""}</span>
      <strong>${money(item.total)}</strong>
    </li>
  `).join("");
}

function orderTimeline(order) {
  const flow = order.shippingWorkflow || {};
  const steps = [
    { label: "Pedido criado", done: true, value: new Date(order.createdAt).toLocaleString("pt-BR") },
    { label: "Pagamento", done: ["paid", "in_production", "shipped", "completed"].includes(order.status), value: order.payment?.status || "pendente" },
    { label: "Produção", done: ["in_production", "shipped", "completed"].includes(order.status), value: order.status === "in_production" ? "em andamento" : "" },
    { label: "Etiqueta", done: Boolean(flow.label || flow.print), value: flow.melhorEnvioOrderId || "não gerada" },
    { label: "Nota fiscal", done: Boolean(order.invoice?.status === "issued"), value: order.invoice?.number || "pendente" },
    { label: "Concluído", done: order.status === "completed", value: "" }
  ];
  return steps.map((step) => `
    <span class="${step.done ? "done" : ""}">
      <b>${step.label}</b>
      <small>${step.value || (step.done ? "ok" : "pendente")}</small>
    </span>
  `).join("");
}

function orderStatusHistory(order) {
  const history = order.history || order.statusHistory || [];
  if (!history.length) {
    return `<p class="muted-copy">Nenhuma mudança manual registrada ainda.</p>`;
  }
  return `
    <ol class="status-history">
      ${history.slice().reverse().map((entry) => `
        <li>
          <strong>${orderStatusLabel(entry.to || entry.status)}</strong>
          <span>${entry.from || entry.previousStatus ? `${orderStatusLabel(entry.from || entry.previousStatus)} → ` : ""}${orderStatusLabel(entry.to || entry.status)}${entry.source ? ` | ${entry.source}` : ""}</span>
          <small>${entry.createdAt ? new Date(entry.createdAt).toLocaleString("pt-BR") : "sem data"}${entry.note ? ` | ${entry.note}` : ""}</small>
        </li>
      `).join("")}
    </ol>
  `;
}

function orderOperationalFlags(order) {
  const flags = [];
  if (!["paid", "in_production", "shipped", "completed"].includes(order.status)) flags.push("Confirmar pagamento");
  if (!order.shippingWorkflow?.label && order.status !== "canceled") flags.push("Etiqueta pendente");
  if (!order.invoice?.status) flags.push("Nota fiscal pendente");
  if (order.status === "paid") flags.push("Liberar para produção");
  return flags;
}

function orderShippingFlow(order) {
  const flow = order.shippingWorkflow || {};
  const quotes = flow.quotes || [];
  const quoteButtons = quotes.length ? `
    <div class="quote-list">
      ${quotes.map((quote) => `
        <button class="ghost-button quote-button" type="button" data-shipping-action="cart" data-order-id="${order.id}" data-quote-id="${quote.id}">
          ${quote.carrier} ${quote.service} - ${money(quote.price)}
        </button>
      `).join("")}
    </div>
  ` : "";
  const printLink = flow.print?.url ? `<a class="primary-link label-print-link" href="${flow.print.url}" target="_blank" rel="noopener">Abrir etiqueta</a>` : "";
  return `
    <div class="label-flow">
      <button class="ghost-button label-button" type="button" data-shipping-action="quote" data-order-id="${order.id}">Cotar envio</button>
      ${order.shippingOption ? `<button class="ghost-button label-button" type="button" data-shipping-action="cart" data-order-id="${order.id}" data-quote-id="${order.shippingOption.id}">Enviar para carrinho ME</button>` : ""}
      ${quoteButtons}
      <button class="ghost-button label-button" type="button" data-shipping-action="checkout" data-order-id="${order.id}" ${flow.melhorEnvioOrderId ? "" : "disabled"}>Comprar etiqueta</button>
      <button class="ghost-button label-button" type="button" data-shipping-action="generate" data-order-id="${order.id}" ${flow.checkout ? "" : "disabled"}>Gerar etiqueta</button>
      <button class="ghost-button label-button" type="button" data-shipping-action="print" data-order-id="${order.id}" ${flow.label ? "" : "disabled"}>Imprimir</button>
      ${printLink}
      <small>${flow.melhorEnvioOrderId ? `Melhor Envio: ${flow.melhorEnvioOrderId}` : "Etiqueta ainda nao criada no Melhor Envio."}</small>
    </div>
  `;
}

function couponLabel(coupon) {
  if (coupon.type === "free_shipping") return "Frete grátis";
  if (coupon.type === "percent") return `${coupon.value}% OFF`;
  return `${money(coupon.value)} OFF`;
}

function randomCouponCode() {
  const prefix = ["BASA", "3D", "COMBO", "FRETE"][Math.floor(Math.random() * 4)];
  return `${prefix}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

function couponExpirationLabel(coupon) {
  if (!coupon.expiresAt) return "Sem expiração";
  const expiresAt = new Date(coupon.expiresAt);
  if (Number.isNaN(expiresAt.getTime())) return "Expiração inválida";
  const expired = expiresAt.getTime() <= Date.now();
  return `${expired ? "Expirado em" : "Expira em"} ${expiresAt.toLocaleString("pt-BR")}`;
}

function discountPercent(product) {
  if (!product.compareAtPrice || product.compareAtPrice <= product.price) return 0;
  return Math.round((1 - product.price / product.compareAtPrice) * 100);
}

function productBasePrice(product) {
  if (!product.shipping?.sellerPaysShipping) return Number(product.price || 0);
  const reserve = Number(product.shipping?.embeddedShippingReserve || currentSettings?.shippingFlatRate || 0);
  return Number(product.shipping?.basePrice ?? Math.max(0, Number(product.price || 0) - reserve));
}

function productBaseCompareAtPrice(product) {
  if (!product.shipping?.sellerPaysShipping) return Number(product.compareAtPrice || 0);
  const reserve = Number(product.shipping?.embeddedShippingReserve || currentSettings?.shippingFlatRate || 0);
  return Number(product.shipping?.compareAtBasePrice ?? Math.max(0, Number(product.compareAtPrice || 0) - reserve));
}

function updateEmbeddedShippingPreview() {
  const preview = $("#embeddedShippingPreview");
  if (!preview) return;
  const form = $("#productForm");
  const basePrice = Number(form.elements.price.value || 0);
  const baseCompareAtPrice = Number(form.elements.compareAtPrice.value || 0);
  const reserve = Number(currentSettings?.shippingFlatRate || 0);
  const sellerPaysShipping = form.elements.sellerPaysShipping.checked;
  const finalPrice = sellerPaysShipping ? basePrice + reserve : basePrice;
  const finalCompareAtPrice = sellerPaysShipping && baseCompareAtPrice > 0 ? baseCompareAtPrice + reserve : baseCompareAtPrice;

  preview.innerHTML = sellerPaysShipping
    ? `Frete fixo reserva: <strong>${money(reserve)}</strong>. Preço publicado: <strong>${money(finalPrice)}</strong>${finalCompareAtPrice > 0 ? ` | Preço antigo publicado: <strong>${money(finalCompareAtPrice)}</strong>` : ""}.`
    : "Ao marcar frete grátis, o frete fixo reserva será somado automaticamente ao preço publicado.";
}

function addHighlight(value = "") {
  const row = document.createElement("div");
  row.className = "repeatable-row";
  row.innerHTML = `
    <input name="highlightItem" value="${value}" placeholder="Ex: Acabamento conferido antes do envio">
    <button class="ghost-button remove-row" type="button" aria-label="Remover destaque">Remover</button>
  `;
  row.querySelector("button").addEventListener("click", () => row.remove());
  $("#highlightsList").append(row);
}

function addSpec(key = "", value = "") {
  const row = document.createElement("div");
  row.className = "repeatable-row spec-row";
  row.innerHTML = `
    <input name="specKey" value="${key}" placeholder="Campo. Ex: Material">
    <input name="specValue" value="${value}" placeholder="Valor. Ex: PLA">
    <button class="ghost-button remove-row" type="button" aria-label="Remover especificacao">Remover</button>
  `;
  row.querySelector("button").addEventListener("click", () => row.remove());
  $("#specsList").append(row);
}

function resetProductForm() {
  const form = $("#productForm");
  form.reset();
  form.elements.productId.value = "";
  form.elements.weightKg.value = "0.30";
  form.elements.widthCm.value = "12";
  form.elements.heightCm.value = "8";
  form.elements.lengthCm.value = "18";
  form.elements.sellerPaysShipping.checked = false;
  form.elements.freeShippingMinQuantity.value = "";
  form.elements.bundleType.value = "single";
  form.elements.piecesIncluded.value = "1";
  $("#highlightsList").innerHTML = "";
  $("#specsList").innerHTML = "";
  addHighlight();
  addHighlight();
  addSpec();
  addSpec();
  $("#productSubmitButton").textContent = "Publicar produto";
  $("#cancelProductEditButton").hidden = true;
  $("#deleteProductButton").hidden = true;
  updateEmbeddedShippingPreview();
}

function resetStoryForm() {
  const form = $("#storyForm");
  form.reset();
  form.elements.storyId.value = "";
  form.elements.active.checked = true;
  form.elements.media.required = true;
  $("#storyProductSearchInput").value = "";
  renderStoryProductOptions({ keepSelected: true });
  $("#storySubmitButton").textContent = "Publicar story";
  $("#cancelStoryEditButton").hidden = true;
}

function editStory(storyId) {
  const story = currentStories.find((item) => item.id === storyId);
  if (!story) return;
  const form = $("#storyForm");
  form.elements.storyId.value = story.id;
  form.elements.title.value = story.title || "";
  form.elements.caption.value = story.caption || "";
  $("#storyProductSearchInput").value = "";
  renderStoryProductOptions({ keepSelected: true });
  form.elements.productId.value = story.productId || "";
  form.elements.active.checked = story.active !== false;
  form.elements.media.value = "";
  form.elements.media.required = false;
  $("#storySubmitButton").textContent = "Salvar story";
  $("#cancelStoryEditButton").hidden = false;
  $("#storyStatus").textContent = `Editando ${story.title}`;
  form.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function deleteStory(storyId) {
  const story = currentStories.find((item) => item.id === storyId);
  if (!story || !confirm(`Excluir o story "${story.title}"?`)) return;
  $("#storyStatus").textContent = "Excluindo story...";
  try {
    const result = await api(`/api/admin/stories/${encodeURIComponent(storyId)}`, {
      method: "DELETE",
      body: "{}"
    });
    currentStories = result.stories || [];
    renderStoryAdminList();
    resetStoryForm();
    $("#storyStatus").textContent = "Story excluido.";
  } catch (error) {
    $("#storyStatus").textContent = error.message;
  }
}

function editProduct(productId) {
  const product = currentProducts.find((item) => item.id === productId);
  if (!product) return;
  const form = $("#productForm");
  form.elements.productId.value = product.id;
  form.elements.name.value = product.name || "";
  form.elements.category.value = product.category || "";
  form.elements.price.value = productBasePrice(product);
  form.elements.compareAtPrice.value = productBaseCompareAtPrice(product) || "";
  form.elements.stock.value = product.stock || 0;
  form.elements.colors.value = (product.variants?.colors || []).join("\n");
  form.elements.bundleType.value = product.variants?.bundleType || (Number(product.variants?.piecesIncluded || 1) > 1 ? "kit" : "single");
  form.elements.piecesIncluded.value = product.variants?.piecesIncluded || 1;
  form.elements.weightKg.value = product.shipping?.weightKg || 0.3;
  form.elements.widthCm.value = product.shipping?.widthCm || 12;
  form.elements.heightCm.value = product.shipping?.heightCm || 8;
  form.elements.lengthCm.value = product.shipping?.lengthCm || 18;
  form.elements.sellerPaysShipping.checked = Boolean(product.shipping?.sellerPaysShipping);
  form.elements.freeShippingMinQuantity.value = product.shipping?.freeShippingMinQuantity || "";
  form.elements.image.value = product.image || "";
  form.elements.description.value = product.description || "";
  form.elements.longDescription.value = product.longDescription || "";
  form.elements.videoUrl.value = product.videoUrl || "";
  form.elements.gallery.value = (product.gallery || []).join("\n");

  $("#highlightsList").innerHTML = "";
  (product.highlights?.length ? product.highlights : [""]).forEach((item) => addHighlight(item));
  $("#specsList").innerHTML = "";
  const entries = Object.entries(product.specs || {});
  (entries.length ? entries : [["", ""]]).forEach(([key, value]) => addSpec(key, value));

  $("#productSubmitButton").textContent = "Salvar alterações";
  $("#cancelProductEditButton").hidden = false;
  $("#deleteProductButton").hidden = false;
  $("#productStatus").textContent = `Editando ${product.name}`;
  updateEmbeddedShippingPreview();
  form.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function deleteProduct(productId) {
  const product = currentProducts.find((item) => item.id === productId);
  if (!product || !confirm(`Excluir o produto "${product.name}"? Ele sairá da loja e das campanhas.`)) return;
  $("#productStatus").textContent = "Excluindo produto...";
  try {
    const result = await api(`/api/admin/products/${encodeURIComponent(productId)}`, {
      method: "DELETE",
      body: "{}"
    });
    currentProducts = result.products || currentProducts.filter((item) => item.id !== productId);
    currentStories = result.stories || currentStories.map((story) => story.productId === productId ? { ...story, productId: "" } : story);
    if ($("#productForm").elements.productId.value === productId) resetProductForm();
    renderProductsTable();
    renderStoryProductOptions({ keepSelected: true });
    renderStoryAdminList();
    renderCampaignProductOptions({ keepSelected: true });
    renderCampaignList();
    renderMetrics();
    $("#productStatus").textContent = "Produto excluído.";
  } catch (error) {
    $("#productStatus").textContent = error.message;
  }
}

function renderProductsTable() {
  const query = $("#productSearchInput")?.value || "";
  const filteredProducts = currentProducts.filter((product) => matchesSearch([
    product.name,
    product.category,
    product.status,
    isRecentlyPosted(product) ? "novo" : "",
    dynamicSoldCount(product) ? `${dynamicSoldCount(product)} vendidos` : "",
    ratingSummary(product),
    product.description,
    product.shipping?.sellerPaysShipping ? "frete gratis" : "",
    product.variants?.colors?.join(" "),
    discountPercent(product) ? `${discountPercent(product)} off` : ""
  ].join(" "), query));

  $("#productsTable").innerHTML = filteredProducts.length ? filteredProducts.map((product) => `
    <tr>
      <td><strong>${product.name}</strong></td>
      <td>${product.category}</td>
      <td>${money(product.price)}${product.shipping?.sellerPaysShipping ? `<small class="table-note">Base ${money(productBasePrice(product))} + frete</small>` : ""}</td>
      <td>${product.compareAtPrice ? money(product.compareAtPrice) : "-"}</td>
      <td>${discountPercent(product) ? `${discountPercent(product)}% OFF` : "-"}</td>
      <td>${product.stock}</td>
      <td>${isRecentlyPosted(product) ? "Novo" : "-"}${dynamicSoldCount(product) ? ` / ${dynamicSoldCount(product)} vendidos` : ""}<small class="table-note">${ratingSummary(product)}</small></td>
      <td>${product.status}${product.shipping?.sellerPaysShipping ? " / frete grátis" : ""}${product.shipping?.freeShippingMinQuantity ? ` / frete ${product.shipping.freeShippingMinQuantity}+ un.` : ""}</td>
      <td>
        <button class="ghost-button table-action" type="button" data-edit-product="${product.id}">Editar</button>
        <button class="ghost-button table-action danger-button" type="button" data-delete-product="${product.id}">Excluir</button>
      </td>
    </tr>
  `).join("") : `<tr><td colspan="9">${currentProducts.length ? "Nenhum produto encontrado." : "Nenhum produto cadastrado ainda."}</td></tr>`;

  document.querySelectorAll("[data-edit-product]").forEach((button) => {
    button.addEventListener("click", () => editProduct(button.dataset.editProduct));
  });
  document.querySelectorAll("[data-delete-product]").forEach((button) => {
    button.addEventListener("click", () => deleteProduct(button.dataset.deleteProduct));
  });
}

function renderOrdersList() {
  const query = $("#orderSearchInput")?.value || "";
  const filteredOrders = currentOrders.filter((order) => matchesSearch([
    order.id,
    order.status,
    orderStatusLabel(order.status),
    order.customer?.name,
    order.customer?.document,
    order.customer?.email,
    formatAddress(order.customer || {}),
    formatShipping(order),
    order.payment?.provider,
    order.payment?.status,
    (order.items || []).map((item) => item.name).join(" ")
  ].join(" "), query));

  if (!selectedOrderId || !filteredOrders.some((order) => order.id === selectedOrderId)) {
    selectedOrderId = filteredOrders[0]?.id || currentOrders[0]?.id || "";
  }

  $("#ordersList").innerHTML = filteredOrders.length ? filteredOrders.map((order) => `
    <button class="order-list-item ${order.id === selectedOrderId ? "active" : ""}" type="button" data-select-order="${order.id}">
      <span class="status-dot ${orderStageClass(order)}"></span>
      <span>
        <strong>${order.id}</strong>
        <small>${order.customer?.name || "Cliente"} | ${new Date(order.createdAt).toLocaleDateString("pt-BR")}</small>
      </span>
      <b>${money(order.total || 0)}</b>
    </button>
  `).join("") : `<p>${currentOrders.length ? "Nenhum pedido encontrado." : "Ainda não há pedidos."}</p>`;

  renderSelectedOrderDetail(filteredOrders.find((order) => order.id === selectedOrderId) || currentOrders.find((order) => order.id === selectedOrderId));

  document.querySelectorAll("[data-select-order]").forEach((button) => {
    button.addEventListener("click", () => {
      selectedOrderId = button.dataset.selectOrder;
      renderOrdersList();
    });
  });
  document.querySelectorAll("[data-order-status]").forEach((select) => {
    select.addEventListener("change", async () => {
      await api(`/api/admin/orders/${encodeURIComponent(select.dataset.orderStatus)}`, {
        method: "PATCH",
        body: JSON.stringify({ status: select.value })
      });
      selectedOrderId = select.dataset.orderStatus;
      await loadDashboard();
    });
  });
  document.querySelectorAll("[data-shipping-action]").forEach((button) => {
    button.addEventListener("click", () => runShippingAction(button));
  });
}

function renderSelectedOrderDetail(order) {
  const panel = $("#orderDetailPanel");
  if (!panel) return;
  if (!order) {
    panel.innerHTML = `<div class="order-empty-state"><strong>Nenhum pedido selecionado</strong><span>Os detalhes aparecerão aqui.</span></div>`;
    return;
  }
  const flags = orderOperationalFlags(order);
  const flow = order.shippingWorkflow || {};
  panel.innerHTML = `
    <div class="order-detail-head">
      <div>
        <p class="eyebrow">Pedido selecionado</p>
        <h3>${order.id}</h3>
        <span>${new Date(order.createdAt).toLocaleString("pt-BR")}</span>
      </div>
      <div class="order-detail-total">
        <strong>${money(order.total || 0)}</strong>
        <small class="status-chip ${orderStageClass(order)}">${orderStatusLabel(order.status)}</small>
      </div>
    </div>

    <div class="order-alert-strip">
      ${flags.length ? flags.map((flag) => `<span>${flag}</span>`).join("") : `<span class="ok">Pedido sem pendências críticas.</span>`}
    </div>

    <div class="order-timeline">${orderTimeline(order)}</div>

    <div class="order-management-grid order-detail-grid">
      <section>
        <h3>Cliente e envio</h3>
        <span><strong>${order.customer?.name || "Cliente"}</strong></span>
        <span>${order.customer?.email || "Email não informado"}</span>
        <span>${order.customer?.phone || "Telefone não informado"}</span>
        <span>${order.customer?.document ? `Documento: ${order.customer.document}` : "Documento não informado"}</span>
        <span>${formatAddress(order.customer || {})}</span>
      </section>
      <section>
        <h3>Itens do pedido</h3>
        <ul class="order-items">${orderItems(order)}</ul>
        <span>Subtotal: <strong>${money(order.subtotal || 0)}</strong></span>
        <span>Entrega: <strong>${money(order.shipping || 0)}</strong></span>
      </section>
      <section>
        <h3>Pagamento</h3>
        <span>Provedor: <strong>${order.payment?.provider || "Não informado"}</strong></span>
        <span>Status: <strong>${order.payment?.status || "Pendente"}</strong></span>
        <span>ID externo: ${order.payment?.id || order.payment?.externalId || "não informado"}</span>
        <small class="muted-copy">Quando o webhook do Mercado Pago estiver ativo, esta etapa muda sozinha após a confirmação.</small>
        <label>Status operacional manual
          <select data-order-status="${order.id}">
            ${["created", "awaiting_payment", "paid", "in_production", "shipped", "completed", "canceled"].map((status) => `<option value="${status}" ${order.status === status ? "selected" : ""}>${orderStatusLabel(status)}</option>`).join("")}
          </select>
        </label>
      </section>
      <section>
        <h3>Integrações automáticas</h3>
        <div class="integration-stack">
          ${integrationStatus(order).map((item) => `
            <span class="${item.active ? "active" : ""}">
              <b>${item.label}</b>
              <small>${item.status}</small>
            </span>
          `).join("")}
        </div>
      </section>
      <section>
        <h3>Envio e etiqueta</h3>
        <span>${formatShipping(order)}</span>
        ${orderShippingFlow(order)}
      </section>
      <section>
        <h3>Histórico do pedido</h3>
        ${orderStatusHistory(order)}
      </section>
      <section>
        <h3>Nota fiscal</h3>
        <span>Status: <strong>${order.invoice?.status || "Pendente"}</strong></span>
        <span>Número: ${order.invoice?.number || "não emitida"}</span>
        <span>Integração futura: ERP/Bling ou emissor fiscal.</span>
        <button class="ghost-button" type="button" disabled>Emitir nota fiscal</button>
      </section>
      <section>
        <h3>Histórico técnico</h3>
        <span>Promoção: ${order.promotion?.reason || "nenhuma"}</span>
        <span>Melhor Envio: ${flow.melhorEnvioOrderId || "não enviado"}</span>
        <span>Etiqueta: ${flow.print?.url ? "pronta" : "pendente"}</span>
        <details>
          <summary>Ver JSON do pedido</summary>
          <pre>${JSON.stringify({ payment: order.payment || null, shipping: order.shippingOption || null, workflow: order.shippingWorkflow || null, promotion: order.promotion || null }, null, 2)}</pre>
        </details>
      </section>
    </div>
  `;
}
function requestStatusLabel(status) {
  return {
    new: "Nova",
    in_review: "Em análise",
    quoted: "Orçamento enviado",
    approved: "Aprovada",
    in_production: "Em produção",
    shipped: "Enviada",
    completed: "Concluída",
    canceled: "Cancelada"
  }[status] || status;
}

function renderAdminRequests() {
  const query = $("#requestSearchInput")?.value || "";
  const requests = currentRequests.filter((request) => matchesSearch([
    request.id,
    request.title,
    request.idea,
    request.status,
    request.customer?.name,
    request.customer?.email,
    request.customer?.phone
  ].join(" "), query));

  $("#adminRequestList").innerHTML = requests.length ? requests.map((request) => `
    <article class="request-card">
      <div class="request-card-head">
        <div>
          <strong>${request.title}</strong>
          <span>${request.id} | ${request.customer?.name || "Cliente"} | ${request.customer?.email || ""}</span>
        </div>
        <small>${requestStatusLabel(request.status)}</small>
      </div>
      <p>${request.idea}</p>
      ${request.attachment?.url ? `<a class="request-attachment" href="${request.attachment.url}" target="_blank" rel="noreferrer">Ver imagem de referência</a>` : ""}
      <div class="request-meta">
        <span>Orçamento: ${request.budget || "Nao informado"}</span>
        <span>Prazo: ${request.deadline || "Nao informado"}</span>
      </div>
      <div class="request-messages">
        ${(request.messages || []).map((message) => `<span class="${message.author === "admin" ? "admin-message" : ""}"><b>${message.author === "admin" ? "Basa" : "Cliente"}:</b> ${message.text}</span>`).join("")}
      </div>
      <form class="admin-request-form" data-admin-request="${request.id}">
        <select name="status">
          ${["new", "in_review", "quoted", "approved", "in_production", "shipped", "completed", "canceled"].map((status) => `<option value="${status}" ${request.status === status ? "selected" : ""}>${requestStatusLabel(status)}</option>`).join("")}
        </select>
        <input name="message" placeholder="Mensagem para o cliente">
        <button class="primary-button" type="submit">Atualizar</button>
      </form>
    </article>
  `).join("") : "<p>Nenhuma encomenda encontrada.</p>";

  document.querySelectorAll("[data-admin-request]").forEach((form) => {
    form.addEventListener("submit", updateCustomRequest);
  });
}

async function updateCustomRequest(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const body = Object.fromEntries(new FormData(form).entries());
  const result = await api(`/api/admin/custom-requests/${encodeURIComponent(form.dataset.adminRequest)}`, {
    method: "PATCH",
    body: JSON.stringify(body)
  });
  currentRequests = result.customRequests || [];
  renderAdminRequests();
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    ...options
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Erro na requisicao.");
  return data;
}

async function loadDashboard() {
  const data = await api("/api/admin/dashboard");
  currentProducts = data.products || [];
  currentStories = data.stories || [];
  currentOrders = data.orders || [];
  currentRequests = data.customRequests || [];
  currentCoupons = data.coupons || [];
  currentSettings = data.settings;
  $("#loginCard").hidden = true;
  $("#dashboard").hidden = false;
  applyTheme(data.settings.theme);

  $("#statsGrid").innerHTML = `
    <div><span>Produtos ativos</span><strong>${data.stats.products}</strong><small>itens no catalogo</small></div>
    <div><span>Pedidos</span><strong>${data.stats.orders}</strong><small>registrados no sistema</small></div>
    <div><span>Receita</span><strong>${money(data.stats.revenue)}</strong><small>total bruto de pedidos</small></div>
  `;

  $("#splitBox").innerHTML = `
    <p><strong>Marketplace:</strong> ${data.settings.marketplaceAccountId}</p>
    <p><strong>Comissao Basa:</strong> ${data.settings.storeCommissionPercent}%</p>
    <p><strong>Taxa gateway:</strong> ${data.settings.paymentFeePercent}% + ${money(data.settings.paymentFeeFixed)}</p>
    <p>O checkout cria uma ordem com divisao entre a conta da Basa e a conta do vendedor. Em producao, ligue o adaptador em Mercado Pago ou Stripe Connect.</p>
  `;

  renderThemeGrid(data.settings.theme || "atelier");
  fillDisplaySettings(data.settings);
  renderHeroSlideList();
  renderCouponList(data.coupons || []);
  renderStoryProductOptions({ keepSelected: true });
  renderCampaignProductOptions({ keepSelected: true });
  renderCampaignList();
  renderStoryAdminList();
  fillShippingSettings(data.settings);
  updateEmbeddedShippingPreview();
  renderMetrics();
  renderProductsTable();
  renderOrdersList();
  renderAdminRequests();
}

async function runShippingAction(button) {
  const action = button.dataset.shippingAction;
  if (action === "checkout" && !confirm("Comprar a etiqueta usa o saldo/credito da sua conta Melhor Envio. Confirmar compra desta etiqueta?")) return;
  button.disabled = true;
  const originalText = button.textContent;
  button.textContent = "Processando...";
  try {
    const payload = button.dataset.quoteId ? { quoteId: button.dataset.quoteId } : {};
    const result = await api(`/api/admin/orders/${encodeURIComponent(button.dataset.orderId)}/shipping/${action}`, {
      method: "POST",
      body: JSON.stringify(payload)
    });
    if (action === "print" && result.url) window.open(result.url, "_blank", "noopener");
    await loadDashboard();
  } catch (error) {
    alert(error.message);
    button.disabled = false;
    button.textContent = originalText;
  }
}

async function uploadHeroSlide(event) {
  event.preventDefault();
  $("#heroSlideStatus").textContent = "Enviando imagem...";
  try {
    const response = await fetch("/api/admin/hero-slides", {
      method: "POST",
      body: new FormData(event.currentTarget)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Nao foi possivel enviar a imagem.");
    currentSettings = result.settings;
    renderHeroSlideList();
    event.currentTarget.reset();
    $("#heroSlideStatus").textContent = "Imagem adicionada.";
  } catch (error) {
    $("#heroSlideStatus").textContent = error.message;
  }
}

async function deleteHeroSlide(slideId) {
  if (!confirm("Remover esta imagem da seção inicial?")) return;
  $("#heroSlideStatus").textContent = "Removendo imagem...";
  try {
    const result = await api(`/api/admin/hero-slides/${encodeURIComponent(slideId)}`, {
      method: "DELETE",
      body: "{}"
    });
    currentSettings = result.settings;
    renderHeroSlideList();
    $("#heroSlideStatus").textContent = "Imagem removida.";
  } catch (error) {
    $("#heroSlideStatus").textContent = error.message;
  }
}

function renderCouponList(coupons) {
  $("#couponList").innerHTML = coupons.length ? coupons.map((coupon) => `
    <article class="coupon-card">
      <div>
        <strong>${coupon.code}</strong>
        <span>${couponLabel(coupon)}</span>
      </div>
      <small>Min. ${coupon.minItems || 1} item(ns) | Compra min. ${money(coupon.minSubtotal || 0)} | ${couponExpirationLabel(coupon)}</small>
    </article>
  `).join("") : "<p>Nenhum cupom criado ainda.</p>";
}

function renderHeroSlideList() {
  const slides = currentSettings?.heroSlides || [];
  $("#heroSlideList").innerHTML = slides.length ? slides.map((slide) => `
    <article class="hero-slide-card">
      <img src="${slide.imageUrl}" alt="${slide.title}">
      <div>
        <strong>${slide.title}</strong>
        <span>${slide.imageUrl}</span>
      </div>
      <button class="ghost-button" type="button" data-delete-hero-slide="${slide.id}">Remover</button>
    </article>
  `).join("") : "<p>Nenhuma imagem cadastrada. A loja usa a imagem padrão.</p>";

  document.querySelectorAll("[data-delete-hero-slide]").forEach((button) => {
    button.addEventListener("click", () => deleteHeroSlide(button.dataset.deleteHeroSlide));
  });
}

function renderThemeGrid(activeTheme) {
  $("#themeGrid").innerHTML = themes.map((theme) => `
    <button class="theme-card ${theme.id === activeTheme ? "active" : ""}" type="button" data-theme="${theme.id}">
      <span class="theme-swatch theme-${theme.id}">
        <i></i><i></i><i></i>
      </span>
      <strong>${theme.name}</strong>
      <small>${theme.description}</small>
    </button>
  `).join("");

  document.querySelectorAll("[data-theme]").forEach((button) => {
    button.addEventListener("click", async () => {
      $("#themeStatus").textContent = "Salvando tema...";
      const result = await api("/api/admin/settings", {
        method: "PATCH",
        body: JSON.stringify({ theme: button.dataset.theme })
      });
      applyTheme(result.settings.theme);
      renderThemeGrid(result.settings.theme);
      $("#themeStatus").textContent = "Tema aplicado.";
    });
  });
}

async function checkSession() {
  const session = await api("/api/session");
  if (session.authenticated) await loadDashboard();
}

$("#loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("#loginStatus").textContent = "Entrando...";
  try {
    await api("/api/login", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget).entries())) });
    await loadDashboard();
  } catch (error) {
    $("#loginStatus").textContent = error.message;
  }
});

$("#productForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("#productStatus").textContent = "Publicando...";
  const form = event.currentTarget;
  const body = Object.fromEntries(new FormData(form).entries());
  const productId = body.productId;
  body.sellerPaysShipping = form.elements.sellerPaysShipping.checked;
  body.highlights = [...form.querySelectorAll('[name="highlightItem"]')].map((input) => input.value.trim()).filter(Boolean);
  body.specs = Object.fromEntries([...form.querySelectorAll(".spec-row")].map((row) => {
    const key = row.querySelector('[name="specKey"]').value.trim();
    const value = row.querySelector('[name="specValue"]').value.trim();
    return [key, value];
  }).filter(([key, value]) => key && value));
  delete body.highlightItem;
  delete body.specKey;
  delete body.specValue;
  delete body.productId;

  try {
    const path = productId ? `/api/admin/products/${encodeURIComponent(productId)}` : "/api/admin/products";
    const method = productId ? "PUT" : "POST";
    await api(path, { method, body: JSON.stringify(body) });
    resetProductForm();
    $("#productStatus").textContent = productId ? "Produto atualizado." : "Produto publicado.";
    await loadDashboard();
  } catch (error) {
    $("#productStatus").textContent = error.message;
  }
});

$("#refreshButton").addEventListener("click", loadDashboard);
$("#productSearchInput").addEventListener("input", renderProductsTable);
$("#storySearchInput").addEventListener("input", renderStoryAdminList);
$("#storyProductSearchInput").addEventListener("input", () => renderStoryProductOptions());
$("#campaignProductSearchInput").addEventListener("input", () => renderCampaignProductOptions());
$("#campaignProductSelect").addEventListener("change", () => {
  fillCampaignFormFromSelected.formDirty = false;
  fillCampaignFormFromSelected();
});
$("#campaignForm").addEventListener("input", (event) => {
  if (event.target !== $("#campaignProductSelect")) fillCampaignFormFromSelected.formDirty = true;
  fillCampaignFormFromSelected();
});
$("#orderSearchInput").addEventListener("input", renderOrdersList);
$("#requestSearchInput").addEventListener("input", renderAdminRequests);
$("#metricsPeriodSelect").addEventListener("change", renderMetrics);
$("#metricsOrderTypeSelect").addEventListener("change", renderMetrics);
$("#salesMonitorFullscreenButton")?.addEventListener("click", toggleSalesMonitorFullscreen);
document.querySelectorAll("[data-metrics-view]").forEach((button) => {
  button.addEventListener("click", () => {
    currentMetricsView = button.dataset.metricsView || "overview";
    applyMetricsView();
  });
});
$("#metricsExportButton").addEventListener("click", () => {
  const rows = productMetricRows(paidOrders($("#metricsPeriodSelect")?.value || "30"));
  const csv = ["Produto,Categoria,Unidades,Receita,Ticket,Avaliacao"]
    .concat(rows.map((row) => [
      row.product.name,
      row.product.category,
      row.units,
      row.revenue.toFixed(2),
      row.ticket.toFixed(2),
      row.rating.count ? `${row.rating.average.toFixed(1)} (${row.rating.count})` : ""
    ].map((value) => `"${String(value).replaceAll('"', '""')}"`).join(",")))
    .join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "basa-metricas.csv";
  link.click();
  URL.revokeObjectURL(link.href);
});
$("#heroSlideForm").addEventListener("submit", uploadHeroSlide);
document.querySelectorAll("[data-admin-tab]").forEach((button) => {
  button.addEventListener("click", () => showAdminPanel(button.dataset.adminTab));
});
$("#productForm").elements.price.addEventListener("input", updateEmbeddedShippingPreview);
$("#productForm").elements.compareAtPrice.addEventListener("input", updateEmbeddedShippingPreview);
$("#productForm").elements.sellerPaysShipping.addEventListener("change", updateEmbeddedShippingPreview);
$("#addHighlightButton").addEventListener("click", () => addHighlight());
$("#addSpecButton").addEventListener("click", () => addSpec());
$("#cancelProductEditButton").addEventListener("click", () => {
  resetProductForm();
  $("#productStatus").textContent = "";
});
$("#deleteProductButton").addEventListener("click", () => {
  const productId = $("#productForm").elements.productId.value;
  if (productId) deleteProduct(productId);
});
$("#generateCouponButton").addEventListener("click", () => {
  $("#couponForm").elements.code.value = randomCouponCode();
});
$("#couponForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("#couponStatus").textContent = "Salvando cupom...";
  const body = Object.fromEntries(new FormData(event.currentTarget).entries());
  try {
    const result = await api("/api/admin/coupons", { method: "POST", body: JSON.stringify(body) });
    renderCouponList(result.coupons);
    event.currentTarget.reset();
    event.currentTarget.elements.value.value = "0";
    event.currentTarget.elements.minItems.value = "1";
    event.currentTarget.elements.minSubtotal.value = "0";
    event.currentTarget.elements.expiresAt.value = "";
    $("#couponStatus").textContent = "Cupom salvo.";
  } catch (error) {
    $("#couponStatus").textContent = error.message;
  }
});
$("#campaignForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const productId = form.elements.productId.value;
  if (!productId) return;
  $("#campaignStatus").textContent = "Salvando campanha...";
  const body = Object.fromEntries(new FormData(form).entries());
  body.active = form.elements.active.checked;
  try {
    const result = await api(`/api/admin/products/${encodeURIComponent(productId)}/campaign`, {
      method: "PATCH",
      body: JSON.stringify(body)
    });
    currentProducts = result.products || currentProducts.map((product) => product.id === result.product.id ? result.product : product);
    renderCampaignProductOptions();
    renderCampaignList();
    renderProductsTable();
    $("#campaignStatus").textContent = "Campanha salva.";
  } catch (error) {
    $("#campaignStatus").textContent = error.message;
  }
});
$("#clearCampaignButton").addEventListener("click", async () => {
  const productId = $("#campaignForm").elements.productId.value;
  if (!productId || !confirm("Remover a campanha deste produto?")) return;
  $("#campaignStatus").textContent = "Removendo campanha...";
  try {
    const result = await api(`/api/admin/products/${encodeURIComponent(productId)}/campaign`, {
      method: "PATCH",
      body: JSON.stringify({ clear: true })
    });
    currentProducts = result.products || currentProducts.map((product) => product.id === result.product.id ? result.product : product);
    renderCampaignProductOptions();
    renderCampaignList();
    renderProductsTable();
    $("#campaignStatus").textContent = "Campanha removida.";
  } catch (error) {
    $("#campaignStatus").textContent = error.message;
  }
});
$("#storyForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("#storyStatus").textContent = "Salvando story...";
  const form = event.currentTarget;
  const storyId = form.elements.storyId.value;
  const body = new FormData(form);
  body.set("active", form.elements.active.checked ? "true" : "false");
  body.delete("storyId");
  try {
    const path = storyId ? `/api/admin/stories/${encodeURIComponent(storyId)}` : "/api/admin/stories";
    const response = await fetch(path, { method: storyId ? "PUT" : "POST", body });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Nao foi possivel salvar o story.");
    resetStoryForm();
    currentStories = data.stories || [];
    renderStoryAdminList();
    $("#storyStatus").textContent = storyId ? "Story atualizado." : "Story publicado.";
  } catch (error) {
    $("#storyStatus").textContent = error.message;
  }
});
$("#cancelStoryEditButton").addEventListener("click", () => {
  resetStoryForm();
  $("#storyStatus").textContent = "";
});
$("#displaySettingsForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("#displaySettingsStatus").textContent = "Salvando exibição...";
  try {
    const result = await api("/api/admin/settings", {
      method: "PATCH",
      body: JSON.stringify({
        displaySalesCount: event.currentTarget.elements.displaySalesCount.checked,
        displayFavoriteCount: event.currentTarget.elements.displayFavoriteCount.checked,
        displayRating: event.currentTarget.elements.displayRating.checked
      })
    });
    currentSettings = result.settings;
    fillDisplaySettings(result.settings);
    $("#displaySettingsStatus").textContent = "Exibição da vitrine salva.";
  } catch (error) {
    $("#displaySettingsStatus").textContent = error.message;
  }
});
$("#shippingSettingsForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("#shippingSettingsStatus").textContent = "Salvando envio...";
  const body = Object.fromEntries(new FormData(event.currentTarget).entries());
  try {
    const result = await api("/api/admin/settings", { method: "PATCH", body: JSON.stringify(body) });
    fillShippingSettings(result.settings);
    $("#shippingSettingsStatus").textContent = "Configuracoes de envio salvas.";
  } catch (error) {
    $("#shippingSettingsStatus").textContent = error.message;
  }
});
$("#logoutButton").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST", body: "{}" });
  location.reload();
});

resetProductForm();
resetStoryForm();
showAdminPanel("products");
checkSession().catch(() => {});



