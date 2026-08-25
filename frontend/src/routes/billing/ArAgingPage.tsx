import { useQuery } from '@tanstack/react-query';
import { reportingApi } from '../../api';
import { AgingReport } from './AgingReport';

/** UI_UX_DESIGN.md §5.1.4 sitemap route `/billing/ar-aging`. Admin/Accounting/Ops Manager only (`viewArApAging`, enforced server-side by FINANCIAL_REPORT_ROLES). */
export function ArAgingPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['reports', 'ar-aging'],
    queryFn: () => reportingApi.arAging(),
  });

  return (
    <AgingReport
      title="AR Aging"
      basisNote="Outstanding customer invoices (Sent / Partially Paid), aged by due date."
      data={data}
      isLoading={isLoading}
    />
  );
}
