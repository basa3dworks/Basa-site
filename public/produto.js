const state = {
  products: [],
  product: null,
  cart: JSON.parse(localStorage.getItem("basa_cart") || "[]"),
  customerSession: JSON.parse(localStorage.getItem("basa_customer_session") || "null"),
  settings: null,
  pendingOrders: [],
  shippingQuotes: [],
  selectedShipping: null,
  shippingBenefit: null,
  checkoutSubmitting: false,
  lightboxMediaItems: [],
  lightboxProduct: null,
  lightboxReady: false,
  reviewLightboxGroups: {},
  relatedProducts: [],
  relatedVisible: 8,
  relatedObserver: null,
  productNavObserver: null
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

const $ = (selector) => document.querySelector(selector);
const FREE_SHIPPING_MIN_SUBTOTAL = 100;
const RELATED_ORIGIN_KEY = "basa_related_origin";
const SUPPORT_CHAT_KEY = "basa_support_chat";
const DELIVERY_ADDRESSES_KEY = "basa_delivery_addresses";
const SELECTED_DELIVERY_ADDRESS_KEY = "basa_selected_delivery_address";

function protectAppSurface() {
  const editableSelector = "input, textarea, select, option, [contenteditable='true']";
  document.addEventListener("contextmenu", (event) => {
    if (!event.target.closest(editableSelector)) event.preventDefault();
  });
  document.addEventListener("dragstart", (event) => {
    if (!event.target.closest(editableSelector)) event.preventDefault();
  });
}

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
const productStockLabel = (product) => {
  const stock = Math.max(0, Number(product.stock || 0));
  return `${stock} ${stock === 1 ? "unidade dispon\u00edvel" : "unidades dispon\u00edveis"}`;
};
const colorName = (color) => typeof color === "string" ? color : color?.name || "";
const colorHex = (color) => {
  const hex = typeof color === "object" ? color?.hex : "";
  return /^#[0-9a-fA-F]{6}$/.test(hex || "") ? hex : "#ffffff";
};
const escapeHtml = (value) => String(value || "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#039;");

function customerProfileLabel(customer = {}) {
  return customer.displayName || customer.customerUsername || customer.name || "Cliente Basa";
}

function topbarAddressLabel(address = {}) {
  return [address.street, address.number].filter(Boolean).join(", ");
}

function selectedDeliveryAddress() {
  try {
    const address = JSON.parse(localStorage.getItem(SELECTED_DELIVERY_ADDRESS_KEY) || "null");
    return address?.zipCode ? address : null;
  } catch {
    return null;
  }
}

function updateTopbarCustomerRow() {
  const row = $("#topbarCustomerRow");
  if (!row) return;
  const customer = state.customerSession?.customer || {};
  const logged = Boolean(state.customerSession?.loggedIn && customer.email);
  const address = selectedDeliveryAddress() || customer;
  const addressLabel = topbarAddressLabel(address);
  row.hidden = !logged;
  document.body.classList.toggle("topbar-profile-visible", logged);
  if (!logged) return;
  $("#topbarCustomerName").innerHTML = `Olá ${escapeHtml(customerProfileLabel(customer))}${customer.profileVerified ? ' <span class="profile-verified topbar-verified" title="Perfil verificado" aria-label="Perfil verificado"></span>' : ""}`;
  $("#topbarCustomerAddress").textContent = addressLabel || "Endereço não cadastrado";
}

function lockProductHorizontalScroll() {
  const html = document.documentElement;
  const body = document.body;
  const hasHorizontalOffset = window.scrollX || html.scrollLeft || body.scrollLeft;
  if (!hasHorizontalOffset) return;
  window.requestAnimationFrame(() => {
    html.scrollLeft = 0;
    body.scrollLeft = 0;
    window.scrollTo(0, window.scrollY);
  });
}

function isAllowedHorizontalTarget(target) {
  return Boolean(target?.closest?.(".product-thumbs, .mobile-category-tabs, .mobile-interest-chips"));
}

function preventProductHorizontalPan() {
  let startX = 0;
  let startY = 0;
  const start = (event) => {
    const touch = event.touches[0];
    if (!touch) return;
    startX = touch.clientX;
    startY = touch.clientY;
  };
  const move = (event) => {
    const touch = event.touches[0];
    if (!touch || isAllowedHorizontalTarget(event.target)) return;
    const deltaX = touch.clientX - startX;
    const deltaY = touch.clientY - startY;
    if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > 6) {
      event.preventDefault();
      lockProductHorizontalScroll();
    }
  };
  window.addEventListener("touchstart", start, { passive: true, capture: true });
  window.addEventListener("touchmove", move, { passive: false, capture: true });
  window.addEventListener("pointermove", (event) => {
    if (event.pointerType !== "touch" || isAllowedHorizontalTarget(event.target)) return;
    if (Math.abs(event.movementX || 0) > Math.abs(event.movementY || 0)) {
      lockProductHorizontalScroll();
    }
  }, { passive: true, capture: true });
}

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

function shippingLogoAlt(quote) {
  return quote.methodCode === "correios-sedex" ? "Correios Sedex" : "J&T Express";
}

function shippingLogoMarkup(quote) {
  if (!quote.logo) return "";
  return `<span class="shipping-option-logo"><img src="${quote.logo}" alt="${shippingLogoAlt(quote)}"></span>`;
}

function productImage(product) {
  return product.image || (product.gallery || [])[0] || "";
}

function ratingMarkup(product, extraClass = "") {
  const average = Number(product.rating?.average || 0);
  const count = Number(product.rating?.count || 0);
  if (!average || !count) return "";
  const proportionalStars = Array.from({ length: 5 }, (_, index) => {
    const fill = Math.max(0, Math.min(100, (average - index) * 100));
    return `<span class="star" style="--fill:${fill}%">&#9733;</span>`;
  }).join("");
  const className = `rating-row ${extraClass}`.trim();
  return `<div class="${className}"><span>${average.toFixed(1)}</span><span class="stars" aria-label="${average.toFixed(1)} de 5">${proportionalStars}</span><span>(${count})</span></div>`;
}

function reviewAvatarMarkup(review) {
  const name = review.customerName || "Cliente Basa";
  const initial = escapeHtml(name.trim().charAt(0).toUpperCase() || "B");
  return review.customerAvatar
    ? `<img class="review-avatar" src="${review.customerAvatar}" alt="${escapeHtml(name)}">`
    : `<span class="review-avatar" aria-hidden="true">${initial}</span>`;
}

function reviewVerifiedBadge(review) {
  return review.profileVerified ? `<span class="profile-verified review-verified" title="Perfil verificado" aria-label="Perfil verificado"></span>` : "";
}

function reviewMediaItems(review) {
  return (review.media || review.photos || [])
    .map((item, index) => {
      const url = typeof item === "string" ? item : item?.url;
      if (!url) return null;
      return {
        type: /\.(mp4|webm|mov|m4v)$/i.test(String(url).split("?")[0]) ? "video" : "image",
        src: url,
        label: `Mídia ${index + 1}`
      };
    })
    .filter(Boolean);
}

function socialReviewsSection(product) {
  const reviews = product.publicReviews || [];
  state.reviewLightboxGroups = {};
  const renderMedia = (review) => {
    const media = reviewMediaItems(review);
    if (!media.length) return "";
    const groupId = review.id || `review-${Object.keys(state.reviewLightboxGroups).length}`;
    state.reviewLightboxGroups[groupId] = media;
    return `<div class="product-review-photos">${media.map((item, index) => {
      const label = `${review.customerName || "Cliente Basa"} - ${item.label}`;
      return item.type === "video"
        ? `<button class="product-review-media-thumb" type="button" data-review-media-group="${escapeHtml(groupId)}" data-review-media-index="${index}" aria-label="Abrir vídeo do comentário"><video src="${item.src}" muted playsinline preload="metadata"></video><span class="review-media-play" aria-hidden="true">▶</span></button>`
        : `<button class="product-review-media-thumb" type="button" data-review-media-group="${escapeHtml(groupId)}" data-review-media-index="${index}" aria-label="Abrir foto do comentário"><img src="${item.src}" alt="${escapeHtml(label)}"></button>`;
    }).join("")}</div>`;
  };
  return `
    <section class="panel product-reviews-panel" id="productCommentsSection" data-product-section="comments">
      <div class="panel-head">
        <div>
          <p class="eyebrow">Coment\u00e1rios</p>
          <h2>Quem comprou conta</h2>
        </div>
      </div>
      ${reviews.length ? `
        <div class="product-review-list">
          ${reviews.slice(0, 8).map((review) => `
          <article class="product-review-card">
            <div class="product-review-head">
              <div class="product-review-author">
                ${reviewAvatarMarkup(review)}
                <strong>${escapeHtml(review.customerName || "Cliente Basa")} ${reviewVerifiedBadge(review)}</strong>
              </div>
              ${review.rating ? `<span>${Number(review.rating).toFixed(1)} ★</span>` : ""}
            </div>
            ${review.comment ? `<p>${escapeHtml(review.comment)}</p>` : ""}
            ${renderMedia(review)}
          </article>
          `).join("")}
        </div>
      ` : `<p class="product-empty-note">Ainda n\u00e3o h\u00e1 coment\u00e1rios deste produto.</p>`}
    </section>
  `;
}

function normalizeTerm(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function productTerms(product) {
  const specs = product.specs || {};
  const values = [
    product.category,
    product.name,
    product.description,
    product.longDescription,
    ...(product.tags || []),
    ...(product.highlights || []),
    ...Object.keys(specs),
    ...Object.values(specs)
  ];
  return new Set(normalizeTerm(values.join(" "))
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 2 && !["para", "com", "uma", "das", "dos", "que", "por", "sem", "produto", "produtos"].includes(term)));
}

function relatedScore(baseProduct, candidate) {
  if (!candidate || candidate.id === baseProduct.id) return -1;
  let score = 0;
  if (normalizeTerm(candidate.category) === normalizeTerm(baseProduct.category)) score += 60;
  const baseTags = new Set((baseProduct.tags || []).map(normalizeTerm).filter(Boolean));
  (candidate.tags || []).forEach((tag) => {
    if (baseTags.has(normalizeTerm(tag))) score += 28;
  });
  const baseTerms = productTerms(baseProduct);
  productTerms(candidate).forEach((term) => {
    if (baseTerms.has(term)) score += 4;
  });
  score += Math.min(16, Number(candidate.soldCount || 0) / 3);
  score += Math.min(10, Number(candidate.favoriteCount || 0));
  score += Number(candidate.rating?.average || 0) * 2;
  return score;
}

function relatedProducts(product) {
  const ranked = state.products
    .filter((candidate) => candidate.id !== product.id && candidate.status !== "inactive")
    .map((candidate) => ({ product: candidate, score: relatedScore(product, candidate) }))
    .sort((a, b) => b.score - a.score || Number(b.product.soldCount || 0) - Number(a.product.soldCount || 0));
  const relevant = ranked.filter((item) => item.score > 0).map((item) => item.product);
  const fallback = ranked.filter((item) => item.score <= 0).map((item) => item.product);
  return [...relevant, ...fallback];
}

function relatedProductCard(product) {
  const url = `/produto.html?slug=${encodeURIComponent(product.slug || product.id)}`;
  return `
    <article class="related-product-card">
      <a href="${url}" data-related-link>
        <img src="${productImage(product)}" alt="${escapeHtml(product.name)}">
        <span class="related-product-category">${escapeHtml(product.category || "Produto")}</span>
        <strong>${escapeHtml(product.name)}</strong>
        ${ratingMarkup(product, "related-rating")}
        <span class="related-product-price">${money(product.price)}</span>
        ${productShippingLabel(product) ? `<em>${productShippingLabel(product)}</em>` : ""}
      </a>
    </article>
  `;
}

function relatedProductsSection(product) {
  state.relatedProducts = relatedProducts(product);
  state.relatedVisible = Math.min(8, Math.max(0, state.relatedProducts.length));
  return `
    <section class="panel product-related-panel" id="productRelatedSection" data-product-section="related">
      <div class="panel-head">
        <div>
          <h2>Relacionados</h2>
        </div>
      </div>
      <div class="related-product-grid" id="relatedProductGrid"></div>
      <div class="related-sentinel" id="relatedSentinel" aria-hidden="true"></div>
    </section>
  `;
}

function renderRelatedProducts() {
  const grid = $("#relatedProductGrid");
  if (!grid) return;
  const products = state.relatedProducts.slice(0, state.relatedVisible);
  const columns = products.reduce((acc, product, index) => {
    acc[index % 2].push(relatedProductCard(product));
    return acc;
  }, [[], []]);
  grid.innerHTML = products.length
    ? columns.map((items) => `<div class="related-product-grid-column">${items.join("")}</div>`).join("")
    : `<p class="product-empty-note">Ainda n\u00e3o h\u00e1 produtos relacionados cadastrados.</p>`;
}

function setupRelatedInfiniteScroll() {
  state.relatedObserver?.disconnect();
  const sentinel = $("#relatedSentinel");
  if (!sentinel || state.relatedProducts.length <= state.relatedVisible) return;
  state.relatedObserver = new IntersectionObserver((entries) => {
    if (!entries.some((entry) => entry.isIntersecting)) return;
    state.relatedVisible = Math.min(state.relatedVisible + 8, state.relatedProducts.length);
    renderRelatedProducts();
    if (state.relatedVisible >= state.relatedProducts.length) state.relatedObserver?.disconnect();
  }, { rootMargin: "420px 0px" });
  state.relatedObserver.observe(sentinel);
}

function productStickyNav(product) {
  const origin = JSON.parse(sessionStorage.getItem(RELATED_ORIGIN_KEY) || "null");
  const backHref = origin?.slug && origin.slug !== product.slug ? `/produto.html?slug=${encodeURIComponent(origin.slug)}` : "/#produtos";
  const backLabel = origin?.slug && origin.slug !== product.slug ? "Voltar ao produto inicial" : "Voltar para a loja";
  return `
    <nav class="product-sticky-nav" id="productStickyNav" aria-label="Navega\u00e7\u00e3o do produto">
      <div class="product-sticky-row">
        <a class="product-sticky-icon" href="${backHref}" aria-label="${backLabel}">&#8249;</a>
        <strong>${escapeHtml(product.name)}</strong>
        <button class="product-sticky-icon" type="button" data-share-product aria-label="Compartilhar produto">&#8599;</button>
      </div>
      <div class="product-sticky-tabs">
        <button type="button" class="active" data-product-tab="intro">In\u00edcio</button>
        <button type="button" data-product-tab="comments">Coment\u00e1rios</button>
        <button type="button" data-product-tab="related">Relacionados</button>
      </div>
    </nav>
  `;
}

function setProductTab(tab) {
  document.querySelectorAll("[data-product-tab]").forEach((button) => {
    button.classList.toggle("active", button.dataset.productTab === tab);
  });
}

function setupProductStickyNav(product) {
  state.productNavObserver?.disconnect();
  const nav = $("#productStickyNav");
  const intro = $("#productIntroSection");
  if (!nav || !intro) return;
  const topbar = document.querySelector(".topbar");
  if (document.body.classList.contains("store-body") && nav.parentElement !== document.body) {
    document.body.appendChild(nav);
  }
  const updateStickyTop = () => {
    const topbarHeight = topbar?.getBoundingClientRect().height || 0;
    document.documentElement.style.setProperty("--product-sticky-top", `${Math.round(topbarHeight)}px`);
    return topbarHeight;
  };
  const stickyOffset = () => {
    const topbarHeight = updateStickyTop();
    const navHeight = nav.getBoundingClientRect().height || 44;
    return topbarHeight + navHeight + 10;
  };
  const updateNavVisibility = () => {
    const introBottom = intro.getBoundingClientRect().bottom;
    const topbarHeight = updateStickyTop();
    nav.classList.toggle("is-visible", introBottom <= topbarHeight + 18);
  };
  const updateActiveTab = () => {
    const marker = stickyOffset() + 20;
    let active = "intro";
    document.querySelectorAll("[data-product-section]").forEach((section) => {
      if (section.getBoundingClientRect().top <= marker) active = section.dataset.productSection;
    });
    setProductTab(active);
  };
  const updateNavState = () => {
    updateNavVisibility();
    updateActiveTab();
  };
  updateNavState();
  window.addEventListener("scroll", updateNavState, { passive: true });
  window.addEventListener("resize", updateNavState);
  document.querySelectorAll("[data-product-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      const section = $(`[data-product-section="${button.dataset.productTab}"]`);
      if (!section) return;
      setProductTab(button.dataset.productTab);
      const targetTop = window.scrollY + section.getBoundingClientRect().top - stickyOffset();
      window.scrollTo({ top: Math.max(0, targetTop), behavior: "smooth" });
    });
  });
  document.querySelectorAll("[data-related-link]").forEach((link) => {
    link.addEventListener("click", () => {
      const currentOrigin = JSON.parse(sessionStorage.getItem(RELATED_ORIGIN_KEY) || "null");
      if (!currentOrigin?.slug) {
        sessionStorage.setItem(RELATED_ORIGIN_KEY, JSON.stringify({ slug: product.slug || product.id, name: product.name }));
      }
    });
  });
  nav.querySelector("[data-share-product]")?.addEventListener("click", async () => {
    if (navigator.share) {
      try {
        await navigator.share({ title: product.name, text: product.description || product.name, url: productShareUrl(product) });
        return;
      } catch {}
    }
    navigator.clipboard?.writeText(productShareUrl(product));
  });
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

function mediaLightboxMarkup(mediaItems, product) {
  return `
    <div class="media-lightbox" id="mediaLightbox" hidden aria-modal="true" role="dialog" aria-label="Imagem ampliada do produto">
      <button class="media-lightbox-close" type="button" data-lightbox-close aria-label="Fechar imagem ampliada">×</button>
      <button class="media-lightbox-nav media-lightbox-prev" type="button" data-lightbox-prev aria-label="Imagem anterior">‹</button>
      <div class="media-lightbox-stage" id="mediaLightboxStage"></div>
      <button class="media-lightbox-nav media-lightbox-next" type="button" data-lightbox-next aria-label="Próxima imagem">›</button>
      <div class="media-lightbox-count" id="mediaLightboxCount">${mediaItems.length ? `1 / ${mediaItems.length}` : ""}</div>
    </div>
  `;
}

function renderLightboxMedia(item, product) {
  if (!item) return "";
  if (item.type === "video") {
    if (videoKind(item.src) === "file") {
      return `<video class="media-lightbox-item" src="${item.src}" poster="${item.poster || ""}" controls autoplay playsinline></video>`;
    }
    return `<iframe class="media-lightbox-item" src="${embedVideoUrl(item.src, true)}" title="Video do produto ${product.name}" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen></iframe>`;
  }
  return `<img class="media-lightbox-item" src="${item.src}" alt="${product.name}">`;
}

function setupMediaLightbox(mediaItems, product) {
  const lightbox = $("#mediaLightbox");
  if (!lightbox) return;
  state.lightboxMediaItems = mediaItems;
  state.lightboxProduct = product;
  if (state.lightboxReady) return;
  state.lightboxReady = true;
  let activeIndex = 0;
  const show = (index) => {
    const items = state.lightboxMediaItems || [];
    if (!items.length) return;
    activeIndex = (index + items.length) % items.length;
    $("#mediaLightboxStage").innerHTML = renderLightboxMedia(items[activeIndex], state.lightboxProduct);
    $("#mediaLightboxCount").textContent = `${activeIndex + 1} / ${items.length}`;
  };
  const open = (index) => {
    show(index);
    lightbox.hidden = false;
    document.body.classList.add("lightbox-open");
    lightbox.querySelector("[data-lightbox-close]")?.focus();
  };
  const close = () => {
    lightbox.hidden = true;
    document.body.classList.remove("lightbox-open");
    $("#mediaLightboxStage").innerHTML = "";
  };

  document.addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-media-expand]");
    if (!button) return;
    state.lightboxMediaItems = productMediaItems(state.product || state.lightboxProduct || {});
    state.lightboxProduct = state.product || state.lightboxProduct;
    open(Number(button.dataset.mediaExpand || 0));
  });
  document.addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-review-media-group]");
    if (!button) return;
    const group = state.reviewLightboxGroups?.[button.dataset.reviewMediaGroup] || [];
    if (!group.length) return;
    state.lightboxMediaItems = group;
    state.lightboxProduct = { name: "Comentário de cliente" };
    open(Number(button.dataset.reviewMediaIndex || 0));
  });
  lightbox.querySelector("[data-lightbox-close]")?.addEventListener("click", close);
  lightbox.querySelector("[data-lightbox-prev]")?.addEventListener("click", () => show(activeIndex - 1));
  lightbox.querySelector("[data-lightbox-next]")?.addEventListener("click", () => show(activeIndex + 1));
  lightbox.addEventListener("click", (event) => {
    if (event.target === lightbox) close();
  });
  document.addEventListener("keydown", (event) => {
    if (lightbox.hidden) return;
    if (event.key === "Escape") close();
    if (event.key === "ArrowLeft") show(activeIndex - 1);
    if (event.key === "ArrowRight") show(activeIndex + 1);
  });
}

function applyTheme(theme) {
  document.body.dataset.theme = theme || "atelier";
}

function saveCart() {
  localStorage.setItem("basa_cart", JSON.stringify(state.cart));
  renderCart();
}

function selectedColor() {
  const checked = document.querySelector('input[name="productColor"]:checked');
  return checked?.value || colorName(state.product?.variants?.colors?.[0]) || "";
}

function productQuantity() {
  return Math.max(1, Number($("#productQuantityInput")?.value || 1));
}

function resetShippingCalculation() {
  state.selectedShipping = null;
  state.shippingQuotes = [];
  state.shippingBenefit = null;
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
  await refreshSupportChat(true);
}

function closeSupportPanel() {
  $("#supportPanel").classList.remove("open");
  $("#supportPanel").setAttribute("aria-hidden", "true");
}

function supportChatState() {
  return JSON.parse(localStorage.getItem(SUPPORT_CHAT_KEY) || "null");
}

function saveSupportChatState(chat) {
  localStorage.setItem(SUPPORT_CHAT_KEY, JSON.stringify(chat));
}

function updateSupportIdentityFields() {
  const known = Boolean(state.customerSession?.customer?.email || supportChatState()?.email);
  document.querySelectorAll("[data-support-identity]").forEach((field) => {
    field.hidden = known;
  });
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
  const customerEmail = state.customerSession?.customer?.email || "";
  const chat = supportChatState() || (customerEmail ? { email: customerEmail, seenAdminCount: 0 } : null);
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

function addToCart(productId) {
  const color = selectedColor();
  const item = state.cart.find((line) => line.productId === productId && (line.color || "") === color);
  const quantity = productQuantity();
  if (item) item.quantity += quantity;
  else state.cart.push({ productId, color, quantity });
  resetShippingCalculation();
  saveCart();
  $("#cartPanel").classList.add("open");
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
  const main = document.querySelector("main");
  if (!main) return;
  main.prepend(banner);
  banner.querySelector("[data-pending-snooze]")?.addEventListener("click", () => snoozePendingPayment(order.id));
  banner.querySelector("[data-pending-close]")?.addEventListener("click", () => snoozePendingPayment(order.id));
  banner.querySelector("[data-pending-view-orders]")?.addEventListener("click", () => {
    localStorage.setItem(pendingPaymentDismissKey(order.id), String(Date.now() + 6 * 3600000));
  });
}

function customerFields(form) {
  return [...form.querySelectorAll("[data-customer-field]")];
}

function deliveryAddressFromForm(form) {
  const value = (name) => String(form.elements[name]?.value || "").trim();
  return {
    zipCode: value("zipCode").replace(/\D/g, ""),
    street: value("street"),
    number: value("number"),
    neighborhood: value("neighborhood"),
    complement: value("complement"),
    city: value("city"),
    state: value("state").toUpperCase(),
    ibge: form.dataset.ibge || ""
  };
}

function deliveryAddressKey(address = {}) {
  return [address.zipCode, address.number, address.complement].map((value) => String(value || "").trim().toLowerCase()).join("|");
}

function accountDeliveryAddress() {
  const customer = state.customerSession?.customer || {};
  const zipCode = String(customer.zipCode || "").replace(/\D/g, "");
  if (zipCode.length !== 8 || !customer.number) return null;
  return {
    zipCode,
    street: customer.street || "",
    number: customer.number || "",
    neighborhood: customer.neighborhood || "",
    complement: customer.complement || "",
    city: customer.city || "",
    state: String(customer.state || "").toUpperCase(),
    ibge: customer.ibge || "",
    principal: true
  };
}

function deliveryAddressLines(address = {}) {
  const zip = String(address.zipCode || "").replace(/\D/g, "");
  const lineOne = [address.street, address.number].filter(Boolean).join(", ");
  const lineTwo = [address.neighborhood, address.city && address.state ? `${address.city}/${address.state}` : address.city || address.state].filter(Boolean).join(" - ");
  const complement = address.complement ? `Complemento: ${address.complement}` : "";
  const zipLine = zip.length === 8 ? `CEP ${zip.replace(/^(\d{5})(\d{3})$/, "$1-$2")}` : "";
  return [lineOne, lineTwo, complement, zipLine].filter(Boolean);
}

function loadDeliveryAddresses() {
  try {
    return JSON.parse(localStorage.getItem(DELIVERY_ADDRESSES_KEY) || "[]").filter((address) => address?.zipCode);
  } catch {
    return [];
  }
}

function saveDeliveryAddresses(addresses) {
  localStorage.setItem(DELIVERY_ADDRESSES_KEY, JSON.stringify(addresses.slice(0, 3)));
}

function deliveryAddressExists(address) {
  const key = deliveryAddressKey(address);
  const principal = accountDeliveryAddress();
  return (principal && deliveryAddressKey(principal) === key) || loadDeliveryAddresses().some((item) => deliveryAddressKey(item) === key);
}

function canSaveDeliveryAddress(form) {
  const address = deliveryAddressFromForm(form);
  return form.dataset.addressMode === "manual" && address.zipCode.length === 8 && Boolean(address.number) && Boolean(address.complement) && !deliveryAddressExists(address);
}

function updateDeliveryAddressControls(form) {
  const manual = form.dataset.addressMode !== "saved";
  const addressForm = form.querySelector("[data-address-form]");
  const newButton = form.querySelector("[data-new-address]");
  const saveButton = form.querySelector("[data-save-address]");
  const savedLimitReached = loadDeliveryAddresses().length >= 3;
  if (addressForm) addressForm.hidden = !manual;
  if (newButton) newButton.hidden = manual || savedLimitReached;
  if (saveButton) saveButton.hidden = !canSaveDeliveryAddress(form);
}

function setDeliveryAddress(form, address = {}) {
  ["zipCode", "street", "number", "neighborhood", "complement", "city", "state"].forEach((name) => {
    if (form.elements[name]) form.elements[name].value = address[name] || "";
  });
  form.dataset.ibge = address.ibge || "";
  form.dataset.addressMode = "saved";
  localStorage.setItem(SELECTED_DELIVERY_ADDRESS_KEY, JSON.stringify(address));
  resetShippingCalculation();
  $("#shippingOptions").innerHTML = "<p>Calcule a entrega novamente após alterar o endereço.</p>";
  updateCheckoutAddressSummary(form);
  renderDeliveryAddressBook(form);
  updateDeliveryAddressControls(form);
  updateTopbarCustomerRow();
  if (String(address.zipCode || "").replace(/\D/g, "").length === 8 && state.cart.length) quoteShipping();
}

function startManualDeliveryAddress(form) {
  ["zipCode", "street", "number", "neighborhood", "complement", "city", "state"].forEach((name) => {
    if (form.elements[name]) form.elements[name].value = "";
  });
  form.dataset.ibge = "";
  form.dataset.addressMode = "manual";
  localStorage.removeItem(SELECTED_DELIVERY_ADDRESS_KEY);
  resetShippingCalculation();
  $("#shippingOptions").innerHTML = "<p>Informe o CEP para calcular as opções de entrega.</p>";
  updateCheckoutAddressSummary(form);
  renderDeliveryAddressBook(form);
  updateDeliveryAddressControls(form);
  updateTopbarCustomerRow();
}

function maybeSeedCustomerAddress(form) {
  const address = accountDeliveryAddress();
  if (!address) return;
  const formAddress = deliveryAddressFromForm(form);
  if (!formAddress.zipCode || deliveryAddressKey(formAddress) === "||") setDeliveryAddress(form, address);
}

function renderDeliveryAddressBook(form) {
  const book = form?.querySelector("[data-address-book]");
  if (!book) return;
  const principal = accountDeliveryAddress();
  const savedAddresses = loadDeliveryAddresses().filter((address) => !principal || deliveryAddressKey(address) !== deliveryAddressKey(principal));
  const addresses = principal ? [principal, ...savedAddresses] : savedAddresses;
  const currentKey = deliveryAddressKey(deliveryAddressFromForm(form));
  book.hidden = !addresses.length;
  book.innerHTML = addresses.map((address, index) => {
    const active = deliveryAddressKey(address) === currentKey;
    const savedIndex = address.principal ? "" : loadDeliveryAddresses().findIndex((item) => deliveryAddressKey(item) === deliveryAddressKey(address));
    return `
      <article class="checkout-address-card ${active ? "active" : ""}">
        <strong>${address.principal ? "Destino principal" : active ? "Destino atual" : `Endereço ${index + 1}`}</strong>
        ${deliveryAddressLines(address).map((line) => `<span>${escapeHtml(line)}</span>`).join("")}
        <div class="checkout-address-card-actions">
          <button class="ghost-button" type="button" data-use-address="${index}">Usar este endereço</button>
          ${address.principal ? "" : `<button class="ghost-button" type="button" data-remove-address="${savedIndex}">Remover</button>`}
        </div>
      </article>
    `;
  }).join("");
  book.querySelectorAll("[data-use-address]").forEach((button) => {
    button.addEventListener("click", () => setDeliveryAddress(form, addresses[Number(button.dataset.useAddress)]));
  });
  book.querySelectorAll("[data-remove-address]").forEach((button) => {
    button.addEventListener("click", () => {
      const next = loadDeliveryAddresses().filter((_, index) => index !== Number(button.dataset.removeAddress));
      saveDeliveryAddresses(next);
      const selected = selectedDeliveryAddress();
      const principal = accountDeliveryAddress();
      const selectedStillExists = selected && ((principal && deliveryAddressKey(principal) === deliveryAddressKey(selected)) || next.some((address) => deliveryAddressKey(address) === deliveryAddressKey(selected)));
      if (selected && !selectedStillExists) {
        localStorage.removeItem(SELECTED_DELIVERY_ADDRESS_KEY);
        updateTopbarCustomerRow();
      }
      renderDeliveryAddressBook(form);
      updateDeliveryAddressControls(form);
    });
  });
}

function saveCurrentDeliveryAddress(form) {
  const address = deliveryAddressFromForm(form);
  if (address.zipCode.length !== 8 || !address.number) {
    $("#checkoutStatus").textContent = "Informe CEP e número para salvar este endereço.";
    return;
  }
  const addresses = loadDeliveryAddresses();
  const existingIndex = addresses.findIndex((item) => deliveryAddressKey(item) === deliveryAddressKey(address));
  if (existingIndex >= 0) addresses.splice(existingIndex, 1);
  else if (addresses.length >= 3) {
    $("#checkoutStatus").textContent = "Você pode salvar até 3 endereços. Remova um endereço para adicionar outro.";
    return;
  }
  saveDeliveryAddresses([address, ...addresses]);
  form.dataset.addressMode = "saved";
  localStorage.setItem(SELECTED_DELIVERY_ADDRESS_KEY, JSON.stringify(address));
  $("#checkoutStatus").textContent = "Endereço salvo para este carrinho.";
  renderDeliveryAddressBook(form);
  updateDeliveryAddressControls(form);
  updateTopbarCustomerRow();
}

function updateCheckoutAddressSummary(form) {
  const summary = form?.querySelector("[data-address-summary]");
  if (!summary) return;
  const lines = deliveryAddressLines(deliveryAddressFromForm(form));
  summary.hidden = !lines.length;
  summary.innerHTML = lines.length ? `<strong>Destino</strong>${lines.map((line) => `<span>${escapeHtml(line)}</span>`).join("")}` : "";
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
  const loginTitle = $("#customerLoginBox h3");
  const googleLoginButton = form.querySelector("[data-google-login]");
  if (loginTitle) loginTitle.textContent = loggedIn ? "Compra identificada" : "Entrar para comprar";
  if (googleLoginButton) googleLoginButton.hidden = loggedIn;
  $("#customerLoginBox").hidden = loggedIn;
  $("#customerLoginStatus").textContent = loggedIn
    ? `Comprando como ${session.customer.name || session.customer.email}.`
    : "Entre ou crie sua conta para finalizar o pedido.";
  updateCheckoutAddressSummary(form);
  if (loggedIn) maybeSeedCustomerAddress(form);
  renderDeliveryAddressBook(form);
  updateDeliveryAddressControls(form);
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
  localStorage.removeItem(SELECTED_DELIVERY_ADDRESS_KEY);
  updateTopbarCustomerRow();
  customerFields(form).forEach((input) => {
    input.readOnly = false;
  });
  form.querySelectorAll("[data-auth-field]").forEach((input) => {
    input.readOnly = false;
    input.value = "";
  });
  applyCustomerSession(form);
  renderPendingPaymentBanner();
  $("#checkoutStatus").textContent = "Dados liberados para alteracao. Salve novamente antes de comprar.";
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
  return "";
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
      updateCheckoutAddressSummary(form);
      updateDeliveryAddressControls(form);
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
    form.dataset.addressMode = "manual";
    updateCheckoutAddressSummary(form);
    updateDeliveryAddressControls(form);
    if (zipInput.value.replace(/\D/g, "").length === 8) lookup();
  });
  form.elements.number?.addEventListener("input", () => {
    form.dataset.addressMode = "manual";
    updateCheckoutAddressSummary(form);
    updateDeliveryAddressControls(form);
  });
  form.elements.complement?.addEventListener("input", () => {
    form.dataset.addressMode = "manual";
    updateCheckoutAddressSummary(form);
    updateDeliveryAddressControls(form);
  });
  form.querySelector("[data-save-address]")?.addEventListener("click", () => saveCurrentDeliveryAddress(form));
  form.querySelector("[data-new-address]")?.addEventListener("click", () => startManualDeliveryAddress(form));
  updateCheckoutAddressSummary(form);
  renderDeliveryAddressBook(form);
  updateDeliveryAddressControls(form);
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
    $("#shippingOptions").innerHTML = "<p>Informe um CEP v\u00e1lido para calcular a entrega.</p>";
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
    ${state.shippingQuotes.map((quote) => `
    <label class="shipping-option">
      <input type="radio" name="shippingOption" value="${shippingQuoteId(quote)}" ${shippingQuoteId(state.selectedShipping) === shippingQuoteId(quote) ? "checked" : ""}>
      ${shippingLogoMarkup(quote)}
      <span>
        <strong>${quote.displayName || `${quote.carrier} - ${quote.service}`}</strong>
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
    <section class="product-detail-hero" id="productIntroSection" data-product-section="intro">
      <div class="product-gallery">
        <div class="product-main-media" id="productMainMedia">
          ${renderMainMediaFrame(firstMedia, product)}
          <button class="product-media-expand" type="button" data-media-expand="0" aria-label="Ampliar imagem do produto"></button>
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
        <p class="eyebrow">${product.category}</p>
        <div class="product-social-proof detail-social-proof">${productMeta(product)}</div>
        <h1>${product.name}</h1>
        ${ratingMarkup(product, "detail-rating")}
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
        <div class="product-options">
          <span>${productPiecesLabel(product)}</span>
          ${product.variants?.colors?.length ? `
            <fieldset class="color-choice-group" aria-label="Cor">
              <legend>Cor</legend>
              <div class="color-choice-list">
                ${product.variants.colors.map((color, index) => {
                  const name = colorName(color);
                  const id = `productColor-${index}`;
                  return `
                    <label class="color-choice" for="${id}">
                      <input id="${id}" type="radio" name="productColor" value="${escapeHtml(name)}" ${index === 0 ? "checked" : ""}>
                      <span class="color-swatch" style="--swatch-color: ${colorHex(color)}"></span>
                      <small>${escapeHtml(name)}</small>
                    </label>
                  `;
                }).join("")}
              </div>
            </fieldset>
          ` : ""}
          <label class="quantity-inline">Quantidade:
            <select id="productQuantityInput" aria-label="Quantidade">
              ${Array.from({ length: Math.max(1, Math.min(Number(product.stock || 1), 20)) }, (_, index) => {
                const quantity = index + 1;
                return `<option value="${quantity}">${quantity} ${quantity === 1 ? "unidade" : "unidades"}</option>`;
              }).join("")}
            </select>
          </label>
          <p class="product-stock-badge">${productStockLabel(product)}</p>
        </div>
        <div class="hero-actions">
          <button class="primary-button" data-add="${product.id}">Adicionar ao carrinho</button>
        </div>
        <div class="payment-info">
          <strong>Pagamento seguro via Mercado Pago</strong>
          <span>Pix e cart\u00f5es de cr\u00e9dito aceitos no checkout.</span>
          <span>Seus dados de pagamento s\u00e3o processados em ambiente protegido.</span>
        </div>
      </div>
    </section>
    ${productStickyNav(product)}

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
    ${socialReviewsSection(product)}
    ${relatedProductsSection(product)}
    ${mediaLightboxMarkup(mediaItems, product)}
  `;

  document.querySelectorAll("[data-add]").forEach((button) => {
    button.addEventListener("click", () => addToCart(button.dataset.add));
  });
  document.querySelectorAll("[data-media-index]").forEach((button) => {
    button.addEventListener("click", () => {
      const item = mediaItems[Number(button.dataset.mediaIndex)];
      $("#productMainMedia").innerHTML = `${renderMainMediaFrame(item, product)}<button class="product-media-expand" type="button" data-media-expand="${button.dataset.mediaIndex}" aria-label="Ampliar imagem do produto"></button>`;
      setupMediaLightbox(mediaItems, product);
      document.querySelectorAll("[data-media-index]").forEach((thumb) => thumb.classList.toggle("active", thumb === button));
    });
  });
  document.querySelector("[data-media-index]")?.classList.add("active");
  setupMediaLightbox(mediaItems, product);
  renderRelatedProducts();
  setupRelatedInfiniteScroll();
  setupProductStickyNav(product);
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
    <span>Subtotal <strong>${money(subtotal)}</strong></span>
    <span>Frete <strong>${deliveryLabel}</strong></span>
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

async function submitSupportChat(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const customer = state.customerSession?.customer || {};
  const chat = supportChatState();
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
      title: `Atendimento sobre ${state.product?.name || "produto"}`,
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
  renderSupportChat(data.request, true);
  status.textContent = "Mensagem enviada. A resposta aparece aqui no chat.";
}

async function init() {
  protectAppSurface();
  lockProductHorizontalScroll();
  preventProductHorizontalPan();
  window.addEventListener("scroll", lockProductHorizontalScroll, { passive: true });
  window.addEventListener("resize", lockProductHorizontalScroll);
  const slug = new URLSearchParams(location.search).get("slug");
  document.querySelectorAll("[data-google-login]").forEach((link) => {
    link.href = `/api/customer/google/start?next=${encodeURIComponent(location.pathname + location.search)}`;
  });
  const response = await fetch("/api/products");
  const data = await response.json();
  state.products = data.products;
  state.settings = data.settings;
  applyTheme(data.settings.theme);
  updateTopbarCustomerRow();
  state.product = state.products.find((product) => product.slug === slug || product.id === slug);

  $("#cartButton").addEventListener("click", () => {
    $("#cartPanel").classList.add("open");
    autoQuoteShippingIfPossible();
  });
  $("#supportChatButton")?.addEventListener("click", openSupportPanel);
  $("#closeCart").addEventListener("click", () => $("#cartPanel").classList.remove("open"));
  $("#closeSupportPanel")?.addEventListener("click", closeSupportPanel);
  $("#supportPanel")?.addEventListener("click", (event) => {
    if (event.target.id === "supportPanel") closeSupportPanel();
  });
  $("#checkoutForm").addEventListener("submit", checkout);
  $("#supportChatForm")?.addEventListener("submit", submitSupportChat);
  refreshSupportChat(false);
  setInterval(() => refreshSupportChat(false), 60000);
  setupCheckoutDetails($("#checkoutForm"));
  $("#saveCustomerButton").addEventListener("click", () => { window.location.href = "/conta.html"; });
  $("#debugCustomerButton")?.addEventListener("click", () => useDebugCustomer($("#checkoutForm")));
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
        <a class="primary-link" href="/">Ir para a loja</a>
      </section>
    `;
    renderCart();
    return;
  }

  setupWhatsAppShare(state.product);
  renderProduct();
  applyCustomerSession($("#checkoutForm"));
  loadPendingOrders();
  renderCart();
  autoQuoteShippingIfPossible();
}

init();
