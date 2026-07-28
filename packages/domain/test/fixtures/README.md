# Test fixtures

## `pinpoint-export.csv`

A structurally faithful, **fully synthetic** Amazon Pinpoint endpoint export. Derived from the
shape of a real export; every identifier, address and date is invented. No real personal data is
in this repo, and none should be added — imports carry `birthDate`, `gender`, `phone` and postal
address, so a "just drop the real file in" fixture would publish exactly the PII the erasure path
(#164) exists to remove.

46 columns, matching the real layout:

| Group | Columns | Notes |
|---|---|---|
| Endpoint | `Id`, `ChannelType`, `Address`, `EndpointStatus`, `OptOut`, `RequestId` | `Address` is the email — **not** a lowercase `email` header |
| Location | `Location.*` | `Latitude`/`Longitude` are `1.0` placeholders in real exports, not coordinates |
| Consent-ish | `EffectiveDate` | An endpoint-**update** stamp. Not proof of opt-in; never record it as consent provenance |
| Lists | `Attributes.*` | One column per newsletter, three-state |
| Profile | `User.UserAttributes.*` | PII: name, birth date, gender, phone, address |

### Why each row exists

| Row | Address | Covers |
|---|---|---|
| 1 | alex.rivera | Baseline mailable endpoint: 1 `true`, 8 `false`, 14 empty |
| 2 | jordan.lee | `OptOut: ALL` **with** a `true` subscription — must never become mailable |
| 3 | sam.patel | `EndpointStatus: INACTIVE` with two `true`s — must never become mailable |
| 4 | casey.morgan | Prefixed/unprefixed **disagreement**: `Sports=true` vs `SD_Sports=false`, same for `BuyLocalInsider` and `DailyandBreakingNews`. Forces an explicit precedence rule |
| 5 | riley.chen | Non-list attribute columns (`audiences`, `companyname`, `contactOwner`) carrying **embedded commas**, plus full PII. Proves quoting survives and that these are not mistaken for audiences |
| 6 | *(blank)* | Empty `Address` — must be rejected with an error, never silently skipped |
| 7 | +15550000000 | `ChannelType: SMS` — must be filtered out, not imported as an email subscriber |
| 8 | morgan.diaz | Every attribute empty — **zero** subscriptions, not 23 declines |

### The three states

`Attributes.*` values are `true`, `false`, or **empty**, and the distinction is load-bearing:

- `true` — subscribed
- `false` — explicitly declined
- empty — **never asked**

Collapsing empty into `false` fabricates a decline the subscriber never made. Collapsing it into
`true` resurrects an opt-out. Row 8 exists so a parser that treats the file as booleans fails
loudly instead of quietly inventing 23 declines.

### Prefixes are publications

`SD_`, `SH_`, `SP_` denote different publications, so **one file can span several orgs**. Thirteen
names in a real export exist both prefixed and unprefixed; row 4 reproduces that with deliberate
disagreement between the two.

Related: #209 (export format), #216 (field mapper), #60 (import wizard consent basis).
