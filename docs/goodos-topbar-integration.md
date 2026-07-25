# GoodOS universal top-bar integration

Load the shared stylesheet from GoodBase:

```html
<link rel="stylesheet" href="https://base.goodos.app/backend-topbar.css">
```

The DOM order is the contract. Keep the four zones in this exact sequence:

```html
<header class="goodos-topbar" data-goodos-topbar>
  <div class="goodos-topbar__identity" data-goodos-topbar-identity>
    <a class="goodos-topbar__brand" data-goodos-topbar-brand href="/" aria-label="GoodFleet home">
      <span class="goodos-topbar__brand-mark" data-goodos-topbar-brand-mark aria-hidden="true">
        <!-- Application icon -->
      </span>
      <span>GoodFleet</span>
    </a>

    <select
      class="goodos-topbar__workspace"
      data-goodos-topbar-workspace
      aria-label="Current workspace"
    >
      <option>Owner Workspace</option>
    </select>
  </div>

  <label class="goodos-topbar__search" data-goodos-topbar-search>
    <span aria-hidden="true"><!-- Search icon --></span>
    <input type="search" placeholder="Search reservations, customers, and vehicles">
  </label>

  <nav
    class="goodos-topbar__actions"
    data-goodos-topbar-actions
    aria-label="Application actions"
  >
    <!-- Only controls specific to this application belong here. -->
    <button class="goodos-topbar__action" data-goodos-topbar-action type="button">
      Create reservation
    </button>
  </nav>

  <nav
    class="goodos-topbar__controls"
    data-goodos-topbar-controls
    aria-label="Universal controls"
  >
    <button
      class="goodos-topbar__control"
      data-goodos-topbar-control="theme"
      type="button"
      aria-label="Display settings"
    ><!-- Theme icon --></button>

    <div
      data-goodos-notifications
      data-goodos-notification-mode="application"
      data-goodos-notification-app-id="goodfleet"
    >
      <button
        class="goodos-topbar__control"
        data-goodos-topbar-control="notifications"
        data-goodos-notification-trigger
        type="button"
        aria-label="Notifications"
        aria-haspopup="dialog"
        aria-expanded="false"
      >
        <!-- Notification icon -->
        <span
          class="goodos-topbar__notification-badge"
          data-goodos-notification-badge
          aria-label="3 unread notifications"
        >3</span>
      </button>
      <section
        class="goodos-topbar__notification-preview"
        data-goodos-notification-preview
        aria-label="Notification preview"
        hidden
      ><!-- Application-owned notification preview --></section>
    </div>

    <a
      class="goodos-topbar__control"
      data-goodos-topbar-control="help"
      href="/help"
      aria-label="Help"
    ><!-- Help icon --></a>

    <button
      class="goodos-topbar__control"
      data-goodos-topbar-control="account"
      type="button"
      aria-label="Account"
    ><!-- Account avatar --></button>
  </nav>
</header>
```

## Zone rules

- Identity/workspace is always first.
- Search sits immediately beside identity, not centered independently on the page.
- Application-specific actions sit after search and before the theme control.
- Theme, notifications, help, and account are universal controls and always remain at the right edge.
- Applications may override the `--goodos-topbar-*` color tokens. They must not override structural sizing or zone order.
- The desktop baseline is a 77 px bar with a fixed 360 px identity zone, a
  544 × 46 px search field, a flexible application-action zone, and a fixed
  166 px universal-control zone.
- Theme, notifications, help, and account occupy fixed 34 × 34 px slots in
  that order. Their coordinates do not change when an application has fewer
  actions or a longer product name.
- The account slot is always a circular 34 × 34 px avatar or initials button.
  User names and roles belong in the account popover, never in the bar itself.

## Notification Center integration

The top-bar contract standardizes notification presentation and integration hooks only. It does not create, fetch, merge, cache, or mutate notification state.

Every product application must declare:

```html
data-goodos-notification-mode="application"
data-goodos-notification-app-id="<stable-product-app-id>"
```

Its notification client must remain application-scoped and must use that `appId` for all reads and mutations. A product application must never request notifications from another product.

Product applications use the strict application endpoint family. The server
forces the `:appId` scope on every operation and rejects applications the
signed-in user is not assigned to:

```text
GET    /api/notifications/apps/:appId/overview
PATCH  /api/notifications/apps/:appId/:notificationId/read
POST   /api/notifications/apps/:appId/read-all
DELETE /api/notifications/apps/:appId/:notificationId
POST   /api/notifications/apps/:appId/archive-read
```

Product code must not call the unscoped `/api/notifications/overview` family.
Those routes belong exclusively to the GoodOS master Notification Center.

GoodOS is the only application allowed to declare master mode:

```html
data-goodos-notification-mode="master"
data-goodos-notification-app-id="goodos"
data-goodos-notification-entitlement-scope="accessible-apps"
```

Master mode may aggregate only applications the signed-in user is entitled to access. The server, not the browser, must enforce that entitlement boundary.

Each application owns the data and behavior behind the standardized hooks:

| Capability | Required hook or action |
| --- | --- |
| Unread count | `[data-goodos-notification-badge]` |
| Preview | `[data-goodos-notification-preview]` |
| Notification list/full center | `data-goodos-notification-action="open-center"` |
| Search | `data-goodos-notification-action="search"` |
| Filters | `data-goodos-notification-action="filter"` |
| Mark read | `data-goodos-notification-action="mark-read"` |
| Mark all read | `data-goodos-notification-action="mark-all-read"` |
| Archive | `data-goodos-notification-action="archive"` |
| Preferences | `data-goodos-notification-action="preferences"` |
| Deep link | `data-goodos-notification-deep-link` |

Applications should dispatch `goodos:notifications:updated` from the element carrying
`data-goodos-notifications` after an unread-count or list change. Event detail must
include `appId` and `unreadCount`; GoodOS master mode may additionally include
`sourceAppIds`, already filtered to entitled applications.
