export type DnsDomainExportRow = [domain: string, plan: string, status: string];

export async function createDnsDomainWorkbook(sheet: string, header: DnsDomainExportRow, rows: DnsDomainExportRow[]): Promise<Blob> {
  const { default: writeExcelFile } = await import('write-excel-file/universal');
  return writeExcelFile([
    header.map(value => ({ value, fontWeight: 'bold' as const })),
    ...rows,
  ], { sheet, columns: [{ width: 46 }, { width: 30 }, { width: 18 }], stickyRowsCount: 1 }).toBlob();
}
