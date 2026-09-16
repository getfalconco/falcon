import React, { useState, useRef, useEffect, useCallback } from "react";
import { cn } from "@/lib/utils";
import { motion } from "framer-motion";
import { toast } from "sonner";

/**
 * Spreadsheet-style data grid: click / shift-click / drag to select ranges,
 * row and column headers select whole lines, Ctrl+C copies the selection as
 * TSV, and the toolbar exports the grid as CSV.
 *
 * Adapted from the shadcn-style source for this app: the upstream `<style jsx>`
 * block is Next.js-only, so drag-select suppression uses Tailwind's
 * `select-none` instead.
 */

interface ExcelTableProps {
  data: string[][];
  headers?: string[];
  editable?: boolean;
  className?: string;
  /** Toolbar heading. */
  title?: string;
  /** Base name for the CSV export (".csv" is appended). */
  exportName?: string;
  onCellChange?: (row: number, col: number, value: string) => void;
}

interface SelectionRange {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

export const ExcelTable: React.FC<ExcelTableProps> = ({
  data,
  headers,
  editable = false,
  className,
  title = "Excel Table",
  exportName = "table-data",
  onCellChange,
}) => {
  const [selectedCells, setSelectedCells] = useState<Set<string>>(new Set());
  const [selectionRange, setSelectionRange] = useState<SelectionRange | null>(null);
  const [editingCell, setEditingCell] = useState<{ row: number; col: number } | null>(null);
  const [editValue, setEditValue] = useState("");
  const [draggedCell, setDraggedCell] = useState<{ row: number; col: number } | null>(null);
  const [isSelecting, setIsSelecting] = useState(false);
  const tableRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const getCellKey = (row: number, col: number) => `${row}-${col}`;

  const updateSelectedCells = (range: SelectionRange) => {
    const cells = new Set<string>();
    const minRow = Math.min(range.startRow, range.endRow);
    const maxRow = Math.max(range.startRow, range.endRow);
    const minCol = Math.min(range.startCol, range.endCol);
    const maxCol = Math.max(range.startCol, range.endCol);

    for (let r = minRow; r <= maxRow; r++) {
      for (let c = minCol; c <= maxCol; c++) {
        cells.add(getCellKey(r, c));
      }
    }
    setSelectedCells(cells);
  };

  const handleCellClick = (row: number, col: number, e: React.MouseEvent) => {
    e.stopPropagation();

    // Don't interfere with double-click.
    if (e.detail === 2) return;

    if (e.shiftKey && selectionRange) {
      const newRange: SelectionRange = {
        startRow: selectionRange.startRow,
        startCol: selectionRange.startCol,
        endRow: row,
        endCol: col,
      };
      setSelectionRange(newRange);
      updateSelectedCells(newRange);
    } else if (e.detail === 1) {
      const newRange = { startRow: row, startCol: col, endRow: row, endCol: col };
      setSelectionRange(newRange);
      updateSelectedCells(newRange);
    }
  };

  const handleCellDoubleClick = (row: number, col: number, e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();

    // Stop any ongoing drag selection.
    setIsSelecting(false);
    setDraggedCell(null);

    if (editable) {
      setEditingCell({ row, col });
      setEditValue(data[row]?.[col] || "");
    }
  };

  const handleRowHeaderClick = (rowIndex: number, e: React.MouseEvent) => {
    e.stopPropagation();
    const newRange: SelectionRange = {
      startRow: rowIndex,
      startCol: 0,
      endRow: rowIndex,
      endCol: (data[0]?.length || 1) - 1,
    };
    setSelectionRange(newRange);
    updateSelectedCells(newRange);
  };

  const handleColHeaderClick = (colIndex: number, e: React.MouseEvent) => {
    e.stopPropagation();
    const newRange: SelectionRange = {
      startRow: 0,
      startCol: colIndex,
      endRow: data.length - 1,
      endCol: colIndex,
    };
    setSelectionRange(newRange);
    updateSelectedCells(newRange);
  };

  const handleTableHeaderClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    const newRange: SelectionRange = {
      startRow: 0,
      startCol: 0,
      endRow: data.length - 1,
      endCol: (data[0]?.length || 1) - 1,
    };
    setSelectionRange(newRange);
    updateSelectedCells(newRange);
  };

  const handleMouseDown = (row: number, col: number, e: React.MouseEvent) => {
    e.preventDefault(); // Prevent native text selection.
    e.stopPropagation();

    const clearSelection = () => {
      const selection = window.getSelection();
      if (selection) selection.removeAllRanges();
    };

    clearSelection();
    // Clear again next tick to catch any delayed selection.
    setTimeout(clearSelection, 0);

    setIsSelecting(true);
    setDraggedCell({ row, col });

    const newRange = { startRow: row, startCol: col, endRow: row, endCol: col };
    setSelectionRange(newRange);
    updateSelectedCells(newRange);
  };

  const handleMouseEnter = (row: number, col: number) => {
    if (isSelecting && draggedCell) {
      const newRange: SelectionRange = {
        startRow: draggedCell.row,
        startCol: draggedCell.col,
        endRow: row,
        endCol: col,
      };
      setSelectionRange(newRange);
      updateSelectedCells(newRange);
    }
  };

  const handleMouseUp = () => {
    setIsSelecting(false);
    setDraggedCell(null);
  };

  const handleEditSubmit = () => {
    if (editingCell && onCellChange) {
      onCellChange(editingCell.row, editingCell.col, editValue);
    }
    setEditingCell(null);
    setEditValue("");
  };

  const handleEditKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleEditSubmit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      setEditingCell(null);
      setEditValue("");
    }
  };

  const copyToClipboard = useCallback(async () => {
    if (selectedCells.size === 0) return;

    const sortedCells = Array.from(selectedCells)
      .map((key) => {
        const [row, col] = key.split("-").map(Number);
        return { row, col, value: data[row]?.[col] || "" };
      })
      .sort((a, b) => a.row - b.row || a.col - b.col);

    const rows = new Map<number, string[]>();
    sortedCells.forEach((cell) => {
      if (!rows.has(cell.row)) rows.set(cell.row, []);
      rows.get(cell.row)!.push(cell.value);
    });

    const clipboardText = Array.from(rows.values())
      .map((row) => row.join("\t"))
      .join("\n");

    const copyText = async (text: string): Promise<boolean> => {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        try {
          const textArea = document.createElement("textarea");
          textArea.value = text;
          textArea.style.position = "fixed";
          textArea.style.left = "-999999px";
          textArea.style.top = "-999999px";
          document.body.appendChild(textArea);
          textArea.focus();
          textArea.select();
          const successful = document.execCommand("copy");
          document.body.removeChild(textArea);
          return successful;
        } catch (err) {
          console.error("Failed to copy text:", err);
          return false;
        }
      }
    };

    // Report what actually happened — the upstream version announces success
    // without waiting for the copy to resolve.
    const copied = await copyText(clipboardText);
    if (copied) {
      toast.success(
        `Copied ${selectedCells.size} cell${selectedCells.size > 1 ? "s" : ""} to clipboard`,
      );
    } else {
      toast.error("Could not copy to the clipboard");
    }
  }, [selectedCells, data]);

  const exportToCSV = useCallback(() => {
    const escape = (cell: string) => `"${String(cell).replace(/"/g, '""')}"`;
    const csvContent = [
      ...(headers ? [headers.map(escape).join(",")] : []),
      ...data.map((row) => row.map(escape).join(",")),
    ].join("\n");

    const blob = new Blob([csvContent], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${exportName}.csv`;
    a.click();
    URL.revokeObjectURL(url);

    toast.success(`Exported ${exportName}.csv`);
  }, [data, headers, exportName]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "c") {
        void copyToClipboard();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [copyToClipboard]);

  useEffect(() => {
    const handleGlobalMouseUp = () => {
      setIsSelecting(false);
      setDraggedCell(null);
    };

    const handleGlobalSelectionChange = () => {
      if (isSelecting) {
        const selection = window.getSelection();
        if (selection && selection.toString()) selection.removeAllRanges();
      }
    };

    const suppressWhileSelecting = (e: Event) => {
      if (isSelecting) {
        e.preventDefault();
        e.stopPropagation();
        return false;
      }
    };

    document.addEventListener("mouseup", handleGlobalMouseUp);
    document.addEventListener("selectionchange", handleGlobalSelectionChange);
    document.addEventListener("selectstart", suppressWhileSelecting, true);
    document.addEventListener("dragstart", suppressWhileSelecting, true);

    return () => {
      document.removeEventListener("mouseup", handleGlobalMouseUp);
      document.removeEventListener("selectionchange", handleGlobalSelectionChange);
      document.removeEventListener("selectstart", suppressWhileSelecting, true);
      document.removeEventListener("dragstart", suppressWhileSelecting, true);
    };
  }, [isSelecting]);

  useEffect(() => {
    if (editingCell && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
      setTimeout(() => {
        if (inputRef.current) {
          inputRef.current.focus();
          inputRef.current.select();
        }
      }, 0);
    }
  }, [editingCell]);

  const isCellSelected = (row: number, col: number) => selectedCells.has(getCellKey(row, col));

  const isRowSelected = (row: number) => {
    for (let col = 0; col < (data[0]?.length || 0); col++) {
      if (!selectedCells.has(getCellKey(row, col))) return false;
    }
    return selectedCells.size > 0;
  };

  const isColSelected = (col: number) => {
    for (let row = 0; row < data.length; row++) {
      if (!selectedCells.has(getCellKey(row, col))) return false;
    }
    return selectedCells.size > 0;
  };

  return (
    <div className={cn("w-full", className)} ref={tableRef}>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void copyToClipboard()}
            className="cursor-pointer rounded bg-secondary px-3 py-1 text-xs text-secondary-foreground transition-colors hover:bg-secondary/80"
          >
            Copy (Ctrl+C)
          </button>
          <button
            type="button"
            onClick={exportToCSV}
            className="cursor-pointer rounded bg-primary px-3 py-1 text-xs text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Export CSV
          </button>
        </div>
      </div>

      <div
        className={cn(
          "overflow-hidden rounded-lg border border-border bg-background",
          isSelecting && "select-none",
        )}
      >
        <div className="max-h-96 overflow-auto">
          <table className="w-full border-collapse">
            <thead className="sticky top-0 z-10">
              <tr className="bg-muted">
                <th
                  onClick={handleTableHeaderClick}
                  className="h-8 w-12 cursor-pointer border border-border bg-muted text-xs font-medium text-muted-foreground hover:bg-muted/70"
                >
                  #
                </th>
                {headers?.map((header, colIndex) => (
                  <th
                    key={colIndex}
                    onClick={(e) => handleColHeaderClick(colIndex, e)}
                    className={cn(
                      "h-8 min-w-24 cursor-pointer border border-border bg-muted px-2 text-left text-xs font-medium text-muted-foreground hover:bg-muted/70",
                      isColSelected(colIndex) && "border-b-2 border-t-2 border-primary",
                    )}
                  >
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.map((row, rowIndex) => (
                <motion.tr
                  key={rowIndex}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: Math.min(rowIndex, 20) * 0.02 }}
                  className={cn(
                    "hover:bg-muted/30",
                    isRowSelected(rowIndex) && "border-l-2 border-r-2 border-primary",
                  )}
                >
                  <td
                    onClick={(e) => handleRowHeaderClick(rowIndex, e)}
                    className="h-8 w-12 cursor-pointer border border-border bg-muted/50 text-center text-xs font-medium text-muted-foreground hover:bg-muted/70"
                  >
                    {rowIndex + 1}
                  </td>
                  {row.map((cell, colIndex) => (
                    <td
                      key={colIndex}
                      className={cn(
                        "relative h-8 min-w-24 cursor-pointer border border-border px-2 font-mono text-xs",
                        "transition-colors hover:bg-muted/50",
                        isCellSelected(rowIndex, colIndex) && "border-2 border-primary bg-primary/5",
                        editingCell?.row === rowIndex && editingCell?.col === colIndex && "p-0",
                      )}
                      onClick={(e) => handleCellClick(rowIndex, colIndex, e)}
                      onDoubleClick={(e) => handleCellDoubleClick(rowIndex, colIndex, e)}
                      onMouseDown={(e) => handleMouseDown(rowIndex, colIndex, e)}
                      onMouseEnter={() => handleMouseEnter(rowIndex, colIndex)}
                      onMouseUp={handleMouseUp}
                    >
                      {editingCell?.row === rowIndex && editingCell?.col === colIndex ? (
                        <input
                          ref={inputRef}
                          type="text"
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onBlur={handleEditSubmit}
                          onKeyDown={handleEditKeyDown}
                          onMouseDown={(e) => e.stopPropagation()}
                          className="h-full w-full border-0 bg-background px-2 text-xs outline-none focus:outline-none focus:ring-0"
                          autoFocus
                        />
                      ) : (
                        <span className="block truncate">{cell}</span>
                      )}
                    </td>
                  ))}
                </motion.tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="mt-1.5 text-[10px] text-muted-foreground">
        {selectedCells.size > 0 && (
          <span>
            {selectedCells.size} cell{selectedCells.size > 1 ? "s" : ""} selected
          </span>
        )}
        <span className="ml-4">
          Click / shift-click / drag to select • Ctrl+C to copy
          {editable && " • Double-click to edit"}
        </span>
      </div>
    </div>
  );
};
