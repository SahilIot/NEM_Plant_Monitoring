// Excel export helper used by the logbook and event log.
export default function useExcelExport(ctx) {
  const { confirm, setExportError, setExporting, asset, assetId } = ctx;

  const exportExcel = async ({
    rows,
    headers,
    sheetName,
    fileName,
    confirmMessage,
  }) => {
    if (
      !(await confirm(confirmMessage, {
        title: "Export Excel file",
        confirmLabel: "Download",
      }))
    )
      return;
    setExportError("");
    setExporting(true);
    try {
      const XLSX = await import("@e965/xlsx");
      const worksheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
      XLSX.writeFile(workbook, fileName);
    } catch (error) {
      setExportError(error.message || "Could not export the Excel file.");
    } finally {
      setExporting(false);
    }
  };

  const exportFileDate = new Date().toISOString().slice(0, 10);

  const assetFileName =
    (asset?.name || `asset-${assetId}`)
      .replace(/[^a-z0-9-_]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase() || `asset-${assetId}`;

  return {
    exportExcel,
    exportFileDate,
    assetFileName,
  };
}
