import { useNavigate } from 'react-router-dom';
import { Button, Modal } from '../../../components/ui';

/**
 * UI_UX_DESIGN.md §5.4.1 — Dispatch Board's "+ New Load" primary action
 * offers this choice. Also reused by Customer Detail's "+ New Quote"
 * header action (§5.4.5), which pre-fills `customerId` into both paths.
 */
export function NewLoadChoiceModal({
  open,
  onClose,
  customerId,
}: {
  open: boolean;
  onClose: () => void;
  customerId?: string;
}) {
  const navigate = useNavigate();
  const suffix = customerId ? `?customerId=${customerId}` : '';

  return (
    <Modal open={open} title="New Load" onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
        <Button size="lg" variant="secondary" onClick={() => navigate(`/quotes/new${suffix}`)}>
          Start a Quote
        </Button>
        <Button size="lg" onClick={() => navigate(`/loads/new${suffix}`)}>
          Book Directly
        </Button>
      </div>
    </Modal>
  );
}
