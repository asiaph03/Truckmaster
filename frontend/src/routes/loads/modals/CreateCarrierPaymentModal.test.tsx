import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '../../../test/mswServer';
import { CreateCarrierPaymentModal } from './CreateCarrierPaymentModal';
import type { CarrierPaymentRemainingBalance } from '../../../api';

const LOAD_ID = 'load-1';

function mockBalance(overrides: Partial<CarrierPaymentRemainingBalance> = {}) {
  const balance: CarrierPaymentRemainingBalance = {
    carrierRate: '700.00',
    carrierAccessorialsTotal: '150.00',
    totalPaid: '0.00',
    remainingCarrierBalance: '850.00',
    ...overrides,
  };
  server.use(
    http.get(`/api/v1/loads/${LOAD_ID}/carrier-payments/remaining-balance`, () =>
      HttpResponse.json(balance),
    ),
  );
  return balance;
}

function renderModal(onCreated: () => void = () => {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <CreateCarrierPaymentModal open loadId={LOAD_ID} onClose={() => {}} onCreated={onCreated} />
    </QueryClientProvider>,
  );
}

describe('CreateCarrierPaymentModal — Accessorial Charges pre-creation balance preview', () => {
  it('displays Carrier Rate, Carrier Accessorials, Paid to Date, and Remaining Carrier Balance above the Amount field', async () => {
    mockBalance();
    renderModal();

    await screen.findByText('Remaining Carrier Balance');
    expect(screen.getByText('Carrier Rate')).toBeInTheDocument();
    expect(screen.getByText('$700.00')).toBeInTheDocument();
    expect(screen.getByText('Carrier Accessorials')).toBeInTheDocument();
    expect(screen.getByText('$150.00')).toBeInTheDocument();
    expect(screen.getByText('Paid to Date')).toBeInTheDocument();
    expect(screen.getByText('$0.00')).toBeInTheDocument();
    expect(screen.getByText('$850.00')).toBeInTheDocument();
  });

  it('reflects already-Paid amounts: $700 + $150 accessorial - $300 paid = $550 remaining', async () => {
    mockBalance({ totalPaid: '300.00', remainingCarrierBalance: '550.00' });
    renderModal();

    await screen.findByText('Remaining Carrier Balance');
    expect(screen.getByText('$550.00')).toBeInTheDocument();
    expect(screen.getByText('$300.00')).toBeInTheDocument();
  });

  it('a Load with no carrier accessorials shows the plain carrierRate as the remaining balance (regression)', async () => {
    mockBalance({ carrierAccessorialsTotal: '0.00', remainingCarrierBalance: '700.00' });
    renderModal();

    await screen.findByText('Remaining Carrier Balance');
    const amountValues = screen.getAllByText('$700.00');
    expect(amountValues.length).toBeGreaterThanOrEqual(1);
  });

  it('"Use Remaining Balance" populates Amount, and the field remains manually editable afterward', async () => {
    mockBalance();
    renderModal();

    await screen.findByText('Remaining Carrier Balance');
    fireEvent.click(screen.getByText('Use Remaining Balance'));

    const amountInput = screen.getByLabelText(/^Amount/) as HTMLInputElement;
    await waitFor(() => expect(amountInput.value).toBe('850.00'));

    // Still a completely normal, editable field — never locked.
    fireEvent.change(amountInput, { target: { value: '825.00' } });
    expect(amountInput.value).toBe('825.00');
  });

  it('never forces the Amount field to the remaining balance — submits exactly what the user typed', async () => {
    mockBalance();
    let receivedBody: Record<string, unknown> | undefined;
    server.use(
      http.post(`/api/v1/loads/${LOAD_ID}/carrier-payments`, async ({ request }) => {
        receivedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ id: 'cp-1', status: 'DRAFT' }, { status: 201 });
      }),
    );
    let created = false;
    renderModal(() => {
      created = true;
    });

    await screen.findByText('Remaining Carrier Balance');
    // Deliberately does NOT click "Use Remaining Balance" — Accounting may
    // intentionally pay a different amount than the computed balance.
    fireEvent.change(screen.getByLabelText(/^Amount/), { target: { value: '400.00' } });
    fireEvent.change(screen.getByLabelText(/^Method/), { target: { value: 'ACH' } });
    fireEvent.change(screen.getByLabelText(/^Reference Number/), { target: { value: 'REF-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(created).toBe(true));
    expect(receivedBody?.amount).toBe('400.00');
  });
});
