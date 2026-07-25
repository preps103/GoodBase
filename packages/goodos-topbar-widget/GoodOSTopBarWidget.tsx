import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

export const GOODOS_TOPBAR_WIDGET_VERSION = '1.0.0';

interface GoodOSTopBarWidgetProps {
  children: ReactNode;
}

/**
 * Owns top-bar viewport placement without owning product behavior.
 *
 * Application branding, search, actions, notifications, help, and account
 * controls remain children so every app keeps its own behavior. The portal
 * prevents an application shell from offsetting or clipping the master bar.
 */
export function GoodOSTopBarWidget({ children }: GoodOSTopBarWidgetProps) {
  const mountedBar =
    typeof document === 'undefined' ? null : createPortal(children, document.body);

  return (
    <>
      <div
        className="goodos-topbar-widget__spacer"
        data-goodos-topbar-spacer
        aria-hidden="true"
      />
      {mountedBar}
    </>
  );
}
