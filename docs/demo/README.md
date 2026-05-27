# Demo data

This directory documents prototype-only content. Demo books and fixed statistics are not imported by production pages.

Use demo data only with:

```bash
DEMO_MODE=true pnpm db:seed:demo
```

Production deployments must keep `DEMO_MODE=false` and `NEXT_PUBLIC_DEMO_MODE=false`.
