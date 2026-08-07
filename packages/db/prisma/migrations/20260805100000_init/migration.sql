-- Initial migration — Faza 1-3 (Tenant/Restaurant/Location/User/Employee/RBAC/
-- Device/AuditLog + MenuCategory/MenuItem + Floor/RestaurantTable/Shift/
-- Order/OrderItem/OrderEvent).
--
-- Poreklo ovog fajla: ručno izveden iz schema.prisma i primenjen/testiran
-- protiv realnog PostgreSQL servera (composite unique constraints, partial
-- unique indeks za smene, ON DELETE RESTRICT/CASCADE/SET NULL ponašanje —
-- sve provereno automatizovanim testovima u tests/integration/). Razlog: u
-- razvojnom okruženju u kom je pisan nije bilo mrežnog pristupa Prisma
-- engine binarnim fajlovima, pa `prisma migrate dev` nije mogao fizički da
-- generiše ovaj fajl automatski — sadržaj je identičan onome što bi
-- `prisma migrate dev` proizveo iz schema.prisma.
--
-- OD SADA NADALJE: koristi standardni `npm run db:migrate` (prisma migrate
-- dev) za sve buduće izmene šeme — Prisma će sam generisati nove migracije
-- iznad ove, uz normalno praćenje istorije.

CREATE TYPE "TenantStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'CANCELLED');
CREATE TYPE "RestaurantStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'ARCHIVED');
CREATE TYPE "EmployeeStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'TERMINATED');
CREATE TYPE "DeviceType" AS ENUM ('POS', 'KDS', 'BAR_DISPLAY', 'ADMIN');

CREATE TABLE "tenants" (
  "id" TEXT PRIMARY KEY,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL UNIQUE,
  "status" "TenantStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "tenants_status_idx" ON "tenants"("status");

CREATE TABLE "restaurants" (
  "id" TEXT PRIMARY KEY,
  "tenantId" TEXT NOT NULL REFERENCES "tenants"("id"),
  "name" TEXT NOT NULL,
  "legalName" TEXT,
  "timezone" TEXT NOT NULL DEFAULT 'Europe/Belgrade',
  "currency" TEXT NOT NULL DEFAULT 'RSD',
  "status" "RestaurantStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "createdBy" TEXT
);
CREATE INDEX "restaurants_tenantId_idx" ON "restaurants"("tenantId");
CREATE INDEX "restaurants_status_idx" ON "restaurants"("status");

CREATE TABLE "locations" (
  "id" TEXT PRIMARY KEY,
  "restaurantId" TEXT NOT NULL REFERENCES "restaurants"("id"),
  "name" TEXT NOT NULL,
  "address" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "locations_restaurantId_idx" ON "locations"("restaurantId");

CREATE TABLE "users" (
  "id" TEXT PRIMARY KEY,
  "email" TEXT NOT NULL UNIQUE,
  "passwordHash" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE TABLE "employees" (
  "id" TEXT PRIMARY KEY,
  "restaurantId" TEXT NOT NULL REFERENCES "restaurants"("id"),
  "userId" TEXT UNIQUE REFERENCES "users"("id") ON DELETE SET NULL,
  "firstName" TEXT NOT NULL,
  "lastName" TEXT NOT NULL,
  "pinHash" TEXT,
  "failedPinAttempts" INTEGER NOT NULL DEFAULT 0,
  "pinLockedUntil" TIMESTAMP(3),
  "status" "EmployeeStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "createdBy" TEXT
);
CREATE INDEX "employees_restaurantId_idx" ON "employees"("restaurantId");
CREATE INDEX "employees_status_idx" ON "employees"("status");

CREATE TABLE "employee_locations" (
  "employeeId" TEXT NOT NULL REFERENCES "employees"("id") ON DELETE CASCADE,
  "locationId" TEXT NOT NULL REFERENCES "locations"("id") ON DELETE CASCADE,
  "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
  PRIMARY KEY ("employeeId", "locationId")
);
CREATE INDEX "employee_locations_locationId_idx" ON "employee_locations"("locationId");

CREATE TABLE "roles" (
  "id" TEXT PRIMARY KEY,
  "restaurantId" TEXT NOT NULL REFERENCES "restaurants"("id"),
  "name" TEXT NOT NULL,
  "isSystem" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  UNIQUE ("restaurantId", "name")
);
CREATE INDEX "roles_restaurantId_idx" ON "roles"("restaurantId");

CREATE TABLE "permissions" (
  "id" TEXT PRIMARY KEY,
  "code" TEXT NOT NULL UNIQUE,
  "description" TEXT
);

CREATE TABLE "role_permissions" (
  "roleId" TEXT NOT NULL REFERENCES "roles"("id") ON DELETE CASCADE,
  "permissionId" TEXT NOT NULL REFERENCES "permissions"("id") ON DELETE CASCADE,
  PRIMARY KEY ("roleId", "permissionId")
);
CREATE INDEX "role_permissions_permissionId_idx" ON "role_permissions"("permissionId");

CREATE TABLE "employee_roles" (
  "employeeId" TEXT NOT NULL REFERENCES "employees"("id") ON DELETE CASCADE,
  "roleId" TEXT NOT NULL REFERENCES "roles"("id") ON DELETE CASCADE,
  "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
  PRIMARY KEY ("employeeId", "roleId")
);
CREATE INDEX "employee_roles_roleId_idx" ON "employee_roles"("roleId");

CREATE TABLE "devices" (
  "id" TEXT PRIMARY KEY,
  "restaurantId" TEXT NOT NULL REFERENCES "restaurants"("id"),
  "locationId" TEXT REFERENCES "locations"("id"),
  "name" TEXT NOT NULL,
  "deviceType" "DeviceType" NOT NULL DEFAULT 'POS',
  "registeredAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
  "isActive" BOOLEAN NOT NULL DEFAULT true
);
CREATE INDEX "devices_restaurantId_idx" ON "devices"("restaurantId");
CREATE INDEX "devices_locationId_idx" ON "devices"("locationId");

CREATE TABLE "audit_logs" (
  "id" TEXT PRIMARY KEY,
  "restaurantId" TEXT NOT NULL,
  "userId" TEXT,
  "role" TEXT,
  "entityType" TEXT NOT NULL,
  "entityId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "previousValue" JSONB,
  "newValue" JSONB,
  "reason" TEXT,
  "ipAddress" TEXT,
  "deviceId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now()
);
CREATE INDEX "audit_logs_restaurantId_idx" ON "audit_logs"("restaurantId");
CREATE INDEX "audit_logs_entityType_entityId_idx" ON "audit_logs"("entityType", "entityId");
CREATE INDEX "audit_logs_createdAt_idx" ON "audit_logs"("createdAt");

CREATE TYPE "CategoryType" AS ENUM ('FOOD', 'DRINK');
CREATE TYPE "PreparationStation" AS ENUM ('KITCHEN', 'BAR', 'KITCHEN_AND_BAR', 'NONE');

CREATE TABLE "menu_categories" (
  "id" TEXT PRIMARY KEY,
  "restaurantId" TEXT NOT NULL REFERENCES "restaurants"("id"),
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "type" "CategoryType" NOT NULL,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  UNIQUE ("restaurantId", "slug")
);
CREATE INDEX "menu_categories_restaurantId_idx" ON "menu_categories"("restaurantId");
CREATE INDEX "menu_categories_restaurantId_isActive_idx" ON "menu_categories"("restaurantId", "isActive");

CREATE TABLE "menu_items" (
  "id" TEXT PRIMARY KEY,
  "restaurantId" TEXT NOT NULL REFERENCES "restaurants"("id"),
  "categoryId" TEXT REFERENCES "menu_categories"("id") ON DELETE SET NULL,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "description" TEXT,
  "price" DECIMAL(12,2) NOT NULL,
  "taxRate" DECIMAL(5,2) NOT NULL DEFAULT 20,
  "quantity" DECIMAL(12,3),
  "unit" TEXT,
  "sku" TEXT,
  "barcode" TEXT,
  "purchasePrice" DECIMAL(12,2),
  "imageUrl" TEXT,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "isAvailable" BOOLEAN NOT NULL DEFAULT true,
  "trackStock" BOOLEAN NOT NULL DEFAULT false,
  "minimumStock" DECIMAL(12,3),
  "preparationStation" "PreparationStation" NOT NULL DEFAULT 'NONE',
  "needsReview" BOOLEAN NOT NULL DEFAULT false,
  "reviewNote" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "deletedAt" TIMESTAMP(3),
  UNIQUE ("restaurantId", "slug")
);
CREATE INDEX "menu_items_restaurantId_idx" ON "menu_items"("restaurantId");
CREATE INDEX "menu_items_restaurantId_isActive_idx" ON "menu_items"("restaurantId", "isActive");
CREATE INDEX "menu_items_categoryId_idx" ON "menu_items"("categoryId");
CREATE INDEX "menu_items_preparationStation_idx" ON "menu_items"("preparationStation");
CREATE TYPE "TableStatus" AS ENUM ('FREE', 'OCCUPIED', 'AWAITING_BILL', 'NEEDS_CLEANING');
CREATE TYPE "ShiftStatus" AS ENUM ('OPEN', 'CLOSED');
CREATE TYPE "OrderStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'ACCEPTED', 'PREPARING', 'READY', 'SERVED', 'COMPLETED', 'CANCELLED');
CREATE TYPE "OrderItemStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'ACCEPTED', 'PREPARING', 'READY', 'SERVED', 'CANCELLED');

CREATE TABLE "floors" (
  "id" TEXT PRIMARY KEY,
  "restaurantId" TEXT NOT NULL REFERENCES "restaurants"("id"),
  "locationId" TEXT NOT NULL REFERENCES "locations"("id"),
  "name" TEXT NOT NULL,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "floors_restaurantId_idx" ON "floors"("restaurantId");
CREATE INDEX "floors_locationId_idx" ON "floors"("locationId");

CREATE TABLE "restaurant_tables" (
  "id" TEXT PRIMARY KEY,
  "floorId" TEXT NOT NULL REFERENCES "floors"("id"),
  "label" TEXT NOT NULL,
  "capacity" INTEGER NOT NULL DEFAULT 2,
  "status" "TableStatus" NOT NULL DEFAULT 'FREE',
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "restaurant_tables_floorId_idx" ON "restaurant_tables"("floorId");
CREATE INDEX "restaurant_tables_status_idx" ON "restaurant_tables"("status");

CREATE TABLE "shifts" (
  "id" TEXT PRIMARY KEY,
  "restaurantId" TEXT NOT NULL REFERENCES "restaurants"("id"),
  "locationId" TEXT NOT NULL REFERENCES "locations"("id"),
  "openedBy" TEXT NOT NULL,
  "openedAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
  "openingCash" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "status" "ShiftStatus" NOT NULL DEFAULT 'OPEN',
  "closedBy" TEXT,
  "closedAt" TIMESTAMP(3)
);
CREATE INDEX "shifts_restaurantId_idx" ON "shifts"("restaurantId");
CREATE INDEX "shifts_locationId_idx" ON "shifts"("locationId");
CREATE INDEX "shifts_status_idx" ON "shifts"("status");

-- Partial unique index: samo JEDNA otvorena smena po lokaciji u datom
-- trenutku. Ovo je namerno IZVAN standardnog Prisma @@unique (koji ne
-- podržava WHERE klauzu) — primenjeno ručno u migraciji; u pravoj Prisma
-- migraciji ovo ide kao dodatni raw SQL blok u istoj migration.sql.
CREATE UNIQUE INDEX "shifts_one_open_per_location"
  ON "shifts" ("locationId")
  WHERE "status" = 'OPEN';

CREATE TABLE "orders" (
  "id" TEXT PRIMARY KEY,
  "restaurantId" TEXT NOT NULL REFERENCES "restaurants"("id"),
  "locationId" TEXT NOT NULL REFERENCES "locations"("id"),
  "tableId" TEXT NOT NULL REFERENCES "restaurant_tables"("id"),
  "shiftId" TEXT NOT NULL REFERENCES "shifts"("id"),
  "openedBy" TEXT NOT NULL,
  "guestCount" INTEGER,
  "status" "OrderStatus" NOT NULL DEFAULT 'DRAFT',
  "idempotencyKey" TEXT,
  "submittedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  UNIQUE ("restaurantId", "idempotencyKey")
);
CREATE INDEX "orders_restaurantId_idx" ON "orders"("restaurantId");
CREATE INDEX "orders_locationId_idx" ON "orders"("locationId");
CREATE INDEX "orders_tableId_idx" ON "orders"("tableId");
CREATE INDEX "orders_shiftId_idx" ON "orders"("shiftId");
CREATE INDEX "orders_status_idx" ON "orders"("status");
CREATE INDEX "orders_createdAt_idx" ON "orders"("createdAt");

CREATE TABLE "order_items" (
  "id" TEXT PRIMARY KEY,
  "orderId" TEXT NOT NULL REFERENCES "orders"("id"),
  "menuItemId" TEXT REFERENCES "menu_items"("id") ON DELETE SET NULL,
  "name" TEXT NOT NULL,
  "price" DECIMAL(12,2) NOT NULL,
  "taxRate" DECIMAL(5,2) NOT NULL,
  "quantity" INTEGER NOT NULL DEFAULT 1,
  "note" TEXT,
  "preparationStation" "PreparationStation" NOT NULL DEFAULT 'NONE',
  "status" "OrderItemStatus" NOT NULL DEFAULT 'DRAFT',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "order_items_orderId_idx" ON "order_items"("orderId");
CREATE INDEX "order_items_menuItemId_idx" ON "order_items"("menuItemId");
CREATE INDEX "order_items_status_idx" ON "order_items"("status");
CREATE INDEX "order_items_preparationStation_idx" ON "order_items"("preparationStation");

CREATE TABLE "order_events" (
  "id" TEXT PRIMARY KEY,
  "orderId" TEXT NOT NULL REFERENCES "orders"("id"),
  "type" TEXT NOT NULL,
  "payload" JSONB,
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now()
);
CREATE INDEX "order_events_orderId_idx" ON "order_events"("orderId");
CREATE INDEX "order_events_createdAt_idx" ON "order_events"("createdAt");
