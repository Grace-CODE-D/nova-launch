#!/usr/bin/env node

/**
 * Performance monitoring pipeline.
 *
 * The script keeps the existing local history/reporting flow and optionally
 * publishes sanitized custom events to New Relic when credentials are present.
 * The monitoring output stays intentionally narrow: bundle size, Lighthouse
 * scores, regression flags, and basic build identity metadata.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const MAX_HISTORY_ENTRIES = 100;
export const NEW_RELIC_EVENT_TYPE = "NovaLaunchPerformanceSample";
export const DEFAULT_HISTORY_FILE = path.join(
  __dirname,
  "..",
  "performance-history.json"
);
export const DEFAULT_BUNDLE_ANALYSIS_FILE = path.join(
  __dirname,
  "..",
  "bundle-analysis.json"
);
export const DEFAULT_LIGHTHOUSE_DIR = path.join(
  __dirname,
  "..",
  ".lighthouseci"
);

const REGRESSION_THRESHOLD = 0.1;
const METRIC_CHECKS = [
  { key: "totalSize", name: "Total Bundle Size", unit: "KB" },
  { key: "fcp", name: "First Contentful Paint", unit: "ms" },
  { key: "lcp", name: "Largest Contentful Paint", unit: "ms" },
  { key: "tti", name: "Time to Interactive", unit: "ms" },
  { key: "tbt", name: "Total Blocking Time", unit: "ms" },
  { key: "cls", name: "Cumulative Layout Shift", unit: "" },
];

function createFsAdapter(fsApi = fs) {
  return {
    existsSync: fsApi.existsSync.bind(fsApi),
    readFileSync: fsApi.readFileSync.bind(fsApi),
    writeFileSync: fsApi.writeFileSync.bind(fsApi),
    readdirSync: fsApi.readdirSync.bind(fsApi),
    statSync: fsApi.statSync.bind(fsApi),
  };
}

function parseJsonFile(filePath, fsApi = fs) {
  const fileSystem = createFsAdapter(fsApi);

  if (!fileSystem.existsSync(filePath)) {
    return null;
  }

  try {
    return JSON.parse(fileSystem.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function toFiniteNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return undefined;
}

function normalizeLabel(value, fallback) {
  const source = (value ?? fallback).toString().trim();
  const normalized = source.replace(/[^a-zA-Z0-9._/-]+/g, "-").slice(0, 200);
  return normalized.length > 0 ? normalized : fallback;
}

function sanitizeMetrics(metrics = {}) {
  return Object.entries(metrics).reduce((accumulator, [key, value]) => {
    const numericValue = toFiniteNumber(value);
    if (numericValue !== undefined) {
      accumulator[key] = numericValue;
    }
    return accumulator;
  }, {});
}

export function loadHistory({ historyFile = DEFAULT_HISTORY_FILE, fsApi = fs } = {}) {
  const data = parseJsonFile(historyFile, fsApi);

  if (!data || !Array.isArray(data.entries)) {
    return { entries: [] };
  }

  return {
    entries: data.entries.filter((entry) => entry && typeof entry === "object"),
  };
}

export function saveHistory(history, { historyFile = DEFAULT_HISTORY_FILE, fsApi = fs } = {}) {
  const fileSystem = createFsAdapter(fsApi);
  fileSystem.writeFileSync(historyFile, JSON.stringify(history, null, 2));
}

export function addEntry(metrics, { historyFile = DEFAULT_HISTORY_FILE, fsApi = fs, env = process.env, timestamp = new Date().toISOString() } = {}) {
  const history = loadHistory({ historyFile, fsApi });
  const entry = {
    timestamp,
    commit: normalizeLabel(env.GITHUB_SHA, "local"),
    branch: normalizeLabel(env.GITHUB_REF_NAME, "local"),
    ...sanitizeMetrics(metrics),
  };

  history.entries.unshift(entry);
  history.entries = history.entries.slice(0, MAX_HISTORY_ENTRIES);

  saveHistory(history, { historyFile, fsApi });

  return { entry, history };
}

export function analyzeBundle({ bundleAnalysisFile = DEFAULT_BUNDLE_ANALYSIS_FILE, fsApi = fs } = {}) {
  const analysis = parseJsonFile(bundleAnalysisFile, fsApi);

  if (!analysis?.totals) {
    return null;
  }

  const totalSize = toFiniteNumber(analysis.totalSize);
  const scriptSize = toFiniteNumber(analysis.totals.scripts);
  const styleSize = toFiniteNumber(analysis.totals.stylesheets);
  const imageSize = toFiniteNumber(analysis.totals.images);
  const fontSize = toFiniteNumber(analysis.totals.fonts);

  if (
    [totalSize, scriptSize, styleSize, imageSize, fontSize].some((value) => value === undefined)
  ) {
    return null;
  }

  return {
    totalSize,
    scriptSize,
    styleSize,
    imageSize,
    fontSize,
  };
}

export function analyzeLighthouse({ lighthouseDir = DEFAULT_LIGHTHOUSE_DIR, fsApi = fs } = {}) {
  const fileSystem = createFsAdapter(fsApi);

  if (!fileSystem.existsSync(lighthouseDir)) {
    return null;
  }

  const files = fileSystem
    .readdirSync(lighthouseDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const filePath = path.join(lighthouseDir, name);
      return {
        name,
        path: filePath,
        time: fileSystem.statSync(filePath).mtime.getTime(),
      };
    })
    .sort((left, right) => right.time - left.time);

  if (files.length === 0) {
    return null;
  }

  const report = parseJsonFile(files[0].path, fsApi);
  const audits = report?.audits;
  const performanceScore = toFiniteNumber(report?.categories?.performance?.score);

  if (!audits || performanceScore === undefined) {
    return null;
  }

  const fcp = toFiniteNumber(audits["first-contentful-paint"]?.numericValue);
  const lcp = toFiniteNumber(audits["largest-contentful-paint"]?.numericValue);
  const tti = toFiniteNumber(audits.interactive?.numericValue);
  const tbt = toFiniteNumber(audits["total-blocking-time"]?.numericValue);
  const cls = toFiniteNumber(audits["cumulative-layout-shift"]?.numericValue);
  const speedIndex = toFiniteNumber(audits["speed-index"]?.numericValue);

  if ([fcp, lcp, tti, tbt, cls, speedIndex].some((value) => value === undefined)) {
    return null;
  }

  return {
    performanceScore: performanceScore * 100,
    fcp,
    lcp,
    tti,
    tbt,
    cls,
    speedIndex,
  };
}

export function detectRegressions(current, previous) {
  if (!previous) {
    return [];
  }

  const regressions = [];

  METRIC_CHECKS.forEach((check) => {
    const currentValue = toFiniteNumber(current?.[check.key]);
    const previousValue = toFiniteNumber(previous?.[check.key]);

    if (currentValue === undefined || previousValue === undefined || previousValue === 0) {
      return;
    }

    const change = (currentValue - previousValue) / previousValue;

    if (change > REGRESSION_THRESHOLD) {
      regressions.push({
        metric: check.name,
        previous: previousValue,
        current: currentValue,
        change: `${(change * 100).toFixed(1)}%`,
        unit: check.unit,
      });
    }
  });

  return regressions;
}

export function getNewRelicConfig(env = process.env) {
  const accountId = env.NEW_RELIC_ACCOUNT_ID?.trim();
  const insertKey = env.NEW_RELIC_INSERT_KEY?.trim();

  if (!accountId || !insertKey) {
    return null;
  }

  const endpoint = env.NEW_RELIC_INSIGHTS_URL?.trim() ?? `https://insights-collector.newrelic.com/v1/accounts/${accountId}/events`;

  return {
    accountId,
    insertKey,
    endpoint,
    appName: env.NEW_RELIC_APP_NAME?.trim() || "nova-launch-frontend",
    source: env.NEW_RELIC_SOURCE?.trim() || "frontend-performance-monitor",
  };
}

export function buildNewRelicEvent({ entry, metrics, regressions, config }) {
  return {
    eventType: NEW_RELIC_EVENT_TYPE,
    appName: config.appName,
    source: config.source,
    branch: entry.branch,
    commit: entry.commit,
    timestamp: entry.timestamp,
    regressionCount: regressions.length,
    regressionSummary: regressions.map((regression) => regression.metric).join(","),
    ...sanitizeMetrics(metrics),
  };
}

export async function publishToNewRelic(event, { config, fetchImpl = globalThis.fetch } = {}) {
  if (!config) {
    return { sent: false, reason: "missing-credentials" };
  }

  if (typeof fetchImpl !== "function") {
    return { sent: false, reason: "fetch-unavailable" };
  }

  const response = await fetchImpl(config.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Api-Key": config.insertKey,
    },
    body: JSON.stringify(event),
  });

  if (!response.ok) {
    throw new Error(`New Relic event API returned ${response.status}`);
  }

  return { sent: true };
}

export async function generateReport({
  fsApi = fs,
  fetchImpl = globalThis.fetch,
  env = process.env,
  historyFile = DEFAULT_HISTORY_FILE,
  bundleAnalysisFile = DEFAULT_BUNDLE_ANALYSIS_FILE,
  lighthouseDir = DEFAULT_LIGHTHOUSE_DIR,
} = {}) {
  console.log("📊 Performance Monitoring Report\n");
  console.log("═".repeat(60));

  const bundleMetrics = analyzeBundle({ bundleAnalysisFile, fsApi });
  const lighthouseMetrics = analyzeLighthouse({ lighthouseDir, fsApi });
  const metrics = {
    ...bundleMetrics,
    ...lighthouseMetrics,
  };

  const { entry, history } = addEntry(metrics, { historyFile, fsApi, env });
  const previous = history.entries[1];
  const regressions = detectRegressions(metrics, previous);

  console.log("\n📈 Current Metrics\n");

  if (bundleMetrics) {
    console.log("Bundle Sizes:");
    console.log(`  Total: ${bundleMetrics.totalSize.toFixed(2)} KB`);
    console.log(`  Scripts: ${bundleMetrics.scriptSize.toFixed(2)} KB`);
    console.log(`  Styles: ${bundleMetrics.styleSize.toFixed(2)} KB`);
  } else {
    console.log("Bundle Sizes: unavailable");
  }

  if (lighthouseMetrics) {
    console.log("\nCore Web Vitals:");
    console.log(`  Performance Score: ${lighthouseMetrics.performanceScore.toFixed(0)}/100`);
    console.log(`  FCP: ${lighthouseMetrics.fcp.toFixed(0)}ms`);
    console.log(`  LCP: ${lighthouseMetrics.lcp.toFixed(0)}ms`);
    console.log(`  TTI: ${lighthouseMetrics.tti.toFixed(0)}ms`);
    console.log(`  TBT: ${lighthouseMetrics.tbt.toFixed(0)}ms`);
    console.log(`  CLS: ${lighthouseMetrics.cls.toFixed(3)}`);
  } else {
    console.log("\nCore Web Vitals: unavailable");
  }

  if (regressions.length > 0) {
    console.log("\n⚠️  Performance Regressions Detected\n");
    regressions.forEach((regression) => {
      console.log(`  ${regression.metric}:`);
      console.log(`    Previous: ${regression.previous}${regression.unit}`);
      console.log(`    Current: ${regression.current}${regression.unit}`);
      console.log(`    Change: +${regression.change}`);
    });
  } else {
    console.log("\n✅ No performance regressions detected");
  }

  if (history.entries.length >= 5) {
    console.log("\n📉 Recent Trend (last 5 builds)\n");

    const recent = history.entries.slice(0, 5).reverse();

    if (recent.every((entryItem) => entryItem.totalSize)) {
      console.log("Bundle Size Trend:");
      recent.forEach((entryItem, index) => {
        const date = new Date(entryItem.timestamp).toLocaleDateString();
        console.log(`  ${index + 1}. ${date}: ${entryItem.totalSize.toFixed(2)} KB`);
      });
    }

    if (recent.every((entryItem) => entryItem.performanceScore)) {
      console.log("\nPerformance Score Trend:");
      recent.forEach((entryItem, index) => {
        const date = new Date(entryItem.timestamp).toLocaleDateString();
        console.log(`  ${index + 1}. ${date}: ${entryItem.performanceScore.toFixed(0)}/100`);
      });
    }
  }

  const newRelicConfig = getNewRelicConfig(env);
  if (newRelicConfig) {
    const event = buildNewRelicEvent({ entry, metrics, regressions, config: newRelicConfig });

    try {
      const result = await publishToNewRelic(event, { config: newRelicConfig, fetchImpl });
      if (result.sent) {
        console.log(`\nNew Relic event submitted: ${newRelicConfig.appName}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`\n⚠️  New Relic publish skipped: ${message}`);
    }
  }

  console.log("\n═".repeat(60));
  console.log(`\n📄 History saved to: ${historyFile}`);
  console.log(`   Total entries: ${history.entries.length}\n`);

  if (regressions.length > 0) {
    console.error("❌ Performance regressions detected!");
    process.exitCode = 1;
  }

  return {
    bundleMetrics,
    lighthouseMetrics,
    metrics,
    entry,
    history,
    regressions,
  };
}

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === __filename;

/* c8 ignore next 6 */
if (isMainModule) {
  generateReport().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
