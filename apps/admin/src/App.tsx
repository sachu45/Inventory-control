import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from '@/components/Layout';
import { RequirePlatformAdmin } from '@/components/RequirePlatformAdmin';
import { AccessDeniedPage } from '@/pages/AccessDeniedPage';
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
          <Route path="/tenants/:companyId" element={<TenantDetailPage />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/tenants" replace />} />
    </Routes>
  );
}
