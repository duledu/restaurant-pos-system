export interface OrderItemModifier {
  id: string;
  modifierOptionId: string | null;
  groupName: string;
  optionName: string;
  priceDelta: string;
}
export interface OrderItem {
  id: string;
  menuItemId: string | null;
  name: string;
  price: string;
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

