import * as Schema from "effect/Schema";
import type { Json } from "effect/Schema";

type FakeSubtitle = {
  readonly fileId: number;
  readonly release: string;
  readonly srt: string;
  readonly title: string;
  readonly season?: number;
  readonly episode?: number;
  readonly year?: number;
  readonly hearingImpaired?: boolean;
  readonly downloads?: number;
};

export type FakeOpenSubtitlesOptions = { readonly subtitles: ReadonlyArray<FakeSubtitle>; readonly quota?: number };

const decodeDownload = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ file_id: Schema.Finite })));

const json = (status: number, body: Json) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export const makeFakeOpenSubtitles = (opts: FakeOpenSubtitlesOptions) => {
  const searches: Array<URLSearchParams> = [];
  const downloads: Array<number> = [];
  let logins = 0;
  let left = opts.quota ?? 20;

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);

    if (url.pathname === "/api/v1/login") {
      logins += 1;

      return json(200, { token: "os-token", base_url: "api.opensubtitles.com", user: { allowed_downloads: 20 } });
    }

    if (url.pathname === "/api/v1/subtitles") {
      searches.push(url.searchParams);
      const query = url.searchParams.get("query") ?? "";
      const season = Number(url.searchParams.get("season_number") ?? Number.NaN);
      const episode = Number(url.searchParams.get("episode_number") ?? Number.NaN);
      const hits = opts.subtitles.filter((s) => s.title.toLowerCase().includes(query) && (s.season === undefined || (s.season === season && s.episode === episode)));

      return json(200, {
        total_count: hits.length,
        data: hits.map((s) => ({
          attributes: {
            release: s.release,
            hearing_impaired: s.hearingImpaired ?? false,
            ai_translated: false,
            machine_translated: false,
            download_count: s.downloads ?? 0,
            feature_details:
              s.season === undefined
                ? { feature_type: "Movie", title: s.title, year: s.year ?? null }
                : { feature_type: "Episode", parent_title: s.title, season_number: s.season, episode_number: s.episode ?? null },
            files: [{ file_id: s.fileId, file_name: `${s.release}.srt` }],
          },
        })),
      });
    }

    if (url.pathname === "/api/v1/download") {
      if (request.headers.get("authorization") !== "Bearer os-token") return json(401, { message: "token required" });

      if (left <= 0) return json(406, { message: "quota", reset_time: "11 hours and 4 minutes" });

      const fileId = decodeDownload(await request.text()).file_id;

      left -= 1;
      downloads.push(fileId);

      return json(200, { link: `https://dl.opensubtitles.test/file/${fileId}`, remaining: left });
    }

    const file = url.pathname.match(/^\/file\/(\d+)$/);
    const found = file ? opts.subtitles.find((s) => s.fileId === Number(file[1])) : undefined;

    return found ? new Response(found.srt, { status: 200 }) : new Response("not found", { status: 404 });
  };

  return {
    fetch,
    searches,
    downloads,
    logins: () => logins,
  };
};
