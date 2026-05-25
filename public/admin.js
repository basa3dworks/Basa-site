const $ = (selector) => document.querySelector(selector);
const money = (value) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value);
const decimalValue = (value, fallback = 0) => {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value)
    .trim()
    .replace(/\s/g, "")
    .replace(/\.(?=\d{3}(?:\D|$))/g, "")
    .replace(",", ".");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const relativeTimeLabel = (value) => {
  const timestamp = Date.parse(value || "");
  if (!Number.isFinite(timestamp)) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "há instantes";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `há ${hours}h`;
  const days = Math.floor(hours / 24);
  return `há ${days} dia${days === 1 ? "" : "s"}`;
};
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
let currentCustomers = [];
let currentCarts = [];
let currentAffiliates = [];
let currentSellers = [];
let currentPartnerClosings = [];
let selectedOrderId = "";
let currentMetricsView = "overview";
let currentSocialProductId = "";
let chatStatusFilter = "all";
let customerStatusFilter = "all";
let affiliateStatusFilter = "all";
let partnerStatusFilter = "all";
let selectedPartnerSettlementId = "";
let productSaveInProgress = false;
let settingsSaveInProgress = false;

const uploadLimits = {
  image: 6 * 1024 * 1024,
  video: 45 * 1024 * 1024
};

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

function jumpAdminPanel(panel) {
  showAdminPanel(panel);
  window.scrollTo({ top: 0, behavior: "smooth" });
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

function affiliateCodeFromCustomer(account) {
  const customer = account.customer || {};
  return normalizeSearch(customer.displayName || account.username || customer.name || customer.email || "afiliado")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "afiliado";
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function uploadLimitLabel(bytes) {
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

function validateUploadSize(file, kind = "image") {
  const isVideo = file.type.startsWith("video/") || /\.(mp4|webm|mov|m4v)$/i.test(file.name);
  const limit = isVideo ? uploadLimits.video : uploadLimits.image;
  if (file.size <= limit) return "";
  return `${file.name} está muito pesado. Limite: ${uploadLimitLabel(limit)} para ${isVideo ? "vídeo" : "imagem"}.`;
}

function validateFormUploads(form) {
  const errors = [...form.querySelectorAll('input[type="file"]')]
    .flatMap((input) => [...input.files].map((file) => validateUploadSize(file)))
    .filter(Boolean);
  if (errors.length) throw new Error(errors[0]);
}

function uploadFailureMessage(error) {
  const message = String(error?.message || "");
  if (message === "Failed to fetch" || message.includes("NetworkError") || message.includes("ERR_INSUFFICIENT_RESOURCES")) {
    return "Falha ao enviar. Confira o tamanho das fotos e vídeos, atualize a página e tente novamente.";
  }
  return message || "Não foi possível concluir a operação.";
}

function isRecentlyPosted(product) {
  const createdAt = new Date(product.createdAt || 0).getTime();
  return Number.isFinite(createdAt) && createdAt > 0 && Date.now() - createdAt <= 30 * 24 * 60 * 60 * 1000;
}

function dynamicSoldCount(product) {
  const paidStatuses = new Set(["paid", "in_production", "shipped", "completed"]);
  const realSold = currentOrders
    .filter((order) => paidStatuses.has(order.status))
    .flatMap((order) => order.items || [])
    .filter((item) => item.productId === product.id)
    .reduce((sum, item) => sum + Number(item.quantity || 0), 0);
  const socialSold = (product.reviews || [])
    .filter((review) => review.approved !== false)
    .reduce((sum, review) => sum + Number(review.soldUnits || 0), 0);
  return Number(product.soldCount || 0) + realSold + socialSold;
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

function aiInsightSummary() {
  const paid = paidOrders("all");
  const revenue = paid.reduce((sum, order) => sum + Number(order.total || 0), 0);
  const units = orderItemsTotal(paid);
  const freeShippingOrders = paid.filter((order) => Number(order.shipping || 0) === 0).length;
  const openRequests = currentRequests.filter((request) => !["completed", "canceled"].includes(request.status)).length;
  const rows = productMetricRows(paid);
  const topProduct = rows.find((row) => row.units > 0);
  const noSales = rows.filter((row) => row.units === 0).length;
  return {
    paid,
    rows,
    topProduct,
    noSales,
    openRequests,
    revenue,
    units,
    averageTicket: paid.length ? revenue / paid.length : 0,
    freeShippingOrders
  };
}

function renderAiInsightBrief() {
  const summary = aiInsightSummary();
  const brief = $("#aiInsightBrief");
  if (!brief) return;
  brief.innerHTML = `
    <article><span>Receita paga</span><strong>${money(summary.revenue)}</strong><small>${summary.paid.length} pedido(s)</small></article>
    <article><span>Ticket médio</span><strong>${money(summary.averageTicket)}</strong><small>${summary.units} unidade(s)</small></article>
    <article><span>Frete grátis</span><strong>${summary.freeShippingOrders}</strong><small>pedido(s) beneficiados</small></article>
    <article><span>Orçamentos abertos</span><strong>${summary.openRequests}</strong><small>sob medida</small></article>
  `;
}

function renderLocalAiInsight() {
  const summary = aiInsightSummary();
  const output = $("#aiInsightOutput");
  const source = $("#aiInsightSource");
  if (!output) return;
  if (source) source.textContent = "Leitura local";
  const topProduct = summary.topProduct?.product?.name || "sem produto vencedor ainda";
  output.innerHTML = `
    <article class="ai-recommendation-card strong">
      <b>Prioridade comercial</b>
      <p>Revise produtos reais, fotos, estoque e preço final antes de comprar tráfego. A IA usa estes dados para sugerir campanhas melhores.</p>
    </article>
    <article class="ai-recommendation-card">
      <b>Produto para observar</b>
      <p>${topProduct}. Quando houver vendas suficientes, use esse item como base para oferta relâmpago e story de produção.</p>
    </article>
    <article class="ai-recommendation-card">
      <b>Risco atual</b>
      <p>${summary.noSales} produto(s) ainda sem venda paga. Teste título, imagem principal, preço antigo e categoria.</p>
    </article>
  `;
}

function renderAiInsightText(text) {
  const output = $("#aiInsightOutput");
  if (!output) return;
  const blocks = String(text || "").split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
  output.innerHTML = blocks.length ? blocks.map((block, index) => `
    <article class="ai-recommendation-card ${index === 0 ? "strong" : ""}">
      <p>${escapeHtml(block).replace(/\n/g, "<br>")}</p>
    </article>
  `).join("") : "<p>A IA não retornou texto para exibir.</p>";
}

async function generateAiInsights() {
  const button = $("#generateInsightsButton");
  const source = $("#aiInsightSource");
  if (button) button.disabled = true;
  if (button) button.textContent = "Gerando...";
  if (source) source.textContent = "Consultando IA";
  try {
    const result = await api("/api/admin/ai-insights", { method: "POST", body: JSON.stringify({}) });
    renderAiInsightText(result.insight);
    if (source) source.textContent = result.warning || (result.source === "openai" ? `OpenAI ${result.model || ""}`.trim() : "Leitura local");
  } catch (error) {
    if (source) source.textContent = "Erro na análise";
    $("#aiInsightOutput").innerHTML = `<article class="ai-recommendation-card danger"><b>Não foi possível gerar agora</b><p>${escapeHtml(error.message)}</p></article>`;
  } finally {
    if (button) button.disabled = false;
    if (button) button.textContent = "Gerar insights";
  }
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

function renderSocialProductOptions({ keepSelected = false } = {}) {
  const select = $("#socialProductSelect");
  if (!select) return;
  const selectedProductId = select.value || currentSocialProductId;
  const query = $("#socialProductSearchInput")?.value || "";
  const filteredProducts = currentProducts.filter((product) => matchesSearch([
    product.sku,
    product.name,
    product.category,
    product.status,
    product.description
  ].join(" "), query));
  const selectedProduct = currentProducts.find((product) => product.id === selectedProductId);
  const products = keepSelected && selectedProduct && !filteredProducts.some((product) => product.id === selectedProduct.id)
    ? [selectedProduct, ...filteredProducts]
    : filteredProducts;
  select.innerHTML = products.length
    ? products.map((product) => `<option value="${product.id}">${product.sku ? `${product.sku} - ` : ""}${product.name}</option>`).join("")
    : `<option value="">Nenhum produto encontrado</option>`;
  const nextValue = keepSelected && selectedProductId && products.some((product) => product.id === selectedProductId)
    ? selectedProductId
    : products[0]?.id || "";
  select.value = nextValue;
  currentSocialProductId = nextValue;
  renderSocialProofList();
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

function campaignDatePayload(form) {
  const startsAt = form.elements.startsAt.value ? new Date(form.elements.startsAt.value).toISOString() : "";
  const endsAt = form.elements.endsAt.value ? new Date(form.elements.endsAt.value).toISOString() : "";
  return { startsAt, endsAt };
}

function campaignDateError(form) {
  const startsAt = form.elements.startsAt.value ? new Date(form.elements.startsAt.value).getTime() : 0;
  const endsAt = form.elements.endsAt.value ? new Date(form.elements.endsAt.value).getTime() : 0;
  if (startsAt && endsAt && endsAt <= startsAt) return "A campanha precisa terminar depois de começar.";
  return "";
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
    ...campaignDatePayload(form),
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

function socialProduct() {
  return currentProducts.find((product) => product.id === ($("#socialProductSelect")?.value || currentSocialProductId));
}

function socialRatingLabel(rating) {
  const value = Number(rating || 0);
  return value ? `${value.toFixed(value % 1 ? 1 : 0)} estrelas` : "Sem nota";
}

function isVideoMedia(url) {
  return /\.(mp4|webm|mov|m4v)$/i.test(String(url || "").split("?")[0]);
}

function reviewMediaList(review) {
  return review?.media || review?.photos || [];
}

function renderReviewMedia(media, className) {
  return media.length ? `<div class="${className}">${media.map((item) => {
    const url = typeof item === "string" ? item : item?.url;
    if (!url) return "";
    return isVideoMedia(url)
      ? `<video src="${url}" controls muted playsinline aria-label="Vídeo do pedido"></video>`
      : `<img src="${url}" alt="Foto do pedido">`;
  }).join("")}</div>` : "";
}

function renderSocialProofList() {
  const target = $("#socialProofList");
  if (!target) return;
  const product = socialProduct();
  if (!product) {
    target.innerHTML = "<p>Selecione um produto para ver as postagens sociais.</p>";
    return;
  }
  const reviews = product.reviews || [];
  target.innerHTML = `
    <div class="social-proof-list-head">
      <div>
        <strong>${product.name}</strong>
        <span>${product.sku || "Sem SKU"} | ${ratingSummary(product)} | ${dynamicSoldCount(product)} vendidos reais</span>
      </div>
      <small>${reviews.length} postagem(ns) social(is)</small>
    </div>
    ${reviews.length ? reviews.map((review) => `
      <article class="social-proof-card">
        <div>
          <strong>${escapeHtml(review.customerName || "Cliente Basa")}</strong>
          <span>${socialRatingLabel(review.rating)} | ${review.source === "customer" ? "Comentário de cliente" : `+${Number(review.soldUnits || 0)} vendido(s)`}${review.orderId ? ` | ${review.orderId}` : ""}${review.approved === false ? " | Oculto" : ""}</span>
          <p>${escapeHtml(review.comment || "Sem comentário")}</p>
          ${renderReviewMedia(reviewMediaList(review), "social-proof-photos")}
        </div>
        <div class="story-admin-actions">
          <button class="ghost-button table-action" type="button" data-edit-social="${review.id}">Editar</button>
          <button class="ghost-button table-action" type="button" data-delete-social="${review.id}">Excluir</button>
        </div>
      </article>
    `).join("") : "<p>Nenhuma prova social cadastrada para este produto.</p>"}
  `;

  document.querySelectorAll("[data-edit-social]").forEach((button) => {
    button.addEventListener("click", () => editSocialProof(button.dataset.editSocial));
  });
  document.querySelectorAll("[data-delete-social]").forEach((button) => {
    button.addEventListener("click", () => deleteSocialProof(button.dataset.deleteSocial));
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

function personStatusLabel(status) {
  return {
    active: "Ativo",
    lead: "Lead",
    paused: "Pausado",
    blocked: "Bloqueado"
  }[status] || status || "Lead";
}

function customerSearchText(account) {
  const customer = account.customer || {};
  return [
    account.username,
    account.status,
    account.notes,
    customer.name,
    customer.displayName,
    customer.email,
    customer.phone,
    customer.document,
    customer.city,
    customer.state
  ].join(" ");
}

function partnerSearchText(item) {
  return [
    item.code,
    item.name,
    item.brandName,
    item.email,
    item.phone,
    item.document,
    item.status,
    item.notes
  ].join(" ");
}

function commissionStatusLabel(status) {
  return {
    pending: "Pendente",
    confirmed: "Confirmada",
    closing: "Em fechamento",
    available: "Disponível",
    paid: "Paga",
    canceled: "Cancelada"
  }[status] || status || "Pendente";
}

function affiliateOrderRows() {
  return currentOrders
    .filter((order) => order.affiliate)
    .map((order) => ({
      order,
      affiliate: order.affiliate,
      status: order.affiliate?.status || "pending",
      amount: Number(order.affiliate?.amount || 0),
      total: Number(order.subtotal || order.total || 0)
    }));
}

function affiliateMetrics(affiliate) {
  const code = String(affiliate.code || "").toLowerCase();
  const id = affiliate.id;
  const rows = affiliateOrderRows().filter((row) =>
    row.affiliate?.affiliateId === id || String(row.affiliate?.code || "").toLowerCase() === code
  );
  const totals = rows.reduce((acc, row) => {
    acc.orders += 1;
    acc.sold += row.total;
    acc[row.status] = (acc[row.status] || 0) + row.amount;
    if (["confirmed", "available", "paid"].includes(row.status)) acc.commission += row.amount;
    return acc;
  }, { orders: 0, sold: 0, commission: 0, pending: 0, confirmed: 0, available: 0, paid: 0, canceled: 0 });
  totals.receivable = (totals.confirmed || 0) + (totals.available || 0);
  return totals;
}

function partnerSettlementRows() {
  return currentOrders.flatMap((order) =>
    (order.partnerSettlements || []).map((settlement) => ({
      order,
      settlement,
      status: settlement.payoutStatus || "pending",
      amount: Number(settlement.partnerReceivable || 0)
    }))
  );
}

function partnerMetrics(partner) {
  const rows = partnerSettlementRows().filter((row) => row.settlement.partnerId === partner.id);
  const totals = rows.reduce((acc, row) => {
    acc.orders += 1;
    acc.gross += Number(row.settlement.grossItemTotal || 0);
    acc.discount += Number(row.settlement.discountShare || 0);
    acc.shipping += Number(row.settlement.shippingShare || 0);
    acc.store += Number(row.settlement.storeCommission || 0);
    acc[row.status] = (acc[row.status] || 0) + row.amount;
    if (["confirmed", "available", "paid"].includes(row.status)) acc.receivable += row.amount;
    return acc;
  }, { orders: 0, gross: 0, discount: 0, shipping: 0, store: 0, receivable: 0, pending: 0, confirmed: 0, available: 0, paid: 0, canceled: 0 });
  totals.products = currentProducts.filter((product) => product.partnerId === partner.id).length;
  return totals;
}

function partnerMatchesStatus(partner, status) {
  if (status === "all") return true;
  if (["active", "lead", "paused"].includes(status)) return (partner.status || "lead") === status;
  const metrics = partnerMetrics(partner);
  if (status === "pending") return Number(metrics.pending || 0) > 0;
  if (status === "available") return Number(metrics.confirmed || 0) + Number(metrics.available || 0) > 0;
  if (status === "closing") return currentPartnerClosings.some((closing) => closing.partnerId === partner.id && closing.status === "closing");
  if (status === "paid") return Number(metrics.paid || 0) > 0;
  return true;
}

function partnerSettlementStatusLabel(status) {
  return {
    all: "Todos",
    active: "Ativos",
    lead: "Leads",
    paused: "Pausados",
    pending: "Repasse pendente",
    available: "Disponível",
    closing: "Em fechamento",
    paid: "Pagos"
  }[status] || personStatusLabel(status);
}

function renderProductPartnerOptions(selectedId = "") {
  const select = $("#productPartnerSelect");
  if (!select) return;
  const partners = currentSellers.filter((partner) => partner.status === "active");
  select.innerHTML = `<option value="">Produto próprio Basa</option>${partners.map((partner) => `
    <option value="${partner.id}" ${partner.id === selectedId ? "selected" : ""}>${escapeHtml(partner.brandName || partner.name)} (${Number(partner.commissionPercent || 0)}%)</option>
  `).join("")}`;
}

function selectedProductPartner() {
  const id = $("#productPartnerSelect")?.value || "";
  return currentSellers.find((partner) => partner.id === id) || null;
}

function productPartnerFinancials(product = {}) {
  const partner = product.partnerId
    ? currentSellers.find((item) => item.id === product.partnerId)
    : selectedProductPartner();
  const price = Number(product.price ?? decimalValue($("#productForm")?.elements.price?.value || 0));
  const percent = Number(product.partnerStoreCommissionPercent ?? decimalValue($("#productForm")?.elements.partnerStoreCommissionPercent?.value || partner?.commissionPercent || 0));
  const storeCommission = price * percent / 100;
  const partnerPreview = Math.max(0, price - storeCommission);
  return { partner, price, percent, storeCommission, partnerPreview };
}

function updateProductPartnerPreview() {
  const preview = $("#productPartnerPreview");
  if (!preview) return;
  const { partner, price, percent, storeCommission, partnerPreview } = productPartnerFinancials();
  if (!partner) {
    preview.innerHTML = "Produto próprio Basa. Nenhum repasse de parceiro será calculado.";
    return;
  }
  preview.innerHTML = `
    <strong>Produto parceiro:</strong> ${escapeHtml(partner.brandName || partner.name)}
    | Comissão Basa ${Number(percent || 0)}% (${money(storeCommission || 0)})
    | Prévia do parceiro sem frete: ${money(partnerPreview || 0)}
    | Base: ${money(price || 0)}
  `;
}

function productPartnerTableLabel(product) {
  if (!product.partnerId) return "Produto Basa";
  const { partner, percent, storeCommission, partnerPreview } = productPartnerFinancials(product);
  return `
    <strong>${escapeHtml(partner?.brandName || partner?.name || "Parceiro")}</strong>
    <small>Basa ${Number(percent || 0)}% (${money(storeCommission || 0)}) | parceiro ${money(partnerPreview || 0)} sem frete</small>
  `;
}

function renderPartnerSettlementSelect(partners) {
  const select = $("#partnerSettlementSelect");
  if (!select) return;
  const activeId = selectedPartnerSettlementId && currentSellers.some((partner) => partner.id === selectedPartnerSettlementId)
    ? selectedPartnerSettlementId
    : "";
  selectedPartnerSettlementId = activeId;
  select.innerHTML = `<option value="">Todos os parceiros</option>${partners.map((partner) => `
    <option value="${partner.id}" ${partner.id === activeId ? "selected" : ""}>${escapeHtml(partner.brandName || partner.name)}</option>
  `).join("")}`;
}

function partnerCloseRows() {
  return partnerSettlementRows().filter((row) => {
    const settlement = row.settlement || {};
    if (selectedPartnerSettlementId && settlement.partnerId !== selectedPartnerSettlementId) return false;
    return ["confirmed", "available"].includes(settlement.payoutStatus || row.status);
  });
}

function partnerPaidRows() {
  return partnerSettlementRows()
    .filter((row) => {
      const settlement = row.settlement || {};
      if (selectedPartnerSettlementId && settlement.partnerId !== selectedPartnerSettlementId) return false;
      return (settlement.payoutStatus || row.status) === "paid";
    })
    .sort((a, b) => new Date(b.settlement.paidAt || b.order.updatedAt || 0) - new Date(a.settlement.paidAt || a.order.updatedAt || 0));
}

function renderPartnerSettlementClose(partners) {
  renderPartnerSettlementSelect(partners);
  const rows = partnerCloseRows();
  const paidRows = partnerPaidRows();
  const closingRows = currentPartnerClosings.filter((closing) => !selectedPartnerSettlementId || closing.partnerId === selectedPartnerSettlementId);
  const totals = rows.reduce((acc, row) => {
    const settlement = row.settlement || {};
    acc.base += Number(settlement.settlementBase || 0);
    acc.discount += Number(settlement.discountShare || 0);
    acc.shipping += Number(settlement.shippingShare || 0);
    acc.store += Number(settlement.storeCommission || 0);
    acc.partner += Number(settlement.partnerReceivable || 0);
    return acc;
  }, { base: 0, discount: 0, shipping: 0, store: 0, partner: 0 });
  const kpi = $("#partnerSettlementKpiGrid");
  if (kpi) {
    kpi.innerHTML = `
      <article><span>Pedidos</span><strong>${new Set(rows.map((row) => row.order.id)).size}</strong><small>Com repasse disponível</small></article>
      <article><span>Base com frete</span><strong>${money(totals.base)}</strong><small>Desconto já abatido</small></article>
      <article><span>Frete incluído</span><strong>${money(totals.shipping)}</strong><small>Proporcional por item</small></article>
      <article><span>Comissão Basa</span><strong>${money(totals.store)}</strong><small>Retida no fechamento</small></article>
      <article><span>Repasse</span><strong>${money(totals.partner)}</strong><small>Valor para pagar</small></article>
    `;
  }
  const list = $("#partnerSettlementCloseList");
  if (list) {
    const availableMarkup = rows.length ? rows.map((row) => {
      const settlement = row.settlement || {};
      return `
        <article class="affiliate-commission-row">
          <div>
            <span>${escapeHtml(settlement.partnerName || "Parceiro")}</span>
            <small>${row.order.id} | ${escapeHtml(settlement.productName || "Produto")} | ${orderStatusLabel(row.order.status)} | ${commissionStatusLabel(settlement.payoutStatus)}</small>
            <small>Base ${money(settlement.settlementBase || 0)} | frete ${money(settlement.shippingShare || 0)} | desconto ${money(settlement.discountShare || 0)} | Basa ${money(settlement.storeCommission || 0)}</small>
          </div>
          <b>${money(settlement.partnerReceivable || 0)}</b>
        </article>
      `;
    }).join("") : `<p>Nenhum repasse disponível para fechamento.</p>`;
    const paidMarkup = paidRows.slice(0, 8).length ? `
      <h4>Pagos recentemente</h4>
      ${paidRows.slice(0, 8).map((row) => {
        const settlement = row.settlement || {};
        return `
          <article class="affiliate-commission-row">
            <div>
              <span>${escapeHtml(settlement.partnerName || "Parceiro")}</span>
              <small>${row.order.id} | ${escapeHtml(settlement.productName || "Produto")} | pago em ${settlement.paidAt ? new Date(settlement.paidAt).toLocaleString("pt-BR") : "data não informada"}</small>
              <small>Recibo ${escapeHtml(settlement.receiptId || "sem código")}</small>
            </div>
            <div class="table-actions">
              <b>${money(settlement.partnerReceivable || 0)}</b>
              ${settlement.receiptId ? `<a class="ghost-button table-action" href="/api/admin/partner-receipts/${encodeURIComponent(settlement.receiptId)}" target="_blank" rel="noopener">Ver recibo</a>` : ""}
            </div>
          </article>
        `;
      }).join("")}
    ` : "";
    list.innerHTML = `${availableMarkup}${paidMarkup}`;
  }
  const closingList = $("#partnerClosingList");
  if (closingList) {
    closingList.innerHTML = closingRows.length ? `
      <h4>Fechamentos</h4>
      ${closingRows.slice(0, 12).map((closing) => {
        const totals = closing.totals || {};
        return `
          <article class="affiliate-commission-row">
            <div>
              <strong>${escapeHtml(closing.id)}</strong>
              <span>${escapeHtml(closing.partnerName || "Parceiro")} | ${commissionStatusLabel(closing.status)}</span>
              <small>${(closing.items || []).length} pedido(s) | frete ${money(totals.shippingShare || 0)} | desconto ${money(totals.discountShare || 0)} | Basa ${money(totals.storeCommission || 0)}</small>
            </div>
            <div class="table-actions">
              <b>${money(totals.partnerReceivable || 0)}</b>
              ${closing.status === "closing" ? `<button class="ghost-button table-action" type="button" data-close-partner-closing="${closing.id}">Marcar pago</button>` : ""}
              ${closing.receiptId ? `<a class="ghost-button table-action" href="/api/admin/partner-receipts/${encodeURIComponent(closing.receiptId)}" target="_blank" rel="noopener">Recibo</a>` : ""}
            </div>
          </article>
        `;
      }).join("")}
    ` : "";
  }
  const button = $("#createPartnerClosingButton");
  if (button) button.disabled = rows.length === 0;
  document.querySelectorAll("[data-close-partner-closing]").forEach((button) => {
    button.addEventListener("click", () => markPartnerClosingPaid(button));
  });
}

function affiliateProductOpportunities() {
  const activeAffiliates = currentAffiliates.filter((affiliate) => affiliate.status === "active");
  const defaultPercent = activeAffiliates.length
    ? activeAffiliates.reduce((sum, affiliate) => sum + Number(affiliate.commissionPercent || 0), 0) / activeAffiliates.length
    : 0;
  return currentProducts
    .filter((product) => product.status !== "inactive")
    .map((product) => {
      const percent = Number(product.affiliateCommissionPercent || defaultPercent || 0);
      const price = Number(product.price || 0);
      return {
        product,
        percent,
        commission: price * percent / 100,
        score: price * percent / 100 + Number(product.favoriteCount || 0) * 0.4 + Number(product.soldCount || product.soldUnits || 0) * 0.8
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);
}

function renderAffiliateDashboard(affiliates) {
  const rows = affiliateOrderRows();
  const activeAffiliates = currentAffiliates.filter((item) => item.status === "active");
  const totals = rows.reduce((acc, row) => {
    acc.orders += 1;
    acc.sold += row.total;
    acc.pending += row.status === "pending" ? row.amount : 0;
    acc.receivable += ["confirmed", "available"].includes(row.status) ? row.amount : 0;
    acc.paid += row.status === "paid" ? row.amount : 0;
    return acc;
  }, { orders: 0, sold: 0, pending: 0, receivable: 0, paid: 0 });

  const kpiGrid = $("#affiliateKpiGrid");
  if (kpiGrid) {
    kpiGrid.innerHTML = `
      <article><span>Afiliados ativos</span><strong>${activeAffiliates.length}</strong><small>${currentAffiliates.length} cadastrados</small></article>
      <article><span>Vendas rastreadas</span><strong>${money(totals.sold)}</strong><small>${totals.orders} pedidos com afiliado</small></article>
      <article><span>A receber</span><strong>${money(totals.receivable)}</strong><small>Confirmado ou disponível</small></article>
      <article><span>Pendente</span><strong>${money(totals.pending)}</strong><small>Aguardando pagamento</small></article>
    `;
  }

  const ranked = currentAffiliates
    .map((affiliate) => ({ affiliate, metrics: affiliateMetrics(affiliate) }))
    .sort((a, b) => b.metrics.commission - a.metrics.commission || b.metrics.sold - a.metrics.sold)
    .slice(0, 8);
  const leaderboard = $("#affiliateLeaderboard");
  if (leaderboard) {
    leaderboard.innerHTML = ranked.length ? ranked.map(({ affiliate, metrics }, index) => `
      <article class="affiliate-rank-card">
        <b>${index + 1}</b>
        <div>
          <strong>${escapeHtml(affiliate.name || affiliate.code || "Afiliado")}</strong>
          <span>${escapeHtml(affiliate.code || "")} | ${personStatusLabel(affiliate.status)}</span>
        </div>
        <em>${money(metrics.commission)}</em>
        <small>${metrics.orders} pedidos | ${money(metrics.sold)}</small>
      </article>
    `).join("") : `<p>Nenhuma venda rastreada ainda.</p>`;
  }

  const commissionTable = $("#affiliateCommissionTable");
  if (commissionTable) {
    const recentRows = rows.slice().sort((a, b) => new Date(b.order.createdAt || 0) - new Date(a.order.createdAt || 0)).slice(0, 8);
    commissionTable.innerHTML = recentRows.length ? recentRows.map((row) => `
      <article class="affiliate-commission-row">
        <div>
          <strong>${escapeHtml(row.order.id)}</strong>
          <span>${escapeHtml(row.affiliate?.name || row.affiliate?.code || "Afiliado")}</span>
        </div>
        <small>${commissionStatusLabel(row.status)} | ${orderStatusLabel(row.order.status)}</small>
        <b>${money(row.amount)}</b>
      </article>
    `).join("") : `<p>Quando pedidos entrarem por links de afiliado, aparecem aqui.</p>`;
  }

  const productList = $("#affiliateProductOpportunities");
  if (productList) {
    const rows = affiliateProductOpportunities();
    productList.innerHTML = rows.length ? rows.map(({ product, percent, commission }) => `
      <article class="affiliate-product-opportunity">
        ${product.image ? `<img src="${product.image}" alt="">` : `<span class="product-placeholder">Produto</span>`}
        <div>
          <strong>${escapeHtml(product.name || "Produto")}</strong>
          <span>${escapeHtml(product.category || "Geral")} | ${money(Number(product.price || 0))}</span>
          <small>Comissão sugerida ${Number(percent || 0)}% = ${money(commission)}</small>
        </div>
      </article>
    `).join("") : `<p>Cadastre produtos ativos para montar oportunidades.</p>`;
  }

  document.querySelectorAll("[data-affiliate-status]").forEach((button) => {
    const status = button.dataset.affiliateStatus;
    button.classList.toggle("active", status === affiliateStatusFilter);
    const count = status === "all" ? currentAffiliates.length : currentAffiliates.filter((affiliate) => affiliate.status === status).length;
    const label = { all: "Todos", active: "Ativos", lead: "Leads", paused: "Pausados" }[status] || personStatusLabel(status);
    button.textContent = `${label} (${count})`;
  });
}

function renderPartnerDashboard(partners) {
  const partnerIds = new Set(partners.map((partner) => partner.id));
  const rows = partnerSettlementRows().filter((row) => !partnerIds.size || partnerIds.has(row.settlement.partnerId));
  const totals = rows.reduce((acc, row) => {
    acc.receivable += ["confirmed", "available"].includes(row.status) ? row.amount : 0;
    acc.pending += row.status === "pending" ? row.amount : 0;
    acc.shipping += Number(row.settlement.shippingShare || 0);
    acc.store += Number(row.settlement.storeCommission || 0);
    return acc;
  }, { receivable: 0, pending: 0, shipping: 0, store: 0 });
  const kpi = $("#partnerKpiGrid");
  if (kpi) {
    kpi.innerHTML = `
      <article><span>Parceiros</span><strong>${partners.length}</strong><small>${partners.filter((item) => item.status === "active").length} ativos</small></article>
      <article><span>A repassar</span><strong>${money(totals.receivable)}</strong><small>Confirmado/disponível</small></article>
      <article><span>Pendente</span><strong>${money(totals.pending)}</strong><small>Aguardando pagamento</small></article>
      <article><span>Frete alocado</span><strong>${money(totals.shipping)}</strong><small>Incluído no cálculo</small></article>
      <article><span>Comissão Basa</span><strong>${money(totals.store)}</strong><small>Sobre produtos parceiros</small></article>
    `;
  }
  const settlementTable = $("#partnerSettlementTable");
  if (settlementTable) {
    settlementTable.innerHTML = rows.slice(0, 10).length ? rows.slice(0, 10).map((row) => `
      <article class="affiliate-commission-row">
        <span>${escapeHtml(row.settlement.partnerName || "Parceiro")}</span>
        <small>${row.order.id} | ${escapeHtml(row.settlement.productName || "Produto")} | ${commissionStatusLabel(row.status)}</small>
        <b>${money(row.amount)}</b>
      </article>
    `).join("") : `<p>Quando um produto parceiro vender, o repasse aparece aqui.</p>`;
  }
  const productList = $("#partnerProductList");
  if (productList) {
    const linked = currentProducts.filter((product) => product.partnerId && (!partnerIds.size || partnerIds.has(product.partnerId))).slice(0, 10);
    productList.innerHTML = linked.length ? linked.map((product) => {
      const partner = currentSellers.find((item) => item.id === product.partnerId);
      return `
        <article class="affiliate-product-opportunity">
          ${product.image ? `<img src="${product.image}" alt="">` : `<span class="product-placeholder">Produto</span>`}
          <div>
            <strong>${escapeHtml(product.name || "Produto")}</strong>
            <span>${escapeHtml(partner?.brandName || partner?.name || "Parceiro")} | ${money(Number(product.price || 0))}</span>
            <small>Comissão Basa ${Number(product.partnerStoreCommissionPercent || partner?.commissionPercent || 0)}%</small>
          </div>
        </article>
      `;
    }).join("") : `<p>Vincule um parceiro no cadastro do produto.</p>`;
  }
  renderPartnerSettlementClose(partners);
}

function renderPeopleLists() {
  const query = $("#peopleSearchInput")?.value || "";
  const affiliateQuery = $("#affiliateSearchInput")?.value || "";
  const partnerQuery = $("#partnerSearchInput")?.value || "";
  const customers = currentCustomers.filter((item) =>
    (customerStatusFilter === "all" || (item.status || "active") === customerStatusFilter)
    && matchesSearch(customerSearchText(item), query)
  );
  const affiliates = currentAffiliates.filter((item) =>
    (affiliateStatusFilter === "all" || (item.status || "lead") === affiliateStatusFilter)
    && matchesSearch(partnerSearchText(item), affiliateQuery)
  );
  const partners = currentSellers.filter((item) =>
    partnerMatchesStatus(item, partnerStatusFilter)
    && matchesSearch(partnerSearchText(item), partnerQuery)
  );
  const partnerCounts = currentSellers.reduce((acc, item) => {
    ["all", "active", "lead", "paused", "pending", "available", "closing", "paid"].forEach((status) => {
      if (partnerMatchesStatus(item, status)) acc[status] = (acc[status] || 0) + 1;
    });
    return acc;
  }, {});
  const customerCounts = currentCustomers.reduce((acc, item) => {
    const status = item.status || "active";
    acc.all += 1;
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, { all: 0, active: 0, lead: 0, blocked: 0 });

  document.querySelectorAll("[data-customer-status]").forEach((button) => {
    const status = button.dataset.customerStatus;
    button.classList.toggle("active", status === customerStatusFilter);
    const baseLabel = {
      all: "Todos",
      active: "Ativos",
      lead: "Leads",
      blocked: "Bloqueados"
    }[status] || personStatusLabel(status);
    button.textContent = `${baseLabel} (${customerCounts[status] || 0})`;
  });

  renderAffiliateDashboard(affiliates);
  renderPartnerDashboard(partners);

  document.querySelectorAll("[data-partner-status]").forEach((button) => {
    const status = button.dataset.partnerStatus;
    button.classList.toggle("active", status === partnerStatusFilter);
    button.textContent = `${partnerSettlementStatusLabel(status)} (${partnerCounts[status] || 0})`;
  });

  const customersList = $("#customersList");
  if (customersList) {
    customersList.innerHTML = customers.length ? customers.map((account) => {
      const customer = account.customer || {};
      return `
        <article class="people-card">
          <div>
            <strong>${escapeHtml(customer.name || account.username || "Cliente")} ${customer.profileVerified ? '<span class="profile-verified" title="Perfil verificado" aria-label="Perfil verificado"></span>' : ""}</strong>
            <span>${escapeHtml(customer.email || "")}${customer.phone ? ` | ${escapeHtml(customer.phone)}` : ""}</span>
            <small>@${escapeHtml(customer.displayName || account.username || "")} | ${personStatusLabel(account.status)}</small>
          </div>
          <div class="story-admin-actions">
            <button class="ghost-button table-action" type="button" data-start-chat-customer="${account.id}">Chat</button>
            <button class="ghost-button table-action" type="button" data-promote-customer-affiliate="${account.id}">Promover a afiliado</button>
            <button class="ghost-button table-action" type="button" data-edit-customer="${account.id}">Editar</button>
            <button class="ghost-button table-action" type="button" data-delete-customer="${account.id}">Excluir</button>
          </div>
        </article>
      `;
    }).join("") : '<article class="people-card"><strong>Nenhum cliente encontrado</strong><span>Quando houver clientes cadastrados, eles aparecem aqui para aprovar o selo verificado.</span></article>';
  }

  $("#affiliatesList").innerHTML = affiliates.length ? affiliates.map((affiliate) => {
    const metrics = affiliateMetrics(affiliate);
    const shareUrl = `${location.origin}/?ref=${encodeURIComponent(affiliate.code || "")}`;
    return `
    <article class="people-card">
      <div>
        <strong>${affiliate.name}</strong>
        <span>${affiliate.email}${affiliate.phone ? ` | ${affiliate.phone}` : ""}</span>
        <small>${affiliate.code ? `Código: ${affiliate.code} | ` : ""}${personStatusLabel(affiliate.status)} | Comissão ${Number(affiliate.commissionPercent || 0)}%</small>
        <small>${metrics.orders} pedidos | ${money(metrics.receivable)} a receber | ${money(metrics.pending)} pendente</small>
      </div>
      <div class="story-admin-actions">
        <button class="ghost-button table-action" type="button" data-copy-affiliate-link="${escapeHtml(shareUrl)}">Link</button>
        <button class="ghost-button table-action" type="button" data-edit-affiliate="${affiliate.id}">Editar</button>
        <button class="ghost-button table-action" type="button" data-delete-affiliate="${affiliate.id}">Excluir</button>
      </div>
    </article>
  `;
  }).join("") : "<p>Nenhum afiliado cadastrado.</p>";

  const sellersList = $("#sellersList");
  if (sellersList) {
    sellersList.innerHTML = partners.length ? partners.map((partner) => {
      const metrics = partnerMetrics(partner);
      return `
        <article class="people-card">
          <div>
            <strong>${escapeHtml(partner.brandName || partner.name)}</strong>
            <span>${escapeHtml(partner.email || "")}${partner.phone ? ` | ${escapeHtml(partner.phone)}` : ""}</span>
            <small>${partner.code ? `Código: ${escapeHtml(partner.code)} | ` : ""}${personStatusLabel(partner.status)} | Comissão Basa ${Number(partner.commissionPercent || 0)}%</small>
            <small>${metrics.products} produto(s) | ${metrics.orders} repasse(s) | ${money(metrics.receivable)} a repassar | frete ${money(metrics.shipping)}</small>
          </div>
          <div class="story-admin-actions">
            <button class="ghost-button table-action" type="button" data-edit-seller="${partner.id}">Editar</button>
            <button class="ghost-button table-action danger-button" type="button" data-delete-seller="${partner.id}">Excluir</button>
          </div>
        </article>
      `;
    }).join("") : "<p>Nenhum parceiro cadastrado.</p>";
  }

  document.querySelectorAll("[data-copy-affiliate-link]").forEach((button) => button.addEventListener("click", async () => {
    await navigator.clipboard?.writeText(button.dataset.copyAffiliateLink || "");
    button.textContent = "Copiado";
    setTimeout(() => { button.textContent = "Link"; }, 1200);
  }));
  document.querySelectorAll("[data-edit-affiliate]").forEach((button) => button.addEventListener("click", () => editAffiliate(button.dataset.editAffiliate)));
  document.querySelectorAll("[data-delete-affiliate]").forEach((button) => button.addEventListener("click", () => deleteAffiliate(button.dataset.deleteAffiliate)));
  document.querySelectorAll("[data-promote-customer-affiliate]").forEach((button) => button.addEventListener("click", () => promoteCustomerToAffiliate(button.dataset.promoteCustomerAffiliate)));
  document.querySelectorAll("[data-edit-customer]").forEach((button) => button.addEventListener("click", () => editCustomer(button.dataset.editCustomer)));
  document.querySelectorAll("[data-delete-customer]").forEach((button) => button.addEventListener("click", () => deleteCustomer(button.dataset.deleteCustomer)));
  document.querySelectorAll("[data-start-chat-customer]").forEach((button) => button.addEventListener("click", () => openStartChatForCustomer(button.dataset.startChatCustomer)));
  document.querySelectorAll("[data-edit-seller]").forEach((button) => button.addEventListener("click", () => editSeller(button.dataset.editSeller)));
  document.querySelectorAll("[data-delete-seller]").forEach((button) => button.addEventListener("click", () => deleteSeller(button.dataset.deleteSeller)));
}

function customerChatLabel(account) {
  const customer = account.customer || {};
  const name = customer.displayName || customer.name || account.username || "Cliente";
  const email = customer.email || "";
  return `${name}${email ? ` | ${email}` : ""}`;
}

function renderStartChatCustomerOptions(selectedId = "") {
  const select = $("#adminStartChatCustomer");
  if (!select) return;
  const customers = currentCustomers.filter((account) => account.customer?.email);
  select.innerHTML = customers.length
    ? `<option value="">Selecione um cliente</option>${customers.map((account) => `<option value="${account.id}" ${account.id === selectedId ? "selected" : ""}>${escapeHtml(customerChatLabel(account))}</option>`).join("")}`
    : '<option value="">Nenhum cliente com e-mail</option>';
}

function openStartChatForCustomer(customerId) {
  renderStartChatCustomerOptions(customerId);
  jumpAdminPanel("chat");
  $("#adminStartChatForm")?.scrollIntoView({ behavior: "smooth", block: "start" });
  $("#adminStartChatForm")?.elements.message?.focus();
}

function renderAdminDashboard() {
  const activeProducts = currentProducts.filter((product) => product.status !== "inactive");
  const activeStories = currentStories.filter((story) => story.active !== false);
  const newOrders = currentOrders.filter((order) => ["created", "awaiting_payment"].includes(order.status));
  const customRequests = currentRequests.filter((request) => requestKind(request) !== "chat");
  const openRequests = customRequests.filter((request) => !["completed", "canceled"].includes(request.status));
  const activeCartCount = currentCarts.filter((cart) => cart.status === "active" && (cart.items || []).length).length;
  const paidLast30 = paidOrders("30");
  const revenue30 = paidLast30.reduce((sum, order) => sum + Number(order.total || 0), 0);

  $("#statsGrid").innerHTML = `
    <div><span>Pedidos novos</span><strong>${newOrders.length}</strong><small>Aguardando processamento</small></div>
    <div><span>Encomendas novas</span><strong>${openRequests.length}</strong><small>${openRequests.filter((request) => request.status === "new").length} novas</small></div>
    <div><span>Receita - 30 dias</span><strong>${money(revenue30)}</strong><small>Pedidos pagos/concluídos</small></div>
    <div><span>Produtos ativos</span><strong>${activeProducts.length}</strong><small>Visíveis na loja</small></div>
    <div><span>Stories ativos</span><strong>${activeStories.length}</strong><small>Exibidos no topo</small></div>
    <div><span>Carrinhos ativos</span><strong>${activeCartCount}</strong><small>Clientes com produtos salvos</small></div>
  `;

  $("#dashboardOrdersList").innerHTML = currentOrders.slice(0, 4).length
    ? currentOrders.slice(0, 4).map((order) => `
      <article>
        <div><strong>${order.id}</strong><span>${order.customer?.name || "Cliente"} | ${orderStatusLabel(order.status)}</span></div>
        <b>${money(order.total || 0)}</b>
      </article>
    `).join("")
    : `<div class="dashboard-empty"><strong>Nenhum pedido ainda.</strong><span>Os pedidos novos aparecerão aqui.</span></div>`;

  $("#dashboardRequestsList").innerHTML = customRequests.slice(0, 4).length
    ? customRequests.slice(0, 4).map((request) => `
      <article>
        <div><strong>${request.customer?.name || request.name || "Cliente"}</strong><span>${requestStatusLabel(request.status)} | ${request.idea || "Orçamento sob medida"}</span></div>
        <b>${new Date(request.createdAt || Date.now()).toLocaleDateString("pt-BR")}</b>
      </article>
    `).join("")
    : `<div class="dashboard-empty"><strong>Nenhuma encomenda ainda.</strong><span>Os orçamentos sob medida aparecerão aqui.</span></div>`;

  const activeCarts = currentCarts
    .filter((cart) => cart.status === "active" && (cart.items || []).length)
    .slice(0, 6);
  $("#dashboardCartsList").innerHTML = activeCarts.length
    ? activeCarts.map((cart) => {
      const customer = cart.customer || {};
      const products = (cart.items || []).map((item) => {
        const age = item.cartAddedAt ? ` (${relativeTimeLabel(item.cartAddedAt)})` : "";
        return `${item.quantity || 1}x ${item.name}${age}`;
      }).join(", ");
      const affiliate = cart.affiliate?.code ? ` | afiliado ${cart.affiliate.code}` : "";
      return `
        <article>
          <div><strong>${escapeHtml(customer.name || customer.email || "Cliente")}</strong><span>No carrinho${affiliate} | ${escapeHtml(products || "Produto")}</span></div>
          <b>${money(cart.total || cart.subtotal || 0)}</b>
        </article>
      `;
    }).join("")
    : `<div class="dashboard-empty"><strong>Nenhum carrinho ativo.</strong><span>Quando clientes adicionarem produtos, você verá aqui.</span></div>`;

  $("#dashboardProductsTable").innerHTML = currentProducts.slice(0, 6).length
    ? currentProducts.slice(0, 6).map((product) => `
      <tr>
        <td><small>${product.sku || "-"}</small></td>
        <td><strong>${product.name}</strong></td>
        <td>${product.category || "-"}</td>
        <td><strong>${money(product.price || 0)}</strong></td>
        <td><span class="status-chip ${product.status === "active" ? "stage-paid" : "stage-created"}">${product.status || "active"}</span></td>
        <td><button class="ghost-button table-action" type="button" data-edit-product="${product.id}">Editar</button></td>
      </tr>
    `).join("")
    : `<tr><td colspan="6">Nenhum produto cadastrado ainda.</td></tr>`;

  document.querySelectorAll("[data-admin-jump]").forEach((button) => button.addEventListener("click", () => jumpAdminPanel(button.dataset.adminJump)));
  document.querySelectorAll("#dashboardProductsTable [data-edit-product]").forEach((button) => {
    button.addEventListener("click", () => {
      jumpAdminPanel("products");
      editProduct(button.dataset.editProduct);
    });
  });
}

function formatShipping(order) {
  if (!order.shippingOption) {
    if (order.promotion?.reason === "seller_pays_shipping") return "Frete grátis assumido pela loja. Envio definido internamente.";
    return `Entrega: ${money(order.shipping || 0)}`;
  }
  const option = order.shippingOption;
  return `${option.carrier} - ${option.service} | ${money(option.price)}${option.deliveryDays ? ` | ${option.deliveryDays} dias uteis` : ""}`;
}

function formatShippingBenefit(order) {
  const benefit = order.shippingBenefit;
  if (!benefit) return "Cálculo de benefício ainda não registrado neste pedido.";
  const zip = benefit.zipCode ? `CEP ${benefit.zipCode}` : "CEP não informado";
  return `${zip} | frete ${benefit.freeShipping ? "grátis" : money(benefit.shippingCharged || benefit.baseShipping || 0)} | ${benefit.message || ""}`;
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
  return Number(product.price || 0);
}

function productBaseCompareAtPrice(product) {
  return Number(product.compareAtPrice || 0);
}

function updateEmbeddedShippingPreview() {
  const preview = $("#embeddedShippingPreview");
  if (!preview) return;
  const form = $("#productForm");
  const sellerPaysShipping = form.elements.sellerPaysShipping.checked;
  preview.innerHTML = sellerPaysShipping
    ? "Marcado como frete grátis. O preço do produto não será alterado pelo sistema."
    : "Cliente pagará o frete calculado no produto e no carrinho.";
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

function addColor(color = {}) {
  const row = document.createElement("div");
  row.className = "repeatable-row color-row";
  const name = typeof color === "string" ? color : color.name || "";
  const hex = typeof color === "string" ? "#ffffff" : color.hex || "#ffffff";
  row.innerHTML = `
    <input name="colorName" value="${escapeHtml(name)}" placeholder="Nome. Ex: Branco">
    <input name="colorHex" type="color" value="${/^#[0-9a-fA-F]{6}$/.test(hex) ? hex : "#ffffff"}" aria-label="Cor hexadecimal">
    <input name="colorHexText" value="${/^#[0-9a-fA-F]{6}$/.test(hex) ? hex : "#ffffff"}" maxlength="7" aria-label="Hexadecimal da cor">
    <button class="ghost-button remove-row" type="button" aria-label="Remover cor">Remover</button>
  `;
  const colorInput = row.querySelector('[name="colorHex"]');
  const textInput = row.querySelector('[name="colorHexText"]');
  colorInput.addEventListener("input", () => { textInput.value = colorInput.value; });
  textInput.addEventListener("input", () => {
    if (/^#[0-9a-fA-F]{6}$/.test(textInput.value)) colorInput.value = textInput.value;
  });
  row.querySelector("button").addEventListener("click", () => row.remove());
  $("#colorsList").append(row);
}

function resetProductForm() {
  const form = $("#productForm");
  form.reset();
  form.elements.productId.value = "";
  form.elements.sku.value = "";
  form.elements.tags.value = "";
  form.elements.affiliateCommissionPercent.value = "0";
  renderProductPartnerOptions();
  form.elements.partnerStoreCommissionPercent.value = "0";
  updateProductPartnerPreview();
  form.elements.weightKg.value = "0.30";
  form.elements.widthCm.value = "12";
  form.elements.heightCm.value = "8";
  form.elements.lengthCm.value = "18";
  form.elements.sellerPaysShipping.checked = false;
  form.elements.imageFile.required = true;
  $("#colorsList").innerHTML = "";
  addColor({ name: "Branco", hex: "#ffffff" });
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
  $("#productMediaStatus").textContent = "";
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

function resetSocialProofForm() {
  const form = $("#socialProofForm");
  if (!form) return;
  const productId = form.elements.productId.value || currentSocialProductId;
  form.reset();
  form.elements.reviewId.value = "";
  form.elements.rating.value = "5";
  form.elements.soldUnits.value = "0";
  form.elements.approved.checked = true;
  renderSocialProductOptions({ keepSelected: true });
  form.elements.productId.value = productId || form.elements.productId.value;
  currentSocialProductId = form.elements.productId.value;
  $("#socialProofSubmitButton").textContent = "Salvar prova social";
  $("#cancelSocialProofEditButton").hidden = true;
}

function resetCustomerAdminForm() {
  const form = $("#customerAdminForm");
  form.reset();
  form.elements.id.value = "";
  form.elements.status.value = "active";
  form.elements.profileVerified.checked = false;
  $("#cancelCustomerEditButton").hidden = true;
  $("#customerAdminStatus").textContent = "";
}

function resetAffiliateForm() {
  const form = $("#affiliateForm");
  form.reset();
  form.elements.id.value = "";
  form.elements.status.value = "lead";
  form.elements.commissionPercent.value = "0";
  $("#cancelAffiliateEditButton").hidden = true;
  $("#affiliateStatus").textContent = "";
}

function resetSellerForm() {
  const form = $("#sellerForm");
  form.reset();
  form.elements.id.value = "";
  form.elements.status.value = "lead";
  form.elements.commissionPercent.value = "0";
  $("#cancelSellerEditButton").hidden = true;
  $("#sellerStatus").textContent = "";
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

function editSocialProof(reviewId) {
  const product = socialProduct();
  const review = product?.reviews?.find((item) => item.id === reviewId);
  if (!product || !review) return;
  const form = $("#socialProofForm");
  form.elements.reviewId.value = review.id;
  form.elements.productId.value = product.id;
  currentSocialProductId = product.id;
  form.elements.customerName.value = review.customerName || "";
  form.elements.rating.value = String(review.rating ?? 0);
  if (![...form.elements.rating.options].some((option) => option.value === form.elements.rating.value)) {
    form.elements.rating.add(new Option(`${review.rating} estrelas`, String(review.rating)));
    form.elements.rating.value = String(review.rating);
  }
  form.elements.soldUnits.value = review.soldUnits || 0;
  form.elements.comment.value = review.comment || "";
  form.elements.mediaFiles.value = "";
  form.elements.approved.checked = review.approved !== false;
  $("#socialProofSubmitButton").textContent = "Salvar edição";
  $("#cancelSocialProofEditButton").hidden = false;
  $("#socialProofStatus").textContent = `Editando prova social de ${review.customerName || "Cliente Basa"}.`;
  form.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function deleteSocialProof(reviewId) {
  const product = socialProduct();
  if (!product || !reviewId || !confirm("Excluir esta prova social?")) return;
  $("#socialProofStatus").textContent = "Excluindo prova social...";
  try {
    const result = await api(`/api/admin/products/${encodeURIComponent(product.id)}/social-posts/${encodeURIComponent(reviewId)}`, {
      method: "DELETE",
      body: "{}"
    });
    currentProducts = result.products || currentProducts.map((item) => item.id === result.product.id ? result.product : item);
    renderSocialProductOptions({ keepSelected: true });
    renderProductsTable();
    renderAdminDashboard();
    resetSocialProofForm();
    $("#socialProofStatus").textContent = "Prova social excluída.";
  } catch (error) {
    $("#socialProofStatus").textContent = error.message;
  }
}

function editProduct(productId) {
  const product = currentProducts.find((item) => item.id === productId);
  if (!product) return;
  const form = $("#productForm");
  form.elements.productId.value = product.id;
  form.elements.sku.value = product.sku || "";
  form.elements.name.value = product.name || "";
  form.elements.category.value = product.category || "";
  form.elements.tags.value = (product.tags || []).join(", ");
  form.elements.price.value = productBasePrice(product);
  form.elements.compareAtPrice.value = productBaseCompareAtPrice(product) || "";
  form.elements.stock.value = product.stock || 0;
  form.elements.affiliateCommissionPercent.value = product.affiliateCommissionPercent || 0;
  renderProductPartnerOptions(product.partnerId || "");
  form.elements.partnerStoreCommissionPercent.value = product.partnerStoreCommissionPercent || 0;
  updateProductPartnerPreview();
  $("#colorsList").innerHTML = "";
  const colors = product.variants?.colors || [];
  (colors.length ? colors : [{ name: "Branco", hex: "#ffffff" }]).forEach((color) => addColor(color));
  form.elements.bundleType.value = product.variants?.bundleType || (Number(product.variants?.piecesIncluded || 1) > 1 ? "kit" : "single");
  form.elements.piecesIncluded.value = product.variants?.piecesIncluded || 1;
  form.elements.weightKg.value = product.shipping?.weightKg || 0.3;
  form.elements.widthCm.value = product.shipping?.widthCm || 12;
  form.elements.heightCm.value = product.shipping?.heightCm || 8;
  form.elements.lengthCm.value = product.shipping?.lengthCm || 18;
  form.elements.sellerPaysShipping.checked = Boolean(product.shipping?.sellerPaysShipping);
  form.elements.imageFile.value = "";
  form.elements.imageFile.required = false;
  form.elements.description.value = product.description || "";
  form.elements.longDescription.value = product.longDescription || "";
  form.elements.videoFile.value = "";
  form.elements.galleryFiles.value = "";
  $("#productMediaStatus").textContent = product.image || product.videoUrl
    ? `Mídias atuais preservadas. Envie novos arquivos somente se quiser trocar.`
    : "";

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

function editCustomer(id) {
  const account = currentCustomers.find((item) => item.id === id);
  if (!account) return;
  const form = $("#customerAdminForm");
  const customer = account.customer || {};
  form.elements.id.value = account.id;
  form.elements.name.value = customer.name || "";
  form.elements.displayName.value = customer.displayName || "";
  form.elements.username.value = account.username || "";
  form.elements.email.value = customer.email || "";
  form.elements.password.value = "";
  form.elements.phone.value = customer.phone || "";
  form.elements.document.value = customer.document || "";
  form.elements.zipCode.value = customer.zipCode || "";
  form.elements.street.value = customer.street || "";
  form.elements.number.value = customer.number || "";
  form.elements.neighborhood.value = customer.neighborhood || "";
  form.elements.city.value = customer.city || "";
  form.elements.state.value = customer.state || "";
  form.elements.status.value = account.status || "active";
  form.elements.profileVerified.checked = Boolean(customer.profileVerified);
  form.elements.notes.value = account.notes || "";
  $("#cancelCustomerEditButton").hidden = false;
  $("#customerAdminStatus").textContent = `Editando ${customer.name || account.username}`;
  form.scrollIntoView({ behavior: "smooth", block: "start" });
}

function fillPartnerForm(form, item) {
  form.elements.id.value = item.id;
  form.elements.name.value = item.name || "";
  if (form.elements.brandName) form.elements.brandName.value = item.brandName || "";
  form.elements.code.value = item.code || "";
  form.elements.email.value = item.email || "";
  form.elements.phone.value = item.phone || "";
  form.elements.document.value = item.document || "";
  if (form.elements.paymentAccountId) form.elements.paymentAccountId.value = item.paymentAccountId || "";
  form.elements.commissionPercent.value = Number(item.commissionPercent || 0);
  form.elements.status.value = item.status || "lead";
  form.elements.notes.value = item.notes || "";
}

function editAffiliate(id) {
  const affiliate = currentAffiliates.find((item) => item.id === id);
  if (!affiliate) return;
  fillPartnerForm($("#affiliateForm"), affiliate);
  $("#cancelAffiliateEditButton").hidden = false;
  $("#affiliateStatus").textContent = `Editando ${affiliate.name}`;
  $("#affiliateForm").scrollIntoView({ behavior: "smooth", block: "start" });
}

function promoteCustomerToAffiliate(id) {
  const account = currentCustomers.find((item) => item.id === id);
  if (!account) return;
  const customer = account.customer || {};
  const form = $("#affiliateForm");
  form.reset();
  form.elements.id.value = "";
  form.elements.name.value = customer.name || customer.displayName || account.username || "";
  form.elements.code.value = affiliateCodeFromCustomer(account);
  form.elements.email.value = customer.email || "";
  form.elements.phone.value = customer.phone || "";
  form.elements.document.value = customer.document || "";
  form.elements.commissionPercent.value = "0";
  form.elements.status.value = "lead";
  form.elements.notes.value = `Promovido a partir do cliente ${customer.name || account.username || account.id}.`;
  $("#cancelAffiliateEditButton").hidden = false;
  $("#affiliateStatus").textContent = "Revise os dados e salve para transformar este cliente em afiliado.";
  jumpAdminPanel("affiliates");
  form.scrollIntoView({ behavior: "smooth", block: "start" });
}

function editSeller(id) {
  const seller = currentSellers.find((item) => item.id === id);
  if (!seller) return;
  fillPartnerForm($("#sellerForm"), seller);
  $("#cancelSellerEditButton").hidden = false;
  $("#sellerStatus").textContent = `Editando ${seller.brandName || seller.name}`;
  $("#sellerForm").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function saveCustomerAdmin(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const body = Object.fromEntries(new FormData(form).entries());
  body.profileVerified = form.elements.profileVerified.checked ? "true" : "false";
  const id = body.id;
  delete body.id;
  if (!body.password) delete body.password;
  $("#customerAdminStatus").textContent = "Salvando cliente...";
  try {
    const result = await api(id ? `/api/admin/customers/${encodeURIComponent(id)}` : "/api/admin/customers", {
      method: id ? "PUT" : "POST",
      body: JSON.stringify(body)
    });
    currentCustomers = result.customers || [];
    resetCustomerAdminForm();
    renderPeopleLists();
    $("#customerAdminStatus").textContent = "Cliente salvo.";
  } catch (error) {
    $("#customerAdminStatus").textContent = error.message;
  }
}

async function saveAffiliate(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const body = Object.fromEntries(new FormData(form).entries());
  const id = body.id;
  delete body.id;
  $("#affiliateStatus").textContent = "Salvando afiliado...";
  try {
    const result = await api(id ? `/api/admin/affiliates/${encodeURIComponent(id)}` : "/api/admin/affiliates", {
      method: id ? "PUT" : "POST",
      body: JSON.stringify(body)
    });
    currentAffiliates = result.affiliates || [];
    resetAffiliateForm();
    renderPeopleLists();
    $("#affiliateStatus").textContent = "Afiliado salvo.";
  } catch (error) {
    $("#affiliateStatus").textContent = error.message;
  }
}

async function saveSeller(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const body = Object.fromEntries(new FormData(form).entries());
  const id = body.id;
  delete body.id;
  $("#sellerStatus").textContent = "Salvando vendedor...";
  try {
    const result = await api(id ? `/api/admin/sellers/${encodeURIComponent(id)}` : "/api/admin/sellers", {
      method: id ? "PUT" : "POST",
      body: JSON.stringify(body)
    });
    currentSellers = result.sellers || [];
    resetSellerForm();
    renderPeopleLists();
    $("#sellerStatus").textContent = "Vendedor salvo.";
  } catch (error) {
    $("#sellerStatus").textContent = error.message;
  }
}

async function deleteCustomer(id) {
  const account = currentCustomers.find((item) => item.id === id);
  const name = account?.customer?.name || account?.username;
  if (!account || !confirm(`Excluir o cliente "${name}"?`)) return;
  $("#customerAdminStatus").textContent = "Excluindo cliente...";
  try {
    const result = await api(`/api/admin/customers/${encodeURIComponent(id)}`, { method: "DELETE" });
    currentCustomers = result.customers || [];
    renderPeopleLists();
    $("#customerAdminStatus").textContent = "Cliente excluido.";
  } catch (error) {
    $("#customerAdminStatus").textContent = error.message;
  }
}

async function deleteAffiliate(id) {
  const affiliate = currentAffiliates.find((item) => item.id === id);
  if (!affiliate || !confirm(`Excluir o afiliado "${affiliate.name}"?`)) return;
  $("#affiliateStatus").textContent = "Excluindo afiliado...";
  try {
    const result = await api(`/api/admin/affiliates/${encodeURIComponent(id)}`, { method: "DELETE" });
    currentAffiliates = result.affiliates || [];
    renderPeopleLists();
    $("#affiliateStatus").textContent = "Afiliado excluido.";
  } catch (error) {
    $("#affiliateStatus").textContent = error.message;
  }
}

async function deleteSeller(id) {
  const seller = currentSellers.find((item) => item.id === id);
  if (!seller || !confirm(`Excluir o vendedor "${seller.brandName || seller.name}"?`)) return;
  $("#sellerStatus").textContent = "Excluindo vendedor...";
  try {
    const result = await api(`/api/admin/sellers/${encodeURIComponent(id)}`, { method: "DELETE" });
    currentSellers = result.sellers || [];
    renderPeopleLists();
    $("#sellerStatus").textContent = "Vendedor excluido.";
  } catch (error) {
    $("#sellerStatus").textContent = error.message;
  }
}

function renderProductsTable() {
  const query = $("#productSearchInput")?.value || "";
  const filteredProducts = currentProducts.filter((product) => matchesSearch([
    product.name,
    product.sku,
    product.category,
    ...(product.tags || []),
    product.status,
    isRecentlyPosted(product) ? "novo" : "",
    dynamicSoldCount(product) ? `${dynamicSoldCount(product)} vendidos` : "",
    ratingSummary(product),
    product.description,
    product.shipping?.sellerPaysShipping ? "frete gratis" : "",
    product.affiliateCommissionPercent ? `afiliado ${product.affiliateCommissionPercent}%` : "",
    product.partnerId ? `parceiro ${currentSellers.find((item) => item.id === product.partnerId)?.brandName || ""}` : "",
    product.variants?.colors?.join(" "),
    discountPercent(product) ? `${discountPercent(product)} off` : ""
  ].join(" "), query));

  $("#productsTable").innerHTML = filteredProducts.length ? filteredProducts.map((product) => `
    <tr>
      <td><small>${product.sku || "-"}</small></td>
      <td><strong>${product.name}</strong></td>
      <td>${product.category}</td>
      <td>${money(product.price)}</td>
      <td>${product.compareAtPrice ? money(product.compareAtPrice) : "-"}</td>
      <td>${discountPercent(product) ? `${discountPercent(product)}% OFF` : "-"}</td>
      <td>${Number(product.affiliateCommissionPercent || 0)}%</td>
      <td>${productPartnerTableLabel(product)}</td>
      <td>${product.stock}</td>
      <td>${product.status}${product.shipping?.sellerPaysShipping ? " / frete grátis" : " / frete cobrado"}</td>
      <td>
        <button class="ghost-button table-action" type="button" data-edit-product="${product.id}">Editar</button>
        <button class="ghost-button table-action danger-button" type="button" data-delete-product="${product.id}">Excluir</button>
      </td>
    </tr>
  `).join("") : `<tr><td colspan="11">${currentProducts.length ? "Nenhum produto encontrado." : "Nenhum produto cadastrado ainda."}</td></tr>`;

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
    order.affiliate?.code,
    order.affiliate?.name,
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
  document.querySelectorAll("[data-payment-action]").forEach((button) => {
    button.addEventListener("click", () => runPaymentAction(button));
  });
  document.querySelectorAll("[data-partner-payout]").forEach((button) => {
    button.addEventListener("click", () => runPartnerPayoutAction(button));
  });
  document.querySelectorAll("[data-partner-adjust]").forEach((button) => {
    button.addEventListener("click", () => runPartnerAdjustmentAction(button));
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
        <span>ID externo: ${order.payment?.paymentId || order.payment?.id || order.payment?.externalId || "não informado"}</span>
        ${order.payment?.expiresAt ? `<span>Expira em: ${new Date(order.payment.expiresAt).toLocaleString("pt-BR")}</span>` : ""}
        ${order.status === "awaiting_payment" && order.payment?.checkoutUrl ? `
          <div class="order-action-row">
            <a class="ghost-button" href="${order.payment.checkoutUrl}" target="_blank" rel="noopener">Abrir pagamento</a>
            <button class="ghost-button" type="button" data-payment-action="resend_payment" data-order-id="${order.id}">Marcar reenvio</button>
            <button class="ghost-button danger-button" type="button" data-payment-action="cancel_payment" data-order-id="${order.id}">Cancelar pedido</button>
          </div>
        ` : ""}
        <small class="muted-copy">Quando o webhook do Mercado Pago estiver ativo, esta etapa muda sozinha após a confirmação.</small>
        <label>Status operacional manual
          <select data-order-status="${order.id}">
            ${["created", "awaiting_payment", "paid", "in_production", "shipped", "completed", "canceled"].map((status) => `<option value="${status}" ${order.status === status ? "selected" : ""}>${orderStatusLabel(status)}</option>`).join("")}
          </select>
        </label>
      </section>
      <section>
        <h3>Afiliado</h3>
        ${order.affiliate ? `
          <span><strong>${order.affiliate.name || order.affiliate.code}</strong></span>
          <span>Código: ${order.affiliate.code || "não informado"}</span>
          <span>Status comissão: ${order.affiliate.status || "pendente"}</span>
          <span>Comissão: <strong>${money(order.affiliate.amount || 0)}</strong></span>
          <small>${(order.affiliate.lines || []).map((line) => `${line.name}: ${Number(line.percent || 0)}%`).join(" | ")}</small>
        ` : "<span>Nenhum afiliado neste pedido.</span>"}
      </section>
      <section>
        <h3>Parceiro</h3>
        ${order.partnerSettlements?.length ? order.partnerSettlements.map((settlement) => `
          <span><strong>${escapeHtml(settlement.partnerName || "Parceiro")}</strong></span>
          <span>Status: ${commissionStatusLabel(settlement.payoutStatus)}</span>
          <span>Base com frete: <strong>${money(settlement.settlementBase || 0)}</strong></span>
          <span>Frete alocado: ${money(settlement.shippingShare || 0)} | Desconto: ${money(settlement.discountShare || 0)}</span>
          <span>Comissão Basa: ${Number(settlement.storeCommissionPercent || 0)}% (${money(settlement.storeCommission || 0)})</span>
          <span>Repasse parceiro: <strong>${money(settlement.partnerReceivable || 0)}</strong></span>
          ${settlement.manualAdjustment ? `<small>Ajuste manual: ${money(settlement.manualAdjustment)}${settlement.adjustmentNote ? ` | ${escapeHtml(settlement.adjustmentNote)}` : ""}</small>` : ""}
          ${settlement.payoutStatus === "paid" ? `
            <span>Pago em: ${settlement.paidAt ? new Date(settlement.paidAt).toLocaleString("pt-BR") : "registrado"}</span>
            <small>Recibo: ${settlement.receiptId || "sem código"}${settlement.paymentNote ? ` | ${escapeHtml(settlement.paymentNote)}` : ""}</small>
            ${settlement.receiptId ? `<a class="ghost-button table-action" href="/api/admin/partner-receipts/${encodeURIComponent(settlement.receiptId)}" target="_blank" rel="noopener">Ver recibo</a>` : ""}
          ` : `
            <button class="ghost-button table-action" type="button" data-partner-adjust="${settlement.partnerId}" data-partner-amount="${settlement.partnerReceivable || 0}" data-partner-name="${escapeHtml(settlement.partnerName || "Parceiro")}" data-order-id="${order.id}">Ajustar repasse</button>
            <button class="ghost-button table-action" type="button" data-partner-payout="${settlement.partnerId}" data-partner-name="${escapeHtml(settlement.partnerName || "Parceiro")}" data-order-id="${order.id}">Marcar repasse pago</button>
          `}
        `).join("<hr>") : "<span>Nenhum parceiro neste pedido.</span>"}
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
        <small>${formatShippingBenefit(order)}</small>
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
          <pre>${JSON.stringify({ payment: order.payment || null, shipping: order.shippingOption || null, shippingBenefit: order.shippingBenefit || null, workflow: order.shippingWorkflow || null, promotion: order.promotion || null }, null, 2)}</pre>
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
    canceled: "Cancelada",
    waiting_admin: "Aguardando Basa",
    answered: "Respondida",
    waiting_customer: "Aguardando cliente",
    closed: "Encerrada"
  }[status] || status;
}

function requestKind(request) {
  return request.kind || (String(request.title || "").startsWith("Atendimento") ? "chat" : "custom");
}

function requestStatusOptions(request) {
  const statuses = requestKind(request) === "chat"
    ? ["waiting_admin", "answered", "waiting_customer", "closed"]
    : ["new", "in_review", "quoted", "approved", "in_production", "shipped", "completed", "canceled"];
  return statuses.map((status) => `<option value="${status}" ${request.status === status ? "selected" : ""}>${requestStatusLabel(status)}</option>`).join("");
}

function requestCard(request) {
  const isChat = requestKind(request) === "chat";
  return `
    <article class="request-card ${isChat ? "chat-request-card" : ""}">
      <div class="request-card-head">
        <div>
          <strong>${request.title}</strong>
          <span>${request.id} | ${request.customer?.name || "Cliente"} | ${request.customer?.email || ""}</span>
        </div>
        <small>${requestStatusLabel(request.status)}</small>
      </div>
      <p>${request.idea}</p>
      ${request.attachment?.url ? `<a class="request-attachment" href="${request.attachment.url}" target="_blank" rel="noreferrer">Ver imagem de referência</a>` : ""}
      ${isChat ? "" : `
        <div class="request-meta">
          <span>Orçamento: ${request.budget || "Nao informado"}</span>
          <span>Prazo: ${request.deadline || "Nao informado"}</span>
        </div>
      `}
      <div class="request-messages">
        ${(request.messages || []).map((message) => `<span class="${message.author === "admin" ? "admin-message" : ""}"><b>${message.author === "admin" ? "Basa" : "Cliente"}:</b> ${message.text}</span>`).join("")}
      </div>
      <form class="admin-request-form" data-admin-request="${request.id}">
        <select name="status">
          ${requestStatusOptions(request)}
        </select>
        <input name="message" placeholder="${isChat ? "Responder no chat do cliente" : "Mensagem para o cliente"}">
        <button class="primary-button" type="submit">${isChat ? "Responder" : "Atualizar"}</button>
        ${isChat ? `<button class="danger-button table-action" type="button" data-delete-chat="${request.id}">Excluir conversa</button>` : ""}
      </form>
    </article>
  `;
}

function requestMatchesQuery(request, query) {
  return matchesSearch([
    request.id,
    request.title,
    request.idea,
    request.status,
    request.customer?.name,
    request.customer?.email,
    request.customer?.phone,
    request.budget,
    request.deadline,
    ...(request.messages || []).map((message) => message.text)
  ].join(" "), query);
}

function renderAdminRequests() {
  const chatQuery = $("#chatSearchInput")?.value || "";
  const requestQuery = $("#requestSearchInput")?.value || "";
  const allChats = currentRequests.filter((request) => requestKind(request) === "chat");
  const chatCounts = allChats.reduce((acc, request) => {
    const status = request.status || "waiting_admin";
    acc.all += 1;
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, { all: 0, waiting_admin: 0, answered: 0, waiting_customer: 0, closed: 0 });
  document.querySelectorAll("[data-chat-status]").forEach((button) => {
    const status = button.dataset.chatStatus;
    button.classList.toggle("active", status === chatStatusFilter);
    const baseLabel = {
      all: "Todas",
      waiting_admin: "Aguardando Basa",
      answered: "Respondidas",
      waiting_customer: "Aguardando cliente",
      closed: "Encerradas"
    }[status] || requestStatusLabel(status);
    button.textContent = `${baseLabel} (${chatCounts[status] || 0})`;
  });
  const chats = allChats.filter((request) =>
    (chatStatusFilter === "all" || request.status === chatStatusFilter)
    && requestMatchesQuery(request, chatQuery)
  );
  const customRequests = currentRequests.filter((request) => requestKind(request) !== "chat" && requestMatchesQuery(request, requestQuery));

  const chatList = $("#adminChatList");
  const requestList = $("#adminRequestList");
  if (chatList) chatList.innerHTML = chats.length ? chats.map(requestCard).join("") : "<p>Nenhuma conversa de chat encontrada.</p>";
  if (requestList) requestList.innerHTML = customRequests.length ? customRequests.map(requestCard).join("") : "<p>Nenhuma encomenda encontrada.</p>";

  document.querySelectorAll("[data-admin-request]").forEach((form) => {
    form.addEventListener("submit", updateCustomRequest);
  });
  document.querySelectorAll("[data-delete-chat]").forEach((button) => {
    button.addEventListener("click", () => deleteChatRequest(button.dataset.deleteChat));
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

async function deleteChatRequest(requestId) {
  const request = currentRequests.find((item) => item.id === requestId);
  const customer = request?.customer?.name || request?.customer?.email || "cliente";
  if (!confirm(`Excluir a conversa com ${customer}? Ela também sumirá do chat do cliente.`)) return;
  const result = await api(`/api/admin/custom-requests/${encodeURIComponent(requestId)}`, {
    method: "DELETE"
  });
  currentRequests = result.customRequests || [];
  renderAdminRequests();
}

async function startAdminChat(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const status = $("#adminStartChatStatus");
  const body = Object.fromEntries(new FormData(form).entries());
  if (status) status.textContent = "Criando conversa...";
  try {
    const result = await api("/api/admin/chats", {
      method: "POST",
      body: JSON.stringify(body)
    });
    currentRequests = result.customRequests || [];
    form.elements.message.value = "";
    if (status) status.textContent = "Conversa iniciada. O cliente verá a mensagem no chat.";
    chatStatusFilter = "waiting_customer";
    renderAdminRequests();
  } catch (error) {
    if (status) status.textContent = error.message;
  }
}

async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(path, {
      headers: { "content-type": "application/json", ...(options.headers || {}) },
      ...options
    });
  } catch {
    throw new Error("Não foi possível conectar ao servidor. Atualize a página e tente novamente.");
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Erro na requisição.");
  return data;
}

function setSettingsControlsDisabled(disabled) {
  document.querySelectorAll("[data-theme], #displaySettingsForm button").forEach((control) => {
    control.disabled = disabled;
  });
}

async function patchAdminSettings(payload, statusSelector, pendingMessage, successMessage) {
  const status = statusSelector ? $(statusSelector) : null;
  if (settingsSaveInProgress) {
    if (status) status.textContent = "Aguarde o salvamento anterior terminar.";
    return null;
  }
  settingsSaveInProgress = true;
  setSettingsControlsDisabled(true);
  if (status) status.textContent = pendingMessage;
  try {
    const result = await api("/api/admin/settings", {
      method: "PATCH",
      body: JSON.stringify(payload)
    });
    if (status) status.textContent = successMessage;
    return result;
  } catch (error) {
    if (status) status.textContent = uploadFailureMessage(error);
    throw error;
  } finally {
    settingsSaveInProgress = false;
    setSettingsControlsDisabled(false);
  }
}

async function loadDashboard() {
  const data = await api("/api/admin/dashboard");
  currentProducts = data.products || [];
  currentStories = data.stories || [];
  currentOrders = data.orders || [];
  currentRequests = data.customRequests || [];
  currentCoupons = data.coupons || [];
  currentCustomers = data.customers || [];
  currentCarts = data.carts || [];
  currentAffiliates = data.affiliates || [];
  currentSellers = data.partners || data.sellers || [];
  currentPartnerClosings = data.partnerClosings || [];
  currentSettings = data.settings;
  $("#loginCard").hidden = true;
  $("#dashboard").hidden = false;
  document.body.classList.add("admin-logged-in");
  applyTheme(data.settings.theme);

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
  renderSocialProductOptions({ keepSelected: true });
  renderCampaignProductOptions({ keepSelected: true });
  renderProductPartnerOptions($("#productForm")?.elements.partnerId?.value || "");
  updateProductPartnerPreview();
  renderCampaignList();
  renderStoryAdminList();
  updateEmbeddedShippingPreview();
  renderAiInsightBrief();
  renderLocalAiInsight();
  renderAdminDashboard();
  renderProductsTable();
  renderOrdersList();
  renderPeopleLists();
  renderStartChatCustomerOptions();
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

async function runPaymentAction(button) {
  const action = button.dataset.paymentAction;
  if (action === "cancel_payment" && !confirm("Cancelar este pedido pendente?")) return;
  button.disabled = true;
  const originalText = button.textContent;
  button.textContent = "Processando...";
  try {
    const result = await api(`/api/admin/orders/${encodeURIComponent(button.dataset.orderId)}`, {
      method: "PATCH",
      body: JSON.stringify({ action })
    });
    if (action === "resend_payment" && result.checkoutUrl) {
      await navigator.clipboard?.writeText(result.checkoutUrl).catch(() => {});
      alert("Link de pagamento pronto para reenvio. Se o navegador permitiu, ele foi copiado.");
    }
    selectedOrderId = button.dataset.orderId;
    await loadDashboard();
  } catch (error) {
    alert(error.message);
    button.disabled = false;
    button.textContent = originalText;
  }
}

async function runPartnerPayoutAction(button) {
  const partnerId = button.dataset.partnerPayout;
  const orderId = button.dataset.orderId;
  const partnerName = button.dataset.partnerName || "parceiro";
  const note = prompt(`Observação do repasse para ${partnerName}:`, "Repasse pago ao parceiro.");
  if (note === null) return;
  button.disabled = true;
  const originalText = button.textContent;
  button.textContent = "Salvando...";
  try {
    const result = await api(`/api/admin/orders/${encodeURIComponent(orderId)}`, {
      method: "PATCH",
      body: JSON.stringify({ action: "mark_partner_paid", partnerId, note })
    });
    selectedOrderId = orderId;
    await loadDashboard();
    alert(`Repasse marcado como pago. Recibo: ${result.receiptId || "gerado"}`);
  } catch (error) {
    alert(error.message);
    button.disabled = false;
    button.textContent = originalText;
  }
}

async function runPartnerAdjustmentAction(button) {
  const partnerId = button.dataset.partnerAdjust;
  const orderId = button.dataset.orderId;
  const partnerName = button.dataset.partnerName || "parceiro";
  const currentAmount = Number(button.dataset.partnerAmount || 0);
  const raw = prompt(`Novo valor de repasse para ${partnerName}:`, String(currentAmount).replace(".", ","));
  if (raw === null) return;
  const amount = decimalValue(raw, NaN);
  if (!Number.isFinite(amount)) {
    alert("Informe um valor válido.");
    return;
  }
  const note = prompt("Motivo do ajuste:", "Ajuste manual antes do fechamento.") || "";
  button.disabled = true;
  const originalText = button.textContent;
  button.textContent = "Ajustando...";
  try {
    await api(`/api/admin/orders/${encodeURIComponent(orderId)}`, {
      method: "PATCH",
      body: JSON.stringify({ action: "adjust_partner_settlement", partnerId, amount, note })
    });
    selectedOrderId = orderId;
    await loadDashboard();
  } catch (error) {
    alert(error.message);
    button.disabled = false;
    button.textContent = originalText;
  }
}

async function createPartnerClosing() {
  const rows = partnerCloseRows();
  if (!rows.length) return;
  const partnerLabel = selectedPartnerSettlementId
    ? currentSellers.find((partner) => partner.id === selectedPartnerSettlementId)?.brandName || currentSellers.find((partner) => partner.id === selectedPartnerSettlementId)?.name || "parceiro"
    : "parceiros visíveis";
  const note = prompt(`Observação para criar fechamento de ${rows.length} repasse(s) de ${partnerLabel}:`, "Fechamento financeiro criado para conferência.");
  if (note === null) return;
  const button = $("#createPartnerClosingButton");
  const status = $("#partnerSettlementStatus");
  if (button) button.disabled = true;
  if (status) status.textContent = "Criando fechamento...";
  try {
    const result = await api("/api/admin/partner-closings", {
      method: "POST",
      body: JSON.stringify({ action: "create", partnerId: selectedPartnerSettlementId, note })
    });
    currentPartnerClosings = result.closings || currentPartnerClosings;
    currentOrders = result.orders || currentOrders;
    if (status) status.textContent = `Fechamento ${result.closing?.id || ""} criado.`;
    await loadDashboard();
  } catch (error) {
    if (status) status.textContent = error.message;
    if (button) button.disabled = false;
  }
}

async function markPartnerClosingPaid(button) {
  const closingId = button.dataset.closePartnerClosing;
  const note = prompt(`Observação de pagamento do fechamento ${closingId}:`, "Fechamento financeiro pago ao parceiro.");
  if (note === null) return;
  button.disabled = true;
  const status = $("#partnerSettlementStatus");
  if (status) status.textContent = "Marcando fechamento como pago...";
  try {
    const result = await api("/api/admin/partner-closings", {
      method: "POST",
      body: JSON.stringify({ action: "mark_paid", closingId, note })
    });
    currentPartnerClosings = result.closings || currentPartnerClosings;
    currentOrders = result.orders || currentOrders;
    if (status) status.textContent = `Fechamento pago. Recibo ${result.closing?.receiptId || ""}`;
    await loadDashboard();
  } catch (error) {
    if (status) status.textContent = error.message;
    button.disabled = false;
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
  `).join("") : "<p>Nenhuma imagem cadastrada. O banner inicial fica oculto ate voce enviar uma imagem.</p>";

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
      if (button.classList.contains("active")) return;
      const result = await patchAdminSettings({ theme: button.dataset.theme }, "#themeStatus", "Salvando tema...", "Tema aplicado.");
      if (!result) return;
      applyTheme(result.settings.theme);
      renderThemeGrid(result.settings.theme);
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
  if (productSaveInProgress) return;
  const form = event.currentTarget;
  const submitButton = $("#productSubmitButton");
  const productId = form.elements.productId.value;
  $("#productStatus").textContent = "Validando arquivos...";
  $("#productMediaStatus").textContent = "";
  productSaveInProgress = true;
  submitButton.disabled = true;
  submitButton.textContent = productId ? "Salvando..." : "Publicando...";
  try {
    validateFormUploads(form);
    $("#productStatus").textContent = productId ? "Salvando..." : "Publicando...";
    const body = new FormData(form);
    const colors = [...form.querySelectorAll(".color-row")].map((row) => ({
      name: row.querySelector('[name="colorName"]').value.trim(),
      hex: row.querySelector('[name="colorHexText"]').value.trim()
    })).filter((color) => color.name);
    const highlights = [...form.querySelectorAll('[name="highlightItem"]')].map((input) => input.value.trim()).filter(Boolean);
    const specs = Object.fromEntries([...form.querySelectorAll(".spec-row")].map((row) => {
      const key = row.querySelector('[name="specKey"]').value.trim();
      const value = row.querySelector('[name="specValue"]').value.trim();
      return [key, value];
    }).filter(([key, value]) => key && value));
    body.set("sellerPaysShipping", form.elements.sellerPaysShipping.checked ? "true" : "false");
    ["price", "compareAtPrice", "affiliateCommissionPercent", "partnerStoreCommissionPercent", "weightKg", "widthCm", "heightCm", "lengthCm"].forEach((field) => {
      if (!body.has(field)) return;
      const raw = body.get(field);
      const parsed = decimalValue(raw, raw === "" ? 0 : NaN);
      if (!Number.isFinite(parsed)) throw new Error("Informe valores numericos validos. Use 89,90 ou 89.90.");
      body.set(field, String(parsed));
    });
    body.set("colors", JSON.stringify(colors));
    body.set("highlights", JSON.stringify(highlights));
    body.set("specs", JSON.stringify(specs));
    body.delete("highlightItem");
    body.delete("specKey");
    body.delete("specValue");
    body.delete("colorName");
    body.delete("colorHex");
    body.delete("colorHexText");
    body.delete("productId");
    const path = productId ? `/api/admin/products/${encodeURIComponent(productId)}` : "/api/admin/products";
    const method = "POST";
    const response = await fetch(path, { method, body });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "Erro ao salvar produto.");
    resetProductForm();
    $("#productStatus").textContent = productId ? "Produto atualizado." : "Produto publicado.";
    await loadDashboard();
  } catch (error) {
    const message = uploadFailureMessage(error);
    $("#productStatus").textContent = message;
    $("#productMediaStatus").textContent = message;
  } finally {
    productSaveInProgress = false;
    submitButton.disabled = false;
    submitButton.textContent = productId ? "Salvar produto" : "Publicar produto";
  }
});

$("#refreshButton").addEventListener("click", loadDashboard);
$("#productSearchInput").addEventListener("input", renderProductsTable);
$("#productPartnerSelect")?.addEventListener("change", updateProductPartnerPreview);
$("#productForm")?.elements.price?.addEventListener("input", updateProductPartnerPreview);
$("#productForm")?.elements.partnerStoreCommissionPercent?.addEventListener("input", updateProductPartnerPreview);
$("#storySearchInput").addEventListener("input", renderStoryAdminList);
$("#storyProductSearchInput").addEventListener("input", () => renderStoryProductOptions());
$("#socialProductSearchInput")?.addEventListener("input", () => renderSocialProductOptions());
$("#socialProductSelect")?.addEventListener("change", () => {
  currentSocialProductId = $("#socialProductSelect").value;
  resetSocialProofForm();
  renderSocialProofList();
});
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
$("#chatSearchInput")?.addEventListener("input", renderAdminRequests);
document.querySelectorAll("[data-chat-status]").forEach((button) => {
  button.addEventListener("click", () => {
    chatStatusFilter = button.dataset.chatStatus || "all";
    renderAdminRequests();
  });
});
$("#requestSearchInput").addEventListener("input", renderAdminRequests);
$("#adminStartChatForm")?.addEventListener("submit", startAdminChat);
$("#peopleSearchInput").addEventListener("input", renderPeopleLists);
$("#affiliateSearchInput")?.addEventListener("input", renderPeopleLists);
$("#partnerSearchInput")?.addEventListener("input", renderPeopleLists);
$("#partnerSettlementSelect")?.addEventListener("change", (event) => {
  selectedPartnerSettlementId = event.currentTarget.value;
  renderPeopleLists();
});
$("#createPartnerClosingButton")?.addEventListener("click", createPartnerClosing);
document.querySelectorAll("[data-customer-status]").forEach((button) => {
  button.addEventListener("click", () => {
    customerStatusFilter = button.dataset.customerStatus || "all";
    renderPeopleLists();
  });
});
document.querySelectorAll("[data-affiliate-status]").forEach((button) => {
  button.addEventListener("click", () => {
    affiliateStatusFilter = button.dataset.affiliateStatus || "all";
    renderPeopleLists();
  });
});
document.querySelectorAll("[data-partner-status]").forEach((button) => {
  button.addEventListener("click", () => {
    partnerStatusFilter = button.dataset.partnerStatus || "all";
    renderPeopleLists();
  });
});
$("#customerAdminForm")?.addEventListener("submit", saveCustomerAdmin);
$("#affiliateForm").addEventListener("submit", saveAffiliate);
$("#sellerForm")?.addEventListener("submit", saveSeller);
$("#cancelCustomerEditButton")?.addEventListener("click", resetCustomerAdminForm);
$("#cancelAffiliateEditButton").addEventListener("click", resetAffiliateForm);
$("#cancelSellerEditButton")?.addEventListener("click", resetSellerForm);
$("#generateInsightsButton")?.addEventListener("click", generateAiInsights);
$("#metricsPeriodSelect")?.addEventListener("change", renderMetrics);
$("#metricsOrderTypeSelect")?.addEventListener("change", renderMetrics);
$("#salesMonitorFullscreenButton")?.addEventListener("click", toggleSalesMonitorFullscreen);
document.querySelectorAll("[data-metrics-view]").forEach((button) => {
  button.addEventListener("click", () => {
    currentMetricsView = button.dataset.metricsView || "overview";
    applyMetricsView();
  });
});
$("#metricsExportButton")?.addEventListener("click", () => {
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
$("#socialProofForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const productId = form.elements.productId.value;
  if (!productId) return;
  $("#socialProofStatus").textContent = "Salvando prova social...";
  const reviewId = form.elements.reviewId.value;
  const body = new FormData(form);
  body.set("approved", form.elements.approved.checked ? "true" : "false");
  body.delete("reviewId");
  try {
    const path = reviewId
      ? `/api/admin/products/${encodeURIComponent(productId)}/social-posts/${encodeURIComponent(reviewId)}`
      : `/api/admin/products/${encodeURIComponent(productId)}/social-posts`;
    const response = await fetch(path, { method: reviewId ? "PUT" : "POST", body });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Não foi possível salvar a prova social.");
    currentProducts = result.products || currentProducts.map((product) => product.id === result.product.id ? result.product : product);
    currentSocialProductId = result.product.id;
    renderSocialProductOptions({ keepSelected: true });
    renderProductsTable();
    renderAdminDashboard();
    resetSocialProofForm();
    $("#socialProofStatus").textContent = reviewId ? "Prova social atualizada." : "Prova social salva.";
  } catch (error) {
    $("#socialProofStatus").textContent = error.message;
  }
});
$("#cancelSocialProofEditButton")?.addEventListener("click", () => {
  resetSocialProofForm();
  $("#socialProofStatus").textContent = "";
});
document.querySelectorAll("[data-admin-tab]").forEach((button) => {
  button.addEventListener("click", () => showAdminPanel(button.dataset.adminTab));
});
$("#productForm").elements.price.addEventListener("input", updateEmbeddedShippingPreview);
$("#productForm").elements.compareAtPrice.addEventListener("input", updateEmbeddedShippingPreview);
$("#productForm").elements.sellerPaysShipping.addEventListener("change", updateEmbeddedShippingPreview);
$("#productForm").querySelectorAll('input[type="file"]').forEach((input) => {
  input.addEventListener("change", () => {
    try {
      validateFormUploads($("#productForm"));
      $("#productMediaStatus").textContent = "";
    } catch (error) {
      $("#productMediaStatus").textContent = uploadFailureMessage(error);
      input.value = "";
    }
  });
});
$("#addHighlightButton").addEventListener("click", () => addHighlight());
$("#addSpecButton").addEventListener("click", () => addSpec());
$("#addColorButton").addEventListener("click", () => addColor());
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
  const dateError = campaignDateError(form);
  if (dateError) {
    $("#campaignStatus").textContent = dateError;
    return;
  }
  $("#campaignStatus").textContent = "Salvando campanha...";
  const body = Object.fromEntries(new FormData(form).entries());
  body.active = form.elements.active.checked;
  Object.assign(body, campaignDatePayload(form));
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
  try {
    const result = await patchAdminSettings({
      displaySalesCount: event.currentTarget.elements.displaySalesCount.checked,
      displayFavoriteCount: event.currentTarget.elements.displayFavoriteCount.checked,
      displayRating: event.currentTarget.elements.displayRating.checked
    }, "#displaySettingsStatus", "Salvando exibição...", "Exibição da vitrine salva.");
    if (!result) return;
    currentSettings = result.settings;
    fillDisplaySettings(result.settings);
  } catch (error) {
    $("#displaySettingsStatus").textContent = error.message;
  }
});
$("#logoutButton").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST", body: "{}" });
  location.reload();
});

resetProductForm();
resetStoryForm();
showAdminPanel("dashboard");
checkSession().catch(() => {});



