# Firestore Composite Indexes

This file documents all composite indexes required by Kreddlo's backend functions.
If a query fails with a "missing index" error, Firebase will print a direct link
in the server logs to auto-create the index — click it and it provisions in minutes.

---

## Required Composite Index — Auto-Approval Query

Used by: `netlify/functions/scheduled-subscriptions.js`

| Field       | Collection | Order |
|-------------|------------|-------|
| `status`    | projects   | ASC   |
| `deliveredAt` | projects | ASC   |

**Query scope:** Collection

### How to create manually

1. Go to [Firebase Console](https://console.firebase.google.com)
2. Select your project → **Firestore Database** → **Indexes** tab
3. Click **Composite** → **Add Index**
4. Set:
   - Collection ID: `projects`
   - Field 1: `status` — Ascending
   - Field 2: `deliveredAt` — Ascending
   - Query scope: **Collection**
5. Click **Create** and wait ~1–2 minutes for it to build

### How to create via Firebase CLI

Add the following to `firestore.indexes.json` (create it if it doesn't exist):

```json
{
  "indexes": [
    {
      "collectionGroup": "projects",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "status",      "order": "ASCENDING" },
        { "fieldPath": "deliveredAt", "order": "ASCENDING" }
      ]
    }
  ],
  "fieldOverrides": []
}
```

Then deploy:

```bash
firebase deploy --only firestore:indexes
```

---

## Required Composite Index — Browse Freelancers Query

Used by: `browse.html` (Freelancers tab)

| Field        | Collection | Order |
|--------------|------------|-------|
| `role`       | users      | ASC   |
| `kycStatus`  | users      | ASC   |

**Query scope:** Collection

```json
{
  "collectionGroup": "users",
  "queryScope": "COLLECTION",
  "fields": [
    { "fieldPath": "role",      "order": "ASCENDING" },
    { "fieldPath": "kycStatus", "order": "ASCENDING" }
  ]
}
```

Note: `browse.html` now falls back to a role-only query and filters
`kycStatus` client-side if this index is missing or still building, so the
page will not silently show "no freelancers found" — but creating this index
is still recommended for performance once you have many users.

## Required Composite Index — Browse / Store Products Query

Used by: `browse.html` (Products tab) and `store.html`

| Field    | Collection | Order |
|----------|------------|-------|
| `uid`    | products   | ASC   |
| `status` | products   | ASC   |

(`browse.html`'s Products tab only filters on `status`, which is single-field
and always indexed automatically; the `uid` + `status` compound index is
needed for `store.html`, which filters a single seller's products by status.)

```json
{
  "collectionGroup": "products",
  "queryScope": "COLLECTION",
  "fields": [
    { "fieldPath": "uid",    "order": "ASCENDING" },
    { "fieldPath": "status", "order": "ASCENDING" }
  ]
}
```

Note: both `browse.html` and `store.html` fall back to an unfiltered/partial
fetch with client-side filtering if this index is missing, so a product that
exists will not incorrectly show as "not found" — but creating this index is
still recommended for performance.

## Symptom if index is missing

The `scheduled-subscriptions` function will log an error like:

```
scheduled-subscriptions: delivery query failed (may need composite index): 9 FAILED_PRECONDITION: ...
```

Firebase will also print a URL in the same log line that you can click to
auto-create the index directly from the console.

---

## Required Composite Index — Product Earnings Clearing Query

Used by: `netlify/functions/scheduled-clear-earnings.js` (Item 9 — earnings holding period)

| Field      | Collection       | Order |
|------------|------------------|-------|
| `cleared`  | product-earnings | ASC   |
| `clearsAt` | product-earnings | ASC   |

**Query scope:** Collection

```json
{
  "collectionGroup": "product-earnings",
  "queryScope": "COLLECTION",
  "fields": [
    { "fieldPath": "cleared",  "order": "ASCENDING" },
    { "fieldPath": "clearsAt", "order": "ASCENDING" }
  ]
}
```

## Required Composite Index — Affiliate Earnings Clearing Query

Used by: `netlify/functions/scheduled-clear-earnings.js` (Item 9 — earnings holding period)

| Field      | Collection         | Order |
|------------|---------------------|-------|
| `cleared`  | affiliate-earnings | ASC   |
| `clearsAt` | affiliate-earnings | ASC   |

**Query scope:** Collection

```json
{
  "collectionGroup": "affiliate-earnings",
  "queryScope": "COLLECTION",
  "fields": [
    { "fieldPath": "cleared",  "order": "ASCENDING" },
    { "fieldPath": "clearsAt", "order": "ASCENDING" }
  ]
}
```

Note: if either of these indexes is missing, `scheduled-clear-earnings.js`
logs the error and simply skips that half of the job on that run (non-fatal
to the other one) — it will catch up automatically once the index finishes
building, since `clearsAt` only ever moves further into the past for
already-existing unfulfilled records.

## Required Composite Index — Dashboard "This Month" Monthly Stats Query

Used by: `dashboard.html` (section 5 — "This Month" earned/escrow calculation)

| Field           | Collection | Order |
|-----------------|------------|-------|
| `freelancerUid` | projects   | ASC   |
| `createdAt`     | projects   | ASC   |

**Query scope:** Collection

```json
{
  "collectionGroup": "projects",
  "queryScope": "COLLECTION",
  "fields": [
    { "fieldPath": "freelancerUid", "order": "ASCENDING" },
    { "fieldPath": "createdAt",     "order": "ASCENDING" }
  ]
}
```

Note: if this index is missing or still building, `dashboard.html` automatically
falls back to computing monthly totals from the 5 most-recently-loaded projects
(the same behaviour as before this fix) so the page never breaks — it just logs a
console warning. Create the index to get accurate totals once you have freelancers
with more than 5 projects.

---

## Required Composite Index — Invoice Overdue / Auto-Dispute Query

Used by: `netlify/functions/scheduled-clear-earnings.js` (invoice escrow auto-dispute on overdue delivery)

| Field       | Collection | Order |
|-------------|------------|-------|
| `status`    | invoices   | ASC   |
| `deliverBy` | invoices   | ASC   |

**Query scope:** Collection

```json
{
  "collectionGroup": "invoices",
  "queryScope": "COLLECTION",
  "fields": [
    { "fieldPath": "status",    "order": "ASCENDING" },
    { "fieldPath": "deliverBy", "order": "ASCENDING" }
  ]
}
```

---

## Required Composite Index — Invoice Auto-Release Query

Used by: `netlify/functions/scheduled-clear-earnings.js` (invoice escrow auto-release after delivery)

| Field         | Collection | Order |
|---------------|------------|-------|
| `status`      | invoices   | ASC   |
| `deliveredAt` | invoices   | ASC   |

**Query scope:** Collection

```json
{
  "collectionGroup": "invoices",
  "queryScope": "COLLECTION",
  "fields": [
    { "fieldPath": "status",      "order": "ASCENDING" },
    { "fieldPath": "deliveredAt", "order": "ASCENDING" }
  ]
}
```

---

## Required Composite Index — Buyer Projects Query

Used by: `buyer-projects.html`, `buyer-payments.html` (projects half), `buyer-dashboard.html`
(main project list, "This Month" stats reuses the same shape from the buyer's side)

| Field      | Collection | Order      |
|------------|------------|------------|
| `buyerUid` | projects   | ASC        |
| `createdAt`| projects   | DESC       |

**Query scope:** Collection

```json
{
  "collectionGroup": "projects",
  "queryScope": "COLLECTION",
  "fields": [
    { "fieldPath": "buyerUid",  "order": "ASCENDING" },
    { "fieldPath": "createdAt", "order": "DESCENDING" }
  ]
}
```

Note: this is distinct from the existing `freelancerUid` + `createdAt` index above —
that one serves the freelancer-side dashboard, this one serves the buyer-side pages.
Both are required; neither substitutes for the other.

## Required Composite Index — Buyer Payments (Product Orders) Query

Used by: `buyer-payments.html` (product-orders half)

| Field      | Collection      | Order |
|------------|-----------------|-------|
| `buyerUid` | product-orders  | ASC   |
| `createdAt`| product-orders  | DESC  |

**Query scope:** Collection

```json
{
  "collectionGroup": "product-orders",
  "queryScope": "COLLECTION",
  "fields": [
    { "fieldPath": "buyerUid",  "order": "ASCENDING" },
    { "fieldPath": "createdAt", "order": "DESCENDING" }
  ]
}
```

## Required Composite Index — Buyer Purchases / Recent Purchases Query

Used by: `buyer-purchases.html` (primary buyerUid query), `buyer-dashboard.html`
(Recent Purchases section)

| Field           | Collection      | Order |
|-----------------|-----------------|-------|
| `buyerUid`      | product-orders  | ASC   |
| `paymentStatus` | product-orders  | ASC   |
| `createdAt`     | product-orders  | DESC  |

**Query scope:** Collection

```json
{
  "collectionGroup": "product-orders",
  "queryScope": "COLLECTION",
  "fields": [
    { "fieldPath": "buyerUid",      "order": "ASCENDING" },
    { "fieldPath": "paymentStatus", "order": "ASCENDING" },
    { "fieldPath": "createdAt",     "order": "DESCENDING" }
  ]
}
```

Note: `buyer-purchases.html`'s guest-order-by-email fallback used to run this
same shape (`buyerEmail` + `paymentStatus` + `createdAt`) directly from the
client and was always blocked by `firestore.rules` with `permission-denied`
(fixed separately — see issue 3 / `get-guest-purchases.js`). That lookup now
runs server-side via the Admin SDK, which bypasses rules but still needs the
composite index below for the query itself to succeed efficiently.

## Required Composite Index — Guest Purchases By Email Query

Used by: `netlify/functions/get-guest-purchases.js`

| Field           | Collection      | Order |
|-----------------|-----------------|-------|
| `buyerEmail`    | product-orders  | ASC   |
| `paymentStatus` | product-orders  | ASC   |
| `createdAt`     | product-orders  | DESC  |

**Query scope:** Collection

```json
{
  "collectionGroup": "product-orders",
  "queryScope": "COLLECTION",
  "fields": [
    { "fieldPath": "buyerEmail",    "order": "ASCENDING" },
    { "fieldPath": "paymentStatus", "order": "ASCENDING" },
    { "fieldPath": "createdAt",     "order": "DESCENDING" }
  ]
}
```

Note: if this index is missing, `get-guest-purchases.js` logs the error and
returns a 500; `buyer-purchases.html` treats that as non-fatal (the primary
buyerUid query already succeeded) and just logs a console warning, so the
page still loads — guest orders simply won't appear until the index finishes
building.

### Symptom if any of these three are missing

`buyer-projects.html`, `buyer-payments.html`, `buyer-dashboard.html`, and
`buyer-purchases.html` will fail to load their primary lists. Each page now
checks for Firestore's `FAILED_PRECONDITION` error code specifically and will
show "Setting up — try again in a minute" instead of a generic load failure,
since a newly-created index can take a minute or two to finish building. Open
the browser console (or Netlify/Firebase logs if server-rendered) — Firestore
prints a direct link to auto-create the missing index right in the error.

---

## Required Composite Index — Dashboard Contracts Query

Used by: `dashboard-contracts.html` (`loadContracts`)

This page queries the `contracts` collection as either the freelancer or the
buyer depending on the signed-in user's role — that's two distinct query
shapes against two different fields, so **both** of the indexes below are
required (one substitutes for neither of the other).

| Field           | Collection | Order |
|-----------------|------------|-------|
| `freelancerUid` | contracts  | ASC   |
| `createdAt`     | contracts  | DESC  |

| Field      | Collection | Order |
|------------|------------|-------|
| `buyerUid` | contracts  | ASC   |
| `createdAt`| contracts  | DESC  |

**Query scope:** Collection (both)

```json
{
  "collectionGroup": "contracts",
  "queryScope": "COLLECTION",
  "fields": [
    { "fieldPath": "freelancerUid", "order": "ASCENDING" },
    { "fieldPath": "createdAt",     "order": "DESCENDING" }
  ]
}
```

```json
{
  "collectionGroup": "contracts",
  "queryScope": "COLLECTION",
  "fields": [
    { "fieldPath": "buyerUid",  "order": "ASCENDING" },
    { "fieldPath": "createdAt", "order": "DESCENDING" }
  ]
}
```

Note: this is a separate collection from `projects`, so the existing
`freelancerUid + createdAt` and `buyerUid + createdAt` indexes documented
above (which serve `dashboard.html` and the buyer-side pages against
`projects`) do **not** cover this query — `contracts` needed its own pair.

### How to create manually

1. Go to [Firebase Console](https://console.firebase.google.com)
2. Select your project → **Firestore Database** → **Indexes** tab
3. Click **Composite** → **Add Index**
4. Create the first one — Collection ID: `contracts`, Field 1: `freelancerUid` (Ascending), Field 2: `createdAt` (Descending), Query scope: **Collection**
5. Repeat for the second — Collection ID: `contracts`, Field 1: `buyerUid` (Ascending), Field 2: `createdAt` (Descending), Query scope: **Collection**
6. Click **Create** for each and wait ~1–2 minutes for them to build

### How to create via Firebase CLI

Both entries have already been added to `firestore.indexes.json` in this
project. Just deploy:

```bash
firebase deploy --only firestore:indexes
```

### Symptom if missing

`dashboard-contracts.html` will fail to load the contracts list and show
"Could not load contracts. Pull down to refresh." — and since pulling to
refresh just re-runs the identical failing query, it will appear to hang
forever until the index is created and finishes building.

---

## Required Composite Index — Dashboard Earnings Payouts Query

Used by: `dashboard-earnings.html` (`loadEarningsData`, Query 3 — payouts list)

| Field      | Collection | Order |
|------------|------------|-------|
| `userUid`  | payouts    | ASC   |
| `createdAt`| payouts    | DESC  |

**Query scope:** Collection

```json
{
  "collectionGroup": "payouts",
  "queryScope": "COLLECTION",
  "fields": [
    { "fieldPath": "userUid",   "order": "ASCENDING" },
    { "fieldPath": "createdAt", "order": "DESCENDING" }
  ]
}
```

### How to create manually

1. Go to [Firebase Console](https://console.firebase.google.com)
2. Select your project → **Firestore Database** → **Indexes** tab
3. Click **Composite** → **Add Index**
4. Collection ID: `payouts`, Field 1: `userUid` (Ascending), Field 2: `createdAt` (Descending), Query scope: **Collection**
5. Click **Create** and wait ~1–2 minutes for it to build

### How to create via Firebase CLI

Already added to `firestore.indexes.json` in this project. Just deploy:

```bash
firebase deploy --only firestore:indexes
```

### Symptom if missing

This query is now wrapped in its own try/catch in `loadEarningsData`, separate
from the other earnings queries and the user balance/plan fetch that follows
it. So if this index is missing, only the **Payouts** section of
`dashboard-earnings.html` will show "Setting up — try again in a minute" (via
toast) and an empty payouts table — the Earnings/Payments tabs and the
balance cards will still load normally from the other queries.

---

## Required Composite Indexes — Affiliate Dashboard Queries

Used by: `dashboard-affiliate.html` (`loadAffiliateDashboard`)

| Field          | Collection         | Order |
|----------------|--------------------|-------|
| `affiliateUid` | affiliate-earnings | ASC   |
| `createdAt`    | affiliate-earnings | DESC  |

| Field | Collection        | Order |
|-------|-------------------|-------|
| `uid` | affiliate-payouts | ASC   |
| `createdAt` | affiliate-payouts | DESC |

**Query scope:** Collection (both)

```json
{
  "collectionGroup": "affiliate-earnings",
  "queryScope": "COLLECTION",
  "fields": [
    { "fieldPath": "affiliateUid", "order": "ASCENDING" },
    { "fieldPath": "createdAt",    "order": "DESCENDING" }
  ]
}
```

```json
{
  "collectionGroup": "affiliate-payouts",
  "queryScope": "COLLECTION",
  "fields": [
    { "fieldPath": "uid",       "order": "ASCENDING" },
    { "fieldPath": "createdAt", "order": "DESCENDING" }
  ]
}
```

Note: `affiliate-earnings` already has a separate `cleared + clearsAt` index
(documented above) used by `scheduled-clear-earnings.js` — that one does not
cover this query shape, since it's a different pair of fields on the same
collection. Both indexes are required independently.

### Symptom if missing

`loadAffiliateDashboard` has no internal try/catch of its own — errors
propagate to the caller's try/catch, which now detects `FAILED_PRECONDITION`
and shows "Setting up — try again in a minute" instead of the generic
"Could not load affiliate data" toast.

---

## Required Composite Index — Dashboard Invoices Query

Used by: `dashboard-invoices.html` (`loadInvoices`)

| Field | Collection | Order |
|-------|------------|-------|
| `uid` | invoices   | ASC   |
| `createdAt` | invoices | DESC |

**Query scope:** Collection

```json
{
  "collectionGroup": "invoices",
  "queryScope": "COLLECTION",
  "fields": [
    { "fieldPath": "uid",       "order": "ASCENDING" },
    { "fieldPath": "createdAt", "order": "DESCENDING" }
  ]
}
```

Note: `invoices` already has two other composite indexes (`status+deliverBy`
and `status+deliveredAt`, documented above) used by the server-side
`scheduled-clear-earnings.js` job. Neither covers this client-side query —
all three are required independently.

### Symptom if missing

`loadInvoices` now detects `FAILED_PRECONDITION` and shows "Setting up — try
again in a minute" instead of letting the page hang on an uncaught error.

---

## Required Composite Indexes — Reviews Queries

Used by: `p.html` (product page — seller's product reviews, two query
shapes) and `profile.html` (freelancer profile — visible reviews only)

| Field        | Collection | Order |
|--------------|------------|-------|
| `targetUid`  | reviews    | ASC   |
| `sourceType` | reviews    | ASC   |
| `createdAt`  | reviews    | DESC  |

| Field       | Collection | Order |
|-------------|------------|-------|
| `targetUid` | reviews    | ASC   |
| `createdAt` | reviews    | DESC  |

| Field       | Collection | Order |
|-------------|------------|-------|
| `targetUid` | reviews    | ASC   |
| `visible`   | reviews    | ASC   |
| `createdAt` | reviews    | DESC  |

**Query scope:** Collection (all three)

```json
{
  "collectionGroup": "reviews",
  "queryScope": "COLLECTION",
  "fields": [
    { "fieldPath": "targetUid",  "order": "ASCENDING" },
    { "fieldPath": "sourceType", "order": "ASCENDING" },
    { "fieldPath": "createdAt",  "order": "DESCENDING" }
  ]
}
```

```json
{
  "collectionGroup": "reviews",
  "queryScope": "COLLECTION",
  "fields": [
    { "fieldPath": "targetUid", "order": "ASCENDING" },
    { "fieldPath": "createdAt", "order": "DESCENDING" }
  ]
}
```

```json
{
  "collectionGroup": "reviews",
  "queryScope": "COLLECTION",
  "fields": [
    { "fieldPath": "targetUid", "order": "ASCENDING" },
    { "fieldPath": "visible",   "order": "ASCENDING" },
    { "fieldPath": "createdAt", "order": "DESCENDING" }
  ]
}
```

Note: `reviews` rules allow public read (`allow read: if true`), so this is a
pure performance/index gap, not a security gap — all three are distinct
query shapes used in different places and none substitutes for another.

### Symptom if missing

`p.html` and `profile.html` now detect `FAILED_PRECONDITION` on these queries
and show "Setting up — try again in a minute" instead of letting the
reviews section silently fail to render.

---

## Firestore Security Rules — escrow-holds collection

`escrow-holds` is written exclusively by the Admin SDK (server-side Netlify
functions). No client should ever read or write it directly.

Add this rule to your `firestore.rules` file (apply in Firebase Console or
via `firebase deploy --only firestore:rules`):

```
match /escrow-holds/{docId} {
  allow read, write: if false;
}
```

Place it inside the existing `match /databases/{database}/documents { ... }`
block alongside your other collection rules.
