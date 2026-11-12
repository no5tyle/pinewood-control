/*
  "Are you sure?" questions in the app's own style, rather than the browser's confirm box.
  confirmAction() opens the dialog drawn by <ConfirmHost /> (mounted once in App) and resolves true when
  the action is confirmed, false when it's cancelled (Cancel, Escape, or a tap outside).
*/
export interface ConfirmRequest {
  title: string;
  message?: string;
  /** The button that goes ahead, e.g. "Delete event" */
  confirmLabel: string;
  /** Red, for something that can't be undone */
  danger?: boolean;
}

type Opener = (request: ConfirmRequest, answer: (ok: boolean) => void) => void;

let opener: Opener | null = null;

export function registerConfirmHost(open: Opener | null) {
  opener = open;
}

export function confirmAction(request: ConfirmRequest): Promise<boolean> {
  return new Promise((resolve) => {
    if (!opener) return resolve(false);
    opener(request, resolve);
  });
}
