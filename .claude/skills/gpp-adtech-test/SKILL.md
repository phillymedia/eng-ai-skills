---
name: gpp-adtech-test
description: Run a GPP ad tech integration test on a website to check if GPP privacy signals reach advertising partners
disable-model-invocation: true
allowed-tools: Bash, Read, Write, Glob
argument-hint: <url>
---

# GPP Ad Tech Integration Test

Run a comprehensive test of a website's GPP (Global Privacy Platform) implementation, checking whether privacy signals are correctly generated and passed to advertising partners in network requests.

**Argument:** The URL to test (e.g., `https://www.inquirer.com`)

## Critical Technical Constraints

1. **AppleScript isolated world**: `window.__gpp()` is NOT accessible via AppleScript `execute javascript`. You MUST use the postMessage protocol with `__gppCall` messages instead.
2. **Title trick for async data**: postMessage is async. Write results to `document.title`, then read the title back via AppleScript after a delay.
3. **CMP load time varies**: VPN connections can cause 60-120s CMP initialization. Poll with retries.
4. **Quote escaping**: Use AppleScript heredoc (`<< 'APPLESCRIPT'`) to avoid quote issues. For complex JS, read from external files and inject.

## Phase 1: Open Browser & Load Page

Open a fresh Chrome incognito window and navigate to the target URL.

```bash
osascript << 'APPLESCRIPT'
tell application "Google Chrome"
  activate
  set newWindow to make new window with properties {mode:"incognito"}
  set URL of active tab of newWindow to "$URL"
end tell
APPLESCRIPT
```

Replace `$URL` with the argument. Wait **15 seconds** for initial page load.

## Phase 2: Wait for CMP Initialization

Poll for CMP readiness using the postMessage "title trick." The GPP postMessage protocol works from any context (including Chrome's isolated world) because postMessage crosses world boundaries.

### Inject ping listener and send ping

```bash
osascript << 'APPLESCRIPT'
tell application "Google Chrome"
  tell active tab of front window
    execute javascript "
      window.addEventListener('message', function handler(e) {
        try {
          var d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
          if (d && d.__gppReturn && d.__gppReturn.returnValue) {
            document.title = 'GPPPING:' + JSON.stringify(d.__gppReturn.returnValue);
            window.removeEventListener('message', handler);
          }
        } catch(ex) {}
      });
      window.postMessage({
        __gppCall: { callId: 'ping1', command: 'ping', version: '1.1' }
      }, '*');
    "
  end tell
end tell
APPLESCRIPT
```

Wait **3 seconds**, then read the title:

```bash
osascript << 'APPLESCRIPT'
tell application "Google Chrome"
  tell active tab of front window
    return title
  end tell
end tell
APPLESCRIPT
```

### Retry logic

Check if the title starts with `GPPPING:`. If so, parse the JSON and check:
- `cmpStatus` should be `"loaded"`
- `signalStatus` should be `"ready"`

If not ready, retry with increasing delays:
1. Wait **15 seconds**, re-inject listener + ping, check again
2. Wait **30 seconds**, re-inject listener + ping, check again
3. Wait **60 seconds**, re-inject listener + ping, check again
4. After ~120s total, report timeout and continue with whatever data is available

**Important:** Each retry must re-inject both the listener AND the ping message, because the listener is one-shot (removes itself after first response).

## Phase 3: Collect GPP State

Once CMP is ready (or timeout), collect detailed GPP data.

### 3a. GPP Ping Data

Already collected in Phase 2. Parse the `GPPPING:` JSON from the title. Key fields:
- `gppVersion`, `cmpStatus`, `cmpDisplayStatus`, `signalStatus`
- `cmpId`, `sectionList`, `applicableSections`, `gppString`
- `supportedAPIs`, `parsedSections`

### 3b. GPP Section Data

For each section in `sectionList`, collect section data via postMessage:

```bash
# For each sectionId (e.g., 7 for usnat, 8 for usca, 9 for usva):
osascript << 'APPLESCRIPT'
tell application "Google Chrome"
  tell active tab of front window
    execute javascript "
      window.addEventListener('message', function handler(e) {
        try {
          var d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
          if (d && d.__gppReturn && d.__gppReturn.callId === 'section_SECTIONPREFIX') {
            document.title = 'GPPSECTION:' + JSON.stringify(d.__gppReturn.returnValue);
            window.removeEventListener('message', handler);
          }
        } catch(ex) {}
      });
      window.postMessage({
        __gppCall: { callId: 'section_SECTIONPREFIX', command: 'getSection', version: '1.1', parameter: 'SECTIONPREFIX' }
      }, '*');
    "
  end tell
end tell
APPLESCRIPT
```

Replace `SECTIONPREFIX` with the appropriate prefix from the GPP spec:
- Section 7 → `usnat`
- Section 8 → `usca`
- Section 9 → `usva`
- Section 10 → `usco`
- Section 11 → `usut`
- Section 12 → `usct`
- Section 2 → `tcfeuv2`
- Section 5 → `tcfcav1`
- Section 6 → `uspv1`

Wait **2 seconds** between each section request, then read the title.

### 3c. Cookies, Banner, and Network Data

Use the helper script bundled with this skill at `scripts/gpp-adtech-collect.js` (relative to this SKILL.md):

```bash
# Read the JS file and escape for AppleScript
SKILL_DIR="$(dirname "$(find ~/.claude/skills/gpp-adtech-test -name SKILL.md)")"
JS_CODE=$(cat "$SKILL_DIR/scripts/gpp-adtech-collect.js" | sed 's/\\/\\\\/g' | sed 's/"/\\"/g')

osascript -e "
tell application \"Google Chrome\"
  tell active tab of front window
    execute javascript \"$JS_CODE\"
  end tell
end tell
"
```

Wait **2 seconds**, then read the title:

```bash
TITLE=$(osascript << 'APPLESCRIPT'
tell application "Google Chrome"
  tell active tab of front window
    return title
  end tell
end tell
APPLESCRIPT
)
echo "$TITLE"
```

The title will start with `GPPDATA:` followed by JSON containing cookies, banner state, vendor network requests, and OneTrust scripts.

### 3d. Initiator Correlation

Inject a script that correlates each ad request with the script that most likely initiated it, using Resource Timing API timing analysis. This identifies the script chain that triggered each network call.

```bash
osascript << 'APPLESCRIPT'
tell application "Google Chrome"
  tell active tab of front window
    execute javascript "
      var entries = performance.getEntriesByType('resource');
      var scripts = [];
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].initiatorType === 'script' || entries[i].name.match(/\\.js(\\?|$)/)) {
          scripts.push({
            name: entries[i].name.split('/').pop().split('?')[0],
            domain: entries[i].name.split('/')[2],
            responseEnd: entries[i].responseEnd
          });
        }
      }
      scripts.sort(function(a,b) { return a.responseEnd - b.responseEnd; });

      var adPatterns = [
        {name:'googleSST', pattern:'server-side-tagging'},
        {name:'gampad', pattern:'gampad/ads'},
        {name:'comScore', pattern:'scorecardresearch.com'},
        {name:'rubiconFastlane', pattern:'fastlane.rubiconproject.com'},
        {name:'casalemedia', pattern:'casalemedia.com'},
        {name:'lijit', pattern:'ap.lijit.com'},
        {name:'medianet', pattern:'prebid.media.net'},
        {name:'smilewanted', pattern:'prebid.smilewanted.com'},
        {name:'amo', pattern:'prebid.a-mo.net'},
        {name:'cootlogix', pattern:'prebid.cootlogix.com'},
        {name:'undertone', pattern:'hb.undertone.com'},
        {name:'amazon', pattern:'amazon-adsystem.com'},
        {name:'ccm', pattern:'ccm/collect'},
        {name:'ga4collect', pattern:'google-analytics.com/g/collect'},
        {name:'prebidGeo', pattern:'geo-location.prebid.cloud'},
        {name:'doubleclick', pattern:'cm.g.doubleclick.net/partnerpixels'},
        {name:'hadron', pattern:'id.hadron.ad.gt'},
        {name:'33across', pattern:'lexicon.33across.com'},
        {name:'bidswitch', pattern:'bidswitch.net'},
        {name:'simplifi', pattern:'um.simpli.fi'},
        {name:'id5', pattern:'id5-sync.com'},
        {name:'sharethrough', pattern:'sharethrough.com'},
        {name:'adsrvr', pattern:'adsrvr.org'},
        {name:'seedtag', pattern:'seedtag.com'}
      ];

      var result = [];
      for (var j = 0; j < entries.length; j++) {
        var url = entries[j].name;
        var matched = null;
        for (var k = 0; k < adPatterns.length; k++) {
          if (url.indexOf(adPatterns[k].pattern) > -1) {
            matched = adPatterns[k].name;
            break;
          }
        }
        if (!matched) continue;

        var bestScript = null;
        for (var s = scripts.length - 1; s >= 0; s--) {
          if (scripts[s].responseEnd <= entries[j].startTime) {
            bestScript = scripts[s];
            break;
          }
        }

        var hasGpp = url.indexOf('gpp=') > -1 || url.indexOf('gpp_sid') > -1 || url.indexOf('sst.gpp') > -1;

        result.push({
          vendor: matched,
          initiator: bestScript ? bestScript.name + ' (' + bestScript.domain + ')' : 'unknown',
          deltaMs: bestScript ? Math.round(entries[j].startTime - bestScript.responseEnd) : -1,
          hasGppInUrl: hasGpp,
          initiatorType: entries[j].initiatorType,
          url: url.substring(0, 200)
        });
      }
      document.title = 'INITIATORS:' + JSON.stringify(result);
    "
  end tell
end tell
APPLESCRIPT
```

Wait **2 seconds**, then read the title. This provides `vendor`, `initiator`, `deltaMs`, `hasGppInUrl`, and `initiatorType` for every ad-related request.

### 3e. Prebid Call Classification

Collect full URLs for all prebid-related requests, flagging whether GPP is present in URL query params:

```bash
osascript << 'APPLESCRIPT'
tell application "Google Chrome"
  tell active tab of front window
    execute javascript "
      var entries = performance.getEntriesByType('resource');
      var prebidCalls = [];
      var patterns = ['casalemedia.com', 'rubiconproject.com', 'lijit.com', 'media.net/rtb',
        'smilewanted.com', 'prebid.a-mo.net', 'prebid.cootlogix.com', 'undertone.com/hb',
        'openx.net', 'pubmatic.com', 'indexww.com', 'hadron.ad.gt', '33across.com',
        'id5-sync.com', 'bidswitch.net', 'simpli.fi', 'sharethrough.com', 'adsrvr.org',
        'geo-location.prebid', 'seedtag.com/se/hb'];
      for (var i = 0; i < entries.length; i++) {
        var u = entries[i].name;
        for (var p = 0; p < patterns.length; p++) {
          if (u.indexOf(patterns[p]) > -1) {
            prebidCalls.push({
              url: u,
              type: entries[i].initiatorType,
              hasGpp: u.indexOf('gpp=') > -1 || u.indexOf('gpp_sid') > -1,
              domain: u.split('/')[2]
            });
            break;
          }
        }
      }
      document.title = 'PREBID:' + JSON.stringify(prebidCalls);
    "
  end tell
end tell
APPLESCRIPT
```

Wait **2 seconds**, then read the title. This gives full URLs for every prebid call with a `hasGpp` boolean.

### 3f. Sync Pixel Collection (GET/img requests)

Collect ad-related sync pixel (img/iframe) requests separately from POST-based bid requests:

```bash
osascript << 'APPLESCRIPT'
tell application "Google Chrome"
  tell active tab of front window
    execute javascript "
      var entries = performance.getEntriesByType('resource');
      var syncPixels = [];
      var adDomains = ['rubiconproject.com', 'casalemedia.com', 'openx.net', 'bidswitch.net',
        'simpli.fi', 'sharethrough.com', 'adsrvr.org', 'a-mo.net', 'dotomi.com', 'lijit.com',
        'cootlogix.com', 'adnxs.com', 'media.net', 'pubmatic.com'];
      for (var i = 0; i < entries.length; i++) {
        var t = entries[i].initiatorType;
        if (t === 'img' || t === 'iframe') {
          var u = entries[i].name;
          for (var d = 0; d < adDomains.length; d++) {
            if (u.indexOf(adDomains[d]) > -1) {
              syncPixels.push({
                url: u,
                type: t,
                hasGpp: u.indexOf('gpp=') > -1 || u.indexOf('gpp_sid') > -1,
                domain: u.split('/')[2]
              });
              break;
            }
          }
        }
      }
      document.title = 'SYNCPIX:' + JSON.stringify(syncPixels);
    "
  end tell
end tell
APPLESCRIPT
```

Wait **2 seconds**, then read the title. Sync pixels are GET-based and GPP params are always visible in the URL if present.

**Note:** Sync pixels are geo-dependent. California visitors see 12+ sync pixels from Rubicon, Casalemedia, BidSwitch, Simpli.fi, Sovrn, TTD, etc. Non-California visitors may see zero sync pixels.

## Phase 4: Analyze Network Requests

Parse all collected JSON data. Analyze each vendor category:

### Vendor Categories to Check

| Vendor | URL Pattern | GPP Params to Look For |
|--------|------------|----------------------|
| **Google SST** | `server-side-tagging*.run.app` | `sst.gpp`, `sst.gpp_sid`, `gcs`, `npa`, `dma` |
| **Google Syndication** | `googlesyndication.com` | `us_privacy`, `gpp`, `gpp_sid`, `gcs`, `npa` |
| **Google Ad Manager** | `gampad/ads` | `gpp`, `gpp_sid`, `us_privacy`, `gdpr`, `npa` |
| **comScore** | `scorecardresearch.com/b` | `gpp_sid`, `gpp_smv`, `gpp_gpc`, `gpp_oos`, `gpp_oon`, `gpp_sdp`, `gpp_pdc`, `gpp_cdc`, `gpp_mct`, `gpp_mom`, `gpp_msm` |
| **Prebid/SSPs** | See Prebid section below | `gpp`, `gpp_sid` in URL or POST body |
| **Amazon** | `amazon-adsystem.com` | Count requests |
| **OneTrust** | `cookielaw.org` | List loaded scripts |

### Prebid Call Analysis (Critical)

Prebid partners use two request patterns — report MUST distinguish between them:

1. **GET-based** (params in URL query string): GPP presence is directly verifiable
   - Rubicon fastlane (`fastlane.rubiconproject.com/a/api/fastlane.json`) — typically includes `gpp=` and `gpp_sid=`
   - Undertone (`hb.undertone.com/hb`) — typically includes `gpp=` and `gpp_sid=`
   - Hadron (`id.hadron.ad.gt`) — typically includes `gpp=` and `gpp_sid=`

2. **POST-based OpenRTB** (params may be in JSON request body): GPP in URL is NOT verifiable via Resource Timing API
   - Casalemedia/Index Exchange (`htlb.casalemedia.com/openrtb/pbjs`)
   - Sovrn/Lijit (`ap.lijit.com/rtb/bid`)
   - Media.net (`prebid.media.net/rtb/prebid`)
   - SmileWanted (`prebid.smilewanted.com`)
   - AMX (`prebid.a-mo.net/a/c`)
   - Cootlogix (`prebid.cootlogix.com/prebid/multi`)
   - BidSwitch (`grid.bidswitch.net/hbjson`)

For POST-based calls, GPP _may_ be present in the request body (`regs.gpp` and `regs.gpp_sid` per OpenRTB 2.6+), but this cannot be confirmed through browser automation. Note this limitation clearly in the report.

### What to Report for Each Vendor

- **Initiator script**: From Phase 3d data. Report format: `scriptname.js (domain) — delta Xms`
- Whether GPP parameters are present in the URL
- For POST-based calls, note that GPP may be in the request body (unverifiable)
- The specific GPP values sent (GPP string, SID, opt-out status)
- Whether legacy `us_privacy` or `gdpr` params are used instead
- Whether Google's own consent mechanism (`gcs`, `npa`) is used

### Known Initiator Chains

From testing inquirer.com (these may vary by site):
- `pubads_impl.js` (securepubads.g.doubleclick.net) → ALL Prebid SSP bid requests, gampad calls, DoubleClick partner pixels
- `gtag/js` (www.googletagmanager.com) → SST, GA4 collect calls
- `up.js` (cdn01.basis.net) → CCM collect (via timing)
- `cx.js` (cdn.cxense.com) → gampad top_banner call
- `beacon.js` (sb.scorecardresearch.com) → comScore pixel (CA only)
- `otSDKStub.js` → OneTrust config, banner, GPP module chain
- `htlbid.js` (htlbid.com) → Amazon apstag.js load

## Phase 5: Generate Report

Save a markdown report to the current working directory: `./<domain>-gpp-adtech-test-<date>.md`

Extract the domain from the URL (e.g., `www.inquirer.com` → `inquirer`).

### Report Template

```markdown
# GPP Ad Tech Integration Test: <domain>
**Date:** <YYYY-MM-DD HH:MM timezone>
**URL:** <tested URL>
**Mode:** Chrome Incognito
**CMP:** <CMP name> (ID <cmpId>), GPP SID <applicableSections>
**Geolocation:** <arc-geo cookie value or OneTrust geo>

---

## Summary

| Check | Result |
|-------|--------|
| GPP CMP status | <cmpStatus>, signalStatus=<signalStatus>, cmpDisplayStatus=<value> |
| GPP section(s) | <section names and IDs, note applicable vs in-string> |
| GPP string | `<gppString>` |
| Consent banner | <visible/hidden/disabled/not present> |
| Total requests | <count> |
| Prebid bid calls | <count> |
| Prebid calls WITH GPP in URL | <count> (<vendor names>) |
| Prebid calls WITHOUT GPP in URL | <count> |
| Google consent mechanism | <gcs/npa values — note if consistent or divergent across properties> |

---

## 1. GPP State

<ping data as JSON code block>

### <Section Name> Section Data (Section N — Applicable/Not Applicable)

<section data as JSON code block, for each section in sectionList>

---

## 2. Consent Banner

<banner visibility, button text, consent groups from cookie>
<Note if banner is "disabled" (not rendered) vs "hidden" (rendered but dismissed)>

---

## 3. Prebid Ad Calls — GPP in URL Query Parameters

<This is the KEY section. Present a clear split between calls with and without GPP in URLs.>

### Calls WITH GPP in URL (<count> of <total>)

<For each call with GPP in URL params:>
<- Vendor name>
<- Initiator script and delta>
<- Full URL in code block>
<- Extracted GPP params>

### Calls WITHOUT GPP in URL (<count> of <total>)

<Table format:>
| # | Vendor | URL | Initiator | Delta |
|---|--------|-----|-----------|-------|

<Explain: These are POST-based OpenRTB calls. GPP may be in the request body
(`regs.gpp`, `regs.gpp_sid` per OpenRTB 2.6+) but cannot be verified via
Resource Timing API. DevTools Network tab inspection required to confirm.>

---

## 4. Initiator Chain Map

<ASCII tree showing which scripts initiated which requests, with GPP status:>

```
pubads_impl.js (securepubads.g.doubleclick.net)
  ├── gampad/ads                    [fetch, HAS GPP]
  ├── rubiconproject.com/fastlane   [fetch, HAS GPP]
  ├── undertone.com/hb              [fetch, HAS GPP]
  ├── casalemedia.com/openrtb       [fetch, NO GPP in URL]
  ├── lijit.com/rtb/bid             [fetch, NO GPP in URL]
  └── ...

gtag/js (www.googletagmanager.com)
  ├── server-side-tagging (SST)     [fetch, HAS GPP]
  └── google-analytics.com/collect  [fetch, gcs=G100]
```

---

## 5. Other Network Requests

### Vendors WITH GPP in URL

<For each non-prebid vendor with GPP params, show params table>

### Vendors WITHOUT GPP in URL

<Table of ad-related domains with no GPP params>

---

## 6. Cookies

| Cookie | Value |
|--------|-------|
| OTGPPConsent | <value or not set> |
| OptanonConsent | <groups excerpt> |
| arc-geo | <value or not set> |

<Note any cookie/API GPP string discrepancy>

---

## 7. Key Findings

<Numbered list. MUST include:>
1. <How many prebid calls have GPP in URL vs not — the headline finding>
2. <POST vs GET explanation for the gap>
3. <Which specific vendors include GPP in URL, which don't>
4. <All prebid calls share same initiator (pubads_impl.js) — confirm the pattern>
5. <Google consent mechanism status (gcs/npa) — consistent or divergent?>
6. <comScore presence/absence>
7. <Sync pixel activity (geo-dependent — California sees many, others see few/none)>
8. <Cookie/API GPP string match or mismatch>
9. <Any other notable observations>

---

## Appendix: Full Ad Call URLs

<For each vendor category, list every captured URL in a fenced code block.
Include the complete URL with all query parameters preserved.
For each URL, include the initiator type AND the initiator script.>

### <Vendor Name>
\```
[initiator: <type>] [initiated by: <script.js>]
<full URL>
\```
```

## Error Handling

- If Chrome is not running, start it before opening incognito
- If AppleScript fails with "not allowed", remind user to enable: `defaults write com.google.Chrome AppleScriptEnabled -bool true` then restart Chrome
- If CMP never reaches `loaded` state, still collect whatever data is available and note the timeout in the report
- If no GPP ping response at all, the site likely doesn't implement GPP — note this prominently in the report

## Geo-Dependent Behavior (Observed)

Test results vary significantly by visitor geolocation:

| Behavior | California (USCA) | Non-CA US (USNAT) |
|----------|------------------|-------------------|
| Applicable section | 8 (USCA) | 7 (USNAT) |
| GPP string sections | 1 (USCA only) | 2 (USNAT + USCA) |
| Consent banner | Exists, hidden after dismissal | Disabled (not rendered) |
| cmpDisplayStatus | `hidden` | `disabled` |
| Google SST `gcs` | `G111` (full consent) | `G100` (restricted) |
| Google SST `npa` | `0` (personalized OK) | `1` (non-personalized) |
| comScore | Present with full GPP decomposition | Absent (0 requests) |
| Sync pixels | 12+ with privacy params | 0 |
| Vendors with GPP in URL | 13+ | ~6 |
| Background consent group | SSPD_BG | OSSTA_BG |

## Notes

- The helper script at `scripts/gpp-adtech-collect.js` (bundled with this skill) handles all DOM-accessible data collection in a single injection
- GPP state (ping, sections) MUST be collected separately via postMessage since `window.__gpp` is not accessible from the isolated world
- Run each AppleScript step sequentially with appropriate waits between them
- Save all raw JSON data in case manual analysis is needed later
- The key user concern is **prebid calls without GPP in URL params** — always highlight this prominently in the report summary and findings
