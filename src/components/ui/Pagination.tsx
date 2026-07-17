import { ChevronLeft, ChevronRight } from "lucide-react";
import { COMMON_TEXT } from "../../constants/common-text";
import { Button } from "./Button";
import { Select } from "./Field";

export function Pagination({
  page,
  totalPages,
  pageSize,
  pageSizeOptions,
  totalItems,
  onPageChange,
  onPageSizeChange,
}: {
  page: number;
  totalPages: number;
  pageSize: number;
  pageSizeOptions: readonly number[];
  totalItems: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
}) {
  if (totalItems === 0) return null;

  const rangeStart = (page - 1) * pageSize + 1;
  const rangeEnd = Math.min(page * pageSize, totalItems);

  return (
    <div className="flex flex-col gap-3 rounded-b-xl border-t border-slate-100 bg-white px-4 py-3 md:grid md:grid-cols-3 md:items-center md:gap-4">
      <div className="flex items-center justify-between gap-4 md:justify-self-start">
        <span className="truncate text-xs text-slate-500">
          {COMMON_TEXT.pagination.showingRange(rangeStart, rangeEnd, totalItems)}
        </span>
        <label className="flex items-center gap-2.5 whitespace-nowrap text-xs font-medium text-slate-500">
          {COMMON_TEXT.pagination.rowsPerPage}
          <Select
            value={pageSize}
            onChange={(e) => onPageSizeChange(Number(e.target.value))}
            className="h-9 w-24 ps-3 pe-6"
            aria-label={COMMON_TEXT.pagination.rowsPerPage}
          >
            {pageSizeOptions.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </Select>
        </label>
      </div>

      <div className="flex items-center justify-center gap-2 md:justify-self-center">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => onPageChange(page - 1)}
          disabled={page <= 1}
          aria-label={COMMON_TEXT.pagination.prevPage}
        >
          <ChevronRight className="size-4" />
        </Button>
        <span className="min-w-24 text-center text-xs font-semibold text-slate-600">
          {COMMON_TEXT.pagination.pageOf(page, totalPages)}
        </span>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => onPageChange(page + 1)}
          disabled={page >= totalPages}
          aria-label={COMMON_TEXT.pagination.nextPage}
        >
          <ChevronLeft className="size-4" />
        </Button>
      </div>
    </div>
  );
}
