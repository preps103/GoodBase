# GoodOS Sites hosting contract

This package is the canonical frontend hosting adapter for active GoodOS products.

It converts a Vite build into the Sites layout, installs the shared edge worker,
preserves single-page application routing, prevents stale document caching, and
supports an optional `CUSTOMER_HTTP_APP_BACKEND` tunnel for application API routes.

GoodBase owns this package. Product repositories receive synchronized snapshots;
they must not fork the worker or preparation script.
