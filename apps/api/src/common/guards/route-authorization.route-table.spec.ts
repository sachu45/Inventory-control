import { readdirSync, statSync } from 'fs';
import { join } from 'path';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { REQUIRES_MODULE_KEY } from '../config/requires-module.decorator';
import { AUTHENTICATED_ONLY_KEY } from '../decorators/authenticated-only.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { PERMISSIONS_ANY_KEY } from '../decorators/require-any-permission.decorator';
import { PERMISSIONS_KEY } from '../decorators/require-permission.decorator';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { RolesGuard } from './roles.guard';

/** Business routes reachable with no user. Each one must verify a token itself. */
const PUBLIC_ROUTES = new Set([
  'ReturnsController.getSupplierPublic',
  'ReturnsController.acknowledgeSupplierPublic',
  'SuppliersController.confirmDeletion',
]);

type Constructor = new (...args: never[]) => unknown;

function controllerFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return controllerFiles(path);
    return name.endsWith('.controller.ts') ? [path] : [];
  });
}

function controllers(): Constructor[] {
  return controllerFiles(join(__dirname, '..', '..')).flatMap((file) =>
    Object.values(require(file) as Record<string, unknown>)
      .filter((value): value is Constructor => typeof value === 'function')
      .filter((cls) => Reflect.getMetadata(PATH_METADATA, cls) !== undefined),
  );
}

function routes() {
  return controllers()
    .filter((cls) => Reflect.getMetadata(REQUIRES_MODULE_KEY, cls) !== undefined)
    .flatMap((cls) =>
      Object.getOwnPropertyNames(cls.prototype)
        .map((name) => ({ name, handler: cls.prototype[name] as object }))
        .filter(({ handler }) => typeof handler === 'function' && Reflect.getMetadata(METHOD_METADATA, handler) !== undefined)
        .map(({ name, handler }) => {
          const read = (key: string) => Reflect.getMetadata(key, handler) ?? Reflect.getMetadata(key, cls);
          const guards = [...(Reflect.getMetadata(GUARDS_METADATA, cls) ?? []), ...(Reflect.getMetadata(GUARDS_METADATA, handler) ?? [])];
          return { route: `${cls.name}.${name}`, read, guards };
        }),
    );
}

describe('business route authorization table', () => {
  const all = routes();

  it('finds the business routes', () => {
    expect(all.length).toBeGreaterThan(200);
  });

  it('every business route declares a permission, a role, @AuthenticatedOnly or @Public', () => {
    const undeclared = all
      .filter(({ read }) => ![PERMISSIONS_KEY, PERMISSIONS_ANY_KEY, ROLES_KEY, AUTHENTICATED_ONLY_KEY, IS_PUBLIC_KEY].some((key) => read(key)?.length || read(key) === true))
      .map(({ route }) => route);
    expect(undeclared).toEqual([]);
  });

  it('@Roles is enforced: RolesGuard is not global, so each such route must apply it', () => {
    const unenforced = all
      .filter(({ read, guards }) => read(ROLES_KEY)?.length && !guards.includes(RolesGuard))
      .map(({ route }) => route);
    expect(unenforced).toEqual([]);
  });

  it('public business routes are exactly the known token routes', () => {
    expect(all.filter(({ read }) => read(IS_PUBLIC_KEY)).map(({ route }) => route).sort()).toEqual([...PUBLIC_ROUTES].sort());
  });
});
