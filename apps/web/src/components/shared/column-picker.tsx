import { ChevronDown, ChevronUp, SlidersHorizontal } from '@/components/ui/icons';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { TableColumnsApi } from '@/hooks/use-table-columns';

/** "Columns" control for a list table: show/hide and reorder, saved per user. */
export function ColumnPicker<Row>({ columns, tableLabel }: { columns: TableColumnsApi<Row>; tableLabel: string }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" aria-label={`Choose ${tableLabel} columns`}>
          <SlidersHorizontal className="mr-2 h-4 w-4" />
          Columns
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-2">
        <p className="px-1 pb-2 text-xs font-medium text-muted-foreground">Show, hide and reorder columns</p>
        <ul className="space-y-0.5" aria-label={`${tableLabel} columns`}>
          {columns.all.map((column, index) => (
            <li key={column.key} className="flex items-center gap-1 rounded px-1 py-1 hover:bg-muted">
              <label className="flex flex-1 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={column.visible}
                  disabled={!column.canHide || columns.saving}
                  onChange={() => columns.toggle(column.key)}
                />
                <span className={column.canHide ? undefined : 'text-muted-foreground'}>{column.label}</span>
              </label>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                aria-label={`Move ${column.label} up`}
                disabled={index === 0 || columns.saving}
                onClick={() => columns.move(column.key, -1)}
              >
                <ChevronUp className="h-3.5 w-3.5" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                aria-label={`Move ${column.label} down`}
                disabled={index === columns.all.length - 1 || columns.saving}
                onClick={() => columns.move(column.key, 1)}
              >
                <ChevronDown className="h-3.5 w-3.5" />
              </Button>
            </li>
          ))}
        </ul>
        <div className="mt-2 border-t pt-2">
          <Button type="button" variant="ghost" size="sm" className="w-full" disabled={columns.saving} onClick={columns.reset}>
            Reset to default
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
