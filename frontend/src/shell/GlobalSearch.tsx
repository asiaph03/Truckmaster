import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { reportingApi } from '../api';
import './GlobalSearch.css';

/**
 * UI_UX_DESIGN.md §5.3.6 — ⌘K/Ctrl+K command-palette overlay, results
 * grouped by entity type. Distinct from the Load Search screen (§5.1.5,
 * built in Frontend Phase 13 at `/loads/search`) — this is a fast jump-to tool,
 * capped at 5 results per group by the backend (`SEARCH_RESULT_LIMIT`),
 * which exposes no total count, so no "See all results" link is
 * rendered — that would require a count the API doesn't return, not a
 * missing frontend feature. Results are already role-filtered/redacted
 * by `ReportingService.search` (Sales/Booking's non-own-deal invoices
 * come back status-only, `total: null`) — this component renders
 * exactly what it's given, no client-side re-filtering.
 */
export function GlobalSearch() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      }
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  const { data } = useQuery({
    queryKey: ['global-search', query],
    queryFn: () => reportingApi.search(query),
    enabled: open && query.trim().length > 0,
  });

  return (
    <>
      <button type="button" className="global-search-trigger" onClick={() => setOpen(true)}>
        <Search size={14} strokeWidth={1.5} />
        <span>Search…</span>
        <kbd>⌘K</kbd>
      </button>
      {open ? (
        <div className="global-search-backdrop" onMouseDown={() => setOpen(false)}>
          <div className="global-search-panel" onMouseDown={(e) => e.stopPropagation()}>
            <input
              autoFocus
              className="global-search-input"
              placeholder="Search loads, customers, carriers, invoices…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {data ? (
              <div className="global-search-results">
                <SearchGroup label="Loads">
                  {data.loads.map((l) => (
                    <button
                      key={l.id}
                      className="global-search-result"
                      onClick={() => {
                        navigate(`/loads/${l.id}`);
                        setOpen(false);
                      }}
                    >
                      {l.loadNumber}
                    </button>
                  ))}
                </SearchGroup>
                <SearchGroup label="Customers">
                  {data.customers.map((c) => (
                    <button
                      key={c.id}
                      className="global-search-result"
                      onClick={() => {
                        navigate(`/customers/${c.id}`);
                        setOpen(false);
                      }}
                    >
                      {c.legalName}
                    </button>
                  ))}
                </SearchGroup>
                <SearchGroup label="Carriers">
                  {data.carriers.map((c) => (
                    <button
                      key={c.id}
                      className="global-search-result"
                      onClick={() => {
                        navigate(`/carriers/${c.id}`);
                        setOpen(false);
                      }}
                    >
                      {c.legalName}
                    </button>
                  ))}
                </SearchGroup>
                <SearchGroup label="Invoices">
                  {data.invoices.map((i) => (
                    <button
                      key={i.id}
                      className="global-search-result"
                      onClick={() => {
                        navigate(`/billing/invoices/${i.id}`);
                        setOpen(false);
                      }}
                    >
                      {i.invoiceNumber}
                    </button>
                  ))}
                </SearchGroup>
                {data.loads.length === 0 &&
                data.customers.length === 0 &&
                data.carriers.length === 0 &&
                data.invoices.length === 0 ? (
                  <div className="global-search-empty">No results for "{query}".</div>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}

function SearchGroup({ label, children }: { label: string; children: React.ReactNode }) {
  const items = Array.isArray(children) ? children : [children];
  const hasItems = items.some(Boolean) && (items as unknown[]).length > 0;
  if (!hasItems) return null;
  return (
    <div className="global-search-group">
      <div className="global-search-group-label">{label}</div>
      {children}
    </div>
  );
}
