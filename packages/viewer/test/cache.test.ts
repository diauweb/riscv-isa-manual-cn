import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEMO_SITE_INDEX } from "../src/demoData";
import { lookupAnchor, resetAnchorCacheForTest } from "../src/lib/anchors";
import type { AnchorIndex, ChapterUnitPack, SearchEntry, SiteIndex, UnitMetaShard } from "../src/types";
import {
  fetchAnchorIndex,
  fetchChapterUnitPack,
  fetchSearchIndex,
  fetchSiteIndex,
  fetchUnitMeta,
  resetDataClientCachesForTest,
  siteDataVersion,
} from "../src/utils/dataClient";
import { withCloudflareRocketLoaderCompat } from "../vite.config";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetDataClientCachesForTest();
  resetAnchorCacheForTest();
});

function makeSiteIndex(overrides: Partial<SiteIndex> = {}): SiteIndex {
  return {
    ...DEMO_SITE_INDEX,
    generated_at: "2026-11-18T12:00:00.000Z",
    default_tree_hash: "1111111111111111",
    ...overrides,
  };
}

describe("viewer dataClient browser & CDN cache handling", () => {
  it("revalidates index.json with cache='no-cache' by default and busts cache on recovery", async () => {
    const calls: Array<{ url: string; cache?: RequestCache }> = [];
    const idx1 = makeSiteIndex();
    const idx2 = makeSiteIndex({
      generated_at: "2026-11-18T13:00:00.000Z",
      default_tree_hash: "2222222222222222",
    });

    let count = 0;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, cache: init?.cache });
      count += 1;
      const body = count === 1 ? idx1 : idx2;
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;

    const loaded1 = await fetchSiteIndex();
    expect(loaded1.default_tree_hash).toBe("1111111111111111");
    expect(calls[0]).toEqual({ url: "./data/index.json", cache: "no-cache" });

    const loaded2 = await fetchSiteIndex({ bustCache: true });
    expect(loaded2.default_tree_hash).toBe("2222222222222222");
    expect(calls[1]?.cache).toBe("reload");
    expect(calls[1]?.url).toMatch(/^\.\/data\/index\.json\?_=\d+$/);
  });

  it("stamps unhashed lazy JSON URLs with siteDataVersion and invalidates caches when index updates", async () => {
    const idxA = makeSiteIndex({
      generated_at: "2026-11-18T12:00:00.000Z",
      default_tree_hash: "aaaaaaaaaaaaaaaa",
    });
    const idxB = makeSiteIndex({
      generated_at: "2026-11-18T18:00:00.000Z",
      default_tree_hash: "bbbbbbbbbbbbbbbb",
    });
    const verA = encodeURIComponent(siteDataVersion(idxA));
    const verB = encodeURIComponent(siteDataVersion(idxB));

    let currentIndex = idxA;
    let anchorLabel = "chap-a";
    let searchZh = "旧译文";
    let metaZhRaw = "旧源码";
    const requestedUrls: string[] = [];

    const unitId = "3a000000000000000000000000000001";
    const packHash = "deadbeefcafebabe";

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.startsWith("./data/index.json")) {
        return new Response(JSON.stringify(currentIndex), { status: 200 });
      }
      if (url.startsWith("./data/anchors.json")) {
        const payload: AnchorIndex = {
          anchors: {
            "my-anchor": {
              volume_id: "unpriv",
              chapter_id: anchorLabel,
              anchor_id: "my-anchor",
            },
          },
        };
        return new Response(JSON.stringify(payload), { status: 200 });
      }
      if (url.startsWith("./data/search.json")) {
        const payload: SearchEntry[] = [
          {
            unit_id: unitId,
            volume_id: "unpriv",
            chapter_id: "rv32i",
            section_id: "sec",
            chapter_title: "RV32I",
            en: "Old",
            zh: searchZh,
          },
        ];
        return new Response(JSON.stringify(payload), { status: 200 });
      }
      if (url.startsWith("./data/meta/3a.json")) {
        const payload: UnitMetaShard = {
          [unitId]: {
            unit_id: unitId,
            kind: "paragraph",
            translatable: true,
            status: "machine",
            en_raw: "Old",
            zh_raw: metaZhRaw,
            upstream_history: [],
            revisions: [],
          },
        };
        return new Response(JSON.stringify(payload), { status: 200 });
      }
      if (url.startsWith(`./data/packs/${packHash}.json`)) {
        const payload: ChapterUnitPack = {
          pack_hash: packHash,
          volume_id: "unpriv",
          chapter_id: "rv32i",
          units: {},
        };
        return new Response(JSON.stringify(payload), { status: 200 });
      }
      return new Response("Not Found", { status: 404 });
    }) as typeof fetch;

    // Load Deploy A
    await fetchSiteIndex();
    expect((await lookupAnchor("my-anchor", false))?.chapter).toBe("chap-a");
    expect((await fetchSearchIndex(false))[0]?.zh).toBe("旧译文");
    expect((await fetchUnitMeta(unitId, false))?.zh_raw).toBe("旧源码");
    await fetchChapterUnitPack(packHash, false);

    // Repeat within Deploy A -> served from in-memory cache with zero extra network calls
    const countAfterFirstLoad = requestedUrls.length;
    await fetchAnchorIndex(false);
    await lookupAnchor("my-anchor", false);
    await fetchSearchIndex(false);
    await fetchUnitMeta(unitId, false);
    await fetchChapterUnitPack(packHash, false);
    expect(requestedUrls.length).toBe(countAfterFirstLoad);

    expect(requestedUrls).toContain(`./data/anchors.json?v=${verA}`);
    expect(requestedUrls).toContain(`./data/search.json?v=${verA}`);
    expect(requestedUrls).toContain(`./data/meta/3a.json?v=${verA}`);
    expect(requestedUrls).toContain(`./data/packs/${packHash}.json`);

    // Simulate Deploy B going live and tab refreshing index.json
    currentIndex = idxB;
    anchorLabel = "chap-b";
    searchZh = "新译文";
    metaZhRaw = "新源码";

    await fetchSiteIndex({ bustCache: true });

    // Unhashed resources bust URL + memory cache; content-hashed pack stays cached
    expect((await lookupAnchor("my-anchor", false))?.chapter).toBe("chap-b");
    expect((await fetchSearchIndex(false))[0]?.zh).toBe("新译文");
    expect((await fetchUnitMeta(unitId, false))?.zh_raw).toBe("新源码");
    await fetchChapterUnitPack(packHash, false);

    expect(requestedUrls).toContain(`./data/anchors.json?v=${verB}`);
    expect(requestedUrls).toContain(`./data/search.json?v=${verB}`);
    expect(requestedUrls).toContain(`./data/meta/3a.json?v=${verB}`);
    expect(requestedUrls.filter((u) => u === `./data/packs/${packHash}.json`)).toHaveLength(1);
  });
});

describe("Cloudflare Rocket Loader HTML compatibility", () => {
  it("places data-cfasync='false' before src and type on all script tags without duplication", () => {
    const sampleViteOutput = [
      "<!doctype html><html><head>",
      '<script data-cfasync="false">console.log("theme")</script>',
      '<script type="module" crossorigin src="./assets/index-B-1DS_j5.js"></script>',
      '<script src="./other.js" data-cfasync="true"></script>',
      "</head><body></body></html>",
    ].join("\n");

    const out = withCloudflareRocketLoaderCompat(sampleViteOutput);
    const scripts = [...out.matchAll(/<script\b[^>]*>/gi)].map((m) => m[0]);
    expect(scripts).toEqual([
      '<script data-cfasync="false">',
      '<script data-cfasync="false" type="module" crossorigin src="./assets/index-B-1DS_j5.js">',
      '<script data-cfasync="false" src="./other.js">',
    ]);
  });

  it("keeps viewer index.html free of inline on*= event attributes", () => {
    const html = readFileSync(join(import.meta.dir, "..", "index.html"), "utf8");
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    const scripts = [...html.matchAll(/<script\b[^>]*>/gi)].map((m) => m[0]);
    expect(scripts.length).toBeGreaterThanOrEqual(2);
    for (const tag of scripts) {
      expect(tag.startsWith('<script data-cfasync="false"')).toBe(true);
    }
  });
});
