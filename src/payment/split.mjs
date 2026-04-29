export function money(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

export function calculateSplit({ subtotal, sellerAccountId, marketplaceAccountId, commissionPercent, paymentFeePercent, paymentFeeFixed }) {
  const gross = money(subtotal);
  const gatewayFee = money(gross * (paymentFeePercent / 100) + paymentFeeFixed);
  const marketplaceCommission = money(gross * (commissionPercent / 100));
  const sellerAmount = money(gross - gatewayFee - marketplaceCommission);

  return {
    gross,
    gatewayFee,
    marketplaceCommission,
    sellerAmount,
    allocations: [
      {
        accountId: marketplaceAccountId,
        role: "marketplace",
        amount: marketplaceCommission
      },
      {
        accountId: sellerAccountId,
        role: "seller",
        amount: sellerAmount
      }
    ]
  };
}

export async function createPaymentIntent({ provider, order, settings, baseUrl }) {
  const split = calculateSplit({
    subtotal: order.subtotal,
    sellerAccountId: order.seller.paymentAccountId,
    marketplaceAccountId: settings.marketplaceAccountId,
    commissionPercent: settings.storeCommissionPercent,
    paymentFeePercent: settings.paymentFeePercent,
    paymentFeeFixed: settings.paymentFeeFixed
  });

  if (provider === "mercado-pago") {
    const accessToken = process.env.MERCADO_PAGO_ACCESS_TOKEN;
    if (!accessToken) {
      throw Object.assign(new Error("Configure MERCADO_PAGO_ACCESS_TOKEN no arquivo .env."), { status: 500 });
    }

    const preference = await createMercadoPagoPreference({ accessToken, order, settings, baseUrl });
    return {
      provider,
      status: "pending_payment",
      paymentId: preference.id,
      checkoutUrl: preference.sandbox_init_point || preference.init_point,
      initPoint: preference.init_point,
      sandboxInitPoint: preference.sandbox_init_point,
      split,
      note: "Checkout Pro criado no Mercado Pago. O pedido aguardara confirmacao de pagamento ate configurarmos webhooks."
    };
  }

  if (provider === "stripe") {
    return {
      provider,
      status: "pending_credentials",
      split,
      note: "Configure STRIPE_SECRET_KEY e use PaymentIntent com transfer_data.destination e application_fee_amount."
    };
  }

  return {
    provider: "mock",
    status: "approved",
    paymentId: `mock_${order.id}`,
    checkoutUrl: `/obrigado.html?pedido=${order.id}`,
    split
  };
}

async function createMercadoPagoPreference({ accessToken, order, settings, baseUrl }) {
  const origin = String(baseUrl || "http://localhost:3000").replace(/\/$/, "");
  const isPublicHttps = origin.startsWith("https://");
  const preference = {
    external_reference: order.id,
    statement_descriptor: "BASA 3D WORKS",
    items: order.items.map((item) => ({
      id: item.productId,
      title: item.name,
      quantity: item.quantity,
      unit_price: item.unitPrice,
      currency_id: settings.currency || "BRL"
    })),
    shipments: {
      cost: order.shipping,
      mode: "not_specified"
    },
    payer: {
      name: order.customer.name,
      email: order.customer.email,
      phone: {
        number: order.customer.phone
      },
      identification: {
        type: order.customer.document?.length > 11 ? "CNPJ" : "CPF",
        number: order.customer.document
      },
      address: {
        zip_code: order.customer.address.zipCode,
        street_name: order.customer.address.street,
        street_number: order.customer.address.number
      }
    },
    back_urls: {
      success: `${origin}/obrigado.html?pedido=${encodeURIComponent(order.id)}&status=approved`,
      pending: `${origin}/obrigado.html?pedido=${encodeURIComponent(order.id)}&status=pending`,
      failure: `${origin}/obrigado.html?pedido=${encodeURIComponent(order.id)}&status=failure`
    },
    metadata: {
      order_id: order.id,
      shipping_provider: order.shippingOption?.provider || "none",
      shipping_service: order.shippingOption?.service || "none",
      promotion_reason: order.promotion?.reason || "none"
    }
  };

  if (isPublicHttps) {
    preference.notification_url = `${origin}/api/webhooks/mercado-pago`;
  }

  const response = await fetch("https://api.mercadopago.com/checkout/preferences", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(preference)
  });

  const data = await response.json();
  if (!response.ok) {
    throw Object.assign(new Error(data.message || "Nao foi possivel criar o checkout no Mercado Pago."), {
      status: response.status,
      details: data
    });
  }

  return data;
}
