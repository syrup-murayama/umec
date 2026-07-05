import { z } from "zod";

const skuKeySchema = z
  .string()
  .min(1, "Product SKU must not be empty");

const productSchema = z.strictObject({
  name: z.string().min(1, "Product name is required"),
  price: z
    .int("Product price must be an integer (JPY)")
    .positive("Product price must be a positive integer (JPY)"),
  description: z.string().optional(),
  active: z.boolean().default(true),
  shippingUnits: z
    .int("Product shippingUnits must be a positive integer")
    .positive("Product shippingUnits must be a positive integer")
    .default(1),
  images: z.array(z.string()).optional(),
});

const brandSchema = z.strictObject({
  name: z.string().min(1, "Brand name is required"),
  url: z.url("Brand url must be a valid URL"),
  description: z.string().optional(),
});

const shippingTierSchema = z.strictObject({
  maxUnits: z
    .int("Shipping tier maxUnits must be an integer")
    .positive("Shipping tier maxUnits must be a positive integer")
    .optional(),
  amount: z
    .int("Shipping tier amount must be an integer (JPY)")
    .nonnegative("Shipping tier amount must be a non-negative integer (JPY)"),
  label: z.string().min(1, "Shipping tier label must not be empty"),
});

const shippingSchema = z
  .strictObject({
    tiers: z.array(shippingTierSchema).min(1, "Shipping tiers must include at least one tier"),
    freeLabel: z.string().min(1, "Shipping freeLabel must not be empty"),
  })
  .superRefine((shipping, ctx) => {
    let previousMaxUnits: number | undefined;

    shipping.tiers.forEach((tier, index) => {
      const isLast = index === shipping.tiers.length - 1;

      if (isLast) {
        if (tier.maxUnits !== undefined) {
          ctx.addIssue({
            code: "custom",
            path: ["tiers", index, "maxUnits"],
            message: "The final shipping tier must omit maxUnits so it can act as the catch-all tier",
          });
        }
        return;
      }

      if (tier.maxUnits === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["tiers", index, "maxUnits"],
          message: "Every shipping tier before the final catch-all tier must define maxUnits",
        });
        return;
      }

      if (previousMaxUnits !== undefined && tier.maxUnits <= previousMaxUnits) {
        ctx.addIssue({
          code: "custom",
          path: ["tiers", index, "maxUnits"],
          message: `Shipping tier maxUnits must be strictly increasing; tier ${index} has ${tier.maxUnits} after ${previousMaxUnits}`,
        });
      }

      previousMaxUnits = tier.maxUnits;
    });
  });

const emailSchema = z.strictObject({
  from: z.email("Email from must be a valid email address"),
  fromName: z.string().min(1, "Email fromName must not be empty").optional(),
  bcc: z.email("Email bcc must be a valid email address").optional(),
  replyTo: z.email("Email replyTo must be a valid email address").optional(),
});

export const umecConfigSchema = z.strictObject({
  schemaVersion: z.literal(1),
  brand: brandSchema,
  products: z.record(skuKeySchema, productSchema),
  shipping: shippingSchema.optional(),
  email: emailSchema,
});

export type UmecConfig = z.infer<typeof umecConfigSchema>;
export type UmecConfigInput = z.input<typeof umecConfigSchema>;
export type UmecProduct = z.infer<typeof productSchema>;
export type UmecShipping = z.infer<typeof shippingSchema>;

/**
 * Validates and returns a typed umec.config.ts object.
 * Applies defaults (e.g. product.active = true).
 */
export function defineUmecConfig(config: unknown): UmecConfig {
  return umecConfigSchema.parse(config);
}

/**
 * Formats an email config's from address with an optional display name,
 * e.g. { from: "order@example.com", fromName: "emu" } -> "emu <order@example.com>".
 */
export function formatEmailFrom(email: { from: string; fromName?: string }): string {
  return email.fromName ? `${email.fromName} <${email.from}>` : email.from;
}
