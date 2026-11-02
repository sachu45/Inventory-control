import { useMemo } from 'react';
import { toast } from 'sonner';
import { useCompanies } from '@/hooks/use-companies';
import { useAuthStore } from '@/store/authStore';
import { cn } from '@/lib/cn';

type OrganisationIdBadgeProps = {
  className?: string;
};

/** Short display code for the tenant (company code, or compact UUID fallback). */
function formatOrganisationDisplayCode(companyCode?: string | null, companyId?: string | null) {
  const code = companyCode?.trim();
  if (code) return code.toUpperCase().replace(/\s+/g, '');
  if (companyId) {
    return companyId.replace(/-/g, '').slice(0, 5).toUpperCase();
  }
  return null;
}

export function OrganisationIdBadge({ className }: OrganisationIdBadgeProps) {
  const companyId = useAuthStore((s) => s.user?.companyId);
  const { data: companies = [] } = useCompanies();

  const { displayCode, fullUuid } = useMemo(() => {
    const company = companies[0];
    const uuid = company?.id ?? companyId ?? null;
    return {
      displayCode: formatOrganisationDisplayCode(company?.companyCode, uuid),
      fullUuid: uuid,
    };
  }, [companies, companyId]);

  if (!displayCode) return null;

  async function copyId() {
    if (!fullUuid) return;
    try {
      await navigator.clipboard.writeText(fullUuid);
      toast.success('Organisation ID copied');
    } catch {
      toast.error('Could not copy to clipboard');
    }
  }

  return (
    <button
      type="button"
      onClick={copyId}
      title={fullUuid ? `Organisation UUID: ${fullUuid} (click to copy)` : displayCode}
      className={cn(
        'group flex flex-col items-start rounded-md outline-hidden transition focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        className,
      )}
    >
      <span className="text-[9px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
        Workspace
      </span>
      <span
        className="mt-0.5 text-xs font-medium text-foreground"
      >
        {displayCode}
      </span>
    </button>
  );
}
