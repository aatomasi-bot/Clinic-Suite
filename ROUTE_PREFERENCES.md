# ROUTE_PREFERENCES.md — VaPiq Clinical Suite
*Living document. Paste this at the start of every new Claude session to restore context.*

---

## HOME BASE

**H4N 1N4 — Cartierville / Saint-Laurent, Montréal**
Home is ALWAYS the departure point. It is never counted as a stop.

> ⚠️ Previous session errors: Claude had assumed H4J 1T2, then H8S (Lachine) — both WRONG. Confirmed home is H4N 1N4.

---

## SPECIAL TRIGGER RULE — 32 Rue Vermette

> **When 32 Rue Vermette, Saint-Eustache is on the plan → it is always STOP #1.**
> Home still departs first, but Vermette is visited before any other patient stop.
> The rest of the route then continues in the normal NW → NE horseshoe arc.

**Confirmed order with Vermette present (May 25, 2026):**
`Home → Vermette → Guindon → Rang du Domaine (NW apex) → Damien-Cyr → Mascouche (NE apex) → Thomas Lapointe → Lévesque Est → 15e Rue → Coughtry`

---

## LAVAL / NORTH CIRCUIT — Step Order (from H4N)

Shape: **clockwise horseshoe** — start local, sweep NW to far apex, arc NE to far apex, return local.

| Step | Zone | Example addresses | Notes |
|------|------|-------------------|-------|
| Special | Saint-Eustache | 32 Rue Vermette | **Always first if present** |
| 1 | Local / St-Laurent | Coughtry H4L | Closest to home — visited LAST when no Vermette; first after Vermette trigger |
| 2 | West Laval entry | 15e Rue H7N | Enter Laval close to H4N |
| 3 | East Laval | Lévesque Est H7G | Sweep east in Laval |
| 4 | NW Laval | Damien-Cyr H7L | Swing northwest through Laval |
| 5 | Saint-Eustache | Vermette J7P, Guindon J7R | NW cluster |
| 6 | Far NW apex | Rang du Domaine J0N / Deux-Montagnes | **Furthest NW point** |
| 7 | NE arc | Terrebonne J6W | Swing northeast |
| 8 | Far NE apex | Mascouche J7K | **Furthest NE point** |

**Without Vermette:** Home → local (Coughtry) → W Laval → E Laval → Terrebonne → Mascouche (NE apex) → NW Laval → Saint-Eustache → far NW apex (end)

**With Vermette:** Home → Vermette (first!) → Saint-Eustache cluster → far NW apex → NW Laval → Mascouche (NE apex) → Terrebonne → E Laval → W Laval → Coughtry (end)

---

## MONTREAL CIRCUIT — Step Order (from H4N)

Shape: **SW-to-NE arc** ending in north Montreal.

| Step | FSA(s) | Neighbourhood |
|------|--------|---------------|
| 1 | H8S, H8R | Lachine |
| 2 | H8N, H8P | LaSalle |
| 3 | H3E | Nun's Island / Île-des-Sœurs |
| 4 | H4C, H4E | St-Henri / LaSalle east |
| 5 | H3W | NDG / Queen Mary |
| 6 | H3T | Côte-Ste-Catherine |
| 7 | H3S, H3X | Appleton / CDN upper |
| 8 | H2X, H3H | Sherbrooke O / Downtown |
| 9 | J5Y, J5Z, J6A | Repentigny — **NE apex** |
| 10 | H2M | Chabanel / Ahuntsic |
| 11 | H3N, H2V | Park-Extension / Outremont — **last** |

---

## CRITICAL RULES (all circuits)

1. **Home (H4N) always departs first** — never skip this.
2. **32 Rue Vermette = always stop #1** when present.
3. **North Montreal (H2M, H3N, H2V) is LAST** on Montreal circuit — Claude's biggest recurring error is putting these first.
4. **Far apexes are visited near the end**, not the beginning (except Vermette trigger).
5. **Local stops are last** on normal days (end near home). With Vermette trigger, local stops shift to the end.

---

## ROUTE COMPARISONS LOG

| # | Date | Route | Key learning | In scheduler? |
|---|------|-------|--------------|---------------|
| 1 | May 24, 2026 | Jun 10 Montreal | South Shore middle; far east last; home base error corrected | ❌ Pending |
| 2 | May 24, 2026 | Same 12 Montreal addresses | North last confirmed; J5Y apex confirmed; home = H4N confirmed | ❌ Pending |
| 3 | May 25, 2026 | 9-stop Laval/NE circuit | Horseshoe shape confirmed; Vermette = stop #1 rule established | ❌ Pending |

---

## SCHEDULER LOGIC (current state)

- Classifies patients by FSA → circuit + step
- Plans 14 days respecting caps and ±3-day windows
- Sorts each day by circuit step order
- Stores plan in sessionStorage

**FSA table**: needs update — apply corrected step orders above once 3 confirmations per rule.

---

## PROJECT INFO

- **App**: VaPiq Clinical Suite
- **GitHub**: aatomasi-bot.github.io/Clinic-Suite/
- **Supabase**: wqlbmtjbjloxpvsbeqyb.supabase.co
- **Files**: index.html (437KB), scheduler.html (84KB), ROUTE_PREFERENCES.md

---

## HOW TO USE THIS FILE

At the start of a new Claude session:
1. Open this file from GitHub
2. Paste its full contents into Claude
3. Claude restores full context instantly

When sharing a new route comparison:
- Share both maps (your preferred + Claude's output)
- Claude updates the log and extracts rules
- 3 confirmations → rule applied to scheduler.html

---

*Maintained by Claude. Part of VaPiq Clinical Suite.*
*Last updated: May 25, 2026 — Vermette trigger rule added. Laval horseshoe circuit documented.*

---

## SATURDAY SPECIAL RULES

> **Saturday is the INVERSE of weekday routing.**

### Core Saturday Rule
- **Start at the FARTHEST patient from home** — not the closest
- First appointment = **8:00 AM** → leave home early enough to reach the far patient on time
- Route sweeps progressively BACK toward home throughout the day
- Last patients of the day are the ones closest to home (H4N area)
- This way fatigue at end of day = short drive home

### Saturday Arc Pattern (confirmed May 25, 2026 — 14-stop route)
`Far west apex → West Island → LaSalle south → LaSalle → NDG → Verdun → Nun's Island → St-Henri → Westmount → Far east (Old Port) → Plateau → Villeray → Snowdon (end near home)`

**Confirmed stop order:**
1. 490 Av du Parc, Vaudreuil (J7V) ← **START — absolute farthest**
2. 145 Av Cartier, Pointe-Claire (H9S)
3. 8318 Av des Rapides, LaSalle (H8P)
4. 6261 Rue Jogues, LaSalle (H4E)
5. 2219 Av Prud'Homme, NDG (H4A)
6. 779 Rue Hickson, Verdun (H4G)
7. 325 Ch. Pointe-Sud, Nun's Island (H3E) ← after Verdun on Saturdays
8. 2700 Rue Rufus-Rockhead, St-Henri (H3J)
9. 464 Av Elm, Westmount (H3Y)
10. 1000 Rue Commune Est, Old Port (H2L) ← far east visited mid-route
11. 2547 Rue Chapleau, Plateau (H2K)
12. 524 Rue Castelnau E, Villeray (H2R)
13. 8511 Av Chateaubriand, Villeray (H2P)
14. 4080 Av Kindersley, Snowdon (H4P) ← **END — closest to home**

### How to Identify the "Farthest" Patient
- Compare straight-line distance from H4N to each patient
- Vaudreuil (J7V), Repentigny (J5Y), Mascouche (J7K), Brossard (J4W) = candidates for far starts
- If two patients are equally far in opposite directions → pick the westernmost first (west→east sweep)

### Saturday vs Weekday Comparison
| Rule | Weekday | Saturday |
|------|---------|----------|
| Start | Near home (local first) | Farthest patient |
| End | Far apex or north cluster | Near home (Snowdon/local) |
| First appt | Morning, any time | 8:00 AM |
| Direction | Home → outward | Outward → home |

---

## ROUTE COMPARISONS LOG (updated)

| # | Date | Route | Key learning | In scheduler? |
|---|------|-------|--------------|---------------|
| 1 | May 24, 2026 | Jun 10 Montreal | South Shore middle; far east last; home base error corrected | ❌ Pending |
| 2 | May 24, 2026 | Same 12 Montreal addresses | North last confirmed; J5Y apex confirmed; home = H4N confirmed | ❌ Pending |
| 3 | May 25, 2026 | 9-stop Laval/NE circuit | Horseshoe shape; Vermette = stop #1 rule | ❌ Pending |
| 4 | May 25, 2026 | 14-stop Saturday Jun 6 | **Saturday rule: start farthest, end near home; 8 AM first patient** | ❌ Pending |

*Last updated: May 25, 2026 — Saturday routing rules added.*
