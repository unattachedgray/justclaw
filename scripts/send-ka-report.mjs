/**
 * One-shot script: Generate and send the Kennedy Access daily report via email.
 * Usage: node scripts/send-ka-report.mjs
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Load .env into process.env
try {
  const lines = readFileSync(join(ROOT, '.env'), 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx);
      if (!process.env[key]) process.env[key] = trimmed.slice(eqIdx + 1);
    }
  }
} catch { /* no .env */ }

const { sendEmail } = await import('../dist/email.js');

const TO = process.argv[2] || 'banking-news@kennedyaccess.com';
const subject = 'Kennedy Access Daily — Immigration & Labor Market Report — March 24, 2026';

// Plain text version (Google Groups/Chat renders this well)
const text = `KENNEDY ACCESS DAILY — March 24, 2026
Immigration & Labor Market Intelligence
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

VISA BULLETIN — April 2026 (Current Month: March 2026)

Category           Final Action    Dates for Filing   Notes
─────────────────  ─────────────   ────────────────   ──────────────────
EB-3 World         01-JUN-2024     ★ CURRENT ★        Dates for Filing is CURRENT
EB-3 China         15-JUN-2021     01-JAN-2022
EB-3 India         15-NOV-2013     15-JAN-2015        12+ year backlog
EB-3 Mexico        01-JUN-2024     ★ CURRENT ★        Dates for Filing is CURRENT
EB-3 Philippines   01-AUG-2023     01-JAN-2024

Other Workers WW   01-NOV-2021     01-AUG-2022
Other Workers CN   01-FEB-2019     01-OCT-2019
Other Workers IN   15-NOV-2013     15-JAN-2015
Other Workers MX   01-NOV-2021     01-AUG-2022
Other Workers PH   01-NOV-2021     01-AUG-2022

⚠ H-2B Cap Status: REACHED for 2H FY2026 (Apr-Sep)
  H-2B Supplemental: 64,716 additional visas authorized
  • 46,226 returning workers only
  • 18,490 open (cap already reached as of Feb 6)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

PROCESSING TIMES — March 2026

Form      Description              Processing Time    Trend
────────  ───────────────────────   ─────────────────  ─────
I-140     Immigrant Petition        5–22 months        →
I-485     Adjustment of Status      11–31.5 months     →
I-765     EAD (Work Permit)         2–7 months         ↓ improving
PERM      Labor Certification       16–17 months       →
PWD       Prevailing Wage Det.      ~4 months          ↓ improving
I-129     H-2B Petition             Varies             →

Premium processing (I-140): 15 business days / $2,965
PERM audit rate: ~30% of filings (adds 3–6 months)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

NEWS HEADLINES

── EB-3 & Employment-Based Immigration ──

• April 2026 Visa Bulletin: Significant Forward Movement
  EB-3 Worldwide and Mexico Dates for Filing now CURRENT. EB-3 Skilled
  Workers advanced 14+ months for rest of world. State Dept attributes
  movement to reduced consular issuance due to Trump admin travel bans
  affecting 40+ countries and visa processing pause for 75 countries.

• March 2026 Visa Bulletin Brought 2–17 Month Advances Across EB-3
  Priority dates moved forward significantly across most EB-2 and EB-3
  categories, reducing wait times.

• PERM Processing Times Remain at 16–17 Months
  DOL updated processing times as of March 5, 2026. Prevailing wage
  determinations down to ~4 months. Audit rate remains ~30%.

── H-2B & Temporary Workers ──

• Trump Admin Doubles FY2026 H-2B Cap — 64,716 Additional Visas
  DHS/DOL added 64,716 supplemental H-2B visas for FY2026. DOL received
  8,759 applications requesting 162,603 positions — demand nearly 2.5x
  available slots.

• H-2B Cap Reached for Second Half of FY2026
  USCIS confirmed statutory limit hit for Apr–Sep period. Employers
  seeking seasonal workers face severe constraints.

• H-2B Program Expansion Debate: EPI Warns Against Year-Round Use
  Economic Policy Institute argues expanding H-2B to year-round jobs
  like meatpacking would lower wages; advocates green card pathway
  instead. Directly relevant to EB-3 strategy.

── Immigration Policy & Enforcement ──

• ICE Workforce Grows 120% — 12,000 New Officers Announced
  Unprecedented recruitment campaign. 40% increase in arrests in January
  alone vs. prior year. New field offices planned by August 2026.

• 28% of Construction Firms Affected by Immigration Enforcement
  5% had ICE visit a jobsite, 10% lost workers, 20% had subcontractors
  lose staff. Staffing agencies face heightened compliance risk.

• Ohio E-Verify Mandate for Construction: Effective March 19, 2026
  All nonresidential construction contractors must now E-Verify new
  hires. Fines: $250 first offense up to $1,500+. South Dakota
  advancing similar bill.

• Philly Gig Economy Shrinking Amid ICE Fear
  Rising delivery prices, longer wait times, fewer rideshare drivers
  as immigrant workers avoid gig platforms due to enforcement fear.

── Labor Market & Workforce Demand ──

• Feb Jobs Report: Nonfarm Employment Fell 92,000
  Temp help services down 6,500 positions. But weekly staffing hours
  hit YTD highs in late February, suggesting demand divergence.

• Construction Needs 349,000 New Workers in 2026
  Down from prior years but still massive gap. Immigration enforcement
  adding upward wage pressure.

• 91% of Hospitality Leaders Say Hiring Remains Difficult
  Housekeepers hardest role to fill. Hotels, restaurants, event venues
  remain chronically understaffed.

• Healthcare Nursing Shortage: 193,100 Annual Openings vs 177,400 Entrants
  Structural 16K/year deficit projected through 2032.

• H-1B $100K Fee Waiver Bill Introduced for Healthcare Workers
  Bipartisan House bill would waive fee for foreign doctors/nurses,
  especially for rural/underserved areas.

── Staffing Industry ──

• Temp Penetration Rate Edges Down to 1.54%
  Despite headline job losses, commercial and professional staffing
  hours trending up. Mixed signals suggest sector-specific demand
  remains strong.

• Job Market for US-Born Workers Stalls Amid Immigration Policy
  Bloomberg reports tighter immigration policy hasn't boosted US-born
  employment as expected.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

LABOR MARKET SNAPSHOT — Key Industries

Industry            Shortage       Workers Needed 2026    Trend
──────────────────  ───────────    ───────────────────    ──────────────────
Construction        HIGH           349,000                Demand ↓ still massive
Healthcare/Nursing  CRITICAL       193,100/yr openings    Structural deficit
Hospitality         HIGH           91% say hard to hire   Chronic since COVID
Food Processing     HIGH           H-2B debate ongoing    ICE pressure rising
Agriculture         MOD-HIGH       H-2A demand up         Seasonal surge ahead
Transportation      MODERATE       CDL shortage ongoing   Steady
Manufacturing       MODERATE       Reshoring demand       Growing

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

ENFORCEMENT & COMPLIANCE

• Ohio E-Verify mandate now active (March 19) for all nonresidential
  construction — affects any clients placing workers in Ohio construction

• ICE arrests up 40% YoY in January — staffing agencies should ensure
  I-9 compliance is airtight

• South Dakota advancing statewide E-Verify bill — could expand
  compliance burden

• California now requires state workers to use E-Verify

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

STRATEGIC IMPLICATIONS

★ EB-3 Dates for Filing going CURRENT for World/Mexico is major
  Clients from non-backlogged countries can file I-485 immediately
  regardless of priority date. This should be communicated to eligible
  clients ASAP.

★ H-2B cap exhausted for 2H FY2026
  Employers needing seasonal workers Apr–Sep have no H-2B path. This
  creates demand for EB-3 permanent solutions. Position Kennedy Access
  as the alternative to H-2B uncertainty.

★ ICE enforcement surge = compliance opportunity
  Employers spooked by raids will seek above-board staffing solutions.
  The legal EB-3 pathway is a differentiator vs. gray-market staffing.

★ EPI arguing against H-2B expansion into meatpacking, favoring green
  cards instead — this validates the EB-3 model directly. Worth
  tracking this policy debate.

★ Construction + hospitality shortages remain severe
  Expand partner outreach to these industries beyond meatpacking/food
  processing.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

H-2B CAP MECHANICS — Quick Reference

The H-2B program has a statutory cap of 66,000 visas per fiscal year,
split evenly: 33,000 for Oct–Mar start dates, 33,000 for Apr–Sep.
Each year, DHS can authorize supplemental visas (this year: 64,716
extra). When demand exceeds supply — as it has every year — USCIS runs
a lottery. For FY2026, employers requested 162,603 positions but only
~131,000 total slots exist. This means roughly 1 in 4 applications
gets selected.

The returning worker exemption (46,226 of the supplemental visas)
gives priority to workers who held H-2B status in the last 3 years.

For Kennedy Access clients, the chronic H-2B oversubscription
reinforces the value proposition of EB-3: instead of gambling on a
lottery each year, employers get a permanent worker through green card
sponsorship.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Sources:
• State Dept Visa Bulletin (travel.state.gov)
• USCIS H-2B supplemental visa announcement
• Clark Hill — March 2026 Visa Bulletin analysis
• RN Law Group — PERM processing times update
• Ballard Spahr — ICE in the workplace 2026 update
• Construction Dive — labor demand gap
• Staffing Industry Analysts — March 2026 US jobs report
• Alston & Bird — Ohio E-Verify mandate
• Economic Policy Institute — H-2B expansion analysis
• Newsweek — H-2B visa cap reached
• Philadelphia Inquirer — gig economy/ICE impact

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Kennedy Access Group — Daily Immigration & Labor Market Intelligence
Report generated March 24, 2026
`;

const ok = await sendEmail({
  to: TO,
  subject,
  text,
});

if (ok) {
  console.log('✅ Report sent to ' + TO);
} else {
  console.error('❌ Failed to send — check SMTP config in .env');
}
