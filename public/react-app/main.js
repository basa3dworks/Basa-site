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

  function productRating(product) {
    const rating = product.rating || {};
    const average = Number(rating.average || product.ratingAverage || 0);
    const count = Number(rating.count || product.ratingCount || 0);
    if (!average) return null;
    return { average, count };
  }

  function Topbar({ count }) {
    return h("header", { className: "react-topbar" },
      h("button", { className: "round-icon", "aria-label": "Menu" }, h("span", { className: "material-symbols-rounded" }, "menu")),
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
    return h("a", { className: "react-product-card", href: `/produto.html?slug=${encodeURIComponent(product.slug || product.id)}` },
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

    return h(React.Fragment, null,
      h(Topbar, { count }),
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
