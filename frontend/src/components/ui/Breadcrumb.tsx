import { Link } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import './Breadcrumb.css';

export interface BreadcrumbItem {
  label: string;
  to?: string;
}

/** UI_UX_DESIGN.md §5.1.5 — breadcrumbs live in the content area, not the top bar. */
export function Breadcrumb({ items }: { items: BreadcrumbItem[] }) {
  return (
    <nav className="breadcrumb" aria-label="Breadcrumb">
      {items.map((item, index) => (
        <span key={index} className="breadcrumb-item">
          {item.to ? (
            <Link to={item.to} className="breadcrumb-link">
              {item.label}
            </Link>
          ) : (
            <span className="breadcrumb-current">{item.label}</span>
          )}
          {index < items.length - 1 ? (
            <ChevronRight size={14} strokeWidth={1.5} className="breadcrumb-separator" />
          ) : null}
        </span>
      ))}
    </nav>
  );
}
