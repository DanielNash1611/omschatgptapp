export interface ShippingAddress {
  line1: string;
  line2?: string | null;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}

export interface PaymentSummary {
  method?: string | null;
  last4?: string | null;
}

export interface OrderTotals {
  subtotal?: number;
  shipping?: number;
  tax?: number;
  total?: number;
  currency?: string;
}

export interface OrderItem {
  id: string;
  name: string;
  quantity: number;
  unitPrice: number;
  subtotal?: number;
  imageUrl?: string;
}

export interface Order {
  orderId: string;
  customerName: string;
  status: string;
  carrier: string | null;
  trackingNumber: string | null;
  eta: string | null;
  canCancel: boolean;
  cancelledAt?: string | null;
  placedAt?: string | null;
  shippingMethod?: string | null;
  shippingAddress?: ShippingAddress | null;
  payment?: PaymentSummary | null;
  totals?: OrderTotals | null;
  items?: OrderItem[];
}

export type CancelOrderFailureReason =
  | "ORDER_NOT_FOUND"
  | "NOT_CANCELLABLE"
  | "CONFIRMATION_REQUIRED"
  | "CONFIRMATION_EXPIRED"
  | "INVALID_CONFIRMATION"
  | "INVALID_PHRASE";

export interface CancelOrderResult {
  success: boolean;
  status?: string;
  reason?: CancelOrderFailureReason;
  cancelledAt?: string;
  orderId?: string;
}
