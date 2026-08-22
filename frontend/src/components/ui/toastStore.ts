import { create } from 'zustand';

export type ToastVariant = 'info' | 'warning' | 'danger' | 'success';

export interface ToastItem {
  id: string;
  variant: ToastVariant;
  message: string;
}

interface ToastState {
  toasts: ToastItem[];
  show: (variant: ToastVariant, message: string) => void;
  dismiss: (id: string) => void;
}

const AUTO_DISMISS_MS = 4000;

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  show: (variant, message) => {
    const id = crypto.randomUUID();
    set((state) => ({ toasts: [...state.toasts, { id, variant, message }] }));
    setTimeout(() => get().dismiss(id), AUTO_DISMISS_MS);
  },
  dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
}));

/** UI_UX_DESIGN.md §5.2.5 "Toasts" — confirmations after actions complete. */
export function useToast() {
  const show = useToastStore((s) => s.show);
  return {
    info: (message: string) => show('info', message),
    success: (message: string) => show('success', message),
    warning: (message: string) => show('warning', message),
    danger: (message: string) => show('danger', message),
  };
}
