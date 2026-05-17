// Page-top toolbar: breadcrumbs + optional title + right slot.
//
// Replaces the old PR F TopBar pill-and-nav pattern. The nav is now in
// the left rail; the toolbar's job is just to anchor the user in
// breadcrumbs and host page-level actions.

import type { ReactNode } from "react";

export function Toolbar({
  crumbs,
  title,
  right,
}: {
  crumbs?: string;
  title?: string;
  right?: ReactNode;
}) {
  return (
    <div className="toolbar">
      {crumbs && <span className="crumbs">{crumbs}</span>}
      {title && <h1 style={{ marginLeft: 8 }}>{title}</h1>}
      <span className="toolbar-spacer" />
      {right}
    </div>
  );
}
