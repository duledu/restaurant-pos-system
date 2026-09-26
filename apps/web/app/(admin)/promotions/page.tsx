import { PromotionsClient } from "./promotions-client";

export default function PromotionsPage() {
  return (
    <div className="w-full">
      <div className="mb-6 flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-ink">Promocije</h1>
          <p className="mt-1 text-sm text-ink/60">Happy Hour i druge vremenski zakazane promocije — cena se automatski primenjuje konobarima u zadatom terminu.</p>
        </div>
      </div>
      <PromotionsClient />
    </div>
  );
}
