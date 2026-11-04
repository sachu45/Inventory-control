import { ForbiddenException } from '@nestjs/common';
import { Prisma, SalesQuotationStatus } from '@prisma/client';
import { QuotationPortalService } from './quotation-portal.service';

function quote(companyId: string | null = 'c1') {
  return {
    id: 'q1',
    quoteNumber: 'SQ-00001',
    quoteDate: new Date('2026-11-01'),
    validUntil: null,
    status: SalesQuotationStatus.SENT,
    remarks: null,
    totalValue: new Prisma.Decimal(100),
    customerRequestedTotal: null,
    customerRequestNote: null,
    shopId: 'shop-1',
    customer: { customerName: 'Buyer', email: 'b@x.test' },
    shop: { shopName: 'Main', shopNumber: 'S1', companyId },
    items: [],
  };
}

function setup(row = quote()) {
  const prisma = {
    salesQuotationHeader: {
      findUnique: jest.fn().mockResolvedValue(row),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: jest.fn().mockResolvedValue(row),
    },
  };
  const modules = { assertEnabled: jest.fn().mockResolvedValue(undefined) };
  const service = new QuotationPortalService(prisma as any, modules as any);
  return { service, prisma, modules };
}

describe('QuotationPortalService module check', () => {
  it('checks sales-quotations with the quotation company and shop, and keeps companyId out of the view', async () => {
    const { service, modules } = setup();
    const view = await service.getByToken('tok');
    expect(modules.assertEnabled).toHaveBeenCalledWith('c1', 'shop-1', 'sales-quotations');
    expect(view.shop).toEqual({ shopName: 'Main', shopNumber: 'S1' });
  });

  it('refuses viewing and answering when the company has disabled sales quotations', async () => {
    const { service, prisma, modules } = setup();
    const disabled = new ForbiddenException({ code: 'MODULE_DISABLED' });
    modules.assertEnabled.mockRejectedValue(disabled);
    await expect(service.getByToken('tok')).rejects.toBe(disabled);
    await expect(service.accept('tok')).rejects.toBe(disabled);
    await expect(service.requestRevision('tok', { requestedTotal: 50 } as any)).rejects.toBe(disabled);
    expect(prisma.salesQuotationHeader.updateMany).not.toHaveBeenCalled();
  });

  it('skips the check for a shop with no company', async () => {
    const { service, modules } = setup(quote(null));
    await service.getByToken('tok');
    expect(modules.assertEnabled).not.toHaveBeenCalled();
  });
});
