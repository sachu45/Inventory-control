import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from '@/components/Layout';
import { RequirePlatformAdmin } from '@/components/RequirePlatformAdmin';
import { TenantLayout } from '@/components/TenantLayout';
import { AccessDeniedPage } from '@/pages/AccessDeniedPage';
import { EffectivePage } from '@/pages/config/EffectivePage';
import { CustomFieldsPage } from '@/pages/config/CustomFieldsPage';
import { ModulesPage } from '@/pages/config/ModulesPage';
import { PublishPage } from '@/pages/config/PublishPage';
import { VersionsPage } from '@/pages/config/VersionsPage';
import { LoginPage } from '@/pages/LoginPage';
import { TenantDetailPage } from '@/pages/TenantDetailPage';
import { TenantsPage } from '@/pages/TenantsPage';

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/access-denied" element={<AccessDeniedPage />} />
      <Route element={<RequirePlatformAdmin />}>
        <Route element={<Layout />}>
          <Route path="/tenants" element={<TenantsPage />} />
          <Route path="/tenants/:companyId" element={<TenantLayout />}>
            <Route index element={<TenantDetailPage />} />
            <Route path="modules" element={<ModulesPage />} />
            <Route path="custom-fields" element={<CustomFieldsPage />} />
            <Route path="publish" element={<PublishPage />} />
            <Route path="versions" element={<VersionsPage />} />
            <Route path="effective" element={<EffectivePage />} />
          </Route>
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/tenants" replace />} />
    </Routes>
  );
}
