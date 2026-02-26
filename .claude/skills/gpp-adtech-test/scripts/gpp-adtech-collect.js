/**
 * GPP Ad Tech Data Collection Script
 * Runs in the browser (via AppleScript execute javascript) to collect
 * cookies, banner state, network requests, and OneTrust scripts.
 *
 * Returns JSON string written to document.title for AppleScript retrieval.
 * NOTE: This runs in Chrome's isolated world, so window.__gpp is NOT accessible.
 * GPP state must be collected separately via postMessage protocol.
 */
(function() {
  var result = {};
  result.url = window.location.href;
  result.timestamp = new Date().toISOString();
  result.userAgent = navigator.userAgent;

  // --- Cookies ---
  var cookies = document.cookie.split(';');
  result.cookies = {};
  var targetCookies = ['OTGPPConsent', 'gppSid', 'OptanonConsent', 'OptanonAlertBoxClosed', 'arc-geo', 'eupubconsent-v2'];
  for (var i = 0; i < cookies.length; i++) {
    var c = cookies[i].trim();
    var eq = c.indexOf('=');
    if (eq > -1) {
      var name = c.substring(0, eq);
      for (var t = 0; t < targetCookies.length; t++) {
        if (name === targetCookies[t]) {
          result.cookies[name] = decodeURIComponent(c.substring(eq + 1));
        }
      }
    }
  }

  // --- Banner State ---
  var banner = document.getElementById('onetrust-banner-sdk');
  result.banner = {};
  if (banner) {
    var style = window.getComputedStyle(banner);
    result.banner.exists = true;
    result.banner.visible = style.display !== 'none' && style.visibility !== 'hidden';
    var acceptBtn = document.getElementById('onetrust-accept-btn-handler');
    var rejectBtn = document.getElementById('onetrust-reject-all-handler');
    result.banner.acceptButton = acceptBtn ? acceptBtn.textContent.trim() : null;
    result.banner.rejectButton = rejectBtn ? rejectBtn.textContent.trim() : null;
  } else {
    result.banner.exists = false;
    result.banner.visible = false;
  }

  // --- Network Requests ---
  var entries = performance.getEntriesByType('resource');
  result.totalRequests = entries.length;

  // Categorized request analysis
  result.vendors = {};

  // Google SST
  var sstReqs = [];
  // Google Syndication
  var syndReqs = [];
  // Google Ad Manager (gampad)
  var gampadReqs = [];
  // comScore / Scorecard
  var comscoreReqs = [];
  // Prebid partners
  var prebidReqs = [];
  // Amazon
  var amazonReqs = [];
  // OneTrust / cookielaw scripts
  var otScripts = [];
  // All requests with GPP/privacy params
  var gppRequests = [];
  // Google analytics / tag manager
  var googleTagReqs = [];

  for (var j = 0; j < entries.length; j++) {
    var url = entries[j].name;

    // Google SST
    if (url.indexOf('server-side-tagging') > -1 && url.indexOf('.run.app') > -1) {
      var sstParams = {};
      try {
        var sstUrl = new URL(url);
        ['sst.gpp', 'sst.gpp_sid', 'gcs', 'npa', 'dma', 'ur'].forEach(function(p) {
          var v = sstUrl.searchParams.get(p);
          if (v !== null) sstParams[p] = v;
        });
      } catch(e) {}
      sstReqs.push({ url: url.substring(0, 300), params: sstParams, initiator: entries[j].initiatorType });
    }

    // Google Syndication
    if (url.indexOf('googlesyndication.com') > -1) {
      var syndParams = {};
      try {
        var syndUrl = new URL(url);
        ['us_privacy', 'gpp', 'gpp_sid', 'gcs', 'npa', 'gdpr', 'gdpr_consent'].forEach(function(p) {
          var v = syndUrl.searchParams.get(p);
          if (v !== null) syndParams[p] = v;
        });
      } catch(e) {}
      syndReqs.push({ url: url.substring(0, 300), params: syndParams, initiator: entries[j].initiatorType });
    }

    // Google Ad Manager (gampad)
    if (url.indexOf('gampad/ads') > -1) {
      var gamParams = {};
      try {
        var gamUrl = new URL(url);
        ['gpp', 'gpp_sid', 'us_privacy', 'gdpr', 'gdpr_consent', 'npa'].forEach(function(p) {
          var v = gamUrl.searchParams.get(p);
          if (v !== null) gamParams[p] = v;
        });
      } catch(e) {}
      gampadReqs.push({ url: url.substring(0, 500), params: gamParams, initiator: entries[j].initiatorType });
    }

    // comScore / Scorecard Research
    if (url.indexOf('scorecardresearch.com/b') > -1 || url.indexOf('comscore.com') > -1) {
      var csParams = {};
      try {
        var csUrl = new URL(url);
        ['gpp_sid', 'gpp_smv', 'gpp_gpc', 'gpp_oos', 'gpp_oon', 'gpp_sdp', 'gpp_pdc', 'gpp_cdc',
         'gpp_mct', 'gpp_mom', 'gpp_msm', 'cs_cmp_id', 'cs_cmp_av', 'us_privacy'].forEach(function(p) {
          var v = csUrl.searchParams.get(p);
          if (v !== null) csParams[p] = v;
        });
      } catch(e) {}
      comscoreReqs.push({ url: url.substring(0, 300), params: csParams, initiator: entries[j].initiatorType });
    }

    // Prebid partners
    if (url.indexOf('openx.net') > -1 || url.indexOf('rubiconproject.com') > -1 ||
        url.indexOf('pubmatic.com') > -1 || url.indexOf('casalemedia.com') > -1 ||
        url.indexOf('indexww.com') > -1 || url.indexOf('prebid') > -1 ||
        url.indexOf('htlbid.com') > -1) {
      prebidReqs.push({ url: url.substring(0, 300), domain: url.split('/')[2], initiator: entries[j].initiatorType });
    }

    // Amazon
    if (url.indexOf('amazon-adsystem.com') > -1) {
      amazonReqs.push({ url: url.substring(0, 300), initiator: entries[j].initiatorType });
    }

    // OneTrust scripts
    if (url.indexOf('cookielaw.org') > -1 || url.indexOf('onetrust.com') > -1) {
      otScripts.push({ file: url.split('/').pop().split('?')[0], initiator: entries[j].initiatorType });
    }

    // Google Tag Manager / Analytics
    if (url.indexOf('googletagmanager.com') > -1) {
      googleTagReqs.push({ url: url.substring(0, 300), initiator: entries[j].initiatorType });
    }

    // Any request with GPP or privacy params in URL
    if (url.indexOf('gpp') > -1 || url.indexOf('GPP') > -1 ||
        url.indexOf('us_privacy') > -1 || url.indexOf('gdpr') > -1) {
      gppRequests.push({ url: url.substring(0, 400), initiator: entries[j].initiatorType });
    }
  }

  result.vendors = {
    googleSST: { count: sstReqs.length, requests: sstReqs },
    googleSyndication: { count: syndReqs.length, requests: syndReqs },
    googleAdManager: { count: gampadReqs.length, requests: gampadReqs },
    comScore: { count: comscoreReqs.length, requests: comscoreReqs },
    prebid: { count: prebidReqs.length, requests: prebidReqs },
    amazon: { count: amazonReqs.length, requests: amazonReqs },
    googleTag: { count: googleTagReqs.length, requests: googleTagReqs }
  };
  result.otScripts = otScripts;
  result.requestsWithPrivacyParams = gppRequests;

  // --- OneTrust consent groups (from OptanonConsent cookie) ---
  if (result.cookies.OptanonConsent) {
    try {
      var groups = result.cookies.OptanonConsent.match(/groups=([^&]+)/);
      if (groups) result.consentGroups = decodeURIComponent(groups[1]);
    } catch(e) {}
  }

  // --- Write result to title for AppleScript retrieval ---
  var json = JSON.stringify(result);
  var originalTitle = document.title;
  document.title = 'GPPDATA:' + json;
  // Restore original title after a short delay to prevent GA from capturing the JSON blob
  setTimeout(function() { document.title = originalTitle; }, 3000);
  return json;
})()
