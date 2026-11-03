import { AlertTriangle, ArrowRight } from '@/components/ui/icons';
import { Link } from 'react-router-dom';
import type { SubscriptionSnapshot } from '@/lib/plans';

type Props = {
  subscription?: SubscriptionSnapshot | null;
};

export function TrialUpgradeBanner({ subscription }: Props) {
  if (!subscription || subscription.plan !== 'TRIAL') return null;
  const daysLeft =
    subscription.daysLeftInTrial != null
      ? `${subscription.daysLeftInTrial} day${subscription.daysLeftInTrial === 1 ? '' : 's'} left`
      : 'Trial active';

  return (
    <div className="trial-notice">
      <AlertTriangle className="h-4 w-4 shrink-0" />
      <div className="flex flex-1 flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <span className="font-semibold">Trial workspace</span>
          <span className="ml-2">{daysLeft}. Explore inventory, procurement and reporting.</span>
        </div>
        <Link
          to="/upgrade"
          className="inline-flex items-center gap-2 text-xs font-semibold hover:underline"
        >
          View plans <ArrowRight className="h-3 w-3" />
        </Link>
      </div>
    </div>
  );
}
