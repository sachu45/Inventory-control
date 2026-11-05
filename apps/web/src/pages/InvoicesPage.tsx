import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Download, Plus } from '@/components/ui/icons';
import { toast } from 'sonner';
import { AppLayout } from '@/components/AppLayout';
import { StatusBadge } from '@/components/StatusBadge';
import { CreatePageLayout, DocumentReferenceSelect, PageHeader } from '@/components/shared';
import { DocumentRowActions } from '@/components/shared/DocumentRowActions';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CustomFieldsSection } from '@/components/shared/custom-fields-section';
import { useCustomFieldForm, withCustomFieldColumns } from '@/hooks/use-custom-fields';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useCustomers } from '@/hooks/use-customers';
import { useCreateInvoice, useInvoices, type Invoice } from '@/hooks/use-invoices';
import { useTableColumns } from '@/hooks/use-table-columns';
import { ColumnPicker } from '@/components/shared/column-picker';
import type { TableColumn } from '@/lib/table-columns';
import { useModuleFields } from '@/hooks/use-module-config';
import { useSalesOrders } from '@/hooks/use-sales-orders';
import { csvDate, csvMoney, exportModuleCsv } from '@/lib/module-csv';
import { formatCustomerOption, formatSalesOrderOption } from '@/lib/document-display';
import { getApiErrorMessage } from '@/lib/api-error';
import { fieldLabel, missingFieldsMessage, visibleCsvColumns } from '@/lib/module-field-ui';

const FIELD_LABELS: Record<string, string> = { dueDate: 'Due Date', remarks: 'Remarks' };

const INVOICE_COLUMNS: TableColumn<Invoice>[] = [
  { key: 'invoiceNumber', label: 'Invoice', locked: true, cell: (inv) => inv.invoiceNumber },
  { key: 'invoiceDate', label: 'Date', cell: (inv) => new Date(inv.invoiceDate).toLocaleDateString() },
  { key: 'customer', label: 'Customer', cell: (inv) => inv.customer?.customerName ?? '-' },
  { key: 'status', label: 'Status', cell: (inv) => <StatusBadge status={inv.status} /> },
  { key: 'total', label: 'Total', cell: (inv) => Number(inv.totalValue ?? 0).toFixed(2) },
  { key: 'paid', label: 'Paid', cell: (inv) => Number(inv.paidValue ?? 0).toFixed(2) },
  { key: 'actions', label: 'Actions', locked: true, headClassName: 'text-right', cell: (inv) => <DocumentRowActions kind="invoice" id={inv.id} /> },
];

const emptyForm = () => ({
  customerId: '',
  salesOrderId: '',
  totalValue: '0',
  dueDate: '',
  remarks: '',
});

export function InvoicesPage({ createOnly = false }: { createOnly?: boolean }) {
  const navigate = useNavigate();
  const { data: invoices = [] } = useInvoices();
  const { data: customers = [] } = useCustomers();
  const { data: salesOrders = [] } = useSalesOrders();
  const createInvoice = useCreateInvoice();
  const [form, setForm] = useState(emptyForm);
  const fields = useModuleFields('invoices');
  const customFieldForm = useCustomFieldForm('invoices');
  const invoiceColumns = useMemo(() => withCustomFieldColumns(INVOICE_COLUMNS, customFieldForm.fields), [customFieldForm.fields]);
  const columns = useTableColumns('invoices', invoiceColumns);

  const onCreate = async () => {
    if (!form.customerId) {
      toast.error('Select a customer');
      return;
    }
    const missing = missingFieldsMessage(fields.missing(form), FIELD_LABELS);
    if (missing) {
      toast.error(missing);
      return;
    }
    if (!customFieldForm.validate()) return;
    // The invoice belongs to the order's (or customer's) plant, not the user's home plant.
    const linkedOrder = salesOrders.find((so) => so.id === form.salesOrderId);
    const shopId = linkedOrder?.shopId ?? customers.find((c) => c.id === form.customerId)?.shopId;
    try {
      await createInvoice.mutateAsync({
        shopId,
        customerId: form.customerId,
        salesOrderId: form.salesOrderId || undefined,
        totalValue: Number(form.totalValue),
        dueDate: fields.isHidden('dueDate') ? undefined : form.dueDate || undefined,
        remarks: fields.isHidden('remarks') ? undefined : form.remarks || undefined,
        ...customFieldForm.payload(),
      });
      toast.success('Invoice created');
      if (createOnly) {
        navigate('/invoices');
      } else {
        setForm(emptyForm());
        customFieldForm.reset();
      }
    } catch (err: unknown) {
      if (customFieldForm.showApiErrors(err)) return;
      toast.error(getApiErrorMessage(err, 'Failed to create invoice'));
    }
  };

  const handleExportInvoices = () => {
    const ok = exportModuleCsv('invoices.csv', invoices, visibleCsvColumns([
      { header: 'Invoice Number', value: (invoice) => invoice.invoiceNumber },
      { header: 'Invoice Date', value: (invoice) => csvDate(invoice.invoiceDate) },
      { header: 'Due Date', field: 'dueDate', value: (invoice) => csvDate(invoice.dueDate) },
      { header: 'Customer', value: (invoice) => invoice.customer?.customerName ?? '' },
      { header: 'Sales Order', value: (invoice) => invoice.salesOrder?.soNumber ?? '' },
      { header: 'Status', value: (invoice) => invoice.status },
      { header: 'Total Value', value: (invoice) => csvMoney(invoice.totalValue) },
      { header: 'Paid Value', value: (invoice) => csvMoney(invoice.paidValue) },
      { header: 'Remarks', field: 'remarks', value: (invoice) => invoice.remarks ?? '' },
    ], fields.isHidden));
    if (ok) toast.success('Invoices exported');
    else toast.error('No invoices to export');
  };

  const createForm = (
    <Card>
      <CardHeader>
        <CardTitle>Invoice Details</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <Label>Customer</Label>
          <DocumentReferenceSelect
            items={customers}
            value={form.customerId}
            onValueChange={(customerId) => setForm((p) => ({ ...p, customerId }))}
            getValue={(customer) => customer.id}
            getLabel={(customer) => formatCustomerOption(customer)}
            placeholder="Select customer"
          />
        </div>
        <div className="space-y-2">
          <Label>Sales Order (optional)</Label>
          <DocumentReferenceSelect
            items={salesOrders}
            value={form.salesOrderId}
            onValueChange={(salesOrderId) => {
              // Picking an order fills in its customer and total.
              const so = salesOrders.find((o) => o.id === salesOrderId);
              setForm((p) => ({
                ...p,
                salesOrderId,
                customerId: so?.customerId ?? p.customerId,
                totalValue: so?.totalValue != null ? String(so.totalValue) : p.totalValue,
              }));
            }}
            getValue={(order) => order.id}
            getLabel={(order) => formatSalesOrderOption(order)}
            placeholder="Select sales order"
            noneLabel="No sales order"
          />
        </div>
        <div className="space-y-2">
          <Label>Total Value</Label>
          <Input
            type="number"
            min="0"
            value={form.totalValue}
            onChange={(e) => setForm((p) => ({ ...p, totalValue: e.target.value }))}
          />
        </div>
        {!fields.isHidden('dueDate') && (
          <div className="space-y-2">
            <Label htmlFor="invoice-due-date">{fieldLabel('Due Date', fields.isRequired('dueDate'))}</Label>
            <Input
              id="invoice-due-date"
              type="date"
              required={fields.isRequired('dueDate')}
              value={form.dueDate}
              onChange={(e) => setForm((p) => ({ ...p, dueDate: e.target.value }))}
            />
          </div>
        )}
        {!fields.isHidden('remarks') && (
          <div className="space-y-2 md:col-span-2">
            <Label htmlFor="invoice-remarks">{fieldLabel('Remarks', fields.isRequired('remarks'))}</Label>
            <Input
              id="invoice-remarks"
              required={fields.isRequired('remarks')}
              value={form.remarks}
              onChange={(e) => setForm((p) => ({ ...p, remarks: e.target.value }))}
            />
          </div>
        )}
        <div className="md:col-span-2">
          <div className="mb-3 w-full text-left">
            <CustomFieldsSection form={customFieldForm} />
          </div>
          <Button onClick={onCreate} disabled={createInvoice.isPending}>
            {createInvoice.isPending ? 'Creating…' : 'Create Invoice'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );

  if (createOnly) {
    return (
      <AppLayout active="Invoices">
        <CreatePageLayout
          title="Create Invoice"
          description="Manual and sales-order-based customer invoicing."
          backTo="/invoices"
        >
          {createForm}
        </CreatePageLayout>
      </AppLayout>
    );
  }

  return (
    <AppLayout active="Invoices">
      <div className="space-y-6">
        <PageHeader title="Invoices" description="Manual and sales-order-based customer invoicing.">
          <Button variant="outline" onClick={handleExportInvoices}>
            <Download className="mr-2 h-4 w-4" />
            Export CSV
          </Button>
          <Button onClick={() => navigate('/invoices/new')}>
            <Plus className="mr-2 h-4 w-4" />
            Create Invoice
          </Button>
        </PageHeader>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <CardTitle>Invoices</CardTitle>
            <ColumnPicker columns={columns} tableLabel="invoice" />
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  {columns.visible.map((c) => <TableHead key={c.key} className={c.headClassName}>{c.label}</TableHead>)}
                </TableRow>
              </TableHeader>
              <TableBody>
                {invoices.length === 0 ? <TableRow><TableCell colSpan={columns.visible.length}>No invoices found.</TableCell></TableRow> : invoices.map((inv) => (
                  <TableRow key={inv.id}>
                    {columns.visible.map((c) => <TableCell key={c.key} className={c.cellClassName}>{c.cell(inv)}</TableCell>)}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}
