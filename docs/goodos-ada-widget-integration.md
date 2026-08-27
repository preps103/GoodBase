# GoodOS universal ADA widget integration

GoodBase serves one framework-neutral ADA widget for every GoodApp. Products
load the shared files and provide only product color tokens. They must not ship
a second launcher or a local copy of the widget implementation.

```html
<html data-goodos-app-name="GoodFleet">
  <head>
    <link rel="stylesheet" href="https://base.goodos.app/backend-ada.css?v=4.0.0">
    <link rel="stylesheet" href="/goodfleet-ada-theme.css">
    <script src="https://base.goodos.app/backend-ada.js?v=4.0.0" defer></script>
  </head>
</html>
```

The launcher defaults to the bottom-right, 24px from each edge. A product that
needs a different established position uses this single short embed:

```html
<script
  src="https://base.goodos.app/backend-ada.js?v=4.0.0"
  data-goodos-ada-placement="bottom-left"
  defer
></script>
```

Supported placements are `bottom-right`, `bottom-left`, `top-right`, and
`top-left`. Per-site offsets remain available for the one-off cases that need
them:

```css
:root {
  --backend-ada-trigger-right: 24px;
  --backend-ada-trigger-bottom: 24px;
  --backend-ada-panel-right: 24px;
  --backend-ada-panel-bottom: 96px;
}
```

The widget can also be added, moved, or removed without importing a component:

```js
window.GoodOSAdaWidget.configure({ placement: "bottom-left" });
window.GoodOSAdaWidget.unmount();
window.GoodOSAdaWidget.mount({ placement: "bottom-right" });
```

The universal launcher is exactly 90 × 46px. The panel is 400 × 750px with an
85vh maximum height. Product themes may override color, border, surface, and
shadow tokens, but never structural dimensions.

Application controls can open the widget without importing its implementation:

```ts
window.dispatchEvent(new Event("goodos:accessibility:open"));
```

The widget also accepts `goodos:accessibility:close` and
`goodos:accessibility:toggle`, and announces readiness with
`goodos:accessibility:ready`.
