import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { reportingApi } from '../api';
import './GlobalSearch.css';

/**
 * UI_UX_DESIGN.md §5.3.6 — ⌘K/Ctrl+K command-palette overlay, results
 * grouped by entity type. Distinct from the future full-featured Load
 * Search screen (§5.1.5) — this is a fast jump-to tool, capped results.
 * Load/Invoice results aren't clickable yet (no detail screens exist
 * until later phases) — shown as plain text, Customer/Carrier results
 * navigate to their (now-built) detail pages.
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
