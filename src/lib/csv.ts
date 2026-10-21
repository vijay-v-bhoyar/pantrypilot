import { z } from "zod";
import { validDate } from "./dates";
const row = z.object({
  sku: z.string().min(1).max(80),
  name: z.string().min(1).max(120),
  quantity: z.number().int().min(1).max(100000),
  expiresAt: z.string().refine(validDate).optional(),
});
export function previewInventoryCsv(value: string) {
  if (value.length > 50000) throw new Error("CSV must be under 50 KB.");
  const records: string[][] = [];
  let fields: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === '"') {
      if (quoted && value[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = !quoted;
    } else if (c === "," && !quoted) {
      fields.push(field);
      field = "";
    } else if ((c === "\n" || c === "\r") && !quoted) {
      if (c === "\r" && value[i + 1] === "\n") i++;
      fields.push(field);
      if (fields.some(Boolean)) records.push(fields);
      fields = [];
      field = "";
    } else field += c;
  }
  if (quoted) throw new Error("Unclosed CSV quote.");
  fields.push(field);
  if (fields.some(Boolean)) records.push(fields);
  const header = records.shift();
  if (header?.join(",") !== "sku,name,quantity,expiresAt")
    throw new Error("Expected header: sku,name,quantity,expiresAt");
  if (!records.length || records.length > 100)
    throw new Error("Import between one and 100 lots.");
  return records.map((fields, i) => {
    if (fields.length !== 4)
      throw new Error(`Row ${i + 2}: expected four fields.`);
    if (fields.some((f) => /^[=+@]/.test(f)))
      throw new Error(
        `Row ${i + 2}: spreadsheet formula prefixes are not accepted.`,
      );
    const parsed = row.safeParse({
      sku: fields[0],
      name: fields[1],
      quantity: Number(fields[2]),
      expiresAt: fields[3] || undefined,
    });
    if (!parsed.success)
      throw new Error(`Row ${i + 2}: invalid SKU, quantity or expiry.`);
    return parsed.data;
  });
}
