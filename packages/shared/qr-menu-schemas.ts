import { z } from "zod";

const hexColorSchema = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/, "Boja mora biti u obliku #RRGGBB");

export const updateQrMenuSettingsSchema = z.object({
  tagline: z.string().trim().max(200).nullable().optional(),
  coverImageUrl: z.string().trim().max(500).nullable().optional(),
  themePreset: z.enum(["LIGHT", "DARK", "WARM", "ELEGANT"]),
  accentColor: hexColorSchema.nullable().optional(),
  typographyPreset: z.enum(["ELEGANT", "MODERN", "CLASSIC", "CASUAL"]),
  cardStyle: z.enum(["IMAGE_DOMINANT", "BALANCED", "COMPACT"]),
  imageShape: z.enum(["ROUNDED", "SOFT", "SQUARE"]),
  isPublished: z.boolean(),
});
export type UpdateQrMenuSettingsInput = z.infer<typeof updateQrMenuSettingsSchema>;

// Lowercase letters/digits/hyphens only, no leading/trailing/double hyphen —
// this becomes a public URL segment (/m/{slug}), so it must be predictable
// and safe with no encoding surprises. Mirrors Tenant.slug's spirit but
// enforced here (Tenant's own slug has no such Zod-level check, it's
// seed-script-only) since this one IS reachable from an Admin form.
export const restaurantSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, "Adresa menija mora imati bar 3 znaka")
  .max(60, "Adresa menija je predugačka (max 60 znakova)")
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Dozvoljena su samo mala slova, brojevi i crtice (npr. stari-hrast)");

export const updateRestaurantSlugSchema = z.object({ slug: restaurantSlugSchema });
export type UpdateRestaurantSlugInput = z.infer<typeof updateRestaurantSlugSchema>;
