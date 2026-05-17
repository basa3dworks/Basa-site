const state = {
  products: [],
  orders: [],
  requests: [],
  session: JSON.parse(localStorage.getItem("basa_customer_session") || "null"),
  privateLoading: false
};

const $ = (selector) => document.querySelector(selector);
const money = (value) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(value || 0));
const escapeHtml = (value) => String(value || "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#039;");
const PROFILE_NAME_PATTERN = /^[a-z0-9._]{1,15}$/;

function normalizeProfileName(value) {
  return String(value || "").trim().replace(/^@+/, "").toLowerCase();
}

function profileNameError(value) {
  const name = normalizeProfileName(value);
  if (!name) return "Informe o nome do perfil.";
  if (!PROFILE_NAME_PATTERN.test(name)) {
    return "Use ate 15 caracteres, sem espacos. Permitidos: letras, numeros, ponto e underline.";
  }
  return "";
}

function favoriteKey() {
  return `basa_favorites_${state.session?.customer?.email || "guest"}`;
}

function favoriteIds() {
  return JSON.parse(localStorage.getItem(favoriteKey()) || "[]");
}

function customerFromForm(form) {
  const displayName = normalizeProfileName(form.elements.displayName?.value || form.elements.customerUsername?.value || "");
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
    ibge: form.dataset.ibge || "",
    displayName,
    customerUsername: displayName || form.elements.email?.value?.split("@")[0] || "",
    customerPassword: form.elements.customerPassword?.value || ""
  };
}

function setupCepLookup(form, statusSelector) {
  const zipInput = form?.elements.zipCode;
  if (!zipInput) return;
  let lastCep = "";
  const status = statusSelector ? $(statusSelector) : null;

  const setAddressField = (name, value) => {
    const field = form.elements[name];
    if (field) field.value = value || "";
  };

  const lookup = async () => {
    const cep = zipInput.value.replace(/\D/g, "");
    if (cep.length !== 8) return;
    if (cep === lastCep) return;
    lastCep = cep;
    if (status) status.textContent = "Buscando CEP...";

    try {
      const response = await fetch(`/api/cep/${cep}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "CEP nao encontrado.");
      zipInput.value = data.zipCode || data.cep || cep;
      setAddressField("street", data.street);
      setAddressField("neighborhood", data.neighborhood);
      setAddressField("city", data.city);
      setAddressField("state", data.state);
      form.dataset.ibge = data.ibge || "";
      if (status) status.textContent = "";
    } catch (error) {
      lastCep = "";
      if (status) status.textContent = error.message;
    }
  };

  zipInput.addEventListener("blur", lookup);
  zipInput.addEventListener("change", lookup);
  zipInput.addEventListener("input", () => {
    if (zipInput.value.replace(/\D/g, "").length === 8) lookup();
  });
}

function normalizeAccount(account) {
  if (account?.customer) return account;
  return {
    username: account?.username || account?.customerUsername || account?.email?.split("@")[0] || "",
    customer: account || {}
  };
}

function setSession(account) {
  const normalized = normalizeAccount(account);
  state.session = {
    loggedIn: true,
    username: normalized.username,
    customer: normalized.customer,
    emailVerified: Boolean(normalized.emailVerified),
    updatedAt: new Date().toISOString()
  };
  localStorage.setItem("basa_customer_session", JSON.stringify(state.session));
}

function googleLoginUrl() {
  return `/api/customer/google/start?next=${encodeURIComponent(location.pathname + location.search + location.hash)}`;
}

function isLoggedIn() {
  return Boolean(state.session?.loggedIn && state.session?.customer?.email);
}

function updateAccountMenu() {
  const logged = isLoggedIn();
  const authMenu = document.querySelector("[data-account-auth-menu]");
  const privateMenu = document.querySelector("[data-account-private-menu]");
  if (authMenu) authMenu.hidden = logged;
  if (privateMenu) privateMenu.hidden = !logged;
  document.body.classList.toggle("account-logged", logged);
}

function updateAccountTopbar(view) {
  const link = $("#accountTopbarBackLink");
  const icon = $("#accountTopbarBackIcon");
  if (!link || !icon) return;
  link.href = isLoggedIn() ? "/?panel=account#produtos" : "/#produtos";
  link.setAttribute("aria-label", isLoggedIn() ? "Voltar para Minha Basa" : "Voltar para loja");
  icon.textContent = "arrow_back";
}

function handleAccountTopbarBack(event) {
  if (!isLoggedIn()) return;
  event.preventDefault();
  window.location.href = "/?panel=account#produtos";
}

function showView(view) {
  updateAccountMenu();
  if (!isLoggedIn() && !["login", "register", "reset"].includes(view)) {
    $("#loginStatus").textContent = "Entre ou crie uma conta para acessar esta área.";
    view = "login";
  }
  if (isLoggedIn() && ["login", "register", "reset"].includes(view)) {
    view = "profile";
  }
  document.body.dataset.accountView = view;
  updateAccountTopbar(view);
  document.querySelectorAll("[data-account-panel]").forEach((panel) => {
    panel.hidden = panel.dataset.accountPanel !== view;
    panel.classList.toggle("active", panel.dataset.accountPanel === view);
  });
  document.querySelectorAll("[data-account-view]").forEach((button) => {
    button.classList.toggle("active", button.dataset.accountView === view);
  });
  renderAccount();
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
  }[status] || status || "Criado";
}

function pendingPaymentOrders() {
  return state.orders.filter((order) => order.status === "awaiting_payment" && order.payment?.checkoutUrl);
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

function profileName(customer = {}) {
  return customer.displayName || customer.name || state.session?.username || "Cliente Basa";
}

function profileInputName(customer = {}) {
  const name = normalizeProfileName(customer.displayName || state.session?.username || customer.email?.split("@")[0] || "");
  return PROFILE_NAME_PATTERN.test(name) ? name : "";
}

function avatarMarkup(customer = {}, sizeClass = "") {
  const name = profileName(customer);
  const initial = escapeHtml(name.trim().charAt(0).toUpperCase() || "B");
  return customer.avatarUrl
    ? `<img class="profile-avatar ${sizeClass}" src="${customer.avatarUrl}" alt="${escapeHtml(name)}">`
    : `<span class="profile-avatar ${sizeClass}" aria-hidden="true">${initial}</span>`;
}

function verifiedBadgeMarkup(customer = {}) {
  return customer.profileVerified ? `<span class="profile-verified" title="Perfil verificado" aria-label="Perfil verificado"></span>` : "";
}

function productById(productId) {
  return state.products.find((product) => product.id === productId) || {};
}

function orderItemImage(item) {
  const product = productById(item.productId);
  return item.image || product.image || product.gallery?.[0] || "/uploads/products/placeholder.svg";
}

function orderPrimaryItem(order) {
  return (order.items || [])[0] || {};
}

function orderItemLabel(item) {
  const variant = item.variant && Object.values(item.variant).filter(Boolean).join(" / ");
  return `${item.quantity || 1}x ${item.name || "Produto"}${variant ? ` - ${variant}` : ""}`;
}

function canReviewOrder(order) {
  return order.status === "completed";
}

function reviewFormMarkup(order, item) {
  if (!canReviewOrder(order) || !item.productId) return "";
  return `
    <form class="account-review-form" data-review-product="${item.productId}" data-review-order="${order.id}" enctype="multipart/form-data">
      <strong>Avaliar ${item.name || "produto"}</strong>
      <label>Nota
        <select name="rating" required>
          <option value="5">5 estrelas</option>
          <option value="4">4 estrelas</option>
          <option value="3">3 estrelas</option>
          <option value="2">2 estrelas</option>
          <option value="1">1 estrela</option>
        </select>
      </label>
      <label>Comentário
        <textarea name="comment" rows="3" placeholder="Conte como foi sua experiência com o produto."></textarea>
      </label>
      <label>Fotos ou vídeos
        <input name="mediaFiles" type="file" accept="image/*,video/*" multiple>
      </label>
      <button class="ghost-button" type="submit">Enviar avaliação</button>
      <p class="form-status"></p>
    </form>
  `;
}

function paymentLabel(order) {
  const payment = order.payment || {};
  const provider = {
    "mercado-pago": "Mercado Pago",
    mercado_pago: "Mercado Pago",
    mock: "Pagamento manual"
  }[payment.provider] || payment.provider || "Pagamento";
  const method = {
    pix: "Pix",
    account_money: "Saldo Mercado Pago",
    credit_card: "Cartão de crédito",
    debit_card: "Cartão de débito",
    ticket: "Boleto"
  }[payment.method || payment.type] || payment.method || payment.type || "";
  return method ? `${provider} - ${method}` : provider;
}

function shippingLabel(order) {
  const option = order.shippingOption || {};
  if (option.carrier || option.service) {
    const price = Number(order.shipping || option.price || 0);
    return `${option.carrier || "Entrega"}${option.service ? ` - ${option.service}` : ""} | ${price > 0 ? money(price) : "Frete grátis"}`;
  }
  if (Number(order.shipping || 0) === 0) return "Frete grátis";
  return `Frete ${money(order.shipping || 0)}`;
}

function productionDays(order) {
  const days = (order.items || []).map((item) => Number(item.productionDays || productById(item.productId).productionDays || productById(item.productId).shipping?.productionDays || 0));
  const maxDays = Math.max(0, ...days.filter(Number.isFinite));
  return maxDays || 3;
}

function carrierDays(order) {
  return Number(order.shippingOption?.deliveryDays || 0);
}

function deliveryWindowLabel(order) {
  const production = productionDays(order);
  const carrier = carrierDays(order);
  if (!carrier && Number(order.shipping || 0) === 0) {
    return `${production} dia(s) úteis de produção + envio a combinar`;
  }
  if (!carrier) return `${production} dia(s) úteis de produção + prazo do envio`;
  return `${production + carrier} dia(s) úteis (${production} produção + ${carrier} transporte)`;
}

function requestStatusLabel(status) {
  return {
    new: "Nova",
    in_review: "Em análise",
    quoted: "Orçada",
    approved: "Aprovada",
    in_production: "Em produção",
    shipped: "Enviada",
    completed: "Concluída",
    canceled: "Cancelada"
  }[status] || status || "Nova";
}

function renderAccount() {
  const customer = state.session?.customer || {};
  const pendingOrders = pendingPaymentOrders();
  $("#accountSummary").innerHTML = isLoggedIn() ? `
    ${pendingOrders.length ? `
      <article class="account-card pending-account-card">
        <strong>Compra pendente</strong>
        <span>${pendingOrders[0].id} | ${money(pendingOrders[0].total)}${paymentExpiryLabel(pendingOrders[0]) ? ` | ${paymentExpiryLabel(pendingOrders[0])}` : ""}</span>
        <div class="account-order-actions">
          <a class="primary-button" href="${pendingOrders[0].payment.checkoutUrl}">Concluir pagamento</a>
          <button class="ghost-button danger-button" type="button" data-cancel-order="${pendingOrders[0].id}">Desistir da compra</button>
        </div>
      </article>
    ` : ""}
    ${state.session.emailVerified === false ? `
      <article class="account-card account-warning-card">
        <strong>E-mail pendente de confirmação</strong>
        <span>Confirme seu e-mail para ativar recuperação de senha e aumentar a segurança da conta.</span>
        <button class="ghost-button" type="button" id="resendVerificationButton">Reenviar confirmação</button>
      </article>
    ` : ""}
    <article class="account-card account-profile-card">
      ${avatarMarkup(customer, "profile-avatar-large")}
      <div>
        <strong>${escapeHtml(profileName(customer))} ${verifiedBadgeMarkup(customer)}</strong>
        <span>${escapeHtml(customer.email || "")}</span>
        <small>@${escapeHtml(state.session.username || "")}</small>
      </div>
    </article>
    <form class="account-card account-profile-form" id="accountProfileForm" enctype="multipart/form-data">
      <strong>Editar perfil público</strong>
      <label>Nome do perfil<input name="displayName" maxlength="15" value="${escapeHtml(profileInputName(customer))}" placeholder="Ex: fernanda.landimm" ${customer.profileVerified ? "readonly" : ""} required></label>
      <small>${customer.profileVerified ? "Perfil verificado: somente o admin pode alterar este nome." : "Prefira usar seu @ do Instagram."}</small>
      <label>Foto de perfil<input name="avatar" type="file" accept="image/*"></label>
      <button class="ghost-button" type="submit">Salvar perfil</button>
      <p class="form-status" id="accountProfileStatus"></p>
    </form>
    <form class="account-card account-profile-form" id="accountDataForm">
      <strong>Editar dados de compra</strong>
      <label>Nome completo<input name="name" value="${escapeHtml(customer.name || "")}" required autocomplete="name"></label>
      <label>CPF ou CNPJ<input name="document" value="${escapeHtml(customer.document || "")}" required inputmode="numeric" autocomplete="off"></label>
      <label>Telefone<input name="phone" value="${escapeHtml(customer.phone || "")}" required autocomplete="tel"></label>
      <div class="checkout-grid">
        <label>CEP<input name="zipCode" value="${escapeHtml(customer.zipCode || "")}" required inputmode="numeric" autocomplete="postal-code"></label>
        <label>N&uacute;mero<input name="number" value="${escapeHtml(customer.number || "")}" required autocomplete="address-line2"></label>
      </div>
      <label>Rua<input name="street" value="${escapeHtml(customer.street || "")}" required autocomplete="address-line1"></label>
      <div class="checkout-grid">
        <label>Bairro<input name="neighborhood" value="${escapeHtml(customer.neighborhood || "")}" required></label>
        <label>Complemento<input name="complement" value="${escapeHtml(customer.complement || "")}" autocomplete="address-line3"></label>
      </div>
      <div class="checkout-grid">
        <label>Cidade<input name="city" value="${escapeHtml(customer.city || "")}" required autocomplete="address-level2"></label>
        <label>Estado<input name="state" value="${escapeHtml(customer.state || "")}" required maxlength="2" autocomplete="address-level1"></label>
      </div>
      <button class="ghost-button" type="submit">Salvar dados</button>
      <p class="form-status" id="accountDataStatus"></p>
    </form>
    <article class="account-card">
      <strong>Endereço principal</strong>
      <span>${customer.street || "Rua não informada"}, ${customer.number || "s/n"}</span>
      <small>${customer.neighborhood || ""} ${customer.city ? `| ${customer.city}/${customer.state}` : ""} ${customer.zipCode ? `| CEP ${customer.zipCode}` : ""}</small>
    </article>
  ` : "<p>Entre para ver seus dados.</p>";
  renderOrders();
  renderFavorites();
  renderRequests();
  $("#resendVerificationButton")?.addEventListener("click", resendVerification);
  $("#accountProfileForm")?.addEventListener("submit", saveProfile);
  const dataForm = $("#accountDataForm");
  if (dataForm) {
    setupCepLookup(dataForm, "#accountDataStatus");
    dataForm.addEventListener("submit", saveAccountData);
  }
}

async function saveProfile(event) {
  event.preventDefault();
  if (!isLoggedIn()) return;
  const form = event.currentTarget;
  const status = $("#accountProfileStatus");
  const button = form.querySelector("button[type='submit']");
  const input = form.elements.displayName;
  const normalizedName = normalizeProfileName(input?.value);
  const validationError = profileNameError(normalizedName);
  if (validationError) {
    if (status) status.textContent = validationError;
    return;
  }
  const currentName = normalizeProfileName(state.session.customer?.displayName || state.session.username || "");
  if (state.session.customer?.profileVerified && normalizedName !== currentName) {
    if (input) input.value = currentName;
    if (status) status.textContent = "Perfil verificado: somente o admin pode alterar este nome.";
    return;
  }
  if (normalizedName !== currentName && !state.session.customer?.profileNameChangedAt) {
    const confirmed = window.confirm("Voce pode trocar o nome de perfil agora. Depois desta troca, a proxima so podera ser feita em 30 dias. Tem certeza?");
    if (!confirmed) return;
  }
  if (input) input.value = normalizedName;
  const body = new FormData(form);
  body.set("email", state.session.customer.email);
  body.set("displayName", normalizedName);
  if (button) button.disabled = true;
  if (status) status.textContent = "Salvando perfil...";
  try {
    const response = await fetch("/api/customer/profile", { method: "POST", body });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Nao foi possivel salvar o perfil.");
    const account = data.account;
    state.session = {
      ...state.session,
      username: account.username,
      customer: account.customer,
      emailVerified: Boolean(account.emailVerified),
      updatedAt: new Date().toISOString()
    };
    localStorage.setItem("basa_customer_session", JSON.stringify(state.session));
    renderAccount();
  } catch (error) {
    if (status) status.textContent = error.message || "Nao foi possivel salvar o perfil.";
  } finally {
    if (button) button.disabled = false;
  }
}

async function saveAccountData(event) {
  event.preventDefault();
  if (!isLoggedIn()) return;
  const form = event.currentTarget;
  const status = $("#accountDataStatus");
  const button = form.querySelector("button[type='submit']");
  const body = new FormData(form);
  body.set("email", state.session.customer.email);
  body.set("ibge", form.dataset.ibge || state.session.customer.ibge || "");
  if (button) button.disabled = true;
  if (status) status.textContent = "Salvando dados...";
  try {
    const response = await fetch("/api/customer/profile", { method: "POST", body });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Nao foi possivel salvar os dados.");
    setSession(data.account);
    renderAccount();
  } catch (error) {
    if (status) status.textContent = error.message || "Nao foi possivel salvar os dados.";
  } finally {
    if (button) button.disabled = false;
  }
}

function renderOrders() {
  const list = $("#accountOrders");
  if (!isLoggedIn()) {
    list.innerHTML = "<p>Entre para ver seus pedidos.</p>";
    return;
  }
  if (state.privateLoading) {
    list.innerHTML = "<p>Carregando seus pedidos...</p>";
    return;
  }
  list.innerHTML = state.orders.length ? state.orders.map((order) => `
    <article class="account-card order-account-card ${order.status === "awaiting_payment" ? "pending-account-card" : ""}">
      <div class="order-account-main">
        <img src="${orderItemImage(orderPrimaryItem(order))}" alt="${orderPrimaryItem(order).name || "Produto"}">
        <div>
          <strong>${orderPrimaryItem(order).name || order.id}</strong>
          <span>${order.id}</span>
          <small>${orderStatusLabel(order.status)} | ${new Date(order.createdAt).toLocaleString("pt-BR")}</small>
        </div>
        <b>${money(order.total)}</b>
      </div>
      <div class="order-account-facts">
        <span><b>Pagamento</b>${paymentLabel(order)}</span>
        <span><b>Frete</b>${shippingLabel(order)}</span>
        <span><b>Prazo estimado</b>${deliveryWindowLabel(order)}</span>
      </div>
      ${order.status === "awaiting_payment" && order.payment?.checkoutUrl ? `
        <span>${paymentExpiryLabel(order) || "Aguardando confirmação do pagamento"}</span>
        <div class="account-order-actions">
          <a class="primary-button" href="${order.payment.checkoutUrl}">Concluir pagamento</a>
          <button class="ghost-button danger-button" type="button" data-cancel-order="${order.id}">Desistir da compra</button>
        </div>
      ` : ""}
      <details class="order-account-details">
        <summary>Ver detalhes</summary>
        <div class="order-account-detail-grid">
          <span><b>Itens</b>${(order.items || []).map(orderItemLabel).join("<br>")}</span>
          <span><b>Subtotal</b>${money(order.subtotal)}</span>
          <span><b>Desconto</b>${money(order.discount)}</span>
          <span><b>Entrega</b>${money(order.shipping)}</span>
          <span><b>Total</b>${money(order.total)}</span>
          <span><b>Criado em</b>${new Date(order.createdAt).toLocaleString("pt-BR")}</span>
        </div>
        ${canReviewOrder(order) ? `<div class="account-review-list">${(order.items || []).map((item) => reviewFormMarkup(order, item)).join("")}</div>` : ""}
      </details>
    </article>
  `).join("") : "<p>Nenhum pedido encontrado.</p>";
  document.querySelectorAll("[data-cancel-order]").forEach((button) => {
    button.addEventListener("click", () => cancelPendingOrder(button.dataset.cancelOrder, button));
  });
  document.querySelectorAll("[data-review-product]").forEach((form) => {
    form.addEventListener("submit", submitProductReview);
  });
}

async function submitProductReview(event) {
  event.preventDefault();
  if (!isLoggedIn()) return;
  const form = event.currentTarget;
  const status = form.querySelector(".form-status");
  const button = form.querySelector("button[type='submit']");
  const body = new FormData(form);
  body.set("email", state.session.customer.email);
  body.set("orderId", form.dataset.reviewOrder);
  if (button) button.disabled = true;
  if (status) status.textContent = "Enviando avaliação...";
  try {
    const response = await fetch(`/api/customer/products/${encodeURIComponent(form.dataset.reviewProduct)}/reviews`, {
      method: "POST",
      body
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Nao foi possivel enviar a avaliação.");
    form.reset();
    if (status) status.textContent = "Avaliação publicada no produto.";
  } catch (error) {
    if (status) status.textContent = error.message || "Nao foi possivel enviar a avaliação.";
  } finally {
    if (button) button.disabled = false;
  }
}

async function cancelPendingOrder(orderId, button) {
  if (!isLoggedIn() || !orderId) return;
  if (!confirm("Deseja cancelar este pedido pendente?")) return;
  const originalText = button?.textContent || "Desistir da compra";
  if (button) {
    button.disabled = true;
    button.textContent = "Cancelando...";
  }
  try {
    const response = await fetch(`/api/customer/orders/${encodeURIComponent(orderId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: state.session.customer.email,
        action: "cancel_payment"
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Nao foi possivel cancelar este pedido.");
    state.orders = state.orders.map((order) => order.id === orderId ? data.order : order);
    renderAccount();
  } catch (error) {
    alert(error.message || "Nao foi possivel cancelar este pedido.");
    if (button) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}

function renderFavorites() {
  const ids = favoriteIds();
  const favorites = state.products.filter((product) => ids.includes(product.id));
  $("#accountFavorites").innerHTML = favorites.length ? favorites.map((product) => `
    <article class="account-product-card">
      <a href="/produto.html?slug=${product.slug}">
        <img src="${product.image}" alt="${product.name}">
        <strong>${product.name}</strong>
        <span>${money(product.price)}</span>
      </a>
    </article>
  `).join("") : "<p>Nenhum favorito salvo ainda.</p>";
}

function renderRequests() {
  const list = $("#accountQuotes");
  if (!isLoggedIn()) {
    list.innerHTML = "<p>Entre para acompanhar seus orçamentos.</p>";
    return;
  }
  if (state.privateLoading) {
    list.innerHTML = "<p>Carregando suas encomendas...</p>";
    return;
  }
  list.innerHTML = state.requests.length ? state.requests.map((request) => `
    <article class="account-card">
      <div>
        <strong>${request.title}</strong>
        <span>${request.id} | ${requestStatusLabel(request.status)}</span>
      </div>
      <p>${request.idea}</p>
      ${(request.messages || []).slice(-3).map((message) => `<small><b>${message.author === "admin" ? "Basa" : "Você"}:</b> ${message.text}</small>`).join("")}
    </article>
  `).join("") : "<p>Nenhum orçamento enviado ainda.</p>";
}

async function loadProducts() {
  const response = await fetch("/api/products");
  const data = await response.json();
  state.products = response.ok ? data.products || [] : [];
}

async function loadOrders() {
  if (!isLoggedIn()) {
    state.orders = [];
    return;
  }
  const response = await fetch(`/api/customer/orders?email=${encodeURIComponent(state.session.customer.email)}`);
  const data = await response.json();
  state.orders = response.ok ? data.orders || [] : [];
  if (response.ok && data.account) {
    setSession(data.account);
  }
}

async function loadRequests() {
  if (!isLoggedIn()) {
    state.requests = [];
    return;
  }
  const response = await fetch(`/api/custom-requests?email=${encodeURIComponent(state.session.customer.email)}`);
  const data = await response.json();
  state.requests = response.ok ? data.requests || [] : [];
}

async function login(event) {
  event.preventDefault();
  const form = event.currentTarget;
  $("#loginStatus").textContent = "Entrando...";
  const body = {
    email: form.elements.email.value,
    customerPassword: form.elements.customerPassword.value,
    customerUsername: form.elements.email.value.split("@")[0],
    loginOnly: true
  };
  const response = await fetch("/api/customer/access", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok) {
    $("#loginStatus").textContent = data.error || "Não foi possível entrar.";
    return;
  }
  setSession(data.account || data.customer);
  state.session.emailVerified = Boolean((data.account || data.customer)?.emailVerified);
  localStorage.setItem("basa_customer_session", JSON.stringify(state.session));
  await refreshPrivateData();
  $("#loginStatus").textContent = "Login confirmado.";
  showView("profile");
}

async function register(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const displayNameInput = form.elements.displayName || form.elements.customerUsername;
  const normalizedName = normalizeProfileName(displayNameInput?.value);
  const validationError = profileNameError(normalizedName);
  if (validationError) {
    $("#registerStatus").textContent = validationError;
    return;
  }
  if (displayNameInput) displayNameInput.value = normalizedName;
  $("#registerStatus").textContent = "Criando conta...";
  const response = await fetch("/api/customer/access", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(customerFromForm(form))
  });
  const data = await response.json();
  if (!response.ok) {
    $("#registerStatus").textContent = data.error || "Não foi possível criar a conta.";
    return;
  }
  setSession(data.account || data.customer);
  state.session.emailVerified = Boolean((data.account || data.customer)?.emailVerified);
  localStorage.setItem("basa_customer_session", JSON.stringify(state.session));
  await refreshPrivateData();
  $("#registerStatus").textContent = data.emailVerificationRequired ? "Conta criada. Enviamos um link de confirmação para seu e-mail." : data.created ? "Conta criada." : "Login confirmado.";
  if (data.verificationPreviewUrl) {
    $("#registerStatus").innerHTML = `Conta criada. Link de confirmação para teste: <a href="${data.verificationPreviewUrl}">confirmar e-mail</a>`;
  }
  showView("profile");
}

async function requestPasswordReset(event) {
  event.preventDefault();
  const form = event.currentTarget;
  $("#resetRequestStatus").textContent = "Enviando link...";
  const response = await fetch("/api/customer/password-reset/request", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: form.elements.email.value })
  });
  const data = await response.json();
  if (!response.ok) {
    $("#resetRequestStatus").textContent = data.error || "Não foi possível enviar.";
    return;
  }
  $("#resetRequestStatus").textContent = data.message || "Se este e-mail estiver cadastrado, enviaremos um link.";
  if (data.resetPreviewUrl) {
    $("#resetRequestStatus").innerHTML = `Link de recuperação para teste: <a href="${data.resetPreviewUrl}">redefinir senha</a>`;
  }
}

async function resendVerification() {
  if (!isLoggedIn()) return;
  const response = await fetch("/api/customer/resend-verification", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: state.session.customer.email })
  });
  const data = await response.json();
  if (data.verificationPreviewUrl) {
    alert(`Link de confirmação para teste: ${data.verificationPreviewUrl}`);
    return;
  }
  alert("Se o e-mail ainda não estiver confirmado, enviaremos uma nova confirmação.");
}

async function sendQuote(event) {
  event.preventDefault();
  if (!isLoggedIn()) {
    $("#accountQuoteStatus").textContent = "Entre antes de enviar um orçamento.";
    showView("login");
    return;
  }
  const form = event.currentTarget;
  const formData = new FormData(form);
  formData.set("customer", JSON.stringify(state.session.customer));
  $("#accountQuoteStatus").textContent = "Enviando orçamento...";
  const response = await fetch("/api/custom-requests", {
    method: "POST",
    body: formData
  });
  const data = await response.json();
  if (!response.ok) {
    $("#accountQuoteStatus").textContent = data.error || "Não foi possível enviar.";
    return;
  }
  form.reset();
  state.requests = [data.request, ...state.requests];
  renderRequests();
  $("#accountQuoteStatus").textContent = "Orçamento enviado.";
}

async function refreshPrivateData() {
  state.privateLoading = isLoggedIn();
  await Promise.all([loadOrders(), loadRequests()]);
  state.privateLoading = false;
  renderAccount();
}

function logout() {
  state.session = null;
  state.orders = [];
  state.requests = [];
  localStorage.removeItem("basa_customer_session");
  updateAccountMenu();
  renderAccount();
  showView("login");
}

async function init() {
  document.querySelectorAll(".google-login-button").forEach((link) => {
    link.href = googleLoginUrl();
  });
  if (new URLSearchParams(location.search).get("google") === "error") {
    $("#loginStatus").textContent = "Nao foi possivel entrar com Google. Tente novamente.";
  }
  document.querySelectorAll("[data-account-view]").forEach((button) => {
    button.addEventListener("click", () => showView(button.dataset.accountView));
  });
  $("#accountTopbarBackLink")?.addEventListener("click", handleAccountTopbarBack);
  $("#loginForm").addEventListener("submit", login);
  const registerForm = $("#registerForm");
  setupCepLookup(registerForm, "#registerStatus");
  registerForm.addEventListener("submit", register);
  $("#resetRequestForm").addEventListener("submit", requestPasswordReset);
  $("#accountQuoteForm").addEventListener("submit", sendQuote);
  $("#logoutAccountButton").addEventListener("click", logout);
  $("#logoutSidebarButton")?.addEventListener("click", logout);
  const hashView = location.hash.replace("#", "");
  const allowedPrivateViews = ["profile", "orders", "favorites", "quotes"];
  const allowedGuestViews = ["login", "register", "reset"];
  const initialView = isLoggedIn()
    ? (allowedPrivateViews.includes(hashView) ? hashView : "profile")
    : (allowedGuestViews.includes(hashView) ? hashView : "login");
  state.privateLoading = isLoggedIn();
  showView(initialView);
  document.body.classList.remove("account-loading");
  document.body.classList.add("account-ready");
  await loadProducts();
  await refreshPrivateData();
}

init();
