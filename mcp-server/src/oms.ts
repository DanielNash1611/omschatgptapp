// mcp-server/src/oms.ts

import { CancelOrderResult, Order } from "../../shared/types";

const mockOrders: Order[] = [
  {
    orderId: "1001",
    customerName: "Alex Rivera",
    status: "Shipped",
    carrier: "UPS",
    trackingNumber: "1Z999AA10123456784",
    eta: "2025-01-15",
    canCancel: false
  },
  {
    orderId: "1002",
    customerName: "Jordan Lee",
    status: "Processing",
    carrier: null,
    trackingNumber: null,
    eta: "2025-01-10",
    canCancel: true
  },
  {
    orderId: "1003",
    customerName: "Taylor Kim",
    status: "Delivered",
    carrier: "FedEx",
    trackingNumber: "999999999999",
    eta: "2025-01-05",
    canCancel: false
  }
];

const maybeDelay = async () => new Promise(resolve => setTimeout(resolve, 120));

export async function getOrderStatus(orderId: string): Promise<Order | null> {
  await maybeDelay();
  const order = mockOrders.find(o => o.orderId === orderId);
  return order ?? null;
}

// Optional cancel; we won’t use it yet but it’s fine to keep
export async function cancelOrder(
  orderId: string
): Promise<CancelOrderResult & { orderId?: string; cancelledAt?: string }> {
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
      orderId
    };
  }
  order.status = "Cancelled";
  order.canCancel = false;
  return {
    success: true,
    status: order.status,
    orderId,
    cancelledAt: new Date().toISOString()
  };
}

export { mockOrders };
