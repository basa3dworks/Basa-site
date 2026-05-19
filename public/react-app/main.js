(function () {
  const h = React.createElement;
  const { useEffect, useMemo, useState } = React;
  const CART_KEY = "basa_cart";

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
        id: product.id,
        slug: product.slug,
        name: product.name,
        price: product.price,
        image: productImage(product),
        quantity,
        colorName,
        colorHex: color?.hex || color?.color || ""
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
      h("a", { className: "round-icon cart-icon", href: "/", "aria-label": "Carrinho" },
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

  function ProductDetail({ products, loading, setCount }) {
    const wantedSlug = getQuery("slug") || "";
    const product = products.find((item) => String(item.slug || item.id) === wantedSlug) || null;
    const images = product ? productImages(product) : [];
    const colors = product ? getColors(product) : [];
    const [selectedImage, setSelectedImage] = useState(0);
    const [selectedColor, setSelectedColor] = useState(0);
    const [quantity, setQuantity] = useState(1);
    const [notice, setNotice] = useState("");

    useEffect(() => {
      setSelectedImage(0);
      setSelectedColor(0);
      setQuantity(1);
      setNotice("");
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
      setNotice(buyNow ? "Produto pronto no carrinho para finalizar." : "Produto adicionado ao carrinho.");
    };

    return h("main", { className: "react-product-page" },
      h("section", { className: "react-gallery" },
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
      )
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

    if (isProductPage) {
      return h(React.Fragment, null,
        h(Topbar, { count, detail: true }),
        h(ProductDetail, { products, loading, setCount })
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
