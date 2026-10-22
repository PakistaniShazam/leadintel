import * as XLSX from "xlsx";

/**
 * Real CSV serialization — no library needed for this, but proper escaping
 * matters (embedded commas, quotes, newlines in company names/descriptions
 * are common in real business data, not edge cases to skip).
 */
export function exportLeadsToCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  const escape = (val: unknown): string => {
    if (val === null || val === undefined) return "";
    const str = val instanceof Date ? val.toISOString() : String(val);
    if (str.includes(",") || str.includes('"') || str.includes("\n")) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => escape(row[h])).join(","));
  }
  return lines.join("\n");
}

/** Real XLSX workbook generation via SheetJS. */
export function exportLeadsToXlsx(rows: Record<string, unknown>[]): Buffer {
  const worksheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Leads");
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
}
