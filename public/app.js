const state = {
  products: [],
  stories: [],
  customRequests: [],
  cart: JSON.parse(localStorage.getItem("basa_cart") || "[]"),
  customerSession: JSON.parse(localStorage.getItem("basa_customer_session") || "null"),
  settings: null,
  pendingOrders: [],
  shippingQuotes: [],
  selectedShipping: null,
  shippingBenefit: null,
  checkoutSubmitting: false,
  catalogFeed: "for-you",
  catalogCategory: "all"
};

const debugCustomer = {
  customerUsername: "cliente_teste",
  name: "Cliente Teste Basa",
  document: "12345678909",
  email: "cliente.teste@basa3d.local",
  phone: "11999999999",
  zipCode: "01001000",
  number: "100",
  street: "Praca da Se",
  neighborhood: "Se",
  complement: "Sala teste",
  city: "Sao Paulo",
  state: "SP",
  ibge: "3550308"
};

const storyDurationMs = 6500;
const FREE_SHIPPING_MIN_SUBTOTAL = 100;
const SUPPORT_CHAT_KEY = "basa_support_chat";

function protectAppSurface() {
  const editableSelector = "input, textarea, select, option, [contenteditable='true']";
  document.addEventListener("contextmenu", (event) => {
    if (!event.target.closest(editableSelector)) event.preventDefault();
  });
  document.addEventListener("dragstart", (event) => {
    if (!event.target.closest(editableSelector)) event.preventDefault();
  });
}

let activeStoryIndex = -1;
let storyTimer = null;
let heroSlideTimer = null;
const favoriteKey = () => `basa_favorites_${state.customerSession?.customer?.email || "guest"}`;

const money = (value) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: state.settings?.currency || "BRL" }).format(value);
const $ = (selector) => document.querySelector(selector);
const shippingQuoteId = (quote) => String(quote?.id ?? `${quote?.carrier || ""}-${quote?.service || ""}`);
const moneyParts = (value) => {
  const [main, cents = "00"] = money(value).split(",");
  return { main, cents };
};
const discountPercent = (product) => {
  if (!product.compareAtPrice || product.compareAtPrice <= product.price) return 0;
  return Math.round((1 - product.price / product.compareAtPrice) * 100);
};

function normalizeSearch(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function customerProfileLabel(customer = {}) {
  return customer.displayName || customer.customerUsername || customer.name || "Cliente Basa";
}

function customerAddressLabel(customer = {}) {
  const streetLine = [customer.street, customer.number].filter(Boolean).join(", ");
  const areaLine = [customer.neighborhood, customer.city && customer.state ? `${customer.city}/${customer.state}` : customer.city || customer.state].filter(Boolean).join(" - ");
  return [streetLine, areaLine || (customer.zipCode ? `CEP ${customer.zipCode}` : "")].filter(Boolean).join(" | ");
}

function updateTopbarCustomerRow() {
  const row = $("#topbarCustomerRow");
  if (!row) return;
  const customer = state.customerSession?.customer || {};
  const logged = Boolean(state.customerSession?.loggedIn && customer.email);
  const address = customerAddressLabel(customer);
  row.hidden = !logged;
  document.body.classList.toggle("topbar-profile-visible", logged);
  if (!logged) return;
  $("#topbarCustomerName").textContent = customerProfileLabel(customer);
  $("#topbarCustomerAddress").textContent = address || "Endereço não cadastrado";
}

function readCustomerProfile() {
  return JSON.parse(localStorage.getItem("basa_customer_profile") || "{\"categories\":{}}");
}

function saveCustomerProfile(profile) {
  localStorage.setItem("basa_customer_profile", JSON.stringify(profile));
}

function readTrendProfile() {
  return JSON.parse(localStorage.getItem("basa_trend_profile") || "{}");
}

function saveTrendProfile(profile) {
  localStorage.setItem("basa_trend_profile", JSON.stringify(profile));
}

function trackProductInterest(productId) {
  const product = state.products.find((item) => item.id === productId);
  if (!product) return;
  const profile = readCustomerProfile();
  profile.categories ||= {};
  profile.categories[product.category] = Number(profile.categories[product.category] || 0) + 1;
  profile.updatedAt = new Date().toISOString();
  saveCustomerProfile(profile);
  const trend = readTrendProfile();
  trend[product.id] = Number(trend[product.id] || 0) + 1;
  saveTrendProfile(trend);
}

function campaignIsRunning(campaign) {
  if (!campaign?.active) return false;
  const now = Date.now();
  const startsAt = campaign.startsAt ? new Date(campaign.startsAt).getTime() : 0;
  const endsAt = campaign.endsAt ? new Date(campaign.endsAt).getTime() : Infinity;
  return now >= startsAt && now <= endsAt;
}

function campaignLabel(product) {
  const campaign = product.campaign;
  if (!campaignIsRunning(campaign)) return discountPercent(product) ? `${discountPercent(product)}% OFF` : "Destaque";
  if (campaign.type === "flash" && (!campaign.label || normalizeSearch(campaign.label).includes("relampago"))) return "Oferta rel\u00e2mpago";
  if (campaign.label) return campaign.label;
  return {
    flash: "Oferta rel\u00e2mpago",
    clearance: "Queima de estoque",
    launch: "Lan\u00e7amento",
    featured: "Destaque"
  }[campaign.type] || "Destaque";
}

function campaignBadgeClass(product) {
  return campaignIsRunning(product.campaign) ? `campaign-${product.campaign.type || "featured"}` : "";
}

function campaignEndsLabel(campaign) {
  if (!campaign?.endsAt) return "por tempo limitado";
  const remainingMs = new Date(campaign.endsAt).getTime() - Date.now();
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return "terminando agora";
  const hours = Math.floor(remainingMs / 3600000);
  const minutes = Math.floor((remainingMs % 3600000) / 60000);
  return hours > 0 ? `termina em ${hours}h ${minutes}min` : `termina em ${minutes}min`;
}

function flashOfferMarkup(product) {
  if (!campaignIsRunning(product.campaign) || product.campaign.type !== "flash") return "";
  return `<div class="flash-offer-card"><strong>Oferta rel\u00e2mpago</strong><span>${campaignEndsLabel(product.campaign)}</span></div>`;
}

function productPiecesLabel(product) {
  const pieces = Number(product.variants?.piecesIncluded || 1);
  return product.variants?.bundleType === "kit" || pieces > 1 ? `Kit com ${pieces} pe\u00e7as` : "1 pe\u00e7a";
}

function stockLabel(stock) {
  const quantity = Number(stock || 0);
  return `${quantity} ${quantity === 1 ? "unidade dispon\u00edvel" : "unidades dispon\u00edveis"}`;
}

function soldLabel(count) {
  const sold = Number(count || 0);
  if (!sold) return "";
  return `${sold >= 100 ? "+" : ""}${sold} vendidos`;
}

function productMeta(product) {
  return state.settings?.displaySalesCount ? soldLabel(product.soldCount) : "";
}

function shippingCardLabel(product) {
  if (product.shipping?.sellerPaysShipping) return "Frete Gr\u00e1tis";
  return "Frete calculado";
}

function ratingMarkup(product) {
  const average = Number(product.rating?.average || 0);
  const count = Number(product.rating?.count || 0);
  if (!average || !count) return "";
  const proportionalStars = Array.from({ length: 5 }, (_, index) => {
    const fill = Math.max(0, Math.min(100, (average - index) * 100));
    return `<span class="star" style="--fill:${fill}%">&#9733;</span>`;
  }).join("");
  return `<div class="rating-row"><span>${average.toFixed(1)}</span><span class="stars" aria-label="${average.toFixed(1)} de 5">${proportionalStars}</span><span>(${count})</span></div>`;
}

function productScore(product) {
  const profile = readCustomerProfile();
  const cartCategories = state.cart
    .map((item) => state.products.find((productItem) => productItem.id === item.productId)?.category)
    .filter(Boolean);
  let score = 0;
  if (campaignIsRunning(product.campaign)) {
    score += 600 + Number(product.campaign.priority || 0) * 8;
    if (product.campaign.type === "flash") score += 180;
    if (product.campaign.type === "clearance") score += 120;
    if (product.campaign.type === "launch") score += 90;
  }
  score += discountPercent(product) * 5;
  score += Number(product.rating?.average || 0) * 12;
  score += Math.min(80, Number(product.soldCount || 0) / 2);
  if (product.shipping?.sellerPaysShipping) score += 45;
  if (product.stock > 0) score += Math.min(40, Number(product.stock || 0));
  score += Number(profile.categories?.[product.category] || 0) * 35;
  if (cartCategories.includes(product.category)) score += 80;
  return score;
}

function trendScore(product) {
  const trend = readTrendProfile();
  let score = Number(trend[product.id] || 0) * 120;
  if (campaignIsRunning(product.campaign)) score += 180 + Number(product.campaign.priority || 0) * 6;
  score += discountPercent(product) * 8;
  score += Number(product.rating?.average || 0) * 14;
  score += Math.min(140, Number(product.soldCount || 0));
  if (product.shipping?.sellerPaysShipping) score += 55;
  score += Math.min(50, Number(product.stock || 0));
  return score;
}

function applyTheme(theme) {
  document.body.dataset.theme = theme || "atelier";
}

function renderHeroSlides() {
  const hero = document.querySelector(".hero");
  const slides = state.settings?.heroSlides || [];
  if (!hero) return;
  if (heroSlideTimer) clearInterval(heroSlideTimer);
  heroSlideTimer = null;
  if (!slides.length) {
    hero.classList.remove("has-slides");
    hero.hidden = true;
    return;
  }
  hero.hidden = false;
  hero.classList.add("has-slides");
  let index = 0;
  const showSlide = () => {
    hero.style.setProperty("--hero-image", `url("${slides[index].imageUrl}")`);
    index = (index + 1) % slides.length;
  };
  showSlide();
  if (slides.length > 1) heroSlideTimer = setInterval(showSlide, 5200);
}

function saveCart() {
  localStorage.setItem("basa_cart", JSON.stringify(state.cart));
  renderCart();
}

function updateCustomerPanelSession() {
  const loggedIn = isCustomerLoggedIn();
  const accessCard = $("#customerAccessCard");
  const sessionCard = $("#customerSessionCard");
  if (accessCard) accessCard.hidden = loggedIn;
  if (sessionCard) sessionCard.hidden = !loggedIn;
  document.querySelectorAll("[data-customer-auth-only]").forEach((item) => {
    item.hidden = loggedIn;
  });
  document.querySelectorAll("[data-customer-logged-only]").forEach((item) => {
    item.hidden = !loggedIn;
  });
  if (loggedIn) {
    const customer = state.customerSession.customer;
    if ($("#customerSessionName")) $("#customerSessionName").textContent = customer.name || state.customerSession.username || "Minha conta";
    if ($("#customerSessionEmail")) $("#customerSessionEmail").textContent = customer.email || "Acompanhe seus pedidos.";
  }
}

function setPublicTopbarPanelMode(isPanelOpen) {
  const menuButton = $("#mobileMenuButton");
  const icon = menuButton?.querySelector(".material-symbols-rounded");
  if (!menuButton || !icon) return;
  icon.textContent = isPanelOpen ? "home" : "menu";
  menuButton.setAttribute("aria-label", isPanelOpen ? "Voltar para loja" : "Abrir menu");
  menuButton.setAttribute("aria-expanded", isPanelOpen ? "true" : "false");
  menuButton.classList.toggle("is-back", isPanelOpen);
}

function hasPublicOverlayOpen() {
  return Boolean(
    $("#cartPanel")?.classList.contains("open") ||
    $("#customerPanel")?.classList.contains("open") ||
    $("#supportPanel")?.classList.contains("open")
  );
}

function openCustomerPanel() {
  updateCustomerPanelSession();
  $("#customerPanel").classList.add("open");
  $("#customerPanel").setAttribute("aria-hidden", "false");
  setPublicTopbarPanelMode(true);
}

function closeCustomerPanel() {
  $("#customerPanel").classList.remove("open");
  $("#customerPanel").setAttribute("aria-hidden", "true");
  setPublicTopbarPanelMode(hasPublicOverlayOpen());
}

function openQuotePanel() {
  $("#quotePanel").classList.add("open");
  $("#quotePanel").setAttribute("aria-hidden", "false");
}

function closeQuotePanel() {
  $("#quotePanel").classList.remove("open");
  $("#quotePanel").setAttribute("aria-hidden", "true");
}

async function openSupportPanel() {
  const panel = $("#supportPanel");
  const form = $("#supportChatForm");
  const customer = state.customerSession?.customer;
  const chat = supportChatState();
  if (form && customer) {
    form.elements.name.value = customer.name || "";
    form.elements.email.value = customer.email || "";
  } else if (form && chat?.email) {
    form.elements.email.value = chat.email;
  }
  updateSupportIdentityFields();
  panel.classList.add("open");
  panel.setAttribute("aria-hidden", "false");
  setPublicTopbarPanelMode(true);
  await refreshSupportChat(true);
}

function closeSupportPanel() {
  $("#supportPanel").classList.remove("open");
  $("#supportPanel").setAttribute("aria-hidden", "true");
  setPublicTopbarPanelMode(hasPublicOverlayOpen());
}

function openCartPanel() {
  $("#cartPanel").classList.add("open");
  $("#cartPanel").setAttribute("aria-hidden", "false");
  setPublicTopbarPanelMode(true);
  autoQuoteShippingIfPossible();
}

function closeCartPanel() {
  $("#cartPanel").classList.remove("open");
  $("#cartPanel").setAttribute("aria-hidden", "true");
  setPublicTopbarPanelMode(hasPublicOverlayOpen());
}

function closePublicPanels(except = "") {
  if (except !== "customer") closeCustomerPanel();
  if (except !== "quote") closeQuotePanel();
  if (except !== "support") closeSupportPanel();
  if (except !== "cart") closeCartPanel();
}

function supportChatState() {
  return JSON.parse(localStorage.getItem(SUPPORT_CHAT_KEY) || "null");
}

function saveSupportChatState(chat) {
  localStorage.setItem(SUPPORT_CHAT_KEY, JSON.stringify(chat));
}

function updateSupportIdentityFields() {
  const logged = Boolean(state.customerSession?.customer?.email);
  const form = $("#supportChatForm");
  const prompt = $("#supportLoginRequired");
  const messageField = form?.elements.message?.closest("label");
  const submitButton = form?.querySelector("button[type='submit']");
  document.querySelectorAll("[data-support-identity]").forEach((field) => {
    field.hidden = true;
  });
  if (prompt) prompt.hidden = logged;
  if (messageField) messageField.hidden = !logged;
  if (submitButton) submitButton.hidden = !logged;
  if (!logged && $("#supportChatStatus")) $("#supportChatStatus").textContent = "";
}

function supportRequestFromList(requests, chat) {
  if (!chat?.email) return null;
  return requests.find((request) => request.id === chat.id)
    || requests.find((request) => String(request.title || "").startsWith("Atendimento"));
}

function renderSupportChat(request, markSeen = false) {
  const thread = $("#supportChatThread");
  const badge = $("#supportChatBadge");
  const chat = supportChatState() || {};
  if (!thread || !badge) return;
  if (!request) {
    thread.hidden = true;
    badge.hidden = true;
    badge.textContent = "0";
    return;
  }
  const messages = request.messages || [];
  thread.hidden = false;
  thread.innerHTML = messages.map((message) => `
    <div class="support-chat-message ${message.author === "admin" ? "from-admin" : "from-customer"}">
      <span>${message.text}</span>
      <small>${message.author === "admin" ? "Basa" : "Voce"}</small>
    </div>
  `).join("");
  thread.scrollTop = thread.scrollHeight;
  const adminCount = messages.filter((message) => message.author === "admin").length;
  const seenAdminCount = Number(chat.seenAdminCount || 0);
  const unread = Math.max(0, adminCount - seenAdminCount);
  if (markSeen) {
    saveSupportChatState({ ...chat, id: request.id, email: request.customer?.email || chat.email, seenAdminCount: adminCount });
    badge.hidden = true;
    badge.textContent = "0";
    return;
  }
  badge.hidden = unread <= 0;
  badge.textContent = String(Math.min(unread, 9));
}

async function refreshSupportChat(markSeen = false) {
  const chat = supportChatState();
  if (!chat?.email) return null;
  const response = await fetch(`/api/custom-requests?email=${encodeURIComponent(chat.email)}`);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return null;
  const request = supportRequestFromList(data.requests || [], chat);
  if (request) {
    saveSupportChatState({ ...chat, id: request.id, email: request.customer?.email || chat.email, seenAdminCount: chat.seenAdminCount || 0 });
    renderSupportChat(request, markSeen);
  }
  return request;
}

function resetShippingCalculation() {
  state.selectedShipping = null;
  state.shippingQuotes = [];
  state.shippingBenefit = null;
}

function addToCart(productId, quantityToAdd = 1) {
  trackProductInterest(productId);
  const product = state.products.find((item) => item.id === productId);
  const color = product?.variants?.colors?.[0] || "";
  const item = state.cart.find((line) => line.productId === productId && (line.color || "") === color);
  const quantity = Math.max(1, Number(quantityToAdd || 1));
  if (item) item.quantity += quantity;
  else state.cart.push({ productId, color, quantity });
  resetShippingCalculation();
  saveCart();
  renderProducts();
  openCartPanel();
}

function setCartQuantity(productId, color, quantity) {
  const nextQuantity = Math.max(0, Number(quantity || 0));
  state.cart = state.cart.flatMap((item) => {
    if (item.productId !== productId || (item.color || "") !== (color || "")) return [item];
    return nextQuantity > 0 ? [{ ...item, quantity: nextQuantity }] : [];
  });
  resetShippingCalculation();
  saveCart();
}

function readCustomer(form) {
  return {
    name: form.elements.name?.value || "",
    document: form.elements.document?.value || "",
    email: form.elements.email?.value || "",
    phone: form.elements.phone?.value || "",
    zipCode: form.elements.zipCode?.value || "",
    number: form.elements.number?.value || "",
    street: form.elements.street?.value || "",
    neighborhood: form.elements.neighborhood?.value || "",
    complement: form.elements.complement?.value || "",
    city: form.elements.city?.value || "",
    state: form.elements.state?.value || "",
    ibge: form.dataset.ibge || ""
  };
}

function readCustomerAccess(form) {
  return {
    ...readCustomer(form),
    customerUsername: form.elements.customerUsername?.value || "",
    customerPassword: form.elements.customerPassword?.value || ""
  };
}

function isCustomerLoggedIn() {
  return Boolean(state.customerSession?.loggedIn && state.customerSession?.customer?.email);
}

function pendingPaymentOrders() {
  return state.pendingOrders.filter((order) => order.status === "awaiting_payment" && order.payment?.checkoutUrl);
}

function pendingPaymentDismissKey(orderId) {
  return `basa_pending_payment_snooze_${orderId}`;
}

function pendingPaymentIsSnoozed(order) {
  return Number(localStorage.getItem(pendingPaymentDismissKey(order.id)) || 0) > Date.now();
}

function snoozePendingPayment(orderId, hours = 6) {
  localStorage.setItem(pendingPaymentDismissKey(orderId), String(Date.now() + hours * 3600000));
  renderPendingPaymentBanner();
}

function paymentExpiryLabel(order) {
  if (!order.payment?.expiresAt) return "";
  const expiresAt = new Date(order.payment.expiresAt).getTime();
  if (!Number.isFinite(expiresAt)) return "";
  const remainingMs = expiresAt - Date.now();
  if (remainingMs <= 0) return "expira em instantes";
  const hours = Math.ceil(remainingMs / 3600000);
  return hours >= 24 ? `expira em ${Math.ceil(hours / 24)} dia(s)` : `expira em ${hours}h`;
}

async function loadPendingOrders() {
  if (!isCustomerLoggedIn()) {
    state.pendingOrders = [];
    renderPendingPaymentBanner();
    return;
  }
  try {
    const email = encodeURIComponent(state.customerSession.customer.email);
    const response = await fetch(`/api/customer/orders?email=${email}`);
    const data = await response.json();
    state.pendingOrders = response.ok ? (data.orders || []).filter((order) => order.status === "awaiting_payment") : [];
  } catch {
    state.pendingOrders = [];
  }
  renderPendingPaymentBanner();
}

function renderPendingPaymentBanner() {
  document.querySelector(".pending-payment-banner")?.remove();
  const [order] = pendingPaymentOrders().filter((item) => !pendingPaymentIsSnoozed(item));
  if (!order) return;
  const banner = document.createElement("aside");
  banner.className = "pending-payment-banner";
  banner.innerHTML = `
    <div class="pending-payment-copy">
      <strong>Você tem uma compra pendente</strong>
      <span>${order.id} | ${money(order.total)}${paymentExpiryLabel(order) ? ` | ${paymentExpiryLabel(order)}` : ""}</span>
    </div>
    <div class="pending-payment-actions">
      <a class="primary-button" href="${order.payment.checkoutUrl}">Concluir pagamento</a>
      <a class="ghost-button" href="/conta.html#orders" data-pending-view-orders="${order.id}">Ver pedidos</a>
      <button class="ghost-button" type="button" data-pending-snooze="${order.id}">Lembre-me mais tarde</button>
      <button class="pending-payment-close" type="button" data-pending-close="${order.id}" aria-label="Fechar aviso">×</button>
    </div>
  `;
  document.body.insertBefore(banner, document.querySelector("main"));
  banner.querySelector("[data-pending-snooze]")?.addEventListener("click", () => snoozePendingPayment(order.id));
  banner.querySelector("[data-pending-close]")?.addEventListener("click", () => snoozePendingPayment(order.id));
  banner.querySelector("[data-pending-view-orders]")?.addEventListener("click", () => {
    localStorage.setItem(pendingPaymentDismissKey(order.id), String(Date.now() + 6 * 3600000));
  });
}

function customerFields(form) {
  return [...form.querySelectorAll("[data-customer-field]")];
}

function applyCustomerSession(form) {
  const session = state.customerSession;
  if (session?.customer) {
    Object.entries(session.customer).forEach(([key, value]) => {
      if (form.elements[key]) form.elements[key].value = value || "";
    });
    if (form.elements.customerUsername) form.elements.customerUsername.value = session.username || "";
    if (form.elements.customerPassword) form.elements.customerPassword.value = "******";
    form.dataset.ibge = session.customer.ibge || "";
  }

  const loggedIn = isCustomerLoggedIn();
  form.querySelectorAll("[data-auth-field]").forEach((input) => {
    input.readOnly = loggedIn;
  });
  customerFields(form).forEach((input) => {
    input.readOnly = false;
  });
  $("#saveCustomerButton").hidden = loggedIn;
  if ($("#debugCustomerButton")) $("#debugCustomerButton").hidden = loggedIn;
  $("#logoutCustomerButton").hidden = !loggedIn;
  $("#checkoutSubmitButton").disabled = false;
  $("#customerLoginBox").classList.toggle("logged", loggedIn);
  $("#customerLoginStatus").textContent = loggedIn
    ? `Comprando como ${session.customer.name || session.customer.email}. Você pode mudar o CEP só para este pedido.`
    : "Entre ou crie sua conta para finalizar o pedido.";
}

async function saveCustomerSession(form) {
  if (!form.reportValidity()) return;
  $("#checkoutStatus").textContent = "Validando cadastro...";
  const response = await fetch("/api/customer/access", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(readCustomerAccess(form))
  });
  const data = await response.json();
  if (!response.ok) {
    $("#checkoutStatus").textContent = data.error || "Nao foi possivel entrar/cadastrar.";
    return;
  }
  const customer = data.account.customer;
  state.customerSession = { loggedIn: true, username: data.account.username, customer, updatedAt: new Date().toISOString() };
  localStorage.setItem("basa_customer_session", JSON.stringify(state.customerSession));
  updateTopbarCustomerRow();
  applyCustomerSession(form);
  loadPendingOrders();
  loadCustomerRequests();
  $("#checkoutStatus").textContent = data.created ? "Cadastro criado. Agora você pode finalizar o pedido." : "Login confirmado. Agora você pode finalizar o pedido.";
}

function useDebugCustomer(form) {
  Object.entries(debugCustomer).forEach(([key, value]) => {
    if (form.elements[key]) form.elements[key].value = value;
  });
  if (form.elements.customerPassword) form.elements.customerPassword.value = location.hostname === "localhost" ? "teste123" : "";
  form.dataset.ibge = debugCustomer.ibge;
  if (location.hostname === "localhost") {
    saveCustomerSession(form);
    return;
  }
  $("#checkoutStatus").textContent = "Dados de teste preenchidos. Defina uma senha e clique em Entrar/Cadastrar.";
  quoteShipping();
}

function logoutCustomer(form) {
  state.customerSession = null;
  state.pendingOrders = [];
  localStorage.removeItem("basa_customer_session");
  updateTopbarCustomerRow();
  state.customRequests = [];
  customerFields(form).forEach((input) => {
    input.readOnly = false;
  });
  form.querySelectorAll("[data-auth-field]").forEach((input) => {
    input.readOnly = false;
    input.value = "";
  });
  applyCustomerSession(form);
  updateCustomerPanelSession();
  renderPendingPaymentBanner();
  renderCustomerRequests();
  $("#checkoutStatus").textContent = "Dados liberados para alteracao. Salve novamente antes de comprar.";
}

function favoriteIds() {
  return JSON.parse(localStorage.getItem(favoriteKey()) || "[]");
}

function saveFavoriteIds(ids) {
  localStorage.setItem(favoriteKey(), JSON.stringify([...new Set(ids)]));
}

function isFavorite(productId) {
  return favoriteIds().includes(productId);
}

function favoriteCount(product) {
  return Number(product.favoriteCount || 0) + (isFavorite(product.id) ? 1 : 0);
}

function favoriteCountLabel(product) {
  if (!state.settings?.displayFavoriteCount) return "";
  const count = favoriteCount(product);
  return count ? `<small>${count}</small>` : "";
}

function toggleFavorite(productId) {
  const ids = favoriteIds();
  saveFavoriteIds(ids.includes(productId) ? ids.filter((id) => id !== productId) : [...ids, productId]);
  renderProducts();
}

function customerForRequest() {
  return state.customerSession?.customer || null;
}

function cartQuantity() {
  return state.cart.reduce((sum, item) => sum + item.quantity, 0);
}

function hasActiveCartFreeShippingBenefit() {
  const allItemsSellerPaid = cartQuantity() > 0 && state.cart.every((item) => state.products.find((entry) => entry.id === item.productId)?.shipping?.sellerPaysShipping);
  return cartSubtotal() >= FREE_SHIPPING_MIN_SUBTOTAL || allItemsSellerPaid;
}

function freeShippingPromo(form) {
  const coupon = String(form.elements.coupon?.value || "").trim().toUpperCase();
  const registeredCoupon = (state.settings?.coupons || []).find((item) => String(item.code || "").toUpperCase() === coupon);
  const couponIsExpired = registeredCoupon?.expiresAt && new Date(registeredCoupon.expiresAt).getTime() <= Date.now();
  const subtotal = cartSubtotal();
  const byCoupon = Boolean(registeredCoupon && !couponIsExpired && registeredCoupon.type === "free_shipping" && cartQuantity() >= Number(registeredCoupon.minItems || 1) && subtotal >= Number(registeredCoupon.minSubtotal || 0));
  const bySubtotal = subtotal >= FREE_SHIPPING_MIN_SUBTOTAL;
  const backendFree = Boolean(state.shippingBenefit?.freeShipping);
  const backendReason = state.shippingBenefit?.reason === "coupon" ? "cupom" : state.shippingBenefit?.reason === "subtotal" ? `subtotal acima de ${money(FREE_SHIPPING_MIN_SUBTOTAL)}` : state.shippingBenefit?.reason === "seller_pays_shipping" ? "produto" : "";
  const byProduct = cartQuantity() > 0 && state.cart.every((item) => state.products.find((product) => product.id === item.productId)?.shipping?.sellerPaysShipping);
  return { eligible: byCoupon || bySubtotal || byProduct || backendFree, coupon, reason: byCoupon ? "cupom" : bySubtotal ? `subtotal acima de ${money(FREE_SHIPPING_MIN_SUBTOTAL)}` : byProduct ? "produto" : backendReason };
}

function allCartItemsHaveSellerPaidShipping() {
  return cartQuantity() > 0 && state.cart.every((item) => state.products.find((product) => product.id === item.productId)?.shipping?.sellerPaysShipping);
}

function cartShippingState(form) {
  const promo = freeShippingPromo(form);
  const isFree = promo.eligible || allCartItemsHaveSellerPaidShipping();
  const needsSelection = cartQuantity() > 0 && !isFree;
  const selectedCost = state.selectedShipping ? Number(state.selectedShipping.price || 0) : null;
  return {
    promo,
    isFree,
    needsSelection,
    shipping: needsSelection ? selectedCost : 0,
    hasSelectedQuote: !needsSelection || selectedCost !== null
  };
}

function cartSubtotal() {
  const products = new Map(state.products.map((product) => [product.id, product]));
  return state.cart.reduce((sum, item) => {
    const product = products.get(item.productId);
    return product ? sum + product.price * item.quantity : sum;
  }, 0);
}

function comboProgressMessage() {
  if (!cartQuantity()) return "Adicione produtos ao carrinho para calcular o frete.";
  if (state.shippingBenefit?.message) return state.shippingBenefit.message;
  if (hasActiveCartFreeShippingBenefit()) return "Frete Gr\u00e1tis ativo neste pedido.";
  return "Calcule a entrega para ver o valor do frete.";
}

function setupCepLookup(form) {
  const zipInput = form.elements.zipCode;
  if (!zipInput) return;
  let lastCep = "";

  const setAddressField = (name, value) => {
    const field = form.elements[name];
    if (field) field.value = value || "";
  };

  const lookup = async () => {
    const cep = zipInput.value.replace(/\D/g, "");
    if (cep.length !== 8) return;
    if (cep === lastCep) return;
    lastCep = cep;
    $("#checkoutStatus").textContent = "Buscando CEP...";

    try {
      const response = await fetch(`/api/cep/${cep}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "CEP n\u00e3o encontrado.");
      zipInput.value = data.zipCode || data.cep || cep;
      setAddressField("street", data.street);
      setAddressField("neighborhood", data.neighborhood);
      setAddressField("city", data.city);
      setAddressField("state", data.state);
      form.dataset.ibge = data.ibge || "";
      $("#checkoutStatus").textContent = "";
      quoteShipping();
    } catch (error) {
      lastCep = "";
      $("#checkoutStatus").textContent = error.message;
    }
  };

  zipInput.addEventListener("blur", lookup);
  zipInput.addEventListener("change", lookup);
  zipInput.addEventListener("input", () => {
    if (zipInput.value.replace(/\D/g, "").length === 8) lookup();
  });
}

function openCheckoutDetails() {
  const details = $("#checkoutDetails");
  if (details) details.open = true;
}

function clearDeliverySelectionWarning() {
  const status = $("#checkoutStatus");
  if (status?.textContent.includes("Calcule e selecione")) status.textContent = "";
}

function autoQuoteShippingIfPossible() {
  const form = $("#checkoutForm");
  const cep = form?.elements.zipCode?.value.replace(/\D/g, "") || "";
  if (state.cart.length && cep.length === 8 && !state.selectedShipping && !state.shippingQuotes.length) {
    quoteShipping();
  }
}

function setupCheckoutDetails(form) {
  const details = $("#checkoutDetails");
  if (!details) return;
  form.addEventListener("invalid", openCheckoutDetails, true);
}

async function quoteShipping() {
  const form = $("#checkoutForm");
  const cep = form.elements.zipCode.value.replace(/\D/g, "");
  if (!state.cart.length) {
    resetShippingCalculation();
    $("#shippingOptions").innerHTML = "";
    return;
  }
  if (cep.length !== 8) {
    state.shippingBenefit = null;
    $("#shippingOptions").innerHTML = "<p>Informe um CEP válido para calcular a entrega.</p>";
    return;
  }

  const qualifiesBySubtotal = cartSubtotal() >= FREE_SHIPPING_MIN_SUBTOTAL;
  if (qualifiesBySubtotal || allCartItemsHaveSellerPaidShipping()) {
    state.shippingQuotes = [];
    state.selectedShipping = null;
    state.shippingBenefit = {
      freeShipping: true,
      reason: qualifiesBySubtotal ? "subtotal" : "seller_pays_shipping",
      message: qualifiesBySubtotal ? "Frete gratis acima de R$ 100 liberado." : "Frete Gratis liberado."
    };
    $("#shippingOptions").innerHTML = `<p class="promo-note">${qualifiesBySubtotal ? "Frete gr\u00e1tis acima de R$ 100 liberado." : "Frete gr\u00e1tis neste pedido. A forma de envio ser\u00e1 definida pela Basa 3D Works."}</p>`;
    clearDeliverySelectionWarning();
    renderCart();
    return;
  }

  $("#shippingOptions").innerHTML = "<p>Calculando entrega...</p>";
  const response = await fetch("/api/shipping/quote", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ zipCode: cep, items: state.cart })
  });
  const data = await response.json();
  if (!response.ok) {
    $("#shippingOptions").innerHTML = `<p>${data.error || "N\u00e3o foi poss\u00edvel calcular o frete."}</p>`;
    return;
  }

  state.shippingQuotes = data.quotes || [];
  state.selectedShipping = state.shippingQuotes[0] || null;
  state.shippingBenefit = data.shippingBenefit || null;
  if (state.selectedShipping) clearDeliverySelectionWarning();
  renderShippingOptions();
  renderCart();
}

function renderShippingOptions() {
  if (!state.shippingQuotes.length) {
    state.selectedShipping = null;
    $("#shippingOptions").innerHTML = "<p>Nenhuma op\u00e7\u00e3o de entrega encontrada para este CEP. Confira peso, medidas e CEP de origem.</p>";
    renderCart();
    return;
  }

  const promo = freeShippingPromo($("#checkoutForm"));
  $("#shippingOptions").innerHTML = `
    <p class="${promo.eligible ? "promo-note" : "combo-note"}">${promo.eligible ? `Frete gr\u00e1tis liberado por ${promo.reason}.` : comboProgressMessage()}</p>
    ${state.shippingQuotes.map((quote) => `
    <label class="shipping-option">
      <input type="radio" name="shippingOption" value="${shippingQuoteId(quote)}" ${shippingQuoteId(state.selectedShipping) === shippingQuoteId(quote) ? "checked" : ""}>
      <span>
        <strong>${quote.carrier} - ${quote.service}</strong>
        <small>${quote.deliveryDays ? `${quote.deliveryDays} dias \u00fateis` : "Prazo a confirmar"}${quote.note ? ` - ${quote.note}` : ""}</small>
      </span>
      <b>${promo.eligible ? "Gr\u00e1tis" : money(quote.price)}</b>
    </label>
  `).join("")}
  `;

  document.querySelectorAll('[name="shippingOption"]').forEach((input) => {
    input.addEventListener("change", () => {
      state.selectedShipping = state.shippingQuotes.find((quote) => shippingQuoteId(quote) === input.value) || null;
      clearDeliverySelectionWarning();
      renderCart();
    });
  });
}

function renderProducts() {
  const category = state.catalogFeed === "category" ? state.catalogCategory : "all";
  const search = normalizeSearch(($("#mobileSearchInput")?.value || "").trim());
  let products = category === "all" ? [...state.products] : state.products.filter((product) => product.category === category);
  if (state.catalogFeed === "favorites") {
    const favorites = favoriteIds();
    products = products.filter((product) => favorites.includes(product.id));
  }
  products = products
    .filter((product) => !search || normalizeSearch(`${product.name} ${product.description} ${product.category} ${productMeta(product)}`).includes(search))
    .sort((a, b) => state.catalogFeed === "trending" ? trendScore(b) - trendScore(a) : productScore(b) - productScore(a));
  $("#productGrid").innerHTML = products.length ? products.map((product) => `
    <article class="product-card">
      <a class="product-image-link" href="/produto.html?slug=${product.slug}">
        <img src="${product.image}" alt="${product.name}">
        <span class="product-badge ${campaignBadgeClass(product)}">${campaignLabel(product)}</span>
      </a>
      <button class="favorite-button ${isFavorite(product.id) ? "active" : ""}" type="button" data-favorite="${product.id}" aria-label="Favoritar ${product.name}">
        <span aria-hidden="true">${isFavorite(product.id) ? "&#9829;" : "&#9825;"}</span>
        ${favoriteCountLabel(product)}
      </button>
      <div class="product-body">
        <p class="eyebrow">${product.category}</p>
        <div class="product-social-proof">${productMeta(product)}</div>
        <h3><a class="product-title-link" href="/produto.html?slug=${product.slug}">${product.name}</a></h3>
        ${ratingMarkup(product)}
        ${flashOfferMarkup(product)}
        <p>${product.description}</p>
        <span class="product-variant-note">${productPiecesLabel(product)}</span>
        <div class="product-actions">
          <div class="price-block">
            ${product.compareAtPrice ? `<span class="old-price">${money(product.compareAtPrice)}</span>` : ""}
            <div class="price-line">
              <strong class="price"><span>${moneyParts(product.price).main}</span><sup>${moneyParts(product.price).cents}</sup></strong>
              ${discountPercent(product) ? `<span class="discount-pill">${discountPercent(product)}% OFF</span>` : ""}
            </div>
          </div>
        </div>
        <span class="shipping-note">${shippingCardLabel(product)}</span>
        <span class="stock-note">${stockLabel(product.stock)}</span>
      </div>
    </article>
  `).join("") : `<div class="empty-catalog"><strong>Nenhum produto por aqui ainda.</strong><span>${state.catalogFeed === "favorites" ? "Favorite alguns itens para montar sua vitrine." : "Tente outra categoria ou busca."}</span></div>`;

  document.querySelectorAll("[data-favorite]").forEach((button) => {
    button.addEventListener("click", () => toggleFavorite(button.dataset.favorite));
  });
  document.querySelectorAll(".product-image-link, .product-title-link").forEach((link) => {
    link.addEventListener("click", () => {
      const product = products.find((item) => link.href.includes(`slug=${item.slug}`));
      if (product) trackProductInterest(product.id);
    });
  });
  renderMobileCatalogTabs();
}

function setCatalogFeed(feed, category = "all") {
  state.catalogFeed = feed;
  state.catalogCategory = category;
  if (feed === "category") $("#categoryFilter").value = category;
  if (feed !== "category") $("#categoryFilter").value = "all";
  renderProducts();
  document.querySelector("#produtos")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderMobileCatalogTabs() {
  const tabs = document.querySelectorAll("[data-feed]");
  tabs.forEach((tab) => {
    tab.classList.toggle("active", state.catalogFeed === tab.dataset.feed);
  });
  document.querySelectorAll("[data-mobile-category]").forEach((button) => {
    button.classList.toggle("active", state.catalogFeed === "category" && state.catalogCategory === button.dataset.mobileCategory);
  });
}

function syncMobileExploreButton() {
  const panel = $("#mobileCategoryPanel");
  const chips = panel?.querySelector(".mobile-interest-chips");
  const exploreButton = $("#mobileExploreMore");
  const printIdeasButton = $("#mobilePrintIdeas");
  if (!panel || !chips || !exploreButton || panel.hidden) return;
  const hasOverflow = chips.scrollHeight > chips.clientHeight + 2;
  exploreButton.hidden = !hasOverflow && !panel.classList.contains("is-expanded");
  if (printIdeasButton) printIdeasButton.hidden = false;
}

function renderStories() {
  const stories = state.stories.slice(0, 10);
  $("#productStories").innerHTML = stories.map((story) => `
    <button class="story-bubble" type="button" data-story="${story.id}">
      <span>
        <img src="${story.mediaType === "video" ? story.posterUrl || story.product?.image || "" : story.mediaUrl}" alt="${story.title}">
        ${story.mediaType === "video" ? "<i>Video</i>" : ""}
      </span>
      <strong>${story.title}</strong>
    </button>
  `).join("");

  document.querySelectorAll("[data-story]").forEach((button) => {
    button.addEventListener("click", () => openStory(button.dataset.story));
  });
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

async function loadCustomerRequests() {
  const customer = customerForRequest();
  if (!customer?.email) {
    state.customRequests = [];
    renderCustomerRequests();
    return;
  }
  const response = await fetch(`/api/custom-requests?email=${encodeURIComponent(customer.email)}`);
  const data = await response.json();
  state.customRequests = response.ok ? data.requests || [] : [];
  renderCustomerRequests();
}

function renderCustomerRequests() {
  const list = $("#customerRequestList");
  if (!list) return;
  list.innerHTML = state.customRequests.length ? state.customRequests.map((request) => `
    <article class="request-card">
      <div class="request-card-head">
        <div>
          <strong>${request.title}</strong>
          <span>${request.id} | ${requestStatusLabel(request.status)}</span>
        </div>
        <small>${new Date(request.updatedAt || request.createdAt).toLocaleString("pt-BR")}</small>
      </div>
      <p>${request.idea}</p>
      ${request.attachment?.url ? `<a class="request-attachment" href="${request.attachment.url}" target="_blank" rel="noreferrer">Ver imagem enviada</a>` : ""}
      <div class="request-messages">
        ${(request.messages || []).slice(-4).map((message) => `<span class="${message.author === "admin" ? "admin-message" : ""}"><b>${message.author === "admin" ? "Basa" : "Você"}:</b> ${message.text}</span>`).join("")}
      </div>
      <form class="request-message-form" data-request-message="${request.id}">
        <input name="text" placeholder="Responder sobre esta encomenda">
        <button class="ghost-button" type="submit">Enviar</button>
      </form>
    </article>
  `).join("") : "<p>Nenhuma encomenda sob medida ainda.</p>";

  document.querySelectorAll("[data-request-message]").forEach((form) => {
    form.addEventListener("submit", sendRequestMessage);
  });
}

async function sendRequestMessage(event) {
  event.preventDefault();
  const customer = customerForRequest();
  const text = event.currentTarget.elements.text.value.trim();
  if (!customer?.email || !text) return;
  const response = await fetch(`/api/custom-requests/${encodeURIComponent(event.currentTarget.dataset.requestMessage)}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: customer.email, text })
  });
  const data = await response.json();
  if (response.ok) {
    state.customRequests = state.customRequests.map((request) => request.id === data.request.id ? data.request : request);
    renderCustomerRequests();
  }
}

function openStory(storyId) {
  const storyIndex = state.stories.findIndex((item) => item.id === storyId);
  const story = state.stories[storyIndex];
  if (!story) return;
  activeStoryIndex = storyIndex;
  const product = story.product ? state.products.find((item) => item.id === story.product.id) : null;
  $("#storyCard").innerHTML = `
    ${story.mediaType === "video" ? `
      <video src="${story.mediaUrl}" autoplay muted loop playsinline></video>
    ` : `
      <img src="${story.mediaUrl}" alt="${story.title}">
    `}
    <div class="story-progress-list">
      ${state.stories.map((item, index) => `
        <span class="${index < activeStoryIndex ? "done" : index === activeStoryIndex ? "active" : ""}"><i></i></span>
      `).join("")}
    </div>
    <button class="story-hit story-prev" type="button" data-story-prev aria-label="Story anterior"></button>
    <button class="story-hit story-next" type="button" data-story-next aria-label="Proximo story"></button>
    <div class="story-content">
      <p class="eyebrow">Bastidores Basa</p>
      <h2>${story.title}</h2>
      <p>${story.caption}</p>
      <div class="story-actions">
        ${product ? `<a class="story-product-link" href="/produto.html?slug=${product.slug}">Ver produto relacionado</a>` : ""}
      </div>
    </div>
  `;
  $("#storyViewer").hidden = false;
  document.body.classList.add("story-open");
  $("#storyCard").querySelector("[data-story-prev]").addEventListener("click", previousStory);
  $("#storyCard").querySelector("[data-story-next]").addEventListener("click", nextStory);
  startStoryTimer();
}

function startStoryTimer() {
  clearTimeout(storyTimer);
  const activeProgress = $("#storyCard").querySelector(".story-progress-list .active i");
  if (activeProgress) {
    activeProgress.style.animation = "none";
    activeProgress.offsetHeight;
    activeProgress.style.animation = `storyProgress ${storyDurationMs}ms linear forwards`;
  }
  storyTimer = setTimeout(nextStory, storyDurationMs);
}

function nextStory() {
  if (activeStoryIndex < state.stories.length - 1) {
    openStory(state.stories[activeStoryIndex + 1].id);
    return;
  }
  closeStory();
}

function previousStory() {
  if (activeStoryIndex > 0) {
    openStory(state.stories[activeStoryIndex - 1].id);
    return;
  }
  startStoryTimer();
}

function closeStory() {
  clearTimeout(storyTimer);
  activeStoryIndex = -1;
  $("#storyViewer").hidden = true;
  document.body.classList.remove("story-open");
}

function renderCart() {
  const products = new Map(state.products.map((product) => [product.id, product]));
  const lines = state.cart.map((item) => ({ ...item, product: products.get(item.productId) })).filter((item) => item.product);
  const subtotal = lines.reduce((sum, item) => sum + item.product.price * item.quantity, 0);
  const shippingState = cartShippingState($("#checkoutForm"));
  const promo = shippingState.promo;
  const shipping = lines.length ? shippingState.shipping : 0;
  const deliveryLabel = !lines.length ? money(0) : shippingState.isFree ? "Gr\u00e1tis" : shipping === null ? "A calcular" : money(shipping);
  const totalLabel = shipping === null ? "A calcular" : money(subtotal + shipping);

  $("#cartCount").textContent = lines.reduce((sum, item) => sum + item.quantity, 0);
  $("#cartItems").innerHTML = lines.length ? lines.map((item) => `
    <div class="cart-line">
      <div>
        <strong>${item.product.name}</strong>
        <span>${item.quantity} x ${money(item.product.price)}${item.color ? ` | Cor: ${item.color}` : ""}</span>
      </div>
      <div class="quantity-stepper" aria-label="Quantidade">
        <button type="button" data-qty-minus="${item.productId}" data-qty-color="${item.color || ""}">-</button>
        <input value="${item.quantity}" inputmode="numeric" data-qty-input="${item.productId}" data-qty-color="${item.color || ""}">
        <button type="button" data-qty-plus="${item.productId}" data-qty-color="${item.color || ""}">+</button>
      </div>
      <button class="ghost-button" data-remove="${item.productId}" data-remove-color="${item.color || ""}">Remover</button>
    </div>
  `).join("") : "<p>Seu carrinho está vazio.</p>";

  $("#cartTotals").innerHTML = `
    <span class="combo-progress">${promo.eligible ? `Frete gr\u00e1tis liberado por ${promo.reason}` : comboProgressMessage()}</span>
    <span>Subtotal <strong>${money(subtotal)}</strong></span>
    <span>Entrega <strong>${deliveryLabel}</strong></span>
    <span>Total <strong>${totalLabel}</strong></span>
  `;

  document.querySelectorAll("[data-remove]").forEach((button) => {
    button.addEventListener("click", () => {
      state.cart = state.cart.filter((item) => item.productId !== button.dataset.remove || (item.color || "") !== (button.dataset.removeColor || ""));
      resetShippingCalculation();
      saveCart();
      $("#shippingOptions").innerHTML = "<p>Calcule a entrega novamente ap\u00f3s alterar o carrinho.</p>";
    });
  });
  document.querySelectorAll("[data-qty-minus]").forEach((button) => {
    button.addEventListener("click", () => {
      const item = state.cart.find((line) => line.productId === button.dataset.qtyMinus && (line.color || "") === (button.dataset.qtyColor || ""));
      if (item) setCartQuantity(item.productId, item.color || "", item.quantity - 1);
    });
  });
  document.querySelectorAll("[data-qty-plus]").forEach((button) => {
    button.addEventListener("click", () => {
      const item = state.cart.find((line) => line.productId === button.dataset.qtyPlus && (line.color || "") === (button.dataset.qtyColor || ""));
      if (item) setCartQuantity(item.productId, item.color || "", item.quantity + 1);
    });
  });
  document.querySelectorAll("[data-qty-input]").forEach((input) => {
    input.addEventListener("change", () => setCartQuantity(input.dataset.qtyInput, input.dataset.qtyColor || "", input.value));
  });
}

async function checkout(event) {
  event.preventDefault();
  if (!state.cart.length) return;
  if (state.checkoutSubmitting) return;
  if (!isCustomerLoggedIn()) {
    openCheckoutDetails();
    $("#checkoutStatus").textContent = "Entre ou crie sua conta antes de finalizar a compra.";
    $("#customerLoginBox").scrollIntoView({ behavior: "smooth", block: "nearest" });
    return;
  }
  const shippingState = cartShippingState(event.currentTarget);
  if (!shippingState.hasSelectedQuote) {
    openCheckoutDetails();
    $("#checkoutStatus").textContent = "Calcule e selecione uma op\u00e7\u00e3o de entrega.";
    return;
  }
  state.checkoutSubmitting = true;
  const submitButton = $("#checkoutSubmitButton");
  const originalButtonText = submitButton?.textContent || "Finalizar pedido";
  if (submitButton) {
    submitButton.disabled = true;
    submitButton.textContent = "Processando...";
  }
  $("#checkoutStatus").textContent = "Criando pedido...";
  let redirecting = false;
  try {
    const response = await fetch("/api/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        items: state.cart,
        customer: readCustomer(event.currentTarget),
        customerLoggedIn: true,
        shippingOption: state.selectedShipping,
        zipCode: event.currentTarget.elements.zipCode?.value || "",
        coupon: event.currentTarget.elements.coupon?.value || ""
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "N\u00e3o foi poss\u00edvel criar o pedido.");
    state.cart = [];
    saveCart();
    redirecting = true;
    location.href = data.payment.checkoutUrl || `/obrigado.html?pedido=${data.order.id}`;
  } catch (error) {
    $("#checkoutStatus").textContent = error.message || "N\u00e3o foi poss\u00edvel criar o pedido.";
  } finally {
    if (!redirecting) {
      state.checkoutSubmitting = false;
      if (submitButton) {
        submitButton.disabled = false;
        submitButton.textContent = originalButtonText;
      }
    }
  }
}

async function submitCustomRequest(event) {
  event.preventDefault();
  const customer = customerForRequest();
  if (!customer?.email) {
    $("#customRequestStatus").textContent = "Entre/cadastre seus dados no carrinho antes de enviar uma ideia.";
    openCartPanel();
    closeCustomerPanel();
    closeQuotePanel();
    return;
  }
  $("#customRequestStatus").textContent = "Enviando ideia...";
  const formData = new FormData(event.currentTarget);
  formData.set("customer", JSON.stringify(customer));
  const response = await fetch("/api/custom-requests", {
    method: "POST",
    body: formData
  });
  const data = await response.json();
  if (!response.ok) {
    $("#customRequestStatus").textContent = data.error || "Nao foi possivel enviar.";
    return;
  }
  event.currentTarget.reset();
  state.customRequests = [data.request, ...state.customRequests];
  renderCustomerRequests();
  $("#customRequestStatus").textContent = "Ideia enviada. Vamos responder por aqui.";
}

async function submitSupportChat(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const customer = state.customerSession?.customer || {};
  const chat = supportChatState();
  if (!customer.email) {
    $("#supportChatStatus").textContent = "";
    return;
  }
  const name = form.elements.name.value.trim() || customer.name || "Cliente Basa";
  const email = (form.elements.email.value.trim() || customer.email || chat?.email || "").toLowerCase();
  const message = form.elements.message.value.trim();
  const status = $("#supportChatStatus");
  if (!email) {
    status.textContent = "Informe seu e-mail para respondermos.";
    return;
  }
  if (!message) {
    status.textContent = "Escreva sua mensagem.";
    return;
  }
  status.textContent = "Enviando mensagem...";
  const request = await refreshSupportChat(false);
  const response = request ? await fetch(`/api/custom-requests/${encodeURIComponent(request.id)}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, text: message })
  }) : await fetch("/api/custom-requests", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: "Atendimento pelo chat",
      kind: "chat",
      idea: message,
      customer: { ...customer, name, email }
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    status.textContent = data.error || "Nao foi possivel enviar.";
    return;
  }
  form.elements.message.value = "";
  saveSupportChatState({ id: data.request.id, email, seenAdminCount: (data.request.messages || []).filter((item) => item.author === "admin").length });
  updateSupportIdentityFields();
  state.customRequests = request
    ? state.customRequests.map((item) => item.id === data.request.id ? data.request : item)
    : [data.request, ...state.customRequests];
  renderCustomerRequests();
  renderSupportChat(data.request, true);
  status.textContent = "Mensagem enviada. A resposta aparece aqui no chat.";
}

async function init() {
  protectAppSurface();
  const response = await fetch("/api/products");
  const data = await response.json();
  state.products = data.products;
  state.stories = data.stories || [];
  state.settings = data.settings;
  applyTheme(data.settings.theme);
  updateTopbarCustomerRow();
  renderHeroSlides();
  $("#tagline").textContent = data.settings.tagline;
  document.querySelectorAll("[data-google-login]").forEach((link) => {
    link.href = `/api/customer/google/start?next=${encodeURIComponent(location.pathname + location.search)}`;
  });

  const categories = [...new Set(state.products.map((product) => product.category))];
  const categoryOptions = categories.map((category) => `<option value="${category}">${category}</option>`).join("");
  $("#categoryFilter").innerHTML += categoryOptions;
  $("#mobileCategoryTabs").innerHTML = categories.map((category) => `
    <button class="mobile-category-tab" type="button" data-mobile-category="${category}">${category}</button>
  `).join("");
  $("#mobileCategoryPanel").innerHTML = `
    <div class="mobile-interest-card">
      <div class="mobile-interest-head">
        <strong>Meus interesses <span>Toque para entrar</span></strong>
        <button class="mobile-panel-close" type="button" aria-label="Fechar categorias">^</button>
      </div>
      <div class="mobile-interest-chips">
        <button type="button" data-feed="favorites">Favoritos</button>
        <button type="button" data-feed="for-you">Para você</button>
        <button type="button" data-feed="trending">Tendência</button>
        ${categories.map((category) => `<button type="button" data-mobile-category="${category}">${category}</button>`).join("")}
      </div>
      <button class="mobile-explore-title" id="mobileExploreMore" type="button" hidden>Explore mais</button>
      <button class="mobile-print-ideas" id="mobilePrintIdeas" type="button" hidden>Imprima suas ideias</button>
    </div>
  `;
  $("#categoryFilter").addEventListener("change", () => {
    setCatalogFeed($("#categoryFilter").value === "all" ? "for-you" : "category", $("#categoryFilter").value);
  });
  document.querySelectorAll("[data-feed]").forEach((button) => {
    button.addEventListener("click", () => {
      setCatalogFeed(button.dataset.feed);
      $("#mobileCategoryPanel").hidden = true;
      $("#mobileCategoryPanel").classList.remove("is-expanded");
      $("#mobileCategoryMore")?.classList.remove("is-open");
      $("#mobileCategoryMore")?.setAttribute("aria-expanded", "false");
    });
  });
  document.querySelectorAll("[data-mobile-category]").forEach((button) => {
    button.addEventListener("click", () => {
      setCatalogFeed(button.dataset.mobileCategory === "all" ? "for-you" : "category", button.dataset.mobileCategory);
      $("#mobileCategoryPanel").hidden = true;
      $("#mobileCategoryPanel").classList.remove("is-expanded");
      $("#mobileCategoryMore")?.classList.remove("is-open");
      $("#mobileCategoryMore")?.setAttribute("aria-expanded", "false");
    });
  });
  $("#mobileCategoryMore")?.addEventListener("click", () => {
    const willOpen = $("#mobileCategoryPanel").hidden;
    $("#mobileCategoryPanel").hidden = !willOpen;
    $("#mobileCategoryMore").classList.toggle("is-open", willOpen);
    $("#mobileCategoryMore").setAttribute("aria-expanded", String(willOpen));
    if (willOpen) requestAnimationFrame(syncMobileExploreButton);
  });
  $(".mobile-panel-close")?.addEventListener("click", () => {
    $("#mobileCategoryPanel").hidden = true;
    $("#mobileCategoryPanel").classList.remove("is-expanded");
    $("#mobileCategoryMore")?.classList.remove("is-open");
    $("#mobileCategoryMore")?.setAttribute("aria-expanded", "false");
  });
  $("#mobileExploreMore")?.addEventListener("click", () => {
    const panel = $("#mobileCategoryPanel");
    panel.classList.toggle("is-expanded");
    $("#mobileExploreMore").textContent = panel.classList.contains("is-expanded") ? "Mostrar menos" : "Explore mais";
    syncMobileExploreButton();
  });
  $("#mobilePrintIdeas")?.addEventListener("click", () => {
    $("#mobileCategoryPanel").hidden = true;
    $("#mobileCategoryPanel").classList.remove("is-expanded");
    $("#mobileCategoryMore")?.classList.remove("is-open");
    $("#mobileCategoryMore")?.setAttribute("aria-expanded", "false");
    openQuotePanel();
    setTimeout(() => {
      $("#customRequestForm")?.scrollIntoView({ behavior: "smooth", block: "start" });
      $("#customRequestForm")?.elements.title?.focus();
    }, 120);
  });
  $("#mobileSearchInput")?.addEventListener("input", renderProducts);
  $("#cartButton").addEventListener("click", () => {
    closePublicPanels("cart");
    openCartPanel();
  });
  $("#supportChatButton")?.addEventListener("click", () => {
    if ($("#supportPanel")?.classList.contains("open")) {
      closeSupportPanel();
      return;
    }
    closePublicPanels("support");
    openSupportPanel();
  });
  $("#mobileCartButton")?.addEventListener("click", () => {
    closePublicPanels("cart");
    openCartPanel();
  });
  $("#closeCart")?.addEventListener("click", closeCartPanel);
  $("#customerButton")?.addEventListener("click", () => openCustomerPanel());
  $("#mobileCustomerButton")?.addEventListener("click", () => { window.location.href = "/conta.html"; });
  $("#mobileMenuButton")?.addEventListener("click", () => {
    if ($("#cartPanel")?.classList.contains("open")) {
      closeCartPanel();
      return;
    }
    if ($("#supportPanel")?.classList.contains("open")) {
      closeSupportPanel();
      return;
    }
    if ($("#customerPanel")?.classList.contains("open")) {
      closeCustomerPanel();
      return;
    }
    closePublicPanels("customer");
    openCustomerPanel();
  });
  $("#closeCustomerPanel")?.addEventListener("click", closeCustomerPanel);
  $("#customerPanelLogoutButton")?.addEventListener("click", () => logoutCustomer($("#checkoutForm")));
  $("#closeQuotePanel").addEventListener("click", closeQuotePanel);
  $("#closeSupportPanel")?.addEventListener("click", closeSupportPanel);
  $("#customerPanel").addEventListener("click", (event) => {
    if (event.target.id === "customerPanel") closeCustomerPanel();
  });
  $("#quotePanel").addEventListener("click", (event) => {
    if (event.target.id === "quotePanel") closeQuotePanel();
  });
  $("#supportPanel")?.addEventListener("click", (event) => {
    if (event.target.id === "supportPanel") closeSupportPanel();
  });
  $("#checkoutForm").addEventListener("submit", checkout);
  setupCheckoutDetails($("#checkoutForm"));
  $("#customRequestForm").addEventListener("submit", submitCustomRequest);
  $("#supportChatForm")?.addEventListener("submit", submitSupportChat);
  refreshSupportChat(false);
  setInterval(() => refreshSupportChat(false), 60000);
  $("#saveCustomerButton").addEventListener("click", () => { window.location.href = "/conta.html"; });
  $("#debugCustomerButton")?.addEventListener("click", () => useDebugCustomer($("#checkoutForm")));
  $("#logoutCustomerButton").addEventListener("click", () => logoutCustomer($("#checkoutForm")));
  setupCepLookup($("#checkoutForm"));
  $("#checkoutForm").elements.coupon.addEventListener("input", () => {
    if (state.shippingQuotes.length) renderShippingOptions();
    renderCart();
  });

  renderProducts();
  renderStories();
  applyCustomerSession($("#checkoutForm"));
  loadPendingOrders();
  loadCustomerRequests();
  renderCart();
  autoQuoteShippingIfPossible();

  const initialPanel = new URLSearchParams(window.location.search).get("panel");
  if (initialPanel === "chat") {
    openSupportPanel();
  } else if (initialPanel === "cart") {
    openCartPanel();
  } else if (initialPanel === "account") {
    openCustomerPanel();
  }
}

$("#storyCloseButton").addEventListener("click", closeStory);
$("#storyViewer").addEventListener("click", (event) => {
  if (event.target.id === "storyViewer") closeStory();
});

init();
