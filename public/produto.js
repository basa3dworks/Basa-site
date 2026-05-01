const state = {
  products: [],
  product: null,
  cart: JSON.parse(localStorage.getItem("basa_cart") || "[]"),
  customerSession: JSON.parse(localStorage.getItem("basa_customer_session") || "null"),
  settings: null,
  shippingQuotes: [],
  selectedShipping: null
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

const $ = (selector) => document.querySelector(selector);
const money = (value) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: state.settings?.currency || "BRL" }).format(value);
const shippingQuoteId = (quote) => String(quote?.id ?? `${quote?.carrier || ""}-${quote?.service || ""}`);
const moneyParts = (value) => {
  const [main, cents = "00"] = money(value).split(",");
  return { main, cents };
};
const discountPercent = (product) => {
  if (!product.compareAtPrice || product.compareAtPrice <= product.price) return 0;
  return Math.round((1 - product.price / product.compareAtPrice) * 100);
};
const productPiecesLabel = (product) => {
  const pieces = Number(product.variants?.piecesIncluded || 1);
  return product.variants?.bundleType === "kit" || pieces > 1 ? `Kit com ${pieces} pe\u00e7as` : "1 pe\u00e7a";
};

function soldLabel(count) {
  const sold = Number(count || 0);
  if (!sold) return "";
  return `${sold >= 100 ? "+" : ""}${sold} vendidos`;
}

function productMeta(product) {
  return state.settings?.displaySalesCount ? soldLabel(product.soldCount) : "";
}

function productShippingLabel(product) {
  return product.shipping?.sellerPaysShipping ? "Frete Gr\u00e1tis" : "";
}

function ratingMarkup(product) {
  const average = Number(product.rating?.average || 0);
  const count = Number(product.rating?.count || 0);
  if (!average || !count) return "";
  const proportionalStars = Array.from({ length: 5 }, (_, index) => {
    const fill = Math.max(0, Math.min(100, (average - index) * 100));
    return `<span class="star" style="--fill:${fill}%">&#9733;</span>`;
  }).join("");
  return `<div class="rating-row detail-rating"><span>${average.toFixed(1)}</span><span class="stars" aria-label="${average.toFixed(1)} de 5">${proportionalStars}</span><span>(${count})</span></div>`;
}

function campaignIsRunning(campaign) {
  if (!campaign?.active) return false;
  const now = Date.now();
  const startsAt = campaign.startsAt ? new Date(campaign.startsAt).getTime() : 0;
  const endsAt = campaign.endsAt ? new Date(campaign.endsAt).getTime() : Infinity;
  return now >= startsAt && now <= endsAt;
}

function campaignEndsLabel(campaign) {
  if (!campaign?.endsAt) return "por tempo limitado";
  const remainingMs = new Date(campaign.endsAt).getTime() - Date.now();
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return "terminando agora";
  const hours = Math.floor(remainingMs / 3600000);
  const minutes = Math.floor((remainingMs % 3600000) / 60000);
  return hours > 0 ? `termina em ${hours}h ${minutes}min` : `termina em ${minutes}min`;
}

function detailFlashOffer(product) {
  if (!campaignIsRunning(product.campaign) || product.campaign.type !== "flash") return "";
  return `
    <div class="detail-flash-offer">
      <span>Oferta rel\u00e2mpago</span>
      <strong>${campaignEndsLabel(product.campaign)}</strong>
    </div>
  `;
}

function productShareUrl(product) {
  const baseUrl = String(state.settings?.publicBaseUrl || location.origin).replace(/\/$/, "");
  return `${baseUrl}/produto.html?slug=${encodeURIComponent(product.slug)}`;
}

function productShareText(product) {
  return `Olha esse produto da Basa 3D Works: ${product.name} por ${money(product.price)} - ${productShareUrl(product)}`;
}

function whatsappShareUrl(product) {
  return `https://api.whatsapp.com/send?text=${encodeURIComponent(productShareText(product))}`;
}

function whatsappShareButton(product) {
  return `
    <a class="whatsapp-share-float" href="${whatsappShareUrl(product)}" target="_blank" rel="noopener" data-whatsapp-share="${product.id}" aria-label="Compartilhar ${product.name} no WhatsApp">
      <span class="share-arrow">&#8599;</span>
      <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false">
        <path d="M16.04 4.8c-6.18 0-11.2 4.94-11.2 11.03 0 2.08.6 4.04 1.63 5.7L4.8 27.2l5.86-1.53a11.3 11.3 0 0 0 5.38 1.38c6.18 0 11.2-4.94 11.2-11.03S22.22 4.8 16.04 4.8Zm0 20.36c-1.78 0-3.43-.5-4.84-1.37l-.35-.21-3.47.9.93-3.28-.23-.36a9.05 9.05 0 0 1-1.36-4.74c0-5.05 4.18-9.15 9.32-9.15 5.15 0 9.33 4.1 9.33 9.15 0 5.06-4.18 9.16-9.33 9.16Zm5.1-6.86c-.28-.14-1.66-.8-1.92-.9-.25-.1-.44-.14-.62.13-.18.27-.71.9-.87 1.08-.16.18-.32.2-.6.07-.28-.14-1.18-.43-2.25-1.36-.83-.73-1.39-1.63-1.55-1.9-.16-.28-.02-.43.12-.57.12-.12.28-.32.42-.48.14-.16.18-.27.28-.45.09-.18.05-.34-.03-.48-.07-.14-.62-1.47-.85-2.02-.22-.53-.45-.46-.62-.47h-.53c-.18 0-.48.07-.73.34-.25.27-.96.92-.96 2.25s.99 2.61 1.13 2.8c.14.18 1.95 2.93 4.72 4.1.66.28 1.17.44 1.57.57.66.2 1.27.17 1.75.1.53-.08 1.66-.67 1.9-1.31.23-.65.23-1.2.16-1.32-.07-.12-.25-.18-.53-.32Z"></path>
      </svg>
    </a>
  `;
}

function setupWhatsAppShare(product) {
  document.addEventListener("click", async (event) => {
    const link = event.target.closest("[data-whatsapp-share]");
    if (!link) return;
    link.href = whatsappShareUrl(product);
    if (!navigator.share) return;
    event.preventDefault();
    try {
      await navigator.share({
        title: product.name,
        text: `Olha esse produto da Basa 3D Works: ${product.name} por ${money(product.price)}`,
        url: productShareUrl(product)
      });
    } catch {
      window.open(link.href, "_blank", "noopener");
    }
  });
}

function videoKind(url) {
  return /\.(mp4|webm|ogg)(\?.*)?$/i.test(url || "") ? "file" : "embed";
}

function embedVideoUrl(url, autoplay = false) {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes("youtu.be")) {
      const id = parsed.pathname.replace("/", "");
      const embed = new URL(`https://www.youtube.com/embed/${id}`);
      embed.searchParams.set("rel", "0");
      if (autoplay) {
        embed.searchParams.set("autoplay", "1");
        embed.searchParams.set("mute", "1");
        embed.searchParams.set("playsinline", "1");
      }
      return embed.toString();
    }
    if (parsed.hostname.includes("youtube.com") && parsed.pathname === "/watch") {
      const id = parsed.searchParams.get("v");
      if (id) {
        const embed = new URL(`https://www.youtube.com/embed/${id}`);
        embed.searchParams.set("rel", "0");
        if (autoplay) {
          embed.searchParams.set("autoplay", "1");
          embed.searchParams.set("mute", "1");
          embed.searchParams.set("playsinline", "1");
        }
        return embed.toString();
      }
    }
    if (autoplay) {
      parsed.searchParams.set("autoplay", "1");
      parsed.searchParams.set("mute", "1");
      parsed.searchParams.set("playsinline", "1");
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

function productMediaItems(product) {
  const images = (product.gallery?.length ? product.gallery : [product.image]).filter(Boolean);
  const items = images.map((image, index) => ({ type: "image", src: image, label: `Foto ${index + 1}` }));
  if (product.videoUrl) items.splice(Math.min(1, items.length), 0, { type: "video", src: product.videoUrl, poster: images[0] || product.image, label: "Video" });
  return items;
}

function renderMainMedia(item, product) {
  if (!item) return "";
  if (item.type === "video") {
    if (videoKind(item.src) === "file") {
      return `<video class="product-main-media-item" src="${item.src}" poster="${item.poster || ""}" muted playsinline controls autoplay></video>`;
    }
    return `<iframe class="product-main-media-item" src="${embedVideoUrl(item.src, true)}" title="Video do produto ${product.name}" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen></iframe>`;
  }
  return `<img class="product-main-media-item" src="${item.src}" alt="${product.name}">`;
}

function renderMainMediaFrame(item, product) {
  return `${renderMainMedia(item, product)}${whatsappShareButton(product)}`;
}

function applyTheme(theme) {
  document.body.dataset.theme = theme || "atelier";
}

function saveCart() {
  localStorage.setItem("basa_cart", JSON.stringify(state.cart));
  renderCart();
}

function selectedColor() {
  return $("#productColorSelect")?.value || state.product?.variants?.colors?.[0] || "";
}

function productQuantity() {
  return Math.max(1, Number($("#productQuantityInput")?.value || 1));
}

function addToCart(productId) {
  const color = selectedColor();
  const item = state.cart.find((line) => line.productId === productId && (line.color || "") === color);
  const quantity = productQuantity();
  if (item) item.quantity += quantity;
  else state.cart.push({ productId, color, quantity });
  state.selectedShipping = null;
  state.shippingQuotes = [];
  saveCart();
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
  customerFields(form).forEach((input) => {
    input.readOnly = false;
  });
  form.querySelectorAll("[data-auth-field]").forEach((input) => {
    input.readOnly = false;
    input.value = "";
  });
  applyCustomerSession(form);
  $("#checkoutStatus").textContent = "Dados liberados para alteracao. Salve novamente antes de comprar.";
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
    $("#shippingOptions").innerHTML = "<p>Informe um CEP v\u00e1lido para calcular a entrega.</p>";
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

function renderProduct() {
  const product = state.product;
  const mediaItems = productMediaItems(product);
  const firstMedia = mediaItems[0];
  document.title = `${product.name} | Basa 3D Works`;

  $("#productPage").innerHTML = `
    <section class="product-detail-hero">
      <div class="product-gallery">
        <div class="product-main-media" id="productMainMedia">
          ${renderMainMediaFrame(firstMedia, product)}
        </div>
        <div class="product-thumbs">
          ${mediaItems.map((item, index) => `
            <button class="thumb-button ${item.type === "video" ? "thumb-video" : ""}" data-media-index="${index}" aria-label="${item.label}">
              ${item.type === "video"
                ? `<span class="thumb-video-poster" style="--thumb-poster: url('${item.poster || product.image || ""}')"><b>&#9654;</b><small>V\u00eddeo</small></span>`
                : `<img src="${item.src}" alt="${product.name}">`}
            </button>
          `).join("")}
        </div>
      </div>

      <div class="product-detail-copy">
        <a class="back-link" href="/#produtos">Voltar ao cat\u00e1logo</a>
        <p class="eyebrow">${product.category}</p>
        <div class="product-social-proof detail-social-proof">${productMeta(product)}</div>
        <h1>${product.name}</h1>
        ${ratingMarkup(product)}
        ${detailFlashOffer(product)}
        <p class="lead">${product.longDescription || product.description}</p>
        <div class="detail-price">
          <div class="price-block detail-price-block">
            ${product.compareAtPrice ? `<span class="old-price">${money(product.compareAtPrice)}</span>` : ""}
            <div class="price-line">
              <strong class="price"><span>${moneyParts(product.price).main}</span><sup>${moneyParts(product.price).cents}</sup></strong>
              ${discountPercent(product) ? `<span class="discount-pill">${discountPercent(product)}% OFF</span>` : ""}
            </div>
          </div>
        </div>
        ${productShippingLabel(product) ? `<p class="free-shipping-callout">${productShippingLabel(product)}</p>` : ""}
        ${product.shipping?.freeShippingMinQuantity ? `<p class="free-shipping-callout">Leve ${product.shipping.freeShippingMinQuantity} unidades deste produto e ganhe frete gr\u00e1tis.</p>` : ""}
        <div class="product-options">
          <span>${productPiecesLabel(product)}</span>
          ${product.variants?.colors?.length ? `
            <label>Cor
              <select id="productColorSelect">
                ${product.variants.colors.map((color) => `<option value="${color}">${color}</option>`).join("")}
              </select>
            </label>
          ` : ""}
          <label class="quantity-inline">Quantidade:
            <select id="productQuantityInput" aria-label="Quantidade">
              ${Array.from({ length: Math.max(1, Math.min(Number(product.stock || 1), 20)) }, (_, index) => {
                const quantity = index + 1;
                return `<option value="${quantity}">${quantity} ${quantity === 1 ? "unidade" : "unidades"}</option>`;
              }).join("")}
            </select>
            <small>(+${product.stock} dispon\u00edveis)</small>
          </label>
        </div>
        <div class="hero-actions">
          <button class="primary-button" data-add="${product.id}">Adicionar ao carrinho</button>
          <a class="secondary-link" href="/#produtos">Continuar comprando</a>
        </div>
        <div class="payment-info">
          <strong>Pagamento seguro via Mercado Pago</strong>
          <span>Pix e cart\u00f5es de cr\u00e9dito aceitos no checkout.</span>
          <span>Seus dados de pagamento s\u00e3o processados em ambiente protegido.</span>
        </div>
      </div>
    </section>

    <section class="product-info-grid">
      <article class="panel">
        <div class="panel-head">
          <div>
            <p class="eyebrow">Destaques</p>
            <h2>Por que escolher</h2>
          </div>
        </div>
        <ul class="feature-list">
          ${(product.highlights || []).map((item) => `<li>${item}</li>`).join("")}
        </ul>
      </article>

      <article class="panel">
        <div class="panel-head">
          <div>
            <p class="eyebrow">Especifica\u00e7\u00f5es</p>
            <h2>Detalhes tecnicos</h2>
          </div>
        </div>
        <dl class="spec-list">
          ${Object.entries(product.specs || {}).map(([key, value]) => `<div><dt>${key}</dt><dd>${value}</dd></div>`).join("")}
        </dl>
      </article>
    </section>
  `;

  document.querySelectorAll("[data-add]").forEach((button) => {
    button.addEventListener("click", () => addToCart(button.dataset.add));
  });
  document.querySelectorAll("[data-media-index]").forEach((button) => {
    button.addEventListener("click", () => {
      const item = mediaItems[Number(button.dataset.mediaIndex)];
      $("#productMainMedia").innerHTML = renderMainMediaFrame(item, product);
      document.querySelectorAll("[data-media-index]").forEach((thumb) => thumb.classList.toggle("active", thumb === button));
    });
  });
  document.querySelector("[data-media-index]")?.classList.add("active");
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

async function init() {
  const slug = new URLSearchParams(location.search).get("slug");
  const response = await fetch("/api/products");
  const data = await response.json();
  state.products = data.products;
  state.settings = data.settings;
  applyTheme(data.settings.theme);
  state.product = state.products.find((product) => product.slug === slug || product.id === slug);

  $("#cartButton").addEventListener("click", () => {
    $("#cartPanel").classList.add("open");
    autoQuoteShippingIfPossible();
  });
  $("#closeCart").addEventListener("click", () => $("#cartPanel").classList.remove("open"));
  $("#checkoutForm").addEventListener("submit", checkout);
  setupCheckoutDetails($("#checkoutForm"));
  $("#saveCustomerButton").addEventListener("click", () => saveCustomerSession($("#checkoutForm")));
  $("#debugCustomerButton").addEventListener("click", () => useDebugCustomer($("#checkoutForm")));
  $("#logoutCustomerButton").addEventListener("click", () => logoutCustomer($("#checkoutForm")));
  setupCepLookup($("#checkoutForm"));
  $("#checkoutForm").elements.coupon.addEventListener("input", () => {
    if (state.shippingQuotes.length) renderShippingOptions();
    renderCart();
  });

  if (!state.product) {
    $("#productPage").innerHTML = `
      <section class="product-loading">
        <p class="eyebrow">Produto n\u00e3o encontrado</p>
        <h1>N\u00e3o encontramos este item</h1>
        <a class="primary-link" href="/#produtos">Voltar ao cat\u00e1logo</a>
      </section>
    `;
    renderCart();
    return;
  }

  setupWhatsAppShare(state.product);
  renderProduct();
  applyCustomerSession($("#checkoutForm"));
  renderCart();
  autoQuoteShippingIfPossible();
}

init();
