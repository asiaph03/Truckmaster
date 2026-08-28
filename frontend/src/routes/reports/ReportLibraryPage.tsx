import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { reportCatalogApi } from '../../api';
import { EmptyState } from '../../components/ui';
import '../shared/ListPage.css';
import './ReportLibraryPage.css';

/**
 * Phase 21 (Reports Library) — locked sitemap route `/reports`
 * (UI_UX_DESIGN.md §5.1.4). Renders purely off `GET /reports/catalog`'s
 * response — the same "no client-side role-to-section mapping" pattern
 * `DashboardPage` already established, extended here to library scope
 * instead of a new PermissionKey. AR Aging/AP Aging cards link out to
 * their existing `/billing/...` routes; every other card opens the
 * generic `/reports/:reportId` run screen.
 */
export function ReportLibraryPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['reports', 'catalog'],
    queryFn: () => reportCatalogApi.catalog(),
  });

  return (
    <div>
      <div className="list-page-header">
        <h1 className="list-page-title">Report Library</h1>
      </div>

      {isLoading ? null : (data?.categories.length ?? 0) === 0 ? (
        <EmptyState message="No reports are available for your role yet." />
      ) : (
        data!.categories.map((category) => (
          <div key={category.key} className="report-library-category">
            <h2 className="report-library-category-title">{category.label}</h2>
            <div className="report-library-card-grid">
              {category.reports.map((report) =>
                report.externalPath ? (
                  <Link key={report.id} to={report.externalPath} className="report-library-card">
                    <div className="report-library-card-title">{report.title}</div>
                  </Link>
                ) : (
                  <Link
                    key={report.id}
                    to={`/reports/${report.id}`}
                    className="report-library-card"
                  >
                    <div className="report-library-card-title">{report.title}</div>
                  </Link>
                ),
              )}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
