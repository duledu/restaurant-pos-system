export const ROLE_LABEL: Record<string, string> = {
  OWNER: "Vlasnik",
  ADMIN: "Administrator",
  MANAGER: "Menadžer",
  WAITER: "Konobar",
  KITCHEN: "Kuhinja",
  BAR: "Šank",
  INVENTORY_MANAGER: "Magacin",
};

/** Role ponuđene pri KREIRANJU novog zaposlenog — namerno bez OWNER (retka,
 * osetljiva radnja van obima jednostavne forme) i bez ADMIN (dodaje se
 * kasnije kroz izmenu ako zatreba). Vidi role-labels korišćenje u izmeni
 * postojećeg zaposlenog za pun skup. */
export const CREATE_ROLE_OPTIONS = ["WAITER", "KITCHEN", "BAR", "MANAGER"] as const;

/** Pun skup — koristi se pri IZMENI postojećeg zaposlenog, gde upravljanje
 * vlasništvom/administratorskim nalozima ima smisla i zaštićeno je
 * assertSafeManagementChange proverom na serveru. */
export const EDIT_ROLE_OPTIONS = ["OWNER", "ADMIN", "MANAGER", "WAITER", "KITCHEN", "BAR", "INVENTORY_MANAGER"] as const;
