(function () {
  const h = React.createElement;
  const { useEffect, useMemo, useState } = React;
  const CART_KEY = "basa_cart";
  const CUSTOMER_SESSION_KEY = "basa_customer_session";
  const SUPPORT_CHAT_KEY = "basa_support_chat";

  function money(value) {
    return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(value || 0));
  }

  function cartCount() {
    try {
      return JSON.parse(localStorage.getItem(CART_KEY) || "[]").reduce((sum, item) => sum + Number(item.quantity || 0), 0);
    } catch {
      return 0;
    }
  }

  function productImage(product) {
    return product.image || product.images?.[0]?.url || product.media?.[0]?.url || "";
  }

  function productImages(product) {
    const sources = [
      product.image,
      ...(product.images || []).map((item) => item.url || item.src || item),
      ...(product.media || []).map((item) => item.url || item.src || item)
    ].filter(Boolean);
    return [...new Set(sources)];
  }

  function productRating(product) {
    const rating = product.rating || {};
    const average = Number(rating.average || product.ratingAverage || 0);
    const count = Number(rating.count || product.ratingCount || 0);
    if (!average) return null;
    return { average, count };
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
    score += Math.min(16, Number(candidate.soldCount || candidate.soldUnits || 0) / 3);
    score += Math.min(10, Number(candidate.favoriteCount || 0));
    score += Number(candidate.rating?.average || 0) * 2;
    return score;
  }

  function relatedProducts(baseProduct, products) {
    const ranked = products
      .filter((candidate) => candidate.id !== baseProduct.id && candidate.status !== "inactive")
      .map((candidate) => ({ product: candidate, score: relatedScore(baseProduct, candidate) }))
      .sort((a, b) => b.score - a.score || Number(b.product.soldCount || 0) - Number(a.product.soldCount || 0));
    return [
      ...ranked.filter((item) => item.score > 0).map((item) => item.product),
      ...ranked.filter((item) => item.score <= 0).map((item) => item.product)
    ];
  }

  function reviewMediaItems(review) {
    return (review.media || review.photos || [])
      .map((item, index) => {
        const src = typeof item === "string" ? item : item?.url || item?.src;
        if (!src) return null;
        return {
          src,
          type: /\.(mp4|webm|mov|m4v)$/i.test(String(src).split("?")[0]) ? "video" : "image",
          label: `Midia ${index + 1}`
        };
      })
      .filter(Boolean);
  }

  function reviewName(review) {
    return review.customerName || review.profileName || "Cliente Basa";
  }

  function productSlug(product) {
    return encodeURIComponent(product.slug || product.id || "");
  }

  function getProductKey(product) {
    return String(product.slug || product.id || "");
  }

  function getQuery(name) {
    return new URLSearchParams(window.location.search).get(name);
  }

  function getColors(product) {
    if (Array.isArray(product.colors)) return product.colors;
    if (Array.isArray(product.variations)) {
      return product.variations.filter((item) => item.type === "color" || item.hex || item.color);
    }
    return [];
  }

  function availableStock(product) {
    return Math.max(0, Number(product.stock ?? product.inventory ?? product.availableStock ?? 0));
  }

  function cartItems() {
    try {
      return JSON.parse(localStorage.getItem(CART_KEY) || "[]");
    } catch {
      return [];
    }
  }

  function customerSession() {
    try {
      return JSON.parse(localStorage.getItem(CUSTOMER_SESSION_KEY) || "null");
    } catch {
      return null;
    }
  }

  function supportChatState() {
    try {
      return JSON.parse(localStorage.getItem(SUPPORT_CHAT_KEY) || "null");
    } catch {
      return null;
    }
  }

  function saveSupportChatState(chat) {
    localStorage.setItem(SUPPORT_CHAT_KEY, JSON.stringify(chat));
  }

  function supportRequestFromList(requests, chat) {
    const chats = (requests || [])
      .filter((request) => request.kind === "chat" || String(request.title || "").startsWith("Atendimento"))
      .sort((a, b) => Date.parse(b.updatedAt || b.createdAt || 0) - Date.parse(a.updatedAt || a.createdAt || 0));
    const saved = chats.find((request) => request.id === chat?.id && request.status !== "closed");
    return saved || chats.find((request) => request.status !== "closed") || chats[0] || null;
  }

  function accountNextUrl() {
    return getQuery("next") || "/react/carrinho";
  }

  function googleLoginUrl() {
    const next = window.location.pathname + window.location.search;
    return `/api/customer/google/start?next=${encodeURIComponent(next)}`;
  }

  function safeCustomerName(customer = {}) {
    return customer.displayName || customer.name || customer.email || "Cliente Basa";
  }

  function normalizeProfileName(value) {
    return String(value || "").trim().replace(/^@+/, "").toLowerCase();
  }

  function profileNameError(value) {
    const name = normalizeProfileName(value);
    if (!name) return "Informe o nome do perfil.";
    if (!/^[a-z0-9._]{1,15}$/.test(name)) {
      return "Use ate 15 caracteres, sem espacos. Permitidos: letras, numeros, ponto e underline.";
    }
    return "";
  }

  function avatarNode(customer = {}, className = "react-profile-avatar") {
    const name = safeCustomerName(customer);
    return customer.avatarUrl
      ? h("img", { className, src: customer.avatarUrl, alt: name })
      : h("span", { className }, name.charAt(0).toUpperCase() || "B");
  }

  function verifiedBadge(customer = {}) {
    return customer.profileVerified ? h("span", { className: "react-verified-badge", title: "Perfil verificado", "aria-label": "Perfil verificado" }) : null;
  }

  function orderStatusLabel(status) {
    return {
      created: "Criado",
      awaiting_payment: "Aguardando pagamento",
      paid: "Pago",
      in_production: "Em producao",
      shipped: "Enviado",
      completed: "Concluido",
      canceled: "Cancelado"
    }[status] || status || "Criado";
  }

  function paymentExpiryLabel(order) {
    if (!order?.payment?.expiresAt) return "";
    const expiresAt = new Date(order.payment.expiresAt).getTime();
    if (!Number.isFinite(expiresAt)) return "";
    const remainingMs = expiresAt - Date.now();
    if (remainingMs <= 0) return "expira em instantes";
    const hours = Math.ceil(remainingMs / 3600000);
    return hours >= 24 ? `expira em ${Math.ceil(hours / 24)} dia(s)` : `expira em ${hours}h`;
  }

  function orderPrimaryItem(order) {
    return order?.items?.[0] || {};
  }

  function orderPaymentLabel(order) {
    const payment = order?.payment || {};
    return payment.method || payment.type || payment.provider || "Mercado Pago";
  }

  function orderShippingLabel(order) {
    const option = order?.shippingOption || {};
    const name = option.displayName || [option.carrier, option.service].filter(Boolean).join(" ");
    if (name) return name;
    return Number(order?.shipping || 0) > 0 ? "Frete calculado" : "Frete gratis";
  }

  function orderDeliveryLabel(order) {
    const option = order?.shippingOption || {};
    const deliveryDays = Number(option.deliveryDays || option.delivery_time || 0);
    const productionDays = Math.max(...(order?.items || []).map((item) => Number(item.productionDays || item.product?.productionDays || 0)), 0);
    const totalDays = deliveryDays + productionDays;
    return totalDays ? `${totalDays} dias uteis` : "Prazo a confirmar";
  }

  function orderItemImage(item, products = []) {
    const product = products.find((candidate) => String(candidate.id) === String(item.productId || item.id));
    return item.image || productImage(product || {}) || "";
  }

  function requestStatusLabel(status) {
    return {
      new: "Nova",
      waiting_admin: "Aguardando Basa",
      waiting_customer: "Aguardando cliente",
      in_review: "Em analise",
      quoted: "Orcada",
      approved: "Aprovada",
      in_production: "Em producao",
      shipped: "Enviada",
      completed: "Concluida",
      closed: "Encerrada",
      canceled: "Cancelada"
    }[status] || status || "Nova";
  }

  function defaultAccountForm(session = null) {
    const customer = session?.customer || {};
    return {
      name: customer.name || "",
      email: customer.email || "",
      password: "",
      customerUsername: customer.displayName || session?.username || "",
      phone: customer.phone || "",
      zipCode: cleanZip(customer.zipCode),
      street: customer.street || "",
      number: customer.number || "",
      neighborhood: customer.neighborhood || "",
      complement: customer.complement || "",
      city: customer.city || "",
      state: customer.state || "",
      ibge: customer.ibge || ""
    };
  }

  function apiCartItems(items) {
    return items.map((item) => ({
      productId: item.productId || item.id,
      quantity: Number(item.quantity || 1),
      variant: item.colorName ? { color: item.colorName, colorHex: item.colorHex || "" } : (item.variant || {})
    })).filter((item) => item.productId);
  }

  function shippingQuoteId(quote) {
    return String(quote?.id || `${quote?.carrier || ""}-${quote?.service || ""}-${quote?.price || ""}`);
  }

  function cleanZip(value) {
    return String(value || "").replace(/\D/g, "").slice(0, 8);
  }

  function addressLines(address = {}) {
    const zip = cleanZip(address.zipCode);
    const lineOne = [address.street, address.number].filter(Boolean).join(", ");
    const lineTwo = [address.neighborhood, address.city && address.state ? `${address.city}/${address.state}` : address.city || address.state].filter(Boolean).join(" - ");
    const complement = address.complement ? `Complemento: ${address.complement}` : "";
    const zipLine = zip.length === 8 ? `CEP ${zip.replace(/^(\d{5})(\d{3})$/, "$1-$2")}` : "";
    return [lineOne, lineTwo, complement, zipLine].filter(Boolean);
  }

  function topbarAddressLabel(address = {}) {
    return [address.street, address.number].filter(Boolean).join(", ");
  }

  function accountDeliveryAddress() {
    const customer = customerSession()?.customer || {};
    const zipCode = cleanZip(customer.zipCode);
    if (zipCode.length !== 8 || !customer.number) return null;
    return {
      zipCode,
      number: customer.number || "",
      complement: customer.complement || "",
      street: customer.street || "",
      neighborhood: customer.neighborhood || "",
      city: customer.city || "",
      state: String(customer.state || "").toUpperCase(),
      ibge: customer.ibge || "",
      principal: true
    };
  }

  function initialCartAddress() {
    return accountDeliveryAddress() || {
      zipCode: "",
      number: "",
      complement: "",
      street: "",
      neighborhood: "",
      city: "",
      state: "",
      ibge: ""
    };
  }

  function saveCart(items) {
    localStorage.setItem(CART_KEY, JSON.stringify(items));
    window.dispatchEvent(new Event("basa-cart-change"));
  }

  function addToCart(product, quantity, color) {
    const items = cartItems();
    const key = getProductKey(product);
    const colorName = color?.name || color?.label || "";
    const existing = items.find((item) => String(item.id || item.slug) === key && (item.colorName || "") === colorName);
    if (existing) {
      existing.quantity = Number(existing.quantity || 0) + quantity;
    } else {
      items.push({
        productId: product.id,
        id: product.id,
        slug: product.slug,
        name: product.name,
        price: product.price,
        image: productImage(product),
        quantity,
        colorName,
        colorHex: color?.hex || color?.color || "",
        sellerPaysShipping: Boolean(product.sellerPaysShipping)
      });
    }
    saveCart(items);
  }

  function Topbar({ count, detail }) {
    const [menuOpen, setMenuOpen] = useState(false);
    const session = customerSession();
    const customer = session?.customer || null;
    const mainAddress = accountDeliveryAddress();
    const addressLabel = topbarAddressLabel(mainAddress || {});
    const closeMenu = () => setMenuOpen(false);
    const logout = () => {
      localStorage.removeItem(CUSTOMER_SESSION_KEY);
      closeMenu();
      window.location.href = "/react/conta";
    };
    const menuItems = customer
      ? [
        ["account_circle", "Perfil e dados", "Cadastro, foto e endereco.", "/react/perfil"],
        ["receipt_long", "Pedidos", "Compras, pagamentos e entrega.", "/react/pedidos"],
        ["inventory_2", "Encomendas", "Solicitacoes sob medida.", "/react/encomendas"],
        ["forum", "Chat", "Fale com a Basa.", "/react/chat"],
        ["shopping_bag", "Carrinho", "Itens e entrega.", "/react/carrinho"]
      ]
      : [
        ["login", "Entrar", "Acesse ou crie sua conta.", "/react/conta"],
        ["forum", "Chat", "Entre para falar conosco.", "/react/chat"],
        ["shopping_bag", "Carrinho", "Itens e entrega.", "/react/carrinho"]
      ];

    return h(React.Fragment, null,
      h("header", { className: customer ? "react-topbar has-customer-row" : "react-topbar" },
        h("div", { className: "react-topbar-main" },
          detail
            ? h("a", { className: "round-icon", href: "/react", "aria-label": "Voltar" }, h("span", { className: "material-symbols-rounded" }, "arrow_back"))
            : h("button", {
              className: "round-icon",
              "aria-label": menuOpen ? "Fechar menu" : "Menu",
              "aria-expanded": menuOpen ? "true" : "false",
              onClick: () => setMenuOpen((current) => !current)
            }, h("span", { className: "material-symbols-rounded" }, menuOpen ? "close" : "menu")),
          h("label", { className: "react-search" },
            h("input", { placeholder: "Buscar na Basa 3D Works", readOnly: true })
          ),
          h("a", { className: "round-icon", href: "/react/chat", "aria-label": "Chat" },
            h("span", { className: "material-symbols-rounded" }, "forum")
          ),
          h("a", { className: "round-icon cart-icon", href: "/react/carrinho", "aria-label": "Carrinho" },
            h("span", { className: "material-symbols-rounded" }, "shopping_bag"),
            h("b", null, count)
          )
        ),
        customer ? h("div", { className: "react-customer-row" },
          h("span", { className: "react-customer-hello" }, "Ola ", h("strong", null, safeCustomerName(customer)), verifiedBadge(customer)),
          h("span", { className: "react-customer-address" }, addressLabel || "Endereco principal")
        ) : null
      ),
      !detail && menuOpen ? h("div", { className: "react-menu-backdrop", onClick: closeMenu },
        h("nav", { className: "react-menu-panel", onClick: (event) => event.stopPropagation(), "aria-label": "Menu da loja" },
          h("div", { className: "react-menu-profile" },
            customer ? avatarNode(customer, "react-profile-avatar") : h("span", { className: "react-profile-avatar" }, "B"),
            h("div", null,
              h("strong", null, customer ? safeCustomerName(customer) : "Minha Basa", customer ? verifiedBadge(customer) : null),
              h("span", null, customer?.email || "Entre para acompanhar compras.")
            )
          ),
          h("a", { className: "react-menu-home", href: "/react", onClick: closeMenu },
            h("span", { className: "material-symbols-rounded" }, "storefront"),
            h("strong", null, "Loja")
          ),
          h("div", { className: "react-menu-links" },
            menuItems.map(([icon, title, text, href]) => h("a", { href, key: href, onClick: closeMenu },
              h("span", { className: "material-symbols-rounded" }, icon),
              h("div", null,
                h("strong", null, title),
                h("small", null, text)
              ),
              h("b", null, ">")
            ))
          ),
          customer ? h("button", { type: "button", className: "react-menu-logout", onClick: logout },
            h("span", { className: "material-symbols-rounded" }, "logout"),
            h("strong", null, "Sair")
          ) : null
        )
      ) : null
    );
  }

  function Hero() {
    return h("section", { className: "react-hero" },
      h("p", null, "Impressao 3D, produtos prontos e sob demanda"),
      h("h1", null, "Basa 3D Works"),
      h("span", null, "Preview React da loja publica. A loja atual continua ativa.")
    );
  }

  function FeedTabs({ feed, setFeed }) {
    const tabs = [
      ["for-you", "Para voce"],
      ["trending", "Tendencia"],
      ["favorites", "Favoritos"]
    ];
    return h("nav", { className: "react-tabs" },
      tabs.map(([id, label]) => h("button", {
        key: id,
        className: feed === id ? "active" : "",
        type: "button",
        onClick: () => setFeed(id)
      }, label))
    );
  }

  function ProductCard({ product }) {
    const rating = productRating(product);
    const img = productImage(product);
    return h("a", { className: "react-product-card", href: `/react/produto?slug=${productSlug(product)}` },
      h("div", { className: "react-product-image" }, img
        ? h("img", { src: img, alt: product.name })
        : h("span", null, "Imagem")
      ),
      h("small", null, product.category || "Produto"),
      h("strong", null, product.name),
      rating && h("div", { className: "react-rating" },
        h("b", null, rating.average.toFixed(1)),
        h("span", null, "★★★★★"),
        rating.count ? h("em", null, `(${rating.count})`) : null
      ),
      h("p", null, money(product.price)),
      product.sellerPaysShipping ? h("span", { className: "free-shipping" }, "Frete Gratis") : null
    );
  }

  function ProductNav() {
    return h("nav", { className: "react-product-nav", "aria-label": "Navegacao do produto" },
      h("a", { href: "#produto-inicio" }, "Inicio"),
      h("a", { href: "#produto-comentarios" }, "Comentarios"),
      h("a", { href: "#produto-relacionados" }, "Relacionados")
    );
  }

  function MediaLightbox({ items, index, onClose, setIndex }) {
    if (!items?.length) return null;
    const item = items[index] || items[0];
    const previous = () => setIndex((index - 1 + items.length) % items.length);
    const next = () => setIndex((index + 1) % items.length);
    return h("div", { className: "react-lightbox", role: "dialog", "aria-modal": "true" },
      h("button", { className: "react-lightbox-close", type: "button", onClick: onClose, "aria-label": "Fechar" },
        h("span", { className: "material-symbols-rounded" }, "close")
      ),
      items.length > 1 && h("button", { className: "react-lightbox-arrow left", type: "button", onClick: previous, "aria-label": "Anterior" },
        h("span", { className: "material-symbols-rounded" }, "chevron_left")
      ),
      h("div", { className: "react-lightbox-media" }, item.type === "video"
        ? h("video", { src: item.src, controls: true, playsInline: true })
        : h("img", { src: item.src, alt: item.label || "Midia do comentario" })
      ),
      items.length > 1 && h("button", { className: "react-lightbox-arrow right", type: "button", onClick: next, "aria-label": "Proxima" },
        h("span", { className: "material-symbols-rounded" }, "chevron_right")
      ),
      h("span", { className: "react-lightbox-count" }, `${index + 1} / ${items.length}`)
    );
  }

  function ReviewsSection({ product, openMedia }) {
    const reviews = product.publicReviews || [];
    return h("section", { className: "react-detail-card react-reviews", id: "produto-comentarios" },
      h("small", null, "Comentarios"),
      h("h2", null, "Quem comprou conta"),
      reviews.length
        ? h("div", { className: "react-review-list" }, reviews.slice(0, 8).map((review, reviewIndex) => {
          const media = reviewMediaItems(review);
          const name = reviewName(review);
          return h("article", { className: "react-review-card", key: review.id || reviewIndex },
            h("div", { className: "react-review-head" },
              review.customerAvatar
                ? h("img", { className: "react-review-avatar", src: review.customerAvatar, alt: name })
                : h("span", { className: "react-review-avatar" }, name.charAt(0).toUpperCase() || "B"),
              h("strong", null, name),
              review.profileVerified ? h("span", { className: "react-verified-badge", "aria-label": "Perfil verificado" }) : null,
              review.rating ? h("em", null, `${Number(review.rating).toFixed(1)} *`) : null
            ),
            review.comment ? h("p", null, review.comment) : null,
            media.length ? h("div", { className: "react-review-media" },
              media.map((item, mediaIndex) => h("button", {
                key: item.src,
                type: "button",
                onClick: () => openMedia(media, mediaIndex),
                "aria-label": `Abrir ${item.label}`
              }, item.type === "video"
                ? h(React.Fragment, null, h("video", { src: item.src, muted: true, playsInline: true, preload: "metadata" }), h("span", { className: "material-symbols-rounded" }, "play_arrow"))
                : h("img", { src: item.src, alt: item.label })
              ))
            ) : null
          );
        }))
        : h("p", { className: "react-empty" }, "Ainda nao ha comentarios deste produto.")
    );
  }

  function RelatedSection({ product, products }) {
    const related = relatedProducts(product, products).slice(0, 12);
    return h("section", { className: "react-section react-related-section", id: "produto-relacionados" },
      h("h2", null, "Relacionados"),
      related.length
        ? h("div", { className: "react-product-grid" }, related.map((item) => h(ProductCard, { key: item.id, product: item })))
        : h("p", { className: "react-empty" }, "Ainda nao ha produtos relacionados cadastrados.")
    );
  }

  function ProductDetail({ products, loading, setCount }) {
    const wantedSlug = getQuery("slug") || "";
    const product = products.find((item) => String(item.slug || item.id) === wantedSlug) || null;
    const images = product ? productImages(product) : [];
    const colors = product ? getColors(product) : [];
    const [selectedImage, setSelectedImage] = useState(0);
    const [selectedColor, setSelectedColor] = useState(0);
    const [quantity, setQuantity] = useState(1);
    const [notice, setNotice] = useState("");
    const [lightbox, setLightbox] = useState(null);

    useEffect(() => {
      setSelectedImage(0);
      setSelectedColor(0);
      setQuantity(1);
      setNotice("");
      setLightbox(null);
    }, [wantedSlug]);

    if (loading) {
      return h("main", { className: "react-product-page" },
        h("section", { className: "react-section" }, h("p", null, "Carregando produto..."))
      );
    }

    if (!product) {
      return h("main", { className: "react-product-page" },
        h("section", { className: "react-detail-card" },
          h("h1", null, "Produto nao encontrado"),
          h("a", { className: "react-add", href: "/react" }, "Voltar para a vitrine")
        )
      );
    }

    const rating = productRating(product);
    const stock = availableStock(product);
    const color = colors[selectedColor];
    const image = images[selectedImage] || productImage(product);

    const handleAdd = (buyNow) => {
      addToCart(product, quantity, color);
      setCount(cartCount());
      if (buyNow) {
        window.location.href = "/react/carrinho";
        return;
      }
      setNotice("Produto adicionado ao carrinho.");
    };

    const openMedia = (items, index) => setLightbox({ items, index });

    return h("main", { className: "react-product-page" },
      h(ProductNav),
      h("section", { className: "react-gallery", id: "produto-inicio" },
        h("div", { className: "react-main-media" }, image
          ? h("img", { src: image, alt: product.name })
          : h("span", null, "Imagem do produto")
        ),
        images.length > 1 && h("div", { className: "react-thumbs" },
          images.map((src, index) => h("button", {
            key: src,
            className: index === selectedImage ? "active" : "",
            type: "button",
            onClick: () => setSelectedImage(index)
          }, h("img", { src, alt: `${product.name} ${index + 1}` })))
        )
      ),
      h("section", { className: "react-detail-card" },
        h("small", null, product.category || "Produto"),
        h("h1", null, product.name),
        rating && h("div", { className: "react-rating product-rating" },
          h("b", null, rating.average.toFixed(1)),
          h("span", null, "*****"),
          rating.count ? h("em", null, `(${rating.count})`) : null
        ),
        h("div", { className: "react-price" }, money(product.price)),
        product.sellerPaysShipping ? h("span", { className: "free-shipping product-free-shipping" }, "Frete Gratis") : null,
        h("div", { className: "react-options" },
          h("div", { className: "react-stock-line" },
            h("strong", null, `${stock || 1} ${stock === 1 ? "unidade disponivel" : "unidades disponiveis"}`)
          ),
          colors.length ? h("div", { className: "react-color-list" },
            colors.map((item, index) => h("button", {
              key: item.name || item.label || item.hex || index,
              className: index === selectedColor ? "active" : "",
              type: "button",
              onClick: () => setSelectedColor(index)
            },
              h("span", { style: { background: item.hex || item.color || "#eee" } }),
              h("em", null, item.name || item.label || "Cor")
            ))
          ) : null,
          h("label", { className: "react-quantity-row" },
            h("span", null, "Quantidade:"),
            h("select", {
              value: quantity,
              onChange: (event) => setQuantity(Number(event.target.value))
            }, Array.from({ length: Math.max(1, Math.min(stock || 10, 10)) }, (_, index) =>
              h("option", { key: index + 1, value: index + 1 }, `${index + 1}`)
            )),
            h("span", null, stock ? `(+${Math.max(0, stock - quantity)} disponiveis)` : "")
          )
        ),
        h("div", { className: "react-actions" },
          h("button", { className: "react-buy", type: "button", onClick: () => handleAdd(true) }, "Comprar agora"),
          h("button", { className: "react-add", type: "button", onClick: () => handleAdd(false) },
            h("span", { className: "material-symbols-rounded" }, "add_shopping_cart"),
            "Adicionar ao carrinho"
          )
        ),
        notice && h("p", { className: "react-status" }, notice),
        h("article", { className: "react-payment" },
          h("strong", null, "Pagamento seguro via Mercado Pago"),
          h("span", null, "Pix e cartoes de credito aceitos no checkout.")
        ),
        product.description && h("p", { className: "react-description" }, product.description)
      ),
      h(ReviewsSection, { product, openMedia }),
      h(RelatedSection, { product, products }),
      lightbox && h(MediaLightbox, {
        items: lightbox.items,
        index: lightbox.index,
        onClose: () => setLightbox(null),
        setIndex: (index) => setLightbox({ ...lightbox, index })
      })
    );
  }

  function ProductGrid({ products, feed }) {
    const visibleProducts = useMemo(() => {
      const active = products.filter((product) => product.status !== "inactive");
      if (feed === "trending") {
        return [...active].sort((a, b) => Number(b.soldUnits || 0) - Number(a.soldUnits || 0));
      }
      return active;
    }, [products, feed]);

    return h("section", { className: "react-section" },
      h("h2", null, feed === "trending" ? "Tendencia" : feed === "favorites" ? "Favoritos" : "Produtos em destaque"),
      h("div", { className: "react-product-grid" },
        visibleProducts.slice(0, 12).map((product) => h(ProductCard, { key: product.id, product }))
      )
    );
  }

  function enrichCartItem(item, products) {
    const product = products.find((candidate) => String(candidate.id) === String(item.id) || String(candidate.slug) === String(item.slug));
    if (!product) return item;
    return {
      ...item,
      product,
      name: item.name || product.name,
      price: item.price ?? product.price,
      image: item.image || productImage(product),
      sellerPaysShipping: item.sellerPaysShipping ?? Boolean(product.sellerPaysShipping)
    };
  }

  function AccountPage() {
    const [session, setSession] = useState(customerSession());
    const [form, setForm] = useState(() => defaultAccountForm(customerSession()));
    const [status, setStatus] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const customer = session?.customer || null;
    const nextUrl = accountNextUrl();

    const updateForm = (field, value) => {
      setForm((current) => ({ ...current, [field]: field === "state" ? value.toUpperCase().slice(0, 2) : value }));
    };

    const lookupCep = async () => {
      const zipCode = cleanZip(form.zipCode);
      if (zipCode.length !== 8) return;
      setStatus("Buscando CEP...");
      try {
        const response = await fetch(`/api/cep/${zipCode}`);
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || "CEP nao encontrado.");
        setForm((current) => ({
          ...current,
          zipCode: data.zipCode || data.cep || zipCode,
          street: data.street || "",
          neighborhood: data.neighborhood || "",
          city: data.city || "",
          state: data.state || "",
          ibge: data.ibge || ""
        }));
        setStatus("");
      } catch (error) {
        setStatus(error.message || "Nao foi possivel consultar o CEP.");
      }
    };

    const submitAccount = async (event) => {
      event.preventDefault();
      if (submitting) return;
      setSubmitting(true);
      setStatus("Validando acesso...");
      try {
        const response = await fetch("/api/customer/access", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: form.name,
            email: form.email,
            password: form.password,
            customerPassword: form.password,
            customerUsername: form.customerUsername,
            username: form.customerUsername,
            phone: form.phone,
            zipCode: cleanZip(form.zipCode),
            street: form.street,
            number: form.number,
            neighborhood: form.neighborhood,
            complement: form.complement,
            city: form.city,
            state: form.state,
            ibge: form.ibge
          })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || "Nao foi possivel entrar ou cadastrar.");
        const nextSession = {
          loggedIn: true,
          username: data.account?.username,
          customer: data.account?.customer || data.customer?.customer || data.customer,
          updatedAt: new Date().toISOString()
        };
        localStorage.setItem(CUSTOMER_SESSION_KEY, JSON.stringify(nextSession));
        setSession(nextSession);
        setForm(defaultAccountForm(nextSession));
        setStatus(data.created ? "Cadastro criado. Agora voce pode finalizar a compra." : "Login confirmado.");
      } catch (error) {
        setStatus(error.message || "Nao foi possivel entrar ou cadastrar.");
      } finally {
        setSubmitting(false);
      }
    };

    const logout = () => {
      localStorage.removeItem(CUSTOMER_SESSION_KEY);
      setSession(null);
      setForm(defaultAccountForm(null));
      setStatus("Sessao encerrada neste aparelho.");
    };

    return h("main", { className: "react-account-page" },
      h("section", { className: "react-account-hero" },
        h("small", null, "Conta do cliente"),
        h("h1", null, customer ? "Minha conta" : "Entrar na Basa"),
        h("p", null, customer ? "Seu acesso esta conectado ao carrinho React." : "Entre para finalizar pedidos, salvar endereco e acompanhar compras.")
      ),
      customer
        ? h(React.Fragment, null,
          h("section", { className: "react-account-card react-session-card" },
            h("div", null,
              h("strong", null, safeCustomerName(customer)),
              h("span", null, customer.email || "")
            ),
            h("a", { className: "react-secondary-link", href: "/react/perfil" }, "Perfil e dados"),
            h("a", { className: "react-secondary-link", href: "/react/pedidos" }, "Meus pedidos"),
            h("a", { className: "react-secondary-link", href: "/react/encomendas" }, "Encomendas"),
            h("a", { className: "react-primary-link", href: nextUrl }, nextUrl.includes("carrinho") ? "Voltar ao carrinho" : "Continuar"),
            h("button", { type: "button", className: "react-danger-button", onClick: logout }, "Sair")
          ),
          status ? h("p", { className: "react-account-status" }, status) : null
        )
        : h("section", { className: "react-account-card" },
          h("a", { className: "react-google-button", href: googleLoginUrl() },
            h("span", { className: "react-google-mark" }, "G"),
            h("strong", null, "Entrar com Google")
          ),
          h("div", { className: "react-account-divider" }, "ou"),
          h("form", { className: "react-account-form", onSubmit: submitAccount },
            h("label", null,
              h("span", null, "Nome completo"),
              h("input", { required: true, value: form.name, onChange: (event) => updateForm("name", event.target.value), placeholder: "Seu nome" })
            ),
            h("label", null,
              h("span", null, "Email"),
              h("input", { required: true, type: "email", value: form.email, onChange: (event) => updateForm("email", event.target.value), placeholder: "voce@email.com" })
            ),
            h("label", null,
              h("span", null, "Senha"),
              h("input", { required: true, type: "password", minLength: 6, value: form.password, onChange: (event) => updateForm("password", event.target.value), placeholder: "Minimo 6 caracteres" })
            ),
            h("label", null,
              h("span", null, "Nome do perfil"),
              h("input", { value: form.customerUsername, onChange: (event) => updateForm("customerUsername", event.target.value), placeholder: "@ do Instagram sem @" }),
              h("small", null, "Prefira usar seu @ do Instagram.")
            ),
            h("div", { className: "react-account-grid" },
              h("label", null,
                h("span", null, "Telefone"),
                h("input", { value: form.phone, onChange: (event) => updateForm("phone", event.target.value), inputMode: "tel", placeholder: "11999999999" })
              ),
              h("label", null,
                h("span", null, "CEP"),
                h("input", { value: form.zipCode, onChange: (event) => updateForm("zipCode", cleanZip(event.target.value)), onBlur: lookupCep, inputMode: "numeric", placeholder: "01128010" })
              ),
              h("label", null,
                h("span", null, "Numero"),
                h("input", { value: form.number, onChange: (event) => updateForm("number", event.target.value), placeholder: "107" })
              ),
              h("label", null,
                h("span", null, "Complemento"),
                h("input", { value: form.complement, onChange: (event) => updateForm("complement", event.target.value), placeholder: "Apto 154" })
              )
            ),
            form.street ? h("div", { className: "react-destination-card" },
              h("strong", null, "Endereco"),
              addressLines(form).map((line) => h("span", { key: line }, line))
            ) : null,
            h("button", { type: "submit", disabled: submitting }, submitting ? "Entrando..." : "Entrar ou criar conta")
          ),
          status ? h("p", { className: "react-account-status" }, status) : null
        )
    );
  }

  function ProfilePage() {
    const [session, setSession] = useState(customerSession());
    const [customer, setCustomer] = useState(() => customerSession()?.customer || null);
    const [profile, setProfile] = useState(() => ({
      displayName: normalizeProfileName(customerSession()?.customer?.displayName || customerSession()?.username || ""),
      avatar: null
    }));
    const [dataForm, setDataForm] = useState(() => defaultAccountForm(customerSession()));
    const [status, setStatus] = useState("");
    const [savingProfile, setSavingProfile] = useState(false);
    const [savingData, setSavingData] = useState(false);

    const refreshSession = (account) => {
      const nextSession = {
        ...session,
        loggedIn: true,
        username: account.username,
        customer: account.customer,
        emailVerified: Boolean(account.emailVerified),
        updatedAt: new Date().toISOString()
      };
      localStorage.setItem(CUSTOMER_SESSION_KEY, JSON.stringify(nextSession));
      setSession(nextSession);
      setCustomer(account.customer);
      setProfile({ displayName: normalizeProfileName(account.customer?.displayName || account.username || ""), avatar: null });
      setDataForm(defaultAccountForm(nextSession));
    };

    const updateData = (field, value) => {
      setDataForm((current) => ({ ...current, [field]: field === "state" ? value.toUpperCase().slice(0, 2) : value }));
    };

    const lookupProfileCep = async () => {
      const zipCode = cleanZip(dataForm.zipCode);
      if (zipCode.length !== 8) return;
      setStatus("Buscando CEP...");
      try {
        const response = await fetch(`/api/cep/${zipCode}`);
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || "CEP nao encontrado.");
        setDataForm((current) => ({
          ...current,
          zipCode: data.zipCode || data.cep || zipCode,
          street: data.street || "",
          neighborhood: data.neighborhood || "",
          city: data.city || "",
          state: data.state || "",
          ibge: data.ibge || ""
        }));
        setStatus("");
      } catch (error) {
        setStatus(error.message || "Nao foi possivel consultar o CEP.");
      }
    };

    const saveProfile = async (event) => {
      event.preventDefault();
      if (!customer?.email || savingProfile) return;
      const normalizedName = normalizeProfileName(profile.displayName);
      const validationError = profileNameError(normalizedName);
      if (validationError) {
        setStatus(validationError);
        return;
      }
      const currentName = normalizeProfileName(customer.displayName || session?.username || "");
      if (customer.profileVerified && normalizedName !== currentName) {
        setProfile((current) => ({ ...current, displayName: currentName }));
        setStatus("Perfil verificado: somente o admin pode alterar este nome.");
        return;
      }
      if (normalizedName !== currentName && !customer.profileNameChangedAt) {
        const confirmed = window.confirm("Voce pode trocar o nome de perfil agora. Depois desta troca, a proxima so podera ser feita em 30 dias. Tem certeza?");
        if (!confirmed) return;
      }
      const body = new FormData();
      body.set("email", customer.email);
      body.set("displayName", normalizedName);
      if (profile.avatar) body.set("avatar", profile.avatar);
      setSavingProfile(true);
      setStatus("Salvando perfil...");
      try {
        const response = await fetch("/api/customer/profile", { method: "POST", body });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || "Nao foi possivel salvar o perfil.");
        refreshSession(data.account);
        setStatus("Perfil salvo.");
      } catch (error) {
        setStatus(error.message || "Nao foi possivel salvar o perfil.");
      } finally {
        setSavingProfile(false);
      }
    };

    const saveData = async (event) => {
      event.preventDefault();
      if (!customer?.email || savingData) return;
      const body = new FormData();
      ["name", "document", "phone", "zipCode", "street", "number", "neighborhood", "complement", "city", "state", "ibge"].forEach((field) => {
        body.set(field, field === "zipCode" ? cleanZip(dataForm[field]) : dataForm[field] || "");
      });
      body.set("email", customer.email);
      setSavingData(true);
      setStatus("Salvando dados...");
      try {
        const response = await fetch("/api/customer/profile", { method: "POST", body });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || "Nao foi possivel salvar os dados.");
        refreshSession(data.account);
        setStatus("Dados salvos.");
      } catch (error) {
        setStatus(error.message || "Nao foi possivel salvar os dados.");
      } finally {
        setSavingData(false);
      }
    };

    return h("main", { className: "react-profile-page" },
      h("section", { className: "react-account-hero" },
        h("small", null, "Dados"),
        h("h1", null, "Perfil e dados"),
        h("p", null, customer ? "Edite seu perfil publico, foto e endereco principal." : "Entre para editar seus dados.")
      ),
      !customer
        ? h("section", { className: "react-account-card" },
          h("p", null, "Sua conta nao esta conectada neste aparelho."),
          h("a", { className: "react-primary-link", href: "/react/conta?next=/react/perfil" }, "Entrar ou criar conta")
        )
        : h(React.Fragment, null,
          h("section", { className: "react-profile-summary" },
            avatarNode(customer, "react-profile-avatar large"),
            h("div", null,
              h("strong", null, safeCustomerName(customer), verifiedBadge(customer)),
              h("span", null, customer.email || ""),
              h("small", null, session?.username ? `@${session.username}` : "")
            )
          ),
          h("form", { className: "react-account-card react-account-form", onSubmit: saveProfile },
            h("strong", null, "Editar perfil publico"),
            h("label", null,
              h("span", null, "Nome do perfil"),
              h("input", {
                required: true,
                maxLength: 15,
                readOnly: Boolean(customer.profileVerified),
                value: profile.displayName,
                onChange: (event) => setProfile((current) => ({ ...current, displayName: normalizeProfileName(event.target.value) })),
                placeholder: "Ex: fernanda.landimm"
              }),
              h("small", null, customer.profileVerified ? "Perfil verificado: somente o admin pode alterar este nome." : "Prefira usar seu @ do Instagram.")
            ),
            h("label", null,
              h("span", null, "Foto de perfil"),
              h("input", { type: "file", accept: "image/*", onChange: (event) => setProfile((current) => ({ ...current, avatar: event.target.files?.[0] || null })) })
            ),
            h("button", { type: "submit", disabled: savingProfile }, savingProfile ? "Salvando..." : "Salvar perfil")
          ),
          h("form", { className: "react-account-card react-account-form", onSubmit: saveData },
            h("strong", null, "Editar dados de compra"),
            h("label", null,
              h("span", null, "Nome completo"),
              h("input", { required: true, value: dataForm.name, onChange: (event) => updateData("name", event.target.value), autoComplete: "name" })
            ),
            h("div", { className: "react-account-grid" },
              h("label", null,
                h("span", null, "CPF ou CNPJ"),
                h("input", { required: true, value: dataForm.document, onChange: (event) => updateData("document", event.target.value), inputMode: "numeric" })
              ),
              h("label", null,
                h("span", null, "Telefone"),
                h("input", { required: true, value: dataForm.phone, onChange: (event) => updateData("phone", event.target.value), inputMode: "tel", autoComplete: "tel" })
              )
            ),
            h("div", { className: "react-account-grid" },
              h("label", null,
                h("span", null, "CEP"),
                h("input", { required: true, value: dataForm.zipCode, onChange: (event) => updateData("zipCode", cleanZip(event.target.value)), onBlur: lookupProfileCep, inputMode: "numeric", autoComplete: "postal-code" })
              ),
              h("label", null,
                h("span", null, "Numero"),
                h("input", { required: true, value: dataForm.number, onChange: (event) => updateData("number", event.target.value), autoComplete: "address-line2" })
              )
            ),
            h("label", null,
              h("span", null, "Rua"),
              h("input", { required: true, value: dataForm.street, onChange: (event) => updateData("street", event.target.value), autoComplete: "address-line1" })
            ),
            h("div", { className: "react-account-grid" },
              h("label", null,
                h("span", null, "Bairro"),
                h("input", { required: true, value: dataForm.neighborhood, onChange: (event) => updateData("neighborhood", event.target.value) })
              ),
              h("label", null,
                h("span", null, "Complemento"),
                h("input", { value: dataForm.complement, onChange: (event) => updateData("complement", event.target.value), autoComplete: "address-line3" })
              )
            ),
            h("div", { className: "react-account-grid" },
              h("label", null,
                h("span", null, "Cidade"),
                h("input", { required: true, value: dataForm.city, onChange: (event) => updateData("city", event.target.value), autoComplete: "address-level2" })
              ),
              h("label", null,
                h("span", null, "Estado"),
                h("input", { required: true, maxLength: 2, value: dataForm.state, onChange: (event) => updateData("state", event.target.value), autoComplete: "address-level1" })
              )
            ),
            h("button", { type: "submit", disabled: savingData }, savingData ? "Salvando..." : "Salvar dados")
          ),
          addressLines(dataForm).length ? h("section", { className: "react-destination-card" },
            h("strong", null, "Endereco principal"),
            addressLines(dataForm).map((line) => h("span", { key: line }, line))
          ) : null,
          status ? h("p", { className: "react-account-status" }, status) : null
        )
    );
  }

  function RequestsPage() {
    const [session, setSession] = useState(customerSession());
    const [requests, setRequests] = useState([]);
    const [form, setForm] = useState({ title: "", idea: "", budget: "", deadline: "" });
    const [replyText, setReplyText] = useState({});
    const [status, setStatus] = useState("");
    const [loading, setLoading] = useState(true);
    const [submitting, setSubmitting] = useState(false);
    const customer = session?.customer || null;

    const loadRequests = () => {
      if (!customer?.email) {
        setRequests([]);
        setLoading(false);
        return;
      }
      setLoading(true);
      fetch(`/api/custom-requests?email=${encodeURIComponent(customer.email)}`)
        .then(async (response) => {
          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(data.error || "Nao foi possivel carregar encomendas.");
          setRequests((data.requests || []).filter((item) => item.kind !== "chat"));
          setStatus("");
        })
        .catch((error) => {
          setStatus(error.message || "Nao foi possivel carregar encomendas.");
          setRequests([]);
        })
        .finally(() => setLoading(false));
    };

    useEffect(loadRequests, [customer?.email]);

    const updateForm = (field, value) => {
      setForm((current) => ({ ...current, [field]: value }));
    };

    const submitRequest = async (event) => {
      event.preventDefault();
      if (!customer || submitting) return;
      setSubmitting(true);
      setStatus("Enviando encomenda...");
      try {
        const response = await fetch("/api/custom-requests", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            customer,
            title: form.title || "Encomenda sob medida",
            idea: form.idea,
            budget: form.budget,
            deadline: form.deadline
          })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || "Nao foi possivel enviar a encomenda.");
        setRequests((current) => [data.request, ...current]);
        setForm({ title: "", idea: "", budget: "", deadline: "" });
        setStatus("Encomenda enviada. A Basa responde por aqui.");
      } catch (error) {
        setStatus(error.message || "Nao foi possivel enviar a encomenda.");
      } finally {
        setSubmitting(false);
      }
    };

    const sendMessage = async (requestId) => {
      const text = String(replyText[requestId] || "").trim();
      if (!customer?.email || !text) return;
      setStatus("Enviando mensagem...");
      try {
        const response = await fetch(`/api/custom-requests/${encodeURIComponent(requestId)}/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: customer.email, text })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || "Nao foi possivel enviar a mensagem.");
        setRequests((current) => current.map((item) => item.id === requestId ? data.request : item));
        setReplyText((current) => ({ ...current, [requestId]: "" }));
        setStatus("Mensagem enviada.");
      } catch (error) {
        setStatus(error.message || "Nao foi possivel enviar a mensagem.");
      }
    };

    return h("main", { className: "react-requests-page" },
      h("section", { className: "react-account-hero" },
        h("small", null, "Sob medida"),
        h("h1", null, "Encomendas"),
        h("p", null, customer ? "Envie uma ideia e acompanhe a resposta da Basa por aqui." : "Entre para pedir uma encomenda sob medida.")
      ),
      !customer
        ? h("section", { className: "react-account-card" },
          h("p", null, "Sua conta nao esta conectada neste aparelho."),
          h("a", { className: "react-primary-link", href: "/react/conta?next=/react/encomendas" }, "Entrar ou criar conta")
        )
        : h(React.Fragment, null,
          h("section", { className: "react-account-card" },
            h("form", { className: "react-account-form", onSubmit: submitRequest },
              h("label", null,
                h("span", null, "Titulo"),
                h("input", { value: form.title, onChange: (event) => updateForm("title", event.target.value), placeholder: "Ex: Suporte personalizado" })
              ),
              h("label", null,
                h("span", null, "Sua ideia"),
                h("textarea", { required: true, value: form.idea, onChange: (event) => updateForm("idea", event.target.value), placeholder: "Conte medidas, uso, cor desejada e referencias." })
              ),
              h("div", { className: "react-account-grid" },
                h("label", null,
                  h("span", null, "Orcamento"),
                  h("input", { value: form.budget, onChange: (event) => updateForm("budget", event.target.value), placeholder: "Ex: ate R$ 150" })
                ),
                h("label", null,
                  h("span", null, "Prazo"),
                  h("input", { value: form.deadline, onChange: (event) => updateForm("deadline", event.target.value), placeholder: "Ex: 10 dias" })
                )
              ),
              h("button", { type: "submit", disabled: submitting }, submitting ? "Enviando..." : "Enviar encomenda")
            )
          ),
          status ? h("p", { className: "react-account-status" }, status) : null,
          loading
            ? h("section", { className: "react-detail-card" }, h("p", null, "Carregando encomendas..."))
            : requests.length
              ? h("section", { className: "react-requests-list" },
                requests.map((request) => h("article", { className: "react-request-card", key: request.id },
                  h("div", { className: "react-request-head" },
                    h("div", null,
                      h("strong", null, request.title || "Encomenda sob medida"),
                      h("span", null, `${request.id} | ${requestStatusLabel(request.status)}`)
                    ),
                    h("small", null, request.createdAt ? new Date(request.createdAt).toLocaleDateString("pt-BR") : "")
                  ),
                  h("p", null, request.idea),
                  request.budget || request.deadline ? h("div", { className: "react-request-meta" },
                    request.budget ? h("span", null, h("b", null, "Orcamento"), request.budget) : null,
                    request.deadline ? h("span", null, h("b", null, "Prazo"), request.deadline) : null
                  ) : null,
                  h("div", { className: "react-request-messages" },
                    (request.messages || []).slice(-4).map((message) => h("span", { className: message.author === "admin" ? "admin" : "", key: message.id || `${request.id}-${message.createdAt}` },
                      h("b", null, message.author === "admin" ? "Basa: " : "Voce: "),
                      message.text
                    ))
                  ),
                  h("div", { className: "react-request-reply" },
                    h("input", {
                      value: replyText[request.id] || "",
                      onChange: (event) => setReplyText((current) => ({ ...current, [request.id]: event.target.value })),
                      placeholder: "Responder nesta encomenda"
                    }),
                    h("button", { type: "button", onClick: () => sendMessage(request.id) }, "Enviar")
                  )
                ))
              )
              : h("section", { className: "react-empty-cart" },
                h("span", { className: "material-symbols-rounded" }, "inventory_2"),
                h("h2", null, "Nenhuma encomenda ainda"),
                h("p", null, "Envie uma ideia para acompanhar o atendimento aqui.")
              )
        )
    );
  }

  function ChatPage() {
    const [session, setSession] = useState(customerSession());
    const [chat, setChat] = useState(null);
    const [message, setMessage] = useState("");
    const [status, setStatus] = useState("");
    const [loading, setLoading] = useState(true);
    const [submitting, setSubmitting] = useState(false);
    const customer = session?.customer || null;

    const loadChat = (markSeen = true) => {
      if (!customer?.email) {
        setChat(null);
        setLoading(false);
        return;
      }
      setLoading(true);
      const saved = supportChatState() || { email: customer.email, seenAdminCount: 0 };
      fetch(`/api/custom-requests?email=${encodeURIComponent(customer.email)}`)
        .then(async (response) => {
          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(data.error || "Nao foi possivel carregar o chat.");
          const nextChat = supportRequestFromList(data.requests || [], saved);
          setChat(nextChat);
          if (nextChat) {
            const adminCount = (nextChat.messages || []).filter((item) => item.author === "admin").length;
            saveSupportChatState({
              id: nextChat.id,
              email: nextChat.customer?.email || customer.email,
              seenAdminCount: markSeen ? adminCount : Number(saved.seenAdminCount || 0)
            });
          }
          setStatus("");
        })
        .catch((error) => {
          setStatus(error.message || "Nao foi possivel carregar o chat.");
          setChat(null);
        })
        .finally(() => setLoading(false));
    };

    useEffect(loadChat, [customer?.email]);

    const sendChatMessage = async (event) => {
      event.preventDefault();
      const text = message.trim();
      if (!customer?.email || !text || submitting) return;
      setSubmitting(true);
      setStatus("Enviando mensagem...");
      try {
        const response = chat ? await fetch(`/api/custom-requests/${encodeURIComponent(chat.id)}/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: customer.email, text })
        }) : await fetch("/api/custom-requests", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            title: "Atendimento pelo chat",
            kind: "chat",
            idea: text,
            customer
          })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || "Nao foi possivel enviar a mensagem.");
        const nextChat = data.request;
        setChat(nextChat);
        setMessage("");
        saveSupportChatState({
          id: nextChat.id,
          email: customer.email,
          seenAdminCount: (nextChat.messages || []).filter((item) => item.author === "admin").length
        });
        setStatus("Mensagem enviada. A resposta aparece aqui no chat.");
      } catch (error) {
        setStatus(error.message || "Nao foi possivel enviar a mensagem.");
      } finally {
        setSubmitting(false);
      }
    };

    return h("main", { className: "react-chat-page" },
      h("section", { className: "react-account-hero" },
        h("small", null, "Atendimento"),
        h("h1", null, "Chat Basa"),
        h("p", null, customer ? "Fale conosco por aqui. A resposta aparece nesta conversa." : "Entre para enviar mensagens e acompanhar a resposta no chat.")
      ),
      !customer
        ? h("section", { className: "react-account-card" },
          h("p", null, "Para falar com a Basa, conecte sua conta primeiro."),
          h("a", { className: "react-primary-link", href: "/react/conta?next=/react/chat" }, "Entrar ou criar conta")
        )
        : h(React.Fragment, null,
          h("section", { className: "react-chat-card" },
            loading
              ? h("p", null, "Carregando conversa...")
              : chat?.messages?.length
                ? h("div", { className: "react-chat-thread" },
                  chat.messages.map((item) => h("div", { className: `react-chat-message ${item.author === "admin" ? "admin" : "customer"}`, key: item.id || `${item.author}-${item.createdAt}` },
                    h("span", null, item.text),
                    h("small", null, item.author === "admin" ? "Basa" : "Voce")
                  ))
                )
                : h("div", { className: "react-chat-empty" },
                  h("span", { className: "material-symbols-rounded" }, "forum"),
                  h("strong", null, "Comece uma conversa"),
                  h("p", null, "Envie uma mensagem e acompanhe a resposta aqui.")
                ),
            h("form", { className: "react-chat-form", onSubmit: sendChatMessage },
              h("textarea", {
                value: message,
                onChange: (event) => setMessage(event.target.value),
                placeholder: "Escreva sua mensagem",
                rows: 3
              }),
              h("button", { type: "submit", disabled: submitting }, submitting ? "Enviando..." : "Enviar mensagem")
            )
          ),
          status ? h("p", { className: "react-account-status" }, status) : null
        )
    );
  }

  function OrdersPage({ products }) {
    const [session, setSession] = useState(customerSession());
    const [orders, setOrders] = useState([]);
    const [status, setStatus] = useState("");
    const [loading, setLoading] = useState(true);
    const customer = session?.customer || null;

    const loadOrders = () => {
      if (!customer?.email) {
        setOrders([]);
        setLoading(false);
        return;
      }
      setLoading(true);
      fetch(`/api/customer/orders?email=${encodeURIComponent(customer.email)}`)
        .then(async (response) => {
          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(data.error || "Nao foi possivel carregar pedidos.");
          if (data.account) {
            const nextSession = {
              loggedIn: true,
              username: data.account.username,
              customer: data.account.customer,
              updatedAt: new Date().toISOString()
            };
            localStorage.setItem(CUSTOMER_SESSION_KEY, JSON.stringify(nextSession));
            setSession(nextSession);
          }
          setOrders(data.orders || []);
          setStatus("");
        })
        .catch((error) => {
          setStatus(error.message || "Nao foi possivel carregar pedidos.");
          setOrders([]);
        })
        .finally(() => setLoading(false));
    };

    useEffect(loadOrders, [customer?.email]);

    const cancelOrder = async (orderId) => {
      if (!customer?.email || !orderId) return;
      if (!window.confirm("Deseja desistir desta compra pendente?")) return;
      setStatus("Cancelando pedido...");
      try {
        const response = await fetch(`/api/customer/orders/${encodeURIComponent(orderId)}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: customer.email, action: "cancel_payment" })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || "Nao foi possivel cancelar este pedido.");
        setOrders((current) => current.map((order) => order.id === orderId ? data.order : order));
        setStatus("Pedido cancelado.");
      } catch (error) {
        setStatus(error.message || "Nao foi possivel cancelar este pedido.");
      }
    };

    return h("main", { className: "react-orders-page" },
      h("section", { className: "react-account-hero" },
        h("small", null, "Compras"),
        h("h1", null, "Meus pedidos"),
        h("p", null, customer ? "Acompanhe pagamentos, entrega e detalhes dos seus pedidos." : "Entre para ver seus pedidos.")
      ),
      !customer
        ? h("section", { className: "react-account-card" },
          h("p", null, "Sua conta nao esta conectada neste aparelho."),
          h("a", { className: "react-primary-link", href: "/react/conta?next=/react/pedidos" }, "Entrar ou criar conta")
        )
        : loading
          ? h("section", { className: "react-detail-card" }, h("p", null, "Carregando seus pedidos..."))
          : orders.length
            ? h("section", { className: "react-orders-list" },
              status ? h("p", { className: "react-account-status" }, status) : null,
              orders.map((order) => {
                const item = orderPrimaryItem(order);
                const image = orderItemImage(item, products);
                const pending = order.status === "awaiting_payment" && order.payment?.checkoutUrl;
                return h("article", { className: `react-order-card ${pending ? "pending" : ""}`, key: order.id },
                  h("div", { className: "react-order-main" },
                    h("div", { className: "react-order-thumb" },
                      image ? h("img", { src: image, alt: item.name || order.id }) : h("span", null, "Imagem")
                    ),
                    h("div", null,
                      h("strong", null, item.name || order.id),
                      h("span", null, order.id),
                      h("small", null, `${orderStatusLabel(order.status)} | ${order.createdAt ? new Date(order.createdAt).toLocaleString("pt-BR") : ""}`)
                    ),
                    h("b", null, money(order.total))
                  ),
                  h("div", { className: "react-order-facts" },
                    h("span", null, h("b", null, "Pagamento"), orderPaymentLabel(order)),
                    h("span", null, h("b", null, "Frete"), orderShippingLabel(order)),
                    h("span", null, h("b", null, "Prazo"), orderDeliveryLabel(order))
                  ),
                  pending ? h("div", { className: "react-order-actions" },
                    h("small", null, paymentExpiryLabel(order) || "Aguardando pagamento"),
                    h("a", { className: "react-primary-link", href: order.payment.checkoutUrl }, "Concluir pagamento"),
                    h("button", { type: "button", className: "react-danger-button", onClick: () => cancelOrder(order.id) }, "Desistir da compra")
                  ) : null,
                  h("details", { className: "react-order-details" },
                    h("summary", null, "Ver detalhes"),
                    h("div", null,
                      h("span", null, h("b", null, "Itens"), (order.items || []).map((line) => `${Number(line.quantity || 1)}x ${line.name || line.productId}`).join(" | ")),
                      h("span", null, h("b", null, "Subtotal"), money(order.subtotal)),
                      Number(order.discount || 0) > 0 ? h("span", null, h("b", null, "Desconto"), money(order.discount)) : null,
                      h("span", null, h("b", null, "Frete"), money(order.shipping)),
                      h("span", null, h("b", null, "Total"), money(order.total))
                    )
                  )
                );
              })
            )
            : h("section", { className: "react-empty-cart" },
              h("span", { className: "material-symbols-rounded" }, "receipt_long"),
              h("h2", null, "Nenhum pedido ainda"),
              h("p", null, "Quando voce comprar, seus pedidos aparecem aqui."),
              h("a", { className: "react-buy", href: "/react" }, "Ver produtos")
            )
    );
  }

  function CartPage({ products, loading, setCount }) {
    const [items, setItems] = useState(cartItems());
    const [coupon, setCoupon] = useState("");
    const [couponResult, setCouponResult] = useState(null);
    const [address, setAddress] = useState(initialCartAddress);
    const [quotes, setQuotes] = useState([]);
    const [selectedQuoteId, setSelectedQuoteId] = useState("");
    const [shippingBenefit, setShippingBenefit] = useState(null);
    const [cartStatus, setCartStatus] = useState("");
    const [submitting, setSubmitting] = useState(false);

    useEffect(() => {
      const sync = () => setItems(cartItems());
      window.addEventListener("basa-cart-change", sync);
      return () => window.removeEventListener("basa-cart-change", sync);
    }, []);

    useEffect(() => {
      const zipCode = String(address.zipCode || "").replace(/\D/g, "");
      if (zipCode.length !== 8 || !items.length) {
        setQuotes([]);
        setSelectedQuoteId("");
        setShippingBenefit(null);
        return;
      }
      let active = true;
      setCartStatus("Calculando entrega...");
      fetch("/api/shipping/quote", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ zipCode, items: apiCartItems(items) })
      })
        .then(async (response) => {
          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(data.error || "Nao foi possivel calcular o frete.");
          return data;
        })
        .then((data) => {
          if (!active) return;
          const nextQuotes = data.quotes || [];
          setQuotes(nextQuotes);
          setShippingBenefit(data.shippingBenefit || null);
          setSelectedQuoteId((current) => current && nextQuotes.some((quote) => shippingQuoteId(quote) === current)
            ? current
            : shippingQuoteId(nextQuotes[0] || {}));
          setCartStatus(nextQuotes.length ? "" : data.shippingBenefit?.message || "Nenhuma opcao de entrega encontrada.");
        })
        .catch((error) => {
          if (!active) return;
          setQuotes([]);
          setSelectedQuoteId("");
          setShippingBenefit(null);
          setCartStatus(error.message);
        });
      return () => { active = false; };
    }, [address.zipCode, items]);

    useEffect(() => {
      const code = coupon.trim().toUpperCase();
      if (!code || !items.length) {
        setCouponResult(null);
        return;
      }
      let active = true;
      const timer = setTimeout(() => {
        fetch("/api/coupons/validate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code, items: apiCartItems(items) })
        })
          .then(async (response) => {
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.error || "Cupom invalido.");
            return data;
          })
          .then((data) => {
            if (active) setCouponResult(data);
          })
          .catch((error) => {
            if (active) setCouponResult({ valid: false, reason: error.message });
          });
      }, 450);
      return () => {
        active = false;
        clearTimeout(timer);
      };
    }, [coupon, items]);

    const enriched = items.map((item) => enrichCartItem(item, products));
    const subtotal = enriched.reduce((sum, item) => sum + Number(item.price || 0) * Number(item.quantity || 0), 0);
    const allFreeShipping = enriched.length > 0 && enriched.every((item) => item.sellerPaysShipping);
    const selectedQuote = quotes.find((quote) => shippingQuoteId(quote) === selectedQuoteId) || null;
    const freeShipping = Boolean(shippingBenefit?.freeShipping || allFreeShipping || (couponResult?.valid && couponResult?.coupon?.type === "free_shipping"));
    const discount = couponResult?.valid && couponResult?.coupon?.type === "percent"
      ? subtotal * Number(couponResult.coupon.value || 0) / 100
      : couponResult?.valid && couponResult?.coupon?.type && couponResult.coupon.type !== "free_shipping"
        ? Math.min(subtotal, Number(couponResult.coupon.value || 0))
        : 0;
    const shipping = freeShipping ? 0 : selectedQuote ? Number(selectedQuote.price || 0) : null;
    const total = Math.max(0, subtotal - discount) + Number(shipping || 0);
    const loggedIn = Boolean(customerSession()?.customer);

    const updateItems = (nextItems) => {
      saveCart(nextItems);
      setItems(nextItems);
      setCount(cartCount());
    };

    const changeQuantity = (index, quantity) => {
      const nextItems = items.map((item, itemIndex) => itemIndex === index ? { ...item, quantity } : item);
      updateItems(nextItems.filter((item) => Number(item.quantity || 0) > 0));
    };

    const removeItem = (index) => {
      updateItems(items.filter((_, itemIndex) => itemIndex !== index));
    };

    const updateAddress = (field, value) => {
      setAddress((current) => ({ ...current, [field]: field === "state" ? value.toUpperCase() : value }));
    };

    const lookupCep = async () => {
      const zipCode = String(address.zipCode || "").replace(/\D/g, "");
      if (zipCode.length !== 8) return;
      setCartStatus("Buscando CEP...");
      try {
        const response = await fetch(`/api/cep/${zipCode}`);
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || "CEP nao encontrado.");
        setAddress((current) => ({
          ...current,
          zipCode: data.zipCode || data.cep || zipCode,
          street: data.street || "",
          neighborhood: data.neighborhood || "",
          city: data.city || "",
          state: data.state || "",
          ibge: data.ibge || ""
        }));
        setCartStatus("");
      } catch (error) {
        setCartStatus(error.message || "Nao foi possivel consultar o CEP.");
      }
    };

    const checkout = async () => {
      const session = customerSession();
      if (!session?.customer) {
        setCartStatus("Entre na sua conta antes de finalizar a compra.");
        return;
      }
      if (!items.length || submitting) return;
      if (!freeShipping && !selectedQuote) {
        setCartStatus("Calcule e selecione uma opcao de entrega.");
        return;
      }
      setSubmitting(true);
      setCartStatus("Criando pedido...");
      const customer = {
        ...session.customer,
        zipCode: String(address.zipCode || "").replace(/\D/g, ""),
        number: address.number,
        complement: address.complement,
        street: address.street,
        neighborhood: address.neighborhood,
        city: address.city,
        state: address.state,
        ibge: address.ibge
      };
      try {
        const response = await fetch("/api/checkout", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            items: apiCartItems(items),
            customer,
            customerLoggedIn: true,
            shippingOption: selectedQuote,
            zipCode: customer.zipCode,
            coupon: coupon.trim().toUpperCase()
          })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || "Nao foi possivel criar o pedido.");
        saveCart([]);
        setItems([]);
        setCount(0);
        window.location.href = data.payment?.checkoutUrl || `/obrigado.html?pedido=${data.order?.id || ""}`;
      } catch (error) {
        setCartStatus(error.message || "Nao foi possivel criar o pedido.");
        setSubmitting(false);
      }
    };

    return h("main", { className: "react-cart-page" },
      h("section", { className: "react-cart-header" },
        h("p", null, "Carrinho"),
        h("h1", null, "Sua compra")
      ),
      loading
        ? h("section", { className: "react-detail-card" }, h("p", null, "Carregando carrinho..."))
        : enriched.length
          ? h(React.Fragment, null,
            h("section", { className: "react-cart-list" },
              enriched.map((item, index) => h("article", { className: "react-cart-item", key: `${item.id || item.slug || index}-${item.colorName || ""}` },
                h("a", { className: "react-cart-media", href: item.slug ? `/react/produto?slug=${encodeURIComponent(item.slug)}` : "/react" },
                  item.image ? h("img", { src: item.image, alt: item.name }) : h("span", null, "Imagem")
                ),
                h("div", { className: "react-cart-info" },
                  h("strong", null, item.name),
                  item.colorName ? h("span", null, `Cor: ${item.colorName}`) : null,
                  item.sellerPaysShipping ? h("em", null, "Frete gratis") : null,
                  h("b", null, money(Number(item.price || 0) * Number(item.quantity || 0)))
                ),
                h("div", { className: "react-cart-controls" },
                  h("select", {
                    value: Number(item.quantity || 1),
                    onChange: (event) => changeQuantity(index, Number(event.target.value))
                  }, Array.from({ length: 10 }, (_, optionIndex) =>
                    h("option", { key: optionIndex + 1, value: optionIndex + 1 }, optionIndex + 1)
                  )),
                  h("button", { type: "button", onClick: () => removeItem(index), "aria-label": "Remover item" },
                    h("span", { className: "material-symbols-rounded" }, "delete")
                  )
                )
              ))
            ),
            h("section", { className: "react-detail-card react-cart-delivery" },
              h("small", null, "Endereco da entrega"),
              h("div", { className: "react-cart-address-grid" },
                h("label", null,
                  h("span", null, "CEP"),
                  h("input", {
                    value: address.zipCode,
                    onChange: (event) => updateAddress("zipCode", cleanZip(event.target.value)),
                    onBlur: lookupCep,
                    placeholder: "Digite o CEP",
                    inputMode: "numeric"
                  })
                ),
                h("label", null,
                  h("span", null, "Numero"),
                  h("input", {
                    value: address.number,
                    onChange: (event) => updateAddress("number", event.target.value),
                    placeholder: "Numero da residencia"
                  })
                ),
                h("label", null,
                  h("span", null, "Complemento"),
                  h("input", {
                    value: address.complement,
                    onChange: (event) => updateAddress("complement", event.target.value),
                    placeholder: "Apto, bloco ou referencia"
                  })
                )
              ),
              addressLines(address).length ? h("div", { className: "react-destination-card" },
                h("strong", null, "Destino"),
                addressLines(address).map((line) => h("span", { key: line }, line))
              ) : null,
              h("label", null,
                h("span", null, "Cupom"),
                h("input", {
                  value: coupon,
                  onChange: (event) => setCoupon(event.target.value.toUpperCase()),
                  placeholder: "Ex: FRETE3D"
                })
              ),
              couponResult && h("p", { className: couponResult.valid ? "react-coupon-ok" : "react-coupon-error" },
                couponResult.valid ? "Cupom aplicado." : couponResult.reason || "Cupom invalido."
              ),
              h("div", { className: "react-shipping-options" },
                quotes.length
                  ? quotes.map((quote) => h("label", { className: "react-shipping-option", key: shippingQuoteId(quote) },
                    h("input", {
                      type: "radio",
                      name: "reactShippingOption",
                      checked: shippingQuoteId(quote) === selectedQuoteId,
                      onChange: () => setSelectedQuoteId(shippingQuoteId(quote))
                    }),
                    quote.logo ? h("img", { src: quote.logo, alt: quote.displayName || quote.carrier || "Entrega" }) : null,
                    h("span", null,
                      h("strong", null, quote.displayName || `${quote.carrier} ${quote.service}`),
                      h("small", null, quote.deliveryDays ? `${quote.deliveryDays} dias uteis` : "Prazo a confirmar")
                    ),
                    h("b", null, freeShipping ? "Gratis" : money(quote.price))
                  ))
                  : h("div", { className: "react-shipping-note" }, shippingBenefit?.message || cartStatus || "Informe o CEP para calcular a entrega.")
              )
            ),
            h("section", { className: "react-cart-summary" },
              h("div", null, h("span", null, "Subtotal"), h("strong", null, money(subtotal))),
              discount > 0 ? h("div", null, h("span", null, "Desconto"), h("strong", null, `-${money(discount)}`)) : null,
              h("div", null, h("span", null, "Frete"), h("strong", null, freeShipping ? "Gratis" : shipping === null ? "A calcular" : money(shipping))),
              h("div", null, h("span", null, "Total"), h("strong", null, money(total))),
              !loggedIn ? h("a", { className: "react-account-cta", href: "/react/conta?next=/react/carrinho" }, "Entrar ou criar conta") : null,
              h("button", { type: "button", onClick: checkout, disabled: submitting }, submitting ? "Processando..." : "Finalizar pedido"),
              cartStatus ? h("p", { className: "react-cart-status" }, cartStatus) : null
            )
          )
          : h("section", { className: "react-empty-cart" },
            h("span", { className: "material-symbols-rounded" }, "shopping_bag"),
            h("h2", null, "Seu carrinho esta vazio"),
            h("p", null, "Escolha um produto para continuar a compra."),
            h("a", { className: "react-buy", href: "/react" }, "Ver produtos")
          )
    );
  }

  function App() {
    const [products, setProducts] = useState([]);
    const [loading, setLoading] = useState(true);
    const [feed, setFeed] = useState("for-you");
    const [count, setCount] = useState(cartCount());

    useEffect(() => {
      let active = true;
      fetch("/api/products")
        .then((response) => response.json())
        .then((data) => {
          if (active) setProducts(data.products || []);
        })
        .catch(() => {
          if (active) setProducts([]);
        })
        .finally(() => {
          if (active) setLoading(false);
        });
      return () => { active = false; };
    }, []);

    useEffect(() => {
      const interval = setInterval(() => setCount(cartCount()), 1000);
      return () => clearInterval(interval);
    }, []);

    const isProductPage = window.location.pathname.startsWith("/react/produto");
    const isCartPage = window.location.pathname.startsWith("/react/carrinho");
    const isAccountPage = window.location.pathname.startsWith("/react/conta");
    const isProfilePage = window.location.pathname.startsWith("/react/perfil");
    const isOrdersPage = window.location.pathname.startsWith("/react/pedidos");
    const isRequestsPage = window.location.pathname.startsWith("/react/encomendas");
    const isChatPage = window.location.pathname.startsWith("/react/chat");

    if (isProductPage) {
      return h(React.Fragment, null,
        h(Topbar, { count, detail: true }),
        h(ProductDetail, { products, loading, setCount })
      );
    }

    if (isCartPage) {
      return h(React.Fragment, null,
        h(Topbar, { count, detail: true }),
        h(CartPage, { products, loading, setCount })
      );
    }

    if (isAccountPage) {
      return h(React.Fragment, null,
        h(Topbar, { count, detail: true }),
        h(AccountPage)
      );
    }

    if (isProfilePage) {
      return h(React.Fragment, null,
        h(Topbar, { count, detail: true }),
        h(ProfilePage)
      );
    }

    if (isOrdersPage) {
      return h(React.Fragment, null,
        h(Topbar, { count, detail: true }),
        h(OrdersPage, { products })
      );
    }

    if (isRequestsPage) {
      return h(React.Fragment, null,
        h(Topbar, { count, detail: true }),
        h(RequestsPage)
      );
    }

    if (isChatPage) {
      return h(React.Fragment, null,
        h(Topbar, { count, detail: true }),
        h(ChatPage)
      );
    }

    return h(React.Fragment, null,
      h(Topbar, { count, detail: false }),
      h(FeedTabs, { feed, setFeed }),
      h("main", null,
        h(Hero),
        loading
          ? h("section", { className: "react-section" }, h("p", null, "Carregando produtos..."))
          : h(ProductGrid, { products, feed })
      )
    );
  }

  ReactDOM.createRoot(document.getElementById("root")).render(h(App));
})();
