export interface ReadyItem {
  id: string;
  name: string;
}
export interface Table {
  id: string;
  label: string;
  capacity: number;
  status: "FREE" | "OCCUPIED" | "AWAITING_BILL" | "NEEDS_CLEANING";
  // Hitna ispravka: employeeId konobara koji trenutno vodi aktivnu
  // porudžbinu na ovom stolu (null ako nema aktivne porudžbine) — vidi
  // table-service.ts listTables. Nikad ime/lični podaci, samo ID za
  // poređenje sa sopstvenim nalogom PRE navigacije.
  activeOrderOwnerId: string | null;
  // FAZA 10: stavke SPREMNE za preuzimanje na aktivnoj porudžbini ovog
  // stola (prazan niz kad nema nijedne) — vidi table-service.ts listTables.
  readyItems: ReadyItem[];
}

export interface FloorWithTables {
  id: string;
  name: string;
  tables: Table[];
}
export interface Shift {
  id: string;
  status: string;
}

