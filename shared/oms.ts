import { CancelOrderResult, Order } from "./types";

const baseItems = [
  {
    id: "guitar-electric",
    name: "Electric guitar",
    quantity: 1,
    unitPrice: 899,
    subtotal: 899,
    imageUrl:
      "https://images.unsplash.com/photo-1511379938547-c1f69419868d?auto=format&fit=crop&w=400&q=80"
  },
  {
    id: "instrument-cables",
    name: "Instrument cables (2-pack)",
    quantity: 2,
    unitPrice: 24.99,
    subtotal: 49.98,
    imageUrl:
      "https://images.unsplash.com/photo-1470229538611-16ba8c7ffbd7?auto=format&fit=crop&w=400&q=80"
  },
  {
    id: "guitar-amp",
    name: "Guitar amp",
    quantity: 1,
    unitPrice: 499,
    subtotal: 499,
    imageUrl:
      "https://images.unsplash.com/photo-1507878866276-a947ef722fee?auto=format&fit=crop&w=400&q=80"
  }
];

const mockOrders: Order[] = [
  {
    orderId: "1001",
    customerName: "Alex Rivera",
    status: "Shipped",
    carrier: "UPS",
    trackingNumber: "1Z999AA10123456784",
    eta: "2025-01-15",
    canCancel: false,
    placedAt: "2024-12-28T18:24:00.000Z",
    shippingMethod: "UPS Ground",
    shippingAddress: {
      line1: "123 Music Ave",
      line2: "Apt 4B",
      city: "Nashville",
      state: "TN",
      postalCode: "37201",
      country: "US"
    },
    payment: { method: "Visa", last4: "4242" },
    totals: { subtotal: 1447.98, shipping: 29, tax: 114, total: 1590.98, currency: "USD" },
    items: baseItems.map(item => ({ ...item }))
  },
  {
    orderId: "1002",
    customerName: "Jordan Lee",
    status: "Processing",
    carrier: null,
    trackingNumber: null,
    eta: "2025-01-10",
    canCancel: true,
    placedAt: "2025-01-02T15:18:00.000Z",
    shippingMethod: "FedEx Express Saver",
    shippingAddress: {
      line1: "22 Guitar Ln",
      line2: null,
      city: "Austin",
      state: "TX",
      postalCode: "73301",
      country: "US"
    },
    payment: { method: "Visa", last4: "4242" },
    totals: { subtotal: 1447.98, shipping: 25, tax: 116.5, total: 1589.48, currency: "USD" },
    items: baseItems.map(item => ({ ...item }))
  },
  {
    orderId: "1003",
    customerName: "Taylor Kim",
    status: "Delivered",
    carrier: "FedEx",
    trackingNumber: "999999999999",
    eta: "2025-01-05",
    canCancel: false,
    placedAt: "2024-12-20T12:05:00.000Z",
    shippingMethod: "FedEx Home Delivery",
    shippingAddress: {
      line1: "88 Stage Way",
      line2: null,
      city: "Seattle",
      state: "WA",
      postalCode: "98101",
      country: "US"
    },
    payment: { method: "Mastercard", last4: "2020" },
    totals: { subtotal: 1447.98, shipping: 19, tax: 120, total: 1586.98, currency: "USD" },
    items: baseItems.map(item => ({ ...item }))
  }
];

const maybeDelay = async () => new Promise(resolve => setTimeout(resolve, 120));

export async function getOrderStatus(orderId: string): Promise<Order | null> {
  await maybeDelay();
  const order = mockOrders.find(o => o.orderId === orderId);
  return order ?? null;
}

// Simple mock cancel implementation; returns success when cancellable, otherwise reasons.
export async function cancelOrder(
  orderId: string
): Promise<CancelOrderResult & { order?: Order }> {
  await maybeDelay();
  const order = mockOrders.find(o => o.orderId === orderId);
  if (!order) {
    return { success: false, reason: "ORDER_NOT_FOUND", orderId };
  }
  if (!order.canCancel) {
    return {
      success: false,
      reason: "NOT_CANCELLABLE",
      status: order.status,
      orderId,
      order
    };
  }
  order.status = "Cancelled";
  order.canCancel = false;
  order.carrier = null;
  order.trackingNumber = null;
  order.eta = null;
  const cancelledAt = new Date().toISOString();
  order.cancelledAt = cancelledAt;
  return {
    success: true,
    status: order.status,
    orderId,
    cancelledAt,
    order
  };
}

export { mockOrders };

/**
 * TODO: Replace mock implementations with real OMS API calls.
 * - Use your internal OMS endpoints and authentication.
 * - Map OMS response fields into the Order / CancelOrderResult shapes above.
 */
