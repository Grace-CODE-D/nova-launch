import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  addEntry,
  analyzeBundle,
  analyzeLighthouse,
  buildNewRelicEvent,
  detectRegressions,
  generateReport,
  getNewRelicConfig,
  loadHistory,
  publishToNewRelic,
  saveHistory,
  MAX_HISTORY_ENTRIES,
} from "./performance-monitor.js";

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nova-launch-monitor-"));
}

function createBundleAnalysisFile(dir, content) {
  const filePath = path.join(dir, "bundle-analysis.json");
  fs.writeFileSync(filePath, JSON.stringify(content, null, 2));
  return filePath;
}

function createLighthouseDir(dir, reports) {
  const lighthouseDir = path.join(dir, ".lighthouseci");
  fs.mkdirSync(lighthouseDir, { recursive: true });

  reports.forEach(({ name, content, mtimeOffset }) => {
    const filePath = path.join(lighthouseDir, name);
    fs.writeFileSync(filePath, JSON.stringify(content, null, 2));
    const time = new Date(Date.now() + mtimeOffset);
    fs.utimesSync(filePath, time, time);
  });

  return lighthouseDir;
}

describe("performance monitor helpers", () => {
  let tempDir;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("loads an empty history when the file is missing", () => {
    expect(loadHistory({ historyFile: path.join(tempDir, "missing.json") })).toEqual({ entries: [] });
  });

  it("filters malformed history entries", () => {
    const historyFile = path.join(tempDir, "history.json");
    fs.writeFileSync(historyFile, JSON.stringify({ entries: [{ ok: true }, null, "bad"] }));

    expect(loadHistory({ historyFile })).toEqual({ entries: [{ ok: true }] });
  });

  it("saves history as formatted JSON", () => {
    const historyFile = path.join(tempDir, "history.json");
    saveHistory({ entries: [{ value: 1 }] }, { historyFile });

    expect(JSON.parse(fs.readFileSync(historyFile, "utf-8"))).toEqual({ entries: [{ value: 1 }] });
  });

  it("adds an entry using sanitized commit and branch metadata", () => {
    const historyFile = path.join(tempDir, "history.json");
    const result = addEntry(
      { totalSize: 12.34, ignored: "text" },
      {
        historyFile,
        env: {
          GITHUB_SHA: "abc123<script>",
          GITHUB_REF_NAME: "feature/new relic",
        },
        timestamp: "2026-04-26T00:00:00.000Z",
      }
    );

    expect(result.entry).toMatchObject({
      timestamp: "2026-04-26T00:00:00.000Z",
      commit: "abc123-script-",
      branch: "feature/new-relic",
      totalSize: 12.34,
    });
    expect(result.history.entries).toHaveLength(1);
  });

  it("caps the history length at MAX_HISTORY_ENTRIES", () => {
    const historyFile = path.join(tempDir, "history.json");
    const entries = Array.from({ length: MAX_HISTORY_ENTRIES }, (_, index) => ({
      timestamp: `2026-04-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
      totalSize: index,
    }));
    fs.writeFileSync(historyFile, JSON.stringify({ entries }, null, 2));

    const result = addEntry({ totalSize: 500 }, { historyFile, timestamp: "2026-05-01T00:00:00.000Z" });

    expect(result.history.entries).toHaveLength(MAX_HISTORY_ENTRIES);
    expect(result.history.entries[0].totalSize).toBe(500);
  });

  it("analyzes bundle metrics from the latest report format", () => {
    const bundleAnalysisFile = createBundleAnalysisFile(tempDir, {
      totalSize: "123.45",
      totals: {
        scripts: 10,
        stylesheets: 5,
        images: 2,
        fonts: 1,
      },
    });

    expect(analyzeBundle({ bundleAnalysisFile })).toEqual({
      totalSize: 123.45,
      scriptSize: 10,
      styleSize: 5,
      imageSize: 2,
      fontSize: 1,
    });
  });

  it("returns null for invalid bundle analysis data", () => {
    const bundleAnalysisFile = createBundleAnalysisFile(tempDir, {
      totalSize: "not-a-number",
      totals: { scripts: 10, stylesheets: 5, images: 2, fonts: 1 },
    });

    expect(analyzeBundle({ bundleAnalysisFile })).toBeNull();
  });

  it("analyzes the newest Lighthouse report", () => {
    const lighthouseDir = createLighthouseDir(tempDir, [
      {
        name: "older.json",
        mtimeOffset: -1000,
        content: {
          categories: { performance: { score: 0.5 } },
          audits: {
            "first-contentful-paint": { numericValue: 100 },
            "largest-contentful-paint": { numericValue: 200 },
            interactive: { numericValue: 300 },
            "total-blocking-time": { numericValue: 400 },
            "cumulative-layout-shift": { numericValue: 0.1 },
            "speed-index": { numericValue: 500 },
          },
        },
      },
      {
        name: "newer.json",
        mtimeOffset: 1000,
        content: {
          categories: { performance: { score: 0.9 } },
          audits: {
            "first-contentful-paint": { numericValue: 111 },
            "largest-contentful-paint": { numericValue: 222 },
            interactive: { numericValue: 333 },
            "total-blocking-time": { numericValue: 444 },
            "cumulative-layout-shift": { numericValue: 0.2 },
            "speed-index": { numericValue: 555 },
          },
        },
      },
    ]);

    expect(analyzeLighthouse({ lighthouseDir })).toEqual({
      performanceScore: 90,
      fcp: 111,
      lcp: 222,
      tti: 333,
      tbt: 444,
      cls: 0.2,
      speedIndex: 555,
    });
  });

  it("returns null when Lighthouse data is invalid or missing", () => {
    const lighthouseDir = createLighthouseDir(tempDir, [
      {
        name: "report.json",
        mtimeOffset: 0,
        content: {
          categories: { performance: { score: 0.9 } },
          audits: {
            "first-contentful-paint": { numericValue: "bad" },
          },
        },
      },
    ]);

    expect(analyzeLighthouse({ lighthouseDir })).toBeNull();
  });

  it("detects only regressions over the configured threshold", () => {
    expect(
      detectRegressions(
        { totalSize: 120, fcp: 110, lcp: 100, tti: 100, tbt: 100, cls: 0.1 },
        { totalSize: 100, fcp: 100, lcp: 100, tti: 100, tbt: 100, cls: 0.1 }
      )
    ).toEqual([
      {
        metric: "Total Bundle Size",
        previous: 100,
        current: 120,
        change: "20.0%",
        unit: "KB",
      },
    ]);
  });

  it("builds a sanitized New Relic event payload", () => {
    const event = buildNewRelicEvent({
      entry: {
        timestamp: "2026-04-26T00:00:00.000Z",
        branch: "main",
        commit: "abcdef",
      },
      metrics: { totalSize: 10.5, performanceScore: 99.2 },
      regressions: [{ metric: "Total Bundle Size" }],
      config: {
        appName: "nova-launch-frontend",
        source: "frontend-performance-monitor",
      },
    });

    expect(event).toMatchObject({
      eventType: "NovaLaunchPerformanceSample",
      appName: "nova-launch-frontend",
      source: "frontend-performance-monitor",
      branch: "main",
      commit: "abcdef",
      regressionCount: 1,
      regressionSummary: "Total Bundle Size",
      totalSize: 10.5,
      performanceScore: 99.2,
    });
  });

  it("derives the New Relic config only when credentials are present", () => {
    expect(getNewRelicConfig({})).toBeNull();
    expect(
      getNewRelicConfig({
        NEW_RELIC_ACCOUNT_ID: "123",
        NEW_RELIC_INSERT_KEY: "insert-key",
        NEW_RELIC_INSIGHTS_URL: "https://example.test/events",
        NEW_RELIC_APP_NAME: "perf-app",
        NEW_RELIC_SOURCE: "custom-source",
      })
    ).toEqual({
      accountId: "123",
      insertKey: "insert-key",
      endpoint: "https://example.test/events",
      appName: "perf-app",
      source: "custom-source",
    });
  });

  it("publishes a New Relic event through fetch", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    const result = await publishToNewRelic(
      { eventType: "NovaLaunchPerformanceSample" },
      {
        config: {
          endpoint: "https://example.test/events",
          insertKey: "insert-key",
        },
        fetchImpl,
      }
    );

    expect(result).toEqual({ sent: true });
    expect(fetchImpl).toHaveBeenCalledWith("https://example.test/events", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Api-Key": "insert-key",
      },
      body: JSON.stringify({ eventType: "NovaLaunchPerformanceSample" }),
    });
  });

  it("skips New Relic publishing when credentials are absent", async () => {
    await expect(
      publishToNewRelic({ eventType: "NovaLaunchPerformanceSample" }, { config: null })
    ).resolves.toEqual({ sent: false, reason: "missing-credentials" });
  });

  it("raises an error for non-2xx New Relic responses", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 503 });

    await expect(
      publishToNewRelic(
        { eventType: "NovaLaunchPerformanceSample" },
        {
          config: {
            endpoint: "https://example.test/events",
            insertKey: "insert-key",
          },
          fetchImpl,
        }
      )
    ).rejects.toThrow("New Relic event API returned 503");
  });

  it("runs the full report flow and publishes a New Relic event", async () => {
    const historyFile = path.join(tempDir, "history.json");
    const bundleAnalysisFile = createBundleAnalysisFile(tempDir, {
      totalSize: "50",
      totals: {
        scripts: 25,
        stylesheets: 10,
        images: 5,
        fonts: 2,
      },
    });
    const lighthouseDir = createLighthouseDir(tempDir, [
      {
        name: "report.json",
        mtimeOffset: 0,
        content: {
          categories: { performance: { score: 0.87 } },
          audits: {
            "first-contentful-paint": { numericValue: 100 },
            "largest-contentful-paint": { numericValue: 200 },
            interactive: { numericValue: 300 },
            "total-blocking-time": { numericValue: 40 },
            "cumulative-layout-shift": { numericValue: 0.01 },
            "speed-index": { numericValue: 400 },
          },
        },
      },
    ]);

    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await generateReport({
      historyFile,
      bundleAnalysisFile,
      lighthouseDir,
      env: {
        GITHUB_SHA: "abc123",
        GITHUB_REF_NAME: "main",
        NEW_RELIC_ACCOUNT_ID: "123",
        NEW_RELIC_INSERT_KEY: "insert-key",
        NEW_RELIC_INSIGHTS_URL: "https://example.test/events",
      },
      fetchImpl,
    });

    expect(result.bundleMetrics).toEqual({
      totalSize: 50,
      scriptSize: 25,
      styleSize: 10,
      imageSize: 5,
      fontSize: 2,
    });
    expect(result.lighthouseMetrics?.performanceScore).toBe(87);
    expect(fs.existsSync(historyFile)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalled();
  });

  it("does not fail the report when the New Relic publish path fails", async () => {
    const historyFile = path.join(tempDir, "history.json");
    const bundleAnalysisFile = createBundleAnalysisFile(tempDir, {
      totalSize: "50",
      totals: {
        scripts: 25,
        stylesheets: 10,
        images: 5,
        fonts: 2,
      },
    });
    const lighthouseDir = createLighthouseDir(tempDir, [
      {
        name: "report.json",
        mtimeOffset: 0,
        content: {
          categories: { performance: { score: 0.87 } },
          audits: {
            "first-contentful-paint": { numericValue: 100 },
            "largest-contentful-paint": { numericValue: 200 },
            interactive: { numericValue: 300 },
            "total-blocking-time": { numericValue: 40 },
            "cumulative-layout-shift": { numericValue: 0.01 },
            "speed-index": { numericValue: 400 },
          },
        },
      },
    ]);

    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await generateReport({
      historyFile,
      bundleAnalysisFile,
      lighthouseDir,
      env: {
        NEW_RELIC_ACCOUNT_ID: "123",
        NEW_RELIC_INSERT_KEY: "insert-key",
      },
      fetchImpl,
    });

    expect(result).toBeDefined();
    expect(warnSpy).toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("sets a failing exit code when regressions are detected", async () => {
    const historyFile = path.join(tempDir, "history.json");
    const previousHistory = {
      entries: [
        {
          timestamp: "2026-04-25T00:00:00.000Z",
          totalSize: 100,
          fcp: 100,
          lcp: 100,
          tti: 100,
          tbt: 100,
          cls: 0.1,
        },
      ],
    };
    fs.writeFileSync(historyFile, JSON.stringify(previousHistory, null, 2));

    const bundleAnalysisFile = createBundleAnalysisFile(tempDir, {
      totalSize: "130",
      totals: {
        scripts: 25,
        stylesheets: 10,
        images: 5,
        fonts: 2,
      },
    });
    const lighthouseDir = createLighthouseDir(tempDir, [
      {
        name: "report.json",
        mtimeOffset: 0,
        content: {
          categories: { performance: { score: 0.87 } },
          audits: {
            "first-contentful-paint": { numericValue: 120 },
            "largest-contentful-paint": { numericValue: 200 },
            interactive: { numericValue: 300 },
            "total-blocking-time": { numericValue: 40 },
            "cumulative-layout-shift": { numericValue: 0.01 },
            "speed-index": { numericValue: 400 },
          },
        },
      },
    ]);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const originalExitCode = process.exitCode;
    process.exitCode = 0;

    try {
      const result = await generateReport({
        historyFile,
        bundleAnalysisFile,
        lighthouseDir,
        env: {},
      });

      expect(result.regressions.length).toBeGreaterThan(0);
      expect(process.exitCode).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith("❌ Performance regressions detected!");
    } finally {
      process.exitCode = originalExitCode;
    }
  });

  it("reports unavailable sections when artifacts are missing", async () => {
    const historyFile = path.join(tempDir, "history.json");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await generateReport({
      historyFile,
      bundleAnalysisFile: path.join(tempDir, "missing-bundle.json"),
      lighthouseDir: path.join(tempDir, "missing-lighthouse"),
      env: {},
    });

    expect(result.bundleMetrics).toBeNull();
    expect(result.lighthouseMetrics).toBeNull();
    expect(logSpy).toHaveBeenCalledWith("Bundle Sizes: unavailable");
    expect(logSpy).toHaveBeenCalledWith("\nCore Web Vitals: unavailable");
  });

  it("prints trend sections when at least five historical entries exist", async () => {
    const historyFile = path.join(tempDir, "history.json");
    const seededHistory = {
      entries: [
        {
          timestamp: "2026-04-25T00:00:00.000Z",
          totalSize: 101,
          performanceScore: 80,
        },
        {
          timestamp: "2026-04-24T00:00:00.000Z",
          totalSize: 102,
          performanceScore: 81,
        },
        {
          timestamp: "2026-04-23T00:00:00.000Z",
          totalSize: 103,
          performanceScore: 82,
        },
        {
          timestamp: "2026-04-22T00:00:00.000Z",
          totalSize: 104,
          performanceScore: 83,
        },
      ],
    };
    fs.writeFileSync(historyFile, JSON.stringify(seededHistory, null, 2));

    const bundleAnalysisFile = createBundleAnalysisFile(tempDir, {
      totalSize: "100",
      totals: {
        scripts: 25,
        stylesheets: 10,
        images: 5,
        fonts: 2,
      },
    });
    const lighthouseDir = createLighthouseDir(tempDir, [
      {
        name: "report.json",
        mtimeOffset: 0,
        content: {
          categories: { performance: { score: 0.88 } },
          audits: {
            "first-contentful-paint": { numericValue: 100 },
            "largest-contentful-paint": { numericValue: 200 },
            interactive: { numericValue: 300 },
            "total-blocking-time": { numericValue: 40 },
            "cumulative-layout-shift": { numericValue: 0.01 },
            "speed-index": { numericValue: 400 },
          },
        },
      },
    ]);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await generateReport({
      historyFile,
      bundleAnalysisFile,
      lighthouseDir,
      env: {},
    });

    expect(logSpy).toHaveBeenCalledWith("Bundle Size Trend:");
    expect(logSpy).toHaveBeenCalledWith("\nPerformance Score Trend:");
  });
});
