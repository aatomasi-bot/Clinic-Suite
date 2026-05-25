# ROUTE_PREFERENCES.md — VaPiq Clinical Suite
*Living document. Paste this at the start of every new Claude session to restore context.*

---

## HOME BASE

**H4N 1N4 — Cartierville / Saint-Laurent, Montréal**
All route step orders are relative to this starting point.

> ⚠️ Previous session errors: Claude had assumed H4J 1T2, then H8S (Lachine) — both WRONG. Confirmed home is H4N 1N4.

---

## CONFIRMED STEP ORDER (from H8S home base)

| Step | FSA(s) | Neighbourhood | Notes |
|------|--------|---------------|-------|
| 1 | H8S, H8R | Lachine | Home cluster — visit nearby first |
| 2 | H8N, H8P | LaSalle | Next closest after Lachine |
| 3 | H3E | Nun's Island / Île-des-Sœurs | Goes south early |
| 4 | H4C, H4E | St-Henri / LaSalle east | Returns to Montreal island |
| 5 | H3W | NDG / Queen Mary | Starts CDN sweep |
| 6 | H3T | Côte-Ste-Catherine | Mid CDN |
| 7 | H3S, H3X | Appleton / CDN upper | Continues CDN |
| 8 | H2X, H3H | Sherbrooke O / Downtown | Eastward push begins |
| 9 | J5Y, J5Z, J6A | Repentigny / NE apex | **Far-east apex — visited near end** |
| 10 | H2M | Chabanel / Ahuntsic | North on return |
| 11 | H3N, H2V | Park-Extension / Outremont | **Last cluster** |

---

## CRITICAL RULES

1. **Start local** — H8S cluster goes first, always.
2. **Nun's Island (H3E) is early** — step 3, not middle.
3. **North Montreal (H2M, H3N, H2V) is LAST** — Claude's biggest recurring error is putting these first.
4. **Repentigny (J5Y) is the apex** — second-to-last cluster, before the north Montreal finish.
5. **South Shore (Brossard J4W etc.) if present** — goes in middle range, NOT first or last.
6. The route forms a **southwest-to-northeast arc** that ends in north Montreal, not a simple shortest-distance loop.

---

## ROUTE COMPARISONS LOG

| # | Date logged | Route date | Addresses | Key learning | Applied to scheduler? |
|---|-------------|------------|-----------|--------------|----------------------|
| 1 | May 24, 2026 | Jun 10, 2026 | Mixed Montreal | South Shore middle not first; far east last; H4J assumed as home (⚠️ later corrected to H8S) | ❌ Pending |
| 2 | May 24, 2026 | (same 12 addresses) | H8S, H8S, H8N, H3E, H4C, H3W, H3T, H3S, H2X, J5Y, H2M, H3N | **Home = H8S confirmed**; North last confirmed; J5Y apex confirmed; H3E early confirmed | ❌ Pending |

---

## SCHEDULER LOGIC (current state)

The scheduler in `scheduler.html`:
1. Classifies patients by FSA → circuit + step
2. Plans 14 days respecting caps and ±3-day windows
3. Sorts each day by circuit step order
4. Stores plan in sessionStorage (survives navigation, clears on tab close)

**FSA table status**: Still uses original/incorrect step order. Needs update once 3 confirmations reached.

**Confirmations still needed before applying to scheduler:**
- [ ] Another Montreal day confirming H3N/H2M last (2 of 3 ✅)
- [ ] A route with Brossard/South Shore (J4W) — confirm exact position in arc
- [ ] A Saturday route — confirm same arc applies from H8S start
- [ ] A Friday (Laval) route — Laval circuit may have different step order entirely

---

## PROJECT INFO

- **App**: VaPiq Clinical Suite
- **GitHub**: aatomasi-bot.github.io/Clinic-Suite/
- **Supabase**: wqlbmtjbjloxpvsbeqyb.supabase.co
- **Files**: index.html (437KB), scheduler.html (84KB), ROUTE_PREFERENCES.md

---

## HOW TO USE THIS FILE

**At the start of a new Claude session:**
1. Open this file from GitHub
2. Paste its full contents into Claude
3. Claude will restore full context instantly

**When sharing a new route comparison:**
- Share both maps (your preferred + Claude's output)
- Claude will update the comparison log and extract new rules
- Once a rule is confirmed 3 times, it gets applied to scheduler.html FSA table

---

*Maintained by Claude. Part of VaPiq Clinical Suite.*
*Last updated: May 24, 2026 — Comparison #2 added. Home base corrected to H4N 1N4.*
