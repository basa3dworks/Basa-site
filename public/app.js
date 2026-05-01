const state = {
  products: [],
  stories: [],
  customRequests: [],
  cart: JSON.parse(localStorage.getItem("basa_cart") || "[]"),
  customerSession: JSON.parse(localStorage.getItem("basa_customer_session") || "null"),
  settings: null,
  shippingQuotes: [],
  selectedShipping: null,
  catalogFeed: "for-you",
  catalogCategory: "all"
};

const debugCustomer = {
  customerUsername: "cliente_teste",
  name: "Cliente Teste Basa",
  document: "12345678909",
  email: "cliente.teste@basa3dworks.local",
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
  if (product.shipping?.freeShippingMinQuantity) return `Frete gr\u00e1tis levando ${product.shipping.freeShippingMinQuantity}+ unidades`;
  return "Combo pode liberar frete gr\u00e1tis";
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
  if (!hero || !slides.length) return;
  let index = 0;
  const showSlide = () => {
    hero.style.setProperty("--hero-image", `url("${slides[index].imageUrl}")`);
    index = (index + 1) % slides.length;
  };
  showSlide();
  if (heroSlideTimer) clearInterval(heroSlideTimer);
  if (slides.length > 1) heroSlideTimer = setInterval(showSlide, 5200);
}

function saveCart() {
  localStorage.setItem("basa_cart", JSON.stringify(state.cart));
  renderCart();
}

function openCustomerPanel() {
  $("#customerPanel").classList.add("open");
  $("#customerPanel").setAttribute("aria-hidden", "false");
}

function closeCustomerPanel() {
  $("#customerPanel").classList.remove("open");
  $("#customerPanel").setAttribute("aria-hidden", "true");
}

function openQuotePanel() {
  $("#quotePanel").classList.add("open");
  $("#quotePanel").setAttribute("aria-hidden", "false");
}

function closeQuotePanel() {
  $("#quotePanel").classList.remove("open");
  $("#quotePanel").setAttribute("aria-hidden", "true");
}

function addToCart(productId, quantityToAdd = 1) {
  trackProductInterest(productId);
  const product = state.products.find((item) => item.id === productId);
  const color = product?.variants?.colors?.[0] || "";
  const item = state.cart.find((line) => line.productId === productId && (line.color || "") === color);
  const quantity = Math.max(1, Number(quantityToAdd || 1));
  if (item) item.quantity += quantity;
  else state.cart.push({ productId, color, quantity });
  state.selectedShipping = null;
  state.shippingQuotes = [];
  saveCart();
  renderProducts();
  $("#cartPanel").classList.add("open");
}

function setCartQuantity(productId, color, quantity) {
  const nextQuantity = Math.max(0, Number(quantity || 0));
  state.cart = state.cart.flatMap((item) => {
    if (item.productId !== productId || (item.color || "") !== (color || "")) return [item];
    return nextQuantity > 0 ? [{ ...item, quantity: nextQuantity }] : [];
  });
  state.selectedShipping = null;
  state.shippingQuotes = [];
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
  [...customerFields(form), ...form.querySelectorAll("[data-auth-field]")].forEach((input) => {
    input.readOnly = loggedIn;
  });
  $("#saveCustomerButton").hidden = loggedIn;
  $("#debugCustomerButton").hidden = loggedIn;
  $("#logoutCustomerButton").hidden = !loggedIn;
  $("#checkoutSubmitButton").disabled = false;
  $("#customerLoginBox").classList.toggle("logged", loggedIn);
  $("#customerLoginStatus").textContent = loggedIn
    ? `Cliente identificado: ${session.customer.name || session.customer.email}.`
    : "Preencha seus dados e salve o cadastro para finalizar o pedido.";
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
  applyCustomerSession(form);
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
  localStorage.removeItem("basa_customer_session");
  state.customRequests = [];
  customerFields(form).forEach((input) => {
    input.readOnly = false;
  });
  form.querySelectorAll("[data-auth-field]").forEach((input) => {
    input.readOnly = false;
    input.value = "";
  });
  applyCustomerSession(form);
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

function freeShippingPromo(form) {
  const promotions = state.settings?.promotions || {};
  const coupon = String(form.elements.coupon?.value || "").trim().toUpperCase();
  const registeredCoupon = (state.settings?.coupons || []).find((item) => String(item.code || "").toUpperCase() === coupon);
  const couponIsExpired = registeredCoupon?.expiresAt && new Date(registeredCoupon.expiresAt).getTime() <= Date.now();
  const subtotal = cartSubtotal();
  const byCoupon = Boolean(registeredCoupon && !couponIsExpired && registeredCoupon.type === "free_shipping" && cartQuantity() >= Number(registeredCoupon.minItems || 1) && subtotal >= Number(registeredCoupon.minSubtotal || 0));
  const byCombo = cartQuantity() >= Number(promotions.freeShippingMinItems || Infinity);
  const byProduct = cartQuantity() > 0 && state.cart.every((item) => state.products.find((product) => product.id === item.productId)?.shipping?.sellerPaysShipping);
  const byProductQuantity = state.cart.some((item) => {
    const minQuantity = Number(state.products.find((product) => product.id === item.productId)?.shipping?.freeShippingMinQuantity || 0);
    return minQuantity > 0 && item.quantity >= minQuantity;
  });
  return { eligible: byCoupon || byCombo || byProduct || byProductQuantity, coupon, reason: byCoupon ? "cupom" : byCombo ? "combo" : byProduct ? "produto" : byProductQuantity ? "quantidade do produto" : "" };
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
  const minItems = Number(state.settings?.promotions?.freeShippingMinItems || 3);
  const quantity = cartQuantity();
  const remaining = Math.max(0, minItems - quantity);
  if (!quantity) return "Adicione produtos ao carrinho para ver benef\u00edcios de frete.";
  if (!remaining) return "Frete gr\u00e1tis liberado por combo.";
  return `Adicione mais ${remaining} ${remaining === 1 ? "item" : "itens"} para liberar frete gr\u00e1tis por combo.`;
}

function setupCepLookup(form) {
  const zipInput = form.elements.zipCode;
  if (!zipInput) return;

  zipInput.addEventListener("blur", async () => {
    const cep = zipInput.value.replace(/\D/g, "");
    if (cep.length !== 8) return;
    $("#checkoutStatus").textContent = "Buscando CEP...";

    try {
      const response = await fetch(`/api/cep/${cep}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "CEP n\u00e3o encontrado.");
      form.elements.street.value = data.street || "";
      form.elements.neighborhood.value = data.neighborhood || "";
      form.elements.city.value = data.city || "";
      form.elements.state.value = data.state || "";
      form.dataset.ibge = data.ibge || "";
      $("#checkoutStatus").textContent = "";
      quoteShipping();
    } catch (error) {
      $("#checkoutStatus").textContent = error.message;
    }
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
    $("#shippingOptions").innerHTML = "";
    return;
  }
  if (cep.length !== 8) {
    $("#shippingOptions").innerHTML = "<p>Informe um CEP válido para calcular a entrega.</p>";
    return;
  }

  if (allCartItemsHaveSellerPaidShipping()) {
    state.shippingQuotes = [];
    state.selectedShipping = null;
    $("#shippingOptions").innerHTML = `<p class="promo-note">Frete gr\u00e1tis neste pedido. A forma de envio ser\u00e1 definida pela Basa 3D Works.</p>`;
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
  if (promo.reason === "produto") {
    $("#shippingOptions").innerHTML = `<p class="promo-note">Frete gr\u00e1tis neste pedido. A forma de envio ser\u00e1 definida pela Basa 3D Works.</p>`;
    clearDeliverySelectionWarning();
    return;
  }
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
        ${favoriteCount(product) ? `<small>${favoriteCount(product)}</small>` : ""}
      </button>
      <div class="product-body">
        <p class="eyebrow">${product.category}</p>
        <div class="product-social-proof">${productMeta(product)}</div>
        <h3><a class="product-title-link" href="/produto.html?slug=${product.slug}">${product.name}</a></h3>
        ${ratingMarkup(product)}
        ${flashOfferMarkup(product)}
        <p>${product.description}</p>
        <span class="product-variant-note">${productPiecesLabel(product)}${product.variants?.colors?.length ? ` | ${product.variants.colors.length} cores` : ""}</span>
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
        <span class="stock-note">${product.stock} unidades dispon\u00edveis</span>
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
      state.selectedShipping = null;
      state.shippingQuotes = [];
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
  if (!isCustomerLoggedIn()) {
    openCheckoutDetails();
    $("#checkoutStatus").textContent = "Entre ou cadastre seus dados antes de finalizar a compra.";
    $("#customerLoginBox").scrollIntoView({ behavior: "smooth", block: "nearest" });
    return;
  }
  const shippingState = cartShippingState(event.currentTarget);
  if (!shippingState.hasSelectedQuote) {
    openCheckoutDetails();
    $("#checkoutStatus").textContent = "Calcule e selecione uma op\u00e7\u00e3o de entrega.";
    return;
  }
  $("#checkoutStatus").textContent = "Criando pedido...";
  const response = await fetch("/api/checkout", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      items: state.cart,
      customer: readCustomer(event.currentTarget),
      customerLoggedIn: true,
      shippingOption: state.selectedShipping,
      coupon: event.currentTarget.elements.coupon?.value || ""
    })
  });
  const data = await response.json();
  if (!response.ok) {
    $("#checkoutStatus").textContent = data.error || "N\u00e3o foi poss\u00edvel criar o pedido.";
    return;
  }
  state.cart = [];
  saveCart();
  location.href = data.payment.checkoutUrl || `/obrigado.html?pedido=${data.order.id}`;
}

async function submitCustomRequest(event) {
  event.preventDefault();
  const customer = customerForRequest();
  if (!customer?.email) {
    $("#customRequestStatus").textContent = "Entre/cadastre seus dados no carrinho antes de enviar uma ideia.";
    $("#cartPanel").classList.add("open");
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

async function init() {
  const response = await fetch("/api/products");
  const data = await response.json();
  state.products = data.products;
  state.stories = data.stories || [];
  state.settings = data.settings;
  applyTheme(data.settings.theme);
  renderHeroSlides();
  $("#tagline").textContent = data.settings.tagline;

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
    $("#cartPanel").classList.add("open");
    autoQuoteShippingIfPossible();
  });
  $("#mobileCartButton")?.addEventListener("click", () => {
    $("#cartPanel").classList.add("open");
    autoQuoteShippingIfPossible();
  });
  $("#closeCart").addEventListener("click", () => $("#cartPanel").classList.remove("open"));
  $("#customerButton").addEventListener("click", () => openCustomerPanel());
  $("#mobileCustomerButton")?.addEventListener("click", () => openCustomerPanel());
  $("#mobileMenuButton")?.addEventListener("click", () => openCustomerPanel());
  $("#closeCustomerPanel").addEventListener("click", closeCustomerPanel);
  $("#closeQuotePanel").addEventListener("click", closeQuotePanel);
  $("#customerPanel").addEventListener("click", (event) => {
    if (event.target.id === "customerPanel") closeCustomerPanel();
  });
  $("#quotePanel").addEventListener("click", (event) => {
    if (event.target.id === "quotePanel") closeQuotePanel();
  });
  $("#checkoutForm").addEventListener("submit", checkout);
  setupCheckoutDetails($("#checkoutForm"));
  $("#customRequestForm").addEventListener("submit", submitCustomRequest);
  $("#saveCustomerButton").addEventListener("click", () => saveCustomerSession($("#checkoutForm")));
  $("#debugCustomerButton").addEventListener("click", () => useDebugCustomer($("#checkoutForm")));
  $("#logoutCustomerButton").addEventListener("click", () => logoutCustomer($("#checkoutForm")));
  setupCepLookup($("#checkoutForm"));
  $("#checkoutForm").elements.coupon.addEventListener("input", () => {
    if (state.shippingQuotes.length) renderShippingOptions();
    renderCart();
  });

  renderProducts();
  renderStories();
  applyCustomerSession($("#checkoutForm"));
  loadCustomerRequests();
  renderCart();
  autoQuoteShippingIfPossible();
}

$("#storyCloseButton").addEventListener("click", closeStory);
$("#storyViewer").addEventListener("click", (event) => {
  if (event.target.id === "storyViewer") closeStory();
});

init();
