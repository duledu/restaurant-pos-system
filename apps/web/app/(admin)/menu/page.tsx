import { MenuManagementClient } from "./menu-client";

export default function MenuManagementPage() {
  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-6 flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-ink">Meni</h1>
          <p className="mt-1 text-sm text-ink/60">
            Cene, artikli i kategorije — izmene se odmah primenjuju u celom sistemu.
          </p>
        </div>
      </div>
      <MenuManagementClient />
    </div>
  );
}
