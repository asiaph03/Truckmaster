import { Button } from './Button';
import { EmptyState } from './EmptyState';

export interface QueryErrorStateProps {
  message: string;
  onRetry: () => void;
}

/**
 * Task #4 — the initial-load counterpart to EmptyState: a query's `isError`
 * must never be left unchecked (the "stuck on Loading… forever" bug this
 * closes), so every detail page's main query renders this instead once
 * isLoading is false and isError is true. Retry re-invokes the query's own
 * `refetch()` — no new data-fetching mechanism.
 */
export function QueryErrorState({ message, onRetry }: QueryErrorStateProps) {
  return (
    <EmptyState
      message={message}
      action={
        <Button variant="secondary" onClick={onRetry}>
          Retry
        </Button>
      }
    />
  );
}
