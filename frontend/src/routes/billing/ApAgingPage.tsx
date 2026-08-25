import { useQuery } from '@tanstack/react-query';
import { reportingApi } from '../../api';
import { AgingReport } from './AgingReport';

/** UI_UX_DESIGN.md §5.1.4 sitemap route `/billing/ap-aging`. Admin/Accounting/Ops Manager only (`viewArApAging`, enforced server-side by FINANCIAL_REPORT_ROLES). */
export function ApAgingPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['reports', 'ap-aging'],
    queryFn: () => reportingApi.apAging(),
  });

  return (
    <AgingReport
      title="AP Aging"
      basisNote="Outstanding carrier balances, aged by the oldest unresolved payment submission date (Decision Log D14)."
      data={data}
      isLoading={isLoading}
    />
  );
}
