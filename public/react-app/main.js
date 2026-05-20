(function () {
  const h = React.createElement;
  const { useEffect, useMemo, useState } = React;
  const CART_KEY = "basa_cart";
  const CUSTOMER_SESSION_KEY = "basa_customer_session";
  const DELIVERY_ADDRESSES_KEY = "basa_delivery_addresses";
  const SELECTED_DELIVERY_ADDRESS_KEY = "basa_selected_delivery_address";

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

  function addressKey(address = {}) {
    return [address.zipCode, address.number, address.complement].map((value) => String(value || "").trim().toLowerCase()).join("|");
  }

  function addressLines(address = {}) {
    const zip = cleanZip(address.zipCode);
    const lineOne = [address.street, address.number].filter(Boolean).join(", ");
    const lineTwo = [address.neighborhood, address.city && address.state ? `${address.city}/${address.state}` : address.city || address.state].filter(Boolean).join(" - ");
    const complement = address.complement ? `Complemento: ${address.complement}` : "";
    const zipLine = zip.length === 8 ? `CEP ${zip.replace(/^(\d{5})(\d{3})$/, "$1-$2")}` : "";
    return [lineOne, lineTwo, complement, zipLine].filter(Boolean);
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

  function loadDeliveryAddresses() {
    try {
      return JSON.parse(localStorage.getItem(DELIVERY_ADDRESSES_KEY) || "[]").filter((address) => address?.zipCode).slice(0, 3);
    } catch {
      return [];
    }
  }

  function saveDeliveryAddresses(addresses) {
    localStorage.setItem(DELIVERY_ADDRESSES_KEY, JSON.stringify(addresses.slice(0, 3)));
  }

  function selectedDeliveryAddress() {
    try {
      return JSON.parse(localStorage.getItem(SELECTED_DELIVERY_ADDRESS_KEY) || "null");
    } catch {
      return null;
    }
  }

  function initialCartAddress() {
    const selected = selectedDeliveryAddress();
    if (selected?.zipCode) return selected;
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
    return h("header", { className: "react-topbar" },
      detail
        ? h("a", { className: "round-icon", href: "/react", "aria-label": "Voltar" }, h("span", { className: "material-symbols-rounded" }, "arrow_back"))
        : h("button", { className: "round-icon", "aria-label": "Menu" }, h("span", { className: "material-symbols-rounded" }, "menu")),
      h("label", { className: "react-search" },
        h("input", { placeholder: "Buscar na Basa 3D Works", readOnly: true })
      ),
      h("a", { className: "round-icon", href: "/?panel=chat#produtos", "aria-label": "Chat" },
        h("span", { className: "material-symbols-rounded" }, "forum")
      ),
      h("a", { className: "round-icon cart-icon", href: "/react/carrinho", "aria-label": "Carrinho" },
        h("span", { className: "material-symbols-rounded" }, "shopping_bag"),
        h("b", null, count)
      )
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

  function CartPage({ products, loading, setCount }) {
    const [items, setItems] = useState(cartItems());
    const [coupon, setCoupon] = useState("");
    const [couponResult, setCouponResult] = useState(null);
    const [address, setAddress] = useState(initialCartAddress);
    const [addressMode, setAddressMode] = useState(() => selectedDeliveryAddress() || accountDeliveryAddress() ? "saved" : "manual");
    const [savedAddresses, setSavedAddresses] = useState(loadDeliveryAddresses);
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
    const principalAddress = accountDeliveryAddress();
    const addressOptions = [
      ...(principalAddress ? [principalAddress] : []),
      ...savedAddresses.filter((item) => !principalAddress || addressKey(item) !== addressKey(principalAddress))
    ];
    const activeAddressKey = addressKey(address);
    const isManual = addressMode === "manual";
    const canSaveAddress = isManual
      && cleanZip(address.zipCode).length === 8
      && Boolean(address.number)
      && Boolean(address.complement)
      && !addressOptions.some((item) => addressKey(item) === addressKey(address))
      && savedAddresses.length < 3;
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
      setAddressMode("manual");
      localStorage.removeItem(SELECTED_DELIVERY_ADDRESS_KEY);
      setAddress((current) => ({ ...current, [field]: field === "state" ? value.toUpperCase() : value }));
    };

    const useAddress = (nextAddress) => {
      setAddress({ ...nextAddress });
      setAddressMode("saved");
      localStorage.setItem(SELECTED_DELIVERY_ADDRESS_KEY, JSON.stringify(nextAddress));
      setCartStatus("");
    };

    const startNewAddress = () => {
      setAddress({
        zipCode: "",
        number: "",
        complement: "",
        street: "",
        neighborhood: "",
        city: "",
        state: "",
        ibge: ""
      });
      setAddressMode("manual");
      localStorage.removeItem(SELECTED_DELIVERY_ADDRESS_KEY);
      setCartStatus("Digite um novo CEP para calcular a entrega.");
    };

    const saveCurrentAddress = () => {
      if (!canSaveAddress) return;
      const normalized = { ...address, zipCode: cleanZip(address.zipCode), principal: false };
      const next = [normalized, ...savedAddresses.filter((item) => addressKey(item) !== addressKey(normalized))].slice(0, 3);
      saveDeliveryAddresses(next);
      setSavedAddresses(next);
      useAddress(normalized);
      setCartStatus("Endereco salvo para este carrinho.");
    };

    const removeSavedAddress = (addressToRemove) => {
      const next = savedAddresses.filter((item) => addressKey(item) !== addressKey(addressToRemove));
      saveDeliveryAddresses(next);
      setSavedAddresses(next);
      if (activeAddressKey === addressKey(addressToRemove)) {
        const fallback = principalAddress || next[0];
        if (fallback) useAddress(fallback);
        else startNewAddress();
      }
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
                    placeholder: "01128010",
                    inputMode: "numeric"
                  })
                ),
                h("label", null,
                  h("span", null, "Numero"),
                  h("input", {
                    value: address.number,
                    onChange: (event) => updateAddress("number", event.target.value),
                    placeholder: "107"
                  })
                ),
                h("label", null,
                  h("span", null, "Complemento"),
                  h("input", {
                    value: address.complement,
                    onChange: (event) => updateAddress("complement", event.target.value),
                    placeholder: "Apto 154"
                  })
                )
              ),
              addressOptions.length ? h("div", { className: "react-address-book" },
                addressOptions.map((item, index) => {
                  const active = addressKey(item) === activeAddressKey;
                  return h("article", { className: active ? "active" : "", key: `${addressKey(item)}-${index}` },
                    h("strong", null, item.principal ? "Destino principal" : active ? "Destino atual" : `Endereco ${index + 1}`),
                    addressLines(item).map((line) => h("span", { key: line }, line)),
                    h("div", { className: "react-address-actions" },
                      h("button", { type: "button", onClick: () => useAddress(item) }, "Usar este endereco"),
                      !item.principal ? h("button", { type: "button", onClick: () => removeSavedAddress(item) }, "Remover") : null
                    )
                  );
                })
              ) : null,
              addressLines(address).length ? h("div", { className: "react-destination-card" },
                h("strong", null, "Destino"),
                addressLines(address).map((line) => h("span", { key: line }, line))
              ) : null,
              h("div", { className: "react-address-extra-actions" },
                addressMode !== "manual" && savedAddresses.length < 3
                  ? h("button", { type: "button", onClick: startNewAddress }, "Usar outro endereco")
                  : null,
                canSaveAddress ? h("button", { type: "button", onClick: saveCurrentAddress }, "Salvar este endereco") : null
              ),
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
