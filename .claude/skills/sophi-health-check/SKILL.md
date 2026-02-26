---
name: sophi-health-check
description: Run a Sophi 2.0 Phase 1 health check across multiple articles from a site — scrapes article links, then tests SDK loading, Demeter, consent, decisions/me, dataLayer, Piano, and paywall decision logic on each
disable-model-invocation: true
allowed-tools: Bash, Read, Write, Glob
argument-hint: [url] [count]
---

# Sophi 2.0 Phase 1 Health Check — Multi-Article (Headless)

Scrape article URLs from a landing page, then run the full Sophi 2.0 health check on each article using **headless Chrome via Puppeteer**. Produces a consolidated report with a per-article summary matrix and individual detail sections.

**Arguments (all optional):**
- `url` — Landing page to scrape articles from. Default: `https://www.inquirer.com`
- `count` — Number of articles to test. Default: `20`

**Examples:**
```
/sophi-health-check
/sophi-health-check https://www.inquirer.com 10
/sophi-health-check https://www.inquirer.com/sports 5
```

## Must Knows

1. All test articles must be published **<15 days ago** (except exclusions).
2. Article age is configurable in Piano and can change over time.
3. Most cases are tested with a **not-logged-in user** unless specified otherwise.
4. `outputType=app-web-view` is **excluded** from scope.
5. Create "clean" articles without exclusion criteria for testing.
6. Clear cache frequently when testing no-paywall exclusions.
7. Sandbox/Prod Piano settings differ — request prod bundle if needed.
8. Known issue: no Sophi on checkout/subscribe pages (fixed Sprint W-2025).
9. Search logs filtering by `/(piano|sophi|quickstart)/`.
10. Sophi decision is final on content **<15 days** considering exclusions.
11. Request vendor to force "no-wall" on 2-3 prod URLs for validation.

## Critical Technical Constraints

1. **Puppeteer `page.evaluate()` runs in the main world** — `window.sophi`, `window.tp`, and `PMNdataLayer` are all directly accessible. No isolated-world workarounds needed.
2. **`page.evaluate()` returns values directly** — no "title trick" needed. Return JSON objects straight from the evaluate callback.
3. **Page load time**: Sophi SDK, Demeter, and Piano all load asynchronously. Use `waitForNetworkIdle` plus a fixed delay to ensure everything has initialized.
4. **Headless mode**: No visible browser window. Works on any OS. Faster than headed mode.
5. **Single browser context, sequential navigation**: Reuse one incognito page. Each `page.goto()` resets `performance` entries — desired for clean per-article measurements.
6. **No size limits**: Unlike the title trick, `page.evaluate()` can return arbitrarily large objects.

---

## Phase 0: Parse Arguments & Write Collector Script

Parse the optional arguments from the user's input:

```
BASE_URL = first argument, or "https://www.inquirer.com"
COUNT = second argument (integer), or 20
```

Extract a short domain label from BASE_URL for the report filename (e.g., `www.inquirer.com` → `inquirer`).

Then write the Puppeteer collector script to `/tmp/sophi-health-check.mjs`. This single script handles the entire data collection pipeline: launching headless Chrome, scraping articles, running all 21 checks on each, and outputting structured JSON.

```bash
cat > /tmp/sophi-health-check.mjs << 'SCRIPT_EOF'
import puppeteer from 'puppeteer';

const BASE_URL = process.argv[2] || 'https://www.inquirer.com';
const COUNT = parseInt(process.argv[3], 10) || 20;

(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');

  // ---- Phase 1: Scrape article URLs ----
  await page.goto(BASE_URL, { waitUntil: 'networkidle2', timeout: 60000 });
  await new Promise(r => setTimeout(r, 3000));

  const articles = await page.evaluate(() => {
    const links = document.querySelectorAll('a[href]');
    const seen = {};
    const results = [];
    const base = window.location.origin;
    for (const link of links) {
      const href = link.href;
      if (!href.startsWith(base)) continue;
      const path = href.replace(base, '');
      if (!path || path === '/') continue;
      if (/^\/(author|staff|tags?|topic|search|subscribe|checkout|newsletters?|about|contact|privacy|terms|faq|help|account|login|signup)\//i.test(path)) continue;
      if (/^\/#/.test(path) || /\?outputType=/.test(path)) continue;
      const segments = path.replace(/^\//, '').replace(/\/$/, '').split('/');
      if (segments.length < 2) continue;
      const canonical = href.split('?')[0].split('#')[0];
      if (seen[canonical]) continue;
      seen[canonical] = true;
      results.push({
        url: canonical,
        text: (link.textContent || '').trim().substring(0, 120)
      });
    }
    return results;
  });

  const selected = articles.slice(0, COUNT);
  const output = { baseUrl: BASE_URL, count: COUNT, articlesFound: articles.length, selected: selected.length, results: [] };

  // ---- Phase 2: Run checks on each article ----
  for (let idx = 0; idx < selected.length; idx++) {
    const articleUrl = selected[idx].url;
    const articleText = selected[idx].text;
    process.stderr.write(`[${idx + 1}/${selected.length}] ${articleUrl}\n`);

    try {
      await page.goto(articleUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    } catch (e) {
      output.results.push({ url: articleUrl, headline: articleText, error: 'Navigation timeout: ' + e.message, netdom: null, windata: null });
      continue;
    }
    // Extra wait for Sophi SDK, Piano, Demeter, dataLayer to initialize
    await new Promise(r => setTimeout(r, 12000));

    // -- Injection 1: Network & DOM data (runs in main world) --
    const netdom = await page.evaluate(() => {
      const r = {};
      const entries = performance.getEntriesByType('resource');

      // Check #1: Sophi SDK
      r.sophiScripts = [];
      for (const e of entries) {
        if (e.name.indexOf('sophi') > -1 && e.name.indexOf('.js') > -1) {
          r.sophiScripts.push({ url: e.name.substring(0, 200), type: e.initiatorType, ms: Math.round(e.duration) });
        }
      }

      // Check #2: Demeter in network
      r.demeterNet = [];
      for (const e of entries) {
        if (e.name.toLowerCase().indexOf('demeter') > -1) {
          r.demeterNet.push({ url: e.name.substring(0, 200), hasConsent: e.name.indexOf('isConsented') > -1, type: e.initiatorType });
        }
      }

      // Check #3: Demeter DOM attributes
      r.demeterDOM = [];
      for (const s of document.querySelectorAll('script[src]')) {
        if (s.src.toLowerCase().indexOf('demeter') > -1) {
          r.demeterDOM.push({ src: s.src.substring(0, 200), id: s.id || null, async: s.async, defer: s.defer });
        }
      }

      // Check #4: Consent
      const otBanner = document.getElementById('onetrust-banner-sdk');
      r.consent = {
        bannerExists: !!otBanner,
        bannerVisible: otBanner ? (getComputedStyle(otBanner).display !== 'none') : false
      };
      const cNames = ['OptanonActiveGroups', 'OptanonConsent', 'OTGPPConsent', 'OptanonAlertBoxClosed'];
      for (const c of document.cookie.split(';')) {
        const eq = c.indexOf('=');
        if (eq > -1) {
          const n = c.substring(0, eq).trim();
          if (cNames.includes(n)) {
            try { r.consent[n] = decodeURIComponent(c.substring(eq + 1)).substring(0, 200); }
            catch { r.consent[n] = c.substring(eq + 1).substring(0, 200); }
          }
        }
      }

      // Check #5: decisions/me
      r.decisionCalls = [];
      for (const e of entries) {
        if (e.name.indexOf('decisions/me') > -1 || e.name.indexOf('decisions%2Fme') > -1) {
          r.decisionCalls.push({ url: e.name.substring(0, 200), type: e.initiatorType, ms: Math.round(e.duration) });
        }
      }

      // Network summary
      r.netCounts = { piano: 0, sophi: 0, gtm: 0, quickstart: 0, total: entries.length };
      for (const e of entries) {
        const u = e.name.toLowerCase();
        if (u.indexOf('piano.io') > -1 || u.indexOf('tinypass') > -1) r.netCounts.piano++;
        if (u.indexOf('sophi') > -1) r.netCounts.sophi++;
        if (u.indexOf('googletagmanager.com') > -1 || u.indexOf('google-analytics.com/g/collect') > -1 || u.indexOf('server-side-tagging') > -1) r.netCounts.gtm++;
        if (u.indexOf('quickstart') > -1) r.netCounts.quickstart++;
      }

      return r;
    });

    // -- Injection 2: Window & DataLayer data (main world — direct access) --
    const windata = await page.evaluate(() => {
      const r = {};

      // PMNdataLayer (Checks #6, #7, #8)
      r.dl = { sophiDecision: null, pageviewTrace: null, pianoMeter: null, eventList: [], total: 0 };
      if (typeof PMNdataLayer !== 'undefined' && Array.isArray(PMNdataLayer)) {
        r.dl.total = PMNdataLayer.length;
        for (let i = 0; i < PMNdataLayer.length; i++) {
          const e = PMNdataLayer[i];
          const n = e.event || e.eventName || '';
          r.dl.eventList.push(n);
          if ((n.toLowerCase().indexOf('sophi') > -1 || e.sophi_decision !== undefined) && !r.dl.sophiDecision) {
            r.dl.sophiDecision = { event: n, decision: e.sophi_decision ?? null, source: e.sophi_decision_source ?? null, trace: e.sophi_trace_id ?? null };
          }
          if ((n === 'pageview' || n === 'page_view') && !r.dl.pageviewTrace) {
            r.dl.pageviewTrace = { event: n, trace: e.sophi_trace_id ?? null };
          }
          if ((n.indexOf('piano') > -1 || n.indexOf('meter') > -1) && !r.dl.pianoMeter) {
            r.dl.pianoMeter = { event: n, trace: e.sophi_trace_id ?? null };
          }
        }
      } else { r.dl.error = 'PMNdataLayer not found'; }

      // Trace IDs (Check #9)
      r.trace = { ids: {} };
      if (r.dl.sophiDecision?.trace) r.trace.ids.dl_sophi = r.dl.sophiDecision.trace;
      if (r.dl.pageviewTrace?.trace) r.trace.ids.dl_pageview = r.dl.pageviewTrace.trace;
      if (typeof window.sophi !== 'undefined') {
        r.trace.ids.window_sophi = window.sophi.traceId || window.sophi.trace_id || window.sophi.sophi_trace_id || null;
      }
      const tv = Object.values(r.trace.ids).filter(v => v !== null);
      r.trace.allMatch = tv.length > 0 && tv.every(v => v === tv[0]);

      // Piano (Checks #14, #15, #16)
      r.piano = { tpExists: false };
      if (typeof window.tp !== 'undefined') {
        r.piano.tpExists = true;
        r.piano.aid = window.tp.aid || null;
        r.piano.hostname = window.location.hostname;
        r.piano.tpHostname = window.tp.host || window.tp.hostname || null;
        r.piano.customVars = null;
        r.piano.sophiInCV = false;
        if (window.tp.customVariables) {
          r.piano.customVars = {};
          for (const k in window.tp.customVariables) {
            r.piano.customVars[k] = String(window.tp.customVariables[k]).substring(0, 100);
            if (k.toLowerCase().indexOf('sophi') > -1 || k.toLowerCase().indexOf('decision') > -1) r.piano.sophiInCV = true;
          }
        }
      }

      // Visitor type (Check #17)
      r.visitor = {};
      if (typeof window.sophi !== 'undefined') {
        r.visitor.fromWindow = window.sophi.visitorType || window.sophi.visitor_type || null;
      }
      if (typeof PMNdataLayer !== 'undefined' && Array.isArray(PMNdataLayer)) {
        for (const e of PMNdataLayer) {
          if (e.visitor_type || e.visitorType) {
            r.visitor.fromDL = e.visitor_type || e.visitorType;
            break;
          }
        }
      }

      // window.sophi vs dataLayer (Check #18)
      r.sophiMatch = { hasWindow: typeof window.sophi !== 'undefined', hasDL: !!r.dl.sophiDecision, matches: {}, mismatches: {} };
      if (r.sophiMatch.hasWindow && r.sophiMatch.hasDL) {
        const ws = window.sophi;
        const ds = r.dl.sophiDecision;
        const fields = [['sophi_decision', 'decision'], ['sophi_decision_source', 'source'], ['sophi_trace_id', 'trace']];
        for (const [wKey, dKey] of fields) {
          const wv = ws[wKey] || ws[wKey.replace('sophi_', '')] || null;
          const dv = ds[dKey] || null;
          if (wv === dv) r.sophiMatch.matches[wKey] = wv;
          else r.sophiMatch.mismatches[wKey] = { w: wv, dl: dv };
        }
      }

      // Decision logic & article age (Checks #19, #20)
      r.age = {};
      const pm = document.querySelector('meta[property="article:published_time"], meta[name="publish-date"], meta[name="sailthru.date"]');
      r.age.publishDate = pm ? pm.content : null;
      if (r.age.publishDate) {
        const pd = new Date(r.age.publishDate);
        r.age.days = Math.floor((new Date() - pd) / 86400000);
        r.age.under15 = r.age.days < 15;
      }
      if (typeof window.sophi !== 'undefined') {
        r.age.decision = window.sophi.decision || window.sophi.sophi_decision || null;
        r.age.source = window.sophi.decisionSource || window.sophi.sophi_decision_source || window.sophi.decision_source || null;
      }
      if (r.dl.sophiDecision) {
        r.age.dlDecision = r.dl.sophiDecision.decision;
        r.age.dlSource = r.dl.sophiDecision.source;
      }

      // Pageview accuracy (Check #13)
      r.pv = { meta: {} };
      const metas = [
        ['meta[property="og:title"]', 'title'],
        ['meta[property="article:section"]', 'section'],
        ['meta[property="og:type"]', 'type'],
        ['meta[name="content-type"]', 'contentType']
      ];
      for (const [sel, key] of metas) {
        const el = document.querySelector(sel);
        r.pv.meta[key] = el ? el.content : null;
      }
      if (typeof PMNdataLayer !== 'undefined' && Array.isArray(PMNdataLayer)) {
        for (const e of PMNdataLayer) {
          if (e.event === 'pageview' || e.event === 'page_view') {
            r.pv.dlPageview = e;
            break;
          }
        }
      }

      // Quickstart events (Check #12)
      r.quickstart = { events: 0 };
      if (typeof PMNdataLayer !== 'undefined' && Array.isArray(PMNdataLayer)) {
        for (const e of PMNdataLayer) {
          if (JSON.stringify(e).toLowerCase().indexOf('quickstart') > -1) r.quickstart.events++;
        }
      }

      return r;
    });

    output.results.push({ url: articleUrl, headline: articleText, netdom, windata });
  }

  await browser.close();
  process.stdout.write(JSON.stringify(output, null, 2));
})();
SCRIPT_EOF
```

---

## Phase 1: Run the Collector Script

Execute the script with the parsed arguments. The script outputs JSON to stdout and progress to stderr.

```bash
node /tmp/sophi-health-check.mjs "$BASE_URL" "$COUNT" 2>&1
```

**Timeout:** Set a generous timeout. Expect ~15 seconds per article (12s wait + 3s collection). For 20 articles, allow up to **6 minutes** (360000ms).

If the script fails with a Puppeteer/Chrome error:
- "Could not find Chrome" → run `npx puppeteer browsers install chrome` first
- Other launch errors → try adding `--disable-gpu` to the args array

The script outputs a JSON object to stdout with this structure:

```json
{
  "baseUrl": "https://www.inquirer.com",
  "count": 20,
  "articlesFound": 54,
  "selected": 20,
  "results": [
    {
      "url": "https://www.inquirer.com/...",
      "headline": "...",
      "netdom": { "sophiScripts": [...], "demeterNet": [...], "demeterDOM": [...], "consent": {...}, "decisionCalls": [...], "netCounts": {...} },
      "windata": { "dl": {...}, "trace": {...}, "piano": {...}, "visitor": {...}, "sophiMatch": {...}, "age": {...}, "pv": {...}, "quickstart": {...} }
    },
    ...
  ]
}
```

Parse this JSON output. If the output is too large to fit in a single bash capture, write it to a temp file:

```bash
node /tmp/sophi-health-check.mjs "$BASE_URL" "$COUNT" > /tmp/sophi-results.json 2>/tmp/sophi-progress.log
```

Then read the file with the Read tool.

---

## Phase 2: Score Each Article

For each article result, apply the pass/fail criteria to produce a score:

```
{
  url: "<article URL>",
  headline: "<from og:title or scraped text>",
  checks: {
    1:  { status: "PASS|FAIL", detail: "..." },
    2:  { status: "PASS|FAIL", detail: "..." },
    ...
    21: { status: "MANUAL", detail: "..." }
  }
}
```

### Pass/Fail Criteria

| # | Check | PASS when | FAIL when |
|---|-------|-----------|-----------|
| 1 | Sophi SDK loaded | `sophiScripts` array is non-empty | Empty array |
| 2 | Demeter consent param | At least one Demeter network entry has `hasConsent: true` | No Demeter requests or none with consent param |
| 3 | Demeter DOM attributes | At least one Demeter DOM element has non-null `id` and `async: true` | Missing id or async |
| 4 | Cookie consent | `OptanonActiveGroups` cookie is set OR `OTGPPConsent` cookie is set | Neither cookie present |
| 5 | decisions/me called | `decisionCalls` array is non-empty | Empty array |
| 6 | sophi_decision in dataLayer | `dl.sophiDecision` is non-null with a non-null `decision` value | Null |
| 7 | Pageview trace | `dl.pageviewTrace` has non-null `trace` | Null trace |
| 8 | Piano meter trace | `dl.pianoMeter` has non-null `trace` | Null trace. **N/A** if no piano meter event exists at all |
| 9 | Trace ID consistent | `trace.allMatch` is `true` | `false` |
| 10 | GTM events | `netCounts.gtm > 0` → PASS, otherwise MANUAL | Always at least MANUAL |
| 11 | GA4 extension | Always MANUAL | — |
| 12 | Quickstart events | `quickstart.events > 0` or `netCounts.quickstart > 0` | Both zero |
| 13 | Pageview accuracy | `pv.meta.section` is non-null and dataLayer pageview exists | Missing meta or no pageview event |
| 14 | V2 decision in Piano CV | `piano.sophiInCV` is `true` | `false` |
| 15 | tp.customVariables set | `piano.customVars` is non-null | Null |
| 16 | Hostname correct | `piano.hostname` equals `piano.tpHostname` (or tpHostname is null but hostname looks correct for the site) | Mismatch |
| 17 | Visitor type | `visitor.fromWindow` or `visitor.fromDL` is non-null | Both null |
| 18 | sophi vs dataLayer match | `sophiMatch.mismatches` is empty | Has mismatches |
| 19 | Decision followed (<15d) | Article is <15 days old and `age.dlSource` or `age.source` indicates Sophi. **N/A** if article is 15+ days | Source does not indicate Sophi |
| 20 | Override on 15+ day | Article is 15+ days old and `age.dlSource` or `age.source` indicates override. **N/A** if article is <15 days | 15+ day article with no override |
| 21 | Exclusion override | Always MANUAL | — |

Print a one-line progress summary after scoring each article:

```
[3/20] PASS 17/21, FAIL 1, MANUAL 3 — https://www.inquirer.com/...
```

---

## Phase 3: Generate Consolidated Report

Save a markdown report to the current working directory: `./<domain>-sophi-health-check-<date>.md`

Extract the domain from the BASE_URL (e.g., `www.inquirer.com` → `inquirer`).

### Report Template

````markdown
# Sophi 2.0 Health Check: <domain>
**Date:** <YYYY-MM-DD HH:MM timezone>
**Landing page:** <BASE_URL>
**Articles tested:** <count>
**Mode:** Headless Chrome (Puppeteer, not logged in)

---

## Overall Summary

**<X> articles tested. <Y> with all checks passing. <Z> with failures.**

| Metric | Value |
|--------|-------|
| Articles with 100% PASS | <count> (<percent>) |
| Most common failure | Check #<N>: <name> — failed on <count> articles |
| Checks that never failed | <list> |
| Checks that always failed | <list> |

---

## Summary Matrix

Each cell shows PASS / FAIL / N/A / MANUAL for that article × check combination.

| # | Article | C1 | C2 | C3 | C4 | C5 | C6 | C7 | C8 | C9 | C10 | C11 | C12 | C13 | C14 | C15 | C16 | C17 | C18 | C19 | C20 | C21 | Score |
|---|---------|----|----|----|----|----|----|----|----|----|----|-----|-----|-----|-----|-----|-----|-----|-----|-----|-----|-----|-------|
| 1 | <slug> | P/F | ... | ... | ... | ... | ... | ... | ... | ... | ... | ... | ... | ... | ... | ... | ... | ... | ... | ... | ... | ... | 17/21 |
| 2 | <slug> | ... | ... | ... | ... | ... | ... | ... | ... | ... | ... | ... | ... | ... | ... | ... | ... | ... | ... | ... | ... | ... | 18/21 |
| ... | | | | | | | | | | | | | | | | | | | | | | |

**Legend:** P = PASS, F = FAIL, N = N/A, M = MANUAL

### Check Key

| # | Check Name |
|---|-----------|
| 1 | Sophi SDK (main.js) loaded |
| 2 | Demeter script with consent param |
| 3 | Demeter script attributes (id, async) |
| 4 | Cookie consent respected |
| 5 | decisions/me called |
| 6 | sophi_decision fields in PMNdataLayer |
| 7 | Pageview event contains sophi_trace_id |
| 8 | piano_meter_event has sophi_trace_id |
| 9 | sophi_trace_id consistent across sources |
| 10 | GTM receives event data |
| 11 | GA4 extension displays data |
| 12 | Quickstart events fired |
| 13 | Pageview/paywall field accuracy |
| 14 | V2 decision in Piano customVariables |
| 15 | window.tp.customVariables set |
| 16 | Hostname correct |
| 17 | visitor.type correct |
| 18 | window.sophi matches dataLayer |
| 19 | Sophi decision followed (<15 days) |
| 20 | Override on 15+ day article |
| 21 | Override with exclusions |

---

## Per-Check Failure Analysis

For each check that had at least one FAIL, list the failing articles:

### Check #<N>: <name> — <fail count>/<total> failed

| # | Article URL | Detail |
|---|------------|--------|
| 1 | <url> | <failure detail> |
| 2 | <url> | <failure detail> |

---

## Per-Article Detail

For each article, include a collapsed detail section:

### Article <N>: <slug>

**URL:** <full URL>
**Headline:** <og:title>
**Published:** <date> (<N> days ago)
**Score:** <X>/21 PASS, <Y> FAIL, <Z> MANUAL

| # | Check | Status | Detail |
|---|-------|--------|--------|
| 1 | Sophi SDK loaded | PASS/FAIL | <detail> |
| 2 | Demeter consent param | PASS/FAIL | <detail> |
| ... | ... | ... | ... |

<If any checks failed, include the relevant raw data (Sophi scripts found, Demeter attributes, trace IDs, etc.) as a JSON code block for debugging.>

---

## Manual Checks Required

- [ ] **Check #10 (GTM):** Open Google Tag Assistant on a sample article and verify Sophi events flow through GTM
- [ ] **Check #11 (GA4):** Verify GA4 extension displays Sophi data on a sample article
- [ ] **Check #21 (Exclusions):** Test with articles matching exclusion criteria (specific content types, sections, or tags configured in Piano)
- [ ] **Send test link to vendor** after QA passes

---

## Key Findings

<Numbered list of the most important observations:>
1. <Overall pass rate and trend>
2. <Most common failure pattern across articles>
3. <SDK loading consistency>
4. <Decision flow integrity: Sophi → Piano → dataLayer>
5. <Trace ID consistency across the test set>
6. <Article age distribution and decision logic correctness>
7. <Any systemic failures vs one-off issues>
8. <Recommendations>
````

---

## Error Handling

- If Puppeteer cannot find Chrome, run: `npx puppeteer browsers install chrome`
- If the script times out on a specific article, it catches the error and records `error` in the result — it does NOT abort the whole run
- If the landing page yields zero article links, ask the user to provide a different URL or check the page structure
- If `PMNdataLayer` is not found on an article, the page may not be an article page or may not have Sophi enabled — mark checks #6-#9 as FAIL with note
- If `window.tp` is not found, Piano may not be loaded — mark checks #14-#16 as FAIL with note
- If the page is a checkout/subscribe page, Sophi is not expected (known exclusion) — note in results

## Notes

- GTM event verification (Check #10) and GA4 extension check (Check #11) require a headed browser with extensions. Flag as MANUAL.
- Exclusion override testing (Check #21) requires identifying articles matching exclusion criteria configured in Piano — always MANUAL.
- For log-based debugging, filter by `/(piano|sophi|quickstart)/` in the console.
- The total run time scales linearly: ~15 seconds per article (12s wait + 3s collection). 20 articles ≈ 5 minutes.
- Headless Chrome behavior is identical to headed Chrome for JavaScript execution, network requests, and cookie handling. The only difference is no visible rendering.
