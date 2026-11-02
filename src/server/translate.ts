import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { downloadSubtitle, listSubtitles, type PutioError, PutioFailed, uploadText } from "./putio";
import { AnthropicClient, weightedTokens } from "./runner";

const TRANSLATOR = "claude-haiku-5-5";
const PRICE_SHARE = 0.05;
const BATCH = 100;

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

const sourceRank = (source: string) => (source === "mkv" ? 0 : source.startsWith("opensubtitles") ? 1 : 2);

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

const Line = Schema.Struct({ id: Schema.Finite, text: Schema.String });
const decodeLines = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ lines: Schema.Array(Line) })));

type Numbered = { readonly id: number; readonly text: string };

const translateBatch = (batch: ReadonlyArray<Numbered>, language: string, spend: Spend) =>
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
                  schema: {
                    type: "object",
                    properties: {
                      lines: {
                        type: "array",
                        items: { type: "object", properties: { id: { type: "integer" }, text: { type: "string" } }, required: ["id", "text"], additionalProperties: false },
                      },
                    },
                    required: ["lines"],
                    additionalProperties: false,
                  },
                },
              },
              system: `Translate English film and TV subtitle lines into ${language}. Return one entry per input line with the same id. Translate each line on its own, even when a sentence runs on into the next line: never merge, split or skip lines. Keep line breaks inside a line, italics tags and speaker dashes. Write natural spoken ${language}, as a professional subtitler would.`,
              messages: [{ role: "user", content: JSON.stringify({ lines: batch }) }],
            },
            { signal },
          )
          .finalMessage(),
      catch: (e) => new PutioFailed({ message: `translation failed: ${e instanceof Error ? e.message : String(e)}`, refused: true }),
    });

    spend.charge(Math.ceil(weightedTokens(message.usage) * PRICE_SHARE));
    const out = decodeLines(message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(""));
    const wanted = new Set(batch.map((c) => c.id));
    const got = new Map(Option.isSome(out) ? out.value.lines.filter((l) => wanted.has(l.id)).map((l) => [l.id, l.text] as const) : []);

    return { got, why: Option.isNone(out) ? `unreadable reply, ${message.stop_reason}` : `${got.size} of ${batch.length} lines back` };
  });

const ROUNDS = 3;
const MAX_SINGLES = 20;

const translateAll = (batch: ReadonlyArray<Numbered>, language: string, spend: Spend) =>
  Effect.gen(function* () {
    const english = new Map(batch.map((c) => [c.id, c.text.trim()]));
    const got = new Map<number, string>();
    let missing = batch;
    let why = "";

    for (let round = 0; round < ROUNDS && missing.length > 0; round++) {
      const reply = yield* translateBatch(missing, language, spend);

      for (const [id, text] of reply.got) if (text.trim() && text.trim() !== english.get(id)) got.set(id, text);
      missing = missing.filter((c) => !got.has(c.id));
      why = reply.why;
    }

    if (missing.length > MAX_SINGLES) return yield* Effect.fail(new PutioFailed({ message: `the translation skipped some lines (${why})`, refused: true }));

    for (const line of missing) {
      const reply = yield* translateBatch([line], language, spend);
      const text = reply.got.get(line.id);

      if (text === undefined) return yield* Effect.fail(new PutioFailed({ message: `the translation skipped some lines (${reply.why})`, refused: true }));
      got.set(line.id, text);
    }

    return got;
  });

export const translateSubtitle = (videoId: number, parentId: number, name: string, language: LanguageCode, spend: Spend) =>
  Effect.gen(function* () {
    const subs = yield* listSubtitles(videoId).pipe(Effect.mapError(nothingWritten));
    const source = subs.filter((x) => x.language_code === "eng" && sourceRank(x.source) < 2).toSorted((a, b) => sourceRank(a.source) - sourceRank(b.source))[0];

    if (!source) return yield* Effect.fail(new PutioFailed({ message: "put.io has no English subtitle for this video", refused: true }));
    const cues = parseSrt(yield* downloadSubtitle(videoId, source.key).pipe(Effect.mapError(nothingWritten)));

    if (cues.length === 0) return yield* Effect.fail(new PutioFailed({ message: "the English subtitle is empty", refused: true }));
    const numbered = cues.map((c, id) => ({ id, text: c.text }));
    const translated = new Map<number, string>();

    for (let i = 0; i < numbered.length; i += BATCH)
      for (const [id, text] of yield* translateAll(numbered.slice(i, i + BATCH), LANGUAGES[language], spend)) translated.set(id, text);

    return yield* uploadText(name, parentId, toSrt(cues.map((c, id) => ({ head: c.head, text: cueText(translated.get(id), c.text) }))));
  });
