// Isolated visual QA only. Never imported by a Next route or written to a DB.
import React from "react";
import { createRoot } from "react-dom/client";
import { PublicMenuView, type PublicMenuPayload } from "../../apps/web/app/m/[slug]/public-menu-view";

const menu: PublicMenuPayload = {
  restaurant: { name: "Restoran MASA", tagline: "Restaurant & Bar", coverImageUrl: "/assets/breakfast.jpg", logoUrl: null },
  theme: { themePreset: "DARK", typographyPreset: "ELEGANT", accentColor: null, cardStyle: "BALANCED", imageShape: "SOFT" },
  table: { label: "7" },
  categories: [
    { id: "breakfast", name: "Doručak", type: "FOOD", items: [
      { id: "omelette", name: "Omlet", description: "Izbor za početak dana", price: "150", imageUrl: "/assets/breakfast.jpg", isAvailable: true, preparationStation: "KITCHEN" },
      { id: "cheese", name: "Omlet sa sirom", description: "Topao doručak iz naše kuhinje", price: "200", imageUrl: "/assets/breakfast.jpg", isAvailable: true, preparationStation: "KITCHEN" },
      { id: "soup", name: "Pileća čorba", description: null, price: "200", imageUrl: null, isAvailable: false, preparationStation: "KITCHEN" },
      { id: "bacon", name: "Omlet sa slaninom", description: "Za dobro jutro, bez žurbe.", price: "200", imageUrl: "/assets/breakfast.jpg", isAvailable: true, preparationStation: "KITCHEN" },
      { id: "ham", name: "Omlet sa šunkom", description: null, price: "200", imageUrl: "/assets/breakfast.jpg", isAvailable: true, preparationStation: "KITCHEN" },
    ] },
    { id: "starters", name: "Topla predjela", type: "FOOD", items: [
      { id: "vegetables", name: "Grilovano povrće", description: null, price: "300", imageUrl: "/assets/salad.jpg", isAvailable: true, preparationStation: "KITCHEN" },
      { id: "mushrooms", name: "Pečurke na žaru", description: null, price: "300", imageUrl: null, isAvailable: true, preparationStation: "KITCHEN" },
    ] },
    { id: "grill", name: "Roštilj", type: "FOOD", items: [
      { id: "long", name: "Punjena pljeskavica sa kajmakom i pršutom", description: "Dugačak naziv za proveru preloma teksta i stabilnog položaja cene.", price: "890", imageUrl: "/assets/pasta.jpg", isAvailable: true, preparationStation: "KITCHEN" },
      { id: "noimage", name: "Ćevapi", description: null, price: "650", imageUrl: null, isAvailable: true, preparationStation: "KITCHEN" },
    ] },
    { id: "salads", name: "Salate", type: "FOOD", items: [
      { id: "salad", name: "Šopska salata", description: null, price: "300", imageUrl: "/assets/salad.jpg", isAvailable: true, preparationStation: "KITCHEN" },
    ] },
    { id: "coffee", name: "Topli napici", type: "DRINK", items: [
      { id: "espresso", name: "Espresso", description: null, price: "180", imageUrl: "/assets/coffee.jpg", isAvailable: true, preparationStation: "BAR" },
      { id: "cappuccino", name: "Cappuccino", description: null, price: "220", imageUrl: "/assets/coffee.jpg", isAvailable: true, preparationStation: "BAR" },
    ] },
    { id: "wine", name: "Vino", type: "DRINK", items: [
      { id: "red", name: "Crveno vino", description: null, price: "450", imageUrl: "/assets/wine.jpg", isAvailable: true, preparationStation: "BAR" },
      { id: "white", name: "Belo vino", description: null, price: "450", imageUrl: null, isAvailable: false, preparationStation: "BAR" },
    ] },
  ],
};

const root = createRoot(document.getElementById("root")!);
const query = new URLSearchParams(location.search);
async function main() {
  const data: PublicMenuPayload = query.has("real") ? await fetch("/real-menu.json").then(response => response.json()) : structuredClone(menu);
  if (query.has("theme")) data.theme.themePreset = query.get("theme") as PublicMenuPayload["theme"]["themePreset"];
  if (query.has("font")) data.theme.typographyPreset = query.get("font") as PublicMenuPayload["theme"]["typographyPreset"];
  if (query.has("broken")) { data.restaurant.coverImageUrl = "/missing-cover.jpg"; data.categories[0].items[0].imageUrl = "/missing-dish.jpg"; }
  if (query.has("empty")) data.categories = [];
  if (query.has("preview")) root.render(<div style={{ width: 380, maxWidth: "100%", margin: "24px auto", height: 680, overflowY: "auto", border: "8px solid #333", borderRadius: 28 }}><PublicMenuView menu={data} /></div>);
  else root.render(<PublicMenuView menu={data} />);
}
void main();
