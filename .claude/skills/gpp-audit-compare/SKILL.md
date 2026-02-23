---
name: gpp-audit-compare
description: Compare GPP string implementations across multiple news sites — CMP provider, opt-out posture, MSPA fields, cookie architecture, and section data
disable-model-invocation: true
allowed-tools: Bash, Read, Write, Glob
argument-hint: [url1 url2 url3 ...]
---

# GPP String Audit — Cross-Site Comparison

Compare GPP (Global Privacy Platform) string implementations across multiple websites in parallel.

**Argument:** Optional space-separated list of URLs. Defaults to:
- `https://www.inquirer.com/`
- `https://www.nytimes.com/`
- `https://www.washingtonpost.com/`

## Critical Technical Constraints

1. **AppleScript isolated world**: `window.__gpp()` is NOT accessible via AppleScript `execute javascript`. Use postMessage protocol (`__gppCall`) exclusively.
2. **Title trick**: Write JSON results to `document.title`, then read it back via AppleScript after a delay.
3. **Window targeting by URL**: After opening all windows, target each by URL using `repeat with w in windows / if URL of active tab of w contains "domain.com"`.
4. **Parallel loading**: Open all windows first, wait once, then query sequentially. Saves total wall-clock time.
5. **CMP-agnostic**: Sites use different CMPs (OneTrust, Ethyca Fides, Sourcepoint, etc.). Collect cookie names first to identify which ones store GPP state.

## Phase 1: Parse Arguments & Set URL List

If arguments are provided, use them. Otherwise default to:
```
URLS=(
  "https://www.inquirer.com/"
  "https://www.nytimes.com/"
  "https://www.washingtonpost.com/"
)
```

Extract a short domain label from each URL for labeling (e.g. `inquirer`, `nytimes`, `washingtonpost`).

## Phase 2: Open All Windows in Parallel

Open each URL in a separate Chrome incognito window in rapid succession:

```bash
osascript << 'APPLESCRIPT'
tell application "Google Chrome"
  activate
  set w1 to make new window with properties {mode:"incognito"}
  set URL of active tab of w1 to "URL_1"
  set w2 to make new window with properties {mode:"incognito"}
  set URL of active tab of w2 to "URL_2"
  set w3 to make new window with properties {mode:"incognito"}
  set URL of active tab of w3 to "URL_3"
end tell
APPLESCRIPT
```

Wait **20 seconds** for all pages to load in parallel.

## Phase 3: Collect GPP Data From Each Site

For each site, run these steps sequentially. Target each window by URL pattern.

### Step A: GPP Ping via postMessage

```bash
osascript << 'APPLESCRIPT'
tell application "Google Chrome"
  repeat with w in windows
    if URL of active tab of w contains "DOMAIN_PATTERN" then
      tell active tab of w
        execute javascript "
          window.addEventListener('message', function handler(e) {
            try {
              var d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
              if (d && d.__gppReturn && d.__gppReturn.returnValue && d.__gppReturn.returnValue.gppVersion) {
                document.title = 'GPPPING:' + JSON.stringify(d.__gppReturn.returnValue);
                window.removeEventListener('message', handler);
              }
            } catch(ex) {}
          });
          window.postMessage({ __gppCall: { callId: 'ping1', command: 'ping', version: '1.1' } }, '*');
        "
      end tell
      exit repeat
    end if
  end repeat
end tell
APPLESCRIPT
```

Wait **3 seconds**, then read the title. Check if it starts with `GPPPING:`.

**If no GPP ping response after 3s:** Re-inject and wait 15s more (CMP may still be loading). If still no response after 60s total, note "GPP not implemented" and continue.

Parse the ping JSON for: `gppVersion`, `cmpStatus`, `cmpDisplayStatus`, `signalStatus`, `cmpId`, `sectionList`, `applicableSections`, `gppString`, `supportedAPIs`, `parsedSections`.

### Step B: Section Data for Each Applicable Section

For each section ID in `sectionList`, query section data. Map section IDs to prefixes:
- 7 → `usnat`, 8 → `usca`, 9 → `usva`, 10 → `usco`, 11 → `usut`, 12 → `usct`,
- 13 → `usfl`, 14 → `usmt`, 15 → `usor`, 16 → `ustx`, 17 → `usde`, 18 → `usia`,
- 19 → `usne`, 20 → `usnh`, 21 → `usnj`, 22 → `ustn`, 2 → `tcfeuv2`, 6 → `uspv1`

```bash
osascript << 'APPLESCRIPT'
tell application "Google Chrome"
  repeat with w in windows
    if URL of active tab of w contains "DOMAIN_PATTERN" then
      tell active tab of w
        execute javascript "
          window.addEventListener('message', function handler(e) {
            try {
              var d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
              if (d && d.__gppReturn && d.__gppReturn.callId === 'sec_SECTION_PREFIX') {
                document.title = 'GPPSEC:' + JSON.stringify(d.__gppReturn.returnValue);
                window.removeEventListener('message', handler);
              }
            } catch(ex) {}
          });
          window.postMessage({
            __gppCall: { callId: 'sec_SECTION_PREFIX', command: 'getSection', version: '1.1', parameter: 'SECTION_PREFIX' }
          }, '*');
        "
      end tell
      exit repeat
    end if
  end repeat
end tell
APPLESCRIPT
```

Wait **2 seconds** between each section request, then read title.

### Step C: Cookie Names & CMP Detection

First pass — get all cookie names to identify CMP type:

```bash
osascript << 'APPLESCRIPT'
tell application "Google Chrome"
  repeat with w in windows
    if URL of active tab of w contains "DOMAIN_PATTERN" then
      tell active tab of w
        execute javascript "
          var result = {};
          result.allCookieNames = document.cookie.split(';').map(function(c){ return c.trim().split('=')[0]; });
          result.totalRequests = performance.getEntriesByType('resource').length;
          result.hasGppGlobal = typeof window.__gpp === 'function';
          result.hasFides = typeof window.Fides !== 'undefined';
          result.hasSourcepoint = typeof window._sp_ !== 'undefined';
          document.title = 'CMPCHECK:' + JSON.stringify(result);
        "
      end tell
      exit repeat
    end if
  end repeat
end tell
APPLESCRIPT
```

### Step D: Targeted Cookie Values

Based on the CMP type identified in Step C, read specific cookies.

**OneTrust sites:** Read `OTGPPConsent`, `OptanonConsent`, `OptanonAlertBoxClosed`, `arc-geo`

**Ethyca Fides sites:** Read `gpp-string`, `fides_consent`, `nyt-geo`, `nyt-purr`, `nyt-gdpr`

**Custom/Akamai sites:** Read all `*gpp*`, `*usp*`, `*geo*` cookies

**Always check for:**
- `wp_ak_gpp`, `wp_usp`, `wp_geo` (WaPo Akamai pattern)
- `eupubconsent-v2` (GDPR TCF string)
- Any cookie containing "gpp", "consent", "privacy", "gdpr" (case-insensitive name match)

```bash
osascript << 'APPLESCRIPT'
tell application "Google Chrome"
  repeat with w in windows
    if URL of active tab of w contains "DOMAIN_PATTERN" then
      tell active tab of w
        execute javascript "
          var result = {};
          var cookies = document.cookie.split(';');
          for (var i = 0; i < cookies.length; i++) {
            var c = cookies[i].trim();
            var eq = c.indexOf('=');
            if (eq > -1) {
              var name = c.substring(0, eq).toLowerCase();
              if (name.indexOf('gpp') > -1 || name.indexOf('consent') > -1 ||
                  name.indexOf('privacy') > -1 || name.indexOf('usp') > -1 ||
                  name.indexOf('purr') > -1 || name.indexOf('geo') > -1 ||
                  name.indexOf('gdpr') > -1 || name.indexOf('fides') > -1) {
                try { result[c.substring(0,eq)] = decodeURIComponent(c.substring(eq+1)); }
                catch(e) { result[c.substring(0,eq)] = c.substring(eq+1); }
              }
            }
          }
          document.title = 'COOKIES:' + JSON.stringify(result);
        "
      end tell
      exit repeat
    end if
  end repeat
end tell
APPLESCRIPT
```

### Step E: Banner State & Ad Privacy Params

Check consent banner and capture any ad requests containing GPP params to confirm signal propagation:

```bash
osascript << 'APPLESCRIPT'
tell application "Google Chrome"
  repeat with w in windows
    if URL of active tab of w contains "DOMAIN_PATTERN" then
      tell active tab of w
        execute javascript "
          var result = {};
          // Banner detection (OneTrust and generic)
          var otBanner = document.getElementById('onetrust-banner-sdk');
          var fidesBanner = document.querySelector('#fides-banner, .fides-banner, #fides-overlay');
          var spBanner = document.querySelector('[id^=sp_message_container]');
          result.bannerExists = !!(otBanner || fidesBanner || spBanner);
          result.bannerType = otBanner ? 'onetrust' : fidesBanner ? 'fides' : spBanner ? 'sourcepoint' : 'none';
          // Ad requests with GPP params (sample — first 3)
          var entries = performance.getEntriesByType('resource');
          var gppAdRequests = [];
          for (var i = 0; i < entries.length && gppAdRequests.length < 3; i++) {
            var u = entries[i].name;
            if ((u.indexOf('gpp=') > -1 || u.indexOf('gpp_sid') > -1 || u.indexOf('sst.gpp') > -1) &&
                (u.indexOf('gampad') > -1 || u.indexOf('doubleclick') > -1 ||
                 u.indexOf('rubiconproject') > -1 || u.indexOf('undertone') > -1 ||
                 u.indexOf('server-side-tagging') > -1)) {
              var url = new URL(u);
              gppAdRequests.push({
                domain: url.hostname,
                gpp: url.searchParams.get('gpp') || url.searchParams.get('sst.gpp'),
                gpp_sid: url.searchParams.get('gpp_sid') || url.searchParams.get('sst.gpp_sid'),
                us_privacy: url.searchParams.get('us_privacy') || url.searchParams.get('ccpa')
              });
            }
          }
          result.gppAdRequests = gppAdRequests;
          result.totalRequests = entries.length;
          document.title = 'BANNER:' + JSON.stringify(result);
        "
      end tell
      exit repeat
    end if
  end repeat
end tell
APPLESCRIPT
```

## Phase 4: Identify CMP Provider from cmpId

Map `cmpId` from ping data to provider name:
- 28 → OneTrust
- 407 → Ethyca Fides
- 76 → Sourcepoint
- 10 → Quantcast Choice
- 131 → Didomi
- Any other → use `cmpId` number, note as "Unknown CMP"

## Phase 5: Decode USNAT Field Values

For USNAT (section 7) parsed data, translate numeric values:
- **0** = Not Applicable
- **1** = Yes / Opted Out (for opt-out fields) / Notice Provided (for notice fields)
- **2** = No / Did Not Opt Out (for opt-out fields)

Key fields to highlight in comparison:
- `SaleOptOut`, `SharingOptOut`, `TargetedAdvertisingOptOut` — core opt-out trio
- `MspaOptOutOptionMode` — whether site offers opt-out UI (2=Yes, 1=N/A)
- `MspaServiceProviderMode` — whether acting as service provider (2=Yes)
- `PersonalDataConsents`
- `Gpc` — GPC signal status

**Default opt-out posture:** A site with SaleOptOut=1, SharingOptOut=1, TargetedAdvertisingOptOut=1 is opting all non-CA users out by default. A site with all=2 is NOT opting them out (treating them as consenting).

## Phase 6: Generate Comparison Report

Save markdown to: `/Users/tdang/www/gpp/gpp-audit-compare-<YYYY-MM-DD>.md`

### Report Template

```markdown
# GPP String Audit — Cross-Site Comparison
**Date:** <YYYY-MM-DD HH:MM timezone>
**Sites:** <site1> · <site2> · <site3>
**Method:** Chrome Incognito, postMessage GPP ping + section query
**Geolocation:** <geo from cookie or user-agent>

---

## TL;DR

| | <site1> | <site2> | <site3> |
|---|---|---|---|
| **CMP** | | | |
| **GPP String** | | | |
| **Opted out by default?** | ✅/❌ | ✅/❌ | ✅/❌ |
| **SaleOptOut** | | | |
| **SharingOptOut** | | | |
| **TargetedAdvertisingOptOut** | | | |
| **us_privacy string** | | | |
| **MSPA OOM** | | | |
| **Supported APIs** | | | |
| **Banner (non-CA)** | | | |
| **GPP cookie name** | | | |

**Headline finding:** <1-2 sentence summary of the most important difference>

---

## 1. GPP Ping Data (Full)

### <site1>
<json code block>

### <site2>
<json code block>

### <site3>
<json code block>

---

## 2. USNAT Section Data Field-by-Field Comparison

### Notice Fields
<table with all notice fields across sites>

### Opt-Out / Consent Fields ← Key Differences
<table — highlight cells where sites differ>

### MSPA Fields ← Key Differences
<table>

### GPC Segment
<table>

---

## 3. GPP String Structural Analysis

Show the USNAT payload portion of each string and explain what the encoding differences represent, referencing the parsed section data.

---

## 4. CMP Implementation Comparison

For each site:
- Provider name and CMP ID
- SDK version (from OptanonConsent version= param, fides_meta.version, or similar)
- Scripts loaded (if identifiable)
- GPP cookie name and format
- Banner behavior and what cmpDisplayStatus means
- Supported APIs count
- Default opt-out posture
- Any architectural notes (Akamai integration, custom cookie family, etc.)

---

## 5. Banner / Consent UX Comparison
<table comparing banner behavior, cmpDisplayStatus, consent capture method, whether opt-out UI is shown>

---

## 6. Consent Cookie Architecture
<table comparing cookie names, formats, whether full GPP string is stored, legacy US Privacy string, geo cookies>

---

## 7. Ad Signal Verification (Sample)
<For each site, show 1-3 ad requests that include GPP params, confirming the string is being passed correctly to ad partners>

---

## 8. Key Findings
<Numbered list of the most important observations — comparisons, compliance implications, architectural differences>

---

## Appendix: Raw Section Data
<JSON code blocks for each site's USNAT section data>

## Appendix: Consent Cookies
<Table of all relevant cookies per site>
```

## Notes

- **CMP ID detection:** The `cmpId` in the GPP ping is the most reliable way to identify the CMP provider — it doesn't require inspecting script URLs or DOM elements.
- **`cmpDisplayStatus` interpretation:**
  - `disabled` = banner never renders for this jurisdiction (no consent UI shown)
  - `hidden` = banner was rendered but dismissed (prior consent recorded or server-side state)
  - `visible` = banner is currently showing
- **WaPo Akamai pattern:** If you see `wp_ak_gpp` cookie, it stores a binary flag + date, not the GPP string. The GPP string is only in runtime memory and ad request URLs.
- **Ethyca Fides pattern:** `fides_consent` JSON cookie and `gpp-string` cookie with `",,{gppString}"` prefix (the `,,` is Fides' serialization for empty TCF and USP legacy fields).
- **GPP string not in cookie ≠ GPP not implemented.** Always verify via postMessage ping, not cookie inspection alone.
- **comScore behavior is a reliable proxy:** If comScore fires with GPP decomposition params (`gpp_oos=`, `gpp_oon=`, etc.), it confirms the CMP is passing signals to vendors. Absence of comScore for non-CA visitors typically indicates an opted-out posture.
- **MSPA OOM=2 is notable:** It declares the site offers an opt-out interface, which is a compliance statement beyond just setting the string values.
