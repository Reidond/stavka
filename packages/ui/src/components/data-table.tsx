import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";

export interface DataTableProps<TData> {
  readonly data: readonly TData[];
  readonly columns: readonly ColumnDef<TData, unknown>[];
  readonly emptyLabel?: string;
  readonly getRowId?: (row: TData, index: number) => string;
}

export const DataTable = <TData,>({
  data,
  columns,
  emptyLabel = "No records",
  getRowId,
}: DataTableProps<TData>) => {
  const table = useReactTable({
    data: [...data],
    columns: [...columns],
    getCoreRowModel: getCoreRowModel(),
    ...(getRowId ? { getRowId } : {}),
  });
  return (
    <div className="overflow-x-auto border border-contour">
      <table className="w-full border-collapse text-left">
        <thead className="bg-contour/40 font-data text-xs tracking-wider uppercase">
          {table.getHeaderGroups().map((group) => (
            <tr key={group.id}>
              {group.headers.map((header) => (
                <th key={header.id} className="border-b border-contour px-3 py-2">
                  {header.isPlaceholder
                    ? null
                    : flexRender(header.column.columnDef.header, header.getContext())}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => (
            <tr key={row.id} className="border-b border-contour/60 last:border-0">
              {row.getVisibleCells().map((cell) => (
                <td key={cell.id} className="px-3 py-2 text-sm">
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {data.length === 0 ? (
        <p className="m-0 px-3 py-6 text-center font-data text-xs text-ink/60 uppercase">
          {emptyLabel}
        </p>
      ) : null}
    </div>
  );
};

export type { ColumnDef } from "@tanstack/react-table";
