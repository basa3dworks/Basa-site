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

function setSession(account) {
  state.session = {
    loggedIn: true,
    username: account.username,
    customer: account.customer,
    updatedAt: new Date().toISOString()
  };
  localStorage.setItem("basa_customer_session", JSON.stringify(state.session));
}

function isLoggedIn() {
  return Boolean(state.session?.loggedIn && state.session?.customer?.email);
}

function showView(view) {
  document.querySelectorAll("[data-account-panel]").forEach((panel) => {
    panel.hidden = panel.dataset.accountPanel !== view;
    panel.classList.toggle("active", panel.dataset.accountPanel === view);
  });
  document.querySelectorAll("[data-account-view]").forEach((button) => {
    button.classList.toggle("active", button.dataset.accountView === view);
  });
  if (["profile", "orders", "favorites", "quotes"].includes(view) && !isLoggedIn()) {
    $("#loginStatus").textContent = "Entre ou crie uma conta para acessar esta área.";
    showView("login");
    return;
  }
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
  $("#accountSummary").innerHTML = isLoggedIn() ? `
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
}

function renderOrders() {
  const list = $("#accountOrders");
  if (!isLoggedIn()) {
    list.innerHTML = "<p>Entre para ver seus pedidos.</p>";
    return;
  }
  list.innerHTML = state.orders.length ? state.orders.map((order) => `
    <article class="account-card">
      <div>
        <strong>${order.id}</strong>
        <span>${orderStatusLabel(order.status)} | ${new Date(order.createdAt).toLocaleString("pt-BR")}</span>
      </div>
      <small>${(order.items || []).map((item) => `${item.quantity}x ${item.name}`).join(", ")}</small>
      <b>${money(order.total)}</b>
    </article>
  `).join("") : "<p>Nenhum pedido encontrado.</p>";
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
  setSession(data.account);
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
  setSession(data.account);
  await refreshPrivateData();
  $("#registerStatus").textContent = data.created ? "Conta criada." : "Login confirmado.";
  showView("profile");
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
  renderAccount();
  showView("login");
}

async function init() {
  document.querySelectorAll("[data-account-view]").forEach((button) => {
    button.addEventListener("click", () => showView(button.dataset.accountView));
  });
  $("#loginForm").addEventListener("submit", login);
  $("#registerForm").addEventListener("submit", register);
  $("#accountQuoteForm").addEventListener("submit", sendQuote);
  $("#logoutAccountButton").addEventListener("click", logout);
  await loadProducts();
  await refreshPrivateData();
  showView(isLoggedIn() ? "profile" : "login");
}

init();
