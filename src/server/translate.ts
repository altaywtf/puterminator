import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { downloadSubtitle, listSubtitles, type PutioError, PutioFailed, uploadText } from "./putio";
import { AnthropicClient, weightedTokens } from "./runner";

const TRANSLATOR = "claude-haiku-5-5";
const PRICE_SHARE = 0.05;
const BATCH = 150;

export const LanguageCode = Schema.Literals(["ara", "chi", "cze", "dan", "dut", "fin", "fre", "ger", "gre", "heb", "hin", "hun", "ind", "ita", "jpn", "kor", "nor", "pol", "por", "rum", "rus", "spa", "swe", "tha", "tur", "ukr", "vie"]);

type LanguageCode = typeof LanguageCode.Type;

export const LANGUAGES: Record<LanguageCode, string> = {
  ara: "Arabic",
  chi: "Chinese (Simplified)",
  cze: "Czech",
  dan: "Danish",
  dut: "Dutch",
  fin: "Finnish",
  fre: "French",
  ger: "German",
  gre: "Greek",
  heb: "Hebrew",
  hin: "Hindi",
  hun: "Hungarian",
  ind: "Indonesian",
  ita: "Italian",
  jpn: "Japanese",
  kor: "Korean",
  nor: "Norwegian",
  pol: "Polish",
  por: "Portuguese",
  rum: "Romanian",
  rus: "Russian",
  spa: "Spanish",
  swe: "Swedish",
  tha: "Thai",
  tur: "Turkish",
  ukr: "Ukrainian",
  vie: "Vietnamese",
};

const SOURCE_ORDER = ["mkv", "opensubtitles"];

type Cue = { head: string; text: string };

type Spend = { readonly allowed: () => boolean; readonly charge: (tokens: number) => void };

const nothingWritten = (e: PutioError): PutioError => (Predicate.isTagged(e, "PutioFailed") ? new PutioFailed({ message: e.message, refused: true }) : e);

const cueText = (translated: string | undefined, original: string) => {
  const text = (translated ?? "").replace(/\r/g, "").replace(/\n{2,}/g, "\n").trim();

  return text || original;
};

const parseSrt = (srt: string): Cue[] =>
  srt
    .replace(/^﻿/, "")
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .flatMap((block) => {
      const lines = block.split("\n");
      const timing = lines.findIndex((l) => l.includes("-->"));

      return timing < 0 ? [] : [{ head: lines.slice(0, timing + 1).join("\n"), text: lines.slice(timing + 1).join("\n") }];
    });

const toSrt = (cues: ReadonlyArray<Cue>) => `${cues.map((c) => `${c.head}\n${c.text}`).join("\n\n")}\n`;

const Lines = Schema.Struct({ lines: Schema.Array(Schema.String) });
const decodeLines = Schema.decodeUnknownOption(Schema.fromJsonString(Lines));

const translateBatch = (texts: ReadonlyArray<string>, language: string, spend: Spend) =>
  Effect.gen(function* () {
    if (!spend.allowed()) return yield* Effect.fail(new PutioFailed({ message: "no credits left this month", refused: true }));
    const client = yield* AnthropicClient;

    const message = yield* Effect.tryPromise({
      try: (signal) =>
        client.messages
          .stream(
            {
              model: TRANSLATOR,
              max_tokens: 32000,
              thinking: { type: "adaptive" },
              output_config: {
                effort: "low",
                format: {
                  type: "json_schema",
                  schema: { type: "object", properties: { lines: { type: "array", items: { type: "string" } } }, required: ["lines"], additionalProperties: false },
                },
              },
              system: `Translate English film and TV subtitle lines into ${language}. Return exactly one translation per input line, in the same order. Keep line breaks inside a line, italics tags and speaker dashes. Write natural spoken ${language}, as a professional subtitler would.`,
              messages: [{ role: "user", content: JSON.stringify({ lines: texts }) }],
            },
            { signal },
          )
          .finalMessage(),
      catch: (e) => new PutioFailed({ message: `translation failed: ${e instanceof Error ? e.message : String(e)}`, refused: true }),
    });

    spend.charge(Math.ceil(weightedTokens(message.usage) * PRICE_SHARE));
    const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    const out = decodeLines(text);

    if (Option.isNone(out) || out.value.lines.length !== texts.length)
      return yield* Effect.fail(new PutioFailed({ message: "the translation came back with the wrong number of lines", refused: true }));

    return out.value.lines;
  });


export const translateSubtitle = (videoId: number, parentId: number, name: string, language: LanguageCode, spend: Spend) =>
  Effect.gen(function* () {
    const subs = yield* listSubtitles(videoId).pipe(Effect.mapError(nothingWritten));
    const source = SOURCE_ORDER.flatMap((s) => subs.filter((x) => x.source === s && x.language_code === "eng"))[0];

    if (!source) return yield* Effect.fail(new PutioFailed({ message: "put.io has no English subtitle for this video", refused: true }));
    const cues = parseSrt(yield* downloadSubtitle(videoId, source.key).pipe(Effect.mapError(nothingWritten)));

    if (cues.length === 0) return yield* Effect.fail(new PutioFailed({ message: "the English subtitle is empty", refused: true }));
    const translated: string[] = [];

    for (let i = 0; i < cues.length; i += BATCH)
      translated.push(...(yield* translateBatch(cues.slice(i, i + BATCH).map((c) => c.text), LANGUAGES[language], spend)));

    return yield* uploadText(name, parentId, toSrt(cues.map((c, i) => ({ head: c.head, text: cueText(translated[i], c.text) }))));
  });
