// mcp-server/src/oms.ts

import type { CancelOrderResult, Order } from "./types.js";

const baseItems = [
  {
    id: "guitar-strat-black",
    sku: "STRAT-PLAYER-BLK",
    name: "Fender Player Stratocaster - Black",
    category: "Electric Guitar",
    quantity: 1,
    unitPrice: 799.99,
    subtotal: 799.99,
    imageUrl:
      "https://images.unsplash.com/photo-1511379938547-c1f69419868d?auto=format&fit=crop&w=400&q=80",
  },
  {
    id: "instrument-cables-10ft-2pk",
    sku: "INSTR-CABLE-10FT-2PK",
    name: "Instrument Cable 10ft (2-Pack)",
    category: "Cables",
    quantity: 2,
    unitPrice: 29.99,
    subtotal: 59.98,
    imageUrl:
      "https://images.unsplash.com/photo-1470229538611-16ba8c7ffbd7?auto=format&fit=crop&w=400&q=80",
  },
  {
    id: "boss-katana-50mkii",
    sku: "BOSS-KATANA-50MKII",
    name: 'BOSS Katana-50 MkII 1x12" 50W Combo Amp',
    category: "Amplifier",
    quantity: 1,
    unitPrice: 619.99,
    subtotal: 619.99,
    imageUrl:
      "https://images.unsplash.com/photo-1507878866276-a947ef722fee?auto=format&fit=crop&w=400&q=80",
  },
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
      country: "US",
    },
    payment: { method: "Visa", last4: "4242" },
    totals: { subtotal: 1479.96, shipping: 29, tax: 123.56, total: 1632.52, currency: "USD" },
    items: baseItems.map(item => ({ ...item })),
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
      country: "US",
    },
    payment: { method: "Visa", last4: "4242" },
    totals: { subtotal: 1479.96, shipping: 25, tax: 118.4, total: 1623.36, currency: "USD" },
    items: baseItems.map(item => ({ ...item })),
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
      country: "US",
    },
    payment: { method: "Mastercard", last4: "2020" },
    totals: { subtotal: 1479.96, shipping: 19, tax: 121.96, total: 1620.92, currency: "USD" },
    items: baseItems.map(item => ({ ...item })),
  },
];

const maybeDelay = async () => new Promise(resolve => setTimeout(resolve, 120));

export async function getOrderStatus(orderId: string): Promise<Order | null> {
  await maybeDelay();
  const order = mockOrders.find(o => o.orderId === orderId);
  return order ?? null;
}

// Mock cancel implementation kept for parity with downstream tooling expectations.
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
      order,
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
    order,
  };
}

export { mockOrders };
