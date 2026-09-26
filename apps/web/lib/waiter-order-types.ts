export interface OrderItemModifier {
  id: string;
  modifierOptionId: string | null;
  groupName: string;
  optionName: string;
  priceDelta: string;
}
export interface OrderItem {
  submittedAt?: string | null;
  id: string;
  menuItemId: string | null;
  name: string;
  price: string;
  regularPrice?: string | null;
  promotionId?: string | null;
  promotionName?: string | null;
  promotionType?: "PERCENTAGE_DISCOUNT" | "FIXED_PRICE" | null;
  promotionValue?: string | null;
  quantity: number;
  note: string | null;
  status: "DRAFT" | "SUBMITTED" | "ACCEPTED" | "PREPARING" | "READY" | "SERVED" | "CANCELLED";
  modifiers: OrderItemModifier[];
  localStatus?: "pending" | "failed";
}

export interface OrderData {
  id: string;
  status: string;
  guestCount: number | null;
  items: OrderItem[];
  table: { label: string };
}

