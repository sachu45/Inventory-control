import { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { lastValueFrom, of } from 'rxjs';
import { compileSnapshot } from './config-snapshot';
import type { ConfigResolverService } from './config-resolver.service';
import { MandatoryFieldsException } from './module-fields';
import { ModuleFields, ModuleFieldsInterceptor, ModuleFieldsWrite } from './module-fields.interceptor';

@ModuleFields('purchase-orders')
class PoController {
  @ModuleFieldsWrite('create')
  create() {}
  get() {}
}

function config(mandatory: string[] = [], hidden: string[] = []) {
  const modules = structuredClone(compileSnapshot([], new Set(), 1).snapshot.company);
  modules['purchase-orders'].config = { mandatoryFields: mandatory, hiddenFields: hidden };
  return { companyId: 'c1', version: 1, shopId: null, modules };
}

function run(handler: 'create' | 'get', body: unknown, resolved = config(), response: unknown = {}, user: unknown = { companyId: 'c1', shopId: 's1' }) {
  const resolver = { resolve: jest.fn().mockResolvedValue(resolved) };
  const interceptor = new ModuleFieldsInterceptor(new Reflector(), resolver as unknown as ConfigResolverService);
  const ctx = {
    getType: () => 'http',
    getClass: () => PoController,
    getHandler: () => PoController.prototype[handler],
    switchToHttp: () => ({ getRequest: () => ({ user, body }) }),
  } as unknown as ExecutionContext;
  const next: CallHandler = { handle: jest.fn(() => of(response)) };
  return { resolver, next, result: interceptor.intercept(ctx, next).then((o) => lastValueFrom(o)) };
}

describe('ModuleFieldsInterceptor', () => {
  it('rejects a create missing a configured mandatory field with 422, before the handler runs', async () => {
    const { result, next } = run('create', { supplier: 'S' }, config(['remarks']));
    await expect(result).rejects.toBeInstanceOf(MandatoryFieldsException);
    expect(next.handle).not.toHaveBeenCalled();
  });

  it('strips hidden fields from the body and the response', async () => {
    const body = { remarks: 'r', rfqId: 'x' };
    const { result } = run('create', body, config([], ['rfqId']), { id: '1', rfqId: 'x' });
    await expect(result).resolves.toEqual({ id: '1' });
    expect(body).toEqual({ remarks: 'r' });
  });

  it('does not enforce writes on handlers without @ModuleFieldsWrite, but still redacts', async () => {
    const { result } = run('get', {}, config(['remarks'], ['rfqId']), { id: '1', rfqId: 'x' });
    await expect(result).resolves.toEqual({ id: '1' });
  });

  it('skips users without a company', async () => {
    const { result, resolver } = run('create', {}, config(['remarks']), { ok: true }, { companyId: null });
    await expect(result).resolves.toEqual({ ok: true });
    expect(resolver.resolve).not.toHaveBeenCalled();
  });
});
