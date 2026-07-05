import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { defineUmecConfig, formatEmailFrom, umecConfigSchema } from "./config.js";

const validConfig = {
  schemaVersion: 1 as const,
  brand: {
    name: "Ume Syrup",
    url: "https://umesyrup.example.com",
    description: "Family-made ume syrup",
  },
  products: {
    "SYRUP-250": {
      name: "Ume Syrup 250ml",
      price: 1800,
      description: "Classic ume syrup",
    },
    "SYRUP-500": {
      name: "Ume Syrup 500ml",
      price: 3200,
      active: false,
    },
  },
  shipping: {
    tiers: [
      { maxUnits: 2, amount: 450, label: "宅急便コンパクト" },
      { amount: 850, label: "宅急便" },
    ],
    freeLabel: "送料無料",
  },
  email: {
    from: "orders@umesyrup.example.com",
    bcc: "owner@umesyrup.example.com",
    replyTo: "support@umesyrup.example.com",
  },
};

describe("defineUmecConfig", () => {
  it("accepts a valid config and applies defaults", () => {
    const config = defineUmecConfig(validConfig);

    expect(config.schemaVersion).toBe(1);
    expect(config.products["SYRUP-250"]?.active).toBe(true);
    expect(config.products["SYRUP-500"]?.active).toBe(false);
    expect(config.shipping?.tiers).toHaveLength(2);
  });

  it("accepts minimal optional fields", () => {
    const config = defineUmecConfig({
      schemaVersion: 1,
      brand: {
        name: "Minimal Shop",
        url: "https://shop.example.com",
      },
      products: {
        ITEM: {
          name: "Single Item",
          price: 1000,
        },
      },
      email: {
        from: "hello@shop.example.com",
      },
    });

    expect(config.brand.description).toBeUndefined();
    expect(config.email.bcc).toBeUndefined();
    expect(config.shipping).toBeUndefined();
  });

  it("accepts a single catch-all shipping tier", () => {
    const config = defineUmecConfig({
      ...validConfig,
      shipping: {
        tiers: [{ amount: 0, label: "送料込み" }],
        freeLabel: "送料無料",
      },
    });

    expect(config.shipping?.tiers).toEqual([{ amount: 0, label: "送料込み" }]);
  });

  it("accepts two shipping tiers with a final catch-all", () => {
    const config = defineUmecConfig(validConfig);

    expect(config.shipping?.tiers).toEqual([
      { maxUnits: 2, amount: 450, label: "宅急便コンパクト" },
      { amount: 850, label: "宅急便" },
    ]);
  });

  it("defaults product shippingUnits to 1", () => {
    const config = defineUmecConfig(validConfig);

    expect(config.products["SYRUP-250"]?.shippingUnits).toBe(1);
  });

  it("accepts an explicit product shippingUnits", () => {
    const config = defineUmecConfig({
      ...validConfig,
      products: {
        ...validConfig.products,
        "SYRUP-250": { ...validConfig.products["SYRUP-250"], shippingUnits: 2 },
      },
    });

    expect(config.products["SYRUP-250"]?.shippingUnits).toBe(2);
  });

  it("accepts a product with images", () => {
    const config = defineUmecConfig({
      ...validConfig,
      products: {
        ...validConfig.products,
        "SYRUP-250": { ...validConfig.products["SYRUP-250"], images: ["/images/syrup-250.jpg"] },
      },
    });

    expect(config.products["SYRUP-250"]?.images).toEqual(["/images/syrup-250.jpg"]);
  });

  it("leaves product images undefined when omitted", () => {
    const config = defineUmecConfig(validConfig);

    expect(config.products["SYRUP-250"]?.images).toBeUndefined();
  });

  it("accepts an email fromName", () => {
    const config = defineUmecConfig({
      ...validConfig,
      email: { ...validConfig.email, fromName: "emu" },
    });

    expect(config.email.fromName).toBe("emu");
  });

  it("leaves email fromName undefined when omitted", () => {
    const config = defineUmecConfig(validConfig);

    expect(config.email.fromName).toBeUndefined();
  });
});

describe("formatEmailFrom", () => {
  it("composes a display name with the address", () => {
    expect(formatEmailFrom({ from: "order@muraya.ma", fromName: "emu" })).toBe(
      "emu <order@muraya.ma>",
    );
  });

  it("returns the bare address when fromName is absent", () => {
    expect(formatEmailFrom({ from: "order@muraya.ma" })).toBe("order@muraya.ma");
  });
});

describe("umecConfigSchema validation errors", () => {
  it("rejects unsupported schemaVersion", () => {
    expect(() =>
      defineUmecConfig({
        ...validConfig,
        schemaVersion: 2,
      }),
    ).toThrow(ZodError);
  });

  it("rejects negative product price", () => {
    expect(() =>
      defineUmecConfig({
        ...validConfig,
        products: {
          "BAD-PRICE": {
            name: "Bad Price Item",
            price: -100,
          },
        },
      }),
    ).toThrow(/positive integer/i);
  });

  it("rejects zero product price", () => {
    expect(() =>
      defineUmecConfig({
        ...validConfig,
        products: {
          "ZERO-PRICE": {
            name: "Zero Price Item",
            price: 0,
          },
        },
      }),
    ).toThrow(/positive integer/i);
  });

  it("rejects non-positive product shippingUnits", () => {
    expect(() =>
      defineUmecConfig({
        ...validConfig,
        products: {
          ...validConfig.products,
          "SYRUP-250": { ...validConfig.products["SYRUP-250"], shippingUnits: 0 },
        },
      }),
    ).toThrow(/positive integer/i);
  });

  it("rejects non-integer product price", () => {
    expect(() =>
      defineUmecConfig({
        ...validConfig,
        products: {
          "FLOAT-PRICE": {
            name: "Float Price Item",
            price: 1299.5,
          },
        },
      }),
    ).toThrow(/integer/i);
  });

  it("rejects empty shipping tiers", () => {
    expect(() =>
      defineUmecConfig({
        ...validConfig,
        shipping: {
          tiers: [],
          freeLabel: "送料無料",
        },
      }),
    ).toThrow(/at least one tier/i);
  });

  it("rejects shipping tiers without a final catch-all", () => {
    expect(() =>
      defineUmecConfig({
        ...validConfig,
        shipping: {
          tiers: [
            { maxUnits: 2, amount: 450, label: "宅急便コンパクト" },
            { maxUnits: 4, amount: 850, label: "宅急便" },
          ],
          freeLabel: "送料無料",
        },
      }),
    ).toThrow(/final shipping tier must omit maxUnits/i);
  });

  it("rejects non-increasing shipping tier maxUnits", () => {
    expect(() =>
      defineUmecConfig({
        ...validConfig,
        shipping: {
          tiers: [
            { maxUnits: 2, amount: 450, label: "宅急便コンパクト" },
            { maxUnits: 2, amount: 850, label: "宅急便" },
            { amount: 1200, label: "大型便" },
          ],
          freeLabel: "送料無料",
        },
      }),
    ).toThrow(/strictly increasing/i);
  });

  it("rejects invalid email.from", () => {
    expect(() =>
      defineUmecConfig({
        ...validConfig,
        email: {
          from: "not-an-email",
        },
      }),
    ).toThrow(/valid email address/i);
  });

  it("rejects invalid email.bcc", () => {
    expect(() =>
      defineUmecConfig({
        ...validConfig,
        email: {
          ...validConfig.email,
          bcc: "invalid-bcc",
        },
      }),
    ).toThrow(/valid email address/i);
  });

  it("rejects invalid brand url", () => {
    expect(() =>
      defineUmecConfig({
        ...validConfig,
        brand: {
          ...validConfig.brand,
          url: "not-a-url",
        },
      }),
    ).toThrow(/valid URL/i);
  });

  it("rejects empty product SKU keys", () => {
    expect(() =>
      defineUmecConfig({
        ...validConfig,
        products: {
          "": {
            name: "Missing SKU",
            price: 1000,
          },
        },
      }),
    ).toThrow(/SKU must not be empty/i);
  });

  it("rejects missing required product name", () => {
    expect(() =>
      defineUmecConfig({
        ...validConfig,
        products: {
          "NO-NAME": {
            name: "",
            price: 1000,
          },
        },
      }),
    ).toThrow(/Product name is required/i);
  });

  it("rejects unknown keys (old shipping.freeThreshold)", () => {
    expect(() =>
      defineUmecConfig({
        ...validConfig,
        shipping: {
          tiers: [{ amount: 600, label: "送料" }],
          freeThreshold: 5000,
          freeLabel: "送料無料",
        },
      }),
    ).toThrow(ZodError);
  });
});

describe("umecConfigSchema", () => {
  it("exports a strict object schema", () => {
    expect(umecConfigSchema.shape.schemaVersion.value).toBe(1);
  });
});
