const state = {
  products: [],
  orders: [],
  requests: [],
  session: JSON.parse(localStorage.getItem("basa_customer_session") || "null")
};

const $ = (selector) => document.querySelector(selector);
const money = (value) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(value || 0));

function favoriteKey() {
  return `basa_favorites_${state.session?.customer?.email || "guest"}`;
}

function favoriteIds() {
  return JSON.parse(localStorage.getItem(favoriteKey()) || "[]");
}

function customerFromForm(form) {
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
    customerUsername: form.elements.customerUsername?.value || form.elements.email?.value?.split("@")[0] || "",
    customerPassword: form.elements.customerPassword?.value || ""
  };
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

function showView(view) {
  updateAccountMenu();
  if (!isLoggedIn() && !["login", "register", "reset"].includes(view)) {
    $("#loginStatus").textContent = "Entre ou crie uma conta para acessar esta área.";
    view = "login";
  }
  if (isLoggedIn() && ["login", "register", "reset"].includes(view)) {
    view = "profile";
  }
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
    <article class="account-card">
      <strong>${customer.name || state.session.username}</strong>
      <span>${customer.email}</span>
      <small>@${state.session.username}</small>
    </article>
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
}

function renderOrders() {
  const list = $("#accountOrders");
  if (!isLoggedIn()) {
    list.innerHTML = "<p>Entre para ver seus pedidos.</p>";
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
      </details>
    </article>
  `).join("") : "<p>Nenhum pedido encontrado.</p>";
  document.querySelectorAll("[data-cancel-order]").forEach((button) => {
    button.addEventListener("click", () => cancelPendingOrder(button.dataset.cancelOrder, button));
  });
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
  await Promise.all([loadOrders(), loadRequests()]);
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
  $("#loginForm").addEventListener("submit", login);
  $("#registerForm").addEventListener("submit", register);
  $("#resetRequestForm").addEventListener("submit", requestPasswordReset);
  $("#accountQuoteForm").addEventListener("submit", sendQuote);
  $("#logoutAccountButton").addEventListener("click", logout);
  $("#logoutSidebarButton")?.addEventListener("click", logout);
  await loadProducts();
  await refreshPrivateData();
  const hashView = location.hash.replace("#", "");
  const allowedPrivateViews = ["profile", "orders", "favorites", "quotes"];
  const allowedGuestViews = ["login", "register", "reset"];
  showView(isLoggedIn()
    ? (allowedPrivateViews.includes(hashView) ? hashView : "profile")
    : (allowedGuestViews.includes(hashView) ? hashView : "login"));
}

init();
