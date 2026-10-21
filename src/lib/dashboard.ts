import { z } from "zod";
export const analysisPrompts = [
  "Show me recovery and funds",
  "Show pantry readiness",
  "Review available funds",
  "Review distribution evidence",
  "What needs attention first?",
  "Why are pending refunds not spendable?",
] as const;
export const focusSchema = z.enum([
  "readiness",
  "funds",
  "recovery",
  "evidence",
]);
const widget = z
  .object({
    type: z.enum([
      "pantry-readiness",
      "pantry-funds",
      "pantry-recovery",
      "pantry-evidence",
    ]),
    dataMapping: z.object({}).strict(),
    format: z.object({}).strict().optional(),
  })
  .strict();
const layout = z
  .object({
    xTrack: z.number().int().min(0).max(24),
    yTrack: z.number().int().min(0).max(500),
    xSpan: z.number().int().min(1).max(24),
    ySpan: z.number().int().min(1).max(100),
  })
  .strict();
export const studioStateSchema = z
  .object({
    pages: z
      .array(
        z
          .object({
            id: z.string().max(100),
            widgets: z.record(z.string().max(100), widget),
            widgetLayout: z.record(z.string().max(100), layout),
          })
          .strict(),
      )
      .min(1)
      .max(5),
    selectedPageId: z.string().max(100),
    version: z.string().max(30).optional(),
  })
  .strict();
export const dashboardDefinition = z
  .object({
    focus: focusSchema,
    period: z.enum(["all", "week", "month"]),
    studio: studioStateSchema.optional(),
  })
  .strict();
export type Focus = z.infer<typeof focusSchema>;
export function dashboardState(focus: Focus) {
  const types = [
    focus,
    ...(["readiness", "funds", "recovery", "evidence"] as Focus[]).filter(
      (f) => f !== focus,
    ),
  ];
  return {
    pages: [
      {
        id: "operations",
        widgets: Object.fromEntries(
          types.map((type, index) => [
            `widget-${index}`,
            { type: `pantry-${type}`, dataMapping: {}, format: {} },
          ]),
        ),
        widgetLayout: Object.fromEntries(
          types.map((_, i) => [
            `widget-${i}`,
            {
              xTrack: (i % 2) * 12,
              yTrack: Math.floor(i / 2) * 14,
              xSpan: 12,
              ySpan: 14,
            },
          ]),
        ),
      },
    ],
    selectedPageId: "operations",
  };
}
