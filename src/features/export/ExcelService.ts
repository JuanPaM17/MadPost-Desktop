import * as XLSX from "xlsx-js-style";
import { save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";

export type ExcelSheet = { name: string; rows: Record<string, string | number | null>[]; headers?: string[] };
export type RawSheet = { name: string; ws: XLSX.WorkSheet };

class ExcelService {
  async exportRawSheets(filename: string, sheets: RawSheet[]): Promise<boolean> {
    const outputName = filename.endsWith(".xlsx") ? filename : `${filename}.xlsx`;
    const destination = await save({
      defaultPath: outputName,
      filters: [{ name: "Archivo de Excel", extensions: ["xlsx"] }],
    });
    if (!destination) return false;
    const workbook = XLSX.utils.book_new();
    for (const sheet of sheets) {
      XLSX.utils.book_append_sheet(workbook, sheet.ws, sheet.name.slice(0, 31));
    }
    const bytes = new Uint8Array(XLSX.write(workbook, { bookType: "xlsx", type: "array" }));
    await invoke("save_export_file", { path: destination, bytes: Array.from(bytes) });
    return true;
  }

  async exportWorkbook(filename: string, sheets: ExcelSheet[]): Promise<boolean> {
    const outputName = filename.endsWith(".xlsx") ? filename : `${filename}.xlsx`;
    const destination = await save({
      defaultPath: outputName,
      filters: [{ name: "Archivo de Excel", extensions: ["xlsx"] }],
    });

    if (!destination) return false;

    const workbook = XLSX.utils.book_new();
    for (const sheet of sheets) {
      const worksheet = XLSX.utils.json_to_sheet(sheet.rows);
      const headers = sheet.headers ?? Object.keys(sheet.rows[0] ?? {});
      if (sheet.rows.length === 0 && headers.length > 0) XLSX.utils.sheet_add_aoa(worksheet, [headers], { origin: "A1" });
      worksheet["!cols"] = headers.map((key) => ({ wch: Math.max(12, key.length + 2) }));
      for (let column = 0; column < headers.length; column += 1) {
        const address = XLSX.utils.encode_cell({ r: 0, c: column });
        const cell = worksheet[address];
        if (cell) {
          cell.s = {
            fill: { patternType: "solid", fgColor: { rgb: "6366F1" } },
            font: { bold: true, color: { rgb: "FFFFFF" } },
            border: { bottom: { style: "thin", color: { rgb: "4F46E5" } } },
          };
        }
      }
      XLSX.utils.book_append_sheet(workbook, worksheet, sheet.name.slice(0, 31));
    }
    const bytes = new Uint8Array(XLSX.write(workbook, { bookType: "xlsx", type: "array" }));
    await invoke("save_export_file", { path: destination, bytes: Array.from(bytes) });
    return true;
  }
}

export const excelService = new ExcelService();
